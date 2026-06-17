// test/supervisor/sidecar-self-exit.test.ts
//
// Unit tests for the sidecar self-exit (session-gone) feature in runSidecarLoop.
//
// Coverage:
//   1. Startup-grace: hasSessionFn always returns false, sessionSeen never latched
//      => loop does NOT exit (startup-grace prevents premature self-exit).
//   2. Session-gone: hasSessionFn returns true once (latch set) then false
//      => runSidecarLoop returns within one idle tick.

import { describe, expect, test } from 'bun:test';
import { runSidecarLoop, type RunSidecarLoopOptions, type RunSupervisorOptions } from '../../src/supervisor/loop.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal RunSupervisorOptions that never does any real I/O. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-17T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok', detail: '' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions',
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSidecarLoop — session self-exit (hasSessionFn)', () => {
	test('startup-grace: hasSessionFn always false, sessionSeen never latched => loop does NOT exit', async () => {
		// hasSessionFn returns false on every call. sessionSeen is never set.
		// The startup-grace rule must prevent any exit: the loop should only
		// stop when we throw the escape sentinel after several idle ticks.
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		let sessionCalls = 0;
		let resolvedCleanly = false;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			sleep: () => {
				sleepCount += 1;
				if (sleepCount >= 5) {
					throw ESCAPE;
				}
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: false as const, holderPid: 99 }),
			hasSessionFn: () => {
				sessionCalls += 1;
				return false; // session always absent
			},
			idlePollMs: 1,
		};

		try {
			await runSidecarLoop(opts);
			resolvedCleanly = true;
		} catch (e) {
			if (e !== ESCAPE) throw e;
			// Expected: escape sentinel fired before the loop returned cleanly.
		}

		// The loop must NOT have returned cleanly (startup-grace prevented early exit).
		expect(resolvedCleanly).toBe(false);
		// hasSessionFn was called at least once per idle tick.
		expect(sessionCalls).toBeGreaterThanOrEqual(5);
		// sleep was called — confirming we actually ran several idle ticks.
		expect(sleepCount).toBeGreaterThanOrEqual(5);
	});

	test('startup-grace race: absent->present->absent => loop exits after latch is set', async () => {
		// Simulates the startup race:
		//   tick 1: hasSessionFn() returns false  (session not yet visible)
		//           -> sessionSeen NOT set, startup-grace prevents exit -> sleep
		//   tick 2: hasSessionFn() returns true   (session now visible)
		//           -> sessionSeen latched -> sleep
		//   tick 3: hasSessionFn() returns false  (session gone)
		//           -> sessionSeen already set -> return cleanly
		//
		// Result: loop resolves with undefined; hasSessionFn called 3×; sleep 2×.
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		let sessionCalls = 0;
		const sessionResponses = [false, true, false]; // absent, present, absent

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			sleep: () => {
				sleepCount += 1;
				// Safety valve: should never need more than 5 ticks.
				if (sleepCount > 5) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: false as const, holderPid: 99 }),
			hasSessionFn: () => {
				const response = sessionResponses[sessionCalls] ?? false;
				sessionCalls += 1;
				return response;
			},
			idlePollMs: 1,
		};

		// Loop must resolve cleanly (no ESCAPE sentinel, no unhandled throw).
		await expect(runSidecarLoop(opts)).resolves.toBeUndefined();

		// hasSessionFn was called exactly three times.
		expect(sessionCalls).toBe(3);
		// sleep was called for ticks 1 and 2; on tick 3 the loop returns before sleeping.
		expect(sleepCount).toBe(2);
	});

	test('session-gone: hasSessionFn true once then false => loop returns within one idle interval', async () => {
		// hasSessionFn returns true on the first call (sessionSeen latched),
		// then false on the second call (session gone => return).
		// The loop should resolve cleanly WITHOUT hitting the safety-valve sleep.
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		let sessionCalls = 0;
		const sessionResponses = [true, false]; // first present, then gone

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			sleep: () => {
				sleepCount += 1;
				// Safety valve: if we sleep too many times the loop is not exiting.
				if (sleepCount > 5) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: false as const, holderPid: 99 }),
			hasSessionFn: () => {
				const response = sessionResponses[sessionCalls] ?? false;
				sessionCalls += 1;
				return response;
			},
			idlePollMs: 1,
		};

		// runSidecarLoop should resolve (return) cleanly once session is gone.
		await expect(runSidecarLoop(opts)).resolves.toBeUndefined();

		// hasSessionFn was called exactly twice: once to latch, once to trigger exit.
		expect(sessionCalls).toBe(2);
		// sleep was called exactly once (after the first tick where session was present).
		// The second tick: session gone + sessionSeen => return (no sleep call).
		expect(sleepCount).toBe(1);
	});
});
