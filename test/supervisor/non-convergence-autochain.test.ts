// test/supervisor/non-convergence-autochain.test.ts
//
// Oracle tests for US-008: Fix auto-chain defeating the MAX_ROUNDS_DEBT
// non-convergence terminal.
//
// Coverage:
//   AC1: No orphan fix story is created in the terminal round (newRound == maxRounds,
//        FIXES_PENDING). prd.json userStories count unchanged; no US-R{maxRounds}-* story.
//   AC2: prd.review.lastVerdict is promoted to MAX_ROUNDS_DEBT on the terminal round.
//   AC3: makeHasPendingStories returns false in the MAX_ROUNDS_DEBT terminal state
//        (no false-pending from orphan fix stories).
//   AC4: Auto-chain does NOT dispatch ship or flip-active at MAX_ROUNDS_DEBT terminal.
//
// All tests use injected fakes; no real tmux or network access.

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeReviewDispatch } from '../../src/supervisor/review.ts';
import { makeHasPendingStories } from '../../src/commands/sidecar.ts';
import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

afterEach(() => {
	for (const dir of dirsToClean.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-us008-'));
	dirsToClean.push(dir);
	return dir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal supervisor options whose supervisor never actually runs. */
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
// AC1 + AC2: makeReviewDispatch — terminal round behaviour
// ---------------------------------------------------------------------------

describe('AC1 + AC2: makeReviewDispatch at terminal round (newRound == maxRounds)', () => {
	/**
	 * Creates a makeReviewDispatch call at newRound == maxRounds (e.g. 3 of 3)
	 * with a FIXES_PENDING verdict. The review.ts fix (newRound >= maxRounds)
	 * must set MAX_ROUNDS_DEBT directly without creating orphan fix stories.
	 */
	function runTerminalRoundDispatch(maxRounds: number) {
		const roundsCompleted = maxRounds - 1; // so newRound = maxRounds

		const originalStories = [
			{ id: 'US-001', priority: 1, passes: true, requires: null },
		];
		const prd: PrdSnapshot = {
			userStories: [...originalStories],
			review: {
				roundsCompleted,
				maxRounds,
				lastVerdict: 'FIXES_PENDING:1',
			},
		};

		const writtenPrds: PrdSnapshot[] = [];

		const dispatch = makeReviewDispatch({
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => '',
			readPrd: () => prd,
			writePrd: (p) => {
				writtenPrds.push(JSON.parse(JSON.stringify(p)) as PrdSnapshot);
			},
			workerPaneId: '%3',
			isPaneAlive: () => true,
			sleepFn: () => {},
			permissionMode: 'bypassPermissions',
			// Inject the review report directly so the poll loop exits immediately
			// without waiting for capture-pane or pane lifecycle.
			readReviewReport: () => ({
				verdict: `FIXES_PENDING:1`,
				findings: [{ severity: 'ERROR', text: 'some error on terminal round' }],
			}),
		});

		const result = dispatch('uuid-terminal');
		return { result, writtenPrds, originalStories };
	}

	test('AC1: userStories count unchanged (no orphan fix stories created)', () => {
		const { writtenPrds, originalStories } = runTerminalRoundDispatch(3);

		expect(writtenPrds.length).toBeGreaterThan(0);
		const lastPrd = writtenPrds[writtenPrds.length - 1]!;

		// Count must be identical to the original (no new fix stories).
		expect(lastPrd.userStories?.length).toBe(originalStories.length);
	});

	test('AC1: no US-R{maxRounds}-* story exists in the written prd', () => {
		const maxRounds = 3;
		const { writtenPrds } = runTerminalRoundDispatch(maxRounds);

		const lastPrd = writtenPrds[writtenPrds.length - 1]!;
		const orphanPattern = new RegExp(`^US-R${maxRounds}-`);
		const hasOrphan = lastPrd.userStories?.some((s) => orphanPattern.test(s.id ?? '')) ?? false;
		expect(hasOrphan).toBe(false);
	});

	test('AC2: prd.review.lastVerdict is MAX_ROUNDS_DEBT on the terminal round', () => {
		const { writtenPrds } = runTerminalRoundDispatch(3);

		const lastPrd = writtenPrds[writtenPrds.length - 1]!;
		expect(lastPrd.review?.lastVerdict).toBe('MAX_ROUNDS_DEBT');
	});

	test('AC1 + AC2: also holds for maxRounds=1 (single-round PRD)', () => {
		const { writtenPrds, originalStories } = runTerminalRoundDispatch(1);

		const lastPrd = writtenPrds[writtenPrds.length - 1]!;
		// No new stories.
		expect(lastPrd.userStories?.length).toBe(originalStories.length);
		// Verdict promoted.
		expect(lastPrd.review?.lastVerdict).toBe('MAX_ROUNDS_DEBT');
	});

	test('CLEAN at maxRounds is unaffected (must not be treated as terminal-debt)', () => {
		// When the verdict is CLEAN, newRound == maxRounds is fine: the CLEAN path
		// exits early before the >= maxRounds check on the FIXES_PENDING path.
		const prd: PrdSnapshot = {
			userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: null },
		};

		const writtenPrds: PrdSnapshot[] = [];

		const dispatch = makeReviewDispatch({
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => '',
			readPrd: () => prd,
			writePrd: (p) => {
				writtenPrds.push(JSON.parse(JSON.stringify(p)) as PrdSnapshot);
			},
			workerPaneId: '%3',
			isPaneAlive: () => true,
			sleepFn: () => {},
			permissionMode: 'bypassPermissions',
			readReviewReport: () => ({
				verdict: 'CLEAN',
				findings: [],
			}),
		});

		const result = dispatch('uuid-clean');
		expect(result.status).toBe('ok');

		const lastPrd = writtenPrds[writtenPrds.length - 1]!;
		// CLEAN: verdict must be 'CLEAN', NOT 'MAX_ROUNDS_DEBT'.
		expect(lastPrd.review?.lastVerdict).toBe('CLEAN');
		// No new stories for CLEAN.
		expect(lastPrd.userStories?.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC3: makeHasPendingStories returns false in MAX_ROUNDS_DEBT state
// ---------------------------------------------------------------------------

describe('AC3: makeHasPendingStories returns false at MAX_ROUNDS_DEBT terminal', () => {
	test('returns false when lastVerdict is MAX_ROUNDS_DEBT and no pending stories', () => {
		const tmpDir = makeTmpDir();
		const prdPath = join(tmpDir, 'prd.json');

		const prd: PrdSnapshot = {
			userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'MAX_ROUNDS_DEBT' },
		};
		writeFileSync(prdPath, JSON.stringify(prd));

		const hasPending = makeHasPendingStories(prdPath);
		expect(hasPending()).toBe(false);
	});

	test('returns false when MAX_ROUNDS_DEBT even if orphan fix stories exist (defensive guard)', () => {
		// This is the core AC3 scenario: the terminal verdict must win over
		// any passes:false stories that might have been left in prd.json.
		const tmpDir = makeTmpDir();
		const prdPath = join(tmpDir, 'prd.json');

		const prdWithOrphans: PrdSnapshot = {
			userStories: [
				{ id: 'US-001', priority: 1, passes: true, requires: null },
				{ id: 'US-R3-001', priority: 99, passes: false, requires: null }, // orphan fix story
			],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'MAX_ROUNDS_DEBT' },
		};
		writeFileSync(prdPath, JSON.stringify(prdWithOrphans));

		const hasPending = makeHasPendingStories(prdPath);
		// Must return false despite the passes:false orphan story.
		expect(hasPending()).toBe(false);
	});

	test('still returns true when lastVerdict is FIXES_PENDING (non-terminal, pending work)', () => {
		// Regression guard: FIXES_PENDING is not terminal; pending stories must still
		// cause makeHasPendingStories to return true.
		const tmpDir = makeTmpDir();
		const prdPath = join(tmpDir, 'prd.json');

		const prd: PrdSnapshot = {
			userStories: [
				{ id: 'US-001', priority: 1, passes: true, requires: null },
				{ id: 'US-R2-001', priority: 1, passes: false, requires: null },
			],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		};
		writeFileSync(prdPath, JSON.stringify(prd));

		const hasPending = makeHasPendingStories(prdPath);
		expect(hasPending()).toBe(true);
	});

	test('returns true when lastVerdict is CLEAN but a non-operator story is still pending (valid scenario)', () => {
		// CLEAN verdict + pending story is a valid scenario (operator added a new
		// story after a clean review, or the story was missed). The guard must NOT
		// apply to CLEAN — only MAX_ROUNDS_DEBT stops the loop unconditionally.
		const tmpDir = makeTmpDir();
		const prdPath = join(tmpDir, 'prd.json');

		const prd: PrdSnapshot = {
			userStories: [
				{ id: 'US-001', priority: 1, passes: true, requires: null },
				{ id: 'US-002', priority: 2, passes: false, requires: null },
			],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'CLEAN' },
		};
		writeFileSync(prdPath, JSON.stringify(prd));

		const hasPending = makeHasPendingStories(prdPath);
		// CLEAN does NOT unconditionally stop the pipeline; pending work resumes.
		expect(hasPending()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC4: Auto-chain does NOT dispatch ship or flip-active at MAX_ROUNDS_DEBT
// ---------------------------------------------------------------------------

describe('AC4: auto-chain does not fire at MAX_ROUNDS_DEBT terminal', () => {
	const ESCAPE = Symbol('escape');

	/** Minimal sidecar loop options that simulate a MAX_ROUNDS_DEBT terminal. */
	function makeMaxDebtSidecarOpts(overrides: Partial<RunSidecarLoopOptions> = {}): RunSidecarLoopOptions {
		const readActiveSeq = [true, false];
		let readIdx = 0;

		return {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => { throw ESCAPE; }, // escape on first idle sleep
			// hasPendingStories returns false: MAX_ROUNDS_DEBT state, no pending work.
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			// Fake supervisor: returns 'complete' immediately (simulates MAX_ROUNDS_DEBT terminal).
			runSupervisorFn: async (): Promise<SupervisorResult> => ({
				status: 'complete',
				iterations: 1,
				lastOutcome: null,
			}),
			...overrides,
		};
	}

	test('flipActiveFn is NOT called when hasPendingStories returns false', async () => {
		let flipCalls = 0;

		const opts = makeMaxDebtSidecarOpts({
			flipActiveFn: () => { flipCalls++; },
		});

		try {
			await runSidecarLoop(opts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// The auto-chain gate (hasPendingStories() === false) must prevent flipActiveFn.
		expect(flipCalls).toBe(0);
	});

	test('autoShipFn is NOT called on MAX_ROUNDS_DEBT verdict (only fires on CLEAN)', async () => {
		// autoShipFn is called inside runSupervisor only when lastVerdict === 'CLEAN'.
		// At a MAX_ROUNDS_DEBT terminal, the supervisor returns 'complete' without
		// a CLEAN verdict, so autoShipFn must never be called.
		let autoShipCalls = 0;

		// Use the real runSupervisor with a prd that reaches MAX_ROUNDS_DEBT.
		// PRD sequence: all-pass-with-FIXES_PENDING-at-maxRounds -> MAX_ROUNDS_DEBT.
		const prd_reviewNeeded: PrdSnapshot = {
			userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		};
		const prd_maxRoundsHit: PrdSnapshot = {
			userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'MAX_ROUNDS_DEBT' },
		};

		const prds = [prd_reviewNeeded, prd_maxRoundsHit];
		let prdIdx = 0;
		let pendingCount = 0;

		const readActiveSeq = [true, false];
		let readIdx = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => ({
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
			}),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => { throw ESCAPE; },
			hasPendingStories: () => {
				pendingCount++;
				// First call (before supervisor dispatch): active/pending.
				// Second call (auto-chain check): MAX_ROUNDS_DEBT => no pending.
				return pendingCount <= 1;
			},
			acquireLock: () => ({ acquired: true, release: () => {} }),
			// No runSupervisorFn override: uses real runSupervisor.
			autoShipFn: () => { autoShipCalls++; },
			flipActiveFn: () => {},
		};

		try {
			await runSidecarLoop(opts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// autoShipFn must NOT be called: MAX_ROUNDS_DEBT is not CLEAN.
		expect(autoShipCalls).toBe(0);
	});

	test('hasPendingStories is called after supervisor completes; false => no flip', async () => {
		// Confirm the exact call sequence: hasPendingStories is consulted by
		// the sidecar loop after runSupervisorFn returns, and returning false
		// prevents the auto-chain flip.
		let flipCalls = 0;
		let pendingCallCount = 0;

		const readActiveSeq = [true, false];
		let readIdx = 0;

		const opts = makeMaxDebtSidecarOpts({
			hasPendingStories: () => {
				pendingCallCount++;
				// First call (before supervisor): true (work to do).
				// Second call (after supervisor, auto-chain check): false (terminal).
				return pendingCallCount <= 1;
			},
			flipActiveFn: () => { flipCalls++; },
			readActive: () => readActiveSeq[readIdx++] ?? false,
		});

		try {
			await runSidecarLoop(opts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// hasPendingStories was called (at least the auto-chain check call).
		expect(pendingCallCount).toBeGreaterThanOrEqual(1);
		// flipActiveFn never called: second hasPendingStories returned false.
		expect(flipCalls).toBe(0);
	});
});
