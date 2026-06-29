// test/supervisor/non-convergence-terminal.test.ts
//
// Oracle tests for US-006: Non-convergence hard terminal.
// Oracle tests for US-002: Cap-REENTRY promotion (top-of-loop).
//
// Coverage:
//   US-006:
//     1. maxRounds hit without CLEAN: loop promotes verdict to MAX_ROUNDS_DEBT,
//        returns a terminal status, and does NOT dispatch a (maxRounds+1)-th fix.
//        (AC1 + AC3: the load-bearing seam US-007 escalation hooks on.)
//     2. Auditor exhausting loops without APPROVE (CLEAN): same deterministic
//        terminal -- no further fix dispatch. (AC2: auditor-no-APPROVE terminal.)
//     3. CLEAN at maxRounds: NO promotion (normal clean exit, unaffected).
//     4. notifyOrchestrator receives the MAX_ROUNDS_DEBT verdict line on promotion.
//     5. writePrd is called with MAX_ROUNDS_DEBT as lastVerdict on promotion.
//   US-002:
//     6. Cap-REENTRY with FIXES_PENDING:1: loop promotes verdict to MAX_ROUNDS_DEBT
//        and returns terminal without dispatching a review/implement round.
//     7. Ship-gate: makeHasPendingStories returns false on promoted prd, true on
//        unpromoted prd with FIXES_PENDING:1.
//     8. CLEAN-at-cap is unchanged: no MAX_ROUNDS_DEBT write when promoteVerdictTo
//        is absent (verdict already terminal).
//     9. await-operator + cap-REENTRY: promotion fires in the await-operator branch.

import { describe, expect, test, beforeEach } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	runSupervisor,
	MAX_ITERATIONS,
} from '../../src/supervisor/loop.ts';
import { makeHasPendingStories } from '../../src/commands/sidecar.ts';
import type {
	RunSupervisorOptions,
	SpawnFn,
	CapturePane,
	ReadPrd,
	WritePrd,
	ReadHandoff,
	ClockFn,
	GenUuid,
	ReviewDispatch,
	WriteSessionMarker,
	IsPaneAlive,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import { DEFAULT_MAX_ROUNDS } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Fake builder helpers
// ---------------------------------------------------------------------------

function makePrd(opts: {
	stories: Array<{ id: string; priority: number; passes: boolean; requires?: string }>;
	review?: PrdSnapshot['review'];
}): PrdSnapshot {
	return {
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: s.requires ?? null,
		})),
		review: opts.review,
	};
}

const WORKER_PANE_ID = '%3';
const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = (_paneId) => true;

	return {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid: fakeGenUuid,
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		...overrides,
	};
}

beforeEach(() => {
	uuidCounter = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('non-convergence hard terminal (US-006)', () => {
	test('maxRounds hit without CLEAN: returns terminal status, promotes to MAX_ROUNDS_DEBT, no 4th fix (AC1 + AC3)', async () => {
		// Setup: all stories pass at the start of the loop iteration (review action).
		// After reviewDispatch, the PRD shows roundsCompleted == maxRounds with
		// FIXES_PENDING (not CLEAN). A passes:false fix story is present to prove
		// the loop does NOT dispatch a (maxRounds+1)-th fix.
		const prd_reviewNeeded = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});
		// After review: maxRounds hit, still FIXES_PENDING. Fix story added by reviewer.
		const prd_maxRoundsHit = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-FIX-001', priority: 99, passes: false }, // reviewer added fix story
			],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		const prds: (PrdSnapshot | null)[] = [prd_reviewNeeded, prd_maxRoundsHit];
		let prdCall = 0;
		const writtenPrds: PrdSnapshot[] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				// Call index: 0 = top-of-loop (review action); 1 = after reviewDispatch
				// (maxRounds hit). If the loop continues past the terminal (bug), it
				// reads null on call 2, causing 'blocked' -- the test would fail.
				return prds[prdCall++] ?? null;
			},
			writePrd: (prd) => {
				// Capture a shallow copy so we can inspect the lastVerdict.
				writtenPrds.push(JSON.parse(JSON.stringify(prd)) as PrdSnapshot);
			},
		});

		const result = await runSupervisor(opts);

		// AC1: loop returns a terminal status (not blocked, not max-iterations).
		expect(result.status).toBe('complete');

		// AC3: the stored verdict in prd.json is promoted to MAX_ROUNDS_DEBT.
		const lastWrite = writtenPrds[writtenPrds.length - 1];
		expect(lastWrite?.review?.lastVerdict).toBe('MAX_ROUNDS_DEBT');

		// AC3: NO (maxRounds+1)-th fix is dispatched.
		// Proven by: prdCall === 2 (only the expected 2 reads occurred).
		// A 3rd read would mean the loop tried to continue past the terminal.
		expect(prdCall).toBe(2);

		// Iterations = 1 (the single review dispatch).
		expect(result.iterations).toBe(1);
	});

	test('auditor exhausting loops without APPROVE: deterministic terminal, no further fix dispatch (AC2)', async () => {
		// AC2 is the same code path as AC1, framed as "auditor-no-APPROVE":
		// the review (auditor) loop exhausts maxRounds without a CLEAN (APPROVE)
		// verdict. The pipeline stops; no further fix is dispatched.
		const prd_start = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: DEFAULT_MAX_ROUNDS, lastVerdict: null },
		});
		const prd_exhausted = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: DEFAULT_MAX_ROUNDS, maxRounds: DEFAULT_MAX_ROUNDS, lastVerdict: 'FIXES_PENDING:0' },
		});

		let prdCall = 0;
		const prds = [prd_start, prd_exhausted];

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
		});

		const result = await runSupervisor(opts);

		// Terminal status: pipeline stops cleanly.
		expect(result.status).toBe('complete');
		// Only 2 prd reads: top + after review. No 3rd read (no fix dispatch).
		expect(prdCall).toBe(2);
	});

	test('CLEAN at maxRounds: NO promotion, normal complete (unaffected path)', async () => {
		// When the review returns CLEAN exactly at maxRounds, the non-convergence
		// check must NOT fire (condition is lastVerdict !== 'CLEAN'). The loop
		// reaches 'complete' via the normal path.
		const prd_reviewNeeded = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: null },
		});
		const prd_cleanAtMax = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'CLEAN' },
		});
		// 3rd read (next iteration top): CLEAN verdict is terminal, returns complete.
		const prd_complete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'CLEAN' },
		});

		const writtenPrds: PrdSnapshot[] = [];
		let prdCall = 0;
		const prds = [prd_reviewNeeded, prd_cleanAtMax, prd_complete];

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
			writePrd: (prd) => {
				writtenPrds.push(JSON.parse(JSON.stringify(prd)) as PrdSnapshot);
			},
		});

		const result = await runSupervisor(opts);

		// Normal complete (not promoted).
		expect(result.status).toBe('complete');
		// The verdict is NOT promoted to MAX_ROUNDS_DEBT.
		const verdicts = writtenPrds.map((p) => p.review?.lastVerdict);
		expect(verdicts.includes('MAX_ROUNDS_DEBT')).toBe(false);
	});

	test('notifyOrchestrator called with MAX_ROUNDS_DEBT verdict line on promotion', async () => {
		const prd_reviewNeeded = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: null },
		});
		const prd_maxRoundsHit = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		const prds = [prd_reviewNeeded, prd_maxRoundsHit];
		let prdCall = 0;
		const notifications: string[] = [];

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
			notifyOrchestrator: (line) => notifications.push(line),
		});

		await runSupervisor(opts);

		// The promotion must emit a '[cam] review round N: MAX_ROUNDS_DEBT' line.
		const maxDebtLine = notifications.find((n) => n.includes('MAX_ROUNDS_DEBT'));
		expect(maxDebtLine).toBeDefined();
		expect(maxDebtLine).toMatch(/\[cam\] review round \d+: MAX_ROUNDS_DEBT/);
	});

	test('writePrd called with MAX_ROUNDS_DEBT as lastVerdict on promotion', async () => {
		const prd_reviewNeeded = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: null },
		});
		const prd_maxRoundsHit = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		const prds = [prd_reviewNeeded, prd_maxRoundsHit];
		let prdCall = 0;
		const writtenVerdicts: Array<string | null | undefined> = [];

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
			writePrd: (prd) => {
				writtenVerdicts.push(prd.review?.lastVerdict);
			},
		});

		await runSupervisor(opts);

		// At least one writePrd call must have MAX_ROUNDS_DEBT.
		expect(writtenVerdicts.includes('MAX_ROUNDS_DEBT')).toBe(true);
		// The LAST writePrd must be the promotion (MAX_ROUNDS_DEBT).
		expect(writtenVerdicts[writtenVerdicts.length - 1]).toBe('MAX_ROUNDS_DEBT');
	});
});

// ---------------------------------------------------------------------------
// US-002: Cap-REENTRY promotion (top-of-loop)
// ---------------------------------------------------------------------------
//
// The US-006 path promotes verdict AFTER a review dispatch (post-review branch,
// ~loop.ts:1115-1148). US-002 adds the missing cap-REENTRY path: when the loop
// re-enters with a prd that ALREADY has roundsCompleted >= maxRounds and a
// non-terminal verdict, decideNextAction returns 'complete' (or 'await-operator')
// with promoteVerdictTo set. The loop must write the promoted prd and return
// terminal WITHOUT dispatching a review or implement round.

describe('cap-REENTRY promotion (US-002)', () => {
	test('AC1+AC2: all stories pass, roundsCompleted==maxRounds, FIXES_PENDING -> terminal + promoted verdict', async () => {
		// The FIRST prd read already has all stories passing, roundsCompleted ==
		// maxRounds, lastVerdict == FIXES_PENDING:1. This is the CAM-78 reentry
		// case: the supervisor loop was stopped at the cap boundary and is now
		// re-entering. No review round is dispatched in this iteration; the
		// FIRST decideNextAction must trigger the cap-REENTRY promotion.
		const prd_capReentry = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		let prdCall = 0;
		const writtenPrds: PrdSnapshot[] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				// First call returns the cap-reentry prd. Any further call returns null
				// (proving the loop did not dispatch a review/implement round).
				return prdCall++ === 0 ? prd_capReentry : null;
			},
			writePrd: (prd) => {
				writtenPrds.push(JSON.parse(JSON.stringify(prd)) as PrdSnapshot);
			},
		});

		const result = await runSupervisor(opts);

		// AC1: loop returns a terminal status (not blocked, not max-iterations).
		expect(result.status).toBe('complete');

		// AC2: writePrd was called with MAX_ROUNDS_DEBT as lastVerdict.
		const lastWrite = writtenPrds[writtenPrds.length - 1];
		expect(lastWrite?.review?.lastVerdict).toBe('MAX_ROUNDS_DEBT');

		// AC2: only ONE prd read occurred (no review/implement dispatch).
		expect(prdCall).toBe(1);
	});

	test('AC3 (ship-gate): promoted prd -> makeHasPendingStories returns false; unpromoted -> true', () => {
		// Create a temp directory to write prd fixtures for makeHasPendingStories.
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-us002-test-'));
		try {
			const promotedPrd = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'MAX_ROUNDS_DEBT' },
			});
			const unpromotedPrd = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
			});

			const promotedPath = join(tmpDir, 'prd-promoted.json');
			const unpromotedPath = join(tmpDir, 'prd-unpromoted.json');
			writeFileSync(promotedPath, JSON.stringify(promotedPrd));
			writeFileSync(unpromotedPath, JSON.stringify(unpromotedPrd));

			// Promoted prd (MAX_ROUNDS_DEBT) -> no pending stories for ship gate.
			expect(makeHasPendingStories(promotedPath)()).toBe(false);

			// Unpromoted prd (FIXES_PENDING:1) -> still pending (verdict non-terminal).
			expect(makeHasPendingStories(unpromotedPath)()).toBe(true);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('AC4 (CLEAN-at-cap unchanged): CLEAN verdict -> no MAX_ROUNDS_DEBT write', async () => {
		// When the prd already has lastVerdict == 'CLEAN' at maxRounds, decideNextAction
		// does NOT set promoteVerdictTo (CLEAN is already terminal). The loop must
		// return complete WITHOUT writing MAX_ROUNDS_DEBT.
		const prd_cleanAtCap = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'CLEAN' },
		});

		const writtenVerdicts: Array<string | null | undefined> = [];

		const opts = makeBaseOpts({
			readPrd: () => prd_cleanAtCap,
			writePrd: (prd) => {
				writtenVerdicts.push(prd.review?.lastVerdict);
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// No writePrd call must contain MAX_ROUNDS_DEBT.
		expect(writtenVerdicts.includes('MAX_ROUNDS_DEBT')).toBe(false);
	});

	test('await-operator + cap-REENTRY: promotion fires in the await-operator branch', async () => {
		// Same cap-REENTRY scenario but with an operator-required story still pending.
		// decideNextAction routes to 'await-operator' with promoteVerdictTo set.
		const prd_capReentryWithOperator = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-OP-001', priority: 2, passes: false, requires: 'operator' },
			],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		let prdCall = 0;
		const writtenPrds: PrdSnapshot[] = [];
		const notifications: string[] = [];

		const opts = makeBaseOpts({
			readPrd: () => (prdCall++ === 0 ? prd_capReentryWithOperator : null),
			writePrd: (prd) => {
				writtenPrds.push(JSON.parse(JSON.stringify(prd)) as PrdSnapshot);
			},
			notifyOrchestrator: (line) => notifications.push(line),
		});

		const result = await runSupervisor(opts);

		// Terminal: await-operator (not complete, not blocked).
		expect(result.status).toBe('awaiting-operator');

		// writePrd called with MAX_ROUNDS_DEBT.
		const lastWrite = writtenPrds[writtenPrds.length - 1];
		expect(lastWrite?.review?.lastVerdict).toBe('MAX_ROUNDS_DEBT');

		// notifyOrchestrator received the MAX_ROUNDS_DEBT verdict line.
		const maxDebtLine = notifications.find((n) => n.includes('MAX_ROUNDS_DEBT'));
		expect(maxDebtLine).toBeDefined();
		expect(maxDebtLine).toMatch(/\[cam\] review round \d+: MAX_ROUNDS_DEBT/);

		// Only ONE prd read (no dispatch).
		expect(prdCall).toBe(1);
	});
});
