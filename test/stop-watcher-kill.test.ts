// test/stop-watcher-kill.test.ts
//
// Unit tests for the recycle-watcher kill leg of `cam stop` (US-R1-001).
//
// Mirrors stop-sidecar-kill.test.ts. Three cases per acceptance criteria:
//   (a) pid file absent -> killFn not called, watcherKilled:false, no error
//   (b) pid file present + signal-0 fails (dead pid) ->
//         killFn not called, watcherKilled:false, pid file is removed
//   (c) pid file present + signal-0 succeeds (live pid) ->
//         killFn called with SIGTERM, watcherKilled:true, pid file is removed

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

describe('watcher kill — pid file absent', () => {
	test('killFn not called, watcherKilled:false, no error', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const report = performStop({
			cwd: '/nonexistent-cwd-w-a',
			spawnSyncFn: noTmuxSpawn,
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			// watcher pid file absent: reader returns null
			watcherPidReader: () => null,
			watcherPidAliveFn: () => { throw new Error('should not be called'); },
			watcherPidRemover: () => {},
			killFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.watcherKilled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Case (b): pid file present, signal-0 fails (dead pid)
// ---------------------------------------------------------------------------

describe('watcher kill — pid file present, pid dead', () => {
	test('killFn not called, watcherKilled:false, pid file removed', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		let removeCalled = false;
		const remove = () => { removeCalled = true; };

		const report = performStop({
			cwd: '/nonexistent-cwd-w-b',
			spawnSyncFn: noTmuxSpawn,
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			// pid file present with a fake dead pid
			watcherPidReader: () => 99998,
			watcherPidAliveFn: () => false,
			watcherPidRemover: remove,
			killFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.watcherKilled).toBe(false);
		// pid file must be removed even when pid is dead
		expect(removeCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Case (c): pid file present, signal-0 succeeds (live pid)
// ---------------------------------------------------------------------------

describe('watcher kill — pid file present, pid alive', () => {
	test('killFn called with SIGTERM, watcherKilled:true, pid file removed', () => {
		const FAKE_PID = 12346;
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		let removeCalled = false;
		const remove = () => { removeCalled = true; };

		const report = performStop({
			cwd: '/nonexistent-cwd-w-c',
			spawnSyncFn: noTmuxSpawn,
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			// pid file present with a fake live pid
			watcherPidReader: () => FAKE_PID,
			watcherPidAliveFn: () => true,
			watcherPidRemover: remove,
			killFn,
		});

		expect(killCalls).toEqual([{ pid: FAKE_PID, signal: 'SIGTERM' }]);
		expect(report.watcherKilled).toBe(true);
		// pid file must be removed after kill
		expect(removeCalled).toBe(true);
	});
});
