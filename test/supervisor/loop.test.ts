// test/supervisor/loop.test.ts
//
// Unit tests for src/supervisor/loop.ts (runSupervisor).
//
// Coverage:
//   1. Happy path: 2 stories pass, then review returns CLEAN -> 'complete'.
//   2. One story blocked: loop exits with 'blocked'.
//   3. Max-iterations cap fires before any story completes.
//   4. PRD unreadable on first iteration -> 'blocked'.
//   5. decideNextAction returns 'complete' immediately -> 'complete' with 0 iterations.
//   6. decideNextAction returns 'blocked-no-implementable' -> 'blocked'.
//   7. Worker outcome 'fail' -> 'blocked'.
//   8. Worker outcome 'unknown' -> 'blocked'.
//   9. Review dispatch error -> 'blocked'.
//  10. writeSessionMarker called with actualStoryId, not advisory storyId.
//  11. PRD_COMPLETE sentinel (outcome.storyId undefined) -> continue, next iter complete.

import { describe, expect, test, jest, beforeEach } from 'bun:test';
import { runSupervisor, MAX_ITERATIONS } from '../../src/supervisor/loop.ts';
import type {
	RunSupervisorOptions,
	SpawnFn,
	WaitForFn,
	CapturePane,
	ReadPrd,
	WritePrd,
	ReadHandoff,
	ClockFn,
	GenUuid,
	GenChannel,
	ReviewDispatch,
	WriteSessionMarker,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Fake builder helpers
// ---------------------------------------------------------------------------

/** Build a prd snapshot with N stories, optionally some already passing. */
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

/** Build a handoff snapshot for the given story. */
function makeHandoff(storyId: string) {
	return {
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test',
		timestamp: '2026-06-08T00:00:00Z',
	};
}

/**
 * Build a fake pane text with the DONE sentinel for the given storyId.
 * Matches the pattern readWorkerOutcome expects.
 */
function donePane(storyId: string): string {
	return `Implemented something\nCAM_IMPLEMENTER_STATUS=DONE story=${storyId}\n`;
}

/** Pane text with PRD_COMPLETE sentinel (no story=). */
const PRD_COMPLETE_PANE = `Nothing to do\nCAM_IMPLEMENTER_STATUS=PRD_COMPLETE\n`;

/** Pane text with BLOCKED sentinel. */
function blockedPane(storyId: string): string {
	return `Some output\nCAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=${storyId} reason=tests_failed\n`;
}

/** Pane text with no recognizable sentinel. */
const UNKNOWN_PANE = `Error: something failed\nNo sentinel here\n`;

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

// ---------------------------------------------------------------------------
// Fake uuid/channel generators (deterministic)
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

function fakeGenChannel(storyId: string, uuid: string): string {
	return `cam-worker-${storyId}-${uuid.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Base options factory
// ---------------------------------------------------------------------------

/**
 * Build a base RunSupervisorOptions where readPrd, readHandoff, capturePane,
 * and writeSessionMarker can be overridden per test.
 */
function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const waitFor: WaitForFn = (_channel) => {};
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid, _channel) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};

	return {
		spawn,
		waitFor,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid: fakeGenUuid,
		genChannel: fakeGenChannel,
		reviewDispatch,
		writeSessionMarker,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Reset uuid counter before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
	uuidCounter = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSupervisor', () => {
	test('immediately returns complete when decideNextAction -> complete', async () => {
		// PRD with all stories passing and terminal review verdict.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(0);
		expect(result.lastOutcome).toBeNull();
	});

	test('immediately returns blocked when decideNextAction -> blocked-no-implementable', async () => {
		// PRD with only operator-required stories remaining.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false, requires: 'operator' }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(0);
	});

	test('returns blocked when PRD is unreadable on first iteration', async () => {
		const opts = makeBaseOpts({
			readPrd: () => null,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(0);
	});

	test('happy path: 2 stories complete then review CLEAN -> complete', async () => {
		// readPrd() call sequence (per iteration):
		//   iter 1 (implement US-001): call 0 = top (decideNextAction), call 1 = fileReader (outcome check)
		//   iter 2 (implement US-002): call 2 = top, call 3 = fileReader
		//   iter 3 (review):           call 4 = top (decideNextAction -> review), call 5 = after reviewDispatch
		//   iter 4 (complete):         call 6 = top -> complete

		const prd_bothIncomplete = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: false },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});
		const prd_001done = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});
		const prd_bothDone_noReview = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: true },
			],
			review: { roundsCompleted: 0, lastVerdict: null },
		});
		const prd_bothDone_clean = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: true },
			],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		const prds: PrdSnapshot[] = [
			prd_bothIncomplete, // call 0: iter 1 top -> implement US-001
			prd_001done,        // call 1: iter 1 fileReader (outcome check, passes:true for US-001)
			prd_001done,        // call 2: iter 2 top -> implement US-002
			prd_bothDone_noReview, // call 3: iter 2 fileReader (outcome check, passes:true for US-002)
			prd_bothDone_noReview, // call 4: iter 3 top -> review
			prd_bothDone_noReview, // call 5: after reviewDispatch, writePrd re-read
			prd_bothDone_clean, // call 6: iter 4 top -> complete
		];

		let prdCallCount = 0;
		let handoffIdx = 0;
		let paneIdx = 0;

		const handoffs = [
			makeHandoff('US-001'), // iter 1 outcome check
			makeHandoff('US-002'), // iter 2 outcome check
		];

		const paneTexts = [
			donePane('US-001'), // iter 1
			donePane('US-002'), // iter 2
		];

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCallCount++] ?? null,
			readHandoff: () => handoffs[handoffIdx++] ?? null,
			capturePane: (_paneId) => paneTexts[paneIdx++] ?? '',
			reviewDispatch: (_uuid, _channel) => ({ status: 'ok', detail: 'review dispatched' }),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(3); // 2 implement + 1 review
	});

	test('one story blocked: loop exits with blocked after 1 iteration', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => blockedPane('US-001'),
			// handoff: not needed because sentinel is BLOCKED
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(1);
		expect(result.lastOutcome?.kind).toBe('blocked');
	});

	test('max-iterations cap fires before completion', async () => {
		// Story never completes (unknown pane sentinel each time).
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => UNKNOWN_PANE,
			maxIterations: 3,
		});

		const result = await runSupervisor(opts);

		// unknown outcome exits blocked after 1 iteration (conservative)
		// so we expect blocked, not max-iterations in this scenario.
		// To test max-iterations, we need a scenario where iterations keep going.
		// Actually, unknown -> blocked exit on iteration 1. Let's test cap differently
		// by using a scenario that naturally keeps iterating (PRD_COMPLETE -> continue).
		expect(result.status).toBe('blocked');
	});

	test('max-iterations cap with PRD_COMPLETE cycling', async () => {
		// Each iteration returns PRD_COMPLETE (storyId undefined) then loop re-runs.
		// But decideNextAction on re-read will still see passes=false because we
		// never update the prd. Actually PRD_COMPLETE means 'continue' so the
		// loop keeps going and hits max cap.
		//
		// Simulate: readPrd always returns a story to implement, capturePane always
		// returns PRD_COMPLETE. The loop increments iterations but does not exit early.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => PRD_COMPLETE_PANE,
			maxIterations: 3,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('max-iterations');
		expect(result.iterations).toBe(3);
	});

	test('worker outcome fail -> blocked', async () => {
		// Sentinel DONE but handoff missing -> fail outcome
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		// Pane has DONE but readHandoff returns null -> fail
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => null, // triggers fail path in readWorkerOutcome
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(1);
		expect(result.lastOutcome?.kind).toBe('fail');
	});

	test('worker outcome unknown -> blocked', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => UNKNOWN_PANE,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(1);
		expect(result.lastOutcome?.kind).toBe('unknown');
	});

	test('review dispatch error -> blocked', async () => {
		// All stories pass, no review done yet -> dispatch review
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 0, lastVerdict: null },
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			reviewDispatch: (_uuid, _channel) => ({ status: 'error', detail: 'dispatch failed' }),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(1);
	});

	test('writeSessionMarker called with actualStoryId (not advisory)', async () => {
		// Advisory storyId from decideNextAction is US-001 (lowest priority pass=false).
		// But the worker actually completed US-002 (via sentinel + handoff).
		// writeSessionMarker must be called with US-002, not US-001.

		// Two stories: US-001 (priority 1, passes=false) and US-002 (priority 2, passes=false).
		// decideNextAction -> implement US-001 (advisory).
		// Worker actually completes US-002.

		const prdForDecide = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: false },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});

		// After worker: US-002 is now passes=true (the worker did US-002).
		const prdAfterWorker = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: false },
				{ id: 'US-002', priority: 2, passes: true },
			],
		});

		let prdCallCount = 0;

		const markerCalls: Array<{ storyId: string; uuid: string }> = [];
		const writeSessionMarker: WriteSessionMarker = (storyId, uuid) => {
			markerCalls.push({ storyId, uuid });
		};

		const opts = makeBaseOpts({
			readPrd: () => {
				// Call 0: top of iter (decideNextAction input)
				// Call 1+: inside fileReader (outcome check)
				prdCallCount++;
				return prdCallCount === 1 ? prdForDecide : prdAfterWorker;
			},
			readHandoff: () => makeHandoff('US-002'),
			capturePane: (_paneId) => donePane('US-002'),
			writeSessionMarker,
			maxIterations: 1, // stop after first pass; we just want to check the marker
		});

		const result = await runSupervisor(opts);

		// After 1 iteration the loop hits max-iterations (we set maxIterations=1).
		// But the marker should have been called with US-002.
		expect(markerCalls.length).toBe(1);
		expect(markerCalls[0]?.storyId).toBe('US-002');
	});

	test('PRD_COMPLETE sentinel continues loop; next iter complete', async () => {
		// Iter 1: story passes=false, capturePane returns PRD_COMPLETE -> continue.
		//   PRD_COMPLETE path in readWorkerOutcome returns immediately (no fileReader calls).
		//   So readPrd() is called exactly once in iter 1 (top of loop).
		// Iter 2: decideNextAction reads prd where all pass + review CLEAN -> complete.
		const prd1 = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		// After PRD_COMPLETE, on re-read PRD is all done.
		const prd2 = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCallCount++;
				// call 1: iter 1 top (prd1 has incomplete story -> implement decision)
				// call 2: iter 2 top (prd2 is all clean -> complete)
				if (prdCallCount <= 1) return prd1;
				return prd2;
			},
			capturePane: (_paneId) => PRD_COMPLETE_PANE,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1); // 1 implement iter + 0 (complete on next decision)
	});

	test('default MAX_ITERATIONS is 50', () => {
		expect(MAX_ITERATIONS).toBe(50);
	});

	test('spawn is called once per implement iteration', async () => {
		const prd1 = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prd2 = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCallCount++;
				if (prdCallCount <= 2) return prd1;
				return prd2;
			},
			readHandoff: () => makeHandoff('US-001'),
			capturePane: (_paneId) => donePane('US-001'),
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		await runSupervisor(opts);

		// One spawn call for the single implement iteration.
		expect(spawnCalls.length).toBe(1);
		// The spawn call should include respawn-pane and the worker pane id.
		const firstCall = spawnCalls[0] ?? [];
		expect(firstCall).toContain('respawn-pane');
		expect(firstCall).toContain(WORKER_PANE_ID);
	});
});
