// test/supervisor/notify-orchestrator.test.ts
//
// Unit tests for the notifyOrchestrator hook in the review branch of
// runSupervisor (US-001, CAM-70).
//
// Coverage:
//   1. CLEAN verdict: notifyOrchestrator called with '[cam] review round 1: CLEAN'.
//   2. FIXES_PENDING:3 verdict: notifyOrchestrator called with '[cam] review round 1: FIXES_PENDING:3'.
//   3. MAX_ROUNDS_DEBT verdict: notifyOrchestrator called with '[cam] review round 4: MAX_ROUNDS_DEBT'.
//   4. notifyOrchestrator absent: loop runs without throwing (backward compat).
//   5. reviewResult.status 'error': notifyOrchestrator IS called with '[cam] review BLOCKED:' (US-005).
//   6. updatedPrd.review.lastVerdict null: notifyOrchestrator is NOT called.

import { describe, expect, test } from 'bun:test';
import { runSupervisor } from '../../src/supervisor/loop.ts';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a PrdSnapshot with all non-operator stories passing and given review state. */
function makeAllPassPrd(review: PrdSnapshot['review']): PrdSnapshot {
	return {
		userStories: [{ id: 'US-001', priority: 1, passes: true }],
		review,
	};
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

let uuidSeq = 0;
function fakeUuid(): string {
	uuidSeq++;
	return `00000000-0000-0000-0000-${String(uuidSeq).padStart(12, '0')}`;
}

/**
 * Build a base RunSupervisorOptions suitable for the review-branch tests.
 *
 * @param prdSequence  Ordered array of PRD snapshots returned by sequential
 *   readPrd() calls. The first call (top of loop) triggers decideNextAction;
 *   the second call (inside the review branch, after reviewDispatch) provides
 *   the verdict PRD that the notifyOrchestrator callback reads from.
 */
function makeReviewOpts(
	prdSequence: Array<PrdSnapshot | null>,
	overrides: Partial<RunSupervisorOptions> = {},
): RunSupervisorOptions {
	let prdCallIdx = 0;
	const readPrd: ReadPrd = () => prdSequence[prdCallIdx++] ?? null;
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-15T00:00:00Z';
	const genUuid: GenUuid = fakeUuid;
	const reviewDispatch: ReviewDispatch = (_uuid) => ({ status: 'ok', detail: 'review dispatched' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = (_paneId) => true;

	return {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid,
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		maxIterations: 2,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notifyOrchestrator in review branch (US-001)', () => {
	test('CLEAN verdict: callback receives "[cam] review round 1: CLEAN"', async () => {
		uuidSeq = 0;
		const notifiedLines: string[] = [];

		// PRD sequence:
		//   call 0 (top of iteration 1): all pass, no review -> decideNextAction: 'review'
		//   call 1 (inside review branch after dispatch): same PRD with CLEAN verdict
		//   call 2 (top of iteration 2): all pass + CLEAN -> decideNextAction: 'complete'
		const cleanPrd = makeAllPassPrd({ roundsCompleted: 1, lastVerdict: 'CLEAN' });
		const prdSequence = [
			makeAllPassPrd({ roundsCompleted: 0, lastVerdict: null }),
			cleanPrd,
			cleanPrd,
		];

		const opts = makeReviewOpts(prdSequence, {
			notifyOrchestrator: (line) => notifiedLines.push(line),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(notifiedLines).toEqual(['[cam] review round 1: CLEAN']);
	});

	test('FIXES_PENDING:3 verdict: callback receives "[cam] review round 1: FIXES_PENDING:3"', async () => {
		uuidSeq = 0;
		const notifiedLines: string[] = [];

		// After FIXES_PENDING, new stories are added and the loop continues. Use
		// maxIterations:1 so the loop exits after the first review iteration, letting
		// us observe the callback without wiring a full implement+review cycle.
		const fixesPendingPrd = makeAllPassPrd({ roundsCompleted: 1, lastVerdict: 'FIXES_PENDING:3' });
		const prdSequence = [
			makeAllPassPrd({ roundsCompleted: 0, lastVerdict: null }),
			fixesPendingPrd,
		];

		const opts = makeReviewOpts(prdSequence, {
			maxIterations: 1,
			notifyOrchestrator: (line) => notifiedLines.push(line),
		});

		const result = await runSupervisor(opts);

		// Loop exits due to maxIterations cap (1 review iteration consumed the budget).
		expect(result.status).toBe('max-iterations');
		expect(notifiedLines).toEqual(['[cam] review round 1: FIXES_PENDING:3']);
	});

	test('MAX_ROUNDS_DEBT verdict: callback receives "[cam] review round 4: MAX_ROUNDS_DEBT"', async () => {
		uuidSeq = 0;
		const notifiedLines: string[] = [];

		// roundsCompleted:4 -> formatReviewVerdictLine(4, 'MAX_ROUNDS_DEBT').
		// PRD[0] must have roundsCompleted < maxRounds so decideNextAction returns
		// 'review', not 'complete'. Use maxRounds:5 and roundsCompleted:3.
		const debtPrd: PrdSnapshot = {
			userStories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 4, maxRounds: 5, lastVerdict: 'MAX_ROUNDS_DEBT' },
		};
		const prdSequence: Array<PrdSnapshot | null> = [
			{
				userStories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 3, maxRounds: 5, lastVerdict: null },
			},
			debtPrd,
			debtPrd,
		];

		const opts = makeReviewOpts(prdSequence, {
			notifyOrchestrator: (line) => notifiedLines.push(line),
		});

		const result = await runSupervisor(opts);

		// MAX_ROUNDS_DEBT is terminal: decideNextAction returns 'complete' on the
		// next iteration (all stories pass + terminal verdict).
		expect(result.status).toBe('complete');
		expect(notifiedLines).toEqual(['[cam] review round 4: MAX_ROUNDS_DEBT']);
	});

	test('notifyOrchestrator absent: loop runs without throwing (backward compat)', async () => {
		uuidSeq = 0;
		const cleanPrd = makeAllPassPrd({ roundsCompleted: 1, lastVerdict: 'CLEAN' });
		const prdSequence = [
			makeAllPassPrd({ roundsCompleted: 0, lastVerdict: null }),
			cleanPrd,
			cleanPrd,
		];

		// No notifyOrchestrator injected.
		const opts = makeReviewOpts(prdSequence);

		// Should not throw and should reach 'complete' normally.
		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
	});

	test('reviewResult status error: notifyOrchestrator IS called with [cam] review BLOCKED: (US-005)', async () => {
		uuidSeq = 0;
		const notifiedLines: string[] = [];

		const prdSequence = [
			makeAllPassPrd({ roundsCompleted: 0, lastVerdict: null }),
		];

		const opts = makeReviewOpts(prdSequence, {
			// All attempts return error -> loop returns 'blocked'.
			reviewDispatch: (_uuid) => ({ status: 'error', detail: 'reviewer died' }),
			notifyOrchestrator: (line) => notifiedLines.push(line),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		// US-005: notifyOrchestrator is called exactly once with the BLOCKED prefix.
		expect(notifiedLines.length).toBe(1);
		expect(notifiedLines[0]).toMatch(/^\[cam\] review BLOCKED:/);
	});

	test('lastVerdict null in re-read PRD: notifyOrchestrator is NOT called', async () => {
		uuidSeq = 0;
		const notifiedLines: string[] = [];

		// The re-read PRD has lastVerdict: null (unusual edge case: dispatch wrote
		// nothing or file was reset). The loop should not call notifyOrchestrator.
		const prdSequence = [
			makeAllPassPrd({ roundsCompleted: 0, lastVerdict: null }),
			makeAllPassPrd({ roundsCompleted: 0, lastVerdict: null }), // no verdict written
			makeAllPassPrd({ roundsCompleted: 1, lastVerdict: 'CLEAN' }), // next iter -> complete
		];

		const opts = makeReviewOpts(prdSequence, {
			maxIterations: 2,
			notifyOrchestrator: (line) => notifiedLines.push(line),
		});

		await runSupervisor(opts);

		expect(notifiedLines).toEqual([]);
	});
});
