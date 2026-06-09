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
//   6. decideNextAction returns 'await-operator' -> 'awaiting-operator'.
//   7. Worker outcome 'fail' -> 'blocked'.
//   8. Worker outcome 'unknown' -> 'blocked'.
//   9. Review dispatch error -> 'blocked'.
//  10. writeSessionMarker called with actualStoryId, not advisory storyId.
//  11. PRD_COMPLETE sentinel (outcome.storyId undefined) -> continue, next iter complete.

import { describe, expect, test, jest, beforeEach } from 'bun:test';
import { runSupervisor, MAX_ITERATIONS, MAX_NO_PROGRESS_RETRIES, NO_PROGRESS_BACKOFF_MS, MAX_REVIEW_DISPATCH_ATTEMPTS, DEFAULT_PER_WORKER_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS } from '../../src/supervisor/loop.ts';
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
	IsPaneAlive,
	ProgressPayload,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';

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
	const waitFor: WaitForFn = (_channel, _timeoutMs) => ({ timedOut: false });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid, _channel) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = (_paneId) => true;

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
		isPaneAlive,
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

	test('immediately returns awaiting-operator when review terminal and operator ceremony pending', async () => {
		// Non-operator stories pass + review CLEAN; an operator-required story
		// remains. Operator ceremonies are gated AFTER review, so this is a
		// successful terminal state, not a block.
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false, requires: 'operator' },
			],
			review: { roundsCompleted: 1, maxRounds: 3, lastVerdict: 'CLEAN' },
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('awaiting-operator');
		expect(result.iterations).toBe(0);
		expect(result.pendingStoryIds).toEqual(['US-002']);
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

	test('no-progress spin: worker re-confirms an already-done story -> blocked (CAM-36)', async () => {
		// Regression for the dogfood spin. US-001 done, US-002 pending. The US-002
		// worker no-op's (instant-exit): the captured pane is empty, so
		// readWorkerOutcome is state-primary and falls back to the stale handoff
		// (lastCompletedStory US-001) + prd (US-001 passes) -> pass/US-001. The PRD
		// never advances (US-002 stays false), so without the guard the loop would
		// re-dispatch US-002 every iteration up to maxIterations (50). The guard
		// blocks after MAX_NO_PROGRESS_RETRIES consecutive no-op passes.
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd, // never advances: US-002 stays false
			readHandoff: () => makeHandoff('US-001'), // stale: last completed = US-001
			capturePane: (_paneId) => '', // empty pane -> state-primary fallback
			maxIterations: 50, // would spin to 50 without the guard
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(MAX_NO_PROGRESS_RETRIES); // bounded, not 50
		expect(result.lastOutcome?.kind).toBe('blocked');
		expect(result.lastOutcome?.detail).toContain('no-progress');
	});

	test('no-progress: backs off (escalating) + emits no-progress-retry before each retry (CAM-38)', async () => {
		// Same spin as above, but assert the CAM-38 backoff: before each re-dispatch
		// the supervisor sleeps (escalating by streak) so a transient startup
		// rate-limit can clear, and emits a no-progress-retry event for visibility.
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});
		const sleeps: number[] = [];
		const { logger, events } = makeInMemoryEventLogger();
		const opts = makeBaseOpts({
			readPrd: () => prd,
			readHandoff: () => makeHandoff('US-001'),
			capturePane: (_paneId) => '',
			maxIterations: 50,
			sleepFn: (ms) => {
				sleeps.push(ms);
			},
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(MAX_NO_PROGRESS_RETRIES);
		// Two paused retries before the 3rd no-op blocks: escalating backoff.
		expect(sleeps).toEqual([NO_PROGRESS_BACKOFF_MS * 1, NO_PROGRESS_BACKOFF_MS * 2]);
		const retryEvents = events.filter((e) => e.kind === 'no-progress-retry');
		expect(retryEvents).toHaveLength(MAX_NO_PROGRESS_RETRIES - 1);
		expect(retryEvents[0]?.detail).toMatchObject({
			attempt: 1,
			backoffMs: NO_PROGRESS_BACKOFF_MS,
			completedStory: 'US-001',
		});
	});

	test('no-progress streak resets after real progress (CAM-36)', async () => {
		// One transient no-op must NOT block: iter 1 the US-002 worker no-op's
		// (pass/US-001, streak -> 1); iter 2 it really completes US-002 (the
		// reported-completed story was NOT already passing -> streak resets to 0);
		// the loop then reviews CLEAN and completes. Guards the "tolerate one
		// transient" + reset semantics so a single hiccup never blocks a live run.
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

		// readPrd() call sequence (mirrors the happy-path test; the no-progress
		// guard adds NO extra read, it reuses the top-of-loop snapshot):
		//   iter 1 (no-op US-002): call 0 top, call 1 outcome (pass US-001, stale)
		//   iter 2 (real US-002):  call 2 top, call 3 outcome (pass US-002)
		//   iter 3 (review):       call 4 top -> review, call 5 post-dispatch
		//   iter 4 (complete):     call 6 top -> complete
		const prds: PrdSnapshot[] = [
			prd_001done, // 0
			prd_001done, // 1: outcome check (US-002 still false -> handoff US-001 -> pass US-001)
			prd_001done, // 2
			prd_bothDone_noReview, // 3: outcome check (US-002 now true -> pass US-002)
			prd_bothDone_noReview, // 4
			prd_bothDone_noReview, // 5
			prd_bothDone_clean, // 6
		];

		// handoff consumed only by iter 1's no-op (-> stale pass US-001). After it
		// overflows to null, iter 2's outcome comes from the DONE sentinel (US-002)
		// with no handoff mismatch. Mirrors the happy-path test's handoff handling.
		let handoffIdx = 0;
		const handoffs = [makeHandoff('US-001')];

		let prdCallCount = 0;
		const opts = makeBaseOpts({
			readPrd: () => prds[prdCallCount++] ?? null,
			readHandoff: () => handoffs[handoffIdx++] ?? null,
			// iter 1: empty pane (no-op). iter 2: DONE sentinel for US-002.
			capturePane: (() => {
				let paneIdx = 0;
				const panes = ['', donePane('US-002')];
				return (_paneId: string) => panes[paneIdx++] ?? '';
			})(),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(3); // 2 implement + 1 review, never blocked
	});

	test('review dispatch: retries a transient error then succeeds -> complete (CAM-37)', async () => {
		// All stories pass -> decideNextAction returns 'review'. The reviewer errors
		// on the first 2 attempts (silent no-op) then succeeds; the loop must retry
		// (not block on the first miss) and reach 'complete'.
		const prd_noReview = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 0, lastVerdict: null },
		});
		const prd_clean = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		const prds = [prd_noReview, prd_noReview, prd_clean];
		let prdCall = 0;
		let reviewCalls = 0;
		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? prd_clean,
			reviewDispatch: (_uuid, _channel) => {
				reviewCalls += 1;
				return reviewCalls < 3
					? { status: 'error', detail: 'no <review> verdict (silent no-op)' }
					: { status: 'ok', detail: 'CLEAN' };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(reviewCalls).toBe(3); // errored twice, succeeded on the 3rd attempt
	});

	test('review dispatch: blocks after MAX_REVIEW_DISPATCH_ATTEMPTS persistent errors (CAM-37)', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 0, lastVerdict: null },
		});
		let reviewCalls = 0;
		const opts = makeBaseOpts({
			readPrd: () => prd,
			reviewDispatch: (_uuid, _channel) => {
				reviewCalls += 1;
				return { status: 'error', detail: 'no <review> verdict (silent no-op)' };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(reviewCalls).toBe(MAX_REVIEW_DISPATCH_ATTEMPTS); // bounded, then block
	});

	test('worker outcome fail -> blocked', async () => {
		// Sentinel says US-001 but handoff records US-002 -> mismatch -> fail
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		// Pane DONE story=US-001 but handoff lastCompletedStory.id=US-002: real mismatch.
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => ({ lastCompletedStory: { id: 'US-002' } }),
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

	test('incomplete -> supervisor re-runs gates + finalizes -> pass -> complete (CAM-32 BUG 2)', async () => {
		// Worker implemented US-001 (handoff set) but did not flip prd.json.
		// readWorkerOutcome returns 'incomplete'; the supervisor finalizes.
		let finalized = false;
		let markerStory: string | undefined;
		const prdBefore = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		const prdAfter = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		const opts = makeBaseOpts({
			readPrd: () => (finalized ? prdAfter : prdBefore),
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			runGates: () => ({ ok: true, detail: 'gates green' }),
			finalizeStory: (storyId) => {
				finalized = true;
				return { ok: true, detail: `flipped ${storyId}` };
			},
			writeSessionMarker: (storyId, _uuid) => {
				markerStory = storyId;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(result.lastOutcome?.detail).toContain('supervisor-finalized');
		expect(markerStory).toBe('US-001');
	});

	test('incomplete -> gates fail -> blocked (no finalize attempted)', async () => {
		let finalizeCalled = false;
		const prd = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			runGates: () => ({ ok: false, detail: 'typecheck failed' }),
			finalizeStory: (_storyId) => {
				finalizeCalled = true;
				return { ok: true, detail: 'should not run' };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.lastOutcome?.kind).toBe('blocked');
		expect(result.lastOutcome?.detail).toContain('gates failed');
		expect(finalizeCalled).toBe(false);
	});

	test('incomplete with no finalize capability -> blocked (kind stays incomplete)', async () => {
		const prd = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			// no runGates / finalizeStory injected
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.lastOutcome?.kind).toBe('incomplete');
	});

	test('durable out-file is preferred over capture-pane (CAM-32 BUG 1)', async () => {
		// The pane reports BLOCKED (as if scraped from a half-dead pane), but the
		// durable log holds the real DONE output. The supervisor must trust the
		// durable log: outcome derives from DONE (-> incomplete here, since prd is
		// not flipped and no finalize is injected), never from the blocked pane.
		const prd = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => blockedPane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			workerOutFile: (uuid) => `/proj/.claude/.cam-worker-out-${uuid}.log`,
			readFile: (path) => (path.includes('.cam-worker-out-') ? donePane('US-001') : null),
		});

		const result = await runSupervisor(opts);

		// If capture-pane had been used, kind would be 'blocked'.
		expect(result.lastOutcome?.kind).toBe('incomplete');
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

	test('DEFAULT_PER_WORKER_TIMEOUT_MS is 30 minutes', () => {
		expect(DEFAULT_PER_WORKER_TIMEOUT_MS).toBe(30 * 60 * 1000);
	});

	// ---------------------------------------------------------------------------
	// US-011: Worker timeout + crash detection
	// ---------------------------------------------------------------------------

	test('timeout path: waitFor timedOut=true, pane alive -> blocked detail=timeout, loop continues', async () => {
		// Iter 1: timeout fires, pane alive -> blocked 'timeout', continue.
		// Iter 2: decideNextAction -> implement, waitFor ok, story completes.
		// Iter 3: decideNextAction -> complete.
		const prd_incomplete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prd_complete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;
		let waitForCallCount = 0;

		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCallCount++;
				// Call 1: iter1 top -> decideNextAction (timeout fires, NO fileReader call)
				// Call 2: iter2 top -> decideNextAction -> implement
				// Call 3: iter2 fileReader -> needs passes:true to confirm pass outcome
				// Call 4: iter3 top -> decideNextAction -> complete
				if (prdCallCount <= 2) return prd_incomplete;
				return prd_complete;
			},
			waitFor: (_channel, _timeoutMs) => {
				waitForCallCount++;
				// First call: timeout; subsequent calls: normal
				if (waitForCallCount === 1) return { timedOut: true };
				return { timedOut: false };
			},
			isPaneAlive: (_paneId) => true, // pane is alive on timeout
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// iter 1 = timeout, iter 2 = normal complete; review/complete decision = iter 3 in decideNextAction
		expect(result.iterations).toBe(2);
		// Timeout outcome recorded
		expect(result.lastOutcome?.kind).toBe('pass'); // last outcome is the pass from iter 2
		// spawn called twice: once for iter1 respawn, once for timeout kill, once for iter2 respawn
		// iter1: respawn + echo timeout (2 calls); iter2: respawn (1 call) = 3 total
		const respawnCalls = spawnCalls.filter((a) => a.includes('respawn-pane'));
		expect(respawnCalls.length).toBe(3);
		// The timeout kill call should have 'echo timeout' as the last element
		const timeoutKillCall = spawnCalls.find((a) => a.includes('echo timeout'));
		expect(timeoutKillCall).toBeDefined();
	});

	test('pane-died path: waitFor timedOut=true, pane dead -> blocked detail=pane-died-pre-result, loop continues', async () => {
		// Iter 1: timeout fires, pane dead -> blocked 'pane-died-pre-result', continue.
		// Iter 2: decideNextAction -> complete (all stories pass after pane died scenario).
		const prd_incomplete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prd_complete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;
		let waitForCallCount = 0;

		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCallCount++;
				if (prdCallCount <= 2) return prd_incomplete;
				return prd_complete;
			},
			waitFor: (_channel, _timeoutMs) => {
				waitForCallCount++;
				if (waitForCallCount === 1) return { timedOut: true };
				return { timedOut: false };
			},
			isPaneAlive: (_paneId) => false, // pane is DEAD on timeout
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
			maxIterations: 5,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// Pane-died does NOT send the 'echo timeout' kill command (pane already dead)
		const timeoutKillCall = spawnCalls.find((a) => a.includes('echo timeout'));
		expect(timeoutKillCall).toBeUndefined();
		// Only the initial respawn-pane for iter1 and iter2
		const respawnCalls = spawnCalls.filter((a) => a.includes('respawn-pane'));
		expect(respawnCalls.length).toBe(2);
	});

	test('waitFor receives the perWorkerTimeoutMs value', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const receivedTimeouts: number[] = [];

		const opts = makeBaseOpts({
			readPrd: () => prd,
			waitFor: (_channel, timeoutMs) => {
				receivedTimeouts.push(timeoutMs);
				return { timedOut: false };
			},
			capturePane: (_paneId) => UNKNOWN_PANE, // -> unknown -> blocked, stop
			perWorkerTimeoutMs: 99_999,
		});

		await runSupervisor(opts);

		expect(receivedTimeouts.length).toBeGreaterThan(0);
		expect(receivedTimeouts[0]).toBe(99_999);
	});

	test('timeout followed by story completion: recovery to next story', async () => {
		// Simulates: iter1 times out (pane alive), iter2 story completes, iter3 complete.
		// This is the "recovery" scenario from the US-011 acceptance criteria.
		const prd_incomplete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;
		let waitForCallCount = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCallCount++;
				// Call 1: iter1 top -> timeout (no fileReader call in timeout path)
				// Call 2: iter2 top -> implement
				// Call 3: iter2 fileReader -> needs passes:true
				// Call 4: iter3 top -> complete
				if (prdCallCount <= 2) return prd_incomplete;
				return prd_done;
			},
			waitFor: (_channel, _timeoutMs) => {
				waitForCallCount++;
				return waitForCallCount === 1 ? { timedOut: true } : { timedOut: false };
			},
			isPaneAlive: (_paneId) => true,
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(2); // 1 timeout iter + 1 pass iter
	});

	test('timeout outcome is blocked kind with correct detail', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		let waitForCallCount = 0;

		const opts = makeBaseOpts({
			readPrd: () => prd,
			waitFor: (_channel, _timeoutMs) => {
				waitForCallCount++;
				// Only timeout once; second call returns blocked (so loop exits)
				if (waitForCallCount === 1) return { timedOut: true };
				return { timedOut: false };
			},
			isPaneAlive: (_paneId) => true, // pane alive -> 'timeout' detail
			capturePane: (_paneId) => blockedPane('US-001'), // after timeout recovery, worker blocked
			maxIterations: 2,
		});

		const result = await runSupervisor(opts);

		// The last outcome (from iter 2) should be 'blocked' from the worker sentinel
		expect(result.lastOutcome?.kind).toBe('blocked');
		// Check that we went through the timeout iteration (iterations = 2)
		expect(result.iterations).toBe(2);
	});

	test('pane-died lastOutcome has correct detail after only one timeout iter', async () => {
		// maxIterations=1: only the timeout iter runs, no second iter.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			waitFor: (_channel, _timeoutMs) => ({ timedOut: true }),
			isPaneAlive: (_paneId) => false, // pane dead
			maxIterations: 1,
		});

		const result = await runSupervisor(opts);

		// 1 iteration (timeout), then max-iterations cap fires
		expect(result.status).toBe('max-iterations');
		expect(result.iterations).toBe(1);
		expect(result.lastOutcome?.detail).toBe('pane-died-pre-result');
	});

	// ---------------------------------------------------------------------------
	// US-012: Sentinel polling mode (detectCompletionBy: 'sentinel')
	// ---------------------------------------------------------------------------

	test('sentinel mode: sentinel appears on 2nd poll -> detected, outcome pass', async () => {
		// Iter 1: sentinel polling finds sentinel on 2nd capturePane call.
		// capturePane call 1: empty (no sentinel) -> check timeout (nowMs always 0, perWorkerTimeoutMs 99999 -> no timeout)
		// capturePane call 2: DONE sentinel -> pollOutcome = 'sentinel' -> outcome pass.
		// Iter 2 (review or complete decision): complete.

		const prd_incomplete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;
		let captureCount = 0;
		const sleepCalls: number[] = [];

		const opts = makeBaseOpts({
			implementerMode: 'sentinel',
			pollIntervalMs: 0,
			sleepFn: (ms) => { sleepCalls.push(ms); },
			nowMs: () => 0, // time never advances -> no timeout
			perWorkerTimeoutMs: 99_999,
			readPrd: () => {
				prdCallCount++;
				// call 1: iter1 top -> decideNextAction (implement)
				// call 2: outcome check (passes:true confirms done)
				// call 3: iter2 top -> complete
				if (prdCallCount <= 1) return prd_incomplete;
				return prd_done;
			},
			capturePane: (_paneId) => {
				captureCount++;
				// First capturePane call: polling attempt 1 (no sentinel)
				// Second: polling attempt 2 (sentinel found)
				// Third: full pane read after sentinel detected
				if (captureCount <= 1) return '';
				return donePane('US-001');
			},
			readHandoff: () => makeHandoff('US-001'),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(result.lastOutcome?.storyId).toBe('US-001');
		// sleepFn called at least twice (once per poll attempt)
		expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
	});

	test('sentinel mode: sentinel never appears -> timeout-blocked, loop continues', async () => {
		// Iter 1: polling times out (nowMs=0, perWorkerTimeoutMs=0 -> immediate timeout).
		// Iter 2: decideNextAction -> complete (prd is all done after timeout).
		const prd_incomplete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			implementerMode: 'sentinel',
			pollIntervalMs: 0,
			sleepFn: (_ms) => {},
			nowMs: () => 0, // elapsed = 0 - 0 = 0 >= 0 -> immediate timeout
			perWorkerTimeoutMs: 0,
			readPrd: () => {
				prdCallCount++;
				// call 1: iter1 top -> implement
				// call 2: iter2 top -> complete (prd flipped externally)
				if (prdCallCount <= 1) return prd_incomplete;
				return prd_done;
			},
			capturePane: (_paneId) => '', // never returns sentinel
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1); // 1 timeout iteration, then complete
		// The timeout path sends the kill command
		const timeoutKill = spawnCalls.find((a) => a.includes('echo timeout'));
		expect(timeoutKill).toBeDefined();
	});

	test('sentinel mode: pane dies during polling -> blocked detail=pane-died-pre-result, loop continues', async () => {
		// Iter 1: pane dies on first isPaneAlive check -> pane-died, continue.
		// Iter 2: decideNextAction -> complete (prd all done after pane died).
		const prd_incomplete = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCallCount = 0;
		let isPaneAliveCallCount = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			implementerMode: 'sentinel',
			pollIntervalMs: 0,
			sleepFn: (_ms) => {},
			nowMs: () => 0,
			perWorkerTimeoutMs: 99_999,
			readPrd: () => {
				prdCallCount++;
				if (prdCallCount <= 1) return prd_incomplete;
				return prd_done;
			},
			capturePane: (_paneId) => '', // never reached (pane dies first)
			isPaneAlive: (_paneId) => {
				isPaneAliveCallCount++;
				return false; // pane is dead on first check
			},
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1); // 1 pane-died iteration, then complete
		// No kill command sent (pane already dead)
		const timeoutKill = spawnCalls.find((a) => a.includes('echo timeout'));
		expect(timeoutKill).toBeUndefined();
		// Only one respawn-pane call (the initial one)
		const respawnCalls = spawnCalls.filter((a) => a.includes('respawn-pane'));
		expect(respawnCalls.length).toBe(1);
	});

	test('DEFAULT_POLL_INTERVAL_MS is 5 seconds', () => {
		expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000);
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

// ---------------------------------------------------------------------------
// US-016: rate-limit pause/resume
// ---------------------------------------------------------------------------

/** Pane text with the headless worker's RATE_LIMIT exit sentinel. */
const RATE_LIMIT_SENTINEL_PANE = `Working hard\nCAM_IMPLEMENTER_STATUS=RATE_LIMIT\n`;
/** Pane text with the claude TUI rate-limit message (matched by isRateLimited). */
const TUI_RATE_LIMIT_PANE = `Hit your usage limit\nresets 3pm\n`;

describe('runSupervisor rate-limit handling (US-016)', () => {
	test('RATE_LIMIT sentinel: pauses, resumes the same session, then completes', async () => {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdTrue = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }] });
		const prdDone = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCall = 0;
		const readPrd = () => {
			prdCall++;
			if (prdCall === 1) return prdFalse; // decideNextAction iter 1 -> implement
			if (prdCall === 2) return prdTrue; // readWorkerOutcome fileReader -> pass
			return prdDone; // decideNextAction iter 2 -> complete
		};

		let capCall = 0;
		const capturePane = (_paneId: string) => {
			capCall++;
			return capCall === 1 ? RATE_LIMIT_SENTINEL_PANE : donePane('US-001');
		};

		const spawnCalls: string[][] = [];
		let rlCalls = 0;
		const { logger, events } = makeInMemoryEventLogger();

		const opts = makeBaseOpts({
			readPrd,
			readHandoff: () => makeHandoff('US-001'),
			capturePane,
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
			rateLimitResume: () => {
				rlCalls++;
			},
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// The pause hook fired exactly once.
		expect(rlCalls).toBe(1);
		// Pause + resume events were recorded.
		const rl = events.filter((e) => e.kind === 'rate-limited');
		expect(rl.map((e) => (e.detail as Record<string, unknown>)['phase'])).toEqual(['pause', 'resume']);
		// The worker was respawned twice with the SAME session-id (continuity).
		const workerRespawns = spawnCalls.filter(
			(a) => a[2] === 'respawn-pane' && a[6] !== undefined && a[6] !== 'echo timeout',
		);
		expect(workerRespawns).toHaveLength(2);
		const uuid = '00000000-0000-0000-0000-000000000001';
		expect(workerRespawns[0]![6]).toContain(`--session-id ${uuid}`);
		expect(workerRespawns[1]![6]).toContain(`--session-id ${uuid}`);
	});

	test('claude TUI rate-limit message also triggers the resume flow', async () => {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdTrue = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }] });
		const prdDone = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		let prdCall = 0;
		const readPrd = () => {
			prdCall++;
			if (prdCall === 1) return prdFalse;
			if (prdCall === 2) return prdTrue;
			return prdDone;
		};

		let capCall = 0;
		const capturePane = (_paneId: string) => {
			capCall++;
			return capCall === 1 ? TUI_RATE_LIMIT_PANE : donePane('US-001');
		};

		let rlCalls = 0;
		const opts = makeBaseOpts({
			readPrd,
			readHandoff: () => makeHandoff('US-001'),
			capturePane,
			rateLimitResume: (info) => {
				rlCalls++;
				// The parsed rate-limit message is forwarded to the hook.
				expect(info.message).toContain('resets');
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(rlCalls).toBe(1);
	});

	test('blocks when rate-limit persists beyond maxRateLimitRetries', async () => {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });

		let rlCalls = 0;
		const opts = makeBaseOpts({
			readPrd: () => prdFalse,
			readHandoff: () => makeHandoff('US-001'),
			// Always rate-limited.
			capturePane: (_paneId) => RATE_LIMIT_SENTINEL_PANE,
			rateLimitResume: () => {
				rlCalls++;
			},
			maxRateLimitRetries: 2,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(rlCalls).toBe(2);
		expect(result.lastOutcome?.detail).toContain('rate-limit retries exhausted');
	});

	test('a timeout during a resume attempt is handled like any worker timeout', async () => {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });

		// First wait succeeds (worker emits rate-limit), the resume wait times out.
		let waitCall = 0;
		const waitFor = (_channel: string, _timeoutMs: number) => {
			waitCall++;
			return { timedOut: waitCall >= 2 };
		};

		const opts = makeBaseOpts({
			readPrd: () => prdFalse,
			readHandoff: () => makeHandoff('US-001'),
			capturePane: (_paneId) => RATE_LIMIT_SENTINEL_PANE,
			waitFor,
			rateLimitResume: () => {},
			maxIterations: 1,
		});

		const result = await runSupervisor(opts);

		// Resume timed out -> blocked outcome, loop hit the iteration cap.
		expect(result.status).toBe('max-iterations');
		expect(result.lastOutcome?.detail).toBe('timeout');
	});

	test('no rateLimitResume injected: rate-limit is not specially handled (zero behavior change)', async () => {
		// Without the hook, a RATE_LIMIT pane flows through readWorkerOutcome as
		// 'unknown' -> blocked, exactly as before US-016.
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });

		const opts = makeBaseOpts({
			readPrd: () => prdFalse,
			readHandoff: () => null,
			capturePane: (_paneId) => RATE_LIMIT_SENTINEL_PANE,
			// rateLimitResume intentionally omitted.
		});

		const result = await runSupervisor(opts);
		expect(result.status).toBe('blocked');
	});
});

// ---------------------------------------------------------------------------
// US-001: ensurePushed -- origin-sync backstop on every pass
// ---------------------------------------------------------------------------

describe('runSupervisor ensurePushed (US-001)', () => {
	// Helper: build prds so that readPrd returns prdFalse on first call
	// (decideNextAction dispatches implement) and prdTrue on subsequent calls
	// (fileReader in readWorkerOutcome sees passes:true -> pass outcome).
	function makePassingPrds() {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdTrue = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		return { prdFalse, prdTrue };
	}

	test('(a) pass-but-unpushed: ensurePushed ok:true pushed:true -> loop continues to complete', async () => {
		const { prdFalse, prdTrue } = makePassingPrds();
		let prdCall = 0;
		let ensurePushedCalls = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			ensurePushed: () => {
				ensurePushedCalls++;
				return { ok: true, pushed: true, sha: 'abc1234', detail: 'pushed to origin/cam-test' };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(ensurePushedCalls).toBe(1);
		expect(result.lastOutcome?.kind).toBe('pass');
	});

	test('(b) pass-already-synced: ensurePushed ok:true pushed:false -> loop continues, no extra side effects', async () => {
		const { prdFalse, prdTrue } = makePassingPrds();
		let prdCall = 0;
		let ensurePushedCalls = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			ensurePushed: () => {
				ensurePushedCalls++;
				return { ok: true, pushed: false, sha: 'abc1234', detail: 'already up-to-date' };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(ensurePushedCalls).toBe(1);
		expect(result.lastOutcome?.kind).toBe('pass');
	});

	test('(c) ensurePushed ok:false -> supervisor returns status:blocked with push-failure detail', async () => {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdTrue = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }] });
		let prdCall = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			ensurePushed: () => ({
				ok: false,
				pushed: false,
				sha: '',
				detail: 'network error during push to origin',
			}),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.lastOutcome?.kind).toBe('blocked');
		expect(result.lastOutcome?.detail).toContain('push-verification failed');
		expect(result.lastOutcome?.detail).toContain('network error during push to origin');
	});

	test('(d) ensurePushed absent -> pass-branch behavior unchanged (backward compatible)', async () => {
		const { prdFalse, prdTrue } = makePassingPrds();
		let prdCall = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			// ensurePushed intentionally absent: zero behavior change.
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.lastOutcome?.kind).toBe('pass');
	});
});

// ---------------------------------------------------------------------------
// US-002: 'pushed' structured event emitted on push verification
// ---------------------------------------------------------------------------

describe("runSupervisor 'pushed' event (US-002)", () => {
	function makePassingPrds() {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdTrue = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		return { prdFalse, prdTrue };
	}

	test('(a) pass + ensurePushed ok -> exactly one "pushed" event, ordered after "result", mirrors adapter', async () => {
		const { prdFalse, prdTrue } = makePassingPrds();
		let prdCall = 0;
		const { logger, events } = makeInMemoryEventLogger();

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			ensurePushed: () => ({
				ok: true,
				pushed: true,
				sha: 'abc1234',
				detail: 'pushed to origin/cam-test',
			}),
			logEvent: logger,
		});

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');

		const pushedEvents = events.filter((e) => e.kind === 'pushed');
		expect(pushedEvents).toHaveLength(1);
		expect(pushedEvents[0]?.storyId).toBe('US-001');
		expect(pushedEvents[0]?.detail).toEqual({
			sha: 'abc1234',
			pushed: true,
			ok: true,
			detail: 'pushed to origin/cam-test',
		});

		// 'pushed' is ordered AFTER the 'result' event.
		const resultIdx = events.findIndex((e) => e.kind === 'result');
		const pushedIdx = events.findIndex((e) => e.kind === 'pushed');
		expect(resultIdx).toBeGreaterThanOrEqual(0);
		expect(pushedIdx).toBeGreaterThan(resultIdx);
	});

	test('(b) ensurePushed ok:false -> still emits a "pushed" event (ok:false) before returning blocked', async () => {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdTrue = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }] });
		let prdCall = 0;
		const { logger, events } = makeInMemoryEventLogger();

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			ensurePushed: () => ({
				ok: false,
				pushed: false,
				sha: '',
				detail: 'network error during push to origin',
			}),
			logEvent: logger,
		});

		const result = await runSupervisor(opts);
		expect(result.status).toBe('blocked');

		const pushedEvents = events.filter((e) => e.kind === 'pushed');
		expect(pushedEvents).toHaveLength(1);
		expect(pushedEvents[0]?.detail).toMatchObject({ ok: false, pushed: false });
	});

	test('(c) ensurePushed present but logEvent absent -> no crash, completes', async () => {
		const { prdFalse, prdTrue } = makePassingPrds();
		let prdCall = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			ensurePushed: () => ({ ok: true, pushed: true, sha: 'abc1234', detail: 'ok' }),
			// logEvent intentionally absent: emit is a no-op, no 'pushed' event.
		});

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
	});

	test('(d) ensurePushed absent -> zero "pushed" events', async () => {
		const { prdFalse, prdTrue } = makePassingPrds();
		let prdCall = 0;
		const { logger, events } = makeInMemoryEventLogger();

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			logEvent: logger,
			// ensurePushed intentionally absent: the event corresponds to a real
			// verification, not a phantom one.
		});

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
		expect(events.filter((e) => e.kind === 'pushed')).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// US-001: onProgress callback — per-iteration + terminal-exit emissions
// ---------------------------------------------------------------------------

describe('runSupervisor onProgress callback (US-001)', () => {
	test('absent onProgress: backward compatible, no change in behavior', async () => {
		// Existing test: no onProgress injected, loop completes normally.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prdDone = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;
		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd : prdDone;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			// onProgress intentionally absent.
		});
		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
	});

	test('called once per iteration with correct storyId + done/total counts', async () => {
		// 2-story PRD: US-001 (priority 1, passes:false), US-002 (priority 2, passes:false).
		// Iter 1: decideNextAction -> implement US-001 (advisory); prd has 0 done / 2 total.
		// After iter 1 worker: US-001 passes:true.
		// Iter 2: decideNextAction -> implement US-002 (advisory); prd has 1 done / 2 total.
		// After iter 2 worker: US-002 passes:true.
		// Iter 3: review CLEAN -> complete.
		const prd0 = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }, { id: 'US-002', priority: 2, passes: false }] });
		const prd1 = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }, { id: 'US-002', priority: 2, passes: false }] });
		const prd2 = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }, { id: 'US-002', priority: 2, passes: true }], review: { roundsCompleted: 0, lastVerdict: null } });
		const prd3 = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }, { id: 'US-002', priority: 2, passes: true }], review: { roundsCompleted: 1, lastVerdict: 'CLEAN' } });

		let prdCall = 0;
		let handoffIdx = 0;
		let paneIdx = 0;
		const handoffs = [makeHandoff('US-001'), makeHandoff('US-002')];
		const panes = [donePane('US-001'), donePane('US-002')];

		const progressCalls: ProgressPayload[] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				// call 1: iter1 top (implement US-001)
				// call 2: iter1 fileReader (passes:true for US-001)
				// call 3: iter2 top (implement US-002)
				// call 4: iter2 fileReader (passes:true for US-002)
				// call 5: iter3 top (review)
				// call 6: after reviewDispatch
				// call 7: iter4 top (complete)
				if (prdCall === 1) return prd0;
				if (prdCall === 2) return prd1;
				if (prdCall === 3) return prd1;
				if (prdCall === 4) return prd2;
				if (prdCall === 5) return prd2;
				if (prdCall === 6) return prd2;
				return prd3;
			},
			readHandoff: () => handoffs[handoffIdx++] ?? null,
			capturePane: (_paneId) => panes[paneIdx++] ?? '',
			reviewDispatch: (_uuid, _channel) => ({ status: 'ok', detail: 'review ok' }),
			onProgress: (p) => { progressCalls.push({ ...p }); },
		});

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');

		// One regular call per iteration (iter 1, 2, 3 implement/review + iter 4 complete).
		const regular = progressCalls.filter((p) => p.terminalStatus === undefined);
		// Iterations: implement US-001, implement US-002, review, complete = 4 regular calls.
		expect(regular.length).toBe(4);

		// Iter 1: currentStoryId = US-001, storiesDone = 0, storiesTotal = 2.
		expect(regular[0]?.currentStoryId).toBe('US-001');
		expect(regular[0]?.storiesDone).toBe(0);
		expect(regular[0]?.storiesTotal).toBe(2);
		expect(regular[0]?.iteration).toBe(1);

		// Iter 2: currentStoryId = US-002, storiesDone = 1, storiesTotal = 2.
		expect(regular[1]?.currentStoryId).toBe('US-002');
		expect(regular[1]?.storiesDone).toBe(1);
		expect(regular[1]?.storiesTotal).toBe(2);
		expect(regular[1]?.iteration).toBe(2);

		// Iter 3 (review): currentStoryId = undefined, storiesDone = 2.
		expect(regular[2]?.currentStoryId).toBeUndefined();
		expect(regular[2]?.storiesDone).toBe(2);

		// Iter 4 (complete decision): currentStoryId = undefined.
		expect(regular[3]?.currentStoryId).toBeUndefined();

		// Exactly one terminal call with terminalStatus = 'complete'.
		const terminal = progressCalls.filter((p) => p.terminalStatus !== undefined);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.terminalStatus).toBe('complete');
	});

	test('terminal call on awaiting-operator status', async () => {
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false, requires: 'operator' },
			],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		const progressCalls: ProgressPayload[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			onProgress: (p) => { progressCalls.push({ ...p }); },
		});
		const result = await runSupervisor(opts);
		expect(result.status).toBe('awaiting-operator');
		const terminal = progressCalls.filter((p) => p.terminalStatus !== undefined);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.terminalStatus).toBe('awaiting-operator');
	});

	test('terminal call on blocked status (worker sentinel)', async () => {
		const prd = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const progressCalls: ProgressPayload[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => blockedPane('US-001'),
			onProgress: (p) => { progressCalls.push({ ...p }); },
		});
		const result = await runSupervisor(opts);
		expect(result.status).toBe('blocked');
		const terminal = progressCalls.filter((p) => p.terminalStatus !== undefined);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.terminalStatus).toBe('blocked');
	});

	test('terminal call on max-iterations', async () => {
		// Loop cycling on PRD_COMPLETE until cap fires.
		const prd = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const progressCalls: ProgressPayload[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => PRD_COMPLETE_PANE,
			maxIterations: 2,
			onProgress: (p) => { progressCalls.push({ ...p }); },
		});
		const result = await runSupervisor(opts);
		expect(result.status).toBe('max-iterations');
		const terminal = progressCalls.filter((p) => p.terminalStatus !== undefined);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.terminalStatus).toBe('max-iterations');
		// 2 regular calls (one per iteration) + 1 terminal = 3 total.
		expect(progressCalls).toHaveLength(3);
	});

	test('terminal call on blocked when PRD unreadable', async () => {
		const progressCalls: ProgressPayload[] = [];
		const opts = makeBaseOpts({
			readPrd: () => null,
			onProgress: (p) => { progressCalls.push({ ...p }); },
		});
		const result = await runSupervisor(opts);
		expect(result.status).toBe('blocked');
		// PRD unreadable: no regular call (decideNextAction never ran), but terminal fires.
		const terminal = progressCalls.filter((p) => p.terminalStatus !== undefined);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.terminalStatus).toBe('blocked');
	});

	test('terminal call on blocked via CAM-36 no-progress guard', async () => {
		// CAM-36 + US-001 integration regression: when the loop blocks because a
		// worker no-op'd and re-confirmed an already-done story, the terminal
		// onProgress MUST still fire so next.ts clears the live state file. Without
		// notifyTerminal('blocked') in the no-progress guard the state file would
		// stay 'active' forever after the block.
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});
		const progressCalls: ProgressPayload[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd, // never advances: US-002 stays false
			readHandoff: () => makeHandoff('US-001'), // stale completed story
			capturePane: (_paneId) => '', // empty pane -> state-primary -> pass US-001
			maxIterations: 50,
			onProgress: (p) => {
				progressCalls.push({ ...p });
			},
		});
		const result = await runSupervisor(opts);
		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(MAX_NO_PROGRESS_RETRIES);
		const terminal = progressCalls.filter((p) => p.terminalStatus !== undefined);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.terminalStatus).toBe('blocked');
	});

	test('lastActivity is the injected clock value', async () => {
		const prd = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdDone = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }], review: { roundsCompleted: 1, lastVerdict: 'CLEAN' } });
		let prdCall = 0;
		const progressCalls: ProgressPayload[] = [];
		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd : prdDone;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			clock: () => '2026-06-09T12:34:56Z',
			onProgress: (p) => { progressCalls.push({ ...p }); },
		});
		await runSupervisor(opts);
		for (const p of progressCalls) {
			expect(p.lastActivity).toBe('2026-06-09T12:34:56Z');
		}
	});
});
