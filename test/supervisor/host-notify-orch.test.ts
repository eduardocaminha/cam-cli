// test/supervisor/host-notify-orch.test.ts
//
// Unit tests for makeNotifyOrchestrator (US-002, CAM-70).
//
// Coverage:
//   1. Valid orch pane: closure invokes send-keys with the argv shape produced
//      by buildWorkerReportSendKeysArgv (no -l, Enter as separate key arg,
//      both in one call).
//   2. No orch pane (list-panes returns empty): no send-keys call (silent no-op).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { makeNotifyOrchestrator } from '../../src/supervisor/host.ts';
import { buildWorkerReportSendKeysArgv } from '../../src/supervisor/worker-report.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpawnCall = { cmd: string; args: string[] };

/**
 * Build a minimal SpawnSyncReturns<string> suitable for faking tmux calls.
 * getOrchPaneId inspects `.status` and `.stdout`; everything else is unused.
 */
function fakeResult(stdout: string, status = 0): SpawnSyncReturns<string> {
	return {
		pid: 0,
		output: [null, stdout, ''],
		stdout,
		stderr: '',
		status,
		signal: null,
	};
}

/**
 * Build a fake TmuxSpawnFn.
 *
 * - When args include 'list-panes', return `listPanesOut` with status 0.
 * - For all other calls (e.g. send-keys), return empty stdout with status 0
 *   and record the call.
 */
function makeFakeSpawnFn(
	listPanesOut: string,
	calls: SpawnCall[],
): SpawnFn {
	return (cmd, args, _opts) => {
		if (args.includes('list-panes')) {
			return fakeResult(listPanesOut);
		}
		calls.push({ cmd, args: args.slice() });
		return fakeResult('');
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeNotifyOrchestrator (US-002)', () => {
	test('valid orch pane: invokes send-keys with buildWorkerReportSendKeysArgv shape', () => {
		// list-panes output: two panes; pane index 0 has id %3.
		const listPanesOut = '0;%3\n1;%4\n';
		const calls: SpawnCall[] = [];
		const spawnFn = makeFakeSpawnFn(listPanesOut, calls);

		const notify = makeNotifyOrchestrator('cam-orch-test-abc123', spawnFn);
		const line = '[cam] review round 1: CLEAN';
		notify(line);

		// Exactly one non-list-panes call must have been recorded: the send-keys call.
		expect(calls).toHaveLength(1);
		const sendCall = calls[0];
		expect(sendCall).toBeDefined();

		// cmd must be 'tmux'
		expect(sendCall!.cmd).toBe('tmux');

		// argv must match buildWorkerReportSendKeysArgv('%3', line) exactly.
		const expectedArgv = buildWorkerReportSendKeysArgv('%3', line);
		expect(sendCall!.args).toEqual(expectedArgv);

		// Verify the shape invariants (sendkeys-literal-enter-gotcha, CAM-55):
		// No '-l' flag anywhere in the argv.
		expect(sendCall!.args).not.toContain('-l');
		// 'Enter' is the last element (separate key argument, not concatenated).
		expect(sendCall!.args.at(-1)).toBe('Enter');
		// The summary line is the second-to-last element.
		expect(sendCall!.args.at(-2)).toBe(line);
		// Both summary and Enter are in one call (not two separate send-keys calls).
		expect(calls).toHaveLength(1);
	});

	test('no orch pane (empty list-panes output): no send-keys called', () => {
		// list-panes returns empty output: getOrchPaneId returns null.
		const calls: SpawnCall[] = [];
		const spawnFn = makeFakeSpawnFn('', calls);

		const notify = makeNotifyOrchestrator('cam-orch-test-abc123', spawnFn);
		notify('[cam] review round 1: CLEAN');

		// No send-keys call: silent no-op.
		expect(calls).toHaveLength(0);
	});

	test('no orch pane (list-panes fails with non-zero status): no send-keys called', () => {
		// list-panes exits non-zero: getOrchPaneId returns null.
		const calls: SpawnCall[] = [];
		const spawnFn: SpawnFn = (cmd, args, _opts) => {
			if (args.includes('list-panes')) {
				return fakeResult('', 1); // non-zero exit
			}
			calls.push({ cmd, args: args.slice() });
			return fakeResult('');
		};

		const notify = makeNotifyOrchestrator('cam-orch-test-abc123', spawnFn);
		notify('[cam] review round 2: FIXES_PENDING:3');

		expect(calls).toHaveLength(0);
	});
});
