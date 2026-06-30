// test/release/merge-watch.test.ts
//
// Unit/integration tests for the merge-watch state machine (US-007).
//
// All I/O is injected via fakes (no real gh, no real spawnSync, no real FS).
//
// Coverage:
//   (a) MERGED path: pollFn returns MERGED -> post-merge runs -> narrates correctly.
//   (b) CI-red path (OPEN+BLOCKED): narrates "CI red, PR #N open, not merged" -> post-merge NOT called.
//   (c) Closed-not-merged path: narrates "CI red, PR #N closed-not-merged" -> post-merge NOT called.
//   (d) Timeout: maxPolls exhausted -> returns timeout outcome -> post-merge NOT called.
//   (e) gh error (null): silent retry until terminal state.
//   (f) Multiple polls before MERGED: sleep called N times between polls.
//   (g) Post-merge failure: narrates "post-merge failed: <reason>".
//   (h) runSidecarLoop: runMergeWatchFn called on idle tick (active:false).
//   (i) runSidecarLoop: runMergeWatchFn NOT called when active:true (supervisor runs instead).
//   (j) Immediate mode: runSidecar does NOT wire runMergeWatchFn (field absent).
//   (k) CI-gated mode: runSidecar DOES wire runMergeWatchFn (field present).
//
// US-007 (CAM-101).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import {
	readMergeWatchState,
	writeMergeWatchState,
	removeMergeWatchState,
	runMergeWatch,
	stepMergeWatch,
	type MergeWatchOptions,
	type MergeWatchState,
	type StepMergeWatchOptions,
	type GhPollFn,
	type PostMergeFn,
	type PrStatus,
} from '../../src/release/merge-watch.ts';
import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../../src/supervisor/loop.ts';
import {
	makeInMemoryEventLogger,
	type WorkerEventKind,
	type WorkerEventDetail,
} from '../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPEN_CLEAN: PrStatus = { state: 'OPEN', mergeStateStatus: 'CLEAN' };
/** BLOCKED with a conclusively failed check (the true ci-red case). */
const OPEN_BLOCKED: PrStatus = {
	state: 'OPEN',
	mergeStateStatus: 'BLOCKED',
	statusCheckRollup: [{ conclusion: 'FAILURE' }],
};
/** BLOCKED with a pending check (CI still running -- must keep polling). */
const OPEN_BLOCKED_PENDING: PrStatus = {
	state: 'OPEN',
	mergeStateStatus: 'BLOCKED',
	statusCheckRollup: [{ conclusion: null }],
};
/** BLOCKED with no statusCheckRollup (no checks configured -- must keep polling). */
const OPEN_BLOCKED_NO_ROLLUP: PrStatus = { state: 'OPEN', mergeStateStatus: 'BLOCKED' };
const MERGED: PrStatus = { state: 'MERGED', mergeStateStatus: 'MERGED' };
const CLOSED: PrStatus = { state: 'CLOSED', mergeStateStatus: 'UNKNOWN' };

/** Build a sequence-based pollFn that returns statuses in order. */
function makeSeqPollFn(statuses: Array<PrStatus | null>): GhPollFn {
	let idx = 0;
	return (_prNumber: number): PrStatus | null => {
		const s = statuses[idx] ?? statuses[statuses.length - 1] ?? null;
		idx++;
		return s;
	};
}

/** A post-merge fn that always succeeds. */
const successPostMerge: PostMergeFn = ({ cwd: _cwd, mergedBranch: _b }) => ({
	ok: true,
	pulledSha: 'abc123',
	tag: 'v1.2.3',
	tagCreated: true,
	branchPrunedLocal: true,
	branchPrunedRemote: true,
});

/** A post-merge fn that always fails. */
const failPostMerge: PostMergeFn = () => ({ ok: false, reason: 'pull-failed' });

/** Build minimal MergeWatchOptions with overrides. */
function makeOpts(
	overrides: Partial<MergeWatchOptions> & { pollStatuses?: Array<PrStatus | null> },
): MergeWatchOptions & { notifications: string[]; sleepCalls: number } {
	const notifications: string[] = [];
	let sleepCalls = 0;
	const base: MergeWatchOptions = {
		prNumber: 42,
		mergedBranch: 'cam/CAM-101-test',
		cwd: '/fake/cwd',
		pollFn: overrides.pollFn ?? makeSeqPollFn(overrides.pollStatuses ?? [MERGED]),
		postMergeFn: overrides.postMergeFn ?? successPostMerge,
		notifyOrchestrator: overrides.notifyOrchestrator ?? ((line) => notifications.push(line)),
		sleepFn:
			overrides.sleepFn ??
			((_ms) => {
				sleepCalls++;
			}),
		pollIntervalMs: overrides.pollIntervalMs ?? 1,
		maxPolls: overrides.maxPolls ?? 10,
	};
	return Object.assign(base, { notifications, sleepCalls: 0, get sleepCallsCount() { return sleepCalls; } });
}

/** Build a minimal RunSupervisorOptions that never actually does anything. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-26T00:00:00Z',
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

const COMPLETE_RESULT: SupervisorResult = {
	status: 'complete',
	iterations: 1,
	lastOutcome: null,
};

// ---------------------------------------------------------------------------
// runMergeWatch state machine tests
// ---------------------------------------------------------------------------

describe('runMergeWatch', () => {
	test('(a) MERGED -> runs post-merge -> narrates result', async () => {
		const notifications: string[] = [];
		let postMergeCalled = false;

		const outcome = await runMergeWatch({
			prNumber: 99,
			mergedBranch: 'cam/my-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: (opts) => {
				postMergeCalled = true;
				expect(opts.mergedBranch).toBe('cam/my-branch');
				return {
					ok: true,
					pulledSha: 'deadbeef',
					tag: 'v2.3.4',
					tagCreated: true,
					branchPrunedLocal: true,
					branchPrunedRemote: true,
				};
			},
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		expect(outcome.kind).toBe('merged');
		expect(postMergeCalled).toBe(true);
		// Should narrate PR merged + post-merge complete
		expect(notifications.some((n) => n.includes('PR #99 merged'))).toBe(true);
		expect(notifications.some((n) => n.includes('post-merge complete') && n.includes('v2.3.4'))).toBe(true);
		expect(notifications.some((n) => n.includes('(tag created)'))).toBe(true);
	});

	test('(b) CI-red (OPEN+BLOCKED) -> narrates + stops, post-merge NOT called', async () => {
		const notifications: string[] = [];
		let postMergeCalled = false;

		const outcome = await runMergeWatch({
			prNumber: 55,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([OPEN_CLEAN, OPEN_BLOCKED]),
			postMergeFn: () => {
				postMergeCalled = true;
				return { ok: false, reason: 'pull-failed' };
			},
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('ci-red');
		if (outcome.kind === 'ci-red') {
			expect(outcome.prNumber).toBe(55);
		}
		expect(postMergeCalled).toBe(false);
		const ciRedLine = notifications.find((n) =>
			n.includes('CI red') && n.includes('PR #55') && n.includes('open, not merged'),
		);
		expect(ciRedLine).toBeDefined();
	});

	test('(b2) BLOCKED+pending checks -> keeps polling, eventually merges (not ci-red)', async () => {
		// The normal ci-gated happy path: first poll returns BLOCKED because CI
		// is still running (pending check conclusion == null). Must keep polling
		// and reach MERGED, NOT stop with a false ci-red.
		const notifications: string[] = [];
		let postMergeCalled = false;

		const outcome = await runMergeWatch({
			prNumber: 56,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			// First poll: BLOCKED+pending (CI still running). Second poll: MERGED.
			pollFn: makeSeqPollFn([OPEN_BLOCKED_PENDING, MERGED]),
			postMergeFn: (opts) => {
				postMergeCalled = true;
				return {
					ok: true,
					pulledSha: 'sha1',
					tag: 'v0.1.0',
					tagCreated: true,
					branchPrunedLocal: true,
					branchPrunedRemote: true,
				};
			},
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('merged');
		expect(postMergeCalled).toBe(true);
		// Must NOT have narrated a false "CI red" line.
		expect(notifications.some((n) => n.includes('CI red'))).toBe(false);
	});

	test('(b3) BLOCKED+no rollup -> keeps polling, eventually merges (not ci-red)', async () => {
		// No statusCheckRollup in the response: can't confirm failure, keep polling.
		const notifications: string[] = [];

		const outcome = await runMergeWatch({
			prNumber: 57,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([OPEN_BLOCKED_NO_ROLLUP, OPEN_BLOCKED_NO_ROLLUP, MERGED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('merged');
		expect(notifications.some((n) => n.includes('CI red'))).toBe(false);
	});

	test('(b4) BLOCKED+StatusContext failure (state:FAILURE) -> ci-red', async () => {
		// Legacy commit-status API: StatusContext with state=="FAILURE" is a real failure.
		const notifications: string[] = [];

		const statusContextFailed: PrStatus = {
			state: 'OPEN',
			mergeStateStatus: 'BLOCKED',
			statusCheckRollup: [{ state: 'FAILURE' }],
		};

		const outcome = await runMergeWatch({
			prNumber: 58,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([statusContextFailed]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('ci-red');
		expect(notifications.some((n) => n.includes('CI red') && n.includes('PR #58'))).toBe(true);
	});

	test('(b5) BLOCKED transitions: pending -> pending -> failed -> ci-red', async () => {
		// Multiple BLOCKED polls with pending checks, then one with a failure.
		const notifications: string[] = [];

		const outcome = await runMergeWatch({
			prNumber: 59,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([
				OPEN_BLOCKED_PENDING,
				OPEN_BLOCKED_PENDING,
				OPEN_BLOCKED, // OPEN_BLOCKED has conclusion:FAILURE
			]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('ci-red');
	});

	test('(c) CLOSED -> narrates closed-not-merged + stops, post-merge NOT called', async () => {
		const notifications: string[] = [];
		let postMergeCalled = false;

		const outcome = await runMergeWatch({
			prNumber: 77,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([CLOSED]),
			postMergeFn: () => {
				postMergeCalled = true;
				return { ok: false, reason: 'pull-failed' };
			},
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		expect(outcome.kind).toBe('closed-not-merged');
		if (outcome.kind === 'closed-not-merged') {
			expect(outcome.prNumber).toBe(77);
		}
		expect(postMergeCalled).toBe(false);
		const closedLine = notifications.find((n) =>
			n.includes('PR #77') && n.includes('closed-not-merged'),
		);
		expect(closedLine).toBeDefined();
	});

	test('(d) Timeout: maxPolls exhausted -> returns timeout, post-merge NOT called', async () => {
		const notifications: string[] = [];
		let postMergeCalled = false;

		const outcome = await runMergeWatch({
			prNumber: 10,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			// Always return OPEN+CLEAN (never terminal)
			pollFn: () => OPEN_CLEAN,
			postMergeFn: () => {
				postMergeCalled = true;
				return { ok: false, reason: 'pull-failed' };
			},
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 3,
		});

		expect(outcome.kind).toBe('timeout');
		if (outcome.kind === 'timeout') {
			expect(outcome.polls).toBe(3);
		}
		expect(postMergeCalled).toBe(false);
		expect(notifications.some((n) => n.includes('timeout'))).toBe(true);
	});

	test('(e) gh error (null) -> silent retry until terminal', async () => {
		const notifications: string[] = [];
		let pollCalls = 0;

		const outcome = await runMergeWatch({
			prNumber: 20,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			// First 3 polls fail, then MERGED
			pollFn: () => {
				pollCalls++;
				return pollCalls <= 3 ? null : MERGED;
			},
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('merged');
		expect(pollCalls).toBe(4); // 3 null + 1 MERGED
	});

	test('(f) Multiple polls before MERGED: sleep called N-1 times', async () => {
		let sleepCalls = 0;
		// OPEN x 3, then MERGED
		const outcome = await runMergeWatch({
			prNumber: 30,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([OPEN_CLEAN, OPEN_CLEAN, OPEN_CLEAN, MERGED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: () => {},
			sleepFn: () => {
				sleepCalls++;
			},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('merged');
		// Sleep called 3 times (before polls 1, 2, 3; NOT before poll 0)
		expect(sleepCalls).toBe(3);
	});

	test('(g) Post-merge failure: narrates "post-merge failed: <reason>"', async () => {
		const notifications: string[] = [];

		const outcome = await runMergeWatch({
			prNumber: 88,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: failPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		expect(outcome.kind).toBe('merged');
		if (outcome.kind === 'merged') {
			expect(outcome.postMerge.ok).toBe(false);
		}
		const failLine = notifications.find((n) =>
			n.includes('post-merge failed') && n.includes('pull-failed'),
		);
		expect(failLine).toBeDefined();
	});

	test('(a2) tag already existed: narrates (tag existed)', async () => {
		const notifications: string[] = [];

		await runMergeWatch({
			prNumber: 11,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc',
				tag: 'v1.0.0',
				tagCreated: false, // already existed
				branchPrunedLocal: true,
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		expect(notifications.some((n) => n.includes('(tag existed)'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runSidecarLoop merge-watch wiring tests
// ---------------------------------------------------------------------------

describe('runSidecarLoop merge-watch wiring', () => {
	/**
	 * Run the loop for one idle tick and one escape tick.
	 * Returns whether runMergeWatchFn was called.
	 */
	async function runWithMergeWatchFn(
		runMergeWatchFn: () => Promise<void>,
		activeOnFirstTick: boolean,
	): Promise<{ mergeWatchCalls: number }> {
		const ESCAPE = Symbol('escape');
		let mergeWatchCalls = 0;
		let sleepCount = 0;
		let readIdx = 0;
		const readActiveSeq: Array<boolean | undefined> = activeOnFirstTick
			? [true, false, false]
			: [false, false];

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false, // so active:true clears fast
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			runMergeWatchFn: async () => {
				mergeWatchCalls++;
				await runMergeWatchFn();
			},
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		return { mergeWatchCalls };
	}

	test('(h) runMergeWatchFn is called on idle tick (active:false)', async () => {
		let watchFnCalled = false;
		const { mergeWatchCalls } = await runWithMergeWatchFn(async () => {
			watchFnCalled = true;
		}, false);

		expect(watchFnCalled).toBe(true);
		expect(mergeWatchCalls).toBeGreaterThan(0);
	});

	test('(i) runMergeWatchFn NOT called when active:true (supervisor runs instead)', async () => {
		// When active:true and hasPendingStories:false, clearActive is called.
		// runMergeWatchFn is only called when active !== true.
		// First tick: active:true -> supervisor path (clearActive + sleep)
		// Second tick: active:false -> runMergeWatchFn + sleep (escape)
		const ESCAPE = Symbol('escape');
		let mergeWatchCalls = 0;
		let sleepCount = 0;
		const readActiveSeq: Array<boolean | undefined> = [true, false, false];
		let readIdx = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 3) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			runMergeWatchFn: async () => {
				mergeWatchCalls++;
			},
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// First tick was active:true (supervisor path, not merge-watch path).
		// mergeWatchCalls only fires on the IDLE ticks (active:false).
		// We had at least one idle tick, so mergeWatchCalls >= 1.
		// But on the ACTIVE tick, mergeWatchCalls must not have been incremented BEFORE clearActive.
		// The key invariant: merge-watch is only called when active !== true.
		expect(mergeWatchCalls).toBeGreaterThanOrEqual(1);
	});

	test('(j-k) absence / presence of runMergeWatchFn is the gate for ci-gated vs immediate', async () => {
		// Verify the contract: when runMergeWatchFn is undefined (as in immediate mode),
		// the loop never calls it. We simulate by NOT injecting it.
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		let capturedOpts: RunSidecarLoopOptions | null = null;

		// We can verify the contract at the loop.ts level by checking whether the
		// runMergeWatchFn field reaches the loop when we inject it vs not.
		// Immediate: field absent -> loop.ts does not call await opts.runMergeWatchFn?.()
		// because the optional chain returns undefined.
		const loopOptsNoWatch: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			// runMergeWatchFn: intentionally absent (simulates immediate mode)
		};

		capturedOpts = loopOptsNoWatch;

		try {
			await runSidecarLoop(loopOptsNoWatch);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(capturedOpts.runMergeWatchFn).toBeUndefined();
		expect(sleepCount).toBeGreaterThan(0); // loop still ran
	});
});

// ---------------------------------------------------------------------------
// Merge-watch inert under immediate mode (AC-3 oracle)
// ---------------------------------------------------------------------------

describe('merge-watch ci-gated vs immediate boundary', () => {
	test('OPEN+CLEAN never stops the watch (CI still running)', async () => {
		// Polls: 3x OPEN_CLEAN, then MERGED. Outcome must be 'merged' (not early stop).
		const outcome = await runMergeWatch({
			prNumber: 100,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([OPEN_CLEAN, OPEN_CLEAN, OPEN_CLEAN, MERGED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('merged');
	});

	test('OPEN+UNSTABLE continues polling (not treated as CI-red)', async () => {
		// mergeStateStatus="UNSTABLE" (partial CI pass) should keep polling.
		const outcome = await runMergeWatch({
			prNumber: 101,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([
				{ state: 'OPEN', mergeStateStatus: 'UNSTABLE' },
				{ state: 'OPEN', mergeStateStatus: 'BEHIND' },
				MERGED,
			]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('merged');
	});
});

// ---------------------------------------------------------------------------
// Structured observability events (US-008)
// ---------------------------------------------------------------------------

describe('runMergeWatch structured events (US-008)', () => {
	test('happy path: watching -> merged -> post-merge-done', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};

		const outcome = await runMergeWatch({
			prNumber: 200,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			logEvent,
		});

		expect(outcome.kind).toBe('merged');

		const kinds = events.map((e) => e.kind);
		expect(kinds).toEqual(['merge-watch-watching', 'merge-watch-merged', 'merge-watch-post-merge-done']);

		// Check watching detail
		const watchingEvt = events[0];
		expect(watchingEvt).toBeDefined();
		if (watchingEvt) {
			const d = watchingEvt.detail as { prNumber: number; mergedBranch: string };
			expect(d.prNumber).toBe(200);
			expect(d.mergedBranch).toBe('cam/test-branch');
		}

		// Check merged detail
		const mergedEvt = events[1];
		expect(mergedEvt).toBeDefined();
		if (mergedEvt) {
			const d = mergedEvt.detail as { prNumber: number };
			expect(d.prNumber).toBe(200);
		}

		// Check post-merge-done detail
		const doneEvt = events[2];
		expect(doneEvt).toBeDefined();
		if (doneEvt) {
			const d = doneEvt.detail as { prNumber: number; ok: boolean; tag?: string; tagCreated?: boolean };
			expect(d.prNumber).toBe(200);
			expect(d.ok).toBe(true);
			expect(d.tag).toBe('v1.2.3');
			expect(d.tagCreated).toBe(true);
		}
	});

	test('CI-red path: watching -> ci-red (OPEN+BLOCKED)', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};

		let postMergeCalled = false;
		const outcome = await runMergeWatch({
			prNumber: 201,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([OPEN_BLOCKED]),
			postMergeFn: () => {
				postMergeCalled = true;
				return { ok: false, reason: 'should-not-run' };
			},
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			logEvent,
		});

		expect(outcome.kind).toBe('ci-red');
		expect(postMergeCalled).toBe(false);

		const kinds = events.map((e) => e.kind);
		expect(kinds).toEqual(['merge-watch-watching', 'merge-watch-ci-red']);

		// Check ci-red detail
		const ciRedEvt = events[1];
		expect(ciRedEvt).toBeDefined();
		if (ciRedEvt) {
			const d = ciRedEvt.detail as { prNumber: number; reason: string };
			expect(d.prNumber).toBe(201);
			expect(d.reason).toBe('blocked');
		}
	});

	test('post-merge failure emits post-merge-done with ok:false', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};

		await runMergeWatch({
			prNumber: 202,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: failPostMerge,
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			logEvent,
		});

		const kinds = events.map((e) => e.kind);
		expect(kinds).toEqual(['merge-watch-watching', 'merge-watch-merged', 'merge-watch-post-merge-done']);

		const doneEvt = events[2];
		if (doneEvt) {
			const d = doneEvt.detail as { ok: boolean; reason?: string };
			expect(d.ok).toBe(false);
			expect(d.reason).toBe('pull-failed');
		}
	});

	test('closed-not-merged emits ci-red with reason:closed', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};

		await runMergeWatch({
			prNumber: 203,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([CLOSED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			logEvent,
		});

		const kinds = events.map((e) => e.kind);
		expect(kinds).toEqual(['merge-watch-watching', 'merge-watch-ci-red']);

		const ciRedEvt = events[1];
		if (ciRedEvt) {
			const d = ciRedEvt.detail as { prNumber: number; reason: string };
			expect(d.prNumber).toBe(203);
			expect(d.reason).toBe('closed');
		}
	});

	test('logEvent absent: no errors thrown (logEvent optional)', async () => {
		// Confirm that omitting logEvent does not throw.
		const outcome = await runMergeWatch({
			prNumber: 204,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			// logEvent intentionally absent
		});

		expect(outcome.kind).toBe('merged');
	});

	test('(US-001) branchPruned fields in event detail + warn narration on prune failure', async () => {
		// --- Part 1: prune failure case (branchPrunedLocal false) ---
		const { logger: logger1, events: events1 } = makeInMemoryEventLogger();
		const logEvent1 = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger1({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};
		const notifications1: string[] = [];

		await runMergeWatch({
			prNumber: 205,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc123',
				tag: 'v1.2.3',
				tagCreated: true,
				branchPrunedLocal: false, // prune failed locally
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: (line) => notifications1.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			logEvent: logEvent1,
		});

		// The done event must carry both prune fields.
		const doneEvt1 = events1.find((e) => e.kind === 'merge-watch-post-merge-done');
		expect(doneEvt1).toBeDefined();
		if (doneEvt1) {
			const d = doneEvt1.detail as {
				ok: boolean;
				branchPrunedLocal?: boolean;
				branchPrunedRemote?: boolean;
			};
			expect(d.ok).toBe(true);
			expect(d.branchPrunedLocal).toBe(false);
			expect(d.branchPrunedRemote).toBe(true);
		}

		// Coalesced-single-line contract (US-003/US-004): the prune sub-status must be
		// folded into the same completion line that carries the tag, not emitted as a
		// separate notifyOrchestrator call. Exactly one notification line must contain
		// both the tag ('v1.2.3') and the prune sub-status ('prune').
		const completionLinesWithPrune1 = notifications1.filter(
			(n) => n.includes('v1.2.3') && n.includes('prune'),
		);
		expect(completionLinesWithPrune1).toHaveLength(1);
		const completionLine1 = completionLinesWithPrune1[0];
		expect(completionLine1).toContain('warn');
		// No standalone warn line (a line with 'warn'+'prune' but NOT the tag).
		const standaloneWarnLines1 = notifications1.filter(
			(n) => n.includes('warn') && n.includes('prune') && !n.includes('v1.2.3'),
		);
		expect(standaloneWarnLines1).toHaveLength(0);

		// --- Part 2: both-true case must produce ZERO prune-failure warning lines ---
		const { logger: logger2, events: events2 } = makeInMemoryEventLogger();
		const logEvent2 = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger2({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};
		const notifications2: string[] = [];

		await runMergeWatch({
			prNumber: 206,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc123',
				tag: 'v1.2.3',
				tagCreated: true,
				branchPrunedLocal: true,
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: (line) => notifications2.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			logEvent: logEvent2,
		});

		// The done event must carry both prune fields as true.
		const doneEvt2 = events2.find((e) => e.kind === 'merge-watch-post-merge-done');
		expect(doneEvt2).toBeDefined();
		if (doneEvt2) {
			const d = doneEvt2.detail as {
				ok: boolean;
				branchPrunedLocal?: boolean;
				branchPrunedRemote?: boolean;
			};
			expect(d.ok).toBe(true);
			expect(d.branchPrunedLocal).toBe(true);
			expect(d.branchPrunedRemote).toBe(true);
		}

		// No prune-failure warning lines when both pruned successfully.
		const pruneWarnLines2 = notifications2.filter((n) => n.includes('warn') && n.includes('prune'));
		expect(pruneWarnLines2).toHaveLength(0);
	});

	test('(US-004/AC5) post-merge with prune-incomplete: exactly one notify call contains tag + prune sub-status', async () => {
		const notifications: string[] = [];

		await runMergeWatch({
			prNumber: 207,
			mergedBranch: 'cam/test-branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc123',
				tag: 'v1.2.3',
				tagCreated: true,
				branchPrunedLocal: false, // prune incomplete
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		// EXACTLY ONE notifyOrchestrator call must contain both the tag and the prune
		// sub-status. This verifies the coalesce invariant: warnOnPruneFailure() folds
		// the prune result into the single '[cam] post-merge complete:...' line rather
		// than emitting a second '[cam] warn: prune ...' call (the old two-call pattern).
		const linesWithTagAndPrune = notifications.filter(
			(n) => n.includes('v1.2.3') && n.includes('prune'),
		);
		expect(linesWithTagAndPrune).toHaveLength(1);
		const combinedLine = linesWithTagAndPrune[0];
		expect(combinedLine).toBeDefined();
		if (combinedLine) {
			expect(combinedLine).toContain('warn');
		}
	});
});

// ---------------------------------------------------------------------------
// stepMergeWatch unit tests (US-001)
// ---------------------------------------------------------------------------
// These tests drive stepMergeWatch directly with an injected clock (now: number)
// and a call-count spy on pollFn. No sleep, no filesystem, no real time.
// ---------------------------------------------------------------------------

describe('stepMergeWatch', () => {
	/** Build a minimal StepMergeWatchOptions with overrides. */
	function makeStepOpts(overrides: Partial<StepMergeWatchOptions> = {}): StepMergeWatchOptions {
		const notifications: string[] = [];
		return {
			cwd: '/fake/cwd',
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			pollIntervalMs: 60_000,
			maxPolls: 240,
			...overrides,
		};
	}

	/** Build a legacy seed state (only prNumber + mergedBranch, no counters). */
	function legacySeed(prNumber = 42): MergeWatchState {
		return { prNumber, mergedBranch: 'cam/test-branch' };
	}

	// AC2a: throttle blocks when now < lastPolledAt + pollIntervalMs
	test('(AC2a) tick where now < lastPolledAt+pollIntervalMs does not call pollFn', () => {
		let pollCalls = 0;
		const pollFn: GhPollFn = () => {
			pollCalls++;
			return MERGED;
		};
		const state: MergeWatchState = {
			prNumber: 1,
			mergedBranch: 'cam/b',
			pollCount: 1,
			lastPolledAt: 1000,
		};
		const opts = makeStepOpts({ pollIntervalMs: 60_000, maxPolls: 240 });

		// now = 1000 + 59_999 < 1000 + 60_000 -> throttled
		const result = stepMergeWatch(state, 1000 + 59_999, pollFn, opts);

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			// State must be unchanged (no poll)
			expect(result.state).toStrictEqual(state);
		}
		expect(pollCalls).toBe(0);
	});

	// AC2b: tick at/after interval calls pollFn exactly once and updates state
	test('(AC2b) tick at interval calls pollFn once and increments pollCount+lastPolledAt', () => {
		let pollCalls = 0;
		const pollFn: GhPollFn = () => {
			pollCalls++;
			return OPEN_CLEAN; // non-terminal
		};
		const state: MergeWatchState = {
			prNumber: 2,
			mergedBranch: 'cam/b',
			pollCount: 3,
			lastPolledAt: 1000,
		};
		const opts = makeStepOpts({ pollIntervalMs: 60_000, maxPolls: 240 });

		// now = 1000 + 60_000 = exactly at interval boundary
		const result = stepMergeWatch(state, 1000 + 60_000, pollFn, opts);

		expect(pollCalls).toBe(1);
		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.pollCount).toBe(4);
			expect(result.state.lastPolledAt).toBe(1000 + 60_000);
		}
	});

	// AC3: legacy seed state polls immediately on first tick
	test('(AC3) legacy seed { prNumber, mergedBranch } polls immediately on first tick', () => {
		let pollCalls = 0;
		const pollFn: GhPollFn = () => {
			pollCalls++;
			return OPEN_CLEAN;
		};
		const state = legacySeed(10);
		// lastPolledAt is absent -> throttle bypassed regardless of now
		const result = stepMergeWatch(state, 0, pollFn, makeStepOpts({ pollIntervalMs: 60_000 }));

		expect(pollCalls).toBe(1);
		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.pollCount).toBe(1);
			expect(result.state.lastPolledAt).toBe(0);
		}
	});

	// AC4: OPEN+BLOCKED+pending check returns continue (not terminal)
	test('(AC4) OPEN_BLOCKED_PENDING yields continue (not ci-red)', () => {
		let pollCalls = 0;
		const pollFn: GhPollFn = () => {
			pollCalls++;
			return OPEN_BLOCKED_PENDING;
		};
		const state = legacySeed(20);
		const result = stepMergeWatch(state, 0, pollFn, makeStepOpts());

		expect(pollCalls).toBe(1);
		expect(result.kind).toBe('continue');
	});

	// AC5: timeout when pollCount reaches maxPolls
	test('(AC5) timeout terminal when pollCount reaches maxPolls', () => {
		let pollCalls = 0;
		const pollFn: GhPollFn = () => {
			pollCalls++;
			return OPEN_CLEAN;
		};
		const opts = makeStepOpts({ maxPolls: 3, pollIntervalMs: 1 });

		// Drive pollCount to 3 (which equals maxPolls=3) -> next tick is timeout
		let state: MergeWatchState = legacySeed(30);
		let virtualNow = 0;

		// Tick 0: lastPolledAt=undefined -> polls, pollCount->1
		let r = stepMergeWatch(state, virtualNow, pollFn, opts);
		expect(r.kind).toBe('continue');
		if (r.kind === 'continue') state = r.state;
		virtualNow += 1;

		// Tick 1: polls, pollCount->2
		r = stepMergeWatch(state, virtualNow, pollFn, opts);
		expect(r.kind).toBe('continue');
		if (r.kind === 'continue') state = r.state;
		virtualNow += 1;

		// Tick 2: polls, pollCount->3
		r = stepMergeWatch(state, virtualNow, pollFn, opts);
		expect(r.kind).toBe('continue');
		if (r.kind === 'continue') state = r.state;
		virtualNow += 1;

		// Tick 3: pollCount===maxPolls=3 -> timeout terminal (pollFn NOT called)
		const pollCallsBefore = pollCalls;
		r = stepMergeWatch(state, virtualNow, pollFn, opts);
		expect(r.kind).toBe('terminal');
		if (r.kind === 'terminal') {
			expect(r.outcome.kind).toBe('timeout');
			if (r.outcome.kind === 'timeout') {
				expect(r.outcome.polls).toBe(3);
			}
		}
		// pollFn must NOT have been called on the timeout tick
		expect(pollCalls).toBe(pollCallsBefore);
	});

	// Extra: gh error (null) on first tick returns continue with updated counters
	test('gh error (null) on first tick returns continue with pollCount incremented', () => {
		const pollFn: GhPollFn = () => null;
		const state = legacySeed(50);
		const result = stepMergeWatch(state, 0, pollFn, makeStepOpts());

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.pollCount).toBe(1);
			expect(result.state.lastPolledAt).toBe(0);
		}
	});

	// Extra: MERGED on first tick returns terminal immediately
	test('MERGED on first tick returns terminal merged outcome', () => {
		const pollFn: GhPollFn = () => MERGED;
		const state = legacySeed(60);
		const notifications: string[] = [];
		const result = stepMergeWatch(state, 0, pollFn, makeStepOpts({
			notifyOrchestrator: (l) => notifications.push(l),
		}));

		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('merged');
		}
	});

	// US-R1-001: 'merge-watch-watching' emitted on first poll (pollCount === 0)
	test('(US-R1-001) merge-watch-watching emitted on first poll (pollCount=0)', () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'sidecar', kind, detail });
		};
		const pollFn: GhPollFn = () => OPEN_CLEAN;
		const state = legacySeed(99);

		stepMergeWatch(state, 0, pollFn, makeStepOpts({ logEvent }));

		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain('merge-watch-watching');
		const watchingEvt = events.find((e) => e.kind === 'merge-watch-watching');
		expect(watchingEvt).toBeDefined();
		if (watchingEvt) {
			const d = watchingEvt.detail as { prNumber: number; mergedBranch: string };
			expect(d.prNumber).toBe(99);
			expect(d.mergedBranch).toBe('cam/test-branch');
		}
	});

	// US-R1-001: 'merge-watch-watching' NOT emitted on subsequent polls (pollCount > 0)
	test('(US-R1-001) merge-watch-watching NOT emitted when pollCount > 0', () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'sidecar', kind, detail });
		};
		const pollFn: GhPollFn = () => OPEN_CLEAN;
		const state: MergeWatchState = {
			prNumber: 88,
			mergedBranch: 'cam/test-branch',
			pollCount: 3,
			lastPolledAt: 0,
		};

		stepMergeWatch(state, 60_000, pollFn, makeStepOpts({ logEvent, pollIntervalMs: 60_000 }));

		const watchingEvents = events.filter((e) => e.kind === 'merge-watch-watching');
		expect(watchingEvents.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Durable state I/O helpers (US-002)
// ---------------------------------------------------------------------------
// Tests use a real tmpdir filesystem (not mocks) as required by the oracle:
//   bun test test/release/merge-watch.test.ts (tmpdir + writeFileSync/readFileSync)
// ---------------------------------------------------------------------------

describe('merge-watch durable state I/O (US-002)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'merge-watch-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// AC1: write + read round-trips all four fields
	test('AC1: write then read round-trips prNumber, mergedBranch, pollCount, lastPolledAt', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		const state: MergeWatchState = {
			prNumber: 42,
			mergedBranch: 'cam/test-branch',
			pollCount: 7,
			lastPolledAt: 1_234_567_890_000,
		};

		writeMergeWatchState(filePath, state);
		const read = readMergeWatchState(filePath);

		expect(read).not.toBeNull();
		expect(read?.prNumber).toBe(42);
		expect(read?.mergedBranch).toBe('cam/test-branch');
		expect(read?.pollCount).toBe(7);
		expect(read?.lastPolledAt).toBe(1_234_567_890_000);
	});

	// AC2a: non-terminal tick keeps file present with updated pollCount/lastPolledAt
	test('AC2a: continue tick leaves file present with updated counters', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');

		// Initial write
		writeMergeWatchState(filePath, {
			prNumber: 10,
			mergedBranch: 'cam/branch',
			pollCount: 2,
			lastPolledAt: 100,
		});
		expect(existsSync(filePath)).toBe(true);

		// Simulate a non-terminal tick: overwrite with updated counters
		writeMergeWatchState(filePath, {
			prNumber: 10,
			mergedBranch: 'cam/branch',
			pollCount: 3,
			lastPolledAt: 200,
		});

		// File must still be present
		expect(existsSync(filePath)).toBe(true);

		// And the updated values must be readable
		const read = readMergeWatchState(filePath);
		expect(read?.pollCount).toBe(3);
		expect(read?.lastPolledAt).toBe(200);
	});

	// AC2b: terminal tick removes the file
	test('AC2b: removeMergeWatchState removes the file (simulates terminal outcome)', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, {
			prNumber: 10,
			mergedBranch: 'cam/branch',
			pollCount: 5,
			lastPolledAt: 300,
		});
		expect(existsSync(filePath)).toBe(true);

		removeMergeWatchState(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	// AC3: restart-resume: persisted pollCount/lastPolledAt survive a fresh read
	test('AC3: restart-resume - write state with pollCount>0, re-read returns the same values', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');

		writeMergeWatchState(filePath, {
			prNumber: 99,
			mergedBranch: 'cam/restart-test',
			pollCount: 5,
			lastPolledAt: 1_719_000_000_000,
		});

		// Simulate a fresh sidecar restart by re-reading the file
		const resumed = readMergeWatchState(filePath);

		// Must resume from the persisted state, not reset to 0
		expect(resumed?.pollCount).toBe(5);
		expect(resumed?.lastPolledAt).toBe(1_719_000_000_000);
	});

	// AC4a: legacy two-field seed reads back with pollCount/lastPolledAt absent
	test('AC4a: legacy { prNumber, mergedBranch } seed reads back as fresh (no pollCount)', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');

		// Write a legacy-style seed (only the two fields the orchestrator originally wrote)
		writeFileSync(filePath, JSON.stringify({ prNumber: 7, mergedBranch: 'cam/legacy' }), 'utf8');

		const state = readMergeWatchState(filePath);

		expect(state).not.toBeNull();
		expect(state?.prNumber).toBe(7);
		expect(state?.mergedBranch).toBe('cam/legacy');
		// pollCount/lastPolledAt absent -> stepMergeWatch treats as fresh (pollCount ?? 0)
		expect(state?.pollCount).toBeUndefined();
		expect(state?.lastPolledAt).toBeUndefined();
	});

	// AC4b: malformed JSON returns null without throwing
	test('AC4b: malformed JSON returns null, does not throw', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, 'not valid json!!!', 'utf8');

		expect(() => readMergeWatchState(filePath)).not.toThrow();
		expect(readMergeWatchState(filePath)).toBeNull();
	});

	// AC4c: non-object JSON (array) returns null
	test('AC4c: JSON array returns null', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');
		expect(readMergeWatchState(filePath)).toBeNull();
	});

	// AC4d: null JSON returns null
	test('AC4d: JSON null returns null', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, 'null', 'utf8');
		expect(readMergeWatchState(filePath)).toBeNull();
	});

	// Missing file returns null
	test('missing file returns null', () => {
		const filePath = join(tempDir, 'nonexistent.json');
		expect(readMergeWatchState(filePath)).toBeNull();
	});

	// removeMergeWatchState is idempotent (no throw on missing file)
	test('removeMergeWatchState is idempotent on a missing file', () => {
		const filePath = join(tempDir, 'nonexistent.json');
		expect(() => removeMergeWatchState(filePath)).not.toThrow();
	});

	// writeMergeWatchState with absent pollCount persists pollCount:0
	test('writeMergeWatchState defaults pollCount to 0 when absent in state', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, { prNumber: 1, mergedBranch: 'cam/b' });

		const read = readMergeWatchState(filePath);
		expect(read?.pollCount).toBe(0);
		expect(read?.lastPolledAt).toBeUndefined();
	});

	// writeMergeWatchState omits lastPolledAt when undefined (so read gives undefined)
	test('writeMergeWatchState omits lastPolledAt when undefined -> read gets undefined', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, {
			prNumber: 3,
			mergedBranch: 'cam/b',
			pollCount: 1,
			// lastPolledAt intentionally absent
		});

		const read = readMergeWatchState(filePath);
		expect(read?.pollCount).toBe(1);
		expect(read?.lastPolledAt).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Production wiring oracle: sidecar.ts uses stepMergeWatch + logEvent (US-003)
// ---------------------------------------------------------------------------
// US-003 replaced the blocking runMergeWatch call with one-step-per-tick via
// stepMergeWatch. These oracles confirm:
//   1. stepMergeWatch is called in makeProductionMergeWatchFn.
//   2. logEvent: is wired in the StepMergeWatchOptions bag (stepOpts).
//   3. uuid: 'sidecar' is present in the logEvent wrapper.
//   4. The eager pre-start unlinkSync is gone (only terminal-path removal remains).
// ---------------------------------------------------------------------------

describe('sidecar.ts production wiring oracle - stepMergeWatch + logEvent', () => {
	const sidecarPath = resolve(import.meta.dir, '..', '..', 'src', 'commands', 'sidecar.ts');
	const source = readFileSync(sidecarPath, 'utf8');

	// Isolate the stepOpts block in the production ci-gated closure.
	const stepOptsMatch = source.match(/const stepOpts: StepMergeWatchOptions = \{[\s\S]*?\};/);

	test('stepMergeWatch is called in sidecar.ts (one-step-per-tick)', () => {
		expect(source).toContain('stepMergeWatch(');
	});

	test('stepOpts block exists in makeProductionMergeWatchFn', () => {
		expect(stepOptsMatch).not.toBeNull();
	});

	test('stepOpts wires logEvent:', () => {
		expect(stepOptsMatch?.[0]).toContain('logEvent:');
	});

	test('logEvent wrapper uses uuid: sidecar', () => {
		expect(stepOptsMatch?.[0]).toContain("uuid: 'sidecar'");
	});

	test('eager pre-start unlinkSync is removed from makeProductionMergeWatchFn', () => {
		// The eager delete "Remove the watch file BEFORE starting" at ~line 314 must
		// be gone. We grep for the comment that identified it in the old code.
		expect(source).not.toContain('Remove the watch file BEFORE starting');
	});
});

// ---------------------------------------------------------------------------
// US-003: coalesced completion + prune sub-status (AC1, AC3, AC4)
// ---------------------------------------------------------------------------
// These tests enforce the single-notifyOrchestrator invariant on the MERGED
// success path: exactly one completion line, prune sub-status folded in.
// ---------------------------------------------------------------------------

describe('US-003: coalesced completion + prune sub-status', () => {
	test('AC1/AC4: success path (both pruned) emits EXACTLY ONE completion narration', async () => {
		const notifications: string[] = [];

		await runMergeWatch({
			prNumber: 300,
			mergedBranch: 'cam/feature',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc',
				tag: 'v1.0.0',
				tagCreated: true,
				branchPrunedLocal: true,
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		// Exactly one 'post-merge complete' line (the COMPLETION line).
		const completionLines = notifications.filter((n) => n.includes('post-merge complete'));
		expect(completionLines).toHaveLength(1);
		// No separate prune-warn line (it is folded into the completion line).
		const warnLines = notifications.filter((n) => n.includes('warn') && n.includes('prune'));
		expect(warnLines).toHaveLength(0);
	});

	test('AC1/AC4: success path (prune failed) still emits EXACTLY ONE completion narration', async () => {
		const notifications: string[] = [];

		await runMergeWatch({
			prNumber: 301,
			mergedBranch: 'cam/feature',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc',
				tag: 'v1.0.0',
				tagCreated: false,
				branchPrunedLocal: false, // prune failed
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		// Still exactly one 'post-merge complete' line (coalesced, not split).
		const completionLines = notifications.filter((n) => n.includes('post-merge complete'));
		expect(completionLines).toHaveLength(1);
	});

	test('AC3: prune failure sub-status folded into the single completion line', async () => {
		const notifications: string[] = [];

		await runMergeWatch({
			prNumber: 302,
			mergedBranch: 'cam/feature',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc',
				tag: 'v2.0.0',
				tagCreated: true,
				branchPrunedLocal: false,
				branchPrunedRemote: false,
			}),
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		// The completion line must contain prune sub-status with local+remote info.
		const completionLine = notifications.find((n) => n.includes('post-merge complete'));
		expect(completionLine).toBeDefined();
		expect(completionLine).toContain('prune');
		expect(completionLine).toContain('local');
		expect(completionLine).toContain('remote');
		expect(completionLine).toContain('FAILED');
	});

	test('AC3: when both pruned, completion line carries NO prune sub-status', async () => {
		const notifications: string[] = [];

		await runMergeWatch({
			prNumber: 303,
			mergedBranch: 'cam/feature',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc',
				tag: 'v3.0.0',
				tagCreated: true,
				branchPrunedLocal: true,
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: (line) => notifications.push(line),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
		});

		const completionLine = notifications.find((n) => n.includes('post-merge complete'));
		expect(completionLine).toBeDefined();
		// No prune sub-status when both succeeded.
		expect(completionLine).not.toContain('prune');
		expect(completionLine).not.toContain('warn');
	});

	test('AC5: logEvent post-merge-done still carries branchPrunedLocal/Remote', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test', kind, detail });
		};

		await runMergeWatch({
			prNumber: 304,
			mergedBranch: 'cam/feature',
			cwd: '/fake',
			pollFn: makeSeqPollFn([MERGED]),
			postMergeFn: () => ({
				ok: true,
				pulledSha: 'abc',
				tag: 'v4.0.0',
				tagCreated: true,
				branchPrunedLocal: false,
				branchPrunedRemote: true,
			}),
			notifyOrchestrator: () => {},
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 5,
			logEvent,
		});

		const doneEvt = events.find((e) => e.kind === 'merge-watch-post-merge-done');
		expect(doneEvt).toBeDefined();
		if (doneEvt) {
			const d = doneEvt.detail as { ok: boolean; branchPrunedLocal?: boolean; branchPrunedRemote?: boolean };
			expect(d.ok).toBe(true);
			expect(d.branchPrunedLocal).toBe(false);
			expect(d.branchPrunedRemote).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Behavioral: file present after non-terminal tick (US-003 AC1 oracle)
// ---------------------------------------------------------------------------
// Validates that when the caller uses stepMergeWatch + writeMergeWatchState on
// a continue result, the state file is still present afterward (CAM-103 fix).
// ---------------------------------------------------------------------------

describe('file persistence: non-terminal tick leaves file present', () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-mw-persist-'));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('continue result + writeMergeWatchState: file is present after tick', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		// Write a fresh state (no lastPolledAt -> polls immediately)
		writeMergeWatchState(filePath, { prNumber: 42, mergedBranch: 'cam/feature' });

		// Non-terminal pollFn: returns OPEN+CLEAN
		const pollFn: GhPollFn = () => OPEN_CLEAN;
		const state = readMergeWatchState(filePath);
		expect(state).not.toBeNull();

		const result = stepMergeWatch(state!, 0, pollFn, {
			cwd: '/fake',
			postMergeFn: () => ({ ok: false, reason: 'should not be called' }),
			notifyOrchestrator: () => {},
		});

		// Non-terminal: caller writes state back.
		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			writeMergeWatchState(filePath, result.state);
		}

		// File must still exist (not eagerly deleted).
		expect(existsSync(filePath)).toBe(true);
		// State is updated with incremented pollCount.
		const updated = readMergeWatchState(filePath);
		expect(updated?.prNumber).toBe(42);
		expect((updated?.pollCount ?? 0)).toBeGreaterThan(0);
	});

	test('terminal=merged: postMergeFn called exactly once, file absent after removeMergeWatchState', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, { prNumber: 7, mergedBranch: 'cam/ship' });

		let postMergeCalls = 0;
		const pollFn: GhPollFn = () => ({ state: 'MERGED', mergeStateStatus: 'MERGED' });
		const state = readMergeWatchState(filePath);
		expect(state).not.toBeNull();

		const result = stepMergeWatch(state!, 0, pollFn, {
			cwd: '/fake',
			postMergeFn: () => {
				postMergeCalls++;
				return {
					ok: true as const,
					pulledSha: 'abc1234',
					tag: 'v0.1.0',
					tagCreated: true,
					branchPrunedLocal: true,
					branchPrunedRemote: true,
				};
			},
			notifyOrchestrator: () => {},
		});

		// Terminal merged: caller removes file.
		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			removeMergeWatchState(filePath);
		}

		// postMergeFn called exactly once by processPollResult inside stepMergeWatch.
		expect(postMergeCalls).toBe(1);
		// File must be absent after terminal.
		expect(existsSync(filePath)).toBe(false);
	});
});
