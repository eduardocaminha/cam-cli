// test/stop-sidecar-kill.test.ts
//
// Unit tests for the sidecar-kill leg of `cam stop` (US-001).
//
// Three cases (per acceptance criteria):
//   (a) pid file absent -> killFn not called, sidecarKilled:false, no error
//   (b) pid file present + signal-0 throws (dead pid) ->
//         killFn not called, sidecarKilled:false, pid file is unlinked
//   (c) pid file present + signal-0 succeeds (live pid) ->
//         killFn called with SIGTERM, sidecarKilled:true, pid file is unlinked
//
// All three use injected sidecarPidReader / sidecarPidAliveFn / sidecarPidRemover
// / killFn so no real OS pids are signalled.

import { describe, expect, test } from 'bun:test';
import type { KillFn, SpawnSyncFn } from '../src/commands/stop.ts';
import { performStop } from '../src/commands/stop.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake SpawnSyncFn that returns exit-1 for everything (tmux unavailable). */
const noTmuxSpawn: SpawnSyncFn = () => ({
	pid: 1,
	output: ['', '', ''] as (string | null)[],
	stdout: '',
	stderr: '',
	status: 1,
	signal: null,
});

// ---------------------------------------------------------------------------
// Case (a): pid file absent
// ---------------------------------------------------------------------------

describe('sidecar kill — pid file absent', () => {
	test('killFn not called, sidecarKilled:false, no error', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const report = performStop({
			cwd: '/nonexistent-cwd-a',
			spawnSyncFn: noTmuxSpawn,
			// pid file absent: reader returns null
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => { throw new Error('should not be called'); },
			sidecarPidRemover: () => { /* no-op */ },
			killFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.sidecarKilled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Case (b): pid file present, signal-0 throws (dead pid)
// ---------------------------------------------------------------------------

describe('sidecar kill — pid file present, pid dead', () => {
	test('killFn not called, sidecarKilled:false, pid file unlinked', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		let removeCalled = false;
		const remove = () => { removeCalled = true; };

		const report = performStop({
			cwd: '/nonexistent-cwd-b',
			spawnSyncFn: noTmuxSpawn,
			// pid file present with a fake dead pid
			sidecarPidReader: () => 99999,
			// signal-0 throws -> dead
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: remove,
			killFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.sidecarKilled).toBe(false);
		// pid file must be unlinked even when pid is dead
		expect(removeCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Case (c): pid file present, signal-0 succeeds (live pid)
// ---------------------------------------------------------------------------

describe('sidecar kill — pid file present, pid alive', () => {
	test('killFn called with SIGTERM, sidecarKilled:true, pid file unlinked', () => {
		const FAKE_PID = 12345;
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		let removeCalled = false;
		const remove = () => { removeCalled = true; };

		const report = performStop({
			cwd: '/nonexistent-cwd-c',
			spawnSyncFn: noTmuxSpawn,
			// pid file present with a fake live pid
			sidecarPidReader: () => FAKE_PID,
			// signal-0 succeeds -> alive
			sidecarPidAliveFn: () => true,
			sidecarPidRemover: remove,
			killFn,
		});

		expect(killCalls).toEqual([{ pid: FAKE_PID, signal: 'SIGTERM' }]);
		expect(report.sidecarKilled).toBe(true);
		// pid file must be unlinked after kill
		expect(removeCalled).toBe(true);
	});
});
