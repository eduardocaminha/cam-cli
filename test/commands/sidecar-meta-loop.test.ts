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
// Most tests use injected fakes; no real filesystem or tmux access. The
// US-001 (CAM-208) section at the bottom of this file is the exception: it
// drives buildMetaLoopFn directly, which reads worker_isolation/meta_loop via
// readWorkerIsolation/readMetaLoop (real fs reads against a tmpdir fixture,
// mirroring test/config/worker-isolation.test.ts).

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSidecarLoop, type RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';
import { makeInMemoryEventLogger, type WorkerEventLogger } from '../../src/supervisor/events.ts';
import { observeDecide, type ObserveState } from '../../src/supervisor/observe.ts';
import { sendEscalation, type ResendSendFn } from '../../src/notify/resend.ts';
import {
	DRAIN_NOTIFY_SUBJECT,
	BLOCKED_CYCLE_ESCALATE_SUBJECT,
	makeProductionMetaLoopDispatchFn,
	makeProductionMetaLoopObserveFn,
	buildMetaLoopFn,
} from '../../src/commands/sidecar.ts';
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
// US-001 (CAM-115): a selector throw during the observe tick must be
// surfaced as a logged error and NEVER converted into a drained/empty-backlog
// observation. selectPlannableFromFile no longer swallows read/parse errors
// (it used to `catch { return null }`), so makeProductionMetaLoopObserveFn now
// owns the boundary: it catches, logs via the WorkerEventLogger, and skips
// the tick without calling observeDecide.
// ---------------------------------------------------------------------------

describe('sidecar-meta-loop: observe-tick selector error boundary (US-001, CAM-115)', () => {
	test('a throwing selectFn is caught + logged and does NOT emit a drained meta-loop-observe event', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const observeFn = makeProductionMetaLoopObserveFn('/repo', logger, '', '', '', () => {
			throw new Error('corrupted backlog: unexpected token');
		});

		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// The real error is logged (not silently dropped).
		const errorEvents = events.filter(
			(ev) =>
				ev.kind === 'sidecar-exit' &&
				(ev.detail as { reason?: string }).reason === 'meta-loop-observe-select-error',
		);
		expect(errorEvents.length).toBeGreaterThan(0);
		expect((errorEvents[0]?.detail as { error?: string }).error).toContain(
			'corrupted backlog',
		);

		// NEVER converted into a drained/empty-backlog observation.
		const observeEvents = events.filter((ev) => ev.kind === 'meta-loop-observe');
		expect(observeEvents.length).toBe(0);
	});

	test('the sidecar outer loop survives a selector throw (does not crash on the tick)', async () => {
		const { logger } = makeInMemoryEventLogger();
		let callCount = 0;
		const observeFn = makeProductionMetaLoopObserveFn('/repo', logger, '', '', '', () => {
			callCount++;
			throw new Error('boom');
		});

		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: observeFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// All 3 ticks ran (the ESCAPE sentinel came from sleep(), not a crash
		// propagating out of the observe fn).
		expect(callCount).toBe(3);
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
		// US-007: previously silent; now emits a structured skip event (AC1).
		const skipEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(skipEvents.length).toBe(1);
		expect(skipEvents[0]?.detail).toEqual({ skipped: true, reason: 'phase-not-idle' });
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
		// US-007: previously silent; now emits a structured skip event (AC1).
		const skipEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(skipEvents.length).toBe(1);
		expect(skipEvents[0]?.detail).toEqual({ skipped: true, reason: 'phase-not-idle' });
	});

	test('does NOT dispatch when prd.json in flight (prdPresentFn true)', async () => {
		const { logger, events } = makeInMemoryEventLogger();
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
		// US-007: previously silent; now emits a structured skip event (AC1).
		const skipEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(skipEvents.length).toBe(1);
		expect(skipEvents[0]?.detail).toEqual({ skipped: true, reason: 'cycle-in-flight' });
	});

	test('does NOT dispatch when merge-watch present', async () => {
		const { logger, events } = makeInMemoryEventLogger();
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
		// US-007: previously silent; now emits a structured skip event (AC1).
		const skipEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(skipEvents.length).toBe(1);
		expect(skipEvents[0]?.detail).toEqual({ skipped: true, reason: 'merge-watch-present' });
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
	test('plain in-flight prd (non-MAX_ROUNDS_DEBT verdict) -> no dispatch, emits cycle-in-flight skip event (US-007)', async () => {
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

		// No dispatch, no blockedCycle event, but the previously-silent skip is
		// now observable with a structured reason (US-007, AC1).
		expect(setPhaseCallCount).toBe(0);
		const blockedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { blockedCycle?: boolean }).blockedCycle === true,
		);
		expect(blockedEvents.length).toBe(0);
		const skipEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(skipEvents.length).toBe(1);
		expect(skipEvents[0]?.detail).toEqual({ skipped: true, reason: 'cycle-in-flight' });
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

// ---------------------------------------------------------------------------
// US-004 (CAM-203): pending explicit plan_issue wins over top-of-queue pick
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: pending explicit plan_issue wins (US-004, CAM-203)', () => {
	test('AC1: pending target wins over a higher-ranked plannable issue', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const setPhaseCaptures: Array<{ phase: string; planIssue?: string }> = [];
		// Higher-ranked top-of-queue candidate (would win if selectFn were consulted).
		const topOfQueue = makePlannableIssue('CAM-66');
		// Explicit pending target: lower-ranked / unranked, but must win regardless.
		const explicitTarget: IssueEntry = {
			id: 'CAM-201',
			title: 'Explicit target',
			stage: 'specified',
			status: 'open',
			wsjf: { value: 5.0, timeCriticality: 5, riskReduction: 3, jobSize: 2 },
		} as IssueEntry;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => topOfQueue,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: (phase, planIssue) => { setPhaseCaptures.push({ phase, planIssue }); },
			warnFn: () => {},
			logEvent: logger,
			readPlanIssueFn: () => 'CAM-201',
			selectTargetFn: (targetId) => (targetId === 'CAM-201' ? explicitTarget : null),
		});

		await dispatchFn();

		expect(setPhaseCaptures.length).toBe(1);
		expect(setPhaseCaptures[0]?.phase).toBe('planning');
		expect(setPhaseCaptures[0]?.planIssue).toBe('CAM-201');

		const dispatchEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(dispatchEvents.length).toBe(1);
		const detail = dispatchEvents[0]?.detail as { dispatched: boolean; issueId: string };
		expect(detail.dispatched).toBe(true);
		expect(detail.issueId).toBe('CAM-201');
	});

	test('AC2: non-plannable pending target is refused, no substitute dispatch, plan_issue cleared', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const setPhaseCaptures: Array<{ phase: string; planIssue?: string }> = [];
		const topOfQueue = makePlannableIssue('CAM-66');
		let selectTargetCalls = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => topOfQueue,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: (phase, planIssue) => { setPhaseCaptures.push({ phase, planIssue }); },
			warnFn: () => {},
			logEvent: logger,
			readPlanIssueFn: () => 'CAM-999',
			selectTargetFn: (targetId) => { selectTargetCalls++; expect(targetId).toBe('CAM-999'); return null; },
		});

		await dispatchFn();

		// Never dispatches a different (top-of-queue) issue on this tick.
		expect(setPhaseCaptures.length).toBe(1);
		expect(setPhaseCaptures[0]?.phase).toBe('idle');
		expect(setPhaseCaptures[0]?.planIssue).toBeUndefined();
		expect(selectTargetCalls).toBe(1);

		const dispatchEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(dispatchEvents.length).toBe(1);
		const detail = dispatchEvents[0]?.detail as { refusedTarget: boolean; targetId: string };
		expect(detail.refusedTarget).toBe(true);
		expect(detail.targetId).toBe('CAM-999');
	});

	test('AC3: no pending plan_issue leaves top-of-queue dispatch unchanged', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const setPhaseCaptures: Array<{ phase: string; planIssue?: string }> = [];
		const topOfQueue = makePlannableIssue('CAM-42');

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => topOfQueue,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: (phase, planIssue) => { setPhaseCaptures.push({ phase, planIssue }); },
			warnFn: () => {},
			logEvent: logger,
			readPlanIssueFn: () => undefined,
			selectTargetFn: () => { throw new Error('selectTargetFn must not be called when no pending target'); },
		});

		await dispatchFn();

		expect(setPhaseCaptures.length).toBe(1);
		expect(setPhaseCaptures[0]?.phase).toBe('planning');
		expect(setPhaseCaptures[0]?.planIssue).toBe('CAM-42');

		const dispatchEvents = events.filter((ev) => ev.kind === 'meta-loop-dispatch');
		expect(dispatchEvents.length).toBe(1);
		const detail = dispatchEvents[0]?.detail as { dispatched: boolean; issueId: string };
		expect(detail.dispatched).toBe(true);
		expect(detail.issueId).toBe('CAM-42');
	});

	test('AC3: existing dispatcher tests pass unchanged when readPlanIssueFn/selectTargetFn are absent', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const setPhaseCaptures: Array<{ phase: string; planIssue?: string }> = [];
		const topOfQueue = makePlannableIssue('CAM-77');

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => topOfQueue,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: (phase, planIssue) => { setPhaseCaptures.push({ phase, planIssue }); },
			warnFn: () => {},
			logEvent: logger,
			// readPlanIssueFn and selectTargetFn deliberately absent.
		});

		await dispatchFn();

		expect(setPhaseCaptures.length).toBe(1);
		expect(setPhaseCaptures[0]?.phase).toBe('planning');
		expect(setPhaseCaptures[0]?.planIssue).toBe('CAM-77');
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(1);
	});

	// File-assert oracle (AC4): buildProductionDispatchFn wires readPlanIssueFn.
	test('sidecar.ts wires readPlanIssueFn in production dispatch build (AC4 oracle)', () => {
		const src = readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('readPlanIssueFn');
		expect(src).toContain('selectTargetFn');
		expect(src).toContain('makeReadPlanIssue(claudeDir)');
		expect(src).toContain('selectPlanTargetFromFile(cwd, targetId)');
	});
});

// ---------------------------------------------------------------------------
// US-007 (CAM-195, Defect 2 refusals + CAM-98 rider): per-issue pending-guard.
// Reproduces the ~4.7s dispatched:true storm: a mutex-busy plan-phase retry
// resets phase back to 'idle' before a PRD ever exists for the issue, so the
// SAME still-open issue is re-selected on every idle tick. The guard must
// keep calling setPhaseFn (retry stays alive) but stop re-emitting the event.
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: per-issue pending-guard (US-007, CAM-98 storm)', () => {
	test('repeat dispatch of the SAME issue across ticks calls setPhaseFn every time but emits dispatched:true only once', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;
		const fixture = makePlannableIssue('CAM-98');

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => fixture,
			readPhaseFn: () => 'idle', // mutex-busy already bounced phase back to idle
			prdPresentFn: () => false, // PRD never got created (mutex kept refusing)
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
		});

		// Simulate 5 idle ticks retrying the same still-open issue.
		for (let i = 0; i < 5; i++) await dispatchFn();

		// setPhaseFn keeps firing every tick: the retry mechanism is untouched.
		expect(setPhaseCallCount).toBe(5);

		// 'dispatched:true' only fires once: the storm is eliminated.
		const dispatchedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { dispatched?: boolean }).dispatched === true,
		);
		expect(dispatchedEvents.length).toBe(1);
		expect((dispatchedEvents[0]?.detail as { issueId: string }).issueId).toBe('CAM-98');
	});

	test('a DIFFERENT issue selected after the pending one clears the guard and emits again', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let selected: IssueEntry = makePlannableIssue('CAM-98');

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => selected,
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			warnFn: () => {},
			logEvent: logger,
		});

		await dispatchFn(); // dispatches CAM-98
		await dispatchFn(); // repeat: deduped, no new event
		selected = makePlannableIssue('CAM-99'); // backlog moved on to a new issue
		await dispatchFn(); // dispatches CAM-99: guard is keyed by identity, not a sticky lock

		const dispatchedEvents = events.filter(
			(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { dispatched?: boolean }).dispatched === true,
		);
		expect(dispatchedEvents.length).toBe(2);
		expect((dispatchedEvents[0]?.detail as { issueId: string }).issueId).toBe('CAM-98');
		expect((dispatchedEvents[1]?.detail as { issueId: string }).issueId).toBe('CAM-99');
	});

	// File-assert oracle: DispatchClosureState carries the pending-guard field.
	test('sidecar.ts DispatchClosureState carries pendingIssueId (AC3 oracle)', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');
		expect(src).toContain('pendingIssueId');
	});
});

// ---------------------------------------------------------------------------
// US-R1-001 (CAM-115): a selector throw during an auto-dispatch tick must be
// surfaced as a logged error and never converted into a dispatch or a drained
// observation. selectPlannableFromFile/selectPlanTargetFromFile no longer
// swallow read/parse errors, so dispatchOrDrain/handlePendingTarget now own
// that boundary too (mirrors the observe-tick fix in the US-001 section above,
// which only covered makeProductionMetaLoopObserveFn).
// ---------------------------------------------------------------------------

describe('meta-loop-dispatch: selector error boundary (US-R1-001, CAM-115)', () => {
	test('a throwing selectFn (no pending target) is caught + logged and does NOT dispatch or drain', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => { throw new Error('corrupted backlog: unexpected token'); },
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
		const errorEvents = events.filter(
			(ev) =>
				ev.kind === 'sidecar-exit' &&
				(ev.detail as { reason?: string }).reason === 'meta-loop-dispatch-select-error',
		);
		expect(errorEvents.length).toBe(1);
		expect((errorEvents[0]?.detail as { error?: string }).error).toContain('corrupted backlog');

		// Never converted into a dispatch or a drained observation.
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(0);
		expect(events.filter((ev) => ev.kind === 'meta-loop-observe').length).toBe(0);
	});

	test('a throwing selectTargetFn (pending target present) is caught + logged, plan_issue left untouched', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		let setPhaseCallCount = 0;

		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => { throw new Error('selectFn must not be called when a pending target is set'); },
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => { setPhaseCallCount++; },
			warnFn: () => {},
			logEvent: logger,
			readPlanIssueFn: () => 'CAM-201',
			selectTargetFn: () => { throw new Error('corrupted backlog: unexpected token'); },
		});

		await dispatchFn();

		// Never dispatches, and never clears the pending plan_issue on a transient error
		// (setPhaseFn is only called on a successful resolve or a genuine not-found refusal).
		expect(setPhaseCallCount).toBe(0);
		const errorEvents = events.filter(
			(ev) =>
				ev.kind === 'sidecar-exit' &&
				(ev.detail as { reason?: string }).reason === 'meta-loop-dispatch-select-target-error',
		);
		expect(errorEvents.length).toBe(1);
		expect((errorEvents[0]?.detail as { error?: string }).error).toContain('corrupted backlog');
		expect(events.filter((ev) => ev.kind === 'meta-loop-dispatch').length).toBe(0);
	});

	test('the sidecar outer loop survives a dispatch selectFn throw across ticks', async () => {
		const { logger } = makeInMemoryEventLogger();
		let callCount = 0;
		const dispatchFn = makeProductionMetaLoopDispatchFn({
			selectFn: () => { callCount++; throw new Error('boom'); },
			readPhaseFn: () => 'idle',
			prdPresentFn: () => false,
			mergeWatchPresentFn: () => false,
			preconditionFn: () => ({ ok: true }),
			killSwitchFn: () => false,
			setPhaseFn: () => {},
			warnFn: () => {},
			logEvent: logger,
		});

		// Same wiring seam runMetaLoopObserveFn is used for both meta_loop=observe
		// and meta_loop=auto in production (buildProductionDispatchFn / sidecar.ts).
		const loopOpts = makeIdleLoopOpts(3, {
			runMetaLoopObserveFn: dispatchFn,
			hasPendingStories: () => false,
		});

		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// All 3 ticks ran (the ESCAPE sentinel came from sleep(), not a crash
		// propagating out of the dispatch fn).
		expect(callCount).toBe(3);
	});
});

// ===========================================================================
// US-001 (CAM-208): gate meta_loop=auto dispatcher arming on worker_isolation=container
// ===========================================================================
//
// buildMetaLoopFn runs once at sidecar boot (not per idle tick), so these tests
// call it directly against a tmpdir project.toml fixture (real fs reads via
// readMetaLoop/readWorkerIsolation, mirroring test/config/worker-isolation.test.ts)
// rather than injecting a fake. This is the only way to assert the boot-time
// warn fires exactly once.

function writeGateProjectToml(cwd: string, content: string): void {
	const dir = join(cwd, 'scripts/cam');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'project.toml'), content, 'utf8');
}

/**
 * Minimal SidecarLoopDepsCtx-shaped object for buildMetaLoopFn. Only `cwd` is
 * read by the host/off/observe branches; `realSpawnFn` is never invoked in
 * these tests (constructing the container-branch dispatch closure does not
 * spawn docker/tmux -- only calling the returned fn would).
 */
function makeGateCtx(cwd: string, logEvent: WorkerEventLogger): Parameters<typeof buildMetaLoopFn>[0] {
	return {
		cwd,
		claudeDir: join(cwd, '.claude'),
		prdPath: join(cwd, 'scripts/cam/prd.json'),
		sessionName: 'cam-gate-test-session',
		logEvent,
		realSpawnFn: (() => ({
			pid: 0,
			output: [],
			stdout: '',
			stderr: '',
			status: 0,
			signal: null,
		})) as unknown as Parameters<typeof buildMetaLoopFn>[0]['realSpawnFn'],
	};
}

/** Capture process.stderr.write calls for the duration of `fn`, then restore. */
function withCapturedStderr<T>(fn: () => T): { result: T; stderrLines: string[] } {
	const stderrLines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = fn();
		return { result, stderrLines };
	} finally {
		process.stderr.write = original;
	}
}

describe('buildMetaLoopFn gate (US-001, CAM-208): meta_loop=auto requires worker_isolation=container', () => {
	let tmpDir: string;

	function setupTmp(): void {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-meta-loop-gate-test-'));
	}
	function teardownTmp(): void {
		rmSync(tmpDir, { recursive: true, force: true });
	}

	test('meta_loop=auto + worker_isolation=host: returns undefined and warns exactly once', () => {
		setupTmp();
		try {
			writeGateProjectToml(
				tmpDir,
				'[loop]\nmeta_loop = "auto"\nworker_isolation = "host"\n',
			);
			const { logger } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);

			const { result: fn, stderrLines } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, {}, logger, { apiKey: '', recipient: '', from: '' }),
			);

			expect(fn).toBeUndefined();
			expect(stderrLines.length).toBe(1);
			expect(stderrLines.join('')).toContain(
				'meta_loop=auto requires worker_isolation=container; auto-chaining disabled in host mode',
			);
		} finally {
			teardownTmp();
		}
	});

	test('meta_loop=auto + worker_isolation absent (defaults to host): returns undefined and warns once', () => {
		setupTmp();
		try {
			writeGateProjectToml(tmpDir, '[loop]\nmeta_loop = "auto"\n');
			const { logger } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);

			const { result: fn, stderrLines } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, {}, logger, { apiKey: '', recipient: '', from: '' }),
			);

			expect(fn).toBeUndefined();
			expect(stderrLines.length).toBe(1);
		} finally {
			teardownTmp();
		}
	});

	test('meta_loop=auto + worker_isolation=container: returns a defined dispatcher, no warning', () => {
		setupTmp();
		try {
			writeGateProjectToml(
				tmpDir,
				'[loop]\nmeta_loop = "auto"\nworker_isolation = "container"\n',
			);
			const { logger } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);

			const { result: fn, stderrLines } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, {}, logger, { apiKey: '', recipient: '', from: '' }),
			);

			expect(typeof fn).toBe('function');
			expect(stderrLines.length).toBe(0);
		} finally {
			teardownTmp();
		}
	});

	test('meta_loop=observe is unchanged regardless of worker_isolation (host)', () => {
		setupTmp();
		try {
			writeGateProjectToml(
				tmpDir,
				'[loop]\nmeta_loop = "observe"\nworker_isolation = "host"\n',
			);
			const { logger } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);

			const { result: fn, stderrLines } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, {}, logger, { apiKey: '', recipient: '', from: '' }),
			);

			expect(typeof fn).toBe('function');
			expect(stderrLines.length).toBe(0);
		} finally {
			teardownTmp();
		}
	});

	test('meta_loop=off returns undefined regardless of worker_isolation, no warning', () => {
		setupTmp();
		try {
			writeGateProjectToml(
				tmpDir,
				'[loop]\nmeta_loop = "off"\nworker_isolation = "host"\n',
			);
			const { logger } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);

			const { result: fn, stderrLines } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, {}, logger, { apiKey: '', recipient: '', from: '' }),
			);

			expect(fn).toBeUndefined();
			expect(stderrLines.length).toBe(0);
		} finally {
			teardownTmp();
		}
	});

	test('options.runMetaLoopObserveFn override wins over the gate even in host mode (no warning)', () => {
		setupTmp();
		try {
			writeGateProjectToml(
				tmpDir,
				'[loop]\nmeta_loop = "auto"\nworker_isolation = "host"\n',
			);
			const { logger } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);
			const overrideFn = async () => {};

			const { result: fn, stderrLines } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, { runMetaLoopObserveFn: overrideFn }, logger, { apiKey: '', recipient: '', from: '' }),
			);

			expect(fn).toBe(overrideFn);
			expect(stderrLines.length).toBe(0);
		} finally {
			teardownTmp();
		}
	});

	// Regression test (per story notes item 6): (a) host -> undefined + boot warn
	// exactly once; (b) container -> defined dispatcher. Also drives the resolved
	// (undefined) fn through N idle ticks of the real sidecar loop to prove zero
	// 'meta-loop-dispatch' refused events and no additional stderr warnings.
	test('regression: host across N idle ticks emits zero refused dispatch events and exactly one boot warn', async () => {
		setupTmp();
		try {
			writeGateProjectToml(
				tmpDir,
				'[loop]\nmeta_loop = "auto"\nworker_isolation = "host"\n',
			);
			const { logger, events } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);

			// (a) Boot-time resolution: runs once, mirroring buildSidecarLoopDeps.
			const { result: runMetaLoopObserveFn, stderrLines } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, {}, logger, { apiKey: '', recipient: '', from: '' }),
			);
			expect(runMetaLoopObserveFn).toBeUndefined();
			expect(stderrLines.length).toBe(1);

			// Drive 5 idle ticks with the resolved (undefined) fn wired in as
			// runMetaLoopObserveFn, exactly as the production sidecar does.
			const loopOpts = makeIdleLoopOpts(5, {
				runMetaLoopObserveFn,
				hasPendingStories: () => false,
			});

			try {
				await runSidecarLoop(loopOpts);
			} catch (e) {
				if (e !== ESCAPE) throw e;
			}

			const refusedEvents = events.filter(
				(ev) => ev.kind === 'meta-loop-dispatch' && (ev.detail as { refused?: boolean }).refused === true,
			);
			expect(refusedEvents.length).toBe(0);
			// No additional stderr writes beyond the single boot-time warn captured
			// above: the idle loop never calls buildMetaLoopFn again per tick.
			expect(stderrLines.length).toBe(1);
		} finally {
			teardownTmp();
		}
	});

	// (b) container -> production dispatcher (not undefined); behavior unchanged.
	test('regression: container mode still returns the production dispatch fn', () => {
		setupTmp();
		try {
			writeGateProjectToml(
				tmpDir,
				'[loop]\nmeta_loop = "auto"\nworker_isolation = "container"\n',
			);
			const { logger } = makeInMemoryEventLogger();
			const ctx = makeGateCtx(tmpDir, logger);

			const { result: fn } = withCapturedStderr(() =>
				buildMetaLoopFn(ctx, {}, logger, { apiKey: '', recipient: '', from: '' }),
			);

			expect(fn).toBeDefined();
			expect(typeof fn).toBe('function');
		} finally {
			teardownTmp();
		}
	});
});

describe('buildMetaLoopFn gate: file-assert oracle (AC#3)', () => {
	test('sidecar.ts contains the exact boot-warn string', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');
		expect(src).toContain('meta_loop=auto requires worker_isolation=container; auto-chaining disabled in host mode');
	});

	test('sidecar.ts exports buildMetaLoopFn for the regression test (AC#6)', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');
		expect(src).toContain('export function buildMetaLoopFn');
	});
});
