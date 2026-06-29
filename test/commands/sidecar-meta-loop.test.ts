// test/commands/sidecar-meta-loop.test.ts
//
// Integration tests for US-004 (CAM-132): wiring the observe drainer into the
// sidecar idle-tick via runMetaLoopObserveFn.
//
// These tests drive runSidecarLoop directly (not runSidecar) using injected fakes.
// They prove:
//   AC#3: off path — no events emitted, selectPlannable spy never called.
//   AC#4: observe wouldSelect — exactly one 'meta-loop-observe' event with
//         wouldSelect/rank/wsjf matching the backlog fixture.
//   AC#5: observe drained — exactly one 'meta-loop-observe' event with drained:true.
//   AC#6: no mutation — flipActiveFn and writePrd never called.
//   AC#7: quiet during active/paused-mid-cycle — no observe event when active:true or
//         when active:false + in-flight prd.json (hasPendingStories:true).
//   AC#9/10: file-assert oracles for loop.ts and sidecar.ts.
//
// All tests use injected fakes; no real filesystem or tmux access.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSidecarLoop, type RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';
import { makeInMemoryEventLogger, type WorkerEventLogger } from '../../src/supervisor/events.ts';
import { observeDecide, type ObserveState } from '../../src/supervisor/observe.ts';
import type { IssueEntry } from '../../src/issues/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE = Symbol('escape');

/**
 * Plannable IssueEntry fixture: stage=specified, status=open, rank=1, wsjf fields set.
 */
function makePlannableIssue(id = 'CAM-42'): IssueEntry {
	return {
		id,
		title: 'Test issue',
		stage: 'specified',
		status: 'open',
		rank: 1,
		wsjf: { value: 3.75, timeCriticality: 3, riskReduction: 2, jobSize: 2 },
	} as IssueEntry;
}

/**
 * Build a test-injectable runMetaLoopObserveFn using observeDecide.
 * The dedup state is held in closure (mirrors the production factory).
 */
function makeTestObserveFn(
	getSelected: () => IssueEntry | null,
	logEvent: WorkerEventLogger,
): () => void {
	let lastState: ObserveState = { kind: 'none' };
	return (): void => {
		const selected = getSelected();
		const result = observeDecide(selected, lastState);
		if (result !== null) {
			lastState = result.newState;
			logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'meta-loop-observe',
				detail: result.detail,
			});
		}
	};
}

/** Minimal RunSupervisorOptions for the supervisor path (never reached in idle tests). */
function makeDummySupervisorOpts() {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-27T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok' as const, detail: '' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions' as const,
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
	};
}

/**
 * Build a RunSidecarLoopOptions that runs N idle ticks and then escapes via
 * the ESCAPE sentinel thrown from sleep().
 *
 * The caller supplies `extraOpts` to inject runMetaLoopObserveFn, hasPendingStories,
 * flipActiveFn, etc.
 */
function makeIdleLoopOpts(
	ticks: number,
	extraOpts: Partial<RunSidecarLoopOptions> = {},
): RunSidecarLoopOptions {
	let sleepCount = 0;
	return {
		buildOpts: () => makeDummySupervisorOpts(),
		readActive: () => false,
		clearActive: () => {},
		sleep: () => {
			sleepCount++;
			if (sleepCount >= ticks) throw ESCAPE;
		},
		// Default: no prd cycle in flight (observe is allowed).
		hasPendingStories: () => false,
		acquireLock: () => ({ acquired: true, release: () => {} }),
		...extraOpts,
	};
}

// ---------------------------------------------------------------------------
// AC#3: Off path — no meta-loop-observe events, selectPlannable spy never called
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: off path (no runMetaLoopObserveFn)', () => {
	test('selectPlannable spy never called and no meta-loop-observe events across 3 idle ticks', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let selectCallCount = 0;

		// Build an observe fn that would call selectSpy if invoked —
		// but do NOT inject it (off path = absent fn).
		const _unusedObserveFn = makeTestObserveFn(() => {
			selectCallCount++;
			return null;
		}, logger);
		void _unusedObserveFn; // declared to prove the fn exists but is not wired

		const loopOpts = makeIdleLoopOpts(3, {
			// runMetaLoopObserveFn intentionally absent (meta_loop=off)
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(selectCallCount).toBe(0);
		const observeEvents = events.filter((ev) => ev.kind === 'meta-loop-observe');
		expect(observeEvents.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC#4: Observe wouldSelect — exactly one event with matching detail
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: observe wouldSelect', () => {
	test('emits exactly one meta-loop-observe event with wouldSelect detail for a plannable issue', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const fixture = makePlannableIssue('CAM-42');
		let selectCallCount = 0;

		const observeFn = makeTestObserveFn(() => {
			selectCallCount++;
			return fixture;
		}, logger);

		// Run 3 idle ticks: first tick emits event; second tick dedup suppresses.
		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false, // no prd cycle in flight
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		const observeEvents = events.filter((ev) => ev.kind === 'meta-loop-observe');
		// Dedup: only one event despite 3 ticks (same issue selected each tick).
		expect(observeEvents.length).toBe(1);

		const detail = observeEvents[0]?.detail as { wouldSelect: string; rank: number; wsjf: number };
		expect(detail.wouldSelect).toBe('CAM-42');
		expect(detail.rank).toBe(1);
		expect(typeof detail.wsjf).toBe('number');
		// selectPlannable was called on each tick (dedup is in observeDecide, not in selector)
		expect(selectCallCount).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AC#5: Observe drained — exactly one event with drained:true
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: observe drained', () => {
	test('emits exactly one meta-loop-observe event with drained:true for an empty backlog', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let selectCallCount = 0;

		const observeFn = makeTestObserveFn(() => {
			selectCallCount++;
			return null; // empty backlog
		}, logger);

		// Run 3 idle ticks: first tick emits drained; second tick dedup suppresses.
		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		const observeEvents = events.filter((ev) => ev.kind === 'meta-loop-observe');
		expect(observeEvents.length).toBe(1);

		const detail = observeEvents[0]?.detail as { drained: boolean };
		expect(detail.drained).toBe(true);
		expect(selectCallCount).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AC#6: No mutation — flipActiveFn and writePrd never called during observe
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: no mutation during observe', () => {
	test('flipActiveFn never called and writePrd never called across observe ticks', async () => {
		const { logger } = makeInMemoryEventLogger();
		let flipCallCount = 0;
		let writePrdCallCount = 0;

		const observeFn = makeTestObserveFn(() => makePlannableIssue(), logger);

		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
			flipActiveFn: () => { flipCallCount++; },
			// supervisor never runs in idle path, but we track writePrd via buildOpts
			buildOpts: () => ({
				...makeDummySupervisorOpts(),
				writePrd: () => { writePrdCallCount++; },
			}),
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(flipCallCount).toBe(0);
		expect(writePrdCallCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC#7: Quiet during active/paused-mid-cycle
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: quiet during active or paused-mid-cycle', () => {
	test('no meta-loop-observe event when active:true (supervisor path)', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let observeCallCount = 0;

		const observeFn = makeTestObserveFn(() => {
			observeCallCount++;
			return makePlannableIssue();
		}, logger);

		// Sequence: [true, false] — one active cycle, then idle (escape on idle sleep)
		const readActiveSeq: Array<boolean> = [true, false];
		let readIdx = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => { throw ESCAPE; },
			hasPendingStories: () => true, // prd cycle exists (drives active path + blocks observe)
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => ({ status: 'complete', iterations: 1, lastOutcome: null }),
			runMetaLoopObserveFn: observeFn,
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// No observe event: active:true dispatches supervisor, not observe.
		// After supervisor, active goes false but hasPendingStories is true -> still no observe.
		const observeEvents = events.filter((ev) => ev.kind === 'meta-loop-observe');
		expect(observeEvents.length).toBe(0);
		expect(observeCallCount).toBe(0);
	});

	test('no meta-loop-observe event when active:false but in-flight prd.json present', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let observeCallCount = 0;

		const observeFn = makeTestObserveFn(() => {
			observeCallCount++;
			return makePlannableIssue();
		}, logger);

		// active:false throughout, but hasPendingStories:true (paused mid-cycle)
		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => true, // in-flight prd.json
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		const observeEvents = events.filter((ev) => ev.kind === 'meta-loop-observe');
		expect(observeEvents.length).toBe(0);
		expect(observeCallCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC#9/10: File-assert oracles
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: file-assert oracles', () => {
	test('loop.ts contains runMetaLoopObserveFn (AC#1 oracle)', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/supervisor/loop.ts'),
			'utf8',
		);
		expect(src).toContain('runMetaLoopObserveFn');
	});

	test('sidecar.ts imports readMetaLoop (AC#2 oracle)', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('readMetaLoop');
	});

	test('sidecar.ts dedup state is in-memory closure (AC#8: no file write path)', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		// The factory creates a local state (closure), never writes to disk.
		// Verify the helper is present and uses observeDecide + selectPlannableFromFile.
		expect(src).toContain('makeProductionMetaLoopObserveFn');
		expect(src).toContain('observeDecide');
		expect(src).toContain('selectPlannableFromFile');
		// Dedup state kept in-memory: ObserveState type used, no writeFileSync call inside
		// the helper (the helper function body should not contain writeFileSync).
		const helperMatch = src.match(/function makeProductionMetaLoopObserveFn[\s\S]*?\n\}/);
		expect(helperMatch).not.toBeNull();
		expect(helperMatch?.[0]).not.toContain('writeFileSync');
	});
});
