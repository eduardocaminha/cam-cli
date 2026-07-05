// test/sidecar-ship-phase.test.ts
//
// Tests for wiring the deterministic ship phase into the sidecar loop
// (US-004, CAM-149).
//
// Coverage:
//   AC1: loop.ts source-text oracle -- the shipping branch guards on
//        loopPhase === 'shipping' and precedes the active!==true idle check
//        (belt-and-suspenders on top of the PRD's own grep oracle).
//   AC2: runSidecarLoop invokes the injected runShipPhaseFn on a shipping
//        tick, guarded by an outer try/catch that logs a sidecar-exit event
//        and survives a throwing dep.
//   AC2: sidecar.ts source-text oracle -- makeProductionShipPhaseFn wires
//        runShipPhase with the shared production adapters and ALWAYS resets
//        phase to idle in a finally block.
//   AC3: handleShipPhaseResult (exported from sidecar.ts) narrates every
//        failure kind + the shipped kind via notify, and fires escalateFn
//        best-effort on failure only.
//   AC4: handleShipPhaseResult logs a structured 'ship-phase-result' event
//        carrying the full ShipPhaseResult for every outcome.
//   AC5: sidecar.ts contains no '/cam-ship' send-keys dispatch; the
//        production autoShipFn is a setPhase('shipping') closure.

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
import { handleShipPhaseResult } from '../src/commands/sidecar.ts';
import type { ShipPhaseResult } from '../src/supervisor/ship-runner.ts';

// ---------------------------------------------------------------------------
// Escape sentinel (same ESCAPE pattern as plan-phase-crash-safety.test.ts)
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
		clock: () => '2026-07-05T00:00:00Z',
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
// AC1: loop.ts source-text oracle for the shipping branch
// ---------------------------------------------------------------------------

describe('AC1: loop.ts source-text oracle -- shipping branch', () => {
	const loopSrc = readFileSync(resolve(import.meta.dir, '../src/supervisor/loop.ts'), 'utf8');

	const shippingIdx = loopSrc.indexOf("loopPhase === 'shipping'");
	const planningIdx = loopSrc.indexOf("loopPhase === 'planning'");
	const activeIdx = loopSrc.indexOf('if (active !== true)');

	test("loop.ts contains the shipping branch guard", () => {
		expect(shippingIdx).toBeGreaterThan(-1);
	});

	test('the shipping branch precedes the active!==true idle check', () => {
		expect(shippingIdx).toBeLessThan(activeIdx);
	});

	test('the shipping branch follows the planning branch (sibling ordering)', () => {
		expect(planningIdx).toBeGreaterThan(-1);
		expect(shippingIdx).toBeGreaterThan(planningIdx);
	});

	const shippingBlock = shippingIdx >= 0 ? loopSrc.slice(shippingIdx, shippingIdx + 800) : '';

	test('shipping branch awaits opts.runShipPhaseFn() inside a try block', () => {
		expect(shippingBlock).toContain('try {');
		expect(shippingBlock).toContain('await opts.runShipPhaseFn()');
	});

	test("shipping branch catch block logs reason: 'ship-phase-crash-outer'", () => {
		expect(shippingBlock).toContain("'ship-phase-crash-outer'");
	});

	test('shipping branch catch block does not itself write phase (closure owns phase->idle)', () => {
		expect(shippingBlock).not.toContain('setPhase');
		expect(shippingBlock).not.toContain('setPhaseFn');
	});
});

// ---------------------------------------------------------------------------
// AC2: runSidecarLoop dispatches runShipPhaseFn on a shipping tick and
// survives a throwing dep.
// ---------------------------------------------------------------------------

describe('AC2: runSidecarLoop -- shipping tick dispatch + crash survival', () => {
	test('invokes the injected runShipPhaseFn on a shipping tick', async () => {
		let shipPhaseCalls = 0;
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
			readLoopPhaseFn: () => 'shipping',
			runShipPhaseFn: async (): Promise<void> => {
				shipPhaseCalls++;
			},
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(shipPhaseCalls).toBeGreaterThanOrEqual(1);
	});

	test('a throwing runShipPhaseFn does not kill the loop; logs sidecar-exit', async () => {
		const { logger: logEvent, events } = makeInMemoryEventLogger();
		let shipPhaseCalls = 0;
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
			readLoopPhaseFn: () => 'shipping',
			runShipPhaseFn: async (): Promise<void> => {
				shipPhaseCalls++;
				throw new Error('injected ship-phase crash');
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
		expect(shipPhaseCalls).toBeGreaterThanOrEqual(1);

		const crashEvents = events.filter((e: WorkerEvent) => e.kind === 'sidecar-exit');
		expect(crashEvents.length).toBeGreaterThanOrEqual(1);
		const detail = crashEvents[0]?.detail as { reason?: string };
		expect(detail.reason).toBe('ship-phase-crash-outer');
	});

	test('when runShipPhaseFn is absent, a shipping phase falls through without dispatch', async () => {
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
			readLoopPhaseFn: () => 'shipping',
			// runShipPhaseFn intentionally omitted.
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		// Falls through to the idle branch (active derives false); must not throw
		// anything other than the escape sentinel.
		expect(caughtErr).toBe(ESCAPE);
	});
});

// ---------------------------------------------------------------------------
// AC2: sidecar.ts source-text oracle -- makeProductionShipPhaseFn wiring
// ---------------------------------------------------------------------------

describe('AC2: sidecar.ts source-text oracle -- makeProductionShipPhaseFn', () => {
	const sidecarSrc = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	const fnStart = sidecarSrc.indexOf('function makeProductionShipPhaseFn(');
	const fnEnd = sidecarSrc.indexOf('\nfunction ', fnStart + 1);
	const fnBody = fnStart >= 0 ? sidecarSrc.slice(fnStart, fnEnd > 0 ? fnEnd : undefined) : '';

	test('makeProductionShipPhaseFn exists', () => {
		expect(fnStart).toBeGreaterThan(-1);
	});

	test('wraps its body in try / finally', () => {
		expect(fnBody).toContain('try {');
		expect(fnBody).toContain('finally {');
	});

	test('ALWAYS resets phase to idle in the finally block', () => {
		const finallyIdx = fnBody.indexOf('finally {');
		const finallyBlock = fnBody.slice(finallyIdx);
		expect(finallyBlock).toContain("setPhase('idle')");
	});

	test('catch block logs a sidecar-exit event with reason ship-phase-crash', () => {
		expect(fnBody).toContain("'sidecar-exit'");
		expect(fnBody).toContain("'ship-phase-crash'");
	});

	test('calls runShipPhase with the shared production adapters', () => {
		expect(fnBody).toContain('runShipPhase(');
		expect(fnBody).toContain('buildShipBumpOpts');
		expect(fnBody).toContain('buildShipFinalizeOpts');
		expect(fnBody).toContain('runShipPrStep(');
	});

	test('does not contain any file-size/coverage ratchet writes (never auto-fixes)', () => {
		expect(fnBody).not.toContain('file-size-budget');
		expect(fnBody).not.toContain('coverage-budget');
	});
});

// ---------------------------------------------------------------------------
// AC3 + AC4: handleShipPhaseResult -- narration, escalation, structured event
// ---------------------------------------------------------------------------

describe('AC3/AC4: handleShipPhaseResult', () => {
	function makeDeps() {
		const notified: string[] = [];
		const events: WorkerEvent[] = [];
		let escalateCalls = 0;
		return {
			notify: (line: string) => notified.push(line),
			escalateFn: async (): Promise<void> => {
				escalateCalls++;
			},
			logEvent: (e: WorkerEvent) => events.push(e),
			notified,
			events,
			getEscalateCalls: () => escalateCalls,
		};
	}

	test('shipped: notifies success, logs the event, never escalates', () => {
		const deps = makeDeps();
		const result: ShipPhaseResult = { kind: 'shipped', prNumber: 42, mergeMode: 'immediate' };

		handleShipPhaseResult(result, deps);

		expect(deps.notified.length).toBe(1);
		expect(deps.notified[0]).toContain('42');
		expect(deps.notified[0]).toContain('immediate');
		expect(deps.getEscalateCalls()).toBe(0);
		expect(deps.events.length).toBe(1);
		expect(deps.events[0]?.kind).toBe('ship-phase-result');
		expect((deps.events[0]?.detail as { kind?: string }).kind).toBe('shipped');
	});

	const failureCases: ShipPhaseResult[] = [
		{ kind: 'on-main' },
		{ kind: 'prd-incomplete', blockingStoryIds: ['US-004'] },
		{ kind: 'no-commits-ahead' },
		{ kind: 'gates-failed', outputTail: 'FAIL some-test\nmore output' },
		{ kind: 'bump-failed', detail: 'bump threw' },
		{ kind: 'finalize-failed', detail: 'finalize threw' },
		{ kind: 'push-failed', detail: 'push exited 1' },
		{ kind: 'pr-create-failed', detail: 'gh pr create failed' },
	];

	for (const result of failureCases) {
		test(`${result.kind}: notifies failure, logs the event, escalates once`, () => {
			const deps = makeDeps();

			handleShipPhaseResult(result, deps);

			expect(deps.notified.length).toBe(1);
			expect(deps.notified[0]).toContain(result.kind);
			expect(deps.getEscalateCalls()).toBe(1);
			expect(deps.events.length).toBe(1);
			expect(deps.events[0]?.kind).toBe('ship-phase-result');
			expect((deps.events[0]?.detail as { kind?: string }).kind).toBe(result.kind);
		});
	}

	test('a failure with escalateFn undefined does not throw and does not escalate', () => {
		const notified: string[] = [];
		const events: WorkerEvent[] = [];
		expect(() =>
			handleShipPhaseResult(
				{ kind: 'on-main' },
				{ notify: (l) => notified.push(l), escalateFn: undefined, logEvent: (e) => events.push(e) },
			),
		).not.toThrow();
		expect(notified.length).toBe(1);
		expect(events.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC5: no '/cam-ship' send-keys dispatch remains; autoShipFn is a phase-signal
// writer.
// ---------------------------------------------------------------------------

describe("AC5: sidecar.ts contains no '/cam-ship' send-keys dispatch", () => {
	const sidecarSrc = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	test("no literal '/cam-ship' string remains in sidecar.ts", () => {
		expect(sidecarSrc).not.toContain("'/cam-ship'");
	});

	test("makeAutoShipFn body calls setPhase('shipping')", () => {
		const fnStart = sidecarSrc.indexOf('function makeAutoShipFn(');
		const fnEnd = sidecarSrc.indexOf('\n}', fnStart);
		const fnBody = sidecarSrc.slice(fnStart, fnEnd);
		expect(fnBody).toContain("setPhase('shipping')");
		expect(fnBody).not.toContain('send-keys');
		expect(fnBody).not.toContain('tmux');
	});
});
