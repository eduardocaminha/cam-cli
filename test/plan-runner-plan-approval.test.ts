// test/plan-runner-plan-approval.test.ts
//
// Unit tests for the writePlanApprovalGateFn seam on runPostAuditAction /
// handleAuditApproved in src/supervisor/plan-runner.ts (US-002, CAM-241/153/312).
//
// Coverage (matches AC1-AC3):
//   1. pause-operator (plan_approval='operator'): writePlanApprovalGateFn is
//      called exactly once (AC2).
//   2. pause-operator: writePlanApprovalGateFn is called BEFORE the function
//      returns { kind: 'awaiting-operator-approval' } (AC2).
//   3. pause-operator: absent writePlanApprovalGateFn is safe (backward
//      compat, never throws).
//   4. proceed-branch (plan_approval='auto'): writePlanApprovalGateFn is NEVER
//      called (AC3).
//   5. proceed-branch: branch created, prd.json committed, phase flipped to
//      'implementing' -- unchanged from the pre-existing behavior (AC3).

import { describe, expect, test } from 'bun:test';
import {
	runPostAuditAction,
	type RunPostAuditOptions,
	type PlanPhaseResult,
} from '../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../src/issues/types.ts';
import type { PlanApproval } from '../src/config/models.ts';
import type { LoopPhase } from '../src/commands/status.ts';

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-312',
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

const APPROVED_RESULT: PlanPhaseResult = {
	kind: 'audit-approved',
	issue: MOCK_ISSUE,
	report: APPROVE_REPORT,
};

const ISSUE_NUMBER = 312;
const BRANCH_NAME = 'cam/issue-312';

interface GitCall {
	cmd: string;
	args: string[];
}

function makeOpts(overrides: Partial<RunPostAuditOptions> = {}): {
	opts: RunPostAuditOptions;
	gitCalls: GitCall[];
	setPhaseCalls: LoopPhase[];
	writeGateCalled: { n: number };
} {
	const gitCalls: GitCall[] = [];
	const setPhaseCalls: LoopPhase[] = [];
	const writeGateCalled = { n: 0 };

	const spawnFn: SpawnFn = (cmd, args) => {
		gitCalls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPostAuditOptions = {
		planResult: APPROVED_RESULT,
		spawnFn,
		setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
		issueNumber: ISSUE_NUMBER,
		readPlanApprovalFn: (): PlanApproval => 'auto',
		writePlanApprovalGateFn: () => { writeGateCalled.n++; },
		...overrides,
	};

	return { opts, gitCalls, setPhaseCalls, writeGateCalled };
}

describe('runPostAuditAction - writePlanApprovalGateFn seam (US-002, CAM-241/153/312)', () => {
	// -------------------------------------------------------------------------
	// pause-operator path (AC2)
	// -------------------------------------------------------------------------

	test('pause-operator: writePlanApprovalGateFn is called exactly once (AC2)', () => {
		const { opts, writeGateCalled } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		runPostAuditAction(opts);
		expect(writeGateCalled.n).toBe(1);
	});

	test('pause-operator: writePlanApprovalGateFn fires before the awaiting-operator-approval result is returned (AC2)', () => {
		const order: string[] = [];
		const { opts } = makeOpts({
			readPlanApprovalFn: () => 'operator',
			writePlanApprovalGateFn: () => { order.push('write-gate'); },
		});
		const result = runPostAuditAction(opts);
		order.push(`result:${result.kind}`);
		expect(order).toEqual(['write-gate', 'result:awaiting-operator-approval']);
	});

	test('pause-operator: returns awaiting-operator-approval kind (AC2)', () => {
		const { opts } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('awaiting-operator-approval');
	});

	test('pause-operator: absent writePlanApprovalGateFn is safe (backward compat, never throws)', () => {
		const { opts } = makeOpts({
			readPlanApprovalFn: () => 'operator',
			writePlanApprovalGateFn: undefined,
		});
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('pause-operator: no git calls made regardless of the gate seam (AC2)', () => {
		const { opts, gitCalls } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// proceed-branch path (AC3): auto-mode behavior is unchanged, and the gate
	// seam is never called.
	// -------------------------------------------------------------------------

	test('proceed-branch: writePlanApprovalGateFn is NEVER called (AC3)', () => {
		const { opts, writeGateCalled } = makeOpts();
		runPostAuditAction(opts);
		expect(writeGateCalled.n).toBe(0);
	});

	test('proceed-branch: returns branch-created kind with the derived branchName (AC3)', () => {
		const { opts } = makeOpts();
		const result = runPostAuditAction(opts) as { kind: 'branch-created'; branchName: string };
		expect(result.kind).toBe('branch-created');
		expect(result.branchName).toBe(BRANCH_NAME);
	});

	test('proceed-branch: git checkout -B, git add scripts/cam/prd.json, git commit fire in order (AC3)', () => {
		const { opts, gitCalls } = makeOpts();
		runPostAuditAction(opts);

		expect(gitCalls.length).toBe(3);
		expect(gitCalls[0]).toEqual({ cmd: 'git', args: ['checkout', '-B', BRANCH_NAME] });
		expect(gitCalls[1]).toEqual({ cmd: 'git', args: ['add', 'scripts/cam/prd.json'] });
		expect(gitCalls[2]?.cmd).toBe('git');
		expect(gitCalls[2]?.args[0]).toBe('commit');
	});

	test('proceed-branch: setPhaseFn is called exactly once with "implementing" (AC3)', () => {
		const { opts, setPhaseCalls } = makeOpts();
		runPostAuditAction(opts);
		expect(setPhaseCalls).toEqual(['implementing']);
	});

	test('proceed-branch: writePlanApprovalGateFn absent is safe (backward compat)', () => {
		const { opts } = makeOpts({ writePlanApprovalGateFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});
});
