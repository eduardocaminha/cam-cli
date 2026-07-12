// test/commands/orch-recycle-watch.test.ts
//
// Unit tests for src/commands/orch-recycle-watch.ts
//
// All deps are injected; no real fs/processes are touched.
//
// Test matrix:
//   AC-SIGTERM-present  — SIGTERM sent when recycle marker is present
//   AC-SIGTERM-absent   — SIGTERM NOT sent when only a handoff file exists (no marker)
//   AC-SIGNAL-VALUE     — The signal sent is exactly 'SIGTERM' (signal 15)
//   AC-CONSUME-ONCE     — Exactly one kill per marker arm; marker removed before next poll

import { test, expect, describe } from 'bun:test';
import {
	runOrchRecycleWatch,
	checkBackstop,
	type OrchRecycleWatchOptions,
	type BackstopDeps,
} from '../../src/commands/orch-recycle-watch.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a sequence-driven readMarkerFn.
 * Returns true for the first `trueCount` calls, then false forever.
 * Tracks how many times it was called so tests can assert on poll count.
 */
function makeSequenceMarker(sequence: boolean[]): { fn: () => boolean; calls: number[] } {
	const calls: number[] = [];
	let idx = 0;
	const fn = (): boolean => {
		const val = sequence[idx] ?? false;
		calls.push(idx);
		idx++;
		return val;
	};
	return { fn, calls };
}

// Run the watcher and swallow the sentinel stop error.
async function runWatcher(opts: OrchRecycleWatchOptions): Promise<void> {
	try {
		await runOrchRecycleWatch(opts);
	} catch (err: unknown) {
		if (err instanceof Error && err.message === '__test_stop__') return;
		throw err;
	}
}

// Helper that re-evaluates removeCalls from the harness via a captured counter
function makeHarnessWithCounter(opts: {
	markerSequence: boolean[];
	sessionId?: string | null;
	/** undefined = default to 9999; null = return null (no PID found). */
	resolvedPid?: number | null;
	maxCycles?: number;
}): { killCalls: Array<{ pid: number; signal: NodeJS.Signals }>; getRemoveCalls: () => number; opts: OrchRecycleWatchOptions } {
	const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	let removeCalls = 0;
	let cycleCount = 0;
	const maxCycles = opts.maxCycles ?? opts.markerSequence.length;

	const { fn: readMarkerFn } = makeSequenceMarker(opts.markerSequence);
	// Use explicit undefined-check so null (no PID) is distinct from default 9999.
	const resolvedPid = opts.resolvedPid !== undefined ? opts.resolvedPid : 9999;

	const watcherOpts: OrchRecycleWatchOptions = {
		readMarkerFn,
		readSessionIdFn: () => opts.sessionId !== undefined ? opts.sessionId : 'test-session-uuid-1234',
		resolvePidFn: () => resolvedPid,
		killFn: (pid, signal) => { killCalls.push({ pid, signal }); },
		removeMarkerFn: () => { removeCalls++; },
		sleepFn: (_ms: number) => {
			cycleCount++;
			if (cycleCount >= maxCycles) {
				throw new Error('__test_stop__');
			}
		},
		pollIntervalMs: 0,
	};

	return { killCalls, getRemoveCalls: () => removeCalls, opts: watcherOpts };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('orch-recycle-watch', () => {
	test('AC-SIGTERM-present: SIGTERM sent when recycle marker is present', async () => {
		const { killCalls, getRemoveCalls, opts } = makeHarnessWithCounter({
			markerSequence: [true, false],
			maxCycles: 2,
		});

		await runWatcher(opts);

		expect(killCalls.length).toBe(1);
		expect(killCalls[0]).toMatchObject({ pid: 9999, signal: 'SIGTERM' });
		expect(getRemoveCalls()).toBe(1);
	});

	test('AC-SIGTERM-absent: SIGTERM NOT sent when no recycle marker (only handoff present)', async () => {
		// Simulate: only handoff file written, no recycle marker.
		const { killCalls, getRemoveCalls, opts } = makeHarnessWithCounter({
			markerSequence: [false, false, false],
			maxCycles: 3,
		});

		await runWatcher(opts);

		expect(killCalls.length).toBe(0);
		expect(getRemoveCalls()).toBe(0);
	});

	test('AC-SIGNAL-VALUE: the kill signal is SIGTERM, not SIGKILL', async () => {
		const { killCalls, opts } = makeHarnessWithCounter({
			markerSequence: [true],
			maxCycles: 1,
		});

		await runWatcher(opts);

		expect(killCalls.length).toBeGreaterThanOrEqual(1);
		const signal = killCalls[0]?.signal;
		expect(signal).toBe('SIGTERM');
		// Confirm it is NOT SIGKILL.
		expect(signal).not.toBe('SIGKILL');
	});

	test('AC-CONSUME-ONCE: exactly one kill per marker arm; marker removed before next poll', async () => {
		// Sequence: marker present on poll 0 only; polls 1-2 return false.
		// Verifies that even if the marker were to reappear, a single arm yields
		// a single kill, and the remove fires exactly once per arm.
		const { killCalls, getRemoveCalls, opts } = makeHarnessWithCounter({
			markerSequence: [true, false, false],
			maxCycles: 3,
		});

		await runWatcher(opts);

		// Exactly one kill triggered.
		expect(killCalls.length).toBe(1);
		// Exactly one remove triggered.
		expect(getRemoveCalls()).toBe(1);
	});

	test('no kill when PID cannot be resolved', async () => {
		// resolvePidFn returns null (e.g. session already gone).
		const { killCalls, getRemoveCalls, opts } = makeHarnessWithCounter({
			markerSequence: [true],
			resolvedPid: null,
			maxCycles: 1,
		});

		await runWatcher(opts);

		// No kill, but marker is still consumed.
		expect(killCalls.length).toBe(0);
		expect(getRemoveCalls()).toBe(1);
	});

	test('readSessionIdFn is deprecated/ignored: resolvePidFn drives the kill, not the session UUID', async () => {
		// US-002/AC2: the tick path no longer gates on readSessionIdFn.
		// Even if readSessionIdFn returns null (the old no-kill gate), the kill
		// now fires whenever resolvePidFn returns a non-null PID.
		const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		let removeCalls = 0;
		let cycles = 0;

		const watcherOpts: OrchRecycleWatchOptions = {
			readMarkerFn: () => true,
			readSessionIdFn: () => null, // deprecated, silently ignored
			resolvePidFn: () => 9999,    // non-null -> kill happens
			killFn: (pid, signal) => { killCalls.push({ pid, signal }); },
			removeMarkerFn: () => { removeCalls++; },
			sleepFn: () => {
				cycles++;
				if (cycles >= 1) throw new Error('__test_stop__');
			},
			pollIntervalMs: 0,
		};

		await runWatcher(watcherOpts);

		// With the new code: resolvePidFn returning 9999 causes a kill.
		expect(killCalls.length).toBe(1);
		expect(killCalls[0]).toEqual({ pid: 9999, signal: 'SIGTERM' });
		// Marker is consumed after the kill.
		expect(removeCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// checkBackstop (US-001/CAM-172: never arm without a handoff on disk)
// ---------------------------------------------------------------------------

describe('checkBackstop', () => {
	test('over-threshold occupancy with NO handoff present: no-op, armMarkerFn not called', () => {
		let armCalls = 0;
		const deps: BackstopDeps = {
			readOccupancyFn: () => 900_000,
			armMarkerFn: () => { armCalls++; },
			contextWindow: 1_000_000,
			backstopFraction: 0.8,
			handoffExistsFn: () => false,
		};

		checkBackstop(deps);

		expect(armCalls).toBe(0);
	});

	test('over-threshold occupancy AND handoff present: arms as before', () => {
		let armCalls = 0;
		const deps: BackstopDeps = {
			readOccupancyFn: () => 900_000,
			armMarkerFn: () => { armCalls++; },
			contextWindow: 1_000_000,
			backstopFraction: 0.8,
			handoffExistsFn: () => true,
		};

		checkBackstop(deps);

		expect(armCalls).toBe(1);
	});

	test('under-threshold occupancy: no-op regardless of handoff presence', () => {
		let armCalls = 0;
		const deps: BackstopDeps = {
			readOccupancyFn: () => 100,
			armMarkerFn: () => { armCalls++; },
			contextWindow: 1_000_000,
			backstopFraction: 0.8,
			handoffExistsFn: () => true,
		};

		checkBackstop(deps);

		expect(armCalls).toBe(0);
	});

	test('null occupancy: no-op, handoffExistsFn not even required to matter', () => {
		let armCalls = 0;
		const deps: BackstopDeps = {
			readOccupancyFn: () => null,
			armMarkerFn: () => { armCalls++; },
			contextWindow: 1_000_000,
			backstopFraction: 0.8,
			handoffExistsFn: () => true,
		};

		checkBackstop(deps);

		expect(armCalls).toBe(0);
	});
});
