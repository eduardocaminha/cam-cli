// test/supervisor/plan/plan-runner-replan.test.ts
//
// Unit tests for runPlanPhaseWithReplan in src/supervisor/plan-runner.ts
// (US-003, CAM-204).
//
// Coverage (matches AC1-AC5):
//   1.  Round 1 audit-approved: terminal, no re-plan round triggered.
//   2.  Round 1 audit-approved: exactly ONE runPlanPhase-equivalent spawn sequence.
//   3.  Round 1 audit-blocked, round 2 audit-approved: returns audit-approved (AC1).
//   4.  Round 2 is pinned to the SAME issue as round 1 (no re-selection) (AC1).
//   5.  Round 2's plannerTaskPrompt is built via buildReplanPlannerTaskPrompt.
//   6.  Round-2 planner spawn prompt contains the non-empty round-1 findings text (AC2).
//   7.  Both rounds audit-blocked: returns a terminal plan-escalated kind (never
//       audit-approved, never audit-blocked) (AC3).
//   8.  Escalation: writeEscalationMarkerFn called with issue id + last round's
//       findings + summary + roundsCompleted (AC3).
//   9.  Escalation: no git/branch spawn occurs (AC3).
//  10.  teardownPlanPanesFn fires on the audit-approved terminal (AC4).
//  11.  teardownPlanPanesFn fires BEFORE each re-plan round's runPlanPhase call (AC4).
//  12.  teardownPlanPanesFn fires on the plan-escalated terminal (AC4).
//  13.  teardownPlanPanesFn fires exactly twice when round1=blocked, round2=escalated
//       (once before round 2, once on the escalated terminal).
//  14.  Non-audit result (preflight-failed) returned as-is, no re-plan round (AC5).
//  15.  Non-audit result (no-plannable-issue) returned as-is, no re-plan round (AC5).
//  16.  Non-audit result (mutex-busy) returned as-is, no re-plan round (AC5).
//  17.  Non-audit result: teardownPlanPanesFn NOT called.
//  18.  writeEscalationMarkerFn NOT called on audit-approved terminal.
//  19.  writeEscalationMarkerFn NOT called on a non-audit terminal.
//  20.  Backward compat: options work when teardownPlanPanesFn/writeEscalationMarkerFn absent.

import { describe, expect, test } from 'bun:test';
import {
	runPlanPhaseWithReplan,
	type RunPlanPhaseWithReplanOptions,
	type PlanEscalationWriterParams,
	MAX_REPLAN_ROUNDS,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../../../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { PlanPreflightResult } from '../../../src/supervisor/plan-preflight.ts';
import type { WorkerEvent } from '../../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-204',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-01T00:00:00Z',
};

const APPROVE_REPORT: PlanVerdictReport = {
	verdict: 'APPROVE',
	summary: 'Plan looks good',
	findings: [],
};

const BLOCK_REPORT_ROUND1: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Round 1 plan has issues',
	findings: [
		{
			id: 'A.001',
			category: 'A.completeness',
			severity: 'critical',
			description: 'Missing acceptance criteria for US-002 in round 1',
		},
	],
};

const BLOCK_REPORT_ROUND2: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Round 2 plan still has issues',
	findings: [
		{
			id: 'A.002',
			category: 'A.completeness',
			severity: 'important',
			description: 'Story notes are too sparse in round 2',
		},
	],
};

const PREFLIGHT_OK: PlanPreflightResult = { ok: true };
const PREFLIGHT_FAIL: PlanPreflightResult = {
	ok: false,
	step: 'typecheck',
	detail: 'error TS2345',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

/**
 * Builds opts for runPlanPhaseWithReplan. Each call to runPlanPhase (round)
 * consumes one entry from `verdicts` in order; readPlanVerdictFn returns that
 * round's report on first read. selectIssueFn defaults to always returning
 * MOCK_ISSUE (round 1); round 2+ overrides are applied internally by
 * runPlanPhaseWithReplan itself, so this fixture does not need to simulate
 * pinning (the test asserts pinning via the spawned prompt / selectIssueFn
 * call args).
 */
function makeReplanOpts(
	verdicts: PlanVerdictReport[],
	overrides: Partial<RunPlanPhaseWithReplanOptions> = {},
): {
	opts: RunPlanPhaseWithReplanOptions;
	calls: TmuxCall[];
	teardownCallCount: () => number;
	markerCalls: PlanEscalationWriterParams[];
	selectIssueCallCount: () => number;
	loggedEvents: WorkerEvent[];
} {
	const calls: TmuxCall[] = [];
	let teardownCount = 0;
	const markerCalls: PlanEscalationWriterParams[] = [];
	let selectIssueCalls = 0;
	let roundIndex = 0;
	const loggedEvents: WorkerEvent[] = [];

	const spawnFn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	// Each round: planner dies after 1 tick, then auditor returns verdicts[roundIndex].
	let plannerAliveCount = 1;

	const opts: RunPlanPhaseWithReplanOptions = {
		spawnFn,
		isPaneAlive: () => {
			if (plannerAliveCount > 0) {
				plannerAliveCount--;
				return true;
			}
			return false;
		},
		sleepFn: () => {},
		genUuid: (() => {
			let n = 0;
			return () => `uuid-${++n}`;
		})(),
		selectIssueFn: () => {
			selectIssueCalls++;
			return MOCK_ISSUE;
		},
		readPlanVerdictFn: () => {
			const report = verdicts[roundIndex] ?? verdicts[verdicts.length - 1] ?? APPROVE_REPORT;
			return report;
		},
		preflightFn: () => PREFLIGHT_OK,
		clock: (() => {
			let t = 0;
			return () => (t += 100);
		})(),
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		teardownPlanPanesFn: () => {
			teardownCount++;
			// Reset the per-round planner-alive counter and advance the round
			// index so the next runPlanPhase call reads the NEXT verdict.
			plannerAliveCount = 1;
			roundIndex++;
		},
		writeEscalationMarkerFn: (params) => {
			markerCalls.push(params);
		},
		logEvent: (event) => {
			loggedEvents.push(event);
		},
		...overrides,
	};

	return {
		opts,
		calls,
		teardownCallCount: () => teardownCount,
		markerCalls,
		selectIssueCallCount: () => selectIssueCalls,
		loggedEvents,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlanPhaseWithReplan', () => {
	// -------------------------------------------------------------------------
	// Round 1 audit-approved: terminal, no re-plan (AC1)
	// -------------------------------------------------------------------------
	test('round 1 audit-approved is terminal (no re-plan round)', () => {
		const { opts } = makeReplanOpts([APPROVE_REPORT]);
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('audit-approved');
	});

	test('round 1 audit-approved: selectIssueFn called exactly once (no re-plan)', () => {
		const { opts, selectIssueCallCount } = makeReplanOpts([APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);
		expect(selectIssueCallCount()).toBe(1);
	});

	test('round 1 audit-approved: teardownPlanPanesFn fires exactly once (AC4)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);
		expect(teardownCallCount()).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Round 1 blocked, round 2 approved (AC1)
	// -------------------------------------------------------------------------
	test('round 1 blocked, round 2 approved: returns audit-approved (AC1)', () => {
		const { opts } = makeReplanOpts([BLOCK_REPORT_ROUND1, APPROVE_REPORT]);
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('audit-approved');
	});

	test('round 2 is pinned to the SAME issue as round 1 (no re-selection) (AC1)', () => {
		const { opts } = makeReplanOpts([BLOCK_REPORT_ROUND1, APPROVE_REPORT]);
		const result = runPlanPhaseWithReplan(opts) as { kind: 'audit-approved'; issue: IssueEntry };
		expect(result.issue.id).toBe('CAM-204');
	});

	test('round-2 planner spawn prompt contains the non-empty round-1 findings text (AC2)', () => {
		const { opts, calls } = makeReplanOpts([BLOCK_REPORT_ROUND1, APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);

		const plannerRespawns = calls.filter(
			(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-planner')),
		);
		// Two rounds -> two planner spawns.
		expect(plannerRespawns.length).toBe(2);
		const round2Shell = plannerRespawns[1]?.args[plannerRespawns[1].args.length - 1] ?? '';
		expect(round2Shell).toContain('Missing acceptance criteria for US-002 in round 1');
	});

	test('round-2 planner spawn prompt names the pinned issue id and forbids re-selection (AC1)', () => {
		const { opts, calls } = makeReplanOpts([BLOCK_REPORT_ROUND1, APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);

		const plannerRespawns = calls.filter(
			(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-planner')),
		);
		const round2Shell = plannerRespawns[1]?.args[plannerRespawns[1].args.length - 1] ?? '';
		expect(round2Shell).toContain('CAM-204');
		expect(round2Shell).toContain('Do not re-select from the backlog');
	});

	test('teardownPlanPanesFn fires BEFORE round 2 runPlanPhase (AC4)', () => {
		const { opts, calls, teardownCallCount } = makeReplanOpts([BLOCK_REPORT_ROUND1, APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);
		// After the run completes, teardown fired twice: once before round 2, once
		// on the audit-approved terminal.
		expect(teardownCallCount()).toBe(2);
		// Sanity: two full planner+auditor spawn cycles occurred (round1 + round2).
		const respawnCalls = calls.filter((c) => c.args[2] === 'respawn-pane');
		expect(respawnCalls.length).toBe(4); // 2 planner + 2 auditor
	});

	// -------------------------------------------------------------------------
	// Both rounds blocked: exhaustion -> plan-escalated (AC3)
	// -------------------------------------------------------------------------
	test('both rounds audit-blocked: returns a terminal plan-escalated kind (AC3)', () => {
		const { opts } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('plan-escalated');
		expect(result.kind).not.toBe('audit-approved');
		expect(result.kind).not.toBe('audit-blocked');
	});

	test('plan-escalated result carries the last round issue, report, and roundsCompleted (AC3)', () => {
		const { opts } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		const result = runPlanPhaseWithReplan(opts) as {
			kind: 'plan-escalated';
			issue: IssueEntry;
			report: PlanVerdictReport;
			roundsCompleted: number;
		};
		expect(result.issue.id).toBe('CAM-204');
		expect(result.report.summary).toBe('Round 2 plan still has issues');
		expect(result.roundsCompleted).toBe(MAX_REPLAN_ROUNDS);
	});

	test('writeEscalationMarkerFn is called with issue id + last round findings/summary/roundsCompleted (AC3)', () => {
		const { opts, markerCalls } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		runPlanPhaseWithReplan(opts);
		expect(markerCalls.length).toBe(1);
		expect(markerCalls[0]).toEqual({
			issueId: 'CAM-204',
			summary: 'Round 2 plan still has issues',
			findings: BLOCK_REPORT_ROUND2.findings,
			roundsCompleted: MAX_REPLAN_ROUNDS,
		});
	});

	// -------------------------------------------------------------------------
	// US-R1-001 (CAM-204 review fix): 'plan-escalated' event emitted
	// unconditionally on the non-convergence terminal (AC2).
	// -------------------------------------------------------------------------
	test('escalation: logEvent is called exactly once with kind plan-escalated (US-R1-001 AC2)', () => {
		const { opts, loggedEvents } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		runPlanPhaseWithReplan(opts);
		const planEscalatedEvents = loggedEvents.filter((e) => e.kind === 'plan-escalated');
		expect(planEscalatedEvents.length).toBe(1);
	});

	test('escalation: plan-escalated event detail carries issueId + roundsCompleted (US-R1-001 AC2)', () => {
		const { opts, loggedEvents } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		runPlanPhaseWithReplan(opts);
		const event = loggedEvents.find((e) => e.kind === 'plan-escalated');
		expect(event?.detail).toEqual({ issueId: 'CAM-204', roundsCompleted: MAX_REPLAN_ROUNDS });
	});

	test('non-escalation terminal (audit-approved): no plan-escalated event logged', () => {
		const { opts, loggedEvents } = makeReplanOpts([APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);
		expect(loggedEvents.some((e) => e.kind === 'plan-escalated')).toBe(false);
	});

	test('backward compat: escalation works when logEvent is absent (no throw)', () => {
		const { opts } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		const { logEvent: _l, ...rest } = opts;
		const result = runPlanPhaseWithReplan(rest);
		expect(result.kind).toBe('plan-escalated');
	});

	test('escalation: no git/branch spawn occurs (AC3)', () => {
		const { opts, calls } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		runPlanPhaseWithReplan(opts);
		const gitCalls = calls.filter((c) => c.cmd === 'git');
		expect(gitCalls.length).toBe(0);
	});

	test('escalation: teardownPlanPanesFn fires exactly twice (before round 2, on escalated terminal) (AC4)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		runPlanPhaseWithReplan(opts);
		expect(teardownCallCount()).toBe(2);
	});

	test('escalation: exactly MAX_REPLAN_ROUNDS planner+auditor spawn cycles occur (no 3rd round)', () => {
		const { opts, calls } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		runPlanPhaseWithReplan(opts);
		const respawnCalls = calls.filter((c) => c.args[2] === 'respawn-pane');
		expect(respawnCalls.length).toBe(2 * MAX_REPLAN_ROUNDS); // planner+auditor per round
	});

	// -------------------------------------------------------------------------
	// Non-audit results: returned as-is, no re-plan round (AC5)
	// -------------------------------------------------------------------------
	test('preflight-failed is returned as-is, no re-plan round (AC5)', () => {
		const { opts } = makeReplanOpts([APPROVE_REPORT], { preflightFn: () => PREFLIGHT_FAIL });
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('preflight-failed');
	});

	test('no-plannable-issue is returned as-is, no re-plan round (AC5)', () => {
		const { opts } = makeReplanOpts([APPROVE_REPORT], { selectIssueFn: () => null });
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('no-plannable-issue');
	});

	test('mutex-busy is returned as-is, no re-plan round (AC5)', () => {
		const { opts } = makeReplanOpts([APPROVE_REPORT], { paneCountMutexFn: () => 'busy' });
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('mutex-busy');
	});

	test('non-audit result (preflight-failed): teardownPlanPanesFn fires exactly once as a harmless no-op exit-teardown (AC2)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([APPROVE_REPORT], {
			preflightFn: () => PREFLIGHT_FAIL,
		});
		runPlanPhaseWithReplan(opts);
		expect(teardownCallCount()).toBe(1);
	});

	test('non-audit result (no-plannable-issue): teardownPlanPanesFn fires exactly once (AC2)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([APPROVE_REPORT], {
			selectIssueFn: () => null,
		});
		runPlanPhaseWithReplan(opts);
		expect(teardownCallCount()).toBe(1);
	});

	test('non-audit result (mutex-busy): teardownPlanPanesFn fires exactly once (AC2)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([APPROVE_REPORT], {
			paneCountMutexFn: () => 'busy',
		});
		runPlanPhaseWithReplan(opts);
		expect(teardownCallCount()).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Non-audit POST-SPAWN terminals: exit-teardown fires exactly once (AC1, AC4)
	// -------------------------------------------------------------------------
	test('planner-timeout: teardownPlanPanesFn fires exactly once at the single unconditional exit (AC1, AC4)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([APPROVE_REPORT], {
			// Planner pane never dies and never writes prd.json: forces the
			// plannerTimeoutMs deadline to fire inside pollPlannerDeath.
			isPaneAlive: () => true,
			readPlannerReportFn: () => null,
			plannerTimeoutMs: 1,
			clock: (() => {
				let t = 0;
				return () => (t += 1000);
			})(),
		});
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('planner-timeout');
		expect(teardownCallCount()).toBe(1);
	});

	test('auditor-timeout: teardownPlanPanesFn fires exactly once at the single unconditional exit (AC1, AC4)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([APPROVE_REPORT], {
			// readPlannerReportFn short-circuits pollPlannerDeath as "completed"
			// on the first tick, so isPaneAlive is only ever consulted by the
			// auditor poll below; keep it always-alive so the auditor never
			// exits via the pane-death fallback, forcing the timeout branch.
			isPaneAlive: () => true,
			readPlannerReportFn: () => ({}),
			readPlanVerdictFn: () => null,
			auditorTimeoutMs: 1,
			clock: (() => {
				let t = 0;
				return () => (t += 1000);
			})(),
		});
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('auditor-timeout');
		expect(teardownCallCount()).toBe(1);
	});

	test('planner-failed: teardownPlanPanesFn fires exactly once at the single unconditional exit (AC1, AC4)', () => {
		const { opts, teardownCallCount } = makeReplanOpts([APPROVE_REPORT], {
			// Planner pane dies naturally but never wrote prd.json.
			isPaneAlive: () => false,
			readPlannerReportFn: () => null,
		});
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('planner-failed');
		expect(teardownCallCount()).toBe(1);
	});

	test('non-audit result: writeEscalationMarkerFn is NOT called', () => {
		const { opts, markerCalls } = makeReplanOpts([APPROVE_REPORT], {
			preflightFn: () => PREFLIGHT_FAIL,
		});
		runPlanPhaseWithReplan(opts);
		expect(markerCalls.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// writeEscalationMarkerFn not called on non-escalation terminals
	// -------------------------------------------------------------------------
	test('writeEscalationMarkerFn NOT called on audit-approved terminal', () => {
		const { opts, markerCalls } = makeReplanOpts([APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);
		expect(markerCalls.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Backward compat: seams optional
	// -------------------------------------------------------------------------
	test('backward compat: works when teardownPlanPanesFn/writeEscalationMarkerFn are absent', () => {
		const { opts } = makeReplanOpts([APPROVE_REPORT]);
		const { teardownPlanPanesFn: _t, writeEscalationMarkerFn: _w, ...rest } = opts;
		const result = runPlanPhaseWithReplan(rest);
		expect(result.kind).toBe('audit-approved');
	});

	test('backward compat: escalation path works when writeEscalationMarkerFn is absent (no throw)', () => {
		const { opts } = makeReplanOpts([BLOCK_REPORT_ROUND1, BLOCK_REPORT_ROUND2]);
		const { writeEscalationMarkerFn: _w, ...rest } = opts;
		const result = runPlanPhaseWithReplan(rest);
		expect(result.kind).toBe('plan-escalated');
	});
});
