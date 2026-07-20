// test/supervisor/notify-orchestrator.test.ts
//
// Unit tests for the notifyOrchestrator hook in the review branch of
// runSupervisor (US-001, CAM-70), plus the sidecar-pusher wiring to
// sendKeysVerified (US-003, CAM-200).
//
// Coverage:
//   1. CLEAN verdict: notifyOrchestrator called with '[cam] review round 1: CLEAN'.
//   2. FIXES_PENDING:3 verdict: notifyOrchestrator called with '[cam] review round 1: FIXES_PENDING:3'.
//   3. MAX_ROUNDS_DEBT verdict: notifyOrchestrator called with '[cam] review round 4: MAX_ROUNDS_DEBT'.
//   4. notifyOrchestrator absent: loop runs without throwing (backward compat).
//   5. reviewResult.status 'error': notifyOrchestrator IS called with '[cam] review BLOCKED:' (US-005).
//   6. updatedPrd.review.lastVerdict null: notifyOrchestrator is NOT called.
//   7. makeNotifyOrchestrator x sendKeysVerified (US-003): retry-then-delivered
//      (2 send-keys attempts, no push-undelivered event).
//   8. makeNotifyOrchestrator x sendKeysVerified (US-003): retry-exhausted
//      (3 send-keys attempts, exactly one push-undelivered event).
//   9. adaptLogEventForPush wraps push-undelivered into a full WorkerEvent
//      (uuid 'sidecar', storyId undefined) for the durable file event logger.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
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
import { makeNotifyOrchestrator, adaptLogEventForPush } from '../../src/supervisor/host.ts';
import type { SpawnFn as TmuxSpawnFn } from '../../src/tmux/session.ts';
import type { WorkerEvent, WorkerEventKind, WorkerEventDetail, WorkerEventLogger } from '../../src/supervisor/events.ts';

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

// ---------------------------------------------------------------------------
// makeNotifyOrchestrator x sendKeysVerified wiring (US-003, CAM-200)
// ---------------------------------------------------------------------------

/**
 * Build a minimal SpawnSyncReturns<string> suitable for faking tmux calls.
 * getOrchPaneId inspects `.status` and `.stdout`; everything else is unused.
 */
function fakeSpawnResult(stdout: string, status = 0): SpawnSyncReturns<string> {
	return {
		pid: 0,
		output: [null, stdout, ''],
		stdout,
		stderr: '',
		status,
		signal: null,
	};
}

/**
 * `sendKeysVerified`'s delivery verdict (US-002, CAM-359) samples cursor
 * geometry via a `display-message` call routed through the same TmuxSpawnFn
 * passed to `makeNotifyOrchestrator` — it is no longer derived from
 * `capturePaneFn` (that reader now only feeds the PRE-send idle-gate; review
 * round 2 fix, US-R2-001, decoupled the content backstop onto its own
 * `visibleCaptureFn`, defaulted from this same TmuxSpawnFn's `capture-pane`
 * call). Two `display-message` samples happen per attempt: a baseline
 * immediately before send-keys, and a post-send sample after the settle
 * window. This responder alternates: odd calls (1st, 3rd, ...) are always the
 * fixed baseline reading; even calls (2nd, 4th, ...) are the post-send
 * reading, driven by `afterReadingForAttempt(attemptIndex)` (1-based).
 */
function makeGeometryDisplayResponder(
	afterReadingForAttempt: (attemptIndex: number) => string,
): (args: string[]) => string {
	let dmCallCount = 0;
	return (): string => {
		dmCallCount++;
		if (dmCallCount % 2 === 1) return '2;26;80;30'; // fixed baseline reading
		const attemptIndex = dmCallCount / 2;
		return afterReadingForAttempt(attemptIndex);
	};
}

describe('makeNotifyOrchestrator x sendKeysVerified (US-003, CAM-200; geometry oracle US-002, CAM-359)', () => {
	test('retry then delivered: geometry verify succeeds on the second attempt (2 send-keys calls, no push-undelivered)', () => {
		const text = '[cam] US-003 DONE: typecheck ok, 5 pass / 0 fail';
		const sendCalls: string[][] = [];
		// Attempt 1's post-send reading differs from the baseline (undelivered);
		// attempt 2's matches the baseline (delivered).
		const displayResponder = makeGeometryDisplayResponder(
			(attemptIndex) => (attemptIndex === 1 ? '10;26;80;30' : '2;26;80;30'),
		);
		const spawnFn: TmuxSpawnFn = (_cmd, args, _opts) => {
			if (args.includes('list-panes')) return fakeSpawnResult('0;%5\n1;%6\n');
			if (args.includes('display-message')) return fakeSpawnResult(displayResponder(args));
			// Prompt-row discriminator reader (review round 2 fix, US-R2-001,
			// CAM-359; discriminator itself US-001, CAM-364): attempt 2's geometry
			// pair is ambiguous (matches baseline), so sendKeysVerified's default
			// visibleCaptureFn issues a real `capture-pane` call here. Answer with
			// content whose row 26 (the fixed cursorY above) starts with the
			// prompt glyph so the discriminator confirms delivered, and don't
			// count it as a push (only send-keys calls belong in sendCalls).
			if (args.includes('capture-pane')) return fakeSpawnResult(`${'\n'.repeat(26)}❯ `);
			sendCalls.push(args.slice());
			return fakeSpawnResult('');
		};

		const capturePaneFn = (_paneId: string): string => '> '; // idle-gate: always ready.

		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail): void => {
			events.push({ kind, detail });
		};

		const notify = makeNotifyOrchestrator('cam-retry-test', spawnFn, capturePaneFn, logEvent);
		notify(text);

		expect(sendCalls.length).toBe(2);
		expect(events).toEqual([]);
	});

	test('retry exhausted: geometry never returns to baseline triggers exactly one push-undelivered event after maxAttempts sends', () => {
		const text = '[cam] review round 2: FIXES_PENDING:1';
		const sendCalls: string[][] = [];
		// Every post-send reading differs from the baseline: the composer never
		// empties (a dropped Enter every attempt).
		const displayResponder = makeGeometryDisplayResponder(() => '10;26;80;30');
		const spawnFn: TmuxSpawnFn = (_cmd, args, _opts) => {
			if (args.includes('list-panes')) return fakeSpawnResult('0;%7\n');
			if (args.includes('display-message')) return fakeSpawnResult(displayResponder(args));
			sendCalls.push(args.slice());
			return fakeSpawnResult('');
		};

		const capturePaneFn = (_paneId: string): string => '> ';

		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail): void => {
			events.push({ kind, detail });
		};

		const notify = makeNotifyOrchestrator('cam-exhaust-test', spawnFn, capturePaneFn, logEvent);
		notify(text);

		// Default maxAttempts is 3 (src/tmux/dispatch.ts sendKeysVerified).
		expect(sendCalls.length).toBe(3);
		expect(events).toHaveLength(1);
		expect(events[0]!.kind).toBe('push-undelivered');
		expect(events[0]!.detail).toEqual({ paneId: '%7', retriesExhausted: 3 });
	});

	test('adaptLogEventForPush wraps push-undelivered into a full WorkerEvent with uuid "sidecar"', () => {
		const text = '[cam] review round 5: MAX_ROUNDS_DEBT';
		const displayResponder = makeGeometryDisplayResponder(() => '10;26;80;30'); // never emptied: exhausts retries.
		const spawnFn: TmuxSpawnFn = (_cmd, args, _opts) => {
			if (args.includes('list-panes')) return fakeSpawnResult('0;%9\n');
			if (args.includes('display-message')) return fakeSpawnResult(displayResponder(args));
			return fakeSpawnResult('');
		};

		const capturePaneFn = (_paneId: string): string => '> ';

		const recorded: WorkerEvent[] = [];
		const fileLogger: WorkerEventLogger = (event) => {
			recorded.push(event);
		};

		const notify = makeNotifyOrchestrator(
			'cam-adapt-test',
			spawnFn,
			capturePaneFn,
			adaptLogEventForPush(fileLogger),
		);
		notify(text);

		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.kind).toBe('push-undelivered');
		expect(recorded[0]!.uuid).toBe('sidecar');
		expect(recorded[0]!.storyId).toBeUndefined();
		expect(recorded[0]!.detail).toEqual({ paneId: '%9', retriesExhausted: 3 });
	});
});
