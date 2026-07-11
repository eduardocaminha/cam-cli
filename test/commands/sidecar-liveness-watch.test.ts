// test/commands/sidecar-liveness-watch.test.ts
//
// Unit tests for src/commands/sidecar-liveness-watch.ts (US-002, CAM-207)
//
// All deps are injected; no real fs/processes are touched.
//
// Test matrix:
//   AC-ALIVE-NOOP        — no respawn attempted while the sidecar reports alive
//   AC-RESPAWN-BOUNDED    — respawn attempted while dead, up to maxRespawnAttempts
//   AC-ESCALATE-ONCE      — marker written exactly once on respawn exhaustion
//   AC-NO-HOTLOOP         — no further respawn attempts once exhausted
//   AC-RECOVERY-RESETS    — becoming alive again resets attempts/exhausted

import { test, expect, describe } from 'bun:test';
import {
	runSidecarLivenessWatch,
	handleOneTick,
	type SidecarLivenessWatchOptions,
	type SidecarLivenessWatchState,
} from '../../src/commands/sidecar-liveness-watch.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the watcher and swallow the sentinel stop error thrown by sleepFn. */
async function runWatcher(opts: SidecarLivenessWatchOptions): Promise<void> {
	try {
		await runSidecarLivenessWatch(opts);
	} catch (err: unknown) {
		if (err instanceof Error && err.message === '__test_stop__') return;
		throw err;
	}
}

function makeHarness(opts: {
	/** Alive sequence per tick; last value repeats once exhausted. */
	aliveSequence: boolean[];
	maxRespawnAttempts?: number;
	maxCycles?: number;
}): {
	spawnCalls: number;
	getWritePidCalls: () => number[];
	getMarkerCalls: () => string[];
	opts: SidecarLivenessWatchOptions;
} {
	const writePidCalls: number[] = [];
	const markerCalls: string[] = [];
	let spawnCalls = 0;
	let idx = 0;
	let cycleCount = 0;
	const maxCycles = opts.maxCycles ?? opts.aliveSequence.length;

	const watcherOpts: SidecarLivenessWatchOptions = {
		aliveFn: () => {
			const val = opts.aliveSequence[idx] ?? opts.aliveSequence[opts.aliveSequence.length - 1] ?? false;
			idx++;
			return val;
		},
		spawnSidecarFn: () => {
			spawnCalls++;
			return { pid: 1000 + spawnCalls, kill: () => {} };
		},
		writePidFn: (pid: number) => {
			writePidCalls.push(pid);
		},
		writeMarkerFn: (detail: string) => {
			markerCalls.push(detail);
		},
		sleepFn: (_ms: number) => {
			cycleCount++;
			if (cycleCount >= maxCycles) {
				throw new Error('__test_stop__');
			}
		},
		pollIntervalMs: 0,
		backoffMs: 0,
		maxRespawnAttempts: opts.maxRespawnAttempts ?? 3,
	};

	return {
		get spawnCalls() {
			return spawnCalls;
		},
		getWritePidCalls: () => writePidCalls,
		getMarkerCalls: () => markerCalls,
		opts: watcherOpts,
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('sidecar-liveness-watch', () => {
	test('AC-ALIVE-NOOP: no respawn attempted while the sidecar reports alive', async () => {
		const { getWritePidCalls, getMarkerCalls, opts } = makeHarness({
			aliveSequence: [true, true, true],
		});

		await runWatcher(opts);

		expect(getWritePidCalls().length).toBe(0);
		expect(getMarkerCalls().length).toBe(0);
	});

	test('AC-RESPAWN-BOUNDED: respawn attempted while dead, up to maxRespawnAttempts', async () => {
		const harness = makeHarness({
			aliveSequence: [false, false, false, false, false],
			maxRespawnAttempts: 3,
			maxCycles: 4,
		});

		await runWatcher(harness.opts);

		// 3 respawn attempts, then the 4th tick escalates (no further spawn).
		expect(harness.spawnCalls).toBe(3);
		expect(harness.getWritePidCalls()).toEqual([1001, 1002, 1003]);
	});

	test('AC-ESCALATE-ONCE: marker written exactly once on respawn exhaustion', async () => {
		const harness = makeHarness({
			aliveSequence: [false, false, false, false, false, false],
			maxRespawnAttempts: 2,
			maxCycles: 5,
		});

		await runWatcher(harness.opts);

		expect(harness.getMarkerCalls().length).toBe(1);
		expect(harness.getMarkerCalls()[0]).toContain('exhausted');
	});

	test('AC-NO-HOTLOOP: no further respawn attempts once exhausted', async () => {
		const harness = makeHarness({
			aliveSequence: [false, false, false, false, false, false, false, false],
			maxRespawnAttempts: 2,
			maxCycles: 8,
		});

		await runWatcher(harness.opts);

		// Only 2 respawn attempts ever, regardless of how many more dead ticks follow.
		expect(harness.spawnCalls).toBe(2);
		expect(harness.getMarkerCalls().length).toBe(1);
	});

	test('AC-RECOVERY-RESETS: becoming alive again resets attempts/exhausted', async () => {
		// dead, dead (exhausts at maxRespawnAttempts=1), alive (recovery), dead again (fresh attempt 1)
		const harness = makeHarness({
			aliveSequence: [false, false, true, false],
			maxRespawnAttempts: 1,
			maxCycles: 4,
		});

		await runWatcher(harness.opts);

		// Attempt 1 (tick 0), exhaust+marker (tick 1), alive no-op (tick 2), fresh attempt 1 (tick 3).
		expect(harness.spawnCalls).toBe(2);
		expect(harness.getMarkerCalls().length).toBe(1);
	});
});

describe('handleOneTick (unit)', () => {
	function makeDeps(overrides: Partial<Parameters<typeof handleOneTick>[0]> = {}) {
		return {
			aliveFn: () => false,
			spawnSidecarFn: () => ({ pid: 42, kill: () => {} }),
			writePidFn: () => {},
			writeMarkerFn: () => {},
			pollIntervalMs: 2000,
			backoffMs: 500,
			maxRespawnAttempts: 3,
			...overrides,
		};
	}

	test('alive resets state and returns pollIntervalMs', () => {
		const state: SidecarLivenessWatchState = { attempts: 2, exhausted: true };
		const sleepMs = handleOneTick(makeDeps({ aliveFn: () => true }), state);
		expect(state.attempts).toBe(0);
		expect(state.exhausted).toBe(false);
		expect(sleepMs).toBe(2000);
	});

	test('dead and exhausted is a no-op returning pollIntervalMs', () => {
		const state: SidecarLivenessWatchState = { attempts: 5, exhausted: true };
		let spawnCalled = false;
		const sleepMs = handleOneTick(
			makeDeps({ spawnSidecarFn: () => { spawnCalled = true; return { pid: 1, kill: () => {} }; } }),
			state,
		);
		expect(spawnCalled).toBe(false);
		expect(sleepMs).toBe(2000);
	});

	test('dead and under bound respawns and returns backoffMs', () => {
		const state: SidecarLivenessWatchState = { attempts: 0, exhausted: false };
		const writePidCalls: number[] = [];
		const sleepMs = handleOneTick(
			makeDeps({ writePidFn: (pid: number) => writePidCalls.push(pid) }),
			state,
		);
		expect(writePidCalls).toEqual([42]);
		expect(state.attempts).toBe(1);
		expect(state.exhausted).toBe(false);
		expect(sleepMs).toBe(500);
	});

	test('dead and reaching the bound escalates: writes marker, latches exhausted', () => {
		const state: SidecarLivenessWatchState = { attempts: 3, exhausted: false };
		let markerDetail = '';
		const sleepMs = handleOneTick(
			makeDeps({ maxRespawnAttempts: 3, writeMarkerFn: (detail: string) => { markerDetail = detail; } }),
			state,
		);
		expect(state.attempts).toBe(4);
		expect(state.exhausted).toBe(true);
		expect(markerDetail).toContain('exhausted');
		expect(sleepMs).toBe(2000);
	});
});
