// test/supervisor/plan/plan-runner-branch-derivation.test.ts
//
// Unit tests for deterministic branch-name derivation in plan-runner.ts
// (US-001, CAM-236, ADR-0016).
//
// Coverage (matches AC1-AC4):
//   AC1: deriveBranchName(issueNumber) returns 'cam/issue-<N>' for a
//        typeof-number issueNumber, and null for null/undefined/non-number.
//   AC2: executeGitProceedBranch (via runPostAuditAction) spawns
//        ['checkout', '-B', 'cam/issue-<N>'] (capital B).
//   AC3: a missing/null/non-number prd.issueNumber bars the plan: notifyFn
//        names the missing issueNumber, zero git calls, result is no-action.
//        Replaces the old empty-branchName guard (test/plan-runner-empty-branch.test.ts,
//        US-004 CAM-155), which tested a contract (RunPostAuditOptions.branchName)
//        that this story removed.
//   AC4: writePrdBranchNameFn is called with the derived name BEFORE the
//        'git add scripts/cam/prd.json' call.

import { describe, expect, test } from 'bun:test';
import {
	deriveBranchName,
	runPostAuditAction,
	type RunPostAuditOptions,
	type PlanPhaseResult,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { PlanApproval } from '../../../src/config/models.ts';
import type { LoopPhase } from '../../../src/commands/status.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { PlanVerdictReport } from '../../../src/supervisor/plan-verdict-report.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-236',
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

const APPROVED_RESULT: PlanPhaseResult = {
	kind: 'audit-approved',
	issue: MOCK_ISSUE,
	report: APPROVE_REPORT,
};

interface GitCall {
	cmd: string;
	args: string[];
}

/** Build minimal opts for runPostAuditAction on the proceed-branch path. */
function makeOpts(overrides: Partial<RunPostAuditOptions> = {}): {
	opts: RunPostAuditOptions;
	gitCalls: GitCall[];
	setPhaseCalls: LoopPhase[];
	notifyMessages: string[];
	escalateCalled: { n: number };
	writeBranchNameCalls: string[];
} {
	const gitCalls: GitCall[] = [];
	const setPhaseCalls: LoopPhase[] = [];
	const notifyMessages: string[] = [];
	const escalateCalled = { n: 0 };
	const writeBranchNameCalls: string[] = [];

	const spawnFn: SpawnFn = (cmd, args) => {
		gitCalls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPostAuditOptions = {
		planResult: APPROVED_RESULT,
		spawnFn,
		setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
		issueNumber: 236,
		writePrdBranchNameFn: (branchName) => { writeBranchNameCalls.push(branchName); },
		readPlanApprovalFn: (): PlanApproval => 'auto',
		escalateFn: async () => { escalateCalled.n++; },
		notifyFn: (msg) => { notifyMessages.push(msg); },
		...overrides,
	};

	return { opts, gitCalls, setPhaseCalls, notifyMessages, escalateCalled, writeBranchNameCalls };
}

// ---------------------------------------------------------------------------
// AC1: deriveBranchName pure function
// ---------------------------------------------------------------------------

describe('deriveBranchName (AC1)', () => {
	test('returns cam/issue-<N> for a positive integer issueNumber', () => {
		expect(deriveBranchName(236)).toBe('cam/issue-236');
	});

	test('returns cam/issue-<N> for issueNumber 1', () => {
		expect(deriveBranchName(1)).toBe('cam/issue-1');
	});

	test('never includes a slug: output is exactly cam/issue-<N>', () => {
		expect(deriveBranchName(42)).toBe('cam/issue-42');
	});

	test('returns null for issueNumber undefined', () => {
		expect(deriveBranchName(undefined)).toBeNull();
	});

	test('returns null for issueNumber null', () => {
		expect(deriveBranchName(null)).toBeNull();
	});

	test('returns null for issueNumber as a string (not typeof number)', () => {
		expect(deriveBranchName('236')).toBeNull();
	});

	test('returns null for issueNumber as an object', () => {
		expect(deriveBranchName({ n: 236 })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC2: checkout -B (capital B) with the derived name
// ---------------------------------------------------------------------------

describe('executeGitProceedBranch via runPostAuditAction: checkout -B (AC2)', () => {
	test('spawns exactly ["checkout", "-B", "cam/issue-<N>"]', () => {
		const { opts, gitCalls } = makeOpts({ issueNumber: 236 });
		runPostAuditAction(opts);
		const checkoutCall = gitCalls.find((c) => c.cmd === 'git' && c.args[0] === 'checkout');
		expect(checkoutCall).toBeDefined();
		expect(checkoutCall?.args).toEqual(['checkout', '-B', 'cam/issue-236']);
	});

	test('never spawns the old ["checkout", "-b", ...] form', () => {
		const { opts, gitCalls } = makeOpts({ issueNumber: 236 });
		runPostAuditAction(opts);
		const oldForm = gitCalls.find(
			(c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === '-b',
		);
		expect(oldForm).toBeUndefined();
	});

	test('branch-created result carries the derived branchName', () => {
		const { opts } = makeOpts({ issueNumber: 236 });
		const result = runPostAuditAction(opts) as { kind: 'branch-created'; branchName: string };
		expect(result.kind).toBe('branch-created');
		expect(result.branchName).toBe('cam/issue-236');
	});

	test('re-planning the same issueNumber derives the identical branch name (idempotent)', () => {
		const { opts: opts1 } = makeOpts({ issueNumber: 236 });
		const { opts: opts2 } = makeOpts({ issueNumber: 236 });
		const r1 = runPostAuditAction(opts1) as { kind: 'branch-created'; branchName: string };
		const r2 = runPostAuditAction(opts2) as { kind: 'branch-created'; branchName: string };
		expect(r1.branchName).toBe(r2.branchName);
	});
});

// ---------------------------------------------------------------------------
// AC3: missing-issueNumber gate
// ---------------------------------------------------------------------------

describe('missing-issueNumber gate (AC3)', () => {
	test('issueNumber undefined: result kind is no-action', () => {
		const { opts } = makeOpts({ issueNumber: undefined });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test('issueNumber null: result kind is no-action', () => {
		const { opts } = makeOpts({ issueNumber: null });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test('issueNumber as a non-number string: result kind is no-action', () => {
		const { opts } = makeOpts({ issueNumber: 'CAM-236' });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test('issueNumber missing: zero git calls (no checkout, no add, no commit)', () => {
		const { opts, gitCalls } = makeOpts({ issueNumber: undefined });
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
	});

	test('issueNumber missing: no exception thrown', () => {
		const { opts } = makeOpts({ issueNumber: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('issueNumber missing: notifyFn is called exactly once naming issueNumber', () => {
		const { opts, notifyMessages } = makeOpts({ issueNumber: undefined });
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
		expect(notifyMessages[0]).toContain('issueNumber');
	});

	test('issueNumber missing: setPhaseFn NOT called by runPostAuditAction (idle via exitPhaseAfterPlan)', () => {
		const { opts, setPhaseCalls } = makeOpts({ issueNumber: undefined });
		runPostAuditAction(opts);
		expect(setPhaseCalls.length).toBe(0);
	});

	test('issueNumber missing: escalateFn NOT called (no email noise on missing PRD)', async () => {
		const { opts, escalateCalled } = makeOpts({ issueNumber: undefined });
		runPostAuditAction(opts);
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(0);
	});

	test('issueNumber missing: writePrdBranchNameFn NOT called', () => {
		const { opts, writeBranchNameCalls } = makeOpts({ issueNumber: undefined });
		runPostAuditAction(opts);
		expect(writeBranchNameCalls.length).toBe(0);
	});

	test('issueNumber missing: absent notifyFn is safe (best-effort contract)', () => {
		const { opts } = makeOpts({ issueNumber: undefined, notifyFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('valid numeric issueNumber is unaffected by the gate (still creates branch)', () => {
		const { opts, gitCalls } = makeOpts({ issueNumber: 236 });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('branch-created');
		expect(gitCalls.length).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// AC4: writePrdBranchNameFn wiring, before git add
// ---------------------------------------------------------------------------

describe('writePrdBranchNameFn wiring (AC4)', () => {
	test('is called once with the derived branch name', () => {
		const { opts, writeBranchNameCalls } = makeOpts({ issueNumber: 236 });
		runPostAuditAction(opts);
		expect(writeBranchNameCalls).toEqual(['cam/issue-236']);
	});

	test('fires BEFORE the git add call', () => {
		const order: string[] = [];
		const { opts } = makeOpts({
			issueNumber: 236,
			writePrdBranchNameFn: () => { order.push('write-branch-name'); },
			spawnFn: (_cmd, args) => {
				if (args[0] === 'add') order.push('git-add');
				return { stdout: '', exitCode: 0 };
			},
		});
		runPostAuditAction(opts);
		expect(order).toEqual(['write-branch-name', 'git-add']);
	});

	test('fires AFTER the git checkout -B call', () => {
		const order: string[] = [];
		const { opts } = makeOpts({
			issueNumber: 236,
			writePrdBranchNameFn: () => { order.push('write-branch-name'); },
			spawnFn: (_cmd, args) => {
				if (args[0] === 'checkout') order.push('git-checkout');
				return { stdout: '', exitCode: 0 };
			},
		});
		runPostAuditAction(opts);
		expect(order).toEqual(['git-checkout', 'write-branch-name']);
	});

	test('absent writePrdBranchNameFn is safe (backward compat, best-effort)', () => {
		const { opts } = makeOpts({ issueNumber: 236, writePrdBranchNameFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});
});
