// test/sidecar-gate-phase.test.ts
//
// Tests for wiring the operator-decision gate lifecycle into the sidecar
// loop (US-003, CAM-241/153).
//
// Coverage:
//   AC1/AC2: loop.ts source-text oracle -- the awaiting-operator branch
//        guards on loopPhase === 'awaiting-operator' and precedes the
//        active!==true idle check (belt-and-suspenders on top of the PRD's
//        own grep oracle), and is a sibling of the planning/shipping branches.
//   AC2: runSidecarLoop invokes the injected runGatePhaseFn on an
//        awaiting-operator tick, guarded by an outer try/catch that logs a
//        sidecar-exit event and survives a throwing dep.
//   AC2: sidecar.ts source-text oracle -- makeProductionGatePhaseFn wires
//        pollAndResolveGate with a discriminator-keyed registry, never
//        hard-coded to a single gate kind.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../src/supervisor/loop.ts';
import { makeInMemoryEventLogger, type WorkerEvent } from '../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Escape sentinel (same ESCAPE pattern as sidecar-ship-phase.test.ts)
// ---------------------------------------------------------------------------

const ESCAPE = Symbol('escape');

/** Build a minimal RunSupervisorOptions that never does any real I/O. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-07-16T00:00:00Z',
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

const COMPLETE_RESULT: SupervisorResult = {
	status: 'complete',
	iterations: 1,
	lastOutcome: null,
};

// ---------------------------------------------------------------------------
// AC1/AC2: loop.ts source-text oracle for the awaiting-operator branch
// ---------------------------------------------------------------------------

describe('AC1/AC2: loop.ts source-text oracle -- awaiting-operator branch', () => {
	const loopSrc = readFileSync(resolve(import.meta.dir, '../src/supervisor/loop.ts'), 'utf8');

	const gateIdx = loopSrc.indexOf("loopPhase === 'awaiting-operator'");
	const shippingIdx = loopSrc.indexOf("loopPhase === 'shipping'");
	const planningIdx = loopSrc.indexOf("loopPhase === 'planning'");
	const activeIdx = loopSrc.indexOf('if (active !== true)');

	test('loop.ts contains the awaiting-operator branch guard', () => {
		expect(gateIdx).toBeGreaterThan(-1);
	});

	test('the awaiting-operator branch precedes the active!==true idle check', () => {
		expect(gateIdx).toBeLessThan(activeIdx);
	});

	test('the awaiting-operator branch follows the planning and shipping branches (sibling ordering)', () => {
		expect(planningIdx).toBeGreaterThan(-1);
		expect(shippingIdx).toBeGreaterThan(-1);
		expect(gateIdx).toBeGreaterThan(planningIdx);
		expect(gateIdx).toBeGreaterThan(shippingIdx);
	});

	const gateBlock = gateIdx >= 0 ? loopSrc.slice(gateIdx, gateIdx + 800) : '';

	test('awaiting-operator branch awaits opts.runGatePhaseFn() inside a try block', () => {
		expect(gateBlock).toContain('try {');
		expect(gateBlock).toContain('await opts.runGatePhaseFn()');
	});

	test("awaiting-operator branch catch block logs reason: 'gate-phase-crash-outer'", () => {
		expect(gateBlock).toContain("'gate-phase-crash-outer'");
	});
});

// ---------------------------------------------------------------------------
// AC2: runSidecarLoop dispatches runGatePhaseFn on an awaiting-operator tick
// and survives a throwing dep.
// ---------------------------------------------------------------------------

describe('AC2: runSidecarLoop -- awaiting-operator tick dispatch + crash survival', () => {
	test('invokes the injected runGatePhaseFn on an awaiting-operator tick', async () => {
		let gatePhaseCalls = 0;
		let sleepCalls = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			runGatePhaseFn: async (): Promise<void> => {
				gatePhaseCalls++;
			},
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(gatePhaseCalls).toBeGreaterThanOrEqual(1);
	});

	test('a throwing runGatePhaseFn does not kill the loop; logs sidecar-exit', async () => {
		const { logger: logEvent, events } = makeInMemoryEventLogger();
		let gatePhaseCalls = 0;
		let sleepCalls = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			runGatePhaseFn: async (): Promise<void> => {
				gatePhaseCalls++;
				throw new Error('injected gate-phase crash');
			},
			logEvent,
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(gatePhaseCalls).toBeGreaterThanOrEqual(1);

		const crashEvents = events.filter((e: WorkerEvent) => e.kind === 'sidecar-exit');
		expect(crashEvents.length).toBeGreaterThanOrEqual(1);
		const detail = crashEvents[0]?.detail as { reason?: string };
		expect(detail.reason).toBe('gate-phase-crash-outer');
	});

	test('when runGatePhaseFn is absent, an awaiting-operator phase falls through without dispatch (zero behavior change)', async () => {
		let sleepCalls = 0;
		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			// runGatePhaseFn intentionally omitted.
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(sleepCalls).toBeGreaterThanOrEqual(2);
	});

	test('runGatePhaseFn is mutually exclusive with the idle path (active!==true) machinery', async () => {
		let gatePhaseCalls = 0;
		let idlePathCalls = 0;
		let sleepCalls = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			runGatePhaseFn: async (): Promise<void> => {
				gatePhaseCalls++;
			},
			runMergeWatchFn: async () => { idlePathCalls++; },
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(gatePhaseCalls).toBeGreaterThanOrEqual(1);
		expect(idlePathCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC2: sidecar.ts source-text oracle -- generic dispatch, never hard-coded
// ---------------------------------------------------------------------------

describe('AC2: sidecar.ts source-text oracle -- generic gate-kind dispatch', () => {
	const src = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	test('sidecar.ts wires pollAndResolveGate', () => {
		expect(src).toContain('pollAndResolveGate');
	});

	test('the production gate-phase registry is not hard-coded to a single gate kind', () => {
		const idx = src.indexOf('function makeProductionGatePhaseFn');
		expect(idx).toBeGreaterThan(-1);
		const block = src.slice(idx, idx + 800);
		expect(block).toContain('GateResolutionRegistry');
		expect(block).toContain('pollAndResolveGate(filePath, registry, setPhase)');
	});
});
