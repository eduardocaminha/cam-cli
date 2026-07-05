// test/supervisor/auto-chain.test.ts
//
// Unit tests for US-005: auto-chain (flipActiveFn + autoShipFn) wiring.
//
// Coverage:
//   1. Auto mode: CLEAN review verdict calls autoShipFn exactly once.
//   2. Auto mode: non-CLEAN verdict (FIXES_PENDING) does NOT call autoShipFn.
//   3. Auto mode: after supervisor completes with pending stories, flipActiveFn called.
//   4. Auto mode: after supervisor completes with NO pending stories, flipActiveFn
//      is NOT called (loop goes idle normally).
//   5. Operator mode: no autoShipFn injected -> review branch unchanged.
//   6. Operator mode: no flipActiveFn injected -> loop goes idle after supervisor.
//   7. File-assert: sidecar.ts contains readPlanApproval (AC3 oracle).
//
// All tests use injected fakes; no real tmux or filesystem access.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	runSupervisor,
	runSidecarLoop,
	type RunSupervisorOptions,
	type RunSidecarLoopOptions,
	type SupervisorResult,
	type SpawnFn,
	type CapturePane,
	type ReadPrd,
	type WritePrd,
	type ReadHandoff,
	type ClockFn,
	type ReviewDispatch,
	type WriteSessionMarker,
	type IsPaneAlive,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrd(opts: {
	allPass: boolean;
	verdict?: string | null;
}): PrdSnapshot {
	const story = { id: 'US-001', priority: 1, passes: opts.allPass ? true : false, requires: null };
	return {
		userStories: [story],
		review: opts.verdict !== undefined ? { roundsCompleted: 1, lastVerdict: opts.verdict } : undefined,
	};
}

const COMPLETE_RESULT: SupervisorResult = {
	status: 'complete',
	iterations: 1,
	lastOutcome: null,
};

/**
 * Build a minimal RunSupervisorOptions for the review path.
 * PRD sequence: [all-pass-no-review (top), all-pass-CLEAN (after reviewDispatch), all-pass-CLEAN (next top)]
 */
function makeReviewBaseOpts(
	overrides: Partial<RunSupervisorOptions> = {},
): RunSupervisorOptions {
	const prds: PrdSnapshot[] = [
		makePrd({ allPass: true, verdict: null }),  // iter 1 top -> review
		makePrd({ allPass: true, verdict: 'CLEAN' }), // after reviewDispatch
		makePrd({ allPass: true, verdict: 'CLEAN' }), // iter 2 top -> complete
	];
	let prdIdx = 0;

	const base: RunSupervisorOptions = {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => prds[prdIdx++] ?? null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-27T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok', detail: 'review ok' }),
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
	return { ...base, ...overrides };
}

/**
 * Build a minimal RunSupervisorOptions for a FIXES_PENDING review verdict.
 */
function makeFixesPendingReviewOpts(
	overrides: Partial<RunSupervisorOptions> = {},
): RunSupervisorOptions {
	const prds: PrdSnapshot[] = [
		makePrd({ allPass: true, verdict: null }),          // top -> review
		makePrd({ allPass: true, verdict: 'FIXES_PENDING:1' }), // after reviewDispatch
	];
	let prdIdx = 0;

	const base: RunSupervisorOptions = {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => prds[prdIdx++] ?? null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-27T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok', detail: 'review ok' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions',
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
		maxIterations: 2, // cap at 2 to avoid runaway on FIXES_PENDING
	};
	return { ...base, ...overrides };
}

/** Minimal dummy supervisor options for sidecar-loop tests. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-27T00:00:00Z',
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
// Test 1: Auto mode - CLEAN verdict calls autoShipFn
// ---------------------------------------------------------------------------

describe('auto-chain: autoShipFn (runSupervisor)', () => {
	test('auto mode: CLEAN verdict calls autoShipFn exactly once', async () => {
		let autoShipCalls = 0;

		const opts = makeReviewBaseOpts({
			autoShipFn: () => { autoShipCalls++; },
		});

		const result = await runSupervisor(opts);

		// The loop should reach 'complete' after the review CLEAN
		expect(result.status).toBe('complete');
		// autoShipFn must have been called exactly once (on the CLEAN verdict)
		expect(autoShipCalls).toBe(1);
	});

	test('auto mode: FIXES_PENDING verdict does NOT call autoShipFn', async () => {
		let autoShipCalls = 0;

		const opts = makeFixesPendingReviewOpts({
			autoShipFn: () => { autoShipCalls++; },
		});

		// With FIXES_PENDING the loop will try to implement again; cap at 2 iters
		await runSupervisor(opts);

		// autoShipFn must NOT have been called for FIXES_PENDING
		expect(autoShipCalls).toBe(0);
	});

	test('operator mode: autoShipFn not injected -> CLEAN does not call it', async () => {
		// Simply confirm the loop runs normally without autoShipFn (should not throw)
		const opts = makeReviewBaseOpts();
		// No autoShipFn injected -> operator mode behavior

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
		// No assertion needed for a non-existent fn; this test confirms no crash.
	});
});

// ---------------------------------------------------------------------------
// Test 2: Auto mode - flipActiveFn after supervisor with pending work
// ---------------------------------------------------------------------------

describe('auto-chain: flipActiveFn (runSidecarLoop)', () => {
	const ESCAPE = Symbol('escape');

	test('auto mode: flipActiveFn called after supervisor completes with pending stories', async () => {
		let flipCalls = 0;
		let supervisorCalls = 0;

		// Sequence: [true, false] - one active cycle, then idle
		const readActiveSeq: Array<boolean> = [true, false];
		let readIdx = 0;

		// hasPendingStories: always true (keeps pending work present)
		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => { throw ESCAPE; }, // escape on first idle sleep
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => {
				supervisorCalls++;
				return COMPLETE_RESULT;
			},
			flipActiveFn: () => { flipCalls++; },
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// Supervisor ran once (the active:true cycle)
		expect(supervisorCalls).toBe(1);
		// flipActiveFn called once (pending work found after supervisor)
		expect(flipCalls).toBe(1);
	});

	test('auto mode: flipActiveFn NOT called when no pending stories remain', async () => {
		let flipCalls = 0;
		let supervisorCalls = 0;

		const readActiveSeq: Array<boolean> = [true, false];
		let readIdx = 0;
		// First hasPendingStories call (before supervisor): true
		// Second call (after clearActive, for auto-chain check): false
		let pendingCallCount = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => { throw ESCAPE; }, // escape on first idle sleep
			hasPendingStories: () => {
				pendingCallCount++;
				// First call (before supervisor dispatch): pending
				// Second call (auto-chain check after supervisor): done
				return pendingCallCount <= 1;
			},
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => {
				supervisorCalls++;
				return COMPLETE_RESULT;
			},
			flipActiveFn: () => { flipCalls++; },
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(supervisorCalls).toBe(1);
		// No pending stories after supervisor -> flipActiveFn NOT called
		expect(flipCalls).toBe(0);
	});

	test('operator mode: no flipActiveFn -> loop goes idle after supervisor', async () => {
		let supervisorCalls = 0;
		let sleepCalls = 0;

		const readActiveSeq: Array<boolean> = [true, false];
		let readIdx = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				throw ESCAPE;
			},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => {
				supervisorCalls++;
				return COMPLETE_RESULT;
			},
			// No flipActiveFn: operator mode
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(supervisorCalls).toBe(1);
		// sleep was called (no auto-chain: loop settled into idle)
		expect(sleepCalls).toBe(1);
	});

	test('auto mode: autoShipFn threaded from RunSidecarLoopOptions into supervisor', async () => {
		// Verify that autoShipFn injected on RunSidecarLoopOptions reaches the
		// runSupervisor call inside runSidecarLoop.
		let autoShipCalls = 0;

		// PRD sequence for the supervisor: all-pass no-review, then CLEAN, then complete
		const prds: PrdSnapshot[] = [
			makePrd({ allPass: true, verdict: null }),
			makePrd({ allPass: true, verdict: 'CLEAN' }),
			makePrd({ allPass: true, verdict: 'CLEAN' }),
		];
		let prdIdx = 0;

		// hasPendingStories: true once (for first cycle), then false
		let pendingCount = 0;

		const readActiveSeq: Array<boolean> = [true, false];
		let readIdx = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => ({
				spawn: () => ({ stdout: '', exitCode: 0 }),
				capturePane: () => '',
				readPrd: () => prds[prdIdx++] ?? null,
				writePrd: () => {},
				readHandoff: () => null,
				clock: () => '2026-06-27T00:00:00Z',
				reviewDispatch: () => ({ status: 'ok', detail: 'ok' }),
				writeSessionMarker: () => {},
				isPaneAlive: () => true,
				workerPaneId: '%2',
				prdPath: '/fake/prd.json',
				handoffPath: '/fake/handoff.json',
				permissionMode: 'bypassPermissions',
				taskPrompt: 'test',
				sleepFn: () => {},
				nowMs: () => 0,
			}),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => { throw ESCAPE; },
			hasPendingStories: () => {
				pendingCount++;
				return pendingCount <= 1; // true first time only
			},
			acquireLock: () => ({ acquired: true, release: () => {} }),
			// No runSupervisorFn override -> uses real runSupervisor
			autoShipFn: () => { autoShipCalls++; },
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// autoShipFn should have fired (threaded from loop opts into supervisor)
		expect(autoShipCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Test 3 (file-assert): sidecar.ts contains readPlanApproval (AC3 oracle)
// ---------------------------------------------------------------------------

describe('auto-chain: file-assert oracles (AC3)', () => {
	test('sidecar.ts imports and calls readPlanApproval', () => {
		const sidecarSrc = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(sidecarSrc).toContain('readPlanApproval');
	});
});

// ---------------------------------------------------------------------------
// CAM-181 / US-001: Re-anchored auto-ship tests
// ---------------------------------------------------------------------------

describe('auto-chain: CAM-181 auto-ship re-anchored to complete+CLEAN', () => {
	// BUG A: a pending requires:'operator' story with a CLEAN verdict must
	// route to await-operator, NOT complete. autoShipFn must not fire.
	test('BUG A: operator story pending + CLEAN verdict → await-operator, autoShipFn not called', async () => {
		let autoShipCalls = 0;

		// All non-operator stories pass, verdict CLEAN (terminal), operator story pending.
		const prd: PrdSnapshot = {
			userStories: [
				{ id: 'US-001', priority: 1, passes: true, requires: null },
				{ id: 'US-002', priority: 2, passes: false, requires: 'operator' },
			],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		};

		const opts = makeReviewBaseOpts({
			readPrd: () => prd,
			autoShipFn: () => { autoShipCalls++; },
		});

		const result = await runSupervisor(opts);

		// Must route to await-operator (not complete): 'complete' is unreachable
		// while a requires:'operator' story is pending (decide.ts invariant).
		expect(result.status).toBe('awaiting-operator');
		// autoShipFn must NOT be called
		expect(autoShipCalls).toBe(0);
	});

	// BUG B: re-entry with review.lastVerdict==='CLEAN' already persisted and
	// all stories passing must dispatch auto-ship exactly once.
	test('BUG B: re-entry with CLEAN already persisted dispatches auto-ship exactly once', async () => {
		let autoShipCalls = 0;
		let writePrdCalls = 0;

		// PRD already in the terminal CLEAN state (simulating a re-entry after
		// the review agent ran in a prior invocation).
		const prd: PrdSnapshot = makePrd({ allPass: true, verdict: 'CLEAN' });

		const opts = makeReviewBaseOpts({
			readPrd: () => prd,
			writePrd: () => { writePrdCalls++; },
			autoShipFn: () => { autoShipCalls++; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// autoShipFn dispatched exactly once on re-entry
		expect(autoShipCalls).toBe(1);
		// marker was written before dispatch
		expect(writePrdCalls).toBe(1);
	});

	// Cross-invocation dedup: Two runSupervisor invocations over the same
	// complete+CLEAN prd must call autoShipFn only once in total. The
	// review.autoShipDispatchedAt marker guards the re-dispatch.
	test('cross-invocation: autoShipFn called once in total across two runSupervisor calls (marker guards re-dispatch)', async () => {
		let autoShipCalls = 0;

		// Shared mutable PRD: writePrd updates it; readPrd reads it.
		let sharedPrd: PrdSnapshot = makePrd({ allPass: true, verdict: 'CLEAN' });

		const makeInvocationOpts = (): RunSupervisorOptions =>
			makeReviewBaseOpts({
				readPrd: () => sharedPrd,
				writePrd: (p) => { sharedPrd = p; },
				autoShipFn: () => { autoShipCalls++; },
			});

		// First invocation: marker absent → writes marker + calls autoShipFn
		const r1 = await runSupervisor(makeInvocationOpts());
		expect(r1.status).toBe('complete');
		expect(autoShipCalls).toBe(1);

		// The marker must now be persisted in the shared prd
		expect(sharedPrd.review?.autoShipDispatchedAt).toBeDefined();

		// Second invocation: marker present → autoShipFn NOT called again
		const r2 = await runSupervisor(makeInvocationOpts());
		expect(r2.status).toBe('complete');
		expect(autoShipCalls).toBe(1); // still 1 — no second dispatch
	});

	// Terminal 'complete' reached via MAX_ROUNDS_DEBT must NOT dispatch auto-ship.
	test('complete via MAX_ROUNDS_DEBT does NOT dispatch auto-ship', async () => {
		let autoShipCalls = 0;

		// All stories pass; verdict is the non-convergence terminal.
		const prd: PrdSnapshot = {
			userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'MAX_ROUNDS_DEBT' },
		};

		const opts = makeReviewBaseOpts({
			readPrd: () => prd,
			autoShipFn: () => { autoShipCalls++; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// Debt terminal: auto-ship must NOT fire (only CLEAN triggers dispatch)
		expect(autoShipCalls).toBe(0);
	});

	// File-assert oracles (AC6): autoShipDispatchedAt appears in both source files.
	test('autoShipDispatchedAt marker exists in decide.ts and loop.ts', () => {
		const decideSrc = readFileSync(
			join(import.meta.dir, '../../src/supervisor/decide.ts'),
			'utf8',
		);
		const loopSrc = readFileSync(
			join(import.meta.dir, '../../src/supervisor/loop.ts'),
			'utf8',
		);
		expect(decideSrc).toContain('autoShipDispatchedAt');
		expect(loopSrc).toContain('autoShipDispatchedAt');
	});

	// File-assert oracle (AC7): prd.json is in ship-finalize harnessPaths.
	test('prd.json is in ship-finalize harnessPaths', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/ship-finalize.ts'),
			'utf8',
		);
		expect(src).toContain('scripts/cam/prd.json');
	});
});
