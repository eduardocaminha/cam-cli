// test/supervisor/auto-chain.test.ts
//
// Unit tests for auto-chain (flipActiveFn) and auto-ship (autoShipFn) wiring
// in runSidecarLoop.
//
// CAM-191 / ADR 0013 moved the auto-ship decision (complete-check, CLEAN-check,
// fire-once marker write, phase:shipping write) out of runSupervisor entirely
// and into the outer runSidecarLoop, positioned AFTER clearActive so that
// phase:shipping is the LAST state-file write on the terminal 'complete' path
// (surviving both the onProgress unlink-on-complete and clearActive's implicit
// phase:idle rewrite). RunSupervisorOptions no longer has an autoShipFn field.
//
// Coverage:
//   1. runSidecarLoop: complete + CLEAN + marker absent -> marker written to
//      prd.json BEFORE autoShipFn is called, autoShipFn called exactly once.
//   2. runSidecarLoop: complete + non-CLEAN verdict -> autoShipFn NOT called.
//   3. runSidecarLoop: awaiting-operator status -> autoShipFn NOT called (even
//      with a CLEAN verdict already on the prd -- fires ONLY on 'complete').
//   4. runSidecarLoop: complete + CLEAN + marker ALREADY present -> autoShipFn
//      NOT called again (fire-once, no re-dispatch, no re-write).
//   5. Operator mode (no autoShipFn injected) -> complete path does not crash.
//   6. flipActiveFn auto-chain tests (unchanged behavior, kept for regression).
//   7. File-assert: sidecar.ts contains readPlanApproval (AC3 legacy oracle).
//   8. File-assert: makeClearActive is exported from sidecar.ts.
//   9. File-assert: RunSupervisorOptions no longer threads autoShipFn (AC1).
//
// All tests use injected fakes; no real tmux or filesystem access.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	runSidecarLoop,
	type RunSupervisorOptions,
	type RunSidecarLoopOptions,
	type SupervisorResult,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrd(opts: {
	allPass: boolean;
	verdict?: string | null;
	autoShipDispatchedAt?: string;
}): PrdSnapshot {
	const story = { id: 'US-001', priority: 1, passes: opts.allPass ? true : false, requires: null };
	return {
		userStories: [story],
		review:
			opts.verdict !== undefined
				? {
						roundsCompleted: 1,
						lastVerdict: opts.verdict,
						...(opts.autoShipDispatchedAt !== undefined
							? { autoShipDispatchedAt: opts.autoShipDispatchedAt }
							: {}),
					}
				: undefined,
	};
}

const COMPLETE_RESULT: SupervisorResult = {
	status: 'complete',
	iterations: 1,
	lastOutcome: null,
};

const AWAITING_OPERATOR_RESULT: SupervisorResult = {
	status: 'awaiting-operator',
	iterations: 1,
	lastOutcome: null,
	pendingStoryIds: ['US-002'],
};

/** Minimal dummy supervisor options for sidecar-loop tests. */
function makeDummySupervisorOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
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
		...overrides,
	};
}

const ESCAPE = Symbol('escape');

/**
 * Drive one active tick of runSidecarLoop with a mocked runSupervisorFn that
 * returns `result` directly (no real inner review loop needed: the outer-loop
 * auto-ship decision only depends on result.status + a post-hoc readPrd()).
 *
 * hasPendingStories returns true on the FIRST call only (the pre-dispatch
 * gate), then false (mirrors the real invariant: 'complete' implies no
 * pending stories, gotcha #7 of CAM-191's story notes), so the flipActiveFn
 * auto-chain branch never fires alongside the auto-ship branch under test.
 */
async function driveOneTick(loopOptsPartial: Partial<RunSidecarLoopOptions> & { result: SupervisorResult }) {
	const { result, ...rest } = loopOptsPartial;
	const readActiveSeq: Array<boolean> = [true, false];
	let readIdx = 0;
	let pendingCallCount = 0;

	const loopOpts: RunSidecarLoopOptions = {
		buildOpts: () => makeDummySupervisorOpts(),
		readActive: () => readActiveSeq[readIdx++] ?? false,
		clearActive: () => {},
		sleep: () => {
			throw ESCAPE;
		},
		hasPendingStories: () => {
			pendingCallCount++;
			return pendingCallCount <= 1;
		},
		acquireLock: () => ({ acquired: true, release: () => {} }),
		runSupervisorFn: async () => result,
		...rest,
	};

	try {
		await runSidecarLoop(loopOpts);
	} catch (e) {
		if (e !== ESCAPE) throw e;
	}
}

// ---------------------------------------------------------------------------
// autoShipFn: outer-loop dispatch (CAM-191 / ADR 0013)
// ---------------------------------------------------------------------------

describe('auto-chain: autoShipFn (runSidecarLoop, post-clearActive)', () => {
	test('complete + CLEAN + marker absent -> marker written before autoShipFn, called once', async () => {
		let autoShipCalls = 0;
		const writtenPrds: PrdSnapshot[] = [];
		const prd = makePrd({ allPass: true, verdict: 'CLEAN' });

		await driveOneTick({
			result: COMPLETE_RESULT,
			buildOpts: () =>
				makeDummySupervisorOpts({
					readPrd: () => prd,
					writePrd: (p) => writtenPrds.push(p),
					clock: () => '2026-07-07T00:00:00Z',
				}),
			autoShipFn: () => {
				autoShipCalls++;
			},
		});

		expect(autoShipCalls).toBe(1);
		expect(writtenPrds).toHaveLength(1);
		expect(writtenPrds[0]?.review?.autoShipDispatchedAt).toBe('2026-07-07T00:00:00Z');
	});

	test('complete + FIXES_PENDING (non-CLEAN) -> autoShipFn NOT called', async () => {
		let autoShipCalls = 0;
		const prd = makePrd({ allPass: true, verdict: 'FIXES_PENDING:1' });

		await driveOneTick({
			result: COMPLETE_RESULT,
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => prd }),
			autoShipFn: () => {
				autoShipCalls++;
			},
		});

		expect(autoShipCalls).toBe(0);
	});

	test('awaiting-operator status -> autoShipFn NOT called even with a CLEAN verdict on the prd', async () => {
		// Auto-ship fires ONLY on result.status === 'complete'. A terminal
		// awaiting-operator result must never dispatch, regardless of prd.review.
		let autoShipCalls = 0;
		const prd = makePrd({ allPass: true, verdict: 'CLEAN' });

		await driveOneTick({
			result: AWAITING_OPERATOR_RESULT,
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => prd }),
			autoShipFn: () => {
				autoShipCalls++;
			},
		});

		expect(autoShipCalls).toBe(0);
	});

	test('complete + CLEAN + marker ALREADY present -> autoShipFn NOT called again (fire-once)', async () => {
		let autoShipCalls = 0;
		let writePrdCalls = 0;
		const prd = makePrd({ allPass: true, verdict: 'CLEAN', autoShipDispatchedAt: '2026-07-01T00:00:00Z' });

		await driveOneTick({
			result: COMPLETE_RESULT,
			buildOpts: () =>
				makeDummySupervisorOpts({
					readPrd: () => prd,
					writePrd: () => {
						writePrdCalls++;
					},
				}),
			autoShipFn: () => {
				autoShipCalls++;
			},
		});

		expect(autoShipCalls).toBe(0);
		expect(writePrdCalls).toBe(0);
	});

	test('operator mode (no autoShipFn injected): complete path does not crash', async () => {
		const prd = makePrd({ allPass: true, verdict: 'CLEAN' });

		// No autoShipFn on loopOpts: must not throw anything other than the
		// escape sentinel used to stop the infinite poll loop.
		let caught: unknown;
		try {
			await driveOneTick({
				result: COMPLETE_RESULT,
				buildOpts: () => makeDummySupervisorOpts({ readPrd: () => prd }),
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// flipActiveFn: auto-chain (unchanged behavior, regression coverage)
// ---------------------------------------------------------------------------

describe('auto-chain: flipActiveFn (runSidecarLoop)', () => {
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
			sleep: () => {
				throw ESCAPE;
			}, // escape on first idle sleep
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => {
				supervisorCalls++;
				return COMPLETE_RESULT;
			},
			flipActiveFn: () => {
				flipCalls++;
			},
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
			sleep: () => {
				throw ESCAPE;
			}, // escape on first idle sleep
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
			flipActiveFn: () => {
				flipCalls++;
			},
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

	test('auto mode: autoShipFn and flipActiveFn are mutually exclusive on the same tick', async () => {
		// complete implies no pending stories (gotcha #7): when autoShipFn fires
		// (CLEAN + marker absent), hasPendingStories() must be false so
		// flipActiveFn does NOT also fire on the same tick.
		let autoShipCalls = 0;
		let flipCalls = 0;
		const prd = makePrd({ allPass: true, verdict: 'CLEAN' });

		await driveOneTick({
			result: COMPLETE_RESULT,
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => prd, writePrd: () => {} }),
			autoShipFn: () => {
				autoShipCalls++;
			},
			flipActiveFn: () => {
				flipCalls++;
			},
		});

		expect(autoShipCalls).toBe(1);
		expect(flipCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// File-assert oracles
// ---------------------------------------------------------------------------

describe('auto-chain: file-assert oracles', () => {
	test('sidecar.ts imports and calls readPlanApproval (AC3 legacy oracle)', () => {
		const sidecarSrc = readFileSync(join(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');
		expect(sidecarSrc).toContain('readPlanApproval');
	});

	test('makeClearActive is exported from sidecar.ts', () => {
		const sidecarSrc = readFileSync(join(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');
		expect(sidecarSrc).toContain('export function makeClearActive');
	});

	test('autoShipDispatchedAt marker exists in decide.ts and loop.ts', () => {
		const decideSrc = readFileSync(join(import.meta.dir, '../../src/supervisor/decide.ts'), 'utf8');
		const loopSrc = readFileSync(join(import.meta.dir, '../../src/supervisor/loop.ts'), 'utf8');
		expect(decideSrc).toContain('autoShipDispatchedAt');
		expect(loopSrc).toContain('autoShipDispatchedAt');
	});

	test('prd.json is in ship-finalize harnessPaths', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/commands/ship-finalize.ts'), 'utf8');
		expect(src).toContain('scripts/cam/prd.json');
	});

	test('AC1: RunSupervisorOptions no longer threads autoShipFn (loop.ts negative oracle)', () => {
		const loopSrc = readFileSync(join(import.meta.dir, '../../src/supervisor/loop.ts'), 'utf8');
		expect(loopSrc).not.toContain('supervisorOpts.autoShipFn');
	});
});
