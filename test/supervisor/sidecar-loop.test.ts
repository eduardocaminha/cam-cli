// test/supervisor/sidecar-loop.test.ts
//
// Unit tests for runSidecarLoop (US-FIX-002 sidecar model).
//
// Coverage:
//   1. Idles (does NOT call runSupervisor) when active:false.
//   2. Idles (does NOT call runSupervisor) when active is undefined (no state file).
//   3. Calls runSupervisor when active:true with pending stories.
//   4. Sets active:false after runSupervisor returns terminal.
//   5. Stays idle when active:true but hasPendingStories returns false.
//   6. Stays idle (does NOT call runSupervisor) when the lock is busy.
//   7. Existing guards remain intact: the injected runSupervisorFn is exactly
//      the exported runSupervisor (not a re-export or wrapper that drops options).
//   8. Releases the lock even when runSupervisorFn throws.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../../src/supervisor/loop.ts';
import { makeHasPendingStories } from '../../src/commands/sidecar.ts';
import {
	stepMergeWatch,
	readMergeWatchState,
	writeMergeWatchState,
	removeMergeWatchState,
	type GhPollFn,
} from '../../src/release/merge-watch.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RunSupervisorOptions that never actually does anything. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-15T00:00:00Z',
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

/** Terminal result used in tests. */
const COMPLETE_RESULT: SupervisorResult = {
	status: 'complete',
	iterations: 1,
	lastOutcome: null,
};

/**
 * Build a RunSidecarLoopOptions that controls exactly N active:true cycles
 * then switches to idle forever. The loop terminates after maxCycles cycles
 * by resolving an external Promise (via an iteration counter and a done resolver).
 */
function makeOpts(opts: {
	activeCycles: number;
	runSupervisorFn?: (o: RunSupervisorOptions) => Promise<SupervisorResult>;
	hasPendingStories?: () => boolean;
	lockBusy?: boolean;
}): RunSidecarLoopOptions & {
	clearActiveCalls: number;
	supervisorCalls: number;
	sleepCalls: number;
} {
	let cycle = 0;
	const activeCycles = opts.activeCycles;
	let clearActiveCalls = 0;
	let supervisorCalls = 0;
	let sleepCalls = 0;

	const result = {
		buildOpts: () => makeDummySupervisorOpts(),
		readActive: (): boolean | undefined => {
			if (cycle < activeCycles) return true;
			return false;
		},
		clearActive: () => {
			clearActiveCalls += 1;
			cycle += 1; // advance past this active cycle
		},
		sleep: (_ms: number) => {
			sleepCalls += 1;
			cycle += 1; // advance cycle so we eventually exit
		},
		hasPendingStories: opts.hasPendingStories ?? (() => true),
		acquireLock: opts.lockBusy
			? () => ({ acquired: false as const, holderPid: 99 })
			: () => ({ acquired: true as const, release: () => {} }),
		runSupervisorFn:
			opts.runSupervisorFn ??
			((_o: RunSupervisorOptions): Promise<SupervisorResult> => {
				supervisorCalls += 1;
				return Promise.resolve(COMPLETE_RESULT);
			}),
		get clearActiveCalls() {
			return clearActiveCalls;
		},
		get supervisorCalls() {
			return supervisorCalls;
		},
		get sleepCalls() {
			return sleepCalls;
		},
	};
	return result;
}

/**
 * Run the sidecar loop for exactly `ticks` poll cycles, then abort.
 * We do this by making sleep() and clearActive() advance a counter that
 * eventually throws an escape sentinel.
 */
async function runForTicks(
	activeCycles: number,
	extraOpts: Partial<{
		hasPendingStories: () => boolean;
		lockBusy: boolean;
		runSupervisorFn: (o: RunSupervisorOptions) => Promise<SupervisorResult>;
	}> = {},
): Promise<{
	clearActiveCalls: number;
	supervisorCalls: number;
	sleepCalls: number;
}> {
	// We need to run the loop for a bounded number of iterations.
	// Strategy: use a special sentinel: after activeCycles active ticks and
	// one idle tick (so the loop has had a chance to clear and sleep),
	// the sleep function throws to escape the while(true).
	const ESCAPE = Symbol('escape');
	let sleepCount = 0;
	let clearActiveCalls = 0;
	let supervisorCalls = 0;

	// The active/idle sequence: first activeCycles cycles are active:true,
	// then idle. We need enough sleep calls to escape.
	const totalSleepBudget = activeCycles + 2; // at most 2 idle sleeps after active

	const readActiveSeq: Array<boolean | undefined> = [
		...Array.from({ length: activeCycles }, () => true as boolean),
		false,
		false,
	];
	let readIdx = 0;

	const loopOpts: RunSidecarLoopOptions = {
		buildOpts: () => makeDummySupervisorOpts(),
		readActive: (): boolean | undefined => readActiveSeq[readIdx++] ?? false,
		clearActive: () => {
			clearActiveCalls += 1;
		},
		sleep: (_ms: number) => {
			sleepCount += 1;
			if (sleepCount >= totalSleepBudget) {
				throw ESCAPE;
			}
		},
		hasPendingStories: extraOpts.hasPendingStories ?? (() => true),
		acquireLock: extraOpts.lockBusy
			? () => ({ acquired: false as const, holderPid: 99 })
			: () => ({ acquired: true as const, release: () => {} }),
		runSupervisorFn:
			extraOpts.runSupervisorFn ??
			((_o: RunSupervisorOptions): Promise<SupervisorResult> => {
				supervisorCalls += 1;
				return Promise.resolve(COMPLETE_RESULT);
			}),
	};

	try {
		await runSidecarLoop(loopOpts);
	} catch (e) {
		if (e !== ESCAPE) throw e;
	}

	return { clearActiveCalls, supervisorCalls, sleepCalls: sleepCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSidecarLoop', () => {
	test('idles (no runSupervisor call) when active is false', async () => {
		const { clearActiveCalls, supervisorCalls, sleepCalls } = await runForTicks(0);

		expect(supervisorCalls).toBe(0);
		expect(clearActiveCalls).toBe(0);
		expect(sleepCalls).toBeGreaterThan(0);
	});

	test('idles (no runSupervisor call) when active is undefined', async () => {
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		let supervisorCalls = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => undefined,
			clearActive: () => {},
			sleep: () => {
				sleepCount += 1;
				if (sleepCount >= 2) throw ESCAPE;
			},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async () => {
				supervisorCalls += 1;
				return COMPLETE_RESULT;
			},
		};

		try {
			await runSidecarLoop(opts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(supervisorCalls).toBe(0);
		expect(sleepCount).toBeGreaterThan(0);
	});

	test('calls runSupervisor when active:true with pending stories', async () => {
		const { supervisorCalls, clearActiveCalls } = await runForTicks(1);

		expect(supervisorCalls).toBe(1);
		// clearActive should have been called once (to set active:false after terminal).
		expect(clearActiveCalls).toBe(1);
	});

	test('sets active:false (calls clearActive) on terminal result', async () => {
		const { clearActiveCalls } = await runForTicks(1);
		expect(clearActiveCalls).toBe(1);
	});

	test('stays idle when active:true but hasPendingStories returns false', async () => {
		const { supervisorCalls, clearActiveCalls } = await runForTicks(1, {
			hasPendingStories: () => false,
		});

		expect(supervisorCalls).toBe(0);
		// clearActive IS called when there are no pending stories (to reset the flag).
		expect(clearActiveCalls).toBe(1);
	});

	test('stays idle when lock is busy (another supervisor running)', async () => {
		const { supervisorCalls, clearActiveCalls } = await runForTicks(1, {
			lockBusy: true,
		});

		expect(supervisorCalls).toBe(0);
		// clearActive is NOT called when we could not acquire the lock.
		expect(clearActiveCalls).toBe(0);
	});

	test('releases the lock even when runSupervisorFn throws', async () => {
		// When runSupervisorFn throws, the finally block in runSidecarLoop
		// must still call release() before the error propagates.
		let releaseCount = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => true,
			clearActive: () => {},
			sleep: () => {},
			hasPendingStories: () => true,
			acquireLock: () => ({
				acquired: true as const,
				release: () => {
					releaseCount += 1;
				},
			}),
			runSupervisorFn: async () => {
				throw new Error('supervisor crashed');
			},
		};

		// The crash propagates out of runSidecarLoop (after the finally runs).
		await expect(runSidecarLoop(opts)).rejects.toThrow('supervisor crashed');

		expect(releaseCount).toBeGreaterThanOrEqual(1);
	});

	test('multiple active cycles: runSupervisor called once per cycle', async () => {
		const { supervisorCalls, clearActiveCalls } = await runForTicks(3);

		expect(supervisorCalls).toBe(3);
		expect(clearActiveCalls).toBe(3);
	});

	test('existing guards intact: injected runSupervisorFn receives full RunSupervisorOptions bag', async () => {
		// Assert that the options bag passed to the injected runSupervisorFn
		// contains all the required RunSupervisorOptions fields (guards live there).
		const ESCAPE = Symbol('escape');
		let capturedOpts: RunSupervisorOptions | null = null;
		let sleepCount = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => (sleepCount === 0 ? true : false),
			clearActive: () => {},
			sleep: () => {
				sleepCount += 1;
				if (sleepCount >= 2) throw ESCAPE;
			},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (o) => {
				capturedOpts = o;
				return COMPLETE_RESULT;
			},
		};

		try {
			await runSidecarLoop(opts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(capturedOpts).not.toBeNull();
		// All required RunSupervisorOptions fields must be present.
		const required: Array<keyof RunSupervisorOptions> = [
			'spawn',
			'capturePane',
			'readPrd',
			'writePrd',
			'readHandoff',
			'clock',
			'reviewDispatch',
			'writeSessionMarker',
			'isPaneAlive',
			'workerPaneId',
			'prdPath',
			'handoffPath',
			'permissionMode',
			'taskPrompt',
		];
		for (const key of required) {
			expect(capturedOpts![key]).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// US-003: one-step-per-tick merge-watch integration tests
// ---------------------------------------------------------------------------
//
// AC2: hasSessionFn called each tick even when merge-watch is mid-progress.
// AC3: at most one gh poll per runMergeWatchFn invocation.
// AC4: postMergeFn called exactly once on terminal=merged; stateFile absent.
// CAM-103: outer loop is not blocked by a non-terminal watch.
// ---------------------------------------------------------------------------

describe('runSidecarLoop + merge-watch: one-step-per-tick (US-003)', () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-sidecar-mw-'));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function makeDummySupervisorOpts(): RunSupervisorOptions {
		return {
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => '',
			readPrd: () => null,
			writePrd: () => {},
			readHandoff: () => null,
			clock: () => '2026-06-29T00:00:00Z',
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

	// AC2: hasSessionFn is called on every idle tick, even when runMergeWatchFn is non-terminal.
	test('AC2: hasSessionFn called each idle tick even when merge-watch returns non-terminal', async () => {
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		let hasSessionCalls = 0;
		let mergeWatchCalls = 0;
		const NUM_TICKS = 4;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false, // always idle
			clearActive: () => {},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			// Non-terminal merge-watch: returns immediately (simulates continue tick)
			runMergeWatchFn: async () => {
				mergeWatchCalls++;
			},
			// hasSessionFn: counts calls, always returns true (session alive)
			hasSessionFn: () => {
				hasSessionCalls++;
				return true;
			},
			sleep: () => {
				sleepCount++;
				if (sleepCount >= NUM_TICKS) throw ESCAPE;
			},
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// hasSessionFn must have been called at least once per idle tick.
		expect(hasSessionCalls).toBeGreaterThanOrEqual(sleepCount);
		// merge-watch was also called (on each idle tick).
		expect(mergeWatchCalls).toBeGreaterThan(0);
		// Loop did not block: it reached at least NUM_TICKS iterations.
		expect(sleepCount).toBe(NUM_TICKS);
	});

	// CAM-103: the outer loop is NOT blocked by a non-terminal watch.
	// Verified by the multi-tick non-blocking test above (reaching NUM_TICKS = 4
	// ticks proves the loop continued beyond the first merge-watch invocation).

	// AC3: stepMergeWatch calls pollFn at most once per runMergeWatchFn invocation.
	test('AC3: per-tick pollFn called at most once per runMergeWatchFn invocation', async () => {
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		const pollCounts: number[] = []; // one entry per merge-watch invocation

		const stateFilePath = join(tempDir, '.cam-merge-watch.json');
		// Fresh state: no lastPolledAt -> polls on first tick
		writeMergeWatchState(stateFilePath, { prNumber: 10, mergedBranch: 'cam/test' });

		// Non-terminal pollFn: OPEN+CLEAN (never terminal)
		const pollFn: GhPollFn = () => ({ state: 'OPEN', mergeStateStatus: 'CLEAN' });

		const runMergeWatchFn = async () => {
			// Count pollFn calls for this invocation.
			let invocationPollCount = 0;
			const countedPollFn: GhPollFn = (prNumber) => {
				invocationPollCount++;
				return pollFn(prNumber);
			};

			const state = readMergeWatchState(stateFilePath);
			if (state === null) return;

			const result = stepMergeWatch(state, Date.now(), countedPollFn, {
				cwd: '/fake',
				postMergeFn: () => ({ ok: false as const, reason: 'should-not-be-called' }),
				notifyOrchestrator: () => {},
				pollIntervalMs: 0, // always poll (throttle disabled for test)
			});
			pollCounts.push(invocationPollCount);

			if (result.kind === 'continue') {
				writeMergeWatchState(stateFilePath, result.state);
			}
		};

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false, // always idle
			clearActive: () => {},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			runMergeWatchFn,
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 3) throw ESCAPE;
			},
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// At least one invocation happened.
		expect(pollCounts.length).toBeGreaterThan(0);
		// Every invocation called pollFn at most once.
		for (const count of pollCounts) {
			expect(count).toBeLessThanOrEqual(1);
		}
	});

	// AC4: on terminal=merged, postMergeFn runs exactly once and the stateFile is absent.
	test('AC4: terminal=merged: postMergeFn called exactly once, stateFile absent after tick', async () => {
		const ESCAPE = Symbol('escape');
		let sleepCount = 0;
		let postMergeCalls = 0;

		const stateFilePath = join(tempDir, '.cam-merge-watch.json');
		writeMergeWatchState(stateFilePath, { prNumber: 20, mergedBranch: 'cam/ship' });

		const runMergeWatchFn = async () => {
			const state = readMergeWatchState(stateFilePath);
			if (state === null) return;

			// pollFn: MERGED immediately
			const pollFn: GhPollFn = () => ({ state: 'MERGED', mergeStateStatus: 'MERGED' });

			const result = stepMergeWatch(state, 0, pollFn, {
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

			if (result.kind === 'continue') {
				writeMergeWatchState(stateFilePath, result.state);
			} else {
				removeMergeWatchState(stateFilePath);
			}
		};

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false, // always idle
			clearActive: () => {},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			runMergeWatchFn,
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 2) throw ESCAPE;
			},
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// postMergeFn must have been called exactly once.
		expect(postMergeCalls).toBe(1);
		// stateFile must be absent after the terminal tick.
		expect(existsSync(stateFilePath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// makeHasPendingStories — verdict-gated tests
// ---------------------------------------------------------------------------

describe('makeHasPendingStories', () => {
	const tmpPaths: string[] = [];

	function writeTempPrd(content: unknown): string {
		const path = `/tmp/cam-test-prd-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
		writeFileSync(path, JSON.stringify(content), 'utf8');
		tmpPaths.push(path);
		return path;
	}

	afterAll(() => {
		for (const p of tmpPaths) {
			try {
				unlinkSync(p);
			} catch {
				// best-effort cleanup
			}
		}
	});

	test('returns true when a non-operator story has passes !== true (existing behavior)', () => {
		const path = writeTempPrd({
			userStories: [{ id: 'US-001', passes: false, requires: null }],
			review: { lastVerdict: 'CLEAN' },
		});
		const fn = makeHasPendingStories(path);
		expect(fn()).toBe(true);
	});

	test('returns true when all non-operator stories pass and review is absent', () => {
		const path = writeTempPrd({
			userStories: [{ id: 'US-001', passes: true, requires: null }],
		});
		const fn = makeHasPendingStories(path);
		expect(fn()).toBe(true);
	});

	test('returns true when all non-operator stories pass and review.lastVerdict is null', () => {
		const path = writeTempPrd({
			userStories: [{ id: 'US-001', passes: true, requires: null }],
			review: { lastVerdict: null },
		});
		const fn = makeHasPendingStories(path);
		expect(fn()).toBe(true);
	});

	test('returns true when all non-operator stories pass and verdict is FIXES_PENDING (non-terminal)', () => {
		const path = writeTempPrd({
			userStories: [{ id: 'US-001', passes: true, requires: null }],
			review: { lastVerdict: 'FIXES_PENDING:US-001' },
		});
		const fn = makeHasPendingStories(path);
		expect(fn()).toBe(true);
	});

	test('returns false when all non-operator stories pass and verdict is CLEAN', () => {
		const path = writeTempPrd({
			userStories: [{ id: 'US-001', passes: true, requires: null }],
			review: { lastVerdict: 'CLEAN' },
		});
		const fn = makeHasPendingStories(path);
		expect(fn()).toBe(false);
	});

	test('returns false when all non-operator stories pass and verdict is MAX_ROUNDS_DEBT', () => {
		const path = writeTempPrd({
			userStories: [{ id: 'US-001', passes: true, requires: null }],
			review: { lastVerdict: 'MAX_ROUNDS_DEBT' },
		});
		const fn = makeHasPendingStories(path);
		expect(fn()).toBe(false);
	});

	test('operator-required stories are ignored: operator pending + all non-operator pass + CLEAN => false', () => {
		const path = writeTempPrd({
			userStories: [
				{ id: 'US-001', passes: true, requires: null },
				{ id: 'US-002', passes: false, requires: 'operator' },
			],
			review: { lastVerdict: 'CLEAN' },
		});
		const fn = makeHasPendingStories(path);
		expect(fn()).toBe(false);
	});
});
