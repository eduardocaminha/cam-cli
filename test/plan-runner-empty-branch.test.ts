// test/plan-runner-empty-branch.test.ts
//
// Unit tests for the empty-branchName guard in runPostAuditAction (US-004, CAM-155).
//
// Acceptance criteria proved:
//   AC1: On the proceed-branch path, when branchName.trim() is empty,
//        runPostAuditAction does NOT invoke `git checkout -b` (nor add/commit),
//        calls notifyFn best-effort, and returns a result that maps to phase 'idle'.
//   AC2: Unit test with a recording spawnFn: audit-approved + proceed-branch +
//        branchName='' (and '   ') asserts spawnFn is NEVER called with
//        ['git','checkout','-b',...], no exception is thrown, and the result maps
//        to idle.
//   AC3: Regression: the sidecar branchName-read fallback (prd.json absent/invalid
//        -> branchName='') flows into runPostAuditAction and escalates cleanly
//        without crashing.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	runPostAuditAction,
	type RunPostAuditOptions,
	type PlanPhaseResult,
} from '../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../src/supervisor/loop.ts';
import type { PlanApproval } from '../src/config/models.ts';
import type { LoopPhase } from '../src/commands/status.ts';
import type { IssueEntry } from '../src/issues/types.ts';
import type { PlanVerdictReport } from '../src/supervisor/plan-verdict-report.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-99',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface GitCall {
	cmd: string;
	args: string[];
}

/**
 * Build options for runPostAuditAction on the proceed-branch path with a
 * configurable branchName (defaults to '' to exercise the empty-branch guard).
 */
function makeEmptyBranchOpts(
	branchName: string,
	extraOverrides: Partial<RunPostAuditOptions> = {},
): {
	opts: RunPostAuditOptions;
	gitCalls: GitCall[];
	setPhaseCalls: LoopPhase[];
	notifyMessages: string[];
	escalateCalled: { n: number };
} {
	const gitCalls: GitCall[] = [];
	const setPhaseCalls: LoopPhase[] = [];
	const notifyMessages: string[] = [];
	const escalateCalled = { n: 0 };

	const spawnFn: SpawnFn = (cmd, args) => {
		gitCalls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPostAuditOptions = {
		planResult: APPROVED_RESULT,
		spawnFn,
		setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
		branchName,
		readPlanApprovalFn: (): PlanApproval => 'auto',
		escalateFn: async () => { escalateCalled.n++; },
		notifyFn: (msg) => { notifyMessages.push(msg); },
		...extraOverrides,
	};

	return { opts, gitCalls, setPhaseCalls, notifyMessages, escalateCalled };
}

// ---------------------------------------------------------------------------
// Tests: empty string branchName (AC1, AC2)
// ---------------------------------------------------------------------------

describe('runPostAuditAction - empty branchName guard (AC1, AC2)', () => {
	// -----------------------------------------------------------------------
	// branchName = ''
	// -----------------------------------------------------------------------

	test("branchName='': result kind is no-action (AC1)", () => {
		const { opts } = makeEmptyBranchOpts('');
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test("branchName='': spawnFn NEVER called with git checkout -b (AC1, AC2)", () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		const checkoutCall = gitCalls.find(
			(c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === '-b',
		);
		expect(checkoutCall).toBeUndefined();
	});

	test("branchName='': no git add call (AC1, AC2)", () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		const addCall = gitCalls.find((c) => c.cmd === 'git' && c.args[0] === 'add');
		expect(addCall).toBeUndefined();
	});

	test("branchName='': no git commit call (AC1, AC2)", () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		const commitCall = gitCalls.find((c) => c.cmd === 'git' && c.args[0] === 'commit');
		expect(commitCall).toBeUndefined();
	});

	test("branchName='': zero git calls total (AC2)", () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
	});

	test("branchName='': no exception thrown (AC2)", () => {
		const { opts } = makeEmptyBranchOpts('');
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test("branchName='': notifyFn called exactly once (AC1)", () => {
		const { opts, notifyMessages } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
	});

	test("branchName='': notifyFn message mentions branchName empty/absent (AC1)", () => {
		const { opts, notifyMessages } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		expect(notifyMessages[0]).toContain('branchName');
	});

	test("branchName='': setPhaseFn NOT called by runPostAuditAction (idle via exitPhaseAfterPlan) (AC1)", () => {
		const { opts, setPhaseCalls } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		expect(setPhaseCalls.length).toBe(0);
	});

	test("branchName='': result maps to idle via exitPhaseAfterPlan logic (AC1)", () => {
		const setPhaseCalls: LoopPhase[] = [];
		const { opts } = makeEmptyBranchOpts('', {
			setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
		});
		const result = runPostAuditAction(opts);

		// Simulate exitPhaseAfterPlan from sidecar.ts:
		//   if (result.kind === 'branch-created') return;
		//   setPhase(result.kind === 'awaiting-operator-approval' ? 'awaiting-operator' : 'idle');
		if (result.kind !== 'branch-created') {
			setPhaseCalls.push(
				result.kind === 'awaiting-operator-approval' ? 'awaiting-operator' : 'idle',
			);
		}
		expect(setPhaseCalls[setPhaseCalls.length - 1]).toBe('idle');
	});

	test("branchName='': escalateFn NOT called (no email noise on missing PRD) (AC1)", async () => {
		const { opts, escalateCalled } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(0);
	});

	// -----------------------------------------------------------------------
	// branchName = '   ' (whitespace-only)
	// -----------------------------------------------------------------------

	test("branchName='   ': result kind is no-action (AC2)", () => {
		const { opts } = makeEmptyBranchOpts('   ');
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test("branchName='   ': spawnFn NEVER called with git checkout -b (AC2)", () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('   ');
		runPostAuditAction(opts);
		const checkoutCall = gitCalls.find(
			(c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === '-b',
		);
		expect(checkoutCall).toBeUndefined();
	});

	test("branchName='   ': zero git calls (AC2)", () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('   ');
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
	});

	test("branchName='   ': no exception thrown (AC2)", () => {
		const { opts } = makeEmptyBranchOpts('   ');
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test("branchName='   ': notifyFn called once (AC2)", () => {
		const { opts, notifyMessages } = makeEmptyBranchOpts('   ');
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
	});

	// -----------------------------------------------------------------------
	// Absent notifyFn is safe (best-effort contract)
	// -----------------------------------------------------------------------

	test("branchName='': absent notifyFn is safe (best-effort contract) (AC1)", () => {
		const { opts } = makeEmptyBranchOpts('', { notifyFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Tests: non-empty branchName is unaffected (regression guard)
// ---------------------------------------------------------------------------

describe('runPostAuditAction - non-empty branchName is unaffected by the guard', () => {
	test('non-empty branchName proceeds normally (still creates branch)', () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('cam/CAM-155-plan-runner-hardening');
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('branch-created');
		const checkoutCall = gitCalls.find(
			(c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === '-b',
		);
		expect(checkoutCall).toBeDefined();
	});

	test('non-empty branchName: three git calls total (checkout, add, commit)', () => {
		const { opts, gitCalls } = makeEmptyBranchOpts('cam/test-branch');
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Tests: sidecar branchName-read fallback regression (AC3)
//
// When prd.json is absent or invalid, the sidecar's branchName extraction path
// (sidecar.ts ~742-748) falls back to branchName=''. This regression test
// proves that runPostAuditAction handles that case cleanly without crashing.
// ---------------------------------------------------------------------------

describe('sidecar branchName fallback regression (AC3)', () => {
	test('branchName="" (sidecar fallback) escalates cleanly, no crash (AC3)', () => {
		// The sidecar produces branchName='' when prd.json is absent or has no
		// branchName field. runPostAuditAction must not throw in that case.
		const { opts } = makeEmptyBranchOpts('');
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('branchName="" (sidecar fallback): no git checkout -b \'\' is ever invoked (AC3)', () => {
		// The specific failure mode: `git checkout -b ''` exits 128 and throws.
		// Verify the guard prevents this from ever reaching spawnFn.
		const { opts, gitCalls } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		const dangerousCheckout = gitCalls.find(
			(c) =>
				c.cmd === 'git' &&
				c.args[0] === 'checkout' &&
				c.args[1] === '-b' &&
				(c.args[2] === '' || c.args[2] === undefined),
		);
		expect(dangerousCheckout).toBeUndefined();
	});

	test('branchName="" (sidecar fallback): result kind is no-action (AC3)', () => {
		const { opts } = makeEmptyBranchOpts('');
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test('branchName="" (sidecar fallback): notifyFn fires (AC3)', () => {
		const { opts, notifyMessages } = makeEmptyBranchOpts('');
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Source-text oracle: guard is present in plan-runner.ts (AC1)
// ---------------------------------------------------------------------------

describe('source-text oracle: empty-branch guard in plan-runner.ts (AC1)', () => {
	const planRunnerPath = resolve(
		import.meta.dir,
		'..',
		'src',
		'supervisor',
		'plan-runner.ts',
	);
	const source = readFileSync(planRunnerPath, 'utf8');

	test('runPostAuditAction contains branchName.trim() === empty-string check', () => {
		// The guard must explicitly use .trim() to catch whitespace-only values.
		expect(source).toContain("branchName.trim() === ''");
	});

	test('guard returns no-action (guard block ends before git calls execute)', () => {
		// The guard block must contain a return { kind: 'no-action' } so execution
		// never reaches the git checkout -b call. Verify the no-action return is
		// co-located with the branchName.trim() check.
		const guardIdx = source.indexOf("branchName.trim() === ''");
		expect(guardIdx).toBeGreaterThanOrEqual(0);

		// Find the closing brace of the guard block: the no-action return should
		// appear within 200 characters of the guard condition.
		const guardRegion = source.slice(guardIdx, guardIdx + 200);
		expect(guardRegion).toContain("{ kind: 'no-action' }");
	});

	test('guard fires notifyFn best-effort', () => {
		// The message text must be in the guard block
		expect(source).toContain('branchName is empty');
	});
});
