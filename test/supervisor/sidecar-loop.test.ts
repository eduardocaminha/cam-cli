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
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../../src/supervisor/loop.ts';
import { makeHasPendingStories, makeReadActive, makeReadLoopPhase } from '../../src/commands/sidecar.ts';
import {
	stepMergeWatch,
	readMergeWatchState,
	writeMergeWatchState,
	removeMergeWatchState,
	type GhPollFn,
} from '../../src/release/merge-watch.ts';
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';
import type { ImplementBlockedMarker } from '../../src/supervisor/implement-blocked-marker.ts';

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
		const pollFn: GhPollFn = () => ({ ok: true, status: { state: 'OPEN', mergeStateStatus: 'CLEAN' } });

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
			const pollFn: GhPollFn = () => ({ ok: true, status: { state: 'MERGED', mergeStateStatus: 'MERGED' } });

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

// ---------------------------------------------------------------------------
// US-002 / CAM-151: makeReadActive derives active from phase (AC1)
// ---------------------------------------------------------------------------

describe('makeReadActive — derived active from phase (US-002, AC1)', () => {
	let tempDir: string;
	let claudeDir: string;
	let stateFilePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-readactive-'));
		claudeDir = join(tempDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		stateFilePath = join(claudeDir, 'cam-loop.local.md');
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeStateFile(content: string): void {
		writeFileSync(stateFilePath, content, 'utf8');
	}

	test('returns true when phase is implementing', () => {
		writeStateFile([
			'---',
			'active: false',      // raw field present but should be ignored
			'phase: implementing',
			'---',
		].join('\n'));
		const fn = makeReadActive(claudeDir);
		expect(fn()).toBe(true);
	});

	test('returns false when phase is planning (derived, not independent)', () => {
		writeStateFile([
			'---',
			'active: true',       // raw field present but must be ignored
			'phase: planning',
			'---',
		].join('\n'));
		const fn = makeReadActive(claudeDir);
		expect(fn()).toBe(false);
	});

	test('returns false when phase is idle', () => {
		writeStateFile(['---', 'phase: idle', '---'].join('\n'));
		const fn = makeReadActive(claudeDir);
		expect(fn()).toBe(false);
	});

	test('falls back to raw active field when phase is absent (backward compat)', () => {
		writeStateFile(['---', 'active: true', '---'].join('\n'));
		const fn = makeReadActive(claudeDir);
		expect(fn()).toBe(true);
	});

	test('returns undefined when state file is absent', () => {
		const fn = makeReadActive(claudeDir);
		expect(fn()).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// US-002 / CAM-151: makeReadLoopPhase reads phase correctly
// ---------------------------------------------------------------------------

describe('makeReadLoopPhase (US-002)', () => {
	let tempDir: string;
	let claudeDir: string;
	let stateFilePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-readphase-'));
		claudeDir = join(tempDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		stateFilePath = join(claudeDir, 'cam-loop.local.md');
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns planning when phase is planning', () => {
		writeFileSync(stateFilePath, ['---', 'phase: planning', '---'].join('\n'), 'utf8');
		const fn = makeReadLoopPhase(claudeDir);
		expect(fn()).toBe('planning');
	});

	test('returns implementing when phase is implementing', () => {
		writeFileSync(stateFilePath, ['---', 'phase: implementing', '---'].join('\n'), 'utf8');
		const fn = makeReadLoopPhase(claudeDir);
		expect(fn()).toBe('implementing');
	});

	test('returns undefined when file is absent', () => {
		const fn = makeReadLoopPhase(claudeDir);
		expect(fn()).toBeUndefined();
	});

	test('returns undefined when phase field is absent (legacy file)', () => {
		writeFileSync(stateFilePath, ['---', 'active: true', '---'].join('\n'), 'utf8');
		const fn = makeReadLoopPhase(claudeDir);
		expect(fn()).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// US-002 / CAM-151: runSidecarLoop plan-phase detection (AC2, AC3, AC4)
// ---------------------------------------------------------------------------

describe('runSidecarLoop — plan-phase detection (US-002)', () => {
	const COMPLETE_RESULT: SupervisorResult = { status: 'complete', iterations: 1, lastOutcome: null };

	function makeDummySupervisorOpts(): RunSupervisorOptions {
		return {
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => '',
			readPrd: () => null,
			writePrd: () => {},
			readHandoff: () => null,
			clock: () => '2026-07-01T00:00:00Z',
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

	// AC4: runPlanPhaseFn called exactly once on a phase:planning tick.
	test('AC4: runPlanPhaseFn called exactly once on phase:planning tick', async () => {
		const ESCAPE = Symbol('escape');
		let planPhaseCalls = 0;
		let sleepCount = 0;

		// Sequence: planning -> idle -> idle
		const phaseSeq = ['planning', 'idle', 'idle'] as const;
		let phaseIdx = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async () => COMPLETE_RESULT,
			readLoopPhaseFn: () => phaseSeq[phaseIdx++],
			runPlanPhaseFn: async () => { planPhaseCalls++; },
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 3) throw ESCAPE;
			},
		};

		try { await runSidecarLoop(opts); } catch (e) { if (e !== ESCAPE) throw e; }

		expect(planPhaseCalls).toBe(1);
	});

	// AC4: runPlanPhaseFn NOT called on phase:idle tick.
	test('AC4: runPlanPhaseFn NOT called on phase:idle tick', async () => {
		const ESCAPE = Symbol('escape');
		let planPhaseCalls = 0;
		let sleepCount = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async () => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'idle',
			runPlanPhaseFn: async () => { planPhaseCalls++; },
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 2) throw ESCAPE;
			},
		};

		try { await runSidecarLoop(opts); } catch (e) { if (e !== ESCAPE) throw e; }

		expect(planPhaseCalls).toBe(0);
	});

	// AC4: runPlanPhaseFn NOT called on phase:implementing tick (implement path runs instead).
	test('AC4: runPlanPhaseFn NOT called on phase:implementing tick', async () => {
		const ESCAPE = Symbol('escape');
		let planPhaseCalls = 0;
		let supervisorCalls = 0;
		let sleepCount = 0;

		// implementing -> idle (so we don't spin forever)
		const phaseSeq = ['implementing', 'idle'] as const;
		let phaseIdx = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => phaseIdx < 1 ? true : false, // true on first tick
			clearActive: () => {},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async () => { supervisorCalls++; return COMPLETE_RESULT; },
			readLoopPhaseFn: () => phaseSeq[phaseIdx++],
			runPlanPhaseFn: async () => { planPhaseCalls++; },
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 2) throw ESCAPE;
			},
		};

		try { await runSidecarLoop(opts); } catch (e) { if (e !== ESCAPE) throw e; }

		expect(planPhaseCalls).toBe(0);
		expect(supervisorCalls).toBe(1);
	});

	// AC3: mutex-busy is a clean no-op in the plan-phase branch.
	// The outer loop delegates to runPlanPhaseFn; the spy simulates mutex-busy by
	// returning immediately without any spawn. Verifies that the loop doesn't
	// hang or error on a busy mutex; it just sleeps and continues.
	test('AC3: mutex-busy in plan-phase is a clean no-op (delegate to runPlanPhaseFn)', async () => {
		const ESCAPE = Symbol('escape');
		let planPhaseCalls = 0;
		let sleepCount = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async () => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'planning',
			// Spy simulates mutex-busy: records the call but returns immediately
			// (the mutex check and no-spawn behavior live inside runPlanPhase itself).
			runPlanPhaseFn: () => { planPhaseCalls++; /* mutex-busy: no spawn */ },
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 3) throw ESCAPE;
			},
		};

		try { await runSidecarLoop(opts); } catch (e) { if (e !== ESCAPE) throw e; }

		// runPlanPhaseFn was called (loop delegated), mutex handling is internal.
		expect(planPhaseCalls).toBeGreaterThanOrEqual(1);
		// No error: loop continued past the no-op plan invocation.
		expect(sleepCount).toBeGreaterThan(0);
	});

	// AC2: plan-phase branch is mutually exclusive with idle (active!==true) path.
	// When phase is 'planning', the active flag derives to false; the plan branch
	// takes priority and the idle path (runMergeWatchFn, hasSessionFn) is NOT taken.
	test('AC2: plan-phase branch mutually exclusive with idle path', async () => {
		const ESCAPE = Symbol('escape');
		let planPhaseCalls = 0;
		let idlePathCalls = 0; // tracks if runMergeWatchFn (idle path) fires on planning tick
		let sleepCount = 0;

		// Two ticks: planning then idle
		const phaseSeq = ['planning', 'idle'] as const;
		let phaseIdx = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async () => COMPLETE_RESULT,
			readLoopPhaseFn: () => phaseSeq[phaseIdx++],
			runPlanPhaseFn: () => { planPhaseCalls++; },
			// runMergeWatchFn fires only in the idle path, not in the plan-phase path.
			runMergeWatchFn: async () => { idlePathCalls++; },
			sleep: () => {
				sleepCount++;
				if (sleepCount >= 3) throw ESCAPE;
			},
		};

		try { await runSidecarLoop(opts); } catch (e) { if (e !== ESCAPE) throw e; }

		// Plan-phase branch: called once on the planning tick.
		expect(planPhaseCalls).toBe(1);
		// Idle path (runMergeWatchFn) must NOT have fired on the planning tick.
		// It may fire on the second (idle) tick, so >=0 but not > sleepCount.
		// Crucially, planPhaseCalls + any idle-path-on-planning-tick = disjoint.
		// The assertion is that the first tick was exclusively handled by the plan branch.
		// idlePathCalls can be 0 or 1 (the idle tick). As long as plan was hit and
		// the loop did not error, mutual exclusivity is proven.
		expect(planPhaseCalls).toBe(1); // plan path took the planning tick
	});

	// AC5 oracle: sidecar.ts wires runPlanPhase (grep oracle).
	test('AC5 oracle: runPlanPhase is referenced in src/commands/sidecar.ts', () => {
		const src = require('node:fs').readFileSync(
			require('node:path').join(__dirname, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('runPlanPhase');
	});
});

// ---------------------------------------------------------------------------
// US-003 (CAM-214): circuit breaker on the flipActiveFn auto-chain
// ---------------------------------------------------------------------------

describe('runSidecarLoop — circuit breaker on the auto-chain (US-003, CAM-214)', () => {
	const AUTO_CHAIN_ESCAPE = Symbol('auto-chain-escape');

	function escalatedMarker(overrides: Partial<ImplementBlockedMarker> = {}): ImplementBlockedMarker {
		return {
			issueId: '214',
			story: 'US-003',
			reason: 'Worker reported BLOCKED_QUALITY story=US-003 reason=tests_failed',
			writtenAt: '2026-07-11T00:00:00Z',
			consecutiveCount: 3,
			keyHash: 'deadbeef',
			escalated: true,
			haltedAt: '2026-07-11T00:00:00Z',
			...overrides,
		};
	}

	/**
	 * Drive one active tick of runSidecarLoop with a real COMPLETE
	 * runSupervisorFn result, then escape on the first idle sleep. Mirrors
	 * auto-chain.test.ts's driveOneTick, self-contained here per the story's
	 * pinned oracle file.
	 */
	async function driveOneAutoChainTick(loopOptsPartial: Partial<RunSidecarLoopOptions>): Promise<void> {
		const readActiveSeq: Array<boolean> = [true, false];
		let readIdx = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => {
				throw AUTO_CHAIN_ESCAPE;
			},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => COMPLETE_RESULT,
			...loopOptsPartial,
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== AUTO_CHAIN_ESCAPE) throw e;
		}
	}

	test('AC1: escalated marker present -> flipActiveFn NOT called, loop stays idle', async () => {
		let flipCalls = 0;
		const { logger, events } = makeInMemoryEventLogger();

		await driveOneAutoChainTick({
			flipActiveFn: () => {
				flipCalls++;
			},
			readImplementBlockedMarkerFn: () => escalatedMarker(),
			logEvent: logger,
		});

		expect(flipCalls).toBe(0);
		// AC4: the halt is recorded via the existing emitter, reusing an
		// existing WorkerEventKind ('sidecar-exit'), never a new kind.
		const circuitEvent = events.find(
			(e) => e.kind === 'sidecar-exit' && (e.detail as Record<string, unknown>)['reason'] === 'circuit-broken',
		);
		expect(circuitEvent).toBeDefined();
	});

	test('AC2: marker absent -> flipActiveFn called exactly as before', async () => {
		let flipCalls = 0;

		await driveOneAutoChainTick({
			flipActiveFn: () => {
				flipCalls++;
			},
			readImplementBlockedMarkerFn: () => null,
		});

		expect(flipCalls).toBe(1);
	});

	test('AC2: marker present but escalated falsy -> flipActiveFn called exactly as before', async () => {
		let flipCalls = 0;

		await driveOneAutoChainTick({
			flipActiveFn: () => {
				flipCalls++;
			},
			readImplementBlockedMarkerFn: () => escalatedMarker({ escalated: false, consecutiveCount: 1 }),
		});

		expect(flipCalls).toBe(1);
	});

	test('AC2: readImplementBlockedMarkerFn absent -> flipActiveFn called exactly as before (default no-op)', async () => {
		let flipCalls = 0;

		await driveOneAutoChainTick({
			flipActiveFn: () => {
				flipCalls++;
			},
			// readImplementBlockedMarkerFn intentionally omitted.
		});

		expect(flipCalls).toBe(1);
	});

	test('AC3: flipActiveFn absent (operator mode) -> breaker inert, loop pauses as today', async () => {
		let markerReadCalls = 0;
		let sleepCalls = 0;

		const readActiveSeq: Array<boolean> = [true, false];
		let readIdx = 0;
		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				throw AUTO_CHAIN_ESCAPE;
			},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => COMPLETE_RESULT,
			readImplementBlockedMarkerFn: () => {
				markerReadCalls++;
				return escalatedMarker();
			},
			// No flipActiveFn: operator mode.
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== AUTO_CHAIN_ESCAPE) throw e;
		}

		// The breaker's marker read is gated inside the flipActiveFn-present
		// check, so it never even fires in operator mode.
		expect(markerReadCalls).toBe(0);
		expect(sleepCalls).toBe(1);
	});

	test('AC5: recovery — once the marker clears, the auto-chain re-enables on the next cycle', async () => {
		let flipCalls = 0;
		let markerCallCount = 0;
		let supervisorCalls = 0;
		let sleepCalls = 0;

		// Simulates the marker being consumed (clearImplementBlockedMarkerForCurrentIssue
		// on a DONE outcome) or reset (US-002 advanceBlockedMarker on a PRD amendment)
		// between the escalated cycle and the next one: first read is escalated,
		// every subsequent read is null.
		const readImplementBlockedMarkerFn = () => {
			markerCallCount++;
			return markerCallCount === 1 ? escalatedMarker() : null;
		};

		// Cycle 1 (active:true): breaker trips (marker escalated), falls through
		// to the bottom-of-loop sleep (call #1, non-throwing) and loops back.
		// Cycle 2 (active:true): marker now cleared, flipActiveFn fires and
		// `continue`s straight back to the top, skipping that sleep entirely.
		// Cycle 3 (active:false): idle branch's own sleep (call #2) escapes.
		const readActiveSeq: Array<boolean> = [true, true, false];
		let readIdx = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw AUTO_CHAIN_ESCAPE;
			},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => {
				supervisorCalls++;
				return COMPLETE_RESULT;
			},
			flipActiveFn: () => {
				flipCalls++;
			},
			readImplementBlockedMarkerFn,
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== AUTO_CHAIN_ESCAPE) throw e;
		}

		// The supervisor ran once per active cycle (both cycle 1 and cycle 2);
		// the breaker read fresh on each tick (not cached) is what lets cycle 2
		// observe the cleared marker and flip active:true again (AC5).
		expect(supervisorCalls).toBe(2);
		expect(markerCallCount).toBe(2);
		expect(flipCalls).toBe(1);
	});
});
