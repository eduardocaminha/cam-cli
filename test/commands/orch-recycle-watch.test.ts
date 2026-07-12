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
	type BackstopEpisodeState,
} from '../../src/commands/orch-recycle-watch.ts';

// ---------------------------------------------------------------------------
// checkBackstop test helper (US-002/CAM-172)
// ---------------------------------------------------------------------------

/**
 * Build a fully-populated BackstopDeps with sane no-op defaults for the
 * signal/fallback/clock seams, overridable per test. `episode` defaults to a
 * fresh, unsignaled state unless overridden (tests that need to simulate
 * across-tick persistence pass the SAME episode object to multiple calls).
 */
function makeBackstopDeps(overrides: Partial<BackstopDeps> = {}): BackstopDeps {
	return {
		readOccupancyFn: () => 900_000,
		armMarkerFn: () => {},
		contextWindow: 1_000_000,
		backstopFraction: 0.8,
		handoffExistsFn: () => false,
		signalPaneFn: () => {},
		writeMinimalHandoffFn: () => {},
		nowFn: () => 0,
		signalTimeoutMs: 30_000,
		episode: { signaledAt: null },
		...overrides,
	};
}

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
	test('over-threshold occupancy with NO handoff present: no-op arm, but signals the pane', () => {
		let armCalls = 0;
		let signalCalls = 0;
		const deps = makeBackstopDeps({
			handoffExistsFn: () => false,
			armMarkerFn: () => { armCalls++; },
			signalPaneFn: () => { signalCalls++; },
		});

		checkBackstop(deps);

		expect(armCalls).toBe(0);
		expect(signalCalls).toBe(1);
	});

	test('over-threshold occupancy AND handoff present: arms as before, no signal', () => {
		let armCalls = 0;
		let signalCalls = 0;
		const deps = makeBackstopDeps({
			handoffExistsFn: () => true,
			armMarkerFn: () => { armCalls++; },
			signalPaneFn: () => { signalCalls++; },
		});

		checkBackstop(deps);

		expect(armCalls).toBe(1);
		expect(signalCalls).toBe(0);
	});

	test('under-threshold occupancy: no-op regardless of handoff presence', () => {
		let armCalls = 0;
		const deps = makeBackstopDeps({
			readOccupancyFn: () => 100,
			handoffExistsFn: () => true,
			armMarkerFn: () => { armCalls++; },
		});

		checkBackstop(deps);

		expect(armCalls).toBe(0);
	});

	test('null occupancy: no-op, handoffExistsFn not even required to matter', () => {
		let armCalls = 0;
		const deps = makeBackstopDeps({
			readOccupancyFn: () => null,
			handoffExistsFn: () => true,
			armMarkerFn: () => { armCalls++; },
		});

		checkBackstop(deps);

		expect(armCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// checkBackstop episode state machine (US-002/CAM-172: signal, then
// deterministic minimal fallback, then arm)
// ---------------------------------------------------------------------------

describe('checkBackstop: authored-handoff signal + fallback episode', () => {
	test('AC1: signals once per episode, not on every subsequent tick while unresolved', () => {
		let signalCalls = 0;
		const episode: BackstopEpisodeState = { signaledAt: null };
		let clock = 1_000;
		const deps = makeBackstopDeps({
			handoffExistsFn: () => false,
			signalPaneFn: () => { signalCalls++; },
			nowFn: () => clock,
			episode,
		});

		// Tick 1: fresh episode -> signals once.
		checkBackstop(deps);
		expect(signalCalls).toBe(1);
		expect(episode.signaledAt).toBe(1_000);

		// Ticks 2-4 (simulated 2s polls, still well within the 30s grace window):
		// no re-signal.
		clock = 3_000;
		checkBackstop(deps);
		clock = 5_000;
		checkBackstop(deps);
		clock = 7_000;
		checkBackstop(deps);
		expect(signalCalls).toBe(1);
	});

	test('AC2: handoff appears within 30s of the signal — arms via handoffExistsFn, never writes its own', () => {
		let armCalls = 0;
		let writeMinimalCalls = 0;
		let handoffAppeared = false;
		const episode: BackstopEpisodeState = { signaledAt: null };
		let clock = 0;
		const deps = makeBackstopDeps({
			handoffExistsFn: () => handoffAppeared,
			armMarkerFn: () => { armCalls++; },
			writeMinimalHandoffFn: () => { writeMinimalCalls++; },
			nowFn: () => clock,
			episode,
		});

		// Tick 1: signals.
		checkBackstop(deps);
		expect(episode.signaledAt).toBe(0);

		// 10s later, the agent authors its own handoff.
		clock = 10_000;
		handoffAppeared = true;
		checkBackstop(deps);

		expect(armCalls).toBe(1);
		expect(writeMinimalCalls).toBe(0);
		// Episode resolved: signaledAt cleared.
		expect(episode.signaledAt).toBeNull();
	});

	test('AC3: no handoff within 30s — writes the deterministic minimal handoff, then arms', () => {
		let armCalls = 0;
		let writeMinimalCalls = 0;
		let signalCalls = 0;
		const callOrder: string[] = [];
		const episode: BackstopEpisodeState = { signaledAt: null };
		let clock = 0;
		const deps = makeBackstopDeps({
			handoffExistsFn: () => false,
			armMarkerFn: () => { armCalls++; callOrder.push('arm'); },
			writeMinimalHandoffFn: () => { writeMinimalCalls++; callOrder.push('write'); },
			signalPaneFn: () => { signalCalls++; },
			nowFn: () => clock,
			signalTimeoutMs: 30_000,
			episode,
		});

		// Tick 1: signals.
		checkBackstop(deps);
		expect(signalCalls).toBe(1);

		// Still within the grace window: no fallback yet.
		clock = 29_999;
		checkBackstop(deps);
		expect(writeMinimalCalls).toBe(0);
		expect(armCalls).toBe(0);

		// Grace period elapsed: deterministic fallback fires, then arms.
		clock = 30_001;
		checkBackstop(deps);

		expect(writeMinimalCalls).toBe(1);
		expect(armCalls).toBe(1);
		expect(callOrder).toEqual(['write', 'arm']);
		// Signal was never re-sent.
		expect(signalCalls).toBe(1);
		// Episode resolved.
		expect(episode.signaledAt).toBeNull();
	});

	test('AC5: the 30s timeout and clock are injectable — a fake clock drives the episode with no real sleep', () => {
		// Proves the state machine is testable with zero real time elapsed:
		// this test itself takes ~0ms even though it exercises a "30s" window.
		let writeMinimalCalls = 0;
		const episode: BackstopEpisodeState = { signaledAt: null };
		let clock = 0;
		const deps = makeBackstopDeps({
			handoffExistsFn: () => false,
			writeMinimalHandoffFn: () => { writeMinimalCalls++; },
			nowFn: () => clock,
			signalTimeoutMs: 5, // tiny injected timeout, no relation to real wall-clock
			episode,
		});

		checkBackstop(deps); // signals
		clock = 6; // "6ms" later, past the tiny injected timeout
		checkBackstop(deps);

		expect(writeMinimalCalls).toBe(1);
	});

	test('episode resets when occupancy drops back under threshold before the fallback fires', () => {
		let signalCalls = 0;
		let writeMinimalCalls = 0;
		const episode: BackstopEpisodeState = { signaledAt: null };
		let occupancy = 900_000;
		let clock = 0;
		const deps = makeBackstopDeps({
			readOccupancyFn: () => occupancy,
			handoffExistsFn: () => false,
			signalPaneFn: () => { signalCalls++; },
			writeMinimalHandoffFn: () => { writeMinimalCalls++; },
			nowFn: () => clock,
			episode,
		});

		checkBackstop(deps); // signals, episode.signaledAt = 0
		expect(episode.signaledAt).toBe(0);

		// Occupancy drops back under the threshold: episode clears.
		occupancy = 100;
		clock = 5_000;
		checkBackstop(deps);
		expect(episode.signaledAt).toBeNull();

		// Occupancy climbs back over threshold: this is a FRESH episode, so it
		// signals again rather than treating it as continuation of the old one.
		occupancy = 900_000;
		clock = 6_000;
		checkBackstop(deps);
		expect(signalCalls).toBe(2);
		expect(writeMinimalCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// runOrchRecycleWatch wiring: OrchRecycleWatchOptions-level seams compose into
// the BackstopDeps consumed by checkBackstop (US-002/CAM-172 AC5).
// ---------------------------------------------------------------------------

describe('runOrchRecycleWatch: authored-handoff signal wiring', () => {
	test('resolveOrchPaneIdFn + signalPaneFn compose: pane id resolved fresh, then signalled', async () => {
		let resolveCalls = 0;
		let signalledPaneIds: string[] = [];
		let cycles = 0;

		const opts: OrchRecycleWatchOptions = {
			readMarkerFn: () => false,
			resolvePidFn: () => null,
			killFn: () => {},
			removeMarkerFn: () => {},
			readOccupancyFn: () => 900_000,
			contextWindow: 1_000_000,
			backstopFraction: 0.8,
			handoffExistsFn: () => false,
			resolveOrchPaneIdFn: () => { resolveCalls++; return '%3'; },
			signalPaneFn: (paneId: string) => { signalledPaneIds.push(paneId); },
			writeMinimalHandoffFn: () => {},
			nowFn: () => 0,
			sleepFn: () => {
				cycles++;
				if (cycles >= 1) throw new Error('__test_stop__');
			},
			pollIntervalMs: 0,
		};

		try {
			await runOrchRecycleWatch(opts);
		} catch (err: unknown) {
			if (!(err instanceof Error && err.message === '__test_stop__')) throw err;
		}

		expect(resolveCalls).toBe(1);
		expect(signalledPaneIds).toEqual(['%3']);
	});

	test('resolveOrchPaneIdFn returning null: signalPaneFn is never called (best-effort no-op)', async () => {
		let signalCalls = 0;
		let cycles = 0;

		const opts: OrchRecycleWatchOptions = {
			readMarkerFn: () => false,
			resolvePidFn: () => null,
			killFn: () => {},
			removeMarkerFn: () => {},
			readOccupancyFn: () => 900_000,
			contextWindow: 1_000_000,
			backstopFraction: 0.8,
			handoffExistsFn: () => false,
			resolveOrchPaneIdFn: () => null,
			signalPaneFn: () => { signalCalls++; },
			writeMinimalHandoffFn: () => {},
			nowFn: () => 0,
			sleepFn: () => {
				cycles++;
				if (cycles >= 1) throw new Error('__test_stop__');
			},
			pollIntervalMs: 0,
		};

		try {
			await runOrchRecycleWatch(opts);
		} catch (err: unknown) {
			if (!(err instanceof Error && err.message === '__test_stop__')) throw err;
		}

		expect(signalCalls).toBe(0);
	});
});
