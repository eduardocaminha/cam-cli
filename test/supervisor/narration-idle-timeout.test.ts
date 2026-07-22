// test/supervisor/narration-idle-timeout.test.ts
//
// Behavioral regression test for US-001 (CAM-361): makeNotifyOrchestrator's
// best-effort narration push must wait at most a short dedicated
// NARRATION_IDLE_TIMEOUT_MS (2_000 ms) before firing sendKeysVerified's
// send-anyway fallback, never the full shared IDLE_WAIT_DEADLINE_MS
// (30_000 ms) a mid-turn orchestrator pane used to block the caller for.
//
// This exercises the REAL idle-gate poll loop (default sleepFn ->
// Bun.sleepSync, default pollIntervalMs -> 200 ms): makeNotifyOrchestrator's
// signature intentionally does not expose a sleepFn override (AC3: the
// sendKeysVerified options object gains ONLY `idleTimeoutMs`, nothing else),
// so wall-clock elapsed time is the only faithful way to prove the bound.
// Bounding NARRATION_IDLE_TIMEOUT_MS to 2_000 ms (rather than the old
// 30_000 ms shared deadline) is exactly what makes this assertion cheap
// enough to run as a normal test.
//
// Coverage:
//   1. capturePaneFn always reports a busy (never-idle) pane -> the idle-gate
//      times out, elapsed wall-clock time is bounded near
//      NARRATION_IDLE_TIMEOUT_MS (well under IDLE_WAIT_DEADLINE_MS), and the
//      send-anyway fallback fires exactly once (a single send-keys call).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { makeNotifyOrchestrator } from '../../src/supervisor/host.ts';
import { NARRATION_IDLE_TIMEOUT_MS, IDLE_WAIT_DEADLINE_MS } from '../../src/tmux/dispatch.ts';
import type { SpawnFn as TmuxSpawnFn } from '../../src/tmux/session.ts';

/** Minimal SpawnSyncReturns<string> fake for tmux calls. */
function fakeSpawnResult(stdout: string, status = 0): SpawnSyncReturns<string> {
	return {
		pid: 0,
		output: [null, stdout, ''],
		stdout,
		stderr: '',
		status,
		signal: null,
	};
}

describe('makeNotifyOrchestrator idle-gate bound (US-001, CAM-361)', () => {
	test('busy pane: send-anyway fallback fires after ~NARRATION_IDLE_TIMEOUT_MS, not IDLE_WAIT_DEADLINE_MS', () => {
		const sendCalls: string[][] = [];
		const spawnFn: TmuxSpawnFn = (_cmd, args, _opts) => {
			if (args.includes('list-panes')) return fakeSpawnResult('0;%12\n');
			// Any other call (send-keys) is the physical push; record it.
			sendCalls.push(args.slice());
			return fakeSpawnResult('');
		};

		// Busy pane: braille spinner glyph on every polled line, never idle.
		const capturePaneFn = (_paneId: string): string => '⠋\n⠋\n⠋\n⠋\n⠋';

		const notify = makeNotifyOrchestrator('cam-narration-timeout-test', spawnFn, capturePaneFn);

		const startedAt = Date.now();
		notify('[cam] narration line while orch is mid-turn');
		const elapsedMs = Date.now() - startedAt;

		// The send-anyway fallback still fires exactly once.
		expect(sendCalls.length).toBe(1);
		expect(sendCalls[0]).toContain('send-keys');

		// Bounded by NARRATION_IDLE_TIMEOUT_MS (2_000 ms) plus generous poll/
		// scheduling slack, and nowhere near the shared IDLE_WAIT_DEADLINE_MS
		// (30_000 ms) the pre-fix code would have blocked for.
		expect(elapsedMs).toBeGreaterThanOrEqual(NARRATION_IDLE_TIMEOUT_MS - 250);
		expect(elapsedMs).toBeLessThan(IDLE_WAIT_DEADLINE_MS / 2);
	});
});
