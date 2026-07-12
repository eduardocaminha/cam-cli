// test/plan.test.ts
//
// Unit tests for `cam plan` (US-004 of CAM-151).
//
// What we cover:
//   - parsePlanArgs: positional integer, leading-# tolerance, bare (no arg),
//     standardized error on any present-but-non-integer token.
//   - runPlan (hit, bare): orchestrator alive, top-of-queue plannable issue
//     selected -> state file written with phase:planning + plan_issue.
//   - runPlan (hit, with N): specific issue N validated -> state file written.
//   - runPlan (F-01 validation): missing / not-open / not-specified / blocked
//     issue returns 1 and does NOT write the state file.
//   - runPlan (miss path): bootstraps cam run, waits for marker, then writes
//     state file.
//   - runPlan: bootstrap failure returns 1.
//   - runPlan: marker timeout returns 1.
//   - runPlan: pane mutex busy returns 1.
//   - AC2: parsed state file has phase==='planning' and plan_issue===<id>.
//   - AC3: specific N falls back to nothing (no selectPlannableFromFile) when
//     the issue is invalid.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runPlan } from '../src/commands/plan.ts';
import { parsePlanArgs } from '../index.ts';
import {
	projectSessionName,
	type SpawnFn as TmuxSpawnFn,
} from '../src/tmux/session.ts';
import { parseStateFile } from '../src/commands/status.ts';
import type { IssueEntry } from '../src/issues/types.ts';

// --- Helpers ----------------------------------------------------------------

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
				return {
					...base,
					stdout: Buffer.from(orchAlive ? `orchestrator\ndashboard\n` : `dashboard\n`),
				};
			}
			if (fmt === '#{pane_index};#{pane_id}') {
				return { ...base, stdout: Buffer.from(`0;${orchPaneId}\n`) };
			}
			if (fmt === '#{pane_id}') {
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

/** Build a minimal plannable IssueEntry fixture. */
function makePlannable(id: string): IssueEntry {
	return {
		id,
		title: `Issue ${id}`,
		stage: 'specified',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
	};
}

/** Capture state-file writes from runPlan. Returns last captured body. */
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

// --- parsePlanArgs (strict, number-only CLI contract) ----------------------

describe('parsePlanArgs', () => {
	test('parses a positional integer issue number', () => {
		expect(parsePlanArgs(['21'])).toEqual({ issue: 21, help: false });
	});

	test('tolerates a leading `#` on the number', () => {
		expect(parsePlanArgs(['#21'])).toEqual({ issue: 21, help: false });
	});

	test('bare (no argument) leaves issue undefined', () => {
		expect(parsePlanArgs([])).toEqual({ help: false });
	});

	test('--help / -h set the help flag', () => {
		expect(parsePlanArgs(['--help'])).toEqual({ help: true });
		expect(parsePlanArgs(['-h'])).toEqual({ help: true });
	});

	test('rejects a present-but-non-integer token (returns null)', () => {
		expect(parsePlanArgs(['abc'])).toBeNull();
		expect(parsePlanArgs(['1.5'])).toBeNull();
		expect(parsePlanArgs(['21abc'])).toBeNull();
		expect(parsePlanArgs(['#abc'])).toBeNull();
		expect(parsePlanArgs([''])).toBeNull();
	});

	test('rejects zero and negatives', () => {
		expect(parsePlanArgs(['0'])).toBeNull();
		expect(parsePlanArgs(['-5'])).toBeNull();
	});

	test('rejects the removed --issue flag and any unknown option', () => {
		expect(parsePlanArgs(['--issue', '21'])).toBeNull();
		expect(parsePlanArgs(['--issue=21'])).toBeNull();
		expect(parsePlanArgs(['--bogus'])).toBeNull();
	});

	test('rejects more than one positional argument', () => {
		expect(parsePlanArgs(['21', '22'])).toBeNull();
	});
});

// --- runPlan: hit path (bare cam plan) -------------------------------------

describe('runPlan (hit path, bare plan)', () => {
	test('writes phase:planning + plan_issue and returns 0', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-bare-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-7')],
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		expect(writeCalls).toHaveLength(1);
		const parsed = parseStateFile(writeCalls[0]?.body ?? '');
		expect(parsed?.phase).toBe('planning');
		expect(parsed?.plan_issue).toBe('CAM-7');
	});

	test('does NOT call send-keys (state-file write is the signal)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-no-sendkeys-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { writeFn } = makeWriteCapture();

		await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-7')],
		});

		const sendKeys = spawnFn.calls.find((c) => c.args.includes('send-keys'));
		expect(sendKeys).toBeUndefined();
	});

	test('skips bootstrap when orchestrator is already alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-no-bootstrap-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { writeFn } = makeWriteCapture();
		let bootstrapCalled = false;

		await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-5')],
			bootstrapFn: async () => { bootstrapCalled = true; return true; },
		});

		expect(bootstrapCalled).toBe(false);
	});

	test('returns 1 when no plannable issue is in the backlog', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-noissue-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [],
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});

	test('returns 1 and does not write when pane mutex is busy', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-busy-'));
		const spawnFn = makeFakeTmuxSpawn({
			sessionExists: true,
			orchAlive: true,
			paneMutexBusy: true,
		});
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-5')],
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});
});

// --- runPlan: hit path (specific issue N) ----------------------------------

describe('runPlan (hit path, specific N)', () => {
	test('writes phase:planning + plan_issue=<id> for valid issue N', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-N-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 42,
			readBacklogFn: () => [makePlannable('CAM-42')],
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		expect(writeCalls).toHaveLength(1);
		const parsed = parseStateFile(writeCalls[0]?.body ?? '');
		expect(parsed?.phase).toBe('planning');
		expect(parsed?.plan_issue).toBe('CAM-42');
	});

	test('AC2: state file parses with phase===planning and plan_issue===N', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-ac2-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 151,
			readBacklogFn: () => [makePlannable('CAM-151')],
			sidecarAliveFn: () => true,
		});

		const body = writeCalls[0]?.body ?? '';
		const parsed = parseStateFile(body);
		expect(parsed?.phase).toBe('planning');
		// plan_issue must be the full id string, matching the issue number
		expect(parsed?.plan_issue).toBe('CAM-151');
	});

	test('selects by numeric suffix even with non-matching prefix', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-prefix-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		// Backlog has two issues with the same numeric suffix
		// (different prefixes). The first one matching numerically wins.
		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 5,
			readBacklogFn: () => [makePlannable('CAM-5')],
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		const parsed = parseStateFile(writeCalls[0]?.body ?? '');
		expect(parsed?.plan_issue).toBe('CAM-5');
	});
});

// --- runPlan: F-01 validation (specific N invalid) -------------------------

describe('runPlan (F-01 validation, specific N)', () => {
	test('AC3: returns 1 when issue N is not found in backlog', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-notfound-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 999,
			readBacklogFn: () => [makePlannable('CAM-7')],
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});

	test('AC3: returns 1 when issue N has status:abandoned', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-abandoned-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const abandoned: IssueEntry = {
			...makePlannable('CAM-10'),
			status: 'abandoned',
		};

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 10,
			readBacklogFn: () => [abandoned],
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});

	test('AC3: returns 1 when issue N has stage:idea (not specified)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-idea-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const idea: IssueEntry = {
			...makePlannable('CAM-11'),
			stage: 'idea',
		};

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 11,
			readBacklogFn: () => [idea],
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});

	test('AC3: returns 1 when issue N is blocked by an unshipped dep', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-blocked-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const dep: IssueEntry = {
			...makePlannable('CAM-12'),
			stage: 'planned', // not shipped
		};
		const blocked: IssueEntry = {
			...makePlannable('CAM-13'),
			blockedBy: ['CAM-12'],
		};

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 13,
			readBacklogFn: () => [dep, blocked],
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});

	test('AC3: specific N does NOT fall back to top-of-queue when invalid', async () => {
		// The backlog has a different plannable issue (CAM-7); passing N=999
		// must NOT plan CAM-7 as a fallback.
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-nofallback-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			issue: 999, // does not exist
			readBacklogFn: () => [makePlannable('CAM-7')],
		});

		expect(code).toBe(1);
		// No write: must NOT have fallen back to CAM-7
		expect(writeCalls).toHaveLength(0);
	});
});

// --- runPlan: miss path (bootstrap) ----------------------------------------

describe('runPlan (miss path)', () => {
	test('bootstraps + waits for marker + writes state file when orch not alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-miss-'));

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

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: statefulSpawnFn,
			bootstrapFn,
			statFn: () => markerPresent,
			sleepFn: () => {},
			waitTimeoutMs: 5_000,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-3')],
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		expect(bootstrapCalled).toBe(true);
		// State file should have been written with phase:planning.
		expect(writeCalls).toHaveLength(1);
		const parsed = parseStateFile(writeCalls[0]?.body ?? '');
		expect(parsed?.phase).toBe('planning');
		expect(parsed?.plan_issue).toBe('CAM-3');
	});

	test('returns 1 when bootstrap fails', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-boot-fail-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => false,
			readBacklogFn: () => [makePlannable('CAM-5')],
		});

		expect(code).toBe(1);
	});

	test('returns 1 when marker never appears (timeout)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-timeout-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => true,
			statFn: () => false,
			sleepFn: () => {},
			waitTimeoutMs: 5,
			readBacklogFn: () => [makePlannable('CAM-5')],
		});

		expect(code).toBe(1);
	});
});

// --- runPlan: session name used in all tmux calls ---------------------------

describe('runPlan: session name', () => {
	test('all tmux calls include the project session name', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-sessname-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
		const { writeFn } = makeWriteCapture();
		const sessionName = projectSessionName(tmpDir);

		await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-1')],
		});

		const callsWithSession = spawnFn.calls.filter((c) => c.args.includes(sessionName));
		expect(callsWithSession.length).toBeGreaterThan(0);
	});
});

// --- runPlan: sidecar liveness gate (US-003, CAM-207) -----------------------

describe('runPlan: sidecar liveness gate', () => {
	test('refuses and does NOT write phase:planning when the sidecar is dead', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-sidecar-dead-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();
		let probedClaudeDir: string | undefined;

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-7')],
			sidecarAliveFn: (claudeDir) => {
				probedClaudeDir = claudeDir;
				return false;
			},
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
		expect(probedClaudeDir).toBe(join(tmpDir, '.claude'));
	});

	test('proceeds and writes phase:planning when the sidecar is alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-sidecar-alive-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-7')],
			sidecarAliveFn: () => true,
		});

		expect(code).toBe(0);
		expect(writeCalls).toHaveLength(1);
	});

	test('AC4: the gate is mode-agnostic — a dead sidecar refuses regardless of worker_isolation', async () => {
		// No worker_isolation branching exists in the gate itself; a fake that
		// always reports dead proves the refusal fires unconditionally, whether
		// the project is configured for host or container mode.
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-sidecar-mode-agnostic-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const { calls: writeCalls, writeFn } = makeWriteCapture();

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			writeFn,
			readBacklogFn: () => [makePlannable('CAM-7')],
			sidecarAliveFn: () => false,
		});

		expect(code).toBe(1);
		expect(writeCalls).toHaveLength(0);
	});
});
