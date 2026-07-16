// test/plan-runner-in-progress-conflict.test.ts
//
// Unit tests: in-progress-work conflict gate at plan start (US-004, CAM-241/153).
//
// Acceptance criteria proved:
//   AC1: detectInProgressConflictFn is called FIRST, before
//        clearStalePlanArtifactsFn/preflightFn/selectIssueFn -- none of those
//        run when a conflict is detected.
//   AC2: writeInProgressConflictGateFn is called with the detected context,
//        exactly once, and runPlanPhase returns { kind: 'in-progress-conflict' }.
//   AC4: no conflict (detectInProgressConflictFn returns null, or the dep is
//        absent) proceeds straight to the normal plan-phase sequence
//        (clearStalePlanArtifactsFn -> preflightFn -> selectIssueFn), with no
//        gate write.
//   AC1 (re-plan non-refire guard): runPlanPhaseWithReplan fires the
//        detection at most once per outer call, even across multiple
//        replan rounds -- a re-plan round's own just-written draft prd.json
//        must never be misdetected as in-progress work from a different cycle.

import { test, expect } from 'bun:test';

import {
	runPlanPhase,
	runPlanPhaseWithReplan,
	MAX_REPLAN_ROUNDS,
	type RunPlanPhaseOptions,
	type RunPlanPhaseWithReplanOptions,
} from '../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../src/issues/types.ts';
import type { PlanPreflightResult } from '../src/supervisor/plan-preflight.ts';

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-153',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-16T00:00:00Z',
	updatedAt: '2026-07-16T00:00:00Z',
};

const APPROVE_REPORT: PlanVerdictReport = { verdict: 'APPROVE', summary: 'ok', findings: [] };
const BLOCK_REPORT: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'blocked',
	findings: [{ id: 'A.001', category: 'A.completeness', severity: 'critical', description: 'missing' }],
};

const PREFLIGHT_OK: PlanPreflightResult = { ok: true };

const noopSpawnFn: SpawnFn = () => ({ stdout: '', exitCode: 0 });

/** Minimal base opts; each test overrides only what it needs. */
function baseOpts(overrides: Partial<RunPlanPhaseOptions> = {}): RunPlanPhaseOptions {
	return {
		spawnFn: noopSpawnFn,
		isPaneAlive: () => false,
		sleepFn: () => {},
		genUuid: () => 'uuid-0000',
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => APPROVE_REPORT,
		preflightFn: () => PREFLIGHT_OK,
		clock: Date.now,
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC1/AC2: conflict detected -> short-circuit, nothing else runs
// ---------------------------------------------------------------------------

test('AC1/AC2: a detected conflict short-circuits BEFORE clearStalePlanArtifactsFn/preflightFn/selectIssueFn, and writes the gate with the context', () => {
	let clearCalls = 0;
	let preflightCalls = 0;
	let selectCalls = 0;
	const writeCalls: string[] = [];

	const result = runPlanPhase(
		baseOpts({
			clearStalePlanArtifactsFn: () => { clearCalls++; },
			preflightFn: () => { preflightCalls++; return PREFLIGHT_OK; },
			selectIssueFn: () => { selectCalls++; return MOCK_ISSUE; },
			detectInProgressConflictFn: () => 'in-progress work detected (test)',
			writeInProgressConflictGateFn: (context) => { writeCalls.push(context); },
		}),
	);

	expect(result).toEqual({ kind: 'in-progress-conflict' });
	expect(clearCalls).toBe(0);
	expect(preflightCalls).toBe(0);
	expect(selectCalls).toBe(0);
	expect(writeCalls).toEqual(['in-progress work detected (test)']);
});

test('AC1/AC2: writeInProgressConflictGateFn absent -- short-circuit still returns in-progress-conflict without crashing', () => {
	const result = runPlanPhase(
		baseOpts({
			detectInProgressConflictFn: () => 'conflict',
		}),
	);
	expect(result).toEqual({ kind: 'in-progress-conflict' });
});

// ---------------------------------------------------------------------------
// AC4: no conflict -> normal sequence proceeds, no gate written
// ---------------------------------------------------------------------------

test('AC4: detectInProgressConflictFn returning null proceeds to the normal sequence with no gate write', () => {
	let clearCalls = 0;
	let preflightCalls = 0;
	let selectCalls = 0;
	let writeCalls = 0;

	const result = runPlanPhase(
		baseOpts({
			clearStalePlanArtifactsFn: () => { clearCalls++; },
			preflightFn: () => { preflightCalls++; return PREFLIGHT_OK; },
			selectIssueFn: () => { selectCalls++; return null; },
			detectInProgressConflictFn: () => null,
			writeInProgressConflictGateFn: () => { writeCalls++; },
		}),
	);

	expect(result).toEqual({ kind: 'no-plannable-issue' });
	expect(clearCalls).toBe(1);
	expect(preflightCalls).toBe(1);
	expect(selectCalls).toBe(1);
	expect(writeCalls).toBe(0);
});

test('AC4: detectInProgressConflictFn absent entirely (backward compat) -- zero behavior change', () => {
	let clearCalls = 0;
	const result = runPlanPhase(
		baseOpts({
			clearStalePlanArtifactsFn: () => { clearCalls++; },
			selectIssueFn: () => null,
		}),
	);
	expect(result).toEqual({ kind: 'no-plannable-issue' });
	expect(clearCalls).toBe(1);
});

// ---------------------------------------------------------------------------
// AC1 (re-plan non-refire guard): detection fires at most once per outer call
// ---------------------------------------------------------------------------

test('re-plan rounds never re-invoke detectInProgressConflictFn (round 1 only)', () => {
	let detectCalls = 0;
	let plannerAliveCount = 1;
	let teardownCount = 0;
	let roundIndex = 0;

	const verdicts: PlanVerdictReport[] = [BLOCK_REPORT, APPROVE_REPORT];

	const replanOpts: RunPlanPhaseWithReplanOptions = {
		spawnFn: noopSpawnFn,
		isPaneAlive: () => {
			if (plannerAliveCount > 0) {
				plannerAliveCount--;
				return true;
			}
			return false;
		},
		sleepFn: () => {},
		genUuid: (() => { let n = 0; return () => `uuid-${++n}`; })(),
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => verdicts[roundIndex] ?? APPROVE_REPORT,
		preflightFn: () => PREFLIGHT_OK,
		clock: (() => { let t = 0; return () => (t += 100); })(),
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		detectInProgressConflictFn: () => { detectCalls++; return null; },
		writeInProgressConflictGateFn: () => { /* must never be called in this scenario */ },
		teardownPlanPanesFn: () => {
			teardownCount++;
			roundIndex++;
			plannerAliveCount = 1;
		},
	};

	const result = runPlanPhaseWithReplan(replanOpts);

	// Round 1 BLOCK -> round 2 APPROVE (MAX_REPLAN_ROUNDS=2): converges by round 2.
	expect(MAX_REPLAN_ROUNDS).toBe(2);
	expect(result.kind).toBe('audit-approved');
	expect(teardownCount).toBeGreaterThanOrEqual(1);
	// The in-progress-conflict detection must fire EXACTLY once (round 1), never
	// re-invoked on the round-2 re-plan call.
	expect(detectCalls).toBe(1);
});
