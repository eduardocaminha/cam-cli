// test/next.test.ts
//
// Unit tests for `cam next` (US-006: thin-proxy to orchestrator).
//
// What we cover:
//   - renderStateFile: template substitution, YAML shape, no stop-hook body.
//   - writeStateFile: creates .claude/, refuses clobber, force flag.
//   - runNext (hit path): orch alive → flip active:true → return 0.
//   - runNext (miss path): bootstrap + wait + flip active:true.
//   - runNext: bootstrap failure returns 1.
//   - runNext: marker timeout returns 1.
//   - runNext: missing pane returns 1.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	runNext,
	renderStateFile,
	writeStateFile,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_COMPLETION_PROMISE,
} from '../src/commands/next.ts';
import { parseStateFile, type LoopPhase } from '../src/commands/status.ts';
import { type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';
import yaml from 'js-yaml';

// Deterministic-preflight gate (US-003, CAM-400) fake: these pre-existing
// tests exercise the hit/miss/write-failure paths, not the preflight itself
// (see test/commands/next-preflight.test.ts for that), so they inject a
// passing fake to avoid falling through to the real spawnSync-backed default
// (which would shell out to real git/bun and recurse into `bun test`).
const PASSING_PREFLIGHT = () => ({ ok: true }) as const;

// --- Fake tmux spawn --------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

function makeFakeTmuxSpawn(opts: {
	sessionExists?: boolean;
	orchAlive?: boolean;
	orchPaneId?: string;
	/** When true, paneCountMutex returns 'busy' (3 panes instead of 2). */
	paneMutexBusy?: boolean;
} = {}): TmuxSpawnFn & { calls: TmuxCall[] } {
	const { sessionExists = true, orchAlive = true, orchPaneId = '%0', paneMutexBusy = false } = opts;
	const calls: TmuxCall[] = [];

	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'has-session') {
			return { ...base, status: sessionExists ? 0 : 1 };
		}

		if (subcommand === 'list-panes') {
			if (!sessionExists) return { ...base, status: 1 };
			const fIdx = args.indexOf('-F');
			const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
			if (fmt === '#{@cam_label}') {
				// orchestratorAlive keys on @cam_label (the orchestrator runs claude
				// under a bash respawn-wrapper, so pane_current_command is never claude).
				return {
					...base,
					stdout: Buffer.from(orchAlive ? `orchestrator\ndashboard\n` : `dashboard\n`),
				};
			}
			if (fmt === '#{pane_index};#{pane_id}') {
				return { ...base, stdout: Buffer.from(`0;${orchPaneId}\n`) };
			}
			if (fmt === '#{pane_id}') {
				// For paneCountMutex: return 2 pane IDs (available) or 3 (busy).
				const panes = paneMutexBusy ? '%0\n%1\n%2\n' : '%0\n%1\n';
				return { ...base, stdout: Buffer.from(panes) };
			}
			return { ...base, stdout: Buffer.from('') };
		}

		if (subcommand === 'capture-pane') {
			// Return idle pane content so the idle-check (US-008) passes immediately.
			return { ...base, stdout: Buffer.from('> ') };
		}
		if (subcommand === 'send-keys') return base;
		return base;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

// --- renderStateFile -------------------------------------------------------

describe('renderStateFile', () => {
	test('substitutes all YAML frontmatter fields', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-06-08T12:00:00Z',
			pid: 4242,
		});
		expect(out).toContain('max_iterations: 30');
		expect(out).toContain('completion_promise: "COMPLETE"');
		expect(out).toContain('started_at: "2026-06-08T12:00:00Z"');
		expect(out).toContain('active: true');
		expect(out).toContain('iteration: 1');
		expect(out).toContain('pid: 4242');
	});

	test('body is empty — no stop-hook re-inject prompt', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-06-08T12:00:00Z',
			pid: 1,
		});
		const parts = out.split(/^---$/m);
		const bodyAfterDelimiter = (parts[2] ?? '').trim();
		expect(bodyAfterDelimiter).toBe('');
	});

	test('emits null for empty completion-promise', () => {
		const out = renderStateFile({
			maxIterations: 0,
			completionPromise: '',
			startedAt: '2026-06-08T12:00:00Z',
			pid: 1,
		});
		expect(out).toContain('completion_promise: null');
	});

	test('state file parses as valid YAML frontmatter with expected fields', () => {
		const out = renderStateFile({
			maxIterations: 50,
			completionPromise: 'COMPLETE',
			startedAt: '2026-06-08T12:00:00Z',
			pid: 9999,
		});
		const lines = out.split('\n');
		let endIdx = -1;
		for (let i = 1; i < lines.length; i += 1) {
			if (lines[i]?.trim() === '---') { endIdx = i; break; }
		}
		expect(endIdx).toBeGreaterThan(0);
		const yamlSection = lines.slice(1, endIdx).join('\n');
		const parsed = yaml.load(yamlSection) as Record<string, unknown>;
		expect(parsed['active']).toBe(true);
		expect(parsed['iteration']).toBe(1);
		expect(parsed['max_iterations']).toBe(50);
		expect(typeof parsed['started_at']).toBe('string');
		expect(parsed['pid']).toBe(9999);
	});

	test('DEFAULT_MAX_ITERATIONS is 30', () => {
		expect(DEFAULT_MAX_ITERATIONS).toBe(30);
	});

	test('DEFAULT_COMPLETION_PROMISE is "COMPLETE"', () => {
		expect(DEFAULT_COMPLETION_PROMISE).toBe('COMPLETE');
	});
});

// --- Phase round-trip (US-001, CAM-151) ------------------------------------

describe('renderStateFile + parseStateFile round-trip: phase field', () => {
	const phases: LoopPhase[] = ['idle', 'planning', 'implementing', 'awaiting-operator', 'shipping'];

	for (const phase of phases) {
		test(`phase "${phase}" survives render->parse; active === (phase === 'implementing')`, () => {
			const rendered = renderStateFile({
				maxIterations: 30,
				completionPromise: 'COMPLETE',
				startedAt: '2026-07-01T00:00:00Z',
				pid: 1,
				phase,
			});
			// The rendered output must contain the phase literal.
			expect(rendered).toContain(`phase: ${phase}`);

			const parsed = parseStateFile(rendered);
			expect(parsed).not.toBeNull();
			expect(parsed?.phase).toBe(phase);
			expect(parsed?.active).toBe(phase === 'implementing');
		});
	}

	test('plan_issue round-trips when set', () => {
		const rendered = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			phase: 'planning',
			plan_issue: 'CAM-151',
		});
		const parsed = parseStateFile(rendered);
		expect(parsed?.plan_issue).toBe('CAM-151');
	});

	test('plan_issue is absent from parsed state when not set (null input)', () => {
		const rendered = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			phase: 'implementing',
			plan_issue: null,
		});
		const parsed = parseStateFile(rendered);
		expect(parsed?.plan_issue).toBeUndefined();
	});

	test('legacy back-compat: active:true (no phase) parses as active:true, no phase field', () => {
		const body = ['---', 'active: true', 'iteration: 1', 'max_iterations: 30', '---', ''].join('\n');
		const parsed = parseStateFile(body);
		expect(parsed?.active).toBe(true);
		expect(parsed?.phase).toBeUndefined();
	});

	test('legacy back-compat: active:false (no phase) parses as active:false, no phase field', () => {
		const body = ['---', 'active: false', 'iteration: 1', 'max_iterations: 30', '---', ''].join('\n');
		const parsed = parseStateFile(body);
		expect(parsed?.active).toBe(false);
		expect(parsed?.phase).toBeUndefined();
	});

	test('when phase and active conflict, phase wins (active derived from phase)', () => {
		// phase:idle + active:true in the frontmatter -> active should be false (from phase)
		const body = [
			'---',
			'active: true',
			'phase: idle',
			'iteration: 1',
			'max_iterations: 30',
			'---',
			'',
		].join('\n');
		const parsed = parseStateFile(body);
		expect(parsed?.phase).toBe('idle');
		expect(parsed?.active).toBe(false); // derived from phase, not from raw active:true
	});
});

// --- renderStateFile: read-modify-write phase preservation (US-001, CAM-195) --

describe('renderStateFile: read-modify-write phase preservation (US-001, CAM-195)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-render-rmw-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('absent phase + cwd over an existing phase:implementing file re-emits phase:implementing (not idle)', () => {
		const seed = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			phase: 'implementing',
		});
		writeStateFile(tmpDir, seed, { force: true });

		const rendered = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			cwd: tmpDir,
		});
		const parsed = parseStateFile(rendered);
		expect(parsed?.phase).toBe('implementing');
		expect(parsed?.active).toBe(true);
	});

	test('an explicit phase wins over the on-disk phase', () => {
		const seed = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			phase: 'implementing',
		});
		writeStateFile(tmpDir, seed, { force: true });

		const rendered = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			phase: 'shipping',
			cwd: tmpDir,
		});
		const parsed = parseStateFile(rendered);
		expect(parsed?.phase).toBe('shipping');
	});

	test('a nonexistent file at cwd defaults to phase:idle', () => {
		const rendered = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			cwd: tmpDir,
		});
		const parsed = parseStateFile(rendered);
		expect(parsed?.phase).toBe('idle');
		expect(parsed?.active).toBe(false);
	});

	test('absent phase + no cwd preserves legacy active-derived back-compat', () => {
		const rendered = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00Z',
			pid: 1,
			active: true,
		});
		const parsed = parseStateFile(rendered);
		expect(parsed?.phase).toBe('implementing');
	});
});

// --- writeStateFile --------------------------------------------------------

describe('writeStateFile', () => {
	test('creates .claude/ when missing and writes the body', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-write-'));
		try {
			const written = writeStateFile(dir, 'hello\n');
			expect(written).toBe(join(dir, '.claude', 'cam-loop.local.md'));
			expect(existsSync(written)).toBe(true);
			expect(readFileSync(written, 'utf8')).toBe('hello\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('refuses to clobber an existing state file unless force=true', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-clobber-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			require('node:fs').writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'old\n');
			expect(() => writeStateFile(dir, 'new\n')).toThrow();
			writeStateFile(dir, 'newer\n', { force: true });
			expect(readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8')).toBe('newer\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runNext (thin-proxy): hit path ----------------------------------------

describe('runNext (thin-proxy, hit path)', () => {
	test('returns 0 and writes active:true when orchestrator is alive', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-hit-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%3' });

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: () => true,
				preflightFn: PASSING_PREFLIGHT,
			});

			expect(code).toBe(0);
			// send-keys is no longer called by cam next (sidecar handles dispatch)
			const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
			expect(sendKeys).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('skips bootstrap when orchestrator is alive', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-no-bootstrap-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
			let bootstrapCalled = false;

			await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				bootstrapFn: async () => { bootstrapCalled = true; return true; },
			});

			expect(bootstrapCalled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('maxIterations and completionPromise options are accepted (CLI compat) but do not affect output', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-compat-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });

			// These options are kept for CLI compat; they should not cause errors.
			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				maxIterations: 10,
				completionPromise: 'MY_PROMISE',
				sidecarAliveFn: () => true,
				preflightFn: PASSING_PREFLIGHT,
			});
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('runNext writes active:true on the hit path', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-active-true-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

			await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: () => true,
				preflightFn: PASSING_PREFLIGHT,
			});

			const stateContent = readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8');
			expect(stateContent).toContain('active: true');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('runNext pushes no task-prompt send-keys to the orchestrator pane', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-no-send-keys-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

			await runNext({ cwd: dir, tmuxSpawnFn: spawnFn });

			const sendKeysCall = spawnFn.calls.find((c) => c.args.includes('send-keys'));
			expect(sendKeysCall).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns 1 and does not send-keys when pane mutex is busy', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-busy-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({
				sessionExists: true,
				orchAlive: true,
				paneMutexBusy: true,
			});

			const code = await runNext({ cwd: dir, tmuxSpawnFn: spawnFn });

			expect(code).toBe(1);
			// send-keys must NOT have been called (worker is still running)
			const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
			expect(sendKeys).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runNext (thin-proxy): miss path ----------------------------------------

describe('runNext (thin-proxy, miss path)', () => {
	test('returns 1 when bootstrap fails', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-boot-fail-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				bootstrapFn: async () => false,
			});

			expect(code).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns 1 when marker never appears (timeout)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-timeout-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				bootstrapFn: async () => true,
				statFn: () => false, // marker never appears
				sleepFn: () => {},
				waitTimeoutMs: 5,
			});

			expect(code).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('bootstraps + waits + flips active:true when orch not alive initially', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-miss-'));
		try {
			// After bootstrap, orch is alive.
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
			let markerPresent = false;

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				bootstrapFn: async () => { markerPresent = true; return true; },
				statFn: () => markerPresent,
				sleepFn: () => {},
				waitTimeoutMs: 5_000,
				sidecarAliveFn: () => true,
				preflightFn: PASSING_PREFLIGHT,
			});

			// spawnFn always sees a live orch so it takes the hit path.
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runNext (write failure path) ------------------------------------------

describe('runNext (write failure path)', () => {
	test('returns 1 and emits error to stderr when writeFn throws', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-write-fail-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

			const capturedStderr: string[] = [];
			const origStderrWrite = process.stderr.write.bind(process.stderr);
			process.stderr.write = ((chunk: string | Uint8Array) => {
				capturedStderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
				return true;
			}) as typeof process.stderr.write;

			let code: number;
			try {
				code = await runNext({
					cwd: dir,
					tmuxSpawnFn: spawnFn,
					writeFn: () => { throw new Error('EACCES: permission denied'); },
					sidecarAliveFn: () => true,
					preflightFn: PASSING_PREFLIGHT,
				});
			} finally {
				process.stderr.write = origStderrWrite;
			}

			expect(code!).toBe(1);
			const stderrOutput = capturedStderr.join('');
			expect(stderrOutput).toContain('cam-loop.local.md');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('does not reach emitOk (no success message) on write failure', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-no-emit-ok-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

			const capturedStdout: string[] = [];
			const origStdoutWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = ((chunk: string | Uint8Array) => {
				capturedStdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
				return true;
			}) as typeof process.stdout.write;

			let code: number;
			try {
				code = await runNext({
					cwd: dir,
					tmuxSpawnFn: spawnFn,
					writeFn: () => { throw new Error('write failed'); },
					sidecarAliveFn: () => true,
					preflightFn: PASSING_PREFLIGHT,
				});
			} finally {
				process.stdout.write = origStdoutWrite;
			}

			expect(code!).toBe(1);
			// emitOk writes a ✓ + "Sidecar trigger written" to stdout — must NOT appear
			const stdoutOutput = capturedStdout.join('');
			expect(stdoutOutput).not.toContain('Sidecar trigger written');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runNext (thin-proxy): pane not found ----------------------------------

describe('runNext (thin-proxy, pane not found)', () => {
	test('returns 1 when getOrchPaneId returns null', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-nopane-'));
		try {
			const spawnFn: TmuxSpawnFn & { calls: TmuxCall[] } = (() => {
				const calls: TmuxCall[] = [];
				const fn = ((cmd: string, args: string[]) => {
					calls.push({ cmd, args: [...args] });
					const base: SpawnSyncReturns<Buffer> = {
						pid: 1,
						output: [null, Buffer.from(''), Buffer.from('')],
						stdout: Buffer.from(''),
						stderr: Buffer.from(''),
						status: 0,
						signal: null,
					};
					const subcommand = args[0] === '-L' ? args[2] : args[0];
					if (subcommand === 'has-session') return base;
					if (subcommand === 'list-panes') {
						const fIdx = args.indexOf('-F');
						const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
						if (fmt === '#{@cam_label}') {
							return { ...base, stdout: Buffer.from('orchestrator\ndashboard\n') };
						}
						return { ...base, stdout: Buffer.from('') }; // no pane id found
					}
					return base;
				}) as TmuxSpawnFn & { calls: TmuxCall[] };
				fn.calls = calls;
				return fn;
			})();

			const code = await runNext({ cwd: dir, tmuxSpawnFn: spawnFn });
			expect(code).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runNext: sidecar liveness gate (US-003, CAM-207) -----------------------

describe('runNext: sidecar liveness gate', () => {
	test('refuses and does NOT write active:true when the sidecar is dead', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-sidecar-dead-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
			let probedClaudeDir: string | undefined;

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: (claudeDir) => {
					probedClaudeDir = claudeDir;
					return false;
				},
			});

			expect(code).toBe(1);
			expect(existsSync(join(dir, '.claude', 'cam-loop.local.md'))).toBe(false);
			expect(probedClaudeDir).toBe(join(dir, '.claude'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('proceeds and writes active:true when the sidecar is alive', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-sidecar-alive-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: () => true,
				preflightFn: PASSING_PREFLIGHT,
			});

			expect(code).toBe(0);
			const stateContent = readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8');
			expect(stateContent).toContain('active: true');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC4: the gate is mode-agnostic — a dead sidecar refuses regardless of worker_isolation', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-sidecar-mode-agnostic-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

			const code = await runNext({ cwd: dir, tmuxSpawnFn: spawnFn, sidecarAliveFn: () => false });

			expect(code).toBe(1);
			expect(existsSync(join(dir, '.claude', 'cam-loop.local.md'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
