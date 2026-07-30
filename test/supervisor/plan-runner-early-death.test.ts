// test/supervisor/plan-runner-early-death.test.ts
//
// Unit tests for the plan phase's three record-integrity defects (US-004,
// CAM-479):
//
//   AC1: planner pane death before prd.json exists yields a reason-bearing
//        terminal, not the bare 'planner-failed' with no reason field.
//   AC2: the auditor poll loop returns distinguishable results for pane
//        death versus cap elapsed, and the caller labels each with its own
//        cause on the observable channels (event, marker).
//   AC3: the emitted phase field never carries a synthesized reason string
//        like 'planner-timeout' (proved by a source grep, not a test here).
//   AC4: a plan timeout emits phase 'planner' with the reason carried in the
//        reason field on both the dispatch-failed event and the durable
//        marker, and the inner sentinel dispatch no longer stamps a reason
//        string into its own phase field.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanPhase, type RunPlanPhaseOptions } from '../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../src/supervisor/loop.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';
import type { DispatchFailedMarker } from '../../src/supervisor/dispatch-failed-marker.ts';
import { withVerifiedPanePid } from '../helpers/verified-pane-pid-spawn.ts';

// ---------------------------------------------------------------------------
// Generic backend fixture (isolates this suite's planner/auditor backend
// resolution from the repo's real project.toml, mirroring the sibling
// plan-runner suites' GENERIC_PLAN_CONFIG_PATH convention).
// ---------------------------------------------------------------------------

const GENERIC_PLAN_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cam-plan-runner-early-death-test-'));
const GENERIC_PLAN_CONFIG_PATH = join(GENERIC_PLAN_CONFIG_DIR, 'project.toml');
writeFileSync(GENERIC_PLAN_CONFIG_PATH, '[backend]\nplanner = "claude"\nauditor = "claude"\n');

afterAll(() => {
	rmSync(GENERIC_PLAN_CONFIG_DIR, { recursive: true, force: true });
});

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-99',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-01T00:00:00Z',
};

interface TmuxCall {
	cmd: string;
	args: string[];
}

/** Minimal spawnFn recording every call; respawn-pane/display-message succeed by default. */
function makeSpawn(
	override?: (cmd: string, args: string[]) => { stdout: string; stderr?: string; exitCode: number | null } | undefined,
): { fn: SpawnFn; calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	const fn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		const overridden = override?.(cmd, args);
		if (overridden !== undefined) return overridden;
		return { stdout: '', exitCode: 0 };
	};
	return { fn, calls };
}

function baseOpts(
	overrides: Partial<RunPlanPhaseOptions> & { spawnFn: SpawnFn },
): RunPlanPhaseOptions {
	return {
		isPaneAlive: () => false,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-early-death',
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: (() => {
			let t = 0;
			return () => (t += 100);
		})(),
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		configPath: GENERIC_PLAN_CONFIG_PATH,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC1: planner pane death before prd.json yields a reason-bearing terminal
// ---------------------------------------------------------------------------

describe('AC1: planner pane death before prd.json exists', () => {
	test('planner pane death before prd.json yields a reason-bearing terminal, not bare planner-failed', () => {
		const { fn } = makeSpawn();
		const opts = baseOpts({
			spawnFn: withVerifiedPanePid(fn),
			isPaneAlive: () => false, // pane already dead: never wrote prd.json
			readPlannerReportFn: () => null,
			readPlanVerdictFn: () => null, // must never be reached
		});

		const result = runPlanPhase(opts);

		expect(result.kind).toBe('planner-failed');
		// The bare pre-fix terminal ({ kind: 'planner-failed' }) carries NO
		// 'reason' key at all. The fixed terminal must carry a non-empty one.
		expect('reason' in result).toBe(true);
		expect(typeof (result as { reason?: string }).reason).toBe('string');
		expect(((result as { reason?: string }).reason ?? '').length).toBeGreaterThan(0);
	});

	test('the reason-bearing planner-failed terminal reaches the notification channel', () => {
		const { fn } = makeSpawn();
		const opts = baseOpts({
			spawnFn: withVerifiedPanePid(fn),
			isPaneAlive: () => false,
			readPlannerReportFn: () => null,
			readPlanVerdictFn: () => null,
		});

		const result = runPlanPhase(opts) as { kind: 'planner-failed'; reason?: string };
		expect(result.kind).toBe('planner-failed');
		expect(result.reason).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// AC2: auditor poll loop distinguishes pane death from cap elapsed
// ---------------------------------------------------------------------------

describe('AC2: auditor poll boundary distinguishes pane death from cap elapsed', () => {
	test('auditor pane death and auditor cap elapsed are distinguishable at the poll boundary', () => {
		// Scenario A: the auditor pane dies naturally before ever writing a
		// verdict, well before auditorTimeoutMs would fire.
		const markersA: DispatchFailedMarker[] = [];
		const eventsA: WorkerEvent[] = [];
		const { fn: fnA } = makeSpawn();
		const optsA = baseOpts({
			spawnFn: withVerifiedPanePid(fnA),
			isPaneAlive: () => true, // planner poll: pane alive, but...
			readPlannerReportFn: () => ({ written: true }), // ...report is written immediately
			readPlanVerdictFn: () => null, // auditor never writes a verdict
			auditorTimeoutMs: 999_999, // cap never reached
			logEvent: (event) => eventsA.push(event),
			writeDispatchFailedMarkerFn: (marker) => markersA.push(marker),
		});
		// The auditor's isPaneAlive must go false BEFORE the cap: override
		// isPaneAlive to flip after the planner tick has already completed.
		let auditorTicks = 0;
		optsA.isPaneAlive = (_paneId: string) => {
			// First call resolves the planner poll (pane alive); subsequent
			// calls are the auditor poll, which should see the pane already
			// dead so the pane-died branch fires deterministically.
			auditorTicks += 1;
			return auditorTicks <= 1;
		};

		const resultA = runPlanPhase(optsA);
		expect(resultA.kind).toBe('auditor-timeout');
		const auditorMarkerA = markersA.find((m) => m.phase === 'auditor');
		expect(auditorMarkerA?.reason).toBe('auditor-pane-died');

		// Scenario B: the auditor pane stays alive the whole time; the cap
		// elapses instead.
		const markersB: DispatchFailedMarker[] = [];
		const { fn: fnB } = makeSpawn();
		const optsB = baseOpts({
			spawnFn: withVerifiedPanePid(fnB),
			isPaneAlive: () => true, // pane never dies, for either poll
			readPlannerReportFn: () => ({ written: true }),
			readPlanVerdictFn: () => null,
			auditorTimeoutMs: 1,
			clock: (() => {
				let t = 0;
				return () => (t += 1_000);
			})(),
			writeDispatchFailedMarkerFn: (marker) => markersB.push(marker),
		});

		const resultB = runPlanPhase(optsB);
		expect(resultB.kind).toBe('auditor-timeout');
		const auditorMarkerB = markersB.find((m) => m.phase === 'auditor');
		expect(auditorMarkerB?.reason).toBe('auditor-timeout');

		// The two causes are NOT byte-identical: this is the whole point of AC2.
		expect(auditorMarkerA?.reason).not.toBe(auditorMarkerB?.reason);
	});
});

// ---------------------------------------------------------------------------
// AC4: the plan timeout terminal emits a real phase name, reason in `reason`
// ---------------------------------------------------------------------------

describe('AC4: plan timeout terminal phase/reason integrity', () => {
	test('the plan timeout terminal emits a real phase name with the reason in the reason field', () => {
		const events: WorkerEvent[] = [];
		const markers: DispatchFailedMarker[] = [];
		let now = 0;

		// Force the INNER sentinel dispatch (runVerifiedDispatch inside
		// emitPlanTimeoutTerminal) to itself fail, so it emits its OWN
		// dispatch-failed event/marker via emitDispatchFailure -- this is the
		// exact call site the pre-fix code corrupted (phase: reason).
		const { fn } = makeSpawn((_cmd, args) =>
			args[2] === 'respawn-pane' && args.includes('echo planner-timeout')
				? { stdout: '', stderr: 'sentinel refused', exitCode: 23 }
				: undefined,
		);

		const opts = baseOpts({
			spawnFn: withVerifiedPanePid(fn),
			isPaneAlive: () => true, // planner never dies; deadline fires instead
			plannerTimeoutMs: 1,
			clock: () => (now += 1_000),
			logEvent: (event) => events.push(event),
			writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
		});

		const result = runPlanPhase(opts);
		expect(result.kind).toBe('planner-timeout');

		// The INNER dispatch-failed event (from the sentinel's own failed
		// respawn-pane) must carry the REAL phase name, never the synthesized
		// 'planner-timeout' reason string, in its `phase` field.
		const innerEvent = events.find(
			(event) =>
				event.kind === 'dispatch-failed' &&
				(event.detail as { reason?: string }).reason === 'respawn-pane-exited',
		);
		expect(innerEvent).toBeDefined();
		expect((innerEvent?.detail as { phase?: string }).phase).toBe('planner');

		const innerMarker = markers.find((m) => m.reason === 'respawn-pane-exited');
		expect(innerMarker?.phase).toBe('planner');

		// The OUTER dispatch-failed terminal (the timeout itself) carries the
		// real phase name AND the reason in the reason field, on both the
		// event and the durable marker.
		const outerEvent = events.find(
			(event) =>
				event.kind === 'dispatch-failed' &&
				(event.detail as { reason?: string }).reason === 'planner-timeout',
		);
		expect(outerEvent).toBeDefined();
		expect((outerEvent?.detail as { phase?: string }).phase).toBe('planner');

		const outerMarker = markers.at(-1);
		expect(outerMarker?.phase).toBe('planner');
		expect(outerMarker?.reason).toBe('planner-timeout');
	});
});
