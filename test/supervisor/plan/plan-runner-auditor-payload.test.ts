// test/supervisor/plan/plan-runner-auditor-payload.test.ts
//
// Unit tests for the record-bearing auditor spawn payload in
// src/supervisor/plan-runner.ts (US-001, CAM-273, ADR-0027).
//
// Coverage (matches AC1-AC4):
//   AC1: buildAuditorTaskPrompt(issue, branchName) embeds id/title/description/
//        spec.acceptanceCriteria + branchName verbatim.
//   AC2: deriveBranchNameFromIssueId computes cam/issue-<numericSuffix> from
//        issue.id by reusing deriveBranchName; never a planner-authored slug.
//   AC3: runPlanWorkerSequence (via runPlanPhase) spawns the auditor with the
//        record-bearing prompt built from the selected IssueEntry, and
//        runPlanPhaseWithReplan's re-plan rounds inherit the same behavior.
//   AC4: regression test reproducing the CAM-156 scenario (a local IssueEntry
//        id 'CAM-156' selected while a coincident GitHub PR #156 exists):
//        the auditor spawn payload carries the fully-resolved record and no
//        `gh` invocation occurs.

import { describe, expect, test } from 'bun:test';
import {
	runPlanPhase,
	runPlanPhaseWithReplan,
	buildAuditorTaskPrompt,
	deriveBranchNameFromIssueId,
	deriveBranchName,
	type RunPlanPhaseOptions,
	type RunPlanPhaseWithReplanOptions,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../../../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { PlanPreflightResult } from '../../../src/supervisor/plan-preflight.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * Reproduces the CAM-156 scenario (ADR-0027): a local IssueEntry id
 * 'CAM-156', fully specified, selected by the deterministic runner while a
 * coincident GitHub PR #156 happens to exist (the auditor must never need to
 * resolve that coincidence itself).
 */
const CAM_156_ISSUE: IssueEntry = {
	id: 'CAM-156',
	title: 'Fix push-verification false-BLOCK on stale expected-ref',
	description: 'Push verification used the prior story HEAD instead of the just-landed US-005 push.',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
	spec: {
		acceptanceCriteria: [
			'Push verification reads the CURRENT HEAD ref, not a stale cached one.',
			'A regression test reproduces the stale-ref false-BLOCK.',
		],
		scope: 'push-verification',
		gotchas: [],
		domainTerms: [],
	},
};

const APPROVE_REPORT: PlanVerdictReport = {
	verdict: 'APPROVE',
	summary: 'Plan looks good',
	findings: [],
};

const BLOCK_REPORT: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Plan has issues',
	findings: [
		{
			id: 'A.001',
			category: 'A.completeness',
			severity: 'critical',
			description: 'Missing acceptance criteria',
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

function makeOpts(
	issue: IssueEntry,
	overrides: Partial<RunPlanPhaseOptions> = {},
): { opts: RunPlanPhaseOptions; calls: TmuxCall[] } {
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
		selectIssueFn: () => issue,
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

function findAuditorShell(calls: TmuxCall[]): string {
	const auditorRespawn = calls.find(
		(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-auditor')),
	);
	return auditorRespawn?.args[auditorRespawn.args.length - 1] ?? '';
}

// ---------------------------------------------------------------------------
// AC1: buildAuditorTaskPrompt pure builder
// ---------------------------------------------------------------------------

describe('buildAuditorTaskPrompt (AC1)', () => {
	test('embeds the issue id verbatim', () => {
		const prompt = buildAuditorTaskPrompt(CAM_156_ISSUE, 'cam/issue-156');
		expect(prompt).toContain('CAM-156');
	});

	test('embeds the issue title verbatim', () => {
		const prompt = buildAuditorTaskPrompt(CAM_156_ISSUE, 'cam/issue-156');
		expect(prompt).toContain('Fix push-verification false-BLOCK on stale expected-ref');
	});

	test('embeds the issue description verbatim', () => {
		const prompt = buildAuditorTaskPrompt(CAM_156_ISSUE, 'cam/issue-156');
		expect(prompt).toContain('Push verification used the prior story HEAD instead of the just-landed US-005 push.');
	});

	test('embeds every spec.acceptanceCriteria entry verbatim', () => {
		const prompt = buildAuditorTaskPrompt(CAM_156_ISSUE, 'cam/issue-156');
		expect(prompt).toContain('Push verification reads the CURRENT HEAD ref, not a stale cached one.');
		expect(prompt).toContain('A regression test reproduces the stale-ref false-BLOCK.');
	});

	test('embeds the derived branchName verbatim', () => {
		const prompt = buildAuditorTaskPrompt(CAM_156_ISSUE, 'cam/issue-156');
		expect(prompt).toContain('cam/issue-156');
	});

	test('renders (none provided) for a description-less issue, not the literal string "undefined"', () => {
		const { description: _d, ...rest } = CAM_156_ISSUE;
		const prompt = buildAuditorTaskPrompt(rest, 'cam/issue-156');
		expect(prompt).toContain('(none provided)');
		expect(prompt).not.toContain('undefined');
	});

	test('renders (none provided) for a spec-less issue (no acceptanceCriteria)', () => {
		const { spec: _s, ...rest } = CAM_156_ISSUE;
		const prompt = buildAuditorTaskPrompt(rest, 'cam/issue-156');
		expect(prompt).toContain('(none provided)');
	});

	test('instructs the auditor NOT to re-resolve issue/PR identity against any backend', () => {
		const prompt = buildAuditorTaskPrompt(CAM_156_ISSUE, 'cam/issue-156');
		expect(prompt.toLowerCase()).toContain('do not re-resolve issue/pr identity');
	});
});

// ---------------------------------------------------------------------------
// AC2: deriveBranchNameFromIssueId
// ---------------------------------------------------------------------------

describe('deriveBranchNameFromIssueId (AC2)', () => {
	test('computes cam/issue-<numericSuffix> from a CAM-NNN id', () => {
		expect(deriveBranchNameFromIssueId('CAM-156')).toBe('cam/issue-156');
	});

	test('matches deriveBranchName(numericSuffix) exactly (reuse, not reimplementation)', () => {
		expect(deriveBranchNameFromIssueId('CAM-273')).toBe(deriveBranchName(273));
	});

	test('never includes a slug: output is exactly cam/issue-<N>', () => {
		expect(deriveBranchNameFromIssueId('CAM-42')).toBe('cam/issue-42');
	});

	test('returns null for an id with no numeric suffix', () => {
		expect(deriveBranchNameFromIssueId('CAM-abc')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC3: runPlanWorkerSequence spawns the auditor with the record-bearing prompt
// ---------------------------------------------------------------------------

describe('runPlanPhase auditor spawn payload (AC3)', () => {
	test('auditor spawn payload embeds the selected issue id', () => {
		const { opts, calls } = makeOpts(CAM_156_ISSUE);
		runPlanPhase(opts);
		expect(findAuditorShell(calls)).toContain('CAM-156');
	});

	test('auditor spawn payload embeds the selected issue title', () => {
		const { opts, calls } = makeOpts(CAM_156_ISSUE);
		runPlanPhase(opts);
		expect(findAuditorShell(calls)).toContain('Fix push-verification false-BLOCK on stale expected-ref');
	});

	test('auditor spawn payload embeds the derived branch name, not a planner slug', () => {
		const { opts, calls } = makeOpts(CAM_156_ISSUE);
		runPlanPhase(opts);
		expect(findAuditorShell(calls)).toContain('cam/issue-156');
	});

	test('opts.auditorTaskPrompt override still wins (backward compat)', () => {
		const { opts, calls } = makeOpts(CAM_156_ISSUE, {
			auditorTaskPrompt: 'Custom override prompt',
		});
		runPlanPhase(opts);
		expect(findAuditorShell(calls)).toContain('Custom override prompt');
	});

	test('re-plan rounds inherit the same record-bearing auditor prompt (AC3)', () => {
		let round = 0;
		const opts: RunPlanPhaseWithReplanOptions = {
			...makeOpts(CAM_156_ISSUE).opts,
			readPlanVerdictFn: () => (round === 0 ? BLOCK_REPORT : APPROVE_REPORT),
			teardownPlanPanesFn: () => {
				round++;
			},
		};
		const calls: TmuxCall[] = [];
		const spawnFn: SpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};
		let plannerAliveCount = 1;
		const result = runPlanPhaseWithReplan({
			...opts,
			spawnFn,
			isPaneAlive: () => {
				if (plannerAliveCount > 0) {
					plannerAliveCount--;
					return true;
				}
				return false;
			},
		});
		expect(result.kind).toBe('audit-approved');

		const auditorRespawns = calls.filter(
			(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-auditor')),
		);
		expect(auditorRespawns.length).toBe(2); // 2 rounds -> 2 auditor spawns
		for (const respawn of auditorRespawns) {
			const shell = respawn.args[respawn.args.length - 1] ?? '';
			expect(shell).toContain('CAM-156');
			expect(shell).toContain('cam/issue-156');
		}
	});
});

// ---------------------------------------------------------------------------
// AC4: CAM-156 regression scenario (coincident GitHub PR #156)
// ---------------------------------------------------------------------------

describe('CAM-156 regression: coincident GitHub PR #156 never triggers bare-number resolution (AC4)', () => {
	test('auditor spawn payload carries the fully-resolved CAM-156 record', () => {
		const { opts, calls } = makeOpts(CAM_156_ISSUE);
		runPlanPhase(opts);
		const shell = findAuditorShell(calls);
		expect(shell).toContain('CAM-156');
		expect(shell).toContain('Fix push-verification false-BLOCK on stale expected-ref');
		expect(shell).toContain('Push verification used the prior story HEAD instead of the just-landed US-005 push.');
		expect(shell).toContain('cam/issue-156');
	});

	test('runPlanPhase issues no gh invocation for issue/PR identity', () => {
		const { opts, calls } = makeOpts(CAM_156_ISSUE);
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
		const ghCalls = calls.filter((c) => c.cmd === 'gh');
		expect(ghCalls.length).toBe(0);
	});

	test('the derived branch is cam/issue-156, never a planner-authored slug', () => {
		const { opts, calls } = makeOpts(CAM_156_ISSUE);
		runPlanPhase(opts);
		const shell = findAuditorShell(calls);
		expect(shell).not.toMatch(/cam\/issue-156-[a-z]/); // no slug suffix appended
	});
});
