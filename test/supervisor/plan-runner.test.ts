// test/supervisor/plan-runner.test.ts
//
// Unit tests for wiring the deterministic oracle linter into the plan-runner
// audit path (US-002, CAM-310 PRD).
//
// Coverage (matches AC1-AC5):
//   AC1: runPlanWorkerSequence gains a content-reading seam (readPrdContentFn)
//        distinct from readPlannerReportFn; exercised throughout this suite.
//   AC2: the linter runs AFTER the presence guard, BEFORE the auditor spawns;
//        a broken oracle means the auditor pane is NEVER spawned for that round.
//   AC3: a lint finding is folded into a synthetic audit-blocked result whose
//        report is a well-formed BLOCK PlanVerdictReport (storyId + offending
//        command + rule name + why-broken per finding), feeding the SAME
//        re-plan loop as an auditor BLOCK (buildReplanPlannerTaskPrompt).
//   AC4: exhausting re-plan rounds on a persistently-broken oracle writes the
//        same escalation marker the auditor-BLOCK exhaustion path writes.
//   AC5: end-to-end ordering (broken PRD -> re-plan without spending the
//        auditor; clean PRD -> auditor unchanged, zero behavior change).

import { describe, expect, test } from 'bun:test';
import {
	runPlanPhase,
	runPlanPhaseWithReplan,
	buildLintBlockReport,
	MAX_REPLAN_ROUNDS,
	type RunPlanPhaseOptions,
	type RunPlanPhaseWithReplanOptions,
	type PlanEscalationWriterParams,
} from '../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import type { PlanPreflightResult } from '../../src/supervisor/plan-preflight.ts';
import type { PrdShape } from '../../src/commands/status.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-310',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-16T00:00:00Z',
	updatedAt: '2026-07-16T00:00:00Z',
};

const APPROVE_REPORT: PlanVerdictReport = {
	verdict: 'APPROVE',
	summary: 'Plan looks good',
	findings: [],
};

const BLOCK_REPORT: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Auditor found a real defect',
	findings: [
		{
			id: 'A.001',
			category: 'A.completeness',
			severity: 'critical',
			description: 'Missing acceptance criteria',
		},
	],
};

const BROKEN_ORACLE_COMMAND = "grep -qL 'X' path/to/file.ts";

/** A PRD whose only story carries the self-nullifying grep -q + -L idiom. */
const BROKEN_PRD: PrdShape = {
	userStories: [
		{
			id: 'US-001',
			title: 'Story with a broken oracle',
			passes: false,
			acceptanceCriteria: [`Some criterion. [oracle: ${BROKEN_ORACLE_COMMAND}]`],
		},
	],
};

/** A PRD whose oracle is well-formed (no rule trips). */
const CLEAN_PRD: PrdShape = {
	userStories: [
		{
			id: 'US-001',
			title: 'Story with a clean oracle',
			passes: false,
			acceptanceCriteria: ["Some criterion. [oracle: grep -q 'X' path/to/file.ts]"],
		},
	],
};

const PREFLIGHT_OK: PlanPreflightResult = { ok: true };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

function auditorRespawnCalls(calls: TmuxCall[]): TmuxCall[] {
	return calls.filter(
		(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-auditor')),
	);
}

function plannerRespawnCalls(calls: TmuxCall[]): TmuxCall[] {
	return calls.filter(
		(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-planner')),
	);
}

/**
 * Builds opts for a single runPlanPhase call. Planner dies after 1 poll tick;
 * auditor (when spawned) reports APPROVE by default. readPrdContentFn is
 * absent by default (backward compat: lint skipped unless overridden).
 */
function makeOpts(overrides: Partial<RunPlanPhaseOptions> = {}): {
	opts: RunPlanPhaseOptions;
	calls: TmuxCall[];
} {
	const calls: TmuxCall[] = [];
	let plannerAliveCount = 1;

	const spawnFn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPlanPhaseOptions = {
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
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => APPROVE_REPORT,
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
		...overrides,
	};

	return { opts, calls };
}

/**
 * Builds opts for runPlanPhaseWithReplan across multiple rounds. Round N's
 * prd.json content and auditor verdict are read from `prdContents[N]` /
 * `verdicts[N]` (index pinned by teardownPlanPanesFn, which advances the
 * round index — mirrors test/supervisor/plan/plan-runner-replan.test.ts).
 */
function makeReplanOpts(
	prdContents: (PrdShape | null)[],
	verdicts: PlanVerdictReport[],
	overrides: Partial<RunPlanPhaseWithReplanOptions> = {},
): {
	opts: RunPlanPhaseWithReplanOptions;
	calls: TmuxCall[];
	teardownCallCount: () => number;
	markerCalls: PlanEscalationWriterParams[];
} {
	const calls: TmuxCall[] = [];
	let teardownCount = 0;
	const markerCalls: PlanEscalationWriterParams[] = [];
	let roundIndex = 0;
	let plannerAliveCount = 1;

	const spawnFn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

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
		selectIssueFn: () => MOCK_ISSUE,
		readPrdContentFn: () => prdContents[roundIndex] ?? prdContents[prdContents.length - 1] ?? null,
		readPlanVerdictFn: () => verdicts[roundIndex] ?? verdicts[verdicts.length - 1] ?? APPROVE_REPORT,
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
			plannerAliveCount = 1;
			roundIndex++;
		},
		writeEscalationMarkerFn: (params) => {
			markerCalls.push(params);
		},
		...overrides,
	};

	return {
		opts,
		calls,
		teardownCallCount: () => teardownCount,
		markerCalls,
	};
}

// ---------------------------------------------------------------------------
// buildLintBlockReport (pure helper)
// ---------------------------------------------------------------------------

describe('buildLintBlockReport', () => {
	test('builds a BLOCK PlanVerdictReport with one finding per lint finding', () => {
		const report = buildLintBlockReport([
			{ storyId: 'US-002', command: BROKEN_ORACLE_COMMAND, ruleName: 'grep-q-plus-list-files', reason: 'why broken' },
		]);
		expect(report.verdict).toBe('BLOCK');
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]).toMatchObject({
			storyId: 'US-002',
			category: 'grep-q-plus-list-files',
			severity: 'critical',
		});
		expect(report.findings[0]!.description).toContain(BROKEN_ORACLE_COMMAND);
		expect(report.findings[0]!.description).toContain('why broken');
	});

	test('summary reports the finding count', () => {
		const report = buildLintBlockReport([
			{ storyId: 'A', command: 'c1', ruleName: 'r', reason: 'why' },
			{ storyId: 'B', command: 'c2', ruleName: 'r', reason: 'why' },
		]);
		expect(report.summary).toContain('2');
	});
});

// ---------------------------------------------------------------------------
// runPlanPhase: lint wiring (AC2, AC3, AC5)
// ---------------------------------------------------------------------------

describe('runPlanPhase: oracle lint wiring (AC2, AC3, AC5)', () => {
	test('AC2: a broken oracle blocks BEFORE the auditor is ever spawned', () => {
		const { opts, calls } = makeOpts({ readPrdContentFn: () => BROKEN_PRD });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-blocked');
		expect(auditorRespawnCalls(calls)).toHaveLength(0);
		expect(plannerRespawnCalls(calls)).toHaveLength(1);
	});

	test('AC3: the synthetic audit-blocked report carries story id + offending command + rule name + reason', () => {
		const { opts } = makeOpts({ readPrdContentFn: () => BROKEN_PRD });
		const result = runPlanPhase(opts) as { kind: 'audit-blocked'; issue: IssueEntry; report: PlanVerdictReport };
		expect(result.issue.id).toBe('CAM-310');
		expect(result.report.verdict).toBe('BLOCK');
		expect(typeof result.report.summary).toBe('string');
		expect(result.report.findings).toHaveLength(1);
		const finding = result.report.findings[0]!;
		expect(finding.storyId).toBe('US-001');
		expect(finding.category).toBe('grep-q-plus-list-files');
		expect(finding.description).toContain(BROKEN_ORACLE_COMMAND);
	});

	test('AC5: a clean prd.json proceeds to the auditor unchanged (zero behavior change)', () => {
		const { opts, calls } = makeOpts({ readPrdContentFn: () => CLEAN_PRD });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
	});

	test('backward compat: readPrdContentFn absent skips the lint entirely', () => {
		const { opts, calls } = makeOpts();
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
	});

	test('readPrdContentFn returning null (unreadable prd.json) does not block', () => {
		const { opts, calls } = makeOpts({ readPrdContentFn: () => null });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// runPlanPhaseWithReplan: fold into the re-plan loop (AC3, AC4, AC5)
// ---------------------------------------------------------------------------

describe('runPlanPhaseWithReplan: lint findings fold into the re-plan loop (AC3, AC4, AC5)', () => {
	test('AC5: round-1 broken oracle re-plans without spending the auditor; round-2 clean prd.json spawns the auditor once', () => {
		const { opts, calls } = makeReplanOpts([BROKEN_PRD, CLEAN_PRD], [APPROVE_REPORT, APPROVE_REPORT]);
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('audit-approved');
		// Exactly one auditor spawn total: round 1's lint-block never spawns it,
		// round 2 (clean) spawns it exactly once.
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
		expect(plannerRespawnCalls(calls)).toHaveLength(2);
	});

	test('AC3: round-2 planner spawn prompt embeds the lint finding as re-plan feedback, pinned to the same issue', () => {
		const { opts, calls } = makeReplanOpts([BROKEN_PRD, CLEAN_PRD], [APPROVE_REPORT, APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);
		const plannerCalls = plannerRespawnCalls(calls);
		expect(plannerCalls).toHaveLength(2);
		const round2Shell = plannerCalls[1]?.args[plannerCalls[1].args.length - 1] ?? '';
		expect(round2Shell).toContain('CAM-310');
		expect(round2Shell).toContain('Do not re-select from the backlog');
		expect(round2Shell).toContain('grep-q-plus-list-files');
		expect(round2Shell).toContain('grep -qL');
		expect(round2Shell).toContain('path/to/file.ts');
	});

	test('AC4: exhausting re-plan rounds on a persistently-broken oracle escalates via writeEscalationMarkerFn, auditor never spawned', () => {
		const { opts, calls, markerCalls } = makeReplanOpts([BROKEN_PRD, BROKEN_PRD], [APPROVE_REPORT, APPROVE_REPORT]);
		const result = runPlanPhaseWithReplan(opts) as { kind: 'plan-escalated'; roundsCompleted: number };
		expect(result.kind).toBe('plan-escalated');
		expect(result.roundsCompleted).toBe(MAX_REPLAN_ROUNDS);
		expect(markerCalls).toHaveLength(1);
		expect(markerCalls[0]?.issueId).toBe('CAM-310');
		expect(markerCalls[0]?.roundsCompleted).toBe(MAX_REPLAN_ROUNDS);
		// The auditor is NEVER spawned across BOTH rounds: the lint blocks every round.
		expect(auditorRespawnCalls(calls)).toHaveLength(0);
		// Never proceeds to branch creation.
		expect(calls.filter((c) => c.cmd === 'git')).toHaveLength(0);
	});

	test('mixed: round-1 lint-block then round-2 real auditor BLOCK both fold into the SAME escalation path', () => {
		const { opts, markerCalls } = makeReplanOpts([BROKEN_PRD, CLEAN_PRD], [APPROVE_REPORT, BLOCK_REPORT]);
		const result = runPlanPhaseWithReplan(opts) as { kind: 'plan-escalated'; roundsCompleted: number };
		expect(result.kind).toBe('plan-escalated');
		expect(result.roundsCompleted).toBe(2);
		expect(markerCalls[0]?.summary).toBe(BLOCK_REPORT.summary);
	});
});
