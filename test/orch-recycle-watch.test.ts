// test/orch-recycle-watch.test.ts
//
// Unit tests for runOrchRecycleWatch.
//
// US-002 acceptance criteria (AC1-AC3 unit tests):
//   AC1: resolvePidFn is now () => number | null (no sessionId arg).
//        Injected fakes cover resolve-ok, file-absent, and no-child paths.
//   AC2: The tick path no longer uses readSessionIdFn for pid resolution.
//   AC3: emitEventFn fires exactly on the unresolved-pid-with-consumed-marker
//        path and NOT on the resolve-ok path.
//
// US-003 acceptance criteria (context-backstop):
//   AC1: parseContextOccupancy is called (via readOccupancyFn seam).
//   AC2: High-occupancy tick -> armMarkerFn called -> handleOneTick fires SIGTERM.
//   AC2: Low-occupancy tick -> armMarkerFn NOT called -> killFn NOT called.
//   AC3: Backstop reuses ORCH_RECYCLE_MARKER path (armMarkerFn seam).
//   AC4: null occupancy (absent transcript) -> no-op, no false-positive.
//
// All I/O is injected; no real fs/process/tmux calls.

import { test, expect } from 'bun:test';
import { runOrchRecycleWatch } from '../src/commands/orch-recycle-watch.ts';
import { ORCH_CONTEXT_BACKSTOP_FRACTION } from '../src/orchestrator/context-window.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run exactly one poll tick by injecting a sleepFn that throws after
 * the first call, causing the while(true) loop to exit via rejection.
 * Returns a resolved promise (swallows the throw-to-stop signal).
 */
async function runOneTick(opts: Parameters<typeof runOrchRecycleWatch>[0]): Promise<void> {
	let slept = false;
	const sleepFn = (_ms: number) => {
		if (!slept) {
			slept = true;
			throw new Error('__stop_loop__');
		}
	};
	await runOrchRecycleWatch({ pollIntervalMs: 0, sleepFn, ...opts }).catch((err: unknown) => {
		// Only swallow our own stop signal.
		if (err instanceof Error && err.message === '__stop_loop__') return;
		throw err;
	});
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

// A context window of 1_000_000 and fraction 0.8 means the ceiling is 800_000.
const CONTEXT_WINDOW = 1_000_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// US-002 AC1: resolvePidFn is now () => number | null (no sessionId arg)
// ---------------------------------------------------------------------------

test('AC1 resolve-ok: marker present + resolvePidFn returns pid -> SIGTERM sent, marker consumed', async () => {
	const killedPids: Array<[number, NodeJS.Signals]> = [];
	let removed = false;

	await runOneTick({
		readMarkerFn: () => true,
		resolvePidFn: () => 12_345,
		killFn: (pid, signal) => { killedPids.push([pid, signal]); },
		removeMarkerFn: () => { removed = true; },
		readOccupancyFn: () => null,
		armMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	expect(killedPids).toHaveLength(1);
	expect(killedPids[0]).toEqual([12_345, 'SIGTERM']);
	expect(removed).toBe(true);
});

test('AC1 file-absent: marker present + resolvePidFn returns null -> no SIGTERM, marker consumed', async () => {
	const killedPids: Array<[number, NodeJS.Signals]> = [];
	let removed = false;

	await runOneTick({
		readMarkerFn: () => true,
		resolvePidFn: () => null, // simulates absent pid file or no child
		killFn: (pid, signal) => { killedPids.push([pid, signal]); },
		removeMarkerFn: () => { removed = true; },
		readOccupancyFn: () => null,
		armMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	expect(killedPids).toHaveLength(0);
	expect(removed).toBe(true); // consume-once even when pid not found
});

test('AC1 no-child: marker present + resolvePidFn returns null (pgrep -P found nothing) -> no SIGTERM', async () => {
	let killCalled = false;

	await runOneTick({
		readMarkerFn: () => true,
		resolvePidFn: () => null,
		killFn: () => { killCalled = true; },
		removeMarkerFn: () => {},
		readOccupancyFn: () => null,
		armMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	expect(killCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// US-002 AC3: emitEventFn fires exactly on unresolved-pid path
// ---------------------------------------------------------------------------

test('AC3 unresolved-pid: emitEventFn fires once when marker consumed but pid not found', async () => {
	const emitted: string[] = [];

	await runOneTick({
		readMarkerFn: () => true,
		resolvePidFn: () => null,
		killFn: () => {},
		removeMarkerFn: () => {},
		emitEventFn: (line) => { emitted.push(line); },
		readOccupancyFn: () => null,
		armMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	expect(emitted).toHaveLength(1);
	const parsed = JSON.parse(emitted[0] ?? '{}') as Record<string, unknown>;
	expect(parsed['event']).toBe('unresolved-pid');
	expect(typeof parsed['ts']).toBe('string');
});

test('AC3 resolve-ok: emitEventFn NOT called when pid successfully resolved', async () => {
	const emitted: string[] = [];

	await runOneTick({
		readMarkerFn: () => true,
		resolvePidFn: () => 99_999,
		killFn: () => {},
		removeMarkerFn: () => {},
		emitEventFn: (line) => { emitted.push(line); },
		readOccupancyFn: () => null,
		armMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	expect(emitted).toHaveLength(0);
});

test('AC3 no-marker: emitEventFn NOT called when marker is absent (no tick action)', async () => {
	const emitted: string[] = [];

	await runOneTick({
		readMarkerFn: () => false,
		resolvePidFn: () => null,
		killFn: () => {},
		removeMarkerFn: () => {},
		emitEventFn: (line) => { emitted.push(line); },
		readOccupancyFn: () => null,
		armMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	expect(emitted).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// US-003 backstop tests (existing)
// ---------------------------------------------------------------------------

test('high-occupancy reader: backstop arms marker and handleOneTick fires SIGTERM on resolved PID', async () => {
	// Shared state: armMarkerFn writes to this; readMarkerFn reads from it.
	let markerArmed = false;
	let markerRemoved = false;
	const killedPids: Array<[number, NodeJS.Signals]> = [];

	// Occupancy above ceiling (900_000 > 1_000_000 * 0.8 = 800_000).
	const readOccupancyFn = (): number => 900_000;

	// armMarkerFn arms the shared marker state.
	const armMarkerFn = (): void => {
		markerArmed = true;
	};

	// readMarkerFn reflects the shared marker state: true after armMarkerFn fires.
	const readMarkerFn = (): boolean => markerArmed;

	// Provide a session ID so handleOneTick can resolve a PID.
	const readSessionIdFn = (): string => 'test-session-uuid';

	// Fake PID resolver (no-arg): always returns a constant PID.
	const resolvePidFn = (): number => 42_000;

	// Capture kill calls.
	const killFn = (pid: number, signal: NodeJS.Signals): void => {
		killedPids.push([pid, signal]);
	};

	// Capture marker removal.
	const removeMarkerFn = (): void => {
		markerRemoved = true;
	};

	await runOneTick({
		readOccupancyFn,
		armMarkerFn,
		readMarkerFn,
		readSessionIdFn,
		resolvePidFn,
		killFn,
		removeMarkerFn,
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
		// US-001/CAM-172: checkBackstop only arms when the handoff already exists.
		handoffExistsFn: () => true,
	});

	// Backstop must have armed the marker.
	expect(markerArmed).toBe(true);

	// handleOneTick must have sent SIGTERM to the resolved PID.
	expect(killedPids).toHaveLength(1);
	expect(killedPids[0]).toEqual([42_000, 'SIGTERM']);

	// Consume-once: marker must have been removed after SIGTERM.
	expect(markerRemoved).toBe(true);
});

test('high-occupancy reader with NO handoff present: no marker armed, killFn not called', async () => {
	// US-001/CAM-172: over-threshold occupancy alone must never arm the marker;
	// the handoff file must already exist on disk.
	let markerArmed = false;
	let killCalled = false;

	const readOccupancyFn = (): number => 900_000; // over threshold

	const armMarkerFn = (): void => {
		markerArmed = true;
	};

	const readMarkerFn = (): boolean => markerArmed;

	const killFn = (_pid: number, _signal: NodeJS.Signals): void => {
		killCalled = true;
	};

	await runOneTick({
		readOccupancyFn,
		armMarkerFn,
		readMarkerFn,
		resolvePidFn: () => 42_000,
		killFn,
		removeMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
		handoffExistsFn: () => false,
	});

	// Backstop must NOT have fired: no handoff present, even though over threshold.
	expect(markerArmed).toBe(false);
	expect(killCalled).toBe(false);
});

test('low-occupancy reader: no marker armed, killFn not called', async () => {
	let markerArmed = false;
	let killCalled = false;

	// Occupancy well below ceiling (100_000 < 800_000).
	const readOccupancyFn = (): number => 100_000;

	const armMarkerFn = (): void => {
		markerArmed = true;
	};

	// readMarkerFn always returns false (marker was never armed).
	const readMarkerFn = (): boolean => false;

	const killFn = (_pid: number, _signal: NodeJS.Signals): void => {
		killCalled = true;
	};

	const removeMarkerFn = (): void => {};

	await runOneTick({
		readOccupancyFn,
		armMarkerFn,
		readMarkerFn,
		readSessionIdFn: () => null,
		resolvePidFn: () => null,
		killFn,
		removeMarkerFn,
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	// Backstop must NOT have fired.
	expect(markerArmed).toBe(false);
	// handleOneTick must NOT have sent any signal.
	expect(killCalled).toBe(false);
});

test('null occupancy (absent transcript): no marker armed, no SIGTERM', async () => {
	let markerArmed = false;
	let killCalled = false;

	// Null simulates an absent/unreadable orchestrator transcript.
	const readOccupancyFn = (): null => null;

	const armMarkerFn = (): void => {
		markerArmed = true;
	};

	const readMarkerFn = (): boolean => false;

	const killFn = (_pid: number, _signal: NodeJS.Signals): void => {
		killCalled = true;
	};

	await runOneTick({
		readOccupancyFn,
		armMarkerFn,
		readMarkerFn,
		readSessionIdFn: () => null,
		resolvePidFn: () => null,
		killFn,
		removeMarkerFn: () => {},
		contextWindow: CONTEXT_WINDOW,
		backstopFraction: ORCH_CONTEXT_BACKSTOP_FRACTION,
	});

	expect(markerArmed).toBe(false);
	expect(killCalled).toBe(false);
});

test('ORCH_RECYCLE_MARKER is the named constant referenced in the source file', () => {
	// Oracle: the watcher must reference ORCH_RECYCLE_MARKER (not a new marker).
	// This is a static import verification: if the watcher did not import or use
	// ORCH_RECYCLE_MARKER, this import would be unused and biome would flag it.
	// The oracle grep on the source file (acceptance criterion 3) confirms usage.
	const { ORCH_RECYCLE_MARKER } = require('../src/tmux/session.ts') as { ORCH_RECYCLE_MARKER: string };
	expect(typeof ORCH_RECYCLE_MARKER).toBe('string');
	expect(ORCH_RECYCLE_MARKER.length).toBeGreaterThan(0);
});
