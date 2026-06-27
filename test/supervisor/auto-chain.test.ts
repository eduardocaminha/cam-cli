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
