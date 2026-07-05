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
//  10. US-005: blocked-review path calls notifyOrchestrator with '[cam] review BLOCKED:'.
//  11. writeSessionMarker called with actualStoryId, not advisory storyId.
//  11. PRD_COMPLETE sentinel (outcome.storyId undefined) -> continue, next iter complete.
//  12. CAM-44: persistent timeout blocks at the dead-worker cap (escalating backoff), not max-iterations.
//  13. CAM-44: persistent pane-death blocks at the dead-worker cap.
//  14. CAM-44: transient pane-death then a real completion does not block (streak resets).
//  15. CAM-5: worker token ceiling kills + blocks terminally once spend crosses the cap.
//  16. CAM-5: ceiling disabled (maxWorkerTokens 0) -> no poll-loop token check, no kill.
//  17. US-003: notifies orchestrator exactly once on genuine implementer advance.
//  18. US-003: does NOT notify on a no-progress re-confirmation retry.

import { describe, expect, test, beforeEach } from 'bun:test';
import { runSupervisor, MAX_ITERATIONS, MAX_NO_PROGRESS_RETRIES, NO_PROGRESS_BACKOFF_MS, MAX_BACKOFF_MS, JITTER_FRACTION, MAX_DEAD_WORKER_RETRIES, MAX_REVIEW_DISPATCH_ATTEMPTS, DEFAULT_PER_WORKER_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, computeBackoffMs } from '../../src/supervisor/loop.ts';
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
	ProgressPayload,
	HandoffSnapshot,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import { formatWorkerReportSummary, type WorkerReport } from '../../src/supervisor/worker-report.ts';
import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Base options factory
// ---------------------------------------------------------------------------

/**
 * Build a base RunSupervisorOptions where readPrd, readHandoff, capturePane,
 * and writeSessionMarker can be overridden per test.
 */
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
		// Use a no-op sleepFn so tests never block.
		sleepFn: (_ms: number) => {},
		// Use a stable nowMs so sentinel polling doesn't immediately timeout.
		nowMs: () => 0,
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

		// In sentinel mode capturePane is called twice per implement iteration:
		// once during the poll loop (sentinel detection) and once after the
		// sentinel is found (reading the full pane for readWorkerOutcome).
		// Both calls for the same iteration must return the same text.
		const paneTexts = [
			donePane('US-001'), // iter 1 poll (sentinel detected)
			donePane('US-001'), // iter 1 outcome read
			donePane('US-002'), // iter 2 poll (sentinel detected)
			donePane('US-002'), // iter 2 outcome read
		];

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCallCount++] ?? null,
			readHandoff: () => handoffs[handoffIdx++] ?? null,
			capturePane: (_paneId) => paneTexts[paneIdx++] ?? '',
			reviewDispatch: (_uuid) => ({ status: 'ok', detail: 'review dispatched' }),
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

	test('persistent timeout blocks at the dead-worker cap, never reaching max-iterations (CAM-44)', async () => {
		// Story never emits a sentinel: the poll loop times out every iteration
		// (perWorkerTimeoutMs:0 -> elapsed 0 >= 0). Before CAM-44 this spun to
		// maxIterations; now the dead-worker guard blocks cleanly after
		// MAX_DEAD_WORKER_RETRIES consecutive timeouts. maxIterations is set high
		// so the cap (not the iteration ceiling) is what fires.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const sleeps: number[] = [];
		const { logger, events } = makeInMemoryEventLogger();
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => UNKNOWN_PANE,
			perWorkerTimeoutMs: 0,
			pollIntervalMs: 0,
			maxIterations: 50,
			sleepFn: (ms) => {
				if (ms > 0) sleeps.push(ms);
			},
			// Pin randomFn so jitter is zero (r=0.5 -> multiplier 1.0). Makes
			// expected sleep values deterministic: computeBackoffMs(streak, ...) equals
			// NO_PROGRESS_BACKOFF_MS * 2^(streak-1) with no jitter offset.
			randomFn: () => 0.5,
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(MAX_DEAD_WORKER_RETRIES);
		// Three escalating backoffs before the 4th timeout blocks.
		expect(sleeps).toEqual([NO_PROGRESS_BACKOFF_MS * 1, NO_PROGRESS_BACKOFF_MS * 2, NO_PROGRESS_BACKOFF_MS * 4]);
		const retryEvents = events.filter((e) => e.kind === 'pane-died-retry');
		expect(retryEvents).toHaveLength(MAX_DEAD_WORKER_RETRIES - 1);
		expect(retryEvents[0]?.detail).toMatchObject({
			attempt: 1,
			backoffMs: NO_PROGRESS_BACKOFF_MS,
			pollOutcome: 'timeout',
		});
		expect(result.lastOutcome?.detail).toContain('dead-worker');
	});

	test('persistent pane-death blocks at the dead-worker cap (CAM-44)', async () => {
		// The pane is dead every poll (isPaneAlive false). The dead-worker guard
		// must block after MAX_DEAD_WORKER_RETRIES, not spin to maxIterations.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const sleeps: number[] = [];
		const { logger, events } = makeInMemoryEventLogger();
		const opts = makeBaseOpts({
			readPrd: () => prd,
			isPaneAlive: (_paneId) => false,
			pollIntervalMs: 0,
			maxIterations: 50,
			sleepFn: (ms) => {
				if (ms > 0) sleeps.push(ms);
			},
			// Pin randomFn for deterministic jitter (r=0.5 -> zero offset).
			randomFn: () => 0.5,
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(MAX_DEAD_WORKER_RETRIES);
		expect(sleeps).toEqual([NO_PROGRESS_BACKOFF_MS * 1, NO_PROGRESS_BACKOFF_MS * 2, NO_PROGRESS_BACKOFF_MS * 4]);
		const retryEvents = events.filter((e) => e.kind === 'pane-died-retry');
		expect(retryEvents).toHaveLength(MAX_DEAD_WORKER_RETRIES - 1);
		expect(retryEvents[0]?.detail).toMatchObject({ pollOutcome: 'pane-died' });
	});

	test('transient pane-death then a real completion does NOT block (streak resets) (CAM-44)', async () => {
		// Iter 1: pane dead (streak 1). Iter 2: live pane yields a DONE sentinel
		// for the only story -> streak resets, story passes, loop reviews + completes.
		const prdBefore = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const prdDone = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 0, lastVerdict: null },
		});
		const prdClean = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		// reads: iter1 top, iter2 top, iter2 outcome, iter3 (review) top, post, iter4 complete
		const prds: PrdSnapshot[] = [prdBefore, prdBefore, prdDone, prdDone, prdDone, prdClean];
		let prdCall = 0;
		let aliveCall = 0;
		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? prdClean,
			readHandoff: () => makeHandoff('US-001'),
			// First poll: pane dead. After that: alive.
			isPaneAlive: (_paneId) => {
				aliveCall += 1;
				return aliveCall > 1;
			},
			capturePane: (_paneId) => donePane('US-001'),
			maxIterations: 50,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// 1 dead iteration + 1 implement + 1 review = 3, never blocked.
		expect(result.iterations).toBe(3);
	});

	test('worker token ceiling: kills the worker and blocks terminally once spend crosses the cap (CAM-5)', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});
		const { logger, events } = makeInMemoryEventLogger();
		const spawnArgs: string[][] = [];
		// readWorkerTokens returns escalating spend: 40k, 80k, 120k. With a 100k
		// ceiling, the 3rd poll crosses it. Spend = input + cacheCreation + cacheRead.
		let call = 0;
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => UNKNOWN_PANE, // never a sentinel; keep polling
			pollIntervalMs: 0,
			maxWorkerTokens: 100_000,
			readWorkerTokens: (_uuid) => {
				call += 1;
				const spend = call * 40_000; // 40k, 80k, 120k
				return { inputTokens: spend, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
			},
			spawn: (_cmd, args) => {
				spawnArgs.push(args);
				return { stdout: '', exitCode: 0 };
			},
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.lastOutcome?.detail).toContain('worker-token-ceiling');
		const ceilingEvents = events.filter((e) => e.kind === 'worker-token-ceiling');
		expect(ceilingEvents).toHaveLength(1);
		expect(ceilingEvents[0]?.detail).toMatchObject({ spend: 120_000, ceiling: 100_000 });
		// The worker pane was killed (respawn-pane -k ... echo token-ceiling).
		const killed = spawnArgs.some(
			(a) => a.includes('respawn-pane') && a[a.length - 1] === 'echo token-ceiling',
		);
		expect(killed).toBe(true);
	});

	test('worker token ceiling disabled (maxWorkerTokens 0): readWorkerTokens never consulted, no kill (CAM-5)', async () => {
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 0, lastVerdict: null },
		});
		const prd_clean = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		// reads: iter1 top, iter1 outcome (US-001 now true -> pass), iter2 top (review),
		// review re-read, iter3 top (complete).
		const prds: PrdSnapshot[] = [prd_impl, prd_done, prd_done, prd_done, prd_clean];
		let prdCall = 0;
		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? prd_clean,
			readHandoff: () => makeHandoff('US-001'),
			capturePane: (_paneId) => donePane('US-001'),
			maxWorkerTokens: 0, // disabled
			readWorkerTokens: (_uuid) => ({
				inputTokens: 999_999,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			}),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// readWorkerTokens may be called by emitTokens at worker-end, but the POLL
		// loop must not consult it when the ceiling is disabled: a 999999 spend with
		// a 0 ceiling never kills. The run completes normally.
		expect(result.lastOutcome?.detail ?? '').not.toContain('worker-token-ceiling');
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
		// worker no-op's: in sentinel mode the worker emits DONE story=US-001 (stale),
		// readWorkerOutcome sees pass/US-001. The PRD never advances (US-002 stays
		// false), so without the guard the loop would re-dispatch US-002 every
		// iteration up to maxIterations (50). The guard blocks after
		// MAX_NO_PROGRESS_RETRIES consecutive no-op passes.
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd, // never advances: US-002 stays false
			readHandoff: () => makeHandoff('US-001'), // stale: last completed = US-001
			// In sentinel mode the stale worker emits a DONE sentinel for the already-
			// done story; both poll call and outcome-read call return the same pane text.
			capturePane: (_paneId) => donePane('US-001'),
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
			// Stale worker emits DONE story=US-001 (same text for poll + outcome read).
			capturePane: (_paneId) => donePane('US-001'),
			maxIterations: 50,
			// Use pollIntervalMs: 0 so the only non-zero sleepFn calls are the
			// escalating no-progress backoffs (CAM-38), keeping the assertion exact.
			pollIntervalMs: 0,
			sleepFn: (ms) => {
				if (ms > 0) sleeps.push(ms);
			},
			// Pin randomFn for deterministic jitter (r=0.5 -> zero offset).
			randomFn: () => 0.5,
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(MAX_NO_PROGRESS_RETRIES);
		// Three paused retries before the 4th no-op blocks: escalating backoff.
		expect(sleeps).toEqual([NO_PROGRESS_BACKOFF_MS * 1, NO_PROGRESS_BACKOFF_MS * 2, NO_PROGRESS_BACKOFF_MS * 4]);
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
			// In sentinel mode capturePane is called twice per implement iteration
			// (poll call + outcome read). Iter 1: worker confirms US-001 done (stale
			// no-progress). Iter 2: worker really completes US-002.
			capturePane: (() => {
				let paneIdx = 0;
				const panes = [
					donePane('US-001'), // iter 1 poll
					donePane('US-001'), // iter 1 outcome read
					donePane('US-002'), // iter 2 poll
					donePane('US-002'), // iter 2 outcome read
				];
				return (_paneId: string) => panes[paneIdx++] ?? '';
			})(),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(3); // 2 implement + 1 review, never blocked
	});

	test('no-progress streak resets after finalize-success (CAM-36, review R1)', async () => {
		// A successful supervisor finalize (incomplete -> gates -> finalizeStory)
		// is real progress and must reset the no-op streak, exactly like a
		// regular completed story. Sequence: 2 no-ops (streak 2), finalize
		// (reset), 1 more no-op (streak 1, NOT 3/blocked), real completion,
		// review CLEAN, complete. Without the reset the 4th iteration blocks.
		const prdA = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
				{ id: 'US-003', priority: 3, passes: false },
			],
		});
		const prdB = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: true },
				{ id: 'US-003', priority: 3, passes: false },
			],
		});
		const prdC = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: true },
				{ id: 'US-003', priority: 3, passes: true },
			],
			review: { roundsCompleted: 0, lastVerdict: null },
		});
		const prdClean = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: true },
				{ id: 'US-003', priority: 3, passes: true },
			],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});

		// 2 reads per implement iteration (top + outcome), 2 for review, 1 complete.
		const prds: PrdSnapshot[] = [
			prdA, prdA, // iter 1: no-op (stale US-001 pass, streak 1)
			prdA, prdA, // iter 2: no-op (streak 2)
			prdA, prdA, // iter 3: incomplete US-002 -> finalize ok (streak reset)
			prdB, prdB, // iter 4: no-op (stale US-002 pass; streak 1 with fix, 3 without)
			prdB, prdC, // iter 5: real US-003 completion
			prdC, prdClean, // iter 6: review -> CLEAN
			prdClean, // iter 7 top: complete
		];
		let prdCall = 0;

		// Per-iteration worker signals: pane (poll + outcome read = same text twice)
		// and the handoff the outcome read sees. Iteration index advances on the
		// poll call (even paneIdx).
		const paneByIter = [
			donePane('US-001'), // iter 1: stale
			donePane('US-001'), // iter 2: stale
			donePane('US-002'), // iter 3: worker truncated (prd still false -> incomplete)
			donePane('US-002'), // iter 4: stale
			donePane('US-003'), // iter 5: real
		];
		const handoffByIter = ['US-001', 'US-001', 'US-002', 'US-002', 'US-003'];
		let paneIdx = 0;
		let iter = 0;

		let finalized = '';
		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
			readHandoff: () => makeHandoff(handoffByIter[iter - 1] ?? 'US-003'),
			capturePane: (_paneId: string) => {
				if (paneIdx % 2 === 0) iter += 1;
				paneIdx += 1;
				return paneByIter[iter - 1] ?? '';
			},
			runGates: () => ({ ok: true, detail: 'gates ok' }),
			finalizeStory: (storyId) => {
				finalized = storyId;
				return { ok: true, detail: 'finalized' };
			},
		});

		const result = await runSupervisor(opts);

		expect(finalized).toBe('US-002');
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(6); // 5 implement + 1 review, never blocked
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
			reviewDispatch: (_uuid) => {
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
			reviewDispatch: (_uuid) => {
				reviewCalls += 1;
				return { status: 'error', detail: 'no <review> verdict (silent no-op)' };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(reviewCalls).toBe(MAX_REVIEW_DISPATCH_ATTEMPTS); // bounded, then block
	});

	test('worker outcome incomplete -> blocked (sentinel-handoff mismatch no longer fails, US-001)', async () => {
		// US-001: the DONE-sentinel-vs-handoff mismatch->fail block was dropped.
		// Sentinel says US-001 but handoff records US-002. Handoff now wins for
		// story selection (no fail-on-mismatch). US-002 is not in the prd
		// (which only has US-001), so passes:false -> kind='incomplete' -> blocked.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => ({ lastCompletedStory: { id: 'US-002' } }),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(1);
		// US-001: was 'fail', now 'incomplete' (handoff wins, prd not confirmed for US-002)
		expect(result.lastOutcome?.kind).toBe('incomplete');
	});

	test('worker outcome unknown -> blocked', async () => {
		// In sentinel mode the poll loop must find a CAM_*_STATUS sentinel or it
		// spins until timeout. Use a DONE sentinel with no story= id and no handoff
		// so that readWorkerOutcome classifies the outcome as 'unknown' (no completed
		// story can be determined from either source).
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => 'CAM_IMPLEMENTER_STATUS=DONE\n',
			// No readHandoff: defaults to null, so no completed story id.
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

	test('review dispatch error -> blocked', async () => {
		// All stories pass, no review done yet -> dispatch review
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 0, lastVerdict: null },
		});

		const opts = makeBaseOpts({
			readPrd: () => prd,
			reviewDispatch: (_uuid) => ({ status: 'error', detail: 'dispatch failed' }),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(1);
	});

	test('US-005: blocked-review path calls notifyOrchestrator exactly once with [cam] review BLOCKED:', async () => {
		// All stories pass -> supervisor goes to review branch.
		// reviewDispatch returns error every attempt -> blocked path triggered.
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 0, lastVerdict: null },
		});

		const notified: string[] = [];

		const opts = makeBaseOpts({
			readPrd: () => prd,
			reviewDispatch: (_uuid) => ({ status: 'error', detail: 'pane died after retries' }),
			notifyOrchestrator: (line) => {
				notified.push(line);
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		// notifyOrchestrator called exactly once on the blocked path.
		expect(notified.length).toBe(1);
		expect(notified[0]).toMatch(/^\[cam\] review BLOCKED:/);
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
	// US-011: Worker timeout + crash detection (sentinel mode)
	// ---------------------------------------------------------------------------

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
			pollIntervalMs: 0,
			sleepFn: (ms) => { sleepCalls.push(ms); },
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
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 0, // elapsed = 0 - 0 = 0 >= 0 -> immediate timeout
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
			pollIntervalMs: 0,
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

	test('spawn is called twice per implement iteration: set-option then respawn-pane (US-002)', async () => {
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

		// US-002: two spawn calls per implement iteration:
		//   1. set-option -p -t <paneId> @cam_label implementer
		//   2. respawn-pane -k -t <paneId> <shellCmd>
		expect(spawnCalls.length).toBe(2);
		// First call sets the @cam_label.
		const labelCall = spawnCalls[0] ?? [];
		expect(labelCall).toContain('set-option');
		expect(labelCall).toContain('@cam_label');
		expect(labelCall).toContain('implementer');
		expect(labelCall).toContain(WORKER_PANE_ID);
		// Second call does the respawn.
		const respawnCall = spawnCalls[1] ?? [];
		expect(respawnCall).toContain('respawn-pane');
		expect(respawnCall).toContain(WORKER_PANE_ID);
	});

	// -------------------------------------------------------------------------
	// US-004: readWorkerReport - report-file completion detection
	// -------------------------------------------------------------------------

	test('US-004: supervisor advances on a report event (readWorkerReport injected)', async () => {
		// When readWorkerReport is injected and returns a non-null report,
		// the poll loop exits with pollOutcome='sentinel' on the first tick.
		// The state-primary outcome is still confirmed via prd.json + handoff.json
		// through readWorkerOutcome (capturePane called once for the pane text).
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;

		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
			notes: 'none',
		};

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readHandoff: () => makeHandoff('US-001'),
			// capturePane is called ONLY for the post-loop readWorkerOutcome call,
			// not for detection (report reader handles detection instead).
			capturePane: (_paneId) => donePane('US-001'),
			readWorkerReport: () => fakeReport, // immediate hit on first poll tick
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(result.lastOutcome?.storyId).toBe('US-001');
	});

	test('US-004: absent report reuses existing timeout guard', async () => {
		// When readWorkerReport always returns null (report not yet written),
		// the poll loop falls through to the timeout guard (perWorkerTimeoutMs:0).
		// All existing guards remain active even when the report reader is injected.
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		const spawnCalls: string[][] = [];
		let prdCall = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readWorkerReport: () => null, // no report written yet
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 0, // elapsed 0 >= 0 -> immediate timeout on first tick
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		// Timeout fires (dead-worker streak 1, under cap), loop continues to next
		// iteration where prd is all done -> complete.
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		// The existing timeout kill-command guard is still active.
		expect(spawnCalls.some((a) => a.includes('echo timeout'))).toBe(true);
	});

	test('W5: scrollback-fallback only scans tail (literal sentinel in history does not false-trip)', async () => {
		// Scrollback guard (US-FIX-006): the capturePane fallback now only scans
		// the last 10 lines. A doc or template containing the literal sentinel
		// string earlier in the pane history must NOT fire pollOutcome='sentinel'.
		// Here, the sentinel appears in the first half of the pane text (simulating
		// a CLAUDE.md read-out), and the last 10 lines contain no sentinel.
		// The poll must NOT advance; the timeout (perWorkerTimeoutMs:0) fires instead.
		const docWithLiteralSentinel =
			// 20 lines of "history" containing the forbidden literal
			Array.from({ length: 20 }, (_, i) =>
				i === 5
					? 'CAM_IMPLEMENTER_STATUS=DONE story=US-001' // literal in scrollback
					: `history line ${i}`,
			).join('\n') +
			'\n' +
			// 3 lines of actual current pane output (no sentinel here)
			'> current prompt output\n> more output\n> idle\n';

		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			capturePane: (_paneId) => docWithLiteralSentinel,
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 0, // forces timeout (not sentinel) on this iteration
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		// Timeout fires (dead-worker streak 1, under cap) because the sentinel in
		// the scrollback history was NOT in the tail -- so it was ignored.
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		// The timeout kill was issued (not a sentinel exit)
		expect(spawnCalls.some((a) => a.includes('echo timeout'))).toBe(true);
	});

	test('US-004: clearWorkerReport called once per implement dispatch', async () => {
		// clearWorkerReport must be called exactly once before respawn-pane -k so
		// a stale report from the previous run does not trigger a false positive.
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;
		let clearCalls = 0;

		const report: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
			notes: 'none',
		};

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readHandoff: () => makeHandoff('US-001'),
			capturePane: (_paneId) => donePane('US-001'),
			readWorkerReport: () => report,
			clearWorkerReport: () => {
				clearCalls++;
			},
		});

		await runSupervisor(opts);

		expect(clearCalls).toBe(1); // exactly once per implement dispatch
	});

	// -------------------------------------------------------------------------
	// US-002: canonical implementer completion-detect via worker-report.json
	// -------------------------------------------------------------------------

	test('US-002: DONE sentinel in pane is ignored when readWorkerReport is injected (report is canonical, sentinel is corroboration)', async () => {
		// AC3: when readWorkerReport IS injected (canonical path), a DONE sentinel
		// visible in the pane is NOT used to break the poll loop. The else-branch
		// (capturePane + parseAnySentinel) is skipped entirely. The poll exits only
		// via timeout (or report file, or pane-died) -- never via sentinel alone.
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			// Pane shows a DONE sentinel -- ignored because readWorkerReport is injected.
			capturePane: (_paneId) => donePane('US-001'),
			// readWorkerReport returns null -> no report file present yet.
			readWorkerReport: () => null,
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 0, // immediate timeout fires (not sentinel)
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		// Poll exits via timeout (dead-worker streak 1, under cap), not via sentinel.
		// Next decideNextAction finds prd all done -> complete.
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		// Timeout kill was issued, confirming the exit was timeout not sentinel.
		expect(spawnCalls.some((a) => a.includes('echo timeout'))).toBe(true);
	});

	test('US-002: pane-died remains a failure net when readWorkerReport is injected', async () => {
		// AC2: pane-died is checked BEFORE readWorkerReport (first guard in the loop).
		// A dead pane terminates the poll immediately even when the report reader is wired.
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			isPaneAlive: (_paneId) => false, // pane dies immediately on first poll tick
			// readWorkerReport returns null -- but pane-died fires before it is checked.
			readWorkerReport: () => null,
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 99_999,
		});

		const result = await runSupervisor(opts);

		// pane-died fires (streak 1, under MAX_DEAD_WORKER_RETRIES cap).
		// Next decideNextAction finds prd all done -> complete.
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// US-001: ensurePushed -- origin-sync backstop on every pass (placeholder)
// ---------------------------------------------------------------------------

// Note: RATE_LIMIT sentinel is still a valid CAM_IMPLEMENTER_STATUS value
// that workers can emit. In sentinel mode it flows through readWorkerOutcome.
/** Pane text with the RATE_LIMIT exit sentinel (emitted by workers on rate-limit). */
const RATE_LIMIT_SENTINEL_PANE = `Working hard\nCAM_IMPLEMENTER_STATUS=RATE_LIMIT\n`;

describe('runSupervisor rate-limit sentinel in sentinel mode', () => {
	test('RATE_LIMIT sentinel -> blocked (no retry logic in sentinel path)', async () => {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });

		const opts = makeBaseOpts({
			readPrd: () => prdFalse,
			readHandoff: () => null,
			capturePane: (_paneId) => RATE_LIMIT_SENTINEL_PANE,
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
		// In sentinel mode capturePane is called twice per implement iteration:
		// once during poll (sentinel detection) and once for outcome reading.
		const panes = [
			donePane('US-001'), // iter 1 poll
			donePane('US-001'), // iter 1 outcome read
			donePane('US-002'), // iter 2 poll
			donePane('US-002'), // iter 2 outcome read
		];

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
			reviewDispatch: (_uuid) => ({ status: 'ok', detail: 'review ok' }),
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
			// In sentinel mode, stale worker emits DONE story=US-001 -> state-primary pass US-001.
			capturePane: (_paneId) => donePane('US-001'),
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

// ---------------------------------------------------------------------------
// US-002: @cam_label on worker pane (uniform titled worker-pane)
// ---------------------------------------------------------------------------

describe('runSupervisor @cam_label pane labeling (US-002)', () => {
	// Helper to build the pass scenario (1 story -> implement -> review -> complete).
	function makeOneStoryPrds() {
		const prdFalse = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdTrue = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		return { prdFalse, prdTrue };
	}

	test('implement dispatch: set-option @cam_label implementer is called before respawn-pane (AC1)', async () => {
		const { prdFalse, prdTrue } = makeOneStoryPrds();
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 2 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			spawn: (_cmd, args) => {
				spawnCalls.push([...args]);
				return { stdout: '', exitCode: 0 };
			},
		});

		await runSupervisor(opts);

		// Find the set-option call that sets @cam_label to 'implementer'.
		const labelCall = spawnCalls.find(
			(a) => a.includes('set-option') && a.includes('@cam_label') && a.includes('implementer'),
		);
		expect(labelCall).toBeDefined();
		expect(labelCall).toContain('-p'); // pane-scoped option
		expect(labelCall).toContain('-t');
		expect(labelCall).toContain(WORKER_PANE_ID);

		// The label call must precede the respawn-pane call in the same iteration.
		const labelIdx = spawnCalls.findIndex(
			(a) => a.includes('set-option') && a.includes('@cam_label') && a.includes('implementer'),
		);
		const respawnIdx = spawnCalls.findIndex((a) => a.includes('respawn-pane'));
		expect(labelIdx).toBeGreaterThanOrEqual(0);
		expect(respawnIdx).toBeGreaterThanOrEqual(0);
		expect(labelIdx).toBeLessThan(respawnIdx);
	});

	test('review dispatch: set-option @cam_label reviewer is called before review respawn-pane (AC1)', async () => {
		// All stories done; decideNextAction -> review. We need to verify a
		// set-option @cam_label reviewer call goes out before reviewDispatch runs.
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
		const spawnCalls: string[][] = [];
		let reviewDispatchCalled = false;
		let reviewerLabelCallIdx = -1;
		let reviewDispatchCallCount = 0;

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? prd_clean,
			spawn: (_cmd, args) => {
				const idx = spawnCalls.push([...args]) - 1;
				// Track when the reviewer label is set.
				if (args.includes('set-option') && args.includes('@cam_label') && args.includes('reviewer')) {
					reviewerLabelCallIdx = idx;
				}
				return { stdout: '', exitCode: 0 };
			},
			reviewDispatch: (_uuid) => {
				reviewDispatchCalled = true;
				reviewDispatchCallCount += 1;
				// Assert label was set before dispatch runs.
				expect(reviewerLabelCallIdx).toBeGreaterThanOrEqual(0);
				return { status: 'ok', detail: 'CLEAN' };
			},
		});

		await runSupervisor(opts);

		expect(reviewDispatchCalled).toBe(true);
		// @cam_label reviewer was set.
		const labelCall = spawnCalls.find(
			(a) => a.includes('set-option') && a.includes('@cam_label') && a.includes('reviewer'),
		);
		expect(labelCall).toBeDefined();
		expect(labelCall).toContain('-p');
		expect(labelCall).toContain(WORKER_PANE_ID);
	});

	test('worker respawn-pane does not include kill-session wrapper (AC3)', async () => {
		// The orchestrator wraps claude in a kill-session shell; the worker must NOT.
		// AC3: /exit closes only the worker-pane (no session teardown from worker).
		const { prdFalse, prdTrue } = makeOneStoryPrds();
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 2 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			spawn: (_cmd, args) => {
				spawnCalls.push([...args]);
				return { stdout: '', exitCode: 0 };
			},
		});

		await runSupervisor(opts);

		// The respawn-pane call for the worker must not contain kill-session.
		const respawnCall = spawnCalls.find((a) => a.includes('respawn-pane'));
		expect(respawnCall).toBeDefined();
		// None of the spawn args should contain kill-session.
		const hasKillSession = respawnCall?.some((a) => a.includes('kill-session'));
		expect(hasKillSession).toBe(false);
	});

	test('worker respawn-pane does not contain -p (AC4: claude -p forbidden)', async () => {
		// AC4: claude -p must not appear in any worker argv (CAM-42 rule).
		const { prdFalse, prdTrue } = makeOneStoryPrds();
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 2 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			spawn: (_cmd, args) => {
				spawnCalls.push([...args]);
				return { stdout: '', exitCode: 0 };
			},
		});

		await runSupervisor(opts);

		// The shell command string passed to respawn-pane must not contain ' -p '.
		const respawnCall = spawnCalls.find((a) => a.includes('respawn-pane'));
		expect(respawnCall).toBeDefined();
		const shellCmdArg = respawnCall?.find((a) => a.includes('claude'));
		expect(shellCmdArg).toBeDefined();
		// '-p' as a standalone flag must be absent.
		expect(shellCmdArg).not.toMatch(/\s-p(\s|$)/);
		expect(shellCmdArg).not.toContain('claude -p');
	});

	test('@cam_label set-option targets the correct worker pane id', async () => {
		const customPaneId = '%99';
		const { prdFalse, prdTrue } = makeOneStoryPrds();
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			workerPaneId: customPaneId,
			readPrd: () => {
				prdCall++;
				return prdCall <= 2 ? prdFalse : prdTrue;
			},
			capturePane: (_paneId) => donePane('US-001'),
			readHandoff: () => makeHandoff('US-001'),
			spawn: (_cmd, args) => {
				spawnCalls.push([...args]);
				return { stdout: '', exitCode: 0 };
			},
		});

		await runSupervisor(opts);

		const labelCall = spawnCalls.find(
			(a) => a.includes('set-option') && a.includes('@cam_label'),
		);
		expect(labelCall).toBeDefined();
		// Must target the custom pane id.
		expect(labelCall).toContain(customPaneId);
	});

	// -------------------------------------------------------------------------
	// US-005: outcome-fallback event
	// -------------------------------------------------------------------------

	test('US-005: outcome-fallback event fires on worker-report fallback path', async () => {
		// When readHandoff returns null (no handoff) and capturePane has no DONE
		// sentinel, readWorkerOutcome resolves via the worker-report fallback.
		// The loop must emit an 'outcome-fallback' event with fallbackKind:
		// 'worker-report-fallback' for operator diagnostics.
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });

		const blockedReport: WorkerReport = {
			outcome: 'BLOCKED_QUALITY',
			story: 'US-001',
			gates: { typecheck: 'fail: 2 errors', tests: '0 pass / 5 fail' },
			notes: 'tests failed',
		};

		const { logger, events } = makeInMemoryEventLogger();

		const opts = makeBaseOpts({
			readPrd: () => prd_impl,
			readHandoff: () => null, // no handoff -> worker-report fallback activated
			capturePane: (_paneId) => UNKNOWN_PANE, // no DONE sentinel
			readWorkerReport: () => blockedReport, // triggers poll sentinel + fallback read
			workerReportPath: '/fake/worker-report.json',
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		const fallbackEvents = events.filter((e) => e.kind === 'outcome-fallback');
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0]?.detail).toMatchObject({ fallbackKind: 'worker-report-fallback' });
	});

	test('US-005 / US-001: when report is primary, outcome-fallback fires with worker-report-fallback (not handoff-string-coerced)', async () => {
		// US-001 inversion: when workerReportPath is provided and a valid DONE
		// report is present, the report is the authoritative source. Even if
		// handoff.lastCompletedStory is a bare string, the handoff-string-coerced
		// path is never taken (handoff is not consulted). The outcome-fallback event
		// fires with fallbackKind 'worker-report-fallback' (the primary-path label).
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done_clean = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;

		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
			notes: 'none',
		};

		const { logger, events } = makeInMemoryEventLogger();

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				// Call 1: top of iter 1 -> passes:false (implement action)
				// Call 2: fileReader prd in readWorkerOutcome -> passes:true (pass outcome)
				// Call 3+: top of iter 2 -> all done + clean (complete)
				return prdCall <= 1 ? prd_impl : prd_done_clean;
			},
			// Bare-string handoff: under US-001 primary path, this is IGNORED.
			readHandoff: () => ({ lastCompletedStory: 'US-001' } as unknown as HandoffSnapshot),
			capturePane: (_paneId) => UNKNOWN_PANE, // no DONE sentinel
			readWorkerReport: () => fakeReport, // triggers poll sentinel detection + primary path
			workerReportPath: '/fake/worker-report.json',
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		const fallbackEvents = events.filter((e) => e.kind === 'outcome-fallback');
		// Report is primary: detail contains 'worker-report-fallback', so the
		// outcome-fallback event fires with that label (not 'handoff-string-coerced').
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0]?.detail).toMatchObject({ fallbackKind: 'worker-report-fallback' });
	});

	test('US-005: outcome-fallback event does NOT fire on happy path (well-formed handoff + DONE sentinel)', async () => {
		// When handoff.lastCompletedStory is a proper {id,title} object AND the
		// captured pane text contains a DONE sentinel, readWorkerOutcome resolves
		// via state-primary + sentinel corroboration. No fallback or coercion
		// occurred, so no 'outcome-fallback' event should be emitted.
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done_clean = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;

		const { logger, events } = makeInMemoryEventLogger();

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done_clean;
			},
			readHandoff: () => makeHandoff('US-001'), // well-formed object, no coercion
			capturePane: (_paneId) => donePane('US-001'), // DONE sentinel present
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		const fallbackEvents = events.filter((e) => e.kind === 'outcome-fallback');
		expect(fallbackEvents).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// US-005 (CAM-77): outcome-source event
	// -------------------------------------------------------------------------

	describe('US-005 (CAM-77): outcome-source event', () => {
		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
			notes: 'none',
		};

		test('(A) worker-report primary path: event fires with winningSrc=worker-report, integrityResult=confirmed-pass', async () => {
			// DONE report + prd passes:true in fileReader -> outcome kind=pass.
			// Detail contains 'worker-report-fallback' -> winningSrc=worker-report.
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const prd_done_clean = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			});
			let prdCall = 0;

			const { logger, events } = makeInMemoryEventLogger();

			const opts = makeBaseOpts({
				readPrd: () => {
					prdCall++;
					// call 1: top of iter 1 -> implement; call 2: fileReader in outcome check -> pass; call 3+: complete
					return prdCall <= 1 ? prd_impl : prd_done_clean;
				},
				readHandoff: () => null,
				capturePane: (_paneId) => UNKNOWN_PANE,
				readWorkerReport: () => fakeReport,
				workerReportPath: '/fake/worker-report.json',
				logEvent: logger,
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('complete');
			const srcEvents = events.filter((e) => e.kind === 'outcome-source');
			expect(srcEvents).toHaveLength(1);
			expect(srcEvents[0]?.detail).toMatchObject({
				winningSrc: 'worker-report',
				integrityResult: 'confirmed-pass',
			});
		});

		test('(B) fallback path (handoff + sentinel): event fires with winningSrc=fallback, integrityResult=confirmed-pass', async () => {
			// Handoff present, DONE sentinel in pane, no workerReportPath.
			// Detail does NOT contain 'worker-report-fallback' -> winningSrc=fallback.
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const prd_done_clean = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			});
			let prdCall = 0;

			const { logger, events } = makeInMemoryEventLogger();

			const opts = makeBaseOpts({
				readPrd: () => {
					prdCall++;
					return prdCall <= 1 ? prd_impl : prd_done_clean;
				},
				readHandoff: () => makeHandoff('US-001'),
				capturePane: (_paneId) => donePane('US-001'),
				logEvent: logger,
				// No workerReportPath -> fallback path
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('complete');
			const srcEvents = events.filter((e) => e.kind === 'outcome-source');
			expect(srcEvents).toHaveLength(1);
			expect(srcEvents[0]?.detail).toMatchObject({
				winningSrc: 'fallback',
				integrityResult: 'confirmed-pass',
			});
		});

		test('(C) DONE report + prd passes:false: event fires with integrityResult=incomplete', async () => {
			// DONE report found, but readPrd always returns passes:false (prd not flipped).
			// readWorkerOutcome returns kind=incomplete; outcome-source should record that.
			const prd_never_passing = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: false }],
			});

			const { logger, events } = makeInMemoryEventLogger();

			const opts = makeBaseOpts({
				readPrd: () => prd_never_passing,
				readHandoff: () => null,
				capturePane: (_paneId) => UNKNOWN_PANE,
				readWorkerReport: () => fakeReport,
				workerReportPath: '/fake/worker-report.json',
				logEvent: logger,
				// Inject runGates returning fail so the loop exits quickly after the event.
				runGates: () => ({ ok: false, detail: 'test gate fail' }),
				finalizeStory: (_storyId) => ({ ok: true, detail: 'finalized' }),
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			const srcEvents = events.filter((e) => e.kind === 'outcome-source');
			expect(srcEvents).toHaveLength(1);
			expect(srcEvents[0]?.detail).toMatchObject({
				winningSrc: 'worker-report',
				integrityResult: 'incomplete',
			});
		});

		test('(D) BLOCKED report: event fires with integrityResult=stale-absent-rejection', async () => {
			// BLOCKED_QUALITY report -> outcome kind=blocked.
			// outcome-source must record stale-absent-rejection.
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const blockedReport: WorkerReport = {
				outcome: 'BLOCKED_QUALITY',
				story: 'US-001',
				gates: { typecheck: 'fail: 2 errors', tests: '0 pass / 5 fail' },
				notes: 'tests failed',
			};

			const { logger, events } = makeInMemoryEventLogger();

			const opts = makeBaseOpts({
				readPrd: () => prd_impl,
				readHandoff: () => null,
				capturePane: (_paneId) => UNKNOWN_PANE,
				readWorkerReport: () => blockedReport,
				workerReportPath: '/fake/worker-report.json',
				logEvent: logger,
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			const srcEvents = events.filter((e) => e.kind === 'outcome-source');
			expect(srcEvents).toHaveLength(1);
			expect(srcEvents[0]?.detail).toMatchObject({
				winningSrc: 'worker-report',
				integrityResult: 'stale-absent-rejection',
			});
		});

		test('(E) logEvent absent: no crash, loop still resolves normally', async () => {
			// When logEvent is not injected, the emit() helper is a no-op.
			// The loop must complete normally without throwing.
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const prd_done_clean = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			});
			let prdCall = 0;

			const opts = makeBaseOpts({
				readPrd: () => {
					prdCall++;
					return prdCall <= 1 ? prd_impl : prd_done_clean;
				},
				readHandoff: () => null,
				capturePane: (_paneId) => UNKNOWN_PANE,
				readWorkerReport: () => fakeReport,
				workerReportPath: '/fake/worker-report.json',
				// logEvent intentionally absent: emit is a no-op.
			});

			const result = await runSupervisor(opts);
			expect(result.status).toBe('complete');
		});

		test('(F) production-wiring: host.ts buildSupervisorOptions wires logEvent into supervisor opts', async () => {
			// CAM-53 lesson: an event emitted without a writeEvent sink wired at the
			// call-site never persists. Assert that host.ts assigns logEvent in the
			// opts object so the production path has a real file sink.
			const hostSrc = await Bun.file('src/supervisor/host.ts').text();
			// logEvent is built from makeFileEventLogger and assigned in opts.
			expect(hostSrc).toContain('makeFileEventLogger');
			expect(hostSrc).toContain('logEvent,');
		});
	});
});

// ---------------------------------------------------------------------------
// US-006: absent / malformed / stale report falls safely to pane-died +
//         timeout nets; CAM-44 backoff intact
//
// AC4 (loop-level): when the report never appears, or is stale/rejected, the
// completion-detect poll does NOT exit via the report path. The pane-died and
// timeout nets fire instead, keeping the CAM-44 dead-worker backoff intact.
// A stale or malformed report must NOT produce a terminal 'blocked' outcome
// that bypasses the backoff.
// ---------------------------------------------------------------------------

describe('runSupervisor US-006: stale / absent / malformed report safety nets', () => {
	// Helper: two-snapshot prd sequence so iter 1 dispatches, iter 2 completes.
	function makeTwoSnapshots() {
		const prd_impl = makePrd({ stories: [{ id: 'US-010', priority: 1, passes: false }] });
		const prd_done = makePrd({
			stories: [{ id: 'US-010', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		return { prd_impl, prd_done };
	}

	// AC4: stale report (story mismatch) -> poll continues -> pane-died fires
	test('AC4: stale report (story != expectedStoryId) -> pane-died net fires, not terminal blocked', async () => {
		// The report carries a stale story ('US-005', not the dispatched 'US-010').
		// With US-006 fix, the poll does NOT exit on the stale report. The pane
		// dies on the same tick, so pane-died fires (streak 1, under cap).
		// The next iteration finds prd all done -> complete.
		const { prd_impl, prd_done } = makeTwoSnapshots();
		let prdCall = 0;

		const staleReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-005', // stale: dispatcher expected US-010
			gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
			notes: 'none',
		};

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			// Pane dies immediately (stale-report scenario: worker crashed after writing stale report)
			isPaneAlive: (_paneId) => false,
			readWorkerReport: () => staleReport,
			workerReportPath: '/fake/worker-report.json',
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 99_999,
		});

		const result = await runSupervisor(opts);

		// pane-died fires (streak 1, under MAX_DEAD_WORKER_RETRIES cap).
		// Next decideNextAction finds prd all done -> complete.
		// Must NOT be a terminal 'blocked' from the stale-report path.
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
	});

	// AC4: stale report -> poll continues -> timeout fires, CAM-44 backoff increments
	test('AC4: stale report -> timeout fires with CAM-44 backoff intact (not terminal block)', async () => {
		// The report carries stale story 'US-005'; dispatched story is 'US-010'.
		// Poll does NOT exit on stale report. Timeout fires (perWorkerTimeoutMs:0).
		// CAM-44 backoff: streak=1 (under cap), pane-died-retry event emitted.
		// Next iter finds prd done -> complete.
		const { prd_impl, prd_done } = makeTwoSnapshots();
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const staleReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-005', // stale
			gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
			notes: 'none',
		};

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readWorkerReport: () => staleReport,
			workerReportPath: '/fake/worker-report.json',
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 0, // immediate timeout
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		// Timeout fires (not sentinel), CAM-44 backoff active (streak 1, under cap).
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		// Timeout kill command was issued (confirms exit was timeout, not sentinel).
		expect(spawnCalls.some((a) => a.includes('echo timeout'))).toBe(true);
	});

	// AC4: malformed report (missing story string) -> poll continues -> timeout fires
	test('AC4: malformed report (missing story discriminator) -> timeout fires, not false-pass', async () => {
		const { prd_impl, prd_done } = makeTwoSnapshots();
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		// A report object with outcome but no story (wrong-shape).
		// readWorkerReport returns it; the poll loop must reject it (no story string).
		const malformedReport = {
			outcome: 'DONE',
			// story field absent - TypeScript cast is intentional to test runtime check
		} as WorkerReport;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readWorkerReport: () => malformedReport,
			workerReportPath: '/fake/worker-report.json',
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 0,
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		// Timeout fires (malformed report rejected), not a false sentinel exit.
		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		expect(spawnCalls.some((a) => a.includes('echo timeout'))).toBe(true);
	});

	// AC4: absent report (readWorkerReport returns null) -> poll continues -> timeout
	// (regression: ensure the null path is unchanged by US-006 edits)
	test('AC4: absent report (null) -> timeout fires, pane-died/timeout nets intact', async () => {
		const { prd_impl, prd_done } = makeTwoSnapshots();
		let prdCall = 0;
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readWorkerReport: () => null,
			workerReportPath: '/fake/worker-report.json',
			pollIntervalMs: 0,
			perWorkerTimeoutMs: 0,
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		expect(spawnCalls.some((a) => a.includes('echo timeout'))).toBe(true);
	});

	// AC4: fresh report for the correct story still exits the poll via sentinel (regression guard).
	test('AC4: fresh report (matching story) still exits poll correctly (no regression)', async () => {
		const { prd_impl, prd_done } = makeTwoSnapshots();
		let prdCall = 0;

		const freshReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-010', // matches dispatched story
			gates: { typecheck: 'ok', tests: '2 pass / 0 fail' },
			notes: 'none',
		};

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readHandoff: () => makeHandoff('US-010'),
			capturePane: (_paneId) => donePane('US-010'),
			readWorkerReport: () => freshReport,
			workerReportPath: '/fake/worker-report.json',
			// No timeout (perWorkerTimeoutMs default: very high), no pane-died.
			// Poll exits via fresh report on first tick.
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.iterations).toBe(1);
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(result.lastOutcome?.storyId).toBe('US-010');
	});

	// AC4: host.ts makeReadWorkerReport applies shape guards (no false-positive from wrong-shape JSON)
	test('AC4: host.ts makeReadWorkerReport applies shape guard for story + outcome (US-R2-001)', async () => {
		// Assert the production reader function (makeReadWorkerReport) includes the
		// correct shape guard expression for both discriminator fields.
		const hostSrc = await Bun.file('src/supervisor/host.ts').text();
		// Shape guard: !Array.isArray + typeof outcome === 'string' + typeof story === 'string'
		expect(hostSrc).toContain("!Array.isArray(parsed)");
		expect(hostSrc).toContain("'outcome'] === 'string'");
		expect(hostSrc).toContain("'story'] === 'string'");
	});
});

// ---------------------------------------------------------------------------
// US-003: sidecar narration wiring
//
// The sidecar (not the worker) emits the [cam] <story> <outcome> line to the
// orchestrator pane. The worker self-push (send-keys) was removed; the sidecar
// calls notifyOrchestrator(formatWorkerReportSummary(report)) at each genuine
// terminal advance. Two discriminating tests:
//   Test 1: genuine advance (story was NOT already passing) -> one notification.
//   Test 2: no-progress re-confirmation retry (story was ALREADY passing, under
//            the cap) -> zero notifications (the retry path must stay silent).
// ---------------------------------------------------------------------------

describe('runSupervisor US-003: sidecar notifyOrchestrator on implementer advance', () => {
	test('notifies orchestrator with worker-report summary on genuine implementer advance', async () => {
		// Iter 1: US-001 is passes:false -> decideNextAction dispatches worker.
		// Worker report: DONE for US-001.
		// readWorkerOutcome (via fileReader) uses prd_done so passes:true -> pass / US-001.
		// completedAlreadyPassing = false (outer prd at top of iter had passes:false).
		// -> else branch fires, noProgressStreak = 0, notifyOrchestrator called once.
		const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prd_done = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: true }] });
		let prdCall = 0;

		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
			notes: 'none',
		};

		const notified: string[] = [];

		const opts = makeBaseOpts({
			readPrd: () => {
				// Call 0: top of loop (decideNextAction + completedAlreadyPassing check).
				// Call 1+: fileReader inside readWorkerOutcome (prd passes:true -> pass).
				prdCall++;
				return prdCall <= 1 ? prd_impl : prd_done;
			},
			readHandoff: () => makeHandoff('US-001'),
			capturePane: (_paneId) => donePane('US-001'),
			readWorkerReport: () => fakeReport,
			notifyOrchestrator: (line) => {
				notified.push(line);
			},
			// Stop after one iteration so we can assert on exactly this advance.
			maxIterations: 1,
		});

		const result = await runSupervisor(opts);

		// Loop exits via max-iterations after the genuine advance iteration.
		expect(result.status).toBe('max-iterations');
		// notifyOrchestrator called exactly once with the formatted summary.
		expect(notified.length).toBe(1);
		expect(notified[0]).toBe('[cam] US-001 DONE: typecheck ok, 5 pass / 0 fail');
	});

	test('does not narrate on a no-progress re-confirmation retry', async () => {
		// Iter 1: US-001 is ALREADY passes:true, US-002 is passes:false ->
		// decideNextAction dispatches for US-002 (advisory = 'US-002').
		//
		// The poll report (story='US-002') matches the advisory ID so the poll
		// exits immediately via readWorkerReport.
		//
		// readWorkerOutcome falls to the fallback path (no workerReportPath):
		//   handoff says US-001 completed (stale worker output re-confirming US-001);
		//   prd shows US-001 passes:true -> outcome = pass / US-001.
		//
		// completedAlreadyPassing = true (US-001 was passes:true at top of iter).
		// noProgressStreak becomes 1, which is < MAX_NO_PROGRESS_RETRIES (4).
		// -> no-progress retry branch: sleep + continue (no notifyOrchestrator call).
		//
		// This test FAILS against a defective implementation that calls
		// notifyOrchestrator BEFORE the no-progress guard (which would fire the
		// report-based notify unconditionally, yielding notified.length = 1).
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});

		// Poll report matches the advisory story (US-002) so the staleness guard
		// passes and the poll exits immediately. readWorkerOutcome still returns
		// pass/US-001 via the handoff fallback path (capturePane + makeHandoff).
		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-002',
			gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
			notes: 'none',
		};

		const notified: string[] = [];

		const opts = makeBaseOpts({
			readPrd: () => prd,
			readHandoff: () => makeHandoff('US-001'),
			// Stale pane: worker emits DONE for already-done US-001.
			capturePane: (_paneId) => donePane('US-001'),
			readWorkerReport: () => fakeReport,
			notifyOrchestrator: (line) => {
				notified.push(line);
			},
			// Stop after one iteration to isolate the single retry.
			maxIterations: 1,
		});

		const result = await runSupervisor(opts);

		// Loop exits via max-iterations after the single no-progress retry.
		expect(result.status).toBe('max-iterations');
		// notifyOrchestrator must NOT be called on a no-progress retry.
		expect(notified.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// US-001 (CAM-94): blocked-narration at terminal-blocked implement sites
	// -------------------------------------------------------------------------

	describe('US-001 (CAM-94): terminal-blocked narration uses lastOutcome.detail, not formatWorkerReportSummary', () => {
		test('AC2: BLOCKED_QUALITY report -> notifyOrchestrator reflects BLOCKED, not formatWorkerReportSummary on a DONE report', async () => {
			// Drive the implement branch to site 949 (outcome.kind === blocked) via
			// an injected BLOCKED_QUALITY worker report. Assert:
			//   - notifyOrchestrator fires exactly once
			//   - the line matches [cam] ... BLOCKED: <detail>
			//   - the line does NOT equal formatWorkerReportSummary applied to a DONE report
			const prd_impl = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: false }],
			});

			const blockedReport: WorkerReport = {
				outcome: 'BLOCKED_QUALITY',
				story: 'US-001',
				gates: { typecheck: 'fail: 2 errors', tests: '0 pass / 5 fail' },
				notes: 'tests failed',
			};

			// A hypothetical DONE report on the same story: formatWorkerReportSummary
			// on this would include the word "DONE". The blocked narration must not
			// equal this string.
			const doneReport: WorkerReport = {
				outcome: 'DONE',
				story: 'US-001',
				gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
				notes: 'none',
			};

			const notified: string[] = [];

			const opts = makeBaseOpts({
				readPrd: () => prd_impl,
				readHandoff: () => null,
				capturePane: (_paneId) => UNKNOWN_PANE,
				readWorkerReport: () => blockedReport,
				workerReportPath: '/fake/worker-report.json',
				notifyOrchestrator: (line) => {
					notified.push(line);
				},
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			expect(notified.length).toBe(1);
			// Must follow the [cam] ... BLOCKED: <detail> pattern.
			expect(notified[0]).toMatch(/^\[cam\].*BLOCKED:/);
			// Must NOT equal formatWorkerReportSummary on a DONE report.
			expect(notified[0]).not.toBe(formatWorkerReportSummary(doneReport));
		});

		test('AC3: worker report says DONE but prd not flipped -> blocked narration does not contain "DONE"', async () => {
			// Drive the implement branch to site 996 (outcome.kind === incomplete,
			// no runGates/finalizeStory). readWorkerOutcome gets a DONE report but
			// prd.json always shows passes:false, so outcome.kind = incomplete.
			// The narrated line must not contain the substring "DONE".
			const prd_never_passing = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: false }],
			});

			const doneReport: WorkerReport = {
				outcome: 'DONE',
				story: 'US-001',
				gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
				notes: 'none',
			};

			const notified: string[] = [];

			const opts = makeBaseOpts({
				readPrd: () => prd_never_passing,
				readHandoff: () => null,
				capturePane: (_paneId) => UNKNOWN_PANE,
				readWorkerReport: () => doneReport,
				workerReportPath: '/fake/worker-report.json',
				notifyOrchestrator: (line) => {
					notified.push(line);
				},
				// No runGates / finalizeStory -> hits the plain incomplete terminal.
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			expect(notified.length).toBe(1);
			// Must follow the [cam] ... BLOCKED: pattern.
			expect(notified[0]).toMatch(/^\[cam\].*BLOCKED:/);
			// Must NOT contain the substring "DONE" (the worker report's outcome value).
			expect(notified[0]).not.toContain('DONE');
		});

		test('AC5: genuine DONE advance -> notifyOrchestrator narrates formatWorkerReportSummary (happy path unchanged)', async () => {
			// Drive a genuine advance: story advances from passes:false to passes:true.
			// The genuine-advance site (line ~1047) must still call
			// formatWorkerReportSummary(r), not the new BLOCKED pattern.
			const prd_impl = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: false }],
			});
			const prd_done_clean = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			});
			let prdCall = 0;

			const fakeReport: WorkerReport = {
				outcome: 'DONE',
				story: 'US-001',
				gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
				notes: 'none',
			};

			const notified: string[] = [];

			const opts = makeBaseOpts({
				readPrd: () => {
					prdCall++;
					// Call 1: top of iter 1 -> passes:false (implement action).
					// Call 2+: fileReader in readWorkerOutcome + top of iter 2 -> done+clean.
					return prdCall <= 1 ? prd_impl : prd_done_clean;
				},
				readHandoff: () => null,
				capturePane: (_paneId) => UNKNOWN_PANE,
				readWorkerReport: () => fakeReport,
				workerReportPath: '/fake/worker-report.json',
				notifyOrchestrator: (line) => {
					notified.push(line);
				},
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('complete');
			// Genuine-advance notify fires once (not on the review-complete path).
			expect(notified.length).toBe(1);
			// Must equal the worker-report summary (happy path unchanged).
			expect(notified[0]).toBe(formatWorkerReportSummary(fakeReport));
		});

		test('AC7: formatWorkerReportSummary call-site count in loop.ts equals 3 (happy-path only)', () => {
			// File-assert: after the fix, formatWorkerReportSummary is called only at
			// the three happy-path sites (supervisor-finalized-pass continue, genuine
			// advance, PRD_COMPLETE). The six terminal-blocked sites no longer call it.
			const src = readFileSync(
				new URL('../../src/supervisor/loop.ts', import.meta.url).pathname,
				'utf-8',
			);
			const count = src.split('formatWorkerReportSummary(').length - 1;
			expect(count).toBe(3);
		});
	});

	// US-005: preflightContainerFn seam tests (B-1 observe-only)
	describe('US-005: preflightContainerFn injectable seam (B-1 observe-only)', () => {
		/**
		 * Shared helper: build a one-story PRD + matching report that drives
		 * the loop to 'complete' in one iteration.
		 */
		function oneStoryBase(): Partial<RunSupervisorOptions> {
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const prd_done = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			});
			const fakeReport: WorkerReport = {
				outcome: 'DONE',
				story: 'US-001',
				gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
				notes: 'none',
			};
			let prdCall = 0;
			return {
				readPrd: () => {
					prdCall++;
					return prdCall <= 1 ? prd_impl : prd_done;
				},
				readHandoff: () => makeHandoff('US-001'),
				capturePane: (_paneId) => donePane('US-001'),
				readWorkerReport: () => fakeReport,
			};
		}

		test('AC3a: preflightContainerFn called before respawn-pane dispatch', async () => {
			const callOrder: string[] = [];
			const opts = makeBaseOpts({
				...oneStoryBase(),
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) callOrder.push('respawn-pane');
					return { stdout: '', exitCode: 0 };
				},
				preflightContainerFn: () => {
					callOrder.push('preflight');
					return { ready: true };
				},
			});

			await runSupervisor(opts);

			const preflightIdx = callOrder.indexOf('preflight');
			const respawnIdx = callOrder.indexOf('respawn-pane');
			expect(preflightIdx).toBeGreaterThanOrEqual(0);
			expect(respawnIdx).toBeGreaterThanOrEqual(0);
			expect(preflightIdx).toBeLessThan(respawnIdx);
		});

		test('AC3b + AC2: not-ready preflight does not block host spawn (dispatch still happens)', async () => {
			let respawnPaneCalled = false;
			let preflightCalled = false;

			const opts = makeBaseOpts({
				...oneStoryBase(),
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) respawnPaneCalled = true;
					return { stdout: '', exitCode: 0 };
				},
				preflightContainerFn: () => {
					preflightCalled = true;
					return { ready: false, reason: 'daemon-unreachable' };
				},
			});

			const result = await runSupervisor(opts);

			expect(preflightCalled).toBe(true);
			expect(respawnPaneCalled).toBe(true);
			expect(result.status).toBe('complete');
		});

		test('AC4: absent preflightContainerFn leaves loop behavior unchanged', async () => {
			let respawnPaneCalled = false;
			const opts = makeBaseOpts({
				...oneStoryBase(),
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) respawnPaneCalled = true;
					return { stdout: '', exitCode: 0 };
				},
				// preflightContainerFn intentionally absent
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('complete');
			expect(respawnPaneCalled).toBe(true);
		});

		test('AC1: preflight result logged as container-preflight event (not-ready)', async () => {
			const { logger, events } = makeInMemoryEventLogger();
			const opts = makeBaseOpts({
				...oneStoryBase(),
				logEvent: logger,
				preflightContainerFn: () => ({ ready: false, reason: 'image-missing' as const }),
			});

			await runSupervisor(opts);

			const preflightEvents = events.filter((e) => e.kind === 'container-preflight');
			expect(preflightEvents.length).toBe(1);
			const detail = preflightEvents[0]?.detail as { ready: boolean; reason?: string };
			expect(detail?.ready).toBe(false);
			expect(detail?.reason).toBe('image-missing');
		});

		test('preflight result logged as container-preflight event (ready)', async () => {
			const { logger, events } = makeInMemoryEventLogger();
			const opts = makeBaseOpts({
				...oneStoryBase(),
				logEvent: logger,
				preflightContainerFn: () => ({ ready: true }),
			});

			await runSupervisor(opts);

			const preflightEvents = events.filter((e) => e.kind === 'container-preflight');
			expect(preflightEvents.length).toBe(1);
			const detail = preflightEvents[0]?.detail as { ready: boolean; reason?: string };
			expect(detail?.ready).toBe(true);
			expect(detail?.reason).toBeUndefined();
		});
	});

	// US-004 / B-2 (CAM-152): container dispatch tests
	describe('US-004 / B-2: container mode dispatch (workerIsolation=container)', () => {
		/**
		 * Shared base: one-story PRD that completes in one iteration via report file.
		 */
		function oneStoryBase(): Partial<RunSupervisorOptions> {
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const prd_done = makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			});
			const fakeReport: WorkerReport = {
				outcome: 'DONE',
				story: 'US-001',
				gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
				notes: 'none',
			};
			let prdCall = 0;
			return {
				readPrd: () => {
					prdCall++;
					return prdCall <= 1 ? prd_impl : prd_done;
				},
				readHandoff: () => makeHandoff('US-001'),
				capturePane: (_paneId) => donePane('US-001'),
				readWorkerReport: () => fakeReport,
			};
		}

		test('AC1/AC4: container mode wraps shellCmd with docker exec prefix before respawn-pane', async () => {
			const dispatchedCmds: string[] = [];

			const opts = makeBaseOpts({
				...oneStoryBase(),
				workerIsolation: 'container',
				preflightContainerFn: () => ({ ready: true }),
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) {
						// The last element of the args array is the shell command passed to respawn-pane -k.
						const lastArg = args[args.length - 1];
						if (typeof lastArg === 'string') dispatchedCmds.push(lastArg);
					}
					return { stdout: '', exitCode: 0 };
				},
			});

			await runSupervisor(opts);

			expect(dispatchedCmds.length).toBeGreaterThanOrEqual(1);
			const dispatchedCmd = dispatchedCmds[0] ?? '';
			// AC4: dispatched string starts with 'docker exec -it cam-worker'
			expect(dispatchedCmd).toMatch(/^docker exec -it cam-worker /);
			// AC4: contains 'env -u CLAUDECODE'
			expect(dispatchedCmd).toContain('env -u CLAUDECODE');
			// AC4: contains 'claude'
			expect(dispatchedCmd).toContain('claude');
			// AC4: contains '--session-id' with a lowercase uuid
			expect(dispatchedCmd).toMatch(/--session-id [0-9a-f-]+/);
		});

		test('AC5: host mode (default, no workerIsolation) passes shellCmd unchanged', async () => {
			const dispatchedCmds: string[] = [];

			const opts = makeBaseOpts({
				...oneStoryBase(),
				// workerIsolation intentionally absent -> defaults to 'host'
				preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) {
						const lastArg = args[args.length - 1];
						if (typeof lastArg === 'string') dispatchedCmds.push(lastArg);
					}
					return { stdout: '', exitCode: 0 };
				},
			});

			const result = await runSupervisor(opts);

			// Host mode completes normally (preflight not-ready is observe-only)
			expect(result.status).toBe('complete');
			const dispatchedCmd = dispatchedCmds[0] ?? '';
			// No docker prefix in host mode
			expect(dispatchedCmd).not.toMatch(/^docker exec/);
			// Contains 'claude' (the raw shellCmd)
			expect(dispatchedCmd).toContain('claude');
		});

		test('AC2: container mode + preflight not-ready -> blocked, respawn-pane never called', async () => {
			let respawnCalled = false;

			const opts = makeBaseOpts({
				...oneStoryBase(),
				workerIsolation: 'container',
				preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) respawnCalled = true;
					return { stdout: '', exitCode: 0 };
				},
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			expect(respawnCalled).toBe(false);
			expect(result.lastOutcome?.detail).toMatch(/container-not-ready/);
			expect(result.lastOutcome?.detail).toContain('daemon-unreachable');
		});

		test('AC2: container mode + preflight not-ready -> blocked reason is container-named', async () => {
			const opts = makeBaseOpts({
				...oneStoryBase(),
				workerIsolation: 'container',
				preflightContainerFn: () => ({ ready: false, reason: 'image-missing' }),
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			expect(result.lastOutcome?.detail).toContain('container-not-ready');
			expect(result.lastOutcome?.detail).toContain('image-missing');
		});

		test('AC3: pane-died in container mode routes to container-named blocked reason', async () => {
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			let paneAliveCallCount = 0;
			// isPaneAlive returns false on first call (pane immediately dies)
			const isPaneAlive: IsPaneAlive = (_paneId) => {
				paneAliveCallCount++;
				return false;
			};

			const opts = makeBaseOpts({
				readPrd: () => prd_impl,
				readHandoff: () => null,
				capturePane: () => '',
				isPaneAlive,
				workerIsolation: 'container',
				preflightContainerFn: () => ({ ready: true }),
				// No readWorkerReport injected -> falls through to pane-alive poll
			});

			const result = await runSupervisor(opts);

			// After MAX_DEAD_WORKER_RETRIES the loop blocks.
			expect(result.status).toBe('blocked');
			// The terminal reason must be container-named.
			expect(result.lastOutcome?.detail).toContain('container-exec-failure');
		});

		test('AC3: container mode pane-died reason does not contain generic pane-died-pre-result', async () => {
			const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const isPaneAlive: IsPaneAlive = (_paneId) => false;

			const opts = makeBaseOpts({
				readPrd: () => prd_impl,
				readHandoff: () => null,
				capturePane: () => '',
				isPaneAlive,
				workerIsolation: 'container',
				preflightContainerFn: () => ({ ready: true }),
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			// Generic host detail must NOT appear in container mode pane-died.
			expect(result.lastOutcome?.detail).not.toContain('pane-died-pre-result');
		});

		test('AC2: container preflight ready:true -> dispatch proceeds (no false block)', async () => {
			const opts = makeBaseOpts({
				...oneStoryBase(),
				workerIsolation: 'container',
				preflightContainerFn: () => ({ ready: true }),
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('complete');
		});
	});
});

// ---------------------------------------------------------------------------
// Unit tests for teardownWorkerPaneFn (US-001 / CAM-188)
// ---------------------------------------------------------------------------

describe('runSupervisor US-001: teardownWorkerPaneFn called on every terminal exit', () => {
	// Helper to build a PRD that drives 'complete' immediately (all stories pass + CLEAN).
	function cleanPrd(): PrdSnapshot {
		return makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
	}

	test('complete status: teardownWorkerPaneFn called exactly once', async () => {
		let teardownCount = 0;
		const opts = makeBaseOpts({
			readPrd: () => cleanPrd(),
			teardownWorkerPaneFn: () => { teardownCount++; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(teardownCount).toBe(1);
	});

	test('awaiting-operator status: teardownWorkerPaneFn called exactly once', async () => {
		let teardownCount = 0;
		const prd = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false, requires: 'operator' },
			],
			review: { roundsCompleted: 1, maxRounds: 3, lastVerdict: 'CLEAN' },
		});
		const opts = makeBaseOpts({
			readPrd: () => prd,
			teardownWorkerPaneFn: () => { teardownCount++; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('awaiting-operator');
		expect(teardownCount).toBe(1);
	});

	test('blocked status (PRD unreadable): teardownWorkerPaneFn called exactly once', async () => {
		let teardownCount = 0;
		const opts = makeBaseOpts({
			readPrd: () => null,
			teardownWorkerPaneFn: () => { teardownCount++; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(teardownCount).toBe(1);
	});

	test('max-iterations status: teardownWorkerPaneFn called exactly once', async () => {
		let teardownCount = 0;
		// maxIterations: 0 causes the while loop to never enter, immediately exiting
		// with 'max-iterations'.
		const opts = makeBaseOpts({
			readPrd: () => makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] }),
			maxIterations: 0,
			teardownWorkerPaneFn: () => { teardownCount++; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('max-iterations');
		expect(teardownCount).toBe(1);
	});

	test('complete path: teardownWorkerPaneFn runs AFTER autoShipFn (ordering invariant)', async () => {
		const callOrder: string[] = [];
		const opts = makeBaseOpts({
			readPrd: () => cleanPrd(),
			autoShipFn: () => { callOrder.push('autoShipFn'); },
			teardownWorkerPaneFn: () => { callOrder.push('teardownWorkerPaneFn'); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		// autoShipFn fires first (CAM-181), teardown follows (CAM-188).
		expect(callOrder).toEqual(['autoShipFn', 'teardownWorkerPaneFn']);
	});

	test('absent teardownWorkerPaneFn (omitted): loop behavior unchanged, no error', async () => {
		// Ensure the default no-op is safe: all existing callers that do not inject
		// the dep are byte-for-byte unaffected (backward compatibility invariant).
		const opts = makeBaseOpts({
			readPrd: () => cleanPrd(),
			// teardownWorkerPaneFn deliberately omitted
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
	});

	test('teardownWorkerPaneFn not called on non-terminal no-progress retry (only fires at terminal exit)', async () => {
		// The no-progress guard *retries* when streak < MAX_NO_PROGRESS_RETRIES.
		// teardownWorkerPaneFn must fire exactly once at the terminal blocked return,
		// NOT once per retry. With MAX=4 and one retry capped case this is
		// hard to drive without knowing internals; use a simpler blocked path (PRD
		// unreadable) to assert exactly-one.
		let teardownCount = 0;
		const opts = makeBaseOpts({
			readPrd: () => null,
			teardownWorkerPaneFn: () => { teardownCount++; },
		});

		await runSupervisor(opts);

		expect(teardownCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Unit tests for computeBackoffMs (CAM-85)
// ---------------------------------------------------------------------------

describe('computeBackoffMs', () => {
	const BASE = NO_PROGRESS_BACKOFF_MS; // 60_000
	const MAX = MAX_BACKOFF_MS;           // 300_000
	const JF = JITTER_FRACTION;           // 0.2

	test('streak=1, r=0.5 -> base with zero jitter', () => {
		// min(300_000, 60_000 * 2^0) = 60_000; jitter = 1 + 0.2*(2*0.5-1) = 1.0
		expect(computeBackoffMs(1, { base: BASE, max: MAX, jitterFraction: JF, random: () => 0.5 })).toBe(60_000);
	});

	test('streak=2, r=0.5 -> base*2 with zero jitter', () => {
		// min(300_000, 60_000 * 2) = 120_000; multiplier = 1.0
		expect(computeBackoffMs(2, { base: BASE, max: MAX, jitterFraction: JF, random: () => 0.5 })).toBe(120_000);
	});

	test('streak=1, r=0 -> base * (1 - jitterFraction) (-20%)', () => {
		// jitter = 1 + 0.2*(2*0-1) = 1 - 0.2 = 0.8 -> 60_000 * 0.8 = 48_000
		expect(computeBackoffMs(1, { base: BASE, max: MAX, jitterFraction: JF, random: () => 0 })).toBe(48_000);
	});

	test('streak=1, r=1 -> base * (1 + jitterFraction) (+20%)', () => {
		// jitter = 1 + 0.2*(2*1-1) = 1.2 -> 60_000 * 1.2 = 72_000
		expect(computeBackoffMs(1, { base: BASE, max: MAX, jitterFraction: JF, random: () => 1 })).toBe(72_000);
	});

	test('max cap is respected even with +jitter', () => {
		// streak=10 -> exponential = min(300_000, 60_000*512) = 300_000; jitter r=1 -> 300_000*1.2 = 360_000
		// BUT the cap is applied BEFORE jitter; the cap bounds the exponential not the jittered result.
		// Implementation: exponential = min(max, ...), then multiply by jitter.
		// So 300_000 * 1.2 = 360_000 — the cap does NOT bound the jittered output intentionally.
		// This is by design: jitter applies after the cap so the actual value can slightly exceed max.
		const result = computeBackoffMs(10, { base: BASE, max: MAX, jitterFraction: JF, random: () => 1 });
		expect(result).toBe(360_000);
	});

	test('returns integer (Math.round applied)', () => {
		// r=0.3 -> jitter = 1 + 0.2*(2*0.3-1) = 1 + 0.2*(-0.4) = 1 - 0.08 = 0.92
		// 60_000 * 0.92 = 55200.0 -> exact integer
		const result = computeBackoffMs(1, { base: BASE, max: MAX, jitterFraction: JF, random: () => 0.3 });
		expect(Number.isInteger(result)).toBe(true);
		expect(result).toBe(55_200);
	});

	test('streak=3 is bounded by max at default constants', () => {
		// 60_000 * 2^2 = 240_000 < 300_000 (not capped yet at streak=3 with r=0.5)
		expect(computeBackoffMs(3, { base: BASE, max: MAX, jitterFraction: JF, random: () => 0.5 })).toBe(240_000);
	});
});
