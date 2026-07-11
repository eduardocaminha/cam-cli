// test/stop-sidecar-liveness-watcher-kill.test.ts
//
// Unit tests for the sidecar-liveness-watcher kill leg of `cam stop`
// (US-002, CAM-207). Mirrors stop-watcher-kill.test.ts. Three cases per
// acceptance criteria:
//   (a) pid file absent -> killFn not called, sidecarLivenessWatcherKilled:false, no error
//   (b) pid file present + signal-0 fails (dead pid) ->
//         killFn not called, sidecarLivenessWatcherKilled:false, pid file is removed
//   (c) pid file present + signal-0 succeeds (live pid) ->
//         killFn called with SIGTERM, sidecarLivenessWatcherKilled:true, pid file is removed

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

describe('sidecar-liveness-watcher kill — pid file absent', () => {
	test('killFn not called, sidecarLivenessWatcherKilled:false, no error', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const report = performStop({
			cwd: '/nonexistent-cwd-lw-a',
			spawnSyncFn: noTmuxSpawn,
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			watcherPidReader: () => null,
			watcherPidAliveFn: () => false,
			watcherPidRemover: () => {},
			// sidecar-liveness-watcher pid file absent: reader returns null
			sidecarLivenessWatcherPidReader: () => null,
			sidecarLivenessWatcherPidAliveFn: () => { throw new Error('should not be called'); },
			sidecarLivenessWatcherPidRemover: () => {},
			killFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.sidecarLivenessWatcherKilled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Case (b): pid file present, signal-0 fails (dead pid)
// ---------------------------------------------------------------------------

describe('sidecar-liveness-watcher kill — pid file present, pid dead', () => {
	test('killFn not called, sidecarLivenessWatcherKilled:false, pid file removed', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		let removeCalled = false;
		const remove = () => { removeCalled = true; };

		const report = performStop({
			cwd: '/nonexistent-cwd-lw-b',
			spawnSyncFn: noTmuxSpawn,
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			watcherPidReader: () => null,
			watcherPidAliveFn: () => false,
			watcherPidRemover: () => {},
			// pid file present with a fake dead pid
			sidecarLivenessWatcherPidReader: () => 99997,
			sidecarLivenessWatcherPidAliveFn: () => false,
			sidecarLivenessWatcherPidRemover: remove,
			killFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.sidecarLivenessWatcherKilled).toBe(false);
		// pid file must be removed even when pid is dead
		expect(removeCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Case (c): pid file present, signal-0 succeeds (live pid)
// ---------------------------------------------------------------------------

describe('sidecar-liveness-watcher kill — pid file present, pid alive', () => {
	test('killFn called with SIGTERM, sidecarLivenessWatcherKilled:true, pid file removed', () => {
		const FAKE_PID = 12347;
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		let removeCalled = false;
		const remove = () => { removeCalled = true; };

		const report = performStop({
			cwd: '/nonexistent-cwd-lw-c',
			spawnSyncFn: noTmuxSpawn,
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			watcherPidReader: () => null,
			watcherPidAliveFn: () => false,
			watcherPidRemover: () => {},
			// pid file present with a fake live pid
			sidecarLivenessWatcherPidReader: () => FAKE_PID,
			sidecarLivenessWatcherPidAliveFn: () => true,
			sidecarLivenessWatcherPidRemover: remove,
			killFn,
		});

		expect(killCalls).toEqual([{ pid: FAKE_PID, signal: 'SIGTERM' }]);
		expect(report.sidecarLivenessWatcherKilled).toBe(true);
		// pid file must be removed after kill
		expect(removeCalled).toBe(true);
	});
});
