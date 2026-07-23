// test/commands/review.test.ts
//
// Unit tests for `cam review` (US-002 of CAM-403: phase-signal writer).
//
// What we cover:
//   - parseReviewArgs: --help/-h, unknown flag rejection (unchanged, still
//     covered here for the default no-flags path).
//   - runReview (hit path): orchestrator alive -> phase:review written to
//     the state file and returns 0. NO send-keys dispatch.
//   - runReview (miss path): bootstraps cam run, waits for marker, then
//     writes the state file.
//   - runReview: bootstrap failure returns 1.
//   - runReview: marker timeout returns 1.
//   - runReview: pane mutex busy returns 1 and does NOT write the state file.
//   - runReview: sidecar liveness gate (US-002, CAM-403) -- refuses and does
//     NOT write phase:review when the sidecar is dead, mirroring runPlan
//     and runShip.
//   - The liveness/bootstrap preamble and paneCountMutex busy-refusal are
//     preserved from the previous send-keys-based thin-proxy.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runReview } from '../../src/commands/review.ts';
import { parseReviewArgs } from '../../index.ts';
import {
	projectSessionName,
	type SpawnFn as TmuxSpawnFn,
} from '../../src/tmux/session.ts';
import { parseStateFile } from '../../src/commands/status.ts';

// --- Fake tmux spawn --------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

/**
 * Build a fake TmuxSpawnFn that simulates a session with an orchestrator pane.
 */
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

		return base;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

/** Capture state-file writes from runReview. Returns last captured body. */
function makeWriteCapture(): {
	calls: Array<{ body: string }>;
	writeFn: (cwd: string, body: string, opts: { force?: boolean }) => string;
} {
	const calls: Array<{ body: string }> = [];
	const writeFn = (_cwd: string, body: string, _opts: { force?: boolean }) => {
		calls.push({ body });
		return 'captured';
	};
	return { calls, writeFn };
}

// --- parseReviewArgs -------------------------------------------------------

describe('parseReviewArgs', () => {
	test('bare (no args) returns help: false', () => {
		expect(parseReviewArgs([])).toEqual({ help: false });
	});

	test('--help sets help: true', () => {
		expect(parseReviewArgs(['--help'])).toEqual({ help: true });
	});

	test('-h sets help: true', () => {
		expect(parseReviewArgs(['-h'])).toEqual({ help: true });
	});

	test('unknown flag returns null', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseReviewArgs(['--bogus'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('does not accept --permission-mode (returns null)', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseReviewArgs(['--permission-mode', 'acceptEdits'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});
});

// --- runReview: hit path -----------------------------------------------------

describe('runReview (hit path)', () => {
	test('writes phase:review and returns 0', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-hit-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		expect(writeCalls).toHaveLength(1);
		const parsed = parseStateFile(writeCalls[0]?.body ?? '');
		expect(parsed?.phase).toBe('review');
	});

	test('does NOT call send-keys (state-file write is the signal)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-no-sendkeys-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { writeFn } = makeWriteCapture();

		await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			sidecarAliveFn: () => true,
		});

		const sendKeys = spawnFn.calls.find((c) => c.args.includes('send-keys'));
		expect(sendKeys).toBeUndefined();
	});

	test('preserves other state-file fields already present (merge, not clobber)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-merge-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		// First write establishes an existing state file (via a real writeStateFile
		// call so buildReviewBody's existsSync/readFileSync path picks it up).
		const { writeStateFile, renderStateFile } = await import('../../src/commands/next.ts');
		writeStateFile(
			tmpDir,
			renderStateFile({
				maxIterations: 42,
				completionPromise: 'custom promise',
				startedAt: '2026-01-01T00:00:00Z',
				pid: 999,
				phase: 'implementing',
				iteration: 3,
				currentStory: 'US-002',
				storiesDone: 1,
				storiesTotal: 5,
				lastActivity: '2026-01-01T00:00:00Z',
				plan_issue: 'CAM-999',
			}),
			{ force: true },
		);

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		const parsed = parseStateFile(writeCalls[0]?.body ?? '');
		expect(parsed?.phase).toBe('review');
		expect(parsed?.max_iterations).toBe(42);
		expect(parsed?.completion_promise).toBe('custom promise');
		expect(parsed?.current_story).toBe('US-002');
		expect(parsed?.stories_done).toBe(1);
		expect(parsed?.stories_total).toBe(5);
		expect(parsed?.plan_issue).toBe('CAM-999');
	});

	test('skips bootstrap when orchestrator is already alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-no-bootstrap-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { writeFn } = makeWriteCapture();
		let bootstrapCalled = false;

		await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			sidecarAliveFn: () => true,
			bootstrapFn: async () => { bootstrapCalled = true; return true; },
		});

		expect(bootstrapCalled).toBe(false);
	});

	test('returns 1 and does not write when pane mutex is busy', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-busy-'));
		const spawnFn = makeFakeTmuxSpawn({
			sessionExists: true,
			orchAlive: true,
			paneMutexBusy: true,
		});
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runReview({ cwd: tmpDir, tmuxSpawnFn: spawnFn, writeFn });

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});
});

// --- runReview: miss path -----------------------------------------------------

describe('runReview (miss path)', () => {
	test('bootstraps + waits for marker + writes state file when orch not alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-miss-'));

		let bootstrapCalled = false;
		let markerPresent = false;
		let orchReady = false;

		const calls: TmuxCall[] = [];
		const statefulSpawnFn: TmuxSpawnFn & { calls: TmuxCall[] } = Object.assign(
			(cmd: string, args: string[]) => {
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
					return { ...base, status: orchReady ? 0 : 1 };
				}
				if (subcommand === 'list-panes') {
					if (!orchReady) return { ...base, status: 1 };
					const fIdx = args.indexOf('-F');
					const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
					if (fmt === '#{@cam_label}') {
						return { ...base, stdout: Buffer.from('orchestrator\ndashboard\n') };
					}
					if (fmt === '#{pane_id}') {
						return { ...base, stdout: Buffer.from('%0\n%1\n') };
					}
					return { ...base, stdout: Buffer.from('') };
				}
				return base;
			},
			{ calls },
		);

		const bootstrapFn = async () => {
			bootstrapCalled = true;
			orchReady = true;
			markerPresent = true;
			return true;
		};

		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: statefulSpawnFn,
			bootstrapFn,
			statFn: () => markerPresent,
			sleepFn: () => {},
			waitTimeoutMs: 5_000,
			writeFn,
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		expect(bootstrapCalled).toBe(true);
		expect(writeCalls).toHaveLength(1);
		const parsed = parseStateFile(writeCalls[0]?.body ?? '');
		expect(parsed?.phase).toBe('review');
	});

	test('returns 1 when bootstrap fails', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-boot-fail-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => false,
		});

		expect(code).toBe(1);
	});

	test('returns 1 when marker never appears (timeout)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-timeout-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => true,
			statFn: () => false,
			sleepFn: () => {},
			waitTimeoutMs: 5,
		});

		expect(code).toBe(1);
	});
});

// --- runReview: session name used in all tmux calls ---------------------------

describe('runReview: session name', () => {
	test('all tmux calls include the project session name', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-sessname-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
		const { writeFn } = makeWriteCapture();
		const sessionName = projectSessionName(tmpDir);

		await runReview({ cwd: tmpDir, tmuxSpawnFn: spawnFn, writeFn, sidecarAliveFn: () => true });

		const callsWithSession = spawnFn.calls.filter((c) => c.args.includes(sessionName));
		expect(callsWithSession.length).toBeGreaterThan(0);
	});
});

// --- runReview: sidecar liveness gate (US-002, CAM-403) -----------------------

describe('runReview: sidecar liveness gate', () => {
	test('refuses and does NOT write phase:review when the sidecar is dead', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-sidecar-dead-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();
		let probedClaudeDir: string | undefined;

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			sidecarAliveFn: (claudeDir) => {
				probedClaudeDir = claudeDir;
				return false;
			},
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
		expect(probedClaudeDir).toBe(join(tmpDir, '.claude'));
	});

	test('proceeds and writes phase:review when the sidecar is alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-sidecar-alive-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		expect(writeCalls).toHaveLength(1);
	});

	test('AC: the gate is mode-agnostic — a dead sidecar refuses regardless of worker_isolation', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-review-sidecar-mode-agnostic-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runReview({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			sidecarAliveFn: () => false,
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});
});
