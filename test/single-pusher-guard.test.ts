// test/single-pusher-guard.test.ts
//
// Single-pusher invariant guard (US-005, CAM-78).
//
// Purpose: assert that makeNotifyOrchestrator is the SOLE emitter of [cam]
// narration lines to the orchestrator pane, and that each notification
// produces exactly ONE tmux send-keys call (zero-double-push guarantee).
//
// Covers:
//   1. Implementer worker-report summary: formatWorkerReportSummary -> notify
//      -> exactly one send-keys call, argv matches buildWorkerReportSendKeysArgv
//      shape (no -l, Enter as separate last arg, summary + Enter in one call).
//   2. Review verdict line: formatReviewVerdictLine -> notify -> exactly one
//      send-keys call, same argv shape invariants.
//   3. Silent no-op when the orchestrator pane is absent (list-panes empty):
//      zero send-keys calls (double-push is impossible when no target exists).
//
// The guards in acceptance criteria 1 and 2 (grep-based) confirm the
// ABSENCE of the narration builders in src/commands and in the subagent
// agent file; THIS file is the DISCRIMINATING proof for criterion 3.
//
// Reference: patterns.md bullets 56, 57, 77 (single-pusher invariant).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { makeNotifyOrchestrator } from '../src/supervisor/host.ts';
import {
	buildWorkerReportSendKeysArgv,
	formatWorkerReportSummary,
	formatReviewVerdictLine,
	type WorkerReport,
} from '../src/supervisor/worker-report.ts';
import type { SpawnFn } from '../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fake TmuxSpawnFn
// ---------------------------------------------------------------------------

type SpawnCall = { cmd: string; args: string[] };

/**
 * Build a recording fake TmuxSpawnFn (SpawnSyncReturns<Buffer> shape, mirroring
 * makeFakeTmuxSpawn in test/next.test.ts).
 *
 * - list-panes -F '#{pane_index};#{pane_id}': resolves pane index 0 to orchPaneId.
 * - All other calls: status 0, empty stdout; recorded in calls[].
 *
 * @param orchPaneId  Pane ID returned for index 0 (e.g. '%0'). Pass '' for the
 *                    no-pane scenario (empty list-panes output -> null result).
 */
function makeFakeSpawn(orchPaneId: string, calls: SpawnCall[]): SpawnFn {
	return (cmd: string, args: string[], _opts) => {
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};

		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'list-panes') {
			// Resolve the orchestrator pane: index 0 -> orchPaneId.
			// Empty orchPaneId simulates no-pane (getOrchPaneId returns null).
			const stdout =
				orchPaneId.length > 0 ? Buffer.from(`0;${orchPaneId}\n1;%1\n`) : Buffer.from('');
			return { ...base, stdout };
		}

		if (subcommand === 'display-message') {
			// sendKeysVerified's delivery verdict (US-002, CAM-359) samples cursor
			// geometry here, not via capturePaneFn. A fixed, always-identical
			// reading means the per-send baseline always matches the post-send
			// sample, so delivery succeeds on attempt 1 — this file's "exactly
			// one send-keys call" assertions are about the single-pusher
			// invariant, not the delivery oracle, and must not count these
			// geometry-sample calls as pushes.
			return { ...base, stdout: Buffer.from('2;26;80;30') };
		}

		if (subcommand === 'capture-pane') {
			// The fixed display-message reading above makes attempt 1's geometry
			// pair always read "unchanged", so sendKeysVerified's content backstop
			// (dedicated visibleCaptureFn, review round 2 fix US-R2-001, CAM-359)
			// always fires. An idle prompt holds no remnant of the pushed text, so
			// the backstop confirms delivered without adding a phantom push.
			return { ...base, stdout: Buffer.from('> ') };
		}

		// Record all other calls (i.e. send-keys calls).
		calls.push({ cmd, args: [...args] });
		return base;
	};
}

// Fake capturePaneFn: always reports an idle prompt, so sendKeysVerified's
// (US-003, CAM-200) PRE-send idle-gate succeeds on the first attempt (no real
// polling/backoff). The POST-send content backstop reads through its own
// default visibleCaptureFn instead (review round 2 fix, US-R2-001, CAM-359;
// see makeFakeSpawn's capture-pane branch), preserving this file's "exactly
// one send-keys call" assertions.
const idleNeverEchoesFn = (): string => '> ';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('single-pusher guard: makeNotifyOrchestrator is the sole [cam] emitter', () => {
	test('implementer worker-report summary: exactly one send-keys call, correct argv shape', () => {
		const orchPaneId = '%0';
		const calls: SpawnCall[] = [];
		const spawnFn = makeFakeSpawn(orchPaneId, calls);

		const notify = makeNotifyOrchestrator('cam-test-session', spawnFn, idleNeverEchoesFn);

		// Construct a typical implementer report and format the summary line.
		const report: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
			notes: 'none',
		};
		const line = formatWorkerReportSummary(report);
		expect(line).toBe('[cam] US-001 DONE: typecheck ok, 1 pass / 0 fail');

		// Invoke the sole emitter.
		notify(line);

		// Exactly one send-keys call (zero-double-push).
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call).toBeDefined();

		// The call must target the correct orchestrator pane.
		expect(call!.cmd).toBe('tmux');
		const expectedArgv = buildWorkerReportSendKeysArgv(orchPaneId, line);
		expect(call!.args).toEqual(expectedArgv);

		// Argv shape invariants (sendkeys-literal-enter-gotcha, CAM-55):
		//   - No -l flag (would make 'Enter' literal text, never submitting).
		expect(call!.args).not.toContain('-l');
		//   - 'Enter' is the last element (separate key argument).
		expect(call!.args.at(-1)).toBe('Enter');
		//   - Summary line is the second-to-last element.
		expect(call!.args.at(-2)).toBe(line);
	});

	test('review verdict line (CLEAN): exactly one send-keys call, correct argv shape', () => {
		const orchPaneId = '%0';
		const calls: SpawnCall[] = [];
		const spawnFn = makeFakeSpawn(orchPaneId, calls);

		const notify = makeNotifyOrchestrator('cam-test-session', spawnFn, idleNeverEchoesFn);

		const line = formatReviewVerdictLine(1, 'CLEAN');
		expect(line).toBe('[cam] review round 1: CLEAN');

		notify(line);

		// Exactly one send-keys call.
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call).toBeDefined();

		const expectedArgv = buildWorkerReportSendKeysArgv(orchPaneId, line);
		expect(call!.cmd).toBe('tmux');
		expect(call!.args).toEqual(expectedArgv);
		expect(call!.args).not.toContain('-l');
		expect(call!.args.at(-1)).toBe('Enter');
		expect(call!.args.at(-2)).toBe(line);
	});

	test('review verdict line (FIXES_PENDING:K): exactly one send-keys call, correct argv shape', () => {
		const orchPaneId = '%2';
		const calls: SpawnCall[] = [];
		const spawnFn = makeFakeSpawn(orchPaneId, calls);

		const notify = makeNotifyOrchestrator('cam-test-session', spawnFn, idleNeverEchoesFn);

		const line = formatReviewVerdictLine(2, 'FIXES_PENDING:3');
		expect(line).toBe('[cam] review round 2: FIXES_PENDING:3');

		notify(line);

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call!.cmd).toBe('tmux');

		const expectedArgv = buildWorkerReportSendKeysArgv(orchPaneId, line);
		expect(call!.args).toEqual(expectedArgv);
		expect(call!.args).not.toContain('-l');
		expect(call!.args.at(-1)).toBe('Enter');
	});

	test('no orchestrator pane (empty list-panes): zero send-keys calls (silent no-op)', () => {
		// When the orchestrator pane cannot be resolved, makeNotifyOrchestrator is
		// a silent no-op. No send-keys call is made, preventing a phantom narration.
		const calls: SpawnCall[] = [];
		const spawnFn = makeFakeSpawn('', calls); // empty orchPaneId -> empty list-panes

		const notify = makeNotifyOrchestrator('cam-test-session', spawnFn);
		notify('[cam] US-001 DONE: typecheck ok, 1 pass / 0 fail');

		// Zero send-keys: double-push is impossible when no target exists.
		expect(calls).toHaveLength(0);
	});
});
