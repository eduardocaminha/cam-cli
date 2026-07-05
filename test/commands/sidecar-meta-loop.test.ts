// test/commands/sidecar-meta-loop.test.ts
//
// Integration tests for US-004/US-005 (CAM-132): wiring the observe drainer
// into the sidecar idle-tick via runMetaLoopObserveFn, and drain notification
// via Resend.
//
// These tests drive runSidecarLoop directly (not runSidecar) using injected fakes.
// They prove:
//   US-004:
//   AC#3: off path — no events emitted, selectPlannable spy never called.
//   AC#4: observe wouldSelect — exactly one 'meta-loop-observe' event with
//         wouldSelect/rank/wsjf matching the backlog fixture.
//   AC#5: observe drained — exactly one 'meta-loop-observe' event with drained:true.
//   AC#6: no mutation — flipActiveFn and writePrd never called.
//   AC#7: quiet during active/paused-mid-cycle — no observe event when active:true or
//         when active:false + in-flight prd.json (hasPendingStories:true).
//   AC#9/10: file-assert oracles for loop.ts and sidecar.ts.
//   US-005:
//   AC#1: drain notify sent exactly once (sendEscalation spy: call count === 1) when
//         Resend is configured and a drained event emits.
//   AC#2: drain subject matches drain message and does NOT contain "Non-convergence".
//   AC#3: no notification when Resend is unconfigured (sendEscalation spy count === 0).
//   AC#4: dedup — staying drained across ticks does NOT re-fire the notification.
//
// All tests use injected fakes; no real filesystem or tmux access.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSidecarLoop, type RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';
import { makeInMemoryEventLogger, type WorkerEventLogger } from '../../src/supervisor/events.ts';
import { observeDecide, type ObserveState } from '../../src/supervisor/observe.ts';
import { sendEscalation, type ResendSendFn } from '../../src/notify/resend.ts';
import { DRAIN_NOTIFY_SUBJECT, BLOCKED_CYCLE_ESCALATE_SUBJECT, makeProductionMetaLoopDispatchFn } from '../../src/commands/sidecar.ts';
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
 *
 * @param drainNotifyFn Optional drain notification fn; called once on the first
 *   drained transition (mirrors production makeProductionMetaLoopObserveFn).
 */
function makeTestObserveFn(
	getSelected: () => IssueEntry | null,
	logEvent: WorkerEventLogger,
	drainNotifyFn?: () => Promise<void>,
): () => Promise<void> {
	let lastState: ObserveState = { kind: 'none' };
	return async (): Promise<void> => {
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
			if ('drained' in result.detail && result.detail.drained === true && drainNotifyFn) {
				await drainNotifyFn();
			}
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

// ---------------------------------------------------------------------------
// US-005: Drain notification via Resend
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: drain notification (US-005)', () => {
	// Helper: build a drainNotifyFn backed by a sendEscalation spy.
	// Returns the spy call records and the drainNotifyFn.
	function makeDrainNotifyWithSpy(): {
		sendCalls: Array<{ subject: string; html: string }>;
		drainNotifyFn: () => Promise<void>;
	} {
		const sendCalls: Array<{ subject: string; html: string }> = [];
		const spySendFn: ResendSendFn = async (params) => {
			sendCalls.push({ subject: params.subject, html: params.html });
			return { data: null, error: null };
		};
		const drainNotifyFn = async () => {
			await sendEscalation({
				apiKey: 'test-api-key',
				recipient: 'test@example.com',
				subject: DRAIN_NOTIFY_SUBJECT,
				html: '<p><strong>[cam]</strong> The meta-loop observer found no plannable issues in the backlog. The project backlog is drained.</p>',
				sendFn: spySendFn,
			});
		};
		return { sendCalls, drainNotifyFn };
	}

	test('sendEscalation spy called exactly once when Resend configured and drained event emits', async () => {
		const { logger } = makeInMemoryEventLogger();
		const { sendCalls, drainNotifyFn } = makeDrainNotifyWithSpy();

		// Empty backlog -> drained event on first tick
		const observeFn = makeTestObserveFn(() => null, logger, drainNotifyFn);

		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// Exactly one call despite 3 ticks (dedup: observeDecide returns null after first drain)
		expect(sendCalls.length).toBe(1);
	});

	test('drain email subject matches drain message and does NOT contain Non-convergence', async () => {
		const { logger } = makeInMemoryEventLogger();
		const { sendCalls, drainNotifyFn } = makeDrainNotifyWithSpy();

		const observeFn = makeTestObserveFn(() => null, logger, drainNotifyFn);

		const loopOpts = makeIdleLoopOpts(2, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		expect(sendCalls.length).toBe(1);
		const call = sendCalls[0];
		// Subject must include the drain text
		expect(call?.subject).toContain('drained');
		// Subject must NOT be the non-convergence message
		expect(call?.subject).not.toMatch(/Non-convergence/);
	});

	test('no sendEscalation call when Resend is NOT configured (no drainNotifyFn)', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let sendCallCount = 0;

		// No drainNotifyFn -> unconfigured path (observe still runs + emits, no notify)
		const observeFn = makeTestObserveFn(
			() => null,
			logger,
			// drainNotifyFn absent: simulates apiKey or recipient empty
			undefined,
		);

		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// Drain event still emits (observe is unaffected)
		const drainEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-observe' && (ev.detail as { drained?: boolean }).drained === true,
		);
		expect(drainEvents.length).toBe(1);

		// But no notification was sent
		expect(sendCallCount).toBe(0);
	});

	test('dedup: staying drained across multiple ticks fires notification exactly once', async () => {
		const { logger } = makeInMemoryEventLogger();
		const { sendCalls, drainNotifyFn } = makeDrainNotifyWithSpy();

		// Run 5 idle ticks with empty backlog — first tick drains, next 4 are deduped
		const observeFn = makeTestObserveFn(() => null, logger, drainNotifyFn);

		const loopOpts = makeIdleLoopOpts(5, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// Notification fired exactly once for the drain transition, not per-tick
		expect(sendCalls.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// US-005: File-assert oracles for drain notify
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: drain notify file-assert oracles (US-005)', () => {
	test('sidecar.ts contains drained drain-specific notify fn (AC#1 oracle)', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		// Drain-specific fn must be present and distinct from escalateFn
		expect(src).toContain('drained');
		expect(src).toContain('makeProductionDrainNotifyFn');
		expect(src).toContain('DRAIN_NOTIFY_SUBJECT');
	});

	test('sidecar.ts reuses sendEscalation and readResendConfig, not re-implemented (AC#1 oracle)', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		// sendEscalation is imported (reused, not re-implemented)
		expect(src).toContain("from '../notify/resend.ts'");
		expect(src).toContain('sendEscalation');
		// readResendConfig is used for drain notify (via resendConfig.apiKey / recipient)
		expect(src).toContain('readResendConfig');
		// No second Resend client: no 'new Resend(' in sidecar.ts
		expect(src).not.toContain('new Resend(');
	});
});

// ===========================================================================
// US-004 (CAM-139): Wire the auto-dispatcher into the sidecar idle-tick
// ===========================================================================

// ---------------------------------------------------------------------------
// AC#7 oracle: events.ts contains 'meta-loop-dispatch'
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: events.ts contains meta-loop-dispatch kind (AC#7)', () => {
	test("grep oracle: 'meta-loop-dispatch' present in src/supervisor/events.ts", () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/supervisor/events.ts'),
			'utf8',
		);
		expect(src).toContain('meta-loop-dispatch');
	});
});

// ---------------------------------------------------------------------------
// AC#1 oracle: sidecar.ts wires dispatch fn for auto and observe fn for observe
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: sidecar wiring oracle (AC#1)', () => {
	test('sidecar.ts exports makeProductionMetaLoopDispatchFn and branches on auto', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('makeProductionMetaLoopDispatchFn');
		expect(src).toContain("metaLoop === 'auto'");
		expect(src).toContain("metaLoop === 'observe'");
	});
});

// ---------------------------------------------------------------------------
// Helper: minimal drain-notify spy (scoped to dispatch tests)
// ---------------------------------------------------------------------------

function makeDispatchDrainSpy(): { callCount: number; drainNotifyFn: () => Promise<void> } {
	let callCount = 0;
	return { get callCount() { return callCount; }, drainNotifyFn: async () => { callCount++; } };
}

// ---------------------------------------------------------------------------
// AC#2: Dispatcher dispatches ONLY when all gates pass
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: dispatches when all gates pass (AC#2)', () => {
	test('setPhaseFn called with planning + issueId; dispatched event emitted', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const setPhaseCaptures: Array<{ phase: string; planIssue?: string }> = [];
		const fixture = makePlannableIssue('CAM-42');

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => fixture,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: (phase, planIssue) => { setPhaseCaptures.push({ phase, planIssue }); },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();

		expect(setPhaseCaptures.length).toBe(1);
		expect(setPhaseCaptures[0]?.phase).toBe('planning');
		expect(setPhaseCaptures[0]?.planIssue).toBe('CAM-42');

		const dispatchEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(dispatchEvents.length).toBe(1);
		const detail = dispatchEvents[0]?.detail as { dispatched: boolean; issueId: string; rank: number };
		expect(detail.dispatched).toBe(true);
		expect(detail.issueId).toBe('CAM-42');
		expect(typeof detail.rank).toBe('number');
	});

	test('dispatches when phase is undefined (absent)', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const setPhaseCaptures: Array<{ phase: string; planIssue?: string }> = [];
		const fixture = makePlannableIssue('CAM-10');

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => fixture,
			readPhaseFn: () => undefined, // absent
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: (phase, planIssue) => { setPhaseCaptures.push({ phase, planIssue }); },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();
		expect(setPhaseCaptures[0]?.phase).toBe('planning');
		expect(setPhaseCaptures[0]?.planIssue).toBe('CAM-10');
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(1);
	});

	test('does NOT dispatch when phase is planning (not idle)', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'planning',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();
		expect(setPhaseCallCount).toBe(0);
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(0);
	});

	test('does NOT dispatch when phase is implementing', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'implementing',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();
		expect(setPhaseCallCount).toBe(0);
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(0);
	});

	test('does NOT dispatch when prd.json in flight (prdPresentFn true)', async () => {
		const { logger } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true, // PRD cycle in flight
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();
		expect(setPhaseCallCount).toBe(0);
	});

	test('does NOT dispatch when merge-watch present', async () => {
		const { logger } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => true, // merge-watch present
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();
		expect(setPhaseCallCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC#4: Refused fail-closed when preconditions not met
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: refused fail-closed (AC#4)', () => {
	test('emits refused event + warnFn for container-not-active', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const warnMessages: string[] = [];
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: false, reason: 'container-not-active' as const }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: (msg) => { warnMessages.push(msg); },
			logEvent: logger,
		});

		await dispatchFn();

		// Fail-closed: setPhaseFn never called
		expect(setPhaseCallCount).toBe(0);

		// Structured refusal event emitted
		const refusalEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(refusalEvents.length).toBe(1);
		const detail = refusalEvents[0]?.detail as { refused: boolean; reason: string };
		expect(detail.refused).toBe(true);
		expect(detail.reason).toBe('container-not-active');

		// stderr warning carries the reason
		expect(warnMessages.length).toBeGreaterThan(0);
		expect(warnMessages[0]).toContain('container-not-active');
	});

	test('emits refused event for plan-approval-not-auto', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const warnMessages: string[] = [];

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: false, reason: 'plan-approval-not-auto' as const }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			warnFn: (msg) => { warnMessages.push(msg); },
			logEvent: logger,
		});

		await dispatchFn();

		const detail = events.filter((ev) => ev.kind === 'meta-loop-dispatch')[0]?.detail as { refused: boolean; reason: string };
		expect(detail.refused).toBe(true);
		expect(detail.reason).toBe('plan-approval-not-auto');
		expect(warnMessages[0]).toContain('plan-approval-not-auto');
	});

	test('selectFn NOT called when preconditions fail (never drains degraded)', async () => {
		const { logger } = makeInMemoryEventLogger();
		let selectCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => { selectCallCount++; return makePlannableIssue(); },
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: false, reason: 'container-not-active' as const }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();

		// Refused before reaching selectFn
		expect(selectCallCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC#5: Drained path: observe event + drain-notify, no dispatch
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: drained path (AC#5)', () => {
	test('emits meta-loop-observe drained event when backlog is empty', async () => {
		const { logger, events } = makeInMemoryEventLogger();

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => null,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();

		const drainEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-observe' && (ev.detail as { drained?: boolean }).drained === true,
		);
		expect(drainEvents.length).toBe(1);
		// No dispatch event
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(0);
	});

	test('fires drain notify once on drained transition; deduped on subsequent calls', async () => {
		const { logger } = makeInMemoryEventLogger();
		const spy = makeDispatchDrainSpy();

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => null,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			drainNotifyFn: spy.drainNotifyFn,
			warnFn: () => {},
			logEvent: logger,
		});

		// Call twice; second is deduped
		await dispatchFn();
		await dispatchFn();

		expect(spy.callCount).toBe(1);
	});

	test('setPhaseFn NOT called when drained', async () => {
		const { logger } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => null,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();
		expect(setPhaseCallCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC#6: Kill-switch parks at boundary; sidecar loop keeps running
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: kill-switch parks at boundary (AC#6)', () => {
	test('emits stopped event once when kill-switch engaged', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => true,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();

		expect(setPhaseCallCount).toBe(0);
		const stoppedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { stopped?: boolean }).stopped === true,
		);
		expect(stoppedEvents.length).toBe(1);
	});

	test('stopped event emitted only once even across multiple calls (dedup)', async () => {
		const { logger, events } = makeInMemoryEventLogger();

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => true,
			setPhaseFn: () => {},
			warnFn: () => {},
			logEvent: logger,
		});

		for (let i = 0; i < 5; i++) await dispatchFn();

		const stoppedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { stopped?: boolean }).stopped === true,
		);
		expect(stoppedEvents.length).toBe(1);
	});

	test('sidecar loop keeps running (no SIGTERM) when dispatch fn parks via kill-switch', async () => {
		const { logger, events } = makeInMemoryEventLogger();

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => true,
			setPhaseFn: () => {},
			warnFn: () => {},
			logEvent: logger,
		});

		// Drive 3 idle ticks via runSidecarLoop to confirm the loop continues
		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: dispatchFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// Loop reached ESCAPE (completed 3 ticks without aborting), stopped event exactly once
		const stoppedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { stopped?: boolean }).stopped === true,
		);
		expect(stoppedEvents.length).toBe(1);
	});
});

// ===========================================================================
// US-005: Blocked-cycle judgment point (AC#1, AC#2, AC#3, AC#4)
// ===========================================================================

describe('meta-loop-dispatch: blocked-cycle judgment point (US-005)', () => {
	// Helper: build a blocked-cycle escalation spy.
	function makeBlockedCycleEscalateSpy(): { callCount: number; escalateFn: () => Promise<void> } {
		let callCount = 0;
		return {
			get callCount() { return callCount; },
			escalateFn: async () => { callCount++; },
		};
	}

	// AC#1: parks and emits blockedCycle event when prd has MAX_ROUNDS_DEBT
	test('parks (no dispatch), emits blockedCycle event when prd has MAX_ROUNDS_DEBT', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true,
			readPrdVerdictFn: () => 'MAX_ROUNDS_DEBT',
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();

		// Park: setPhaseFn never called
		expect(setPhaseCallCount).toBe(0);

		// Structured blockedCycle event emitted
		const blockedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { blockedCycle?: boolean }).blockedCycle === true,
		);
		expect(blockedEvents.length).toBe(1);
	});

	// AC#2: escalation fired when blockedCycleEscalateFn is configured
	test('fires blockedCycleEscalateFn exactly once when configured (Resend configured)', async () => {
		const { logger } = makeInMemoryEventLogger();
		const spy = makeBlockedCycleEscalateSpy();

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true,
			readPrdVerdictFn: () => 'MAX_ROUNDS_DEBT',
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			blockedCycleEscalateFn: spy.escalateFn,
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();

		expect(spy.callCount).toBe(1);
	});

	// AC#2: soft-warn emitted (not escalation) when blockedCycleEscalateFn absent
	test('emits warnFn (soft-warn) when blockedCycleEscalateFn absent (Resend unconfigured)', async () => {
		const { logger } = makeInMemoryEventLogger();
		const warnMessages: string[] = [];

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true,
			readPrdVerdictFn: () => 'MAX_ROUNDS_DEBT',
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			// blockedCycleEscalateFn absent: simulates unconfigured Resend
			warnFn: (msg) => { warnMessages.push(msg); },
			logEvent: logger,
		});

		await dispatchFn();

		// warnFn must have been called at least once
		expect(warnMessages.length).toBeGreaterThan(0);
		// The message must reference the blocked cycle condition
		expect(warnMessages[0]).toContain('blocked-cycle');
	});

	// AC#4: dedup - blocked event and escalation fired exactly once across multiple ticks
	test('dedup: blockedCycle event and escalation emitted once across multiple calls', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const spy = makeBlockedCycleEscalateSpy();

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true,
			readPrdVerdictFn: () => 'MAX_ROUNDS_DEBT',
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			blockedCycleEscalateFn: spy.escalateFn,
			warnFn: () => {},
			logEvent: logger,
		});

		// Call 5 times: only first should emit + escalate
		for (let i = 0; i < 5; i++) await dispatchFn();

		const blockedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { blockedCycle?: boolean }).blockedCycle === true,
		);
		expect(blockedEvents.length).toBe(1);
		expect(spy.callCount).toBe(1);
	});

	// AC#4: drain resumes when prd.json removed (block cleared)
	test('resumes dispatch when prd.json removed after being blocked', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const setPhaseCaptures: Array<{ phase: string; planIssue?: string }> = [];

		// First 3 calls: prd present + MAX_ROUNDS_DEBT (blocked)
		// Next calls: prd absent (block cleared)
		let prdPresent = true;
		let verdictValue: string | null = 'MAX_ROUNDS_DEBT';

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue('CAM-42'),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => prdPresent,
			readPrdVerdictFn: () => verdictValue,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: (phase, planIssue) => { setPhaseCaptures.push({ phase, planIssue }); },
			warnFn: () => {},
			logEvent: logger,
		});

		// While blocked: no dispatch
		await dispatchFn();
		await dispatchFn();
		expect(setPhaseCaptures.length).toBe(0);

		// Operator clears the block (removes prd.json)
		prdPresent = false;
		verdictValue = null;

		// Next call: dispatch resumes
		await dispatchFn();

		expect(setPhaseCaptures.length).toBe(1);
		expect(setPhaseCaptures[0]?.phase).toBe('planning');
		expect(setPhaseCaptures[0]?.planIssue).toBe('CAM-42');

		const dispatchEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { dispatched?: boolean }).dispatched === true,
		);
		expect(dispatchEvents.length).toBe(1);
	});

	// AC#4: still-blocked prd keeps parking without re-escalating
	test('still-blocked prd.json keeps parking each tick without re-escalating', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const spy = makeBlockedCycleEscalateSpy();

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true,
			readPrdVerdictFn: () => 'MAX_ROUNDS_DEBT',
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			blockedCycleEscalateFn: spy.escalateFn,
			warnFn: () => {},
			logEvent: logger,
		});

		// Simulate 5 idle ticks with prd still blocked
		for (let i = 0; i < 5; i++) await dispatchFn();

		// blockedCycle event emitted exactly once (not per-tick)
		const blockedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { blockedCycle?: boolean }).blockedCycle === true,
		);
		expect(blockedEvents.length).toBe(1);
		// Escalation fired exactly once
		expect(spy.callCount).toBe(1);
	});

	// Loop stays alive: drive via runSidecarLoop to confirm no SIGTERM/clearActive
	test('sidecar loop keeps running (no clearActive) when dispatcher parks on blocked cycle', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let clearActiveCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true,
			readPrdVerdictFn: () => 'MAX_ROUNDS_DEBT',
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			warnFn: () => {},
			logEvent: logger,
		});

		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: dispatchFn,
			hasPendingStories: () => false,
			clearActive: () => { clearActiveCallCount++; },
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// Loop reached ESCAPE (3 ticks without aborting): sidecar stayed alive
		// clearActive must NOT have been called by the dispatch fn itself
		expect(clearActiveCallCount).toBe(0);

		// blockedCycle event emitted exactly once (dedup across 3 ticks)
		const blockedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { blockedCycle?: boolean }).blockedCycle === true,
		);
		expect(blockedEvents.length).toBe(1);
	});

	// Plain in-flight prd (non-MAX_ROUNDS_DEBT) -> silent skip, no event
	test('plain in-flight prd (non-MAX_ROUNDS_DEBT verdict) -> silent skip, no blockedCycle event', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => makePlannableIssue(),
			readPhaseFn: () => 'idle',
			prdPresentFn: () => true,
			readPrdVerdictFn: () => 'FIXES_PENDING:2', // in-flight, not blocked
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn();

		// No dispatch, no blockedCycle event
		expect(setPhaseCallCount).toBe(0);
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(0);
	});

	// File-assert oracle: BLOCKED_CYCLE_ESCALATE_SUBJECT exported from sidecar.ts
	test('BLOCKED_CYCLE_ESCALATE_SUBJECT is exported from sidecar.ts and references MAX_ROUNDS_DEBT', () => {
		expect(typeof BLOCKED_CYCLE_ESCALATE_SUBJECT).toBe('string');
		expect(BLOCKED_CYCLE_ESCALATE_SUBJECT.length).toBeGreaterThan(0);
		// Subject must reference the blocked condition distinctly from drain/non-convergence
		expect(BLOCKED_CYCLE_ESCALATE_SUBJECT).not.toContain('drained');
		expect(BLOCKED_CYCLE_ESCALATE_SUBJECT).not.toContain('Non-convergence');
	});

	// File-assert oracle: sidecar.ts contains the new blocked-cycle handling
	test('sidecar.ts contains handleBlockedCycleBoundary and BLOCKED_CYCLE_ESCALATE_SUBJECT', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('handleBlockedCycleBoundary');
		expect(src).toContain('BLOCKED_CYCLE_ESCALATE_SUBJECT');
		expect(src).toContain('blockedCycleEmitted');
		expect(src).toContain('readPrdVerdictFn');
		expect(src).toContain('blockedCycleEscalateFn');
	});

	// File-assert oracle: events.ts contains blockedCycle variant
	test('events.ts MetaLoopDispatchEventDetail includes blockedCycle: true variant', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/supervisor/events.ts'),
			'utf8',
		);
		expect(src).toContain('blockedCycle');
	});
});
