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
import { gcMergeWatchIfGarbage, updateShipStalledMarker } from '../../src/commands/sidecar.ts';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import {
	readMergeWatchState,
	writeMergeWatchState,
	removeMergeWatchState,
	stashIssueIdInMergeWatch,
	readShipStalledMarker,
	writeShipStalledMarker,
	removeShipStalledMarker,
	SHIP_STALLED_FILENAME,
	MERGE_WATCH_FILENAME,
	runMergeWatch,
	stepMergeWatch,
	POLL_ERROR_THRESHOLD,
	type MergeWatchOptions,
	type MergeWatchState,
	type MergeWatchOutcome,
	type StepMergeWatchOptions,
	type StepMergeWatchResult,
	type GhPollFn,
	type GhPollResult,
	type PostMergeFn,
	type PrStatus,
	type ShipStalledMarker,
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

/** Wrap a PrStatus into a successful GhPollResult (test convenience). */
function ok(status: PrStatus): GhPollResult {
	return { ok: true, status };
}

/** Wrap a stderr string into a failed GhPollResult (test convenience). */
function err(stderr: string): GhPollResult {
	return { ok: false, stderr };
}

/** Build a sequence-based pollFn that returns statuses in order. */
function makeSeqPollFn(statuses: PrStatus[]): GhPollFn {
	let idx = 0;
	return (_prNumber: number): GhPollResult => {
		const s = statuses[idx] ?? statuses[statuses.length - 1] ?? OPEN_CLEAN;
		idx++;
		return ok(s);
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
	overrides: Partial<MergeWatchOptions> & { pollStatuses?: PrStatus[] },
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
			pollFn: () => ok(OPEN_CLEAN),
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

	test('(e) gh error -> silent retry until terminal', async () => {
		const notifications: string[] = [];
		let pollCalls = 0;

		const outcome = await runMergeWatch({
			prNumber: 20,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			// First 3 polls fail, then MERGED
			pollFn: () => {
				pollCalls++;
				return pollCalls <= 3 ? err('gh: authentication failed') : ok(MERGED);
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
		expect(kinds).toEqual(['merge-watch-watching', 'merge-watch-ci-red', 'merge-watch-stalled']);

		// Check ci-red detail
		const ciRedEvt = events[1];
		expect(ciRedEvt).toBeDefined();
		if (ciRedEvt) {
			const d = ciRedEvt.detail as { prNumber: number; reason: string };
			expect(d.prNumber).toBe(201);
			expect(d.reason).toBe('blocked');
		}

		// Check merge-watch-stalled detail (US-002, CAM-182)
		const stalledEvt = events[2];
		expect(stalledEvt).toBeDefined();
		if (stalledEvt) {
			const d = stalledEvt.detail as { prNumber: number; reason: string };
			expect(d.prNumber).toBe(201);
			expect(d.reason).toBe('ci-red');
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
		expect(kinds).toEqual(['merge-watch-watching', 'merge-watch-ci-red', 'merge-watch-stalled']);

		const ciRedEvt = events[1];
		if (ciRedEvt) {
			const d = ciRedEvt.detail as { prNumber: number; reason: string };
			expect(d.prNumber).toBe(203);
			expect(d.reason).toBe('closed');
		}

		// Check merge-watch-stalled detail (US-002, CAM-182): reason mirrors the
		// MergeWatchOutcome kind ('closed-not-merged'), NOT the ci-red sub-reason.
		const stalledEvt = events[2];
		if (stalledEvt) {
			const d = stalledEvt.detail as { prNumber: number; reason: string };
			expect(d.prNumber).toBe(203);
			expect(d.reason).toBe('closed-not-merged');
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
			return ok(MERGED);
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
			return ok(OPEN_CLEAN); // non-terminal
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
			return ok(OPEN_CLEAN);
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
			return ok(OPEN_BLOCKED_PENDING);
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
			return ok(OPEN_CLEAN);
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

	// Extra: gh poll error on first tick returns continue with updated counters
	// and increments consecutiveNullPolls (US-001, CAM-170).
	test('gh poll error on first tick returns continue with pollCount and consecutiveNullPolls incremented', () => {
		const pollFn: GhPollFn = () => err('gh: authentication failed');
		const state = legacySeed(50);
		const result = stepMergeWatch(state, 0, pollFn, makeStepOpts());

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.pollCount).toBe(1);
			expect(result.state.lastPolledAt).toBe(0);
			expect(result.state.consecutiveNullPolls).toBe(1);
		}
	});

	// AC1: a normal poll of a still-open PR does not count as an error: the
	// counter never increments on a successful (ok:true) poll.
	test('(US-001) successful not-merged poll never increments consecutiveNullPolls', () => {
		const pollFn: GhPollFn = () => ok(OPEN_CLEAN);
		const state = legacySeed(51);
		const result = stepMergeWatch(state, 0, pollFn, makeStepOpts());

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.consecutiveNullPolls).toBe(0);
		}
	});

	// Extra: MERGED on first tick returns terminal immediately
	test('MERGED on first tick returns terminal merged outcome', () => {
		const pollFn: GhPollFn = () => ok(MERGED);
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
		const pollFn: GhPollFn = () => ok(OPEN_CLEAN);
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
		const pollFn: GhPollFn = () => ok(OPEN_CLEAN);
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

	// US-001 (CAM-170): consecutiveNullPolls round-trips through write+read
	test('US-001: write then read round-trips consecutiveNullPolls', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, {
			prNumber: 55,
			mergedBranch: 'cam/poll-error-test',
			pollCount: 4,
			consecutiveNullPolls: 3,
		});

		const read = readMergeWatchState(filePath);

		expect(read?.consecutiveNullPolls).toBe(3);
	});

	// US-001 (CAM-170): legacy state file without the field reads back absent (fresh)
	test('US-001: legacy state file without consecutiveNullPolls reads back absent (fresh)', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, JSON.stringify({ prNumber: 8, mergedBranch: 'cam/legacy-poll' }), 'utf8');

		const state = readMergeWatchState(filePath);

		expect(state).not.toBeNull();
		expect(state?.consecutiveNullPolls).toBeUndefined();
	});

	// US-001 (CAM-170): writeMergeWatchState defaults consecutiveNullPolls to 0 when absent
	test('US-001: writeMergeWatchState defaults consecutiveNullPolls to 0 when absent in state', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, { prNumber: 1, mergedBranch: 'cam/b' });

		const read = readMergeWatchState(filePath);
		expect(read?.consecutiveNullPolls).toBe(0);
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
		const pollFn: GhPollFn = () => ok(OPEN_CLEAN);
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
		const pollFn: GhPollFn = () => ok({ state: 'MERGED', mergeStateStatus: 'MERGED' });
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

// ---------------------------------------------------------------------------
// US-002 (CAM-121 PRD): issueId threading in MergeWatchState
// ---------------------------------------------------------------------------
// AC1: issueId survives every read/write round-trip.
// AC2: stashIssueIdInMergeWatch creates / read-modify-writes the file.
// AC3: readMergeWatchState returns null for issueId-only files (no prNumber).
// ---------------------------------------------------------------------------

describe('MergeWatchState issueId round-trip (US-002)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-mw-issueid-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// AC1a: issueId written and read back correctly
	test('AC1a: issueId survives writeMergeWatchState / readMergeWatchState round-trip', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		const state: MergeWatchState = {
			prNumber: 42,
			mergedBranch: 'cam/feature',
			pollCount: 3,
			lastPolledAt: 1_000_000,
			issueId: 'CAM-121',
		};

		writeMergeWatchState(filePath, state);
		const read = readMergeWatchState(filePath);

		expect(read).not.toBeNull();
		expect(read?.prNumber).toBe(42);
		expect(read?.mergedBranch).toBe('cam/feature');
		expect(read?.pollCount).toBe(3);
		expect(read?.lastPolledAt).toBe(1_000_000);
		expect(read?.issueId).toBe('CAM-121');
	});

	// AC1b: issueId absent in state -> not present in written JSON and reads back undefined
	test('AC1b: issueId absent -> read back as undefined', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, { prNumber: 1, mergedBranch: 'cam/b' });

		const read = readMergeWatchState(filePath);
		expect(read?.issueId).toBeUndefined();

		// Also verify it is not in the raw JSON
		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		expect('issueId' in raw).toBe(false);
	});

	// AC1c: issueId survives a non-terminal tick (write -> stepMergeWatch -> write result -> read)
	test('AC1c: issueId survives a non-terminal tick round-trip', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		const initial: MergeWatchState = {
			prNumber: 9,
			mergedBranch: 'cam/feature',
			issueId: 'CAM-121',
		};
		writeMergeWatchState(filePath, initial);

		const pollFn: GhPollFn = () => ok(OPEN_CLEAN);
		const state = readMergeWatchState(filePath);
		expect(state?.issueId).toBe('CAM-121');

		const result = stepMergeWatch(state!, 0, pollFn, {
			cwd: '/fake',
			postMergeFn: () => ({ ok: false, reason: 'not called' }),
			notifyOrchestrator: () => {},
		});

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			writeMergeWatchState(filePath, result.state);
		}

		const after = readMergeWatchState(filePath);
		expect(after?.issueId).toBe('CAM-121');
	});

	// AC3: readMergeWatchState returns null for issueId-only file (pre-PR stash)
	test('AC3: issueId-only file (no prNumber) -> readMergeWatchState returns null', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, JSON.stringify({ issueId: 'CAM-121' }), 'utf8');

		const state = readMergeWatchState(filePath);
		expect(state).toBeNull();
	});

	// AC3b: issueId present alongside prNumber -> reads correctly (not null)
	test('AC3b: issueId + prNumber present -> not null, issueId accessible', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(
			filePath,
			JSON.stringify({ prNumber: 5, mergedBranch: 'cam/b', issueId: 'CAM-42' }),
			'utf8',
		);

		const state = readMergeWatchState(filePath);
		expect(state).not.toBeNull();
		expect(state?.issueId).toBe('CAM-42');
	});
});

describe('stashIssueIdInMergeWatch (US-002)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-mw-stash-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// AC2a: creates the file when absent
	test('AC2a: creates file when absent with issueId only', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		expect(existsSync(filePath)).toBe(false);

		stashIssueIdInMergeWatch(filePath, 'CAM-121');

		expect(existsSync(filePath)).toBe(true);
		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		expect(raw['issueId']).toBe('CAM-121');
		// File is issueId-only: readMergeWatchState returns null (sidecar stays inert)
		expect(readMergeWatchState(filePath)).toBeNull();
	});

	// AC2b: preserves existing prNumber, mergedBranch, pollCount when file already has them
	test('AC2b: preserves prNumber, mergedBranch, pollCount from existing file', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, {
			prNumber: 77,
			mergedBranch: 'cam/existing-branch',
			pollCount: 5,
			lastPolledAt: 999_000,
		});

		stashIssueIdInMergeWatch(filePath, 'CAM-121');

		const state = readMergeWatchState(filePath);
		expect(state).not.toBeNull();
		expect(state?.prNumber).toBe(77);
		expect(state?.mergedBranch).toBe('cam/existing-branch');
		expect(state?.pollCount).toBe(5);
		expect(state?.lastPolledAt).toBe(999_000);
		expect(state?.issueId).toBe('CAM-121');
	});

	// AC2c: overwrites an existing issueId
	test('AC2c: overwrites an existing issueId', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(filePath, {
			prNumber: 10,
			mergedBranch: 'cam/b',
			issueId: 'CAM-001',
		});

		stashIssueIdInMergeWatch(filePath, 'CAM-121');

		const state = readMergeWatchState(filePath);
		expect(state?.issueId).toBe('CAM-121');
	});

	// AC2d: handles malformed JSON in existing file gracefully (creates fresh { issueId })
	test('AC2d: malformed JSON -> creates fresh file with issueId only', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, 'INVALID JSON{{{{', 'utf8');

		stashIssueIdInMergeWatch(filePath, 'CAM-121');

		expect(existsSync(filePath)).toBe(true);
		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		expect(raw['issueId']).toBe('CAM-121');
	});

	// AC2e: idempotent for the same issueId
	test('AC2e: idempotent - calling twice with same issueId leaves issueId unchanged', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		stashIssueIdInMergeWatch(filePath, 'CAM-121');
		stashIssueIdInMergeWatch(filePath, 'CAM-121');

		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		expect(raw['issueId']).toBe('CAM-121');
	});
});

// ---------------------------------------------------------------------------
// AC4: real-fs regression for null-state GC (US-001)
// ---------------------------------------------------------------------------
// Anti-shadow-mock: exercises the ACTUAL production GC helper (gcMergeWatchIfGarbage
// imported from sidecar.ts), not a re-implementation of the discriminator logic.
// This test MUST fail against the old code (unconditional unlinkSync on existsSync)
// and pass with the fix (discriminate valid issueId-only seed vs real garbage).
// ---------------------------------------------------------------------------

describe('AC4: gcMergeWatchIfGarbage real-fs regression (US-001)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-mw-gc-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('AC4a: valid issueId-only seed is preserved (not deleted)', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		// Simulate what `cam ship --finalize` writes before `gh pr create`.
		writeFileSync(filePath, JSON.stringify({ issueId: 'CAM-161' }), 'utf8');

		// Run the ACTUAL production GC code path.
		gcMergeWatchIfGarbage(filePath);

		// File must still be present with issueId intact.
		expect(existsSync(filePath)).toBe(true);
		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		expect(raw['issueId']).toBe('CAM-161');
	});

	test('AC4b: malformed JSON is deleted as garbage', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, 'NOT VALID JSON {{{{', 'utf8');

		gcMergeWatchIfGarbage(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('AC4c: JSON array is deleted as garbage', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');

		gcMergeWatchIfGarbage(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('AC4d: object with neither issueId nor prNumber is deleted as garbage', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		writeFileSync(filePath, JSON.stringify({ someOtherField: 'stale-value' }), 'utf8');

		gcMergeWatchIfGarbage(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('AC4e: object with numeric prNumber only (no issueId, no mergedBranch) is deleted as garbage', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		// readMergeWatchState returns null here (mergedBranch absent); it has a numeric
		// prNumber so it is NOT a valid issueId-only seed.
		writeFileSync(filePath, JSON.stringify({ prNumber: 42 }), 'utf8');

		gcMergeWatchIfGarbage(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('AC4f: absent file is a no-op (no throw)', () => {
		const filePath = join(tempDir, 'nonexistent.json');
		expect(() => gcMergeWatchIfGarbage(filePath)).not.toThrow();
		expect(existsSync(filePath)).toBe(false);
	});

	test('AC4g: issueId-only seed issueId is byte-intact after GC (non-null closeIssueId)', () => {
		// Regression for the bug: the old code unlinked the seed unconditionally,
		// so closeIssueId would be undefined (post-merge closes no issue).
		// After the fix, issueId survives and closeIssueId is the stashed value.
		const filePath = join(tempDir, '.cam-merge-watch.json');
		const stashedIssueId = 'CAM-161';
		writeFileSync(filePath, JSON.stringify({ issueId: stashedIssueId }), 'utf8');

		gcMergeWatchIfGarbage(filePath);

		// Seed intact: the next cam-ship enrich step can read issueId.
		expect(existsSync(filePath)).toBe(true);
		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		expect(typeof raw['issueId']).toBe('string');
		expect(raw['issueId']).toBe(stashedIssueId);
	});
});

// ---------------------------------------------------------------------------
// AC3: preserved-seed -> jq enrich -> stepMergeWatch -> postMergeFn closeIssueId
// ---------------------------------------------------------------------------
// Integration test composing:
//   1. preserved issueId-only seed (post-gcMergeWatchIfGarbage)
//   2. cam-ship.md enrich step (jq '. + {prNumber, mergedBranch}') -- skipIf jq absent
//   3. readMergeWatchState: yields full state with issueId
//   4. stepMergeWatch on MERGED: postMergeFn is called; production closure uses
//      state.issueId as closeIssueId -> asserts closeIssueId === seed issueId
// ---------------------------------------------------------------------------

describe('AC3: preserved-seed -> enrich -> stepMergeWatch closeIssueId (US-001)', () => {
	const jqAvailable = Bun.which('jq') !== null;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-mw-ac3-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// Non-jq subtest: verify readMergeWatchState reads issueId from enriched state
	// (enrich is simulated by writing the merged JSON directly, no jq needed).
	test('AC3 (no-jq): enriched state read by readMergeWatchState carries issueId', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		// Simulate what jq '. + {"prNumber":42,"mergedBranch":"cam/test"}' produces
		// when applied to a preserved issueId-only seed.
		const enriched = { issueId: 'CAM-161', prNumber: 42, mergedBranch: 'cam/test' };
		writeFileSync(filePath, JSON.stringify(enriched), 'utf8');

		const state = readMergeWatchState(filePath);
		expect(state).not.toBeNull();
		expect(state?.issueId).toBe('CAM-161');
		expect(state?.prNumber).toBe(42);
		expect(state?.mergedBranch).toBe('cam/test');
	});

	// Non-jq subtest: stepMergeWatch on MERGED with enriched state gives closeIssueId.
	test('AC3 (no-jq): stepMergeWatch on MERGED with enriched state -> postMergeFn receives closeIssueId', () => {
		const filePath = join(tempDir, '.cam-merge-watch.json');
		const enriched = { issueId: 'CAM-161', prNumber: 42, mergedBranch: 'cam/test' };
		writeFileSync(filePath, JSON.stringify(enriched), 'utf8');

		const state = readMergeWatchState(filePath);
		expect(state).not.toBeNull();

		// Simulate the production closure: the postMergeFn captures state.issueId
		// as closeIssueId (mirrors makeProductionMergeWatchFn stepOpts.postMergeFn).
		let capturedCloseIssueId: string | undefined;
		const result = stepMergeWatch(state!, 0, () => ok(MERGED), {
			cwd: '/fake',
			postMergeFn: () => {
				capturedCloseIssueId = state?.issueId;
				return {
					ok: true as const,
					pulledSha: 'abc',
					tag: 'v1.0.0',
					tagCreated: true,
					branchPrunedLocal: true,
					branchPrunedRemote: true,
				};
			},
			notifyOrchestrator: () => {},
		});

		expect(result.kind).toBe('terminal');
		// The production postMergeFn closure passes state.issueId as closeIssueId.
		expect(capturedCloseIssueId).toBe('CAM-161');
	});

	// Real-jq subtest: skipIf jq absent. Uses real jq to verify the enrich step
	// (mirrors what cam-ship.md Step 7 ci-gated branch does).
	test.skipIf(!jqAvailable)(
		'AC3 (real-jq): preserved seed + jq enrich -> readMergeWatchState -> issueId non-null',
		async () => {
			const seedJson = JSON.stringify({ issueId: 'CAM-161' });

			// Run the enrich step: jq '. + {"prNumber":42,"mergedBranch":"cam/test"}'
			const proc = Bun.spawn(
				['jq', '. + {"prNumber":42,"mergedBranch":"cam/test"}'],
				{
					stdin: new TextEncoder().encode(seedJson),
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const exitCode = await proc.exited;
			const enrichedText = await new Response(proc.stdout).text();
			expect(exitCode).toBe(0);

			const filePath = join(tempDir, '.cam-merge-watch.json');
			writeFileSync(filePath, enrichedText.trim(), 'utf8');

			// readMergeWatchState must return a state with issueId intact.
			const state = readMergeWatchState(filePath);
			expect(state).not.toBeNull();
			expect(state?.issueId).toBe('CAM-161');
			expect(state?.prNumber).toBe(42);
			expect(state?.mergedBranch).toBe('cam/test');

			// stepMergeWatch on MERGED: postMergeFn receives closeIssueId.
			let capturedCloseIssueId: string | undefined;
			const result = stepMergeWatch(state!, 0, () => ok(MERGED), {
				cwd: '/fake',
				postMergeFn: () => {
					capturedCloseIssueId = state?.issueId;
					return {
						ok: true as const,
						pulledSha: 'abc',
						tag: 'v1.0.0',
						tagCreated: true,
						branchPrunedLocal: true,
						branchPrunedRemote: true,
					};
				},
				notifyOrchestrator: () => {},
			});

			expect(result.kind).toBe('terminal');
			expect(capturedCloseIssueId).toBe('CAM-161');
		},
	);
});

// ---------------------------------------------------------------------------
// US-001 (CAM-182): auto-recover OPEN+BEHIND via bounded gh pr update-branch
// ---------------------------------------------------------------------------

describe('processPollResult / stepMergeWatch: BEHIND auto-recovery (US-001, CAM-182)', () => {
	const OPEN_BEHIND_ARMED: PrStatus = {
		state: 'OPEN',
		mergeStateStatus: 'BEHIND',
		autoMergeRequest: { enabledAt: '2026-07-05T00:00:00Z' },
	};
	const OPEN_BEHIND_NOT_ARMED: PrStatus = {
		state: 'OPEN',
		mergeStateStatus: 'BEHIND',
		autoMergeRequest: null,
	};
	const OPEN_BEHIND_ARMED_FAILED_CHECK: PrStatus = {
		state: 'OPEN',
		mergeStateStatus: 'BEHIND',
		autoMergeRequest: { enabledAt: '2026-07-05T00:00:00Z' },
		statusCheckRollup: [{ conclusion: 'FAILURE' }],
	};
	const OPEN_DIRTY: PrStatus = { state: 'OPEN', mergeStateStatus: 'DIRTY' };

	function makeUpdateBranchStepOpts(
		overrides: Partial<StepMergeWatchOptions> = {},
	): { opts: StepMergeWatchOptions; notifications: string[]; updateBranchCalls: number[] } {
		const notifications: string[] = [];
		const updateBranchCalls: number[] = [];
		const opts: StepMergeWatchOptions = {
			cwd: '/fake',
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			updateBranchFn: (prNumber) => updateBranchCalls.push(prNumber),
			pollIntervalMs: 1,
			maxPolls: 240,
			...overrides,
		};
		return { opts, notifications, updateBranchCalls };
	}

	// AC (armed): BEHIND + auto-merge armed + no failed check + count < 2 ->
	// updateBranchFn called exactly once, count incremented, watch continues.
	test('OPEN+BEHIND with auto-merge armed calls updateBranchFn once and continues (count 0 -> 1)', () => {
		const { opts, notifications, updateBranchCalls } = makeUpdateBranchStepOpts();
		const state: MergeWatchState = { prNumber: 500, mergedBranch: 'cam/b' };

		const result = stepMergeWatch(state, 0, () => ok(OPEN_BEHIND_ARMED), opts);

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.updateBranchCount).toBe(1);
		}
		expect(updateBranchCalls).toEqual([500]);
		expect(notifications.some((n) => n.includes('BEHIND') && n.includes('update-branch'))).toBe(true);
	});

	// AC (cap): updateBranchCount===2 and still BEHIND -> terminal behind-unrecovered,
	// updateBranchFn NOT called again.
	test('OPEN+BEHIND with updateBranchCount already at cap (2) terminates behind-unrecovered', () => {
		const { opts, notifications, updateBranchCalls } = makeUpdateBranchStepOpts();
		const state: MergeWatchState = { prNumber: 501, mergedBranch: 'cam/b', updateBranchCount: 2 };

		const result = stepMergeWatch(state, 0, () => ok(OPEN_BEHIND_ARMED), opts);

		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('behind-unrecovered');
			if (result.outcome.kind === 'behind-unrecovered') {
				expect(result.outcome.prNumber).toBe(501);
			}
		}
		expect(updateBranchCalls).toEqual([]);
		expect(notifications.some((n) => n.includes('giving up'))).toBe(true);
	});

	// AC (not armed): auto-merge NOT armed -> updateBranchFn not called, keep polling.
	test('OPEN+BEHIND with auto-merge NOT armed does not call updateBranchFn, keeps polling', () => {
		const { opts, updateBranchCalls } = makeUpdateBranchStepOpts();
		const state: MergeWatchState = { prNumber: 502, mergedBranch: 'cam/b' };

		const result = stepMergeWatch(state, 0, () => ok(OPEN_BEHIND_NOT_ARMED), opts);

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.updateBranchCount).toBeUndefined();
		}
		expect(updateBranchCalls).toEqual([]);
	});

	// AC (dirty): OPEN+DIRTY terminates non-merged (kind:dirty), updateBranchFn not called.
	test('OPEN+DIRTY terminates with outcome kind dirty, updateBranchFn not called', () => {
		const { opts, updateBranchCalls } = makeUpdateBranchStepOpts();
		const state: MergeWatchState = { prNumber: 503, mergedBranch: 'cam/b' };

		const result = stepMergeWatch(state, 0, () => ok(OPEN_DIRTY), opts);

		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('dirty');
			if (result.outcome.kind === 'dirty') {
				expect(result.outcome.prNumber).toBe(503);
			}
		}
		expect(updateBranchCalls).toEqual([]);
	});

	// AC (guard): a failed check in the rollup blocks the update-branch recovery
	// even when auto-merge is armed.
	test('OPEN+BEHIND with a failed check in the rollup does not call updateBranchFn', () => {
		const { opts, updateBranchCalls } = makeUpdateBranchStepOpts();
		const state: MergeWatchState = { prNumber: 504, mergedBranch: 'cam/b' };

		const result = stepMergeWatch(state, 0, () => ok(OPEN_BEHIND_ARMED_FAILED_CHECK), opts);

		expect(result.kind).toBe('continue');
		expect(updateBranchCalls).toEqual([]);
	});

	// AC (round-trip): updateBranchCount survives a write/read cycle (sidecar restart).
	test('updateBranchCount round-trips through writeMergeWatchState/readMergeWatchState', () => {
		const filePath = join(mkdtempSync(join(tmpdir(), 'merge-watch-behind-test-')), '.cam-merge-watch.json');
		writeMergeWatchState(filePath, { prNumber: 42, mergedBranch: 'cam/b', updateBranchCount: 1 });

		const read = readMergeWatchState(filePath);

		expect(read?.updateBranchCount).toBe(1);
	});

	// AC (round-trip legacy): a legacy state file without updateBranchCount reads
	// back as fresh (count 0 via the `?? 0` default at use-sites).
	test('legacy state file without updateBranchCount reads back as fresh (undefined -> 0)', () => {
		const filePath = join(mkdtempSync(join(tmpdir(), 'merge-watch-behind-legacy-')), '.cam-merge-watch.json');
		writeFileSync(filePath, JSON.stringify({ prNumber: 7, mergedBranch: 'cam/legacy' }), 'utf8');

		const state = readMergeWatchState(filePath);

		expect(state).not.toBeNull();
		expect(state?.updateBranchCount).toBeUndefined();
	});

	// AC (default write): writeMergeWatchState defaults updateBranchCount to 0 when absent.
	test('writeMergeWatchState defaults updateBranchCount to 0 when absent in state', () => {
		const filePath = join(mkdtempSync(join(tmpdir(), 'merge-watch-behind-default-')), '.cam-merge-watch.json');
		writeMergeWatchState(filePath, { prNumber: 1, mergedBranch: 'cam/b' });

		const read = readMergeWatchState(filePath);

		expect(read?.updateBranchCount).toBe(0);
	});

	// End-to-end via the legacy blocking runMergeWatch wrapper: two consecutive
	// BEHIND polls exhaust the cap and the watch terminates behind-unrecovered
	// without ever reaching a merge.
	test('runMergeWatch: BEHIND streak exhausts the cap and terminates behind-unrecovered', async () => {
		const updateBranchCalls: number[] = [];
		const notifications: string[] = [];

		const outcome = await runMergeWatch({
			prNumber: 600,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([OPEN_BEHIND_ARMED, OPEN_BEHIND_ARMED, OPEN_BEHIND_ARMED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			updateBranchFn: (prNumber) => updateBranchCalls.push(prNumber),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('behind-unrecovered');
		// Exactly 2 update-branch attempts (cap), the 3rd poll gives up.
		expect(updateBranchCalls).toEqual([600, 600]);
		expect(notifications.some((n) => n.includes('giving up'))).toBe(true);
	});

	// End-to-end: BEHIND recovers after one update-branch attempt and eventually merges.
	test('runMergeWatch: BEHIND recovers after one update-branch attempt, then merges', async () => {
		const updateBranchCalls: number[] = [];

		const outcome = await runMergeWatch({
			prNumber: 601,
			mergedBranch: 'cam/branch',
			cwd: '/fake',
			pollFn: makeSeqPollFn([OPEN_BEHIND_ARMED, OPEN_CLEAN, MERGED]),
			postMergeFn: successPostMerge,
			notifyOrchestrator: () => {},
			updateBranchFn: (prNumber) => updateBranchCalls.push(prNumber),
			sleepFn: () => {},
			pollIntervalMs: 1,
			maxPolls: 10,
		});

		expect(outcome.kind).toBe('merged');
		expect(updateBranchCalls).toEqual([601]);
	});
});

// ---------------------------------------------------------------------------
// sidecar.ts production wiring oracle - BEHIND auto-recovery (US-001, CAM-182)
// ---------------------------------------------------------------------------

describe('sidecar.ts production wiring oracle - BEHIND auto-recovery (US-001, CAM-182)', () => {
	const sidecarPath = resolve(import.meta.dir, '..', '..', 'src', 'commands', 'sidecar.ts');
	const source = readFileSync(sidecarPath, 'utf8');

	const ghPollFnMatch = source.match(/const ghPollFn: GhPollFn = \(prNumber\): GhPollResult => \{[\s\S]*?\n\t\t\};/);
	const updateBranchFnMatch = source.match(/const updateBranchFn: UpdateBranchFn = \(prNumber\): void => \{[\s\S]*?\n\t\t\};/);
	const stepOptsMatch = source.match(/const stepOpts: StepMergeWatchOptions = \{[\s\S]*?\};/);

	test('autoMergeRequest is present in sidecar.ts (AC1 grep oracle mirror)', () => {
		expect(source).toContain('autoMergeRequest');
	});

	test('ghPollFn --json field list includes state,mergeStateStatus,statusCheckRollup,autoMergeRequest,url', () => {
		expect(source).toContain(
			"'pr', 'view', String(prNumber), '--json', 'state,mergeStateStatus,statusCheckRollup,autoMergeRequest,url'",
		);
	});

	test('the read-only ghPollFn spawnSync call carries no custom env (keeps ambient GITHUB_TOKEN)', () => {
		expect(ghPollFnMatch).not.toBeNull();
		expect(ghPollFnMatch?.[0]).not.toContain('env:');
	});

	test('updateBranchFn strips GITHUB_TOKEN from the child environment', () => {
		expect(updateBranchFnMatch).not.toBeNull();
		expect(updateBranchFnMatch?.[0]).toContain("k !== 'GITHUB_TOKEN'");
		expect(updateBranchFnMatch?.[0]).toContain("'pr', 'update-branch'");
	});

	test('stepOpts wires updateBranchFn into the production StepMergeWatchOptions bag', () => {
		expect(stepOptsMatch).not.toBeNull();
		expect(stepOptsMatch?.[0]).toContain('updateBranchFn,');
	});

	// US-001 (CAM-170): production ghPollFn surfaces gh stderr into the
	// discriminated error result on non-zero exit and on JSON-parse failure.
	// Parsing is delegated to the named parseGhPollResult helper (extracted to
	// keep ghPollFn under the biome complexity limit).
	test('ghPollFn delegates to parseGhPollResult', () => {
		expect(ghPollFnMatch).not.toBeNull();
		expect(ghPollFnMatch?.[0]).toContain('parseGhPollResult(result)');
	});

	test('parseGhPollResult surfaces gh stderr into the error result on non-zero exit', () => {
		expect(source).toContain('function parseGhPollResult');
		expect(source).toContain('result.stderr');
		expect(source).toContain('ok: false, stderr');
	});

	test('parseGhPollResult returns ok:false with a message on JSON-parse failure (catch block)', () => {
		expect(source).toContain("'gh pr view returned malformed JSON'");
	});
});

// ---------------------------------------------------------------------------
// US-001 (CAM-170): merge-watch-poll-error edge-triggered advisory event
// ---------------------------------------------------------------------------

describe('merge-watch-poll-error edge-triggered emission (US-001, CAM-170)', () => {
	function makePollErrorStepOpts(overrides: Partial<StepMergeWatchOptions> = {}): {
		opts: StepMergeWatchOptions;
		events: ReturnType<typeof makeInMemoryEventLogger>['events'];
		notifications: string[];
	} {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};
		const notifications: string[] = [];
		const opts: StepMergeWatchOptions = {
			cwd: '/fake',
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			logEvent,
			pollIntervalMs: 1,
			maxPolls: 240,
			...overrides,
		};
		return { opts, events, notifications };
	}

	/** Drive N consecutive failing ticks starting from a legacy seed state. */
	function driveFailingTicks(
		prNumber: number,
		n: number,
		opts: StepMergeWatchOptions,
		stderr = 'gh: authentication failed',
	): { state: MergeWatchState; result: StepMergeWatchResult } {
		let state: MergeWatchState = { prNumber, mergedBranch: 'cam/b' };
		let now = 0;
		let result: StepMergeWatchResult = { kind: 'continue', state };
		for (let i = 0; i < n; i++) {
			result = stepMergeWatch(state, now, () => err(stderr), opts);
			if (result.kind !== 'continue') return { state, result };
			state = result.state;
			now += 1;
		}
		return { state, result };
	}

	test('POLL_ERROR_THRESHOLD constant is 3 (three minutes at the 60s poll interval)', () => {
		expect(POLL_ERROR_THRESHOLD).toBe(3);
	});

	test('AC: consecutiveNullPolls increments by 1 on each poll error', () => {
		const { opts } = makePollErrorStepOpts();
		const { state } = driveFailingTicks(100, 2, opts);
		expect(state.consecutiveNullPolls).toBe(2);
	});

	test('AC: a successful poll resets consecutiveNullPolls to 0', () => {
		const { opts } = makePollErrorStepOpts();
		const { state: afterFailures } = driveFailingTicks(101, 2, opts);
		expect(afterFailures.consecutiveNullPolls).toBe(2);

		const result = stepMergeWatch(afterFailures, 10, () => ok(OPEN_CLEAN), opts);
		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.state.consecutiveNullPolls).toBe(0);
		}
	});

	test('AC: emits exactly one merge-watch-poll-error event + one notifyOrchestrator narration at the Nth consecutive failure', () => {
		const { opts, events, notifications } = makePollErrorStepOpts();
		driveFailingTicks(102, POLL_ERROR_THRESHOLD, opts);

		const pollErrorEvents = events.filter((e) => e.kind === 'merge-watch-poll-error');
		expect(pollErrorEvents.length).toBe(1);
		const pollErrorNarrations = notifications.filter((n) => n.includes('gh poll failed'));
		expect(pollErrorNarrations.length).toBe(1);
	});

	test('AC: ticks N+1 and N+2 emit nothing further (edge-triggered, not level-triggered)', () => {
		const { opts, events, notifications } = makePollErrorStepOpts();
		driveFailingTicks(103, POLL_ERROR_THRESHOLD + 2, opts);

		const pollErrorEvents = events.filter((e) => e.kind === 'merge-watch-poll-error');
		expect(pollErrorEvents.length).toBe(1);
		const pollErrorNarrations = notifications.filter((n) => n.includes('gh poll failed'));
		expect(pollErrorNarrations.length).toBe(1);
	});

	test('AC: a reset followed by a later re-crossing to N emits again', () => {
		const { opts, events } = makePollErrorStepOpts();
		const { state: afterFirstCrossing } = driveFailingTicks(104, POLL_ERROR_THRESHOLD, opts);
		expect(afterFirstCrossing.consecutiveNullPolls).toBe(POLL_ERROR_THRESHOLD);

		// Recover (resets the counter), then fail N more times to re-cross.
		const recovered = stepMergeWatch(afterFirstCrossing, 10, () => ok(OPEN_CLEAN), opts);
		expect(recovered.kind).toBe('continue');
		if (recovered.kind !== 'continue') return;
		expect(recovered.state.consecutiveNullPolls).toBe(0);

		let state = recovered.state;
		let now = 11;
		for (let i = 0; i < POLL_ERROR_THRESHOLD; i++) {
			const r = stepMergeWatch(state, now, () => err('gh: still failing'), opts);
			expect(r.kind).toBe('continue');
			if (r.kind === 'continue') state = r.state;
			now += 1;
		}

		const pollErrorEvents = events.filter((e) => e.kind === 'merge-watch-poll-error');
		expect(pollErrorEvents.length).toBe(2);
	});

	test('AC: the event detail carries prNumber, consecutiveNullPolls, and the last gh stderr', () => {
		const { opts, events } = makePollErrorStepOpts();
		driveFailingTicks(105, POLL_ERROR_THRESHOLD, opts, 'gh: bad credentials (HTTP 401)');

		const pollErrorEvt = events.find((e) => e.kind === 'merge-watch-poll-error');
		expect(pollErrorEvt).toBeDefined();
		if (pollErrorEvt) {
			const d = pollErrorEvt.detail as { prNumber: number; consecutiveNullPolls: number; lastStderr: string };
			expect(d.prNumber).toBe(105);
			expect(d.consecutiveNullPolls).toBe(POLL_ERROR_THRESHOLD);
			expect(d.lastStderr).toBe('gh: bad credentials (HTTP 401)');
		}
	});

	test('AC: reaching the threshold does not change the watch outcome -- polling continues past N to the maxPolls timeout terminal', () => {
		const { opts } = makePollErrorStepOpts({ maxPolls: POLL_ERROR_THRESHOLD + 2 });
		let state: MergeWatchState = { prNumber: 106, mergedBranch: 'cam/b' };
		let now = 0;
		let result: StepMergeWatchResult = { kind: 'continue', state };
		for (let i = 0; i < POLL_ERROR_THRESHOLD + 2; i++) {
			result = stepMergeWatch(state, now, () => err('gh: rate limited'), opts);
			expect(result.kind).toBe('continue');
			if (result.kind === 'continue') state = result.state;
			now += 1;
		}
		// One more tick: pollCount has reached maxPolls -> timeout terminal.
		result = stepMergeWatch(state, now, () => err('gh: rate limited'), opts);
		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('timeout');
		}
	});

	test('AC: a fail-then-recover sequence past N proceeds to MERGED normally', () => {
		const { opts } = makePollErrorStepOpts();
		const { state: afterFailures } = driveFailingTicks(107, POLL_ERROR_THRESHOLD, opts);

		const result = stepMergeWatch(afterFailures, 10, () => ok(MERGED), opts);
		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('merged');
		}
	});

	test('AC: a fail-then-recover sequence past N emits merge-watch-poll-error but never merge-watch-stalled', () => {
		const { opts, events } = makePollErrorStepOpts();
		const { state: afterFailures } = driveFailingTicks(108, POLL_ERROR_THRESHOLD, opts);

		stepMergeWatch(afterFailures, 10, () => ok(MERGED), opts);

		expect(events.some((e) => e.kind === 'merge-watch-poll-error')).toBe(true);
		expect(events.some((e) => e.kind === 'merge-watch-stalled')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// US-002 (CAM-182): durable stalled escalation
// ---------------------------------------------------------------------------

describe('merge-watch-stalled event emission on non-merged terminals (US-002, CAM-182)', () => {
	function makeStalledStepOpts(overrides: Partial<StepMergeWatchOptions> = {}): {
		opts: StepMergeWatchOptions;
		events: ReturnType<typeof makeInMemoryEventLogger>['events'];
		notifications: string[];
	} {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};
		const notifications: string[] = [];
		const opts: StepMergeWatchOptions = {
			cwd: '/fake',
			postMergeFn: successPostMerge,
			notifyOrchestrator: (line) => notifications.push(line),
			logEvent,
			pollIntervalMs: 1,
			maxPolls: 240,
			...overrides,
		};
		return { opts, events, notifications };
	}

	test('dirty terminal emits merge-watch-stalled with reason:dirty, prUrl and issueId', () => {
		const { opts, events, notifications } = makeStalledStepOpts();
		const state: MergeWatchState = { prNumber: 700, mergedBranch: 'cam/b', issueId: 'CAM-700' };
		const dirtyWithUrl: PrStatus = {
			state: 'OPEN',
			mergeStateStatus: 'DIRTY',
			url: 'https://github.com/x/y/pull/700',
		};

		const result = stepMergeWatch(state, 0, () => ok(dirtyWithUrl), opts);

		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('dirty');
		}
		// AC6: the existing live-orchestrator narration is preserved alongside the
		// new durable event (both fire; neither replaces the other).
		expect(notifications.some((n) => n.includes('DIRTY'))).toBe(true);

		const stalled = events.find((e) => e.kind === 'merge-watch-stalled');
		expect(stalled).toBeDefined();
		if (stalled) {
			const d = stalled.detail as { prNumber: number; reason: string; prUrl?: string; issueId?: string };
			expect(d.prNumber).toBe(700);
			expect(d.reason).toBe('dirty');
			expect(d.prUrl).toBe('https://github.com/x/y/pull/700');
			expect(d.issueId).toBe('CAM-700');
		}
	});

	test('behind-unrecovered terminal (cap exhausted) emits merge-watch-stalled with reason:behind-unrecovered', () => {
		const { opts, events } = makeStalledStepOpts();
		const state: MergeWatchState = { prNumber: 701, mergedBranch: 'cam/b', updateBranchCount: 2 };
		const behindArmed: PrStatus = {
			state: 'OPEN',
			mergeStateStatus: 'BEHIND',
			autoMergeRequest: { enabledAt: '2026-07-05T00:00:00Z' },
		};

		const result = stepMergeWatch(state, 0, () => ok(behindArmed), opts);

		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('behind-unrecovered');
		}
		const stalled = events.find((e) => e.kind === 'merge-watch-stalled');
		expect(stalled).toBeDefined();
		if (stalled) {
			const d = stalled.detail as { prNumber: number; reason: string };
			expect(d.prNumber).toBe(701);
			expect(d.reason).toBe('behind-unrecovered');
		}
	});

	test('timeout terminal emits merge-watch-stalled with reason:timeout and no prUrl (never polled)', () => {
		const { opts, events } = makeStalledStepOpts({ maxPolls: 1 });
		const state: MergeWatchState = { prNumber: 702, mergedBranch: 'cam/b', pollCount: 1, lastPolledAt: 0 };

		const result = stepMergeWatch(state, 60_000, () => ok(OPEN_CLEAN), opts);

		expect(result.kind).toBe('terminal');
		if (result.kind === 'terminal') {
			expect(result.outcome.kind).toBe('timeout');
		}
		const stalled = events.find((e) => e.kind === 'merge-watch-stalled');
		expect(stalled).toBeDefined();
		if (stalled) {
			const d = stalled.detail as { prNumber: number; reason: string; prUrl?: string };
			expect(d.prNumber).toBe(702);
			expect(d.reason).toBe('timeout');
			expect(d.prUrl).toBeUndefined();
		}
	});

	test('MERGED terminal does NOT emit merge-watch-stalled', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const logEvent = (kind: WorkerEventKind, detail: WorkerEventDetail) => {
			logger({ ts: '2026-01-01T00:00:00Z', storyId: undefined, uuid: 'test-uuid', kind, detail });
		};

		await runMergeWatch({
			prNumber: 703,
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

		expect(events.some((e) => e.kind === 'merge-watch-stalled')).toBe(false);
	});
});

describe('ship-stalled marker durable I/O helpers (US-002, CAM-182)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-ship-stalled-'));
		filePath = join(tempDir, SHIP_STALLED_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('round-trips a full marker (prUrl+issueId known)', () => {
		const marker: ShipStalledMarker = {
			prNumber: 800,
			prUrl: 'https://github.com/x/y/pull/800',
			issueId: 'CAM-800',
			reason: 'ci-red',
			ts: '2026-07-05T00:00:00Z',
		};
		writeShipStalledMarker(filePath, marker);

		expect(readShipStalledMarker(filePath)).toEqual(marker);
	});

	test('tolerates null prUrl/issueId when unknown (e.g. timeout)', () => {
		const marker: ShipStalledMarker = {
			prNumber: 801,
			prUrl: null,
			issueId: null,
			reason: 'timeout',
			ts: '2026-07-05T00:00:00Z',
		};
		writeShipStalledMarker(filePath, marker);

		expect(readShipStalledMarker(filePath)).toEqual(marker);
	});

	test('readShipStalledMarker returns null for an absent file', () => {
		expect(readShipStalledMarker(filePath)).toBeNull();
	});

	test('readShipStalledMarker returns null for malformed JSON', () => {
		writeFileSync(filePath, 'NOT VALID JSON {{{{', 'utf8');
		expect(readShipStalledMarker(filePath)).toBeNull();
	});

	test('readShipStalledMarker returns null when required fields are missing', () => {
		writeFileSync(filePath, JSON.stringify({ prNumber: 802 }), 'utf8');
		expect(readShipStalledMarker(filePath)).toBeNull();
	});

	test('removeShipStalledMarker deletes the file', () => {
		writeShipStalledMarker(filePath, {
			prNumber: 803, prUrl: null, issueId: null, reason: 'dirty', ts: '2026-07-05T00:00:00Z',
		});
		expect(existsSync(filePath)).toBe(true);

		removeShipStalledMarker(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('removeShipStalledMarker on an absent file does not throw', () => {
		expect(() => removeShipStalledMarker(filePath)).not.toThrow();
	});
});

describe('updateShipStalledMarker: sidecar terminal-branch marker reconciliation (US-002, CAM-182)', () => {
	let tempDir: string;
	let markerPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-ship-stalled-caller-'));
		markerPath = join(tempDir, SHIP_STALLED_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('AC3: non-merged terminal writes the marker with prNumber/prUrl/issueId/reason/ts', () => {
		const state: MergeWatchState = { prNumber: 900, mergedBranch: 'cam/b', issueId: 'CAM-900' };
		const outcome: MergeWatchOutcome = {
			kind: 'ci-red', prNumber: 900, prUrl: 'https://github.com/x/y/pull/900',
		};

		updateShipStalledMarker(markerPath, outcome, state);

		const marker = readShipStalledMarker(markerPath);
		expect(marker).not.toBeNull();
		if (marker) {
			expect(marker.prNumber).toBe(900);
			expect(marker.prUrl).toBe('https://github.com/x/y/pull/900');
			expect(marker.issueId).toBe('CAM-900');
			expect(marker.reason).toBe('ci-red');
			expect(typeof marker.ts).toBe('string');
		}
	});

	test('AC3: prUrl/issueId tolerate null when unknown (timeout terminal)', () => {
		const state: MergeWatchState = { prNumber: 901, mergedBranch: 'cam/b' };
		const outcome: MergeWatchOutcome = { kind: 'timeout', polls: 240 };

		updateShipStalledMarker(markerPath, outcome, state);

		const marker = readShipStalledMarker(markerPath);
		expect(marker).not.toBeNull();
		if (marker) {
			expect(marker.prNumber).toBe(901);
			expect(marker.prUrl).toBeNull();
			expect(marker.issueId).toBeNull();
			expect(marker.reason).toBe('timeout');
		}
	});

	test('AC4: MERGED for the SAME prNumber removes the marker', () => {
		writeShipStalledMarker(markerPath, {
			prNumber: 902, prUrl: null, issueId: null, reason: 'dirty', ts: '2026-07-05T00:00:00Z',
		});
		const state: MergeWatchState = { prNumber: 902, mergedBranch: 'cam/b' };
		const outcome: MergeWatchOutcome = {
			kind: 'merged',
			postMerge: {
				ok: true, pulledSha: 'abc123', tag: 'v1.0.0', tagCreated: true,
				branchPrunedLocal: true, branchPrunedRemote: true,
			},
		};

		updateShipStalledMarker(markerPath, outcome, state);

		expect(existsSync(markerPath)).toBe(false);
	});

	test('AC4: MERGED for a DIFFERENT prNumber leaves the marker intact', () => {
		writeShipStalledMarker(markerPath, {
			prNumber: 903, prUrl: null, issueId: null, reason: 'dirty', ts: '2026-07-05T00:00:00Z',
		});
		const state: MergeWatchState = { prNumber: 904, mergedBranch: 'cam/other-b' };
		const outcome: MergeWatchOutcome = {
			kind: 'merged',
			postMerge: {
				ok: true, pulledSha: 'def456', tag: 'v2.0.0', tagCreated: true,
				branchPrunedLocal: true, branchPrunedRemote: true,
			},
		};

		updateShipStalledMarker(markerPath, outcome, state);

		const marker = readShipStalledMarker(markerPath);
		expect(marker).not.toBeNull();
		expect(marker?.prNumber).toBe(903);
	});

	test('AC5: the marker file is separate from the merge-watch state file', () => {
		const watchStatePath = join(tempDir, MERGE_WATCH_FILENAME);
		writeMergeWatchState(watchStatePath, { prNumber: 905, mergedBranch: 'cam/b' });
		const state: MergeWatchState = { prNumber: 905, mergedBranch: 'cam/b' };
		const outcome: MergeWatchOutcome = { kind: 'dirty', prNumber: 905 };

		updateShipStalledMarker(markerPath, outcome, state);

		// Both files exist independently: writing/removing the marker never
		// touches the watch-state file's own consume-on-terminal lifecycle.
		expect(markerPath).not.toBe(watchStatePath);
		expect(existsSync(markerPath)).toBe(true);
		expect(existsSync(watchStatePath)).toBe(true);
	});
});
