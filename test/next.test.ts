// test/next.test.ts
//
// Unit tests for `cam next` (US-006: thin-proxy to orchestrator).
//
// What we cover:
//   - renderStateFile: template substitution, YAML shape, no stop-hook body.
//   - writeStateFile: creates .claude/, refuses clobber, force flag.
//   - runNext (hit path): orch alive → send-keys task prompt → return 0.
//   - runNext (miss path): bootstrap + wait + send-keys.
//   - runNext: bootstrap failure returns 1.
//   - runNext: marker timeout returns 1.
//   - runNext: missing pane returns 1.
//   - runNext: uses DEFAULT_TASK_PROMPT by default.
//   - runNext: custom taskPrompt forwarded to orchestrator.
//   - send-keys is atomic (-l flag, text + Enter in same call).

import { describe, expect, test } from 'bun:test';
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
	DEFAULT_TASK_PROMPT,
} from '../src/commands/next.ts';
import { type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';
import yaml from 'js-yaml';

// --- Fake tmux spawn --------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

function makeFakeTmuxSpawn(opts: {
	sessionExists?: boolean;
	orchAlive?: boolean;
	orchPaneId?: string;
} = {}): TmuxSpawnFn & { calls: TmuxCall[] } {
	const { sessionExists = true, orchAlive = true, orchPaneId = '%0' } = opts;
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
			if (fmt === '#{pane_index}\t#{pane_current_command}') {
				return {
					...base,
					stdout: Buffer.from(orchAlive ? `0\tclaude\n` : `0\tsh\n`),
				};
			}
			if (fmt === '#{pane_index}\t#{pane_id}') {
				return { ...base, stdout: Buffer.from(`0\t${orchPaneId}\n`) };
			}
			return { ...base, stdout: Buffer.from('') };
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

	test('DEFAULT_TASK_PROMPT mentions prd.json and AGENT.md', () => {
		expect(DEFAULT_TASK_PROMPT).toContain('prd.json');
		expect(DEFAULT_TASK_PROMPT).toContain('AGENT.md');
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
	test('sends DEFAULT_TASK_PROMPT to orchestrator pane and returns 0', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-hit-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%3' });

			const code = await runNext({ cwd: dir, tmuxSpawnFn: spawnFn });

			expect(code).toBe(0);

			const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
			expect(sendKeys).toBeDefined();
			expect(sendKeys?.args).toContain('-l');
			expect(sendKeys?.args).toContain(DEFAULT_TASK_PROMPT);
			expect(sendKeys?.args).toContain('Enter');
			expect(sendKeys?.args).toContain('%3');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('forwards a custom taskPrompt to the orchestrator', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-custom-prompt-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
			const customPrompt = 'Run the review cycle on the latest PRD.';

			await runNext({ cwd: dir, tmuxSpawnFn: spawnFn, taskPrompt: customPrompt });

			const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
			expect(sendKeys?.args).toContain(customPrompt);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('send-keys uses -l flag for literal payload', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-literal-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });

			await runNext({ cwd: dir, tmuxSpawnFn: spawnFn });

			const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
			expect(sendKeys?.args).toContain('-l');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Enter is a separate argument in the send-keys call (atomic)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-atomic-'));
		try {
			const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });

			await runNext({ cwd: dir, tmuxSpawnFn: spawnFn });

			const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
			const enterIdx = sendKeys?.args.lastIndexOf('Enter') ?? -1;
			const textIdx = sendKeys?.args.findIndex((a) => a === DEFAULT_TASK_PROMPT) ?? -1;
			expect(enterIdx).toBeGreaterThan(textIdx);
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
			});
			expect(code).toBe(0);
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

	test('bootstraps + waits + sends keys when orch not alive initially', async () => {
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
			});

			// spawnFn always sees a live orch so it takes the hit path.
			expect(code).toBe(0);
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
						if (fmt === '#{pane_index}\t#{pane_current_command}') {
							return { ...base, stdout: Buffer.from('0\tclaude\n') };
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
