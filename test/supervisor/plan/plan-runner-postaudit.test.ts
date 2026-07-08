// test/supervisor/plan/plan-runner-postaudit.test.ts
//
// Unit tests for runPostAuditAction in src/supervisor/plan-runner.ts (US-003, CAM-151).
//
// Coverage (matches AC1-AC5):
//   1.  proceed-branch: branch-create git call precedes prd-commit git call (AC1).
//   2.  proceed-branch: setPhaseFn called exactly once with 'implementing' (AC1, AC5).
//   3.  proceed-branch: returns { kind: 'branch-created', branchName } (AC1).
//   4.  proceed-branch: git checkout -b uses the supplied branchName (AC1).
//   5.  proceed-branch: git add targets scripts/cam/prd.json (AC1).
//   6.  proceed-branch: git commit fires after git add (AC1).
//   7.  pause-operator: returns { kind: 'awaiting-operator-approval' } (AC4).
//   8.  pause-operator: no branch/commit/setPhase calls (AC4).
//   9.  audit-blocked: returns { kind: 'escalated' } (AC3).
//  10.  audit-blocked: escalateFn called (AC3).
//  11.  audit-blocked: notifyFn called with [cam] plan BLOCK prefix (AC3).
//  12.  audit-blocked: no branch/commit/setPhase calls (AC3).
//  13.  audit-blocked: setPhaseFn called zero times (AC5).
//  14.  non-approved planResult: returns { kind: 'no-action' }.
//  15.  non-approved planResult: no branch/commit/setPhase/escalate calls.
//  16.  proceed-branch: git checkout -b fails -> throws (spawnSync exit-status guard).
//  17.  proceed-branch: git add fails -> throws.
//  18.  proceed-branch: git commit fails -> throws.
// Production wiring oracle (US-R1-001):
//  19.  sidecar.ts imports runPostAuditAction from plan-runner.ts.
//  20.  sidecar.ts calls runPostAuditAction inside makeProductionPlanPhaseFn.
//  21.  sidecar.ts wires setPhaseFn, branchName, readPlanApprovalFn in the call.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	runPostAuditAction,
	type RunPostAuditOptions,
	type PostAuditActionResult,
	type PlanPhaseResult,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../../../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { PlanApproval } from '../../../src/config/models.ts';
import type { LoopPhase } from '../../../src/commands/status.ts';
import { makeInMemoryEventLogger } from '../../../src/supervisor/events.ts';
import type { PlanPreflightFailedWriterParams } from '../../../src/supervisor/plan-preflight-marker.ts';

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

const BLOCK_REPORT: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Plan has critical issues',
	findings: [
		{
			id: 'A.001',
			category: 'A.completeness',
			severity: 'critical',
			description: 'Missing acceptance criteria',
		},
	],
};

const APPROVED_RESULT: PlanPhaseResult = {
	kind: 'audit-approved',
	issue: MOCK_ISSUE,
	report: APPROVE_REPORT,
};

const BLOCKED_RESULT: PlanPhaseResult = {
	kind: 'audit-blocked',
	issue: MOCK_ISSUE,
	report: BLOCK_REPORT,
};

const ESCALATED_REPORT: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Plan did not converge after all re-plan rounds',
	findings: [
		{
			id: 'A.002',
			category: 'A.completeness',
			severity: 'critical',
			description: 'Still missing acceptance criteria after re-plan',
		},
	],
};

const ESCALATED_RESULT: PlanPhaseResult = {
	kind: 'plan-escalated',
	issue: MOCK_ISSUE,
	report: ESCALATED_REPORT,
	roundsCompleted: 2,
};

const PREFLIGHT_FAILED_RESULT: PlanPhaseResult = {
	kind: 'preflight-failed',
	step: 'typecheck',
	detail: 'error TS2345',
};

const TARGET_INVALID_RESULT: PlanPhaseResult = {
	kind: 'plan-target-invalid',
	targetId: 'CAM-777',
};

const BRANCH_NAME = 'cam/CAM-117-plan-runner';

// ---------------------------------------------------------------------------
// Helper: recorded git call
// ---------------------------------------------------------------------------

interface GitCall {
	cmd: string;
	args: string[];
}

/**
 * Build a minimal set of options for runPostAuditAction.
 *
 * Defaults: proceed-branch path (auto mode, audit-approved, git calls succeed).
 */
function makeOpts(overrides: Partial<RunPostAuditOptions> = {}): {
	opts: RunPostAuditOptions;
	gitCalls: GitCall[];
	setPhaseCalls: LoopPhase[];
	escalateCalled: { n: number };
	notifyMessages: string[];
	removeMarkerCalled: { n: number };
	preflightMarkerCalls: PlanPreflightFailedWriterParams[];
	removePreflightMarkerCalled: { n: number };
} {
	const gitCalls: GitCall[] = [];
	const setPhaseCalls: LoopPhase[] = [];
	const escalateCalled = { n: 0 };
	const notifyMessages: string[] = [];
	const removeMarkerCalled = { n: 0 };
	const preflightMarkerCalls: PlanPreflightFailedWriterParams[] = [];
	const removePreflightMarkerCalled = { n: 0 };

	const spawnFn: SpawnFn = (cmd, args) => {
		gitCalls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPostAuditOptions = {
		planResult: APPROVED_RESULT,
		spawnFn,
		setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
		branchName: BRANCH_NAME,
		readPlanApprovalFn: (): PlanApproval => 'auto',
		escalateFn: async () => { escalateCalled.n++; },
		notifyFn: (msg) => { notifyMessages.push(msg); },
		removeEscalationMarkerFn: () => { removeMarkerCalled.n++; },
		writePreflightFailedMarkerFn: (params) => { preflightMarkerCalls.push(params); },
		removePreflightFailedMarkerFn: () => { removePreflightMarkerCalled.n++; },
		...overrides,
	};

	return {
		opts,
		gitCalls,
		setPhaseCalls,
		escalateCalled,
		notifyMessages,
		removeMarkerCalled,
		preflightMarkerCalls,
		removePreflightMarkerCalled,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPostAuditAction', () => {
	// -------------------------------------------------------------------------
	// proceed-branch path (auto mode, audit-approved) - AC1
	// -------------------------------------------------------------------------

	test('proceed-branch: returns branch-created kind (AC1)', () => {
		const { opts } = makeOpts();
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('branch-created');
	});

	test('proceed-branch: result includes the branchName (AC1)', () => {
		const { opts } = makeOpts();
		const result = runPostAuditAction(opts) as { kind: 'branch-created'; branchName: string };
		expect(result.branchName).toBe(BRANCH_NAME);
	});

	test('proceed-branch: git checkout -b precedes git commit (AC1)', () => {
		const { opts, gitCalls } = makeOpts();
		runPostAuditAction(opts);

		const checkoutIdx = gitCalls.findIndex(
			(c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === '-b',
		);
		const commitIdx = gitCalls.findIndex(
			(c) => c.cmd === 'git' && c.args[0] === 'commit',
		);

		expect(checkoutIdx).toBeGreaterThanOrEqual(0);
		expect(commitIdx).toBeGreaterThanOrEqual(0);
		expect(checkoutIdx).toBeLessThan(commitIdx);
	});

	test('proceed-branch: git checkout -b uses the supplied branchName (AC1)', () => {
		const { opts, gitCalls } = makeOpts();
		runPostAuditAction(opts);

		const checkoutCall = gitCalls.find(
			(c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === '-b',
		);
		expect(checkoutCall).toBeDefined();
		expect(checkoutCall?.args[2]).toBe(BRANCH_NAME);
	});

	test('proceed-branch: git add targets scripts/cam/prd.json (AC1)', () => {
		const { opts, gitCalls } = makeOpts();
		runPostAuditAction(opts);

		const addCall = gitCalls.find(
			(c) => c.cmd === 'git' && c.args[0] === 'add',
		);
		expect(addCall).toBeDefined();
		expect(addCall?.args[1]).toBe('scripts/cam/prd.json');
	});

	test('proceed-branch: git add precedes git commit (AC1)', () => {
		const { opts, gitCalls } = makeOpts();
		runPostAuditAction(opts);

		const addIdx = gitCalls.findIndex(
			(c) => c.cmd === 'git' && c.args[0] === 'add',
		);
		const commitIdx = gitCalls.findIndex(
			(c) => c.cmd === 'git' && c.args[0] === 'commit',
		);

		expect(addIdx).toBeGreaterThanOrEqual(0);
		expect(commitIdx).toBeGreaterThanOrEqual(0);
		expect(addIdx).toBeLessThan(commitIdx);
	});

	test('proceed-branch: setPhaseFn called exactly once with "implementing" (AC1, AC5)', () => {
		const { opts, setPhaseCalls } = makeOpts();
		runPostAuditAction(opts);
		expect(setPhaseCalls.length).toBe(1);
		expect(setPhaseCalls[0]).toBe('implementing');
	});

	test('proceed-branch: three git calls total: checkout, add, commit (AC1)', () => {
		const { opts, gitCalls } = makeOpts();
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(3);
	});

	test('proceed-branch: escalateFn NOT called on approve (AC1)', async () => {
		const { opts, escalateCalled } = makeOpts();
		runPostAuditAction(opts);
		// Give the fire-and-forget microtask a tick to settle
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(0);
	});

	// -------------------------------------------------------------------------
	// pause-operator path (operator mode, audit-approved) - AC2
	// -------------------------------------------------------------------------

	test('pause-operator: returns awaiting-operator-approval kind (AC2)', () => {
		const { opts } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('awaiting-operator-approval');
	});

	test('pause-operator: no git calls made (AC2)', () => {
		const { opts, gitCalls } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
	});

	test('pause-operator: setPhaseFn NOT called (AC4)', () => {
		const { opts, setPhaseCalls } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		runPostAuditAction(opts);
		expect(setPhaseCalls.length).toBe(0);
	});

	test('pause-operator: escalateFn NOT called (AC2)', async () => {
		const { opts, escalateCalled } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		runPostAuditAction(opts);
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(0);
	});

	// -------------------------------------------------------------------------
	// audit-blocked path - AC3
	// -------------------------------------------------------------------------

	test('audit-blocked: returns escalated kind (AC3)', () => {
		const { opts } = makeOpts({ planResult: BLOCKED_RESULT });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('escalated');
	});

	test('audit-blocked: escalateFn is called (AC3)', async () => {
		const { opts, escalateCalled } = makeOpts({ planResult: BLOCKED_RESULT });
		runPostAuditAction(opts);
		// Give the fire-and-forget microtask a tick to settle
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(1);
	});

	test('audit-blocked: notifyFn is called with [cam] plan BLOCK prefix (AC3)', () => {
		const { opts, notifyMessages } = makeOpts({ planResult: BLOCKED_RESULT });
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
		expect(notifyMessages[0]).toMatch(/^\[cam\] plan BLOCK:/);
	});

	test('audit-blocked: notifyFn message includes report summary (AC3)', () => {
		const { opts, notifyMessages } = makeOpts({ planResult: BLOCKED_RESULT });
		runPostAuditAction(opts);
		expect(notifyMessages[0]).toContain(BLOCK_REPORT.summary);
	});

	test('audit-blocked: no git calls made (AC3)', () => {
		const { opts, gitCalls } = makeOpts({ planResult: BLOCKED_RESULT });
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
	});

	test('audit-blocked: setPhaseFn called zero times (AC3, AC5)', () => {
		const { opts, setPhaseCalls } = makeOpts({ planResult: BLOCKED_RESULT });
		runPostAuditAction(opts);
		expect(setPhaseCalls.length).toBe(0);
	});

	test('audit-blocked: absent escalateFn is safe (AC3 best-effort)', () => {
		const { opts } = makeOpts({ planResult: BLOCKED_RESULT, escalateFn: undefined });
		// Should not throw when escalateFn is absent
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Non-approved, non-blocked planResult
	// -------------------------------------------------------------------------

	test('no-plannable-issue: returns no-action kind', () => {
		const { opts } = makeOpts({ planResult: { kind: 'no-plannable-issue' } });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test('mutex-busy: returns no-action kind', () => {
		const { opts } = makeOpts({ planResult: { kind: 'mutex-busy' } });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	// -------------------------------------------------------------------------
	// preflight-failed path (US-003, CAM-215): distinct kind + marker + notify
	// -------------------------------------------------------------------------

	test('preflight-failed: returns a distinct preflight-failed kind, not no-action', () => {
		const { opts } = makeOpts({ planResult: PREFLIGHT_FAILED_RESULT });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('preflight-failed');
	});

	test('preflight-failed: no git/setPhase/escalate calls', () => {
		const { opts, gitCalls, setPhaseCalls, escalateCalled } = makeOpts({
			planResult: PREFLIGHT_FAILED_RESULT,
		});
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
		expect(setPhaseCalls.length).toBe(0);
		expect(escalateCalled.n).toBe(0);
	});

	test('preflight-failed: writePreflightFailedMarkerFn is called once with the FULL untruncated { step, detail }', () => {
		const multiLineResult: PlanPhaseResult = {
			kind: 'preflight-failed',
			step: 'bun-test',
			detail: 'line one\nline two\nline three',
		};
		const { opts, preflightMarkerCalls } = makeOpts({ planResult: multiLineResult });
		runPostAuditAction(opts);
		expect(preflightMarkerCalls.length).toBe(1);
		expect(preflightMarkerCalls[0]).toEqual({ step: 'bun-test', detail: 'line one\nline two\nline three' });
	});

	test('preflight-failed: the writer-params object carries no writtenAt field (pure, clock-free loop)', () => {
		const { opts, preflightMarkerCalls } = makeOpts({ planResult: PREFLIGHT_FAILED_RESULT });
		runPostAuditAction(opts);
		expect(Object.keys(preflightMarkerCalls[0] ?? {}).sort()).toEqual(['detail', 'step']);
	});

	test('preflight-failed: notifyFn is called once with a one-line narration containing step and truncated detail', () => {
		const multiLineResult: PlanPhaseResult = {
			kind: 'preflight-failed',
			step: 'typecheck',
			detail: 'error TS2345: first\nsecond context line\nthird context line',
		};
		const { opts, notifyMessages } = makeOpts({ planResult: multiLineResult });
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
		expect(notifyMessages[0]).toContain('typecheck');
		expect(notifyMessages[0]).toContain('error TS2345: first');
		expect(notifyMessages[0]).toContain('(+2 more)');
		// The pane narration is truncated: the raw remaining lines never appear.
		expect(notifyMessages[0]).not.toContain('second context line');
	});

	test('preflight-failed: notifyFn narration is unchanged for single-line detail (no (+N more) suffix)', () => {
		const { opts, notifyMessages } = makeOpts({ planResult: PREFLIGHT_FAILED_RESULT });
		runPostAuditAction(opts);
		expect(notifyMessages[0]).toContain(PREFLIGHT_FAILED_RESULT.kind === 'preflight-failed' ? PREFLIGHT_FAILED_RESULT.detail : '');
		expect(notifyMessages[0]).not.toContain('more)');
	});

	test('preflight-failed: absent writePreflightFailedMarkerFn/notifyFn is safe (best-effort, never throws)', () => {
		const { opts } = makeOpts({
			planResult: PREFLIGHT_FAILED_RESULT,
			writePreflightFailedMarkerFn: undefined,
			notifyFn: undefined,
		});
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// plan-target-invalid path (US-003, CAM-203)
	// -------------------------------------------------------------------------

	test('plan-target-invalid: returns no-action kind (AC4: no branch/commit/implementing flip)', () => {
		const { opts } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test('plan-target-invalid: notifyFn is called naming the target id (AC2)', () => {
		const { opts, notifyMessages } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
		expect(notifyMessages[0]).toContain('CAM-777');
	});

	test('plan-target-invalid: notifyFn message names the plan-target-invalid failure (AC2)', () => {
		const { opts, notifyMessages } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		runPostAuditAction(opts);
		expect(notifyMessages[0]).toMatch(/plan target invalid/i);
	});

	test('plan-target-invalid: escalateFn is NEVER called (operator-input error, not an infra alert) (AC2)', async () => {
		const { opts, escalateCalled } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		runPostAuditAction(opts);
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(0);
	});

	test('plan-target-invalid: emits a structured plan-target-invalid event carrying the targetId (AC2)', () => {
		const { logger: logEvent, events } = makeInMemoryEventLogger();
		const { opts } = makeOpts({ planResult: TARGET_INVALID_RESULT, logEvent });
		runPostAuditAction(opts);
		const targetEvents = events.filter((e) => e.kind === 'plan-target-invalid');
		expect(targetEvents.length).toBe(1);
		expect((targetEvents[0]?.detail as { targetId?: string }).targetId).toBe('CAM-777');
	});

	test('plan-target-invalid: absent logEvent is safe (backward compat)', () => {
		const { opts } = makeOpts({ planResult: TARGET_INVALID_RESULT, logEvent: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('plan-target-invalid: no git calls made (AC4: no branch/commit)', () => {
		const { opts, gitCalls } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
		const branchCalls = gitCalls.filter((c) => c.args[0] === 'checkout' && c.args[1] === '-b');
		expect(branchCalls.length).toBe(0);
	});

	test('plan-target-invalid: setPhaseFn NOT called by runPostAuditAction itself (AC3: idle exit happens via the caller exitPhaseAfterPlan)', () => {
		const { opts, setPhaseCalls } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		runPostAuditAction(opts);
		expect(setPhaseCalls.length).toBe(0);
	});

	test('plan-target-invalid: removeEscalationMarkerFn NOT called', () => {
		const { opts, removeMarkerCalled } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		runPostAuditAction(opts);
		expect(removeMarkerCalled.n).toBe(0);
	});

	// -------------------------------------------------------------------------
	// spawnSync exit-status guard (US-R1-001 pattern)
	// -------------------------------------------------------------------------

	test('git checkout -b failure throws (exit-status guard)', () => {
		const failCheckoutSpawnFn: SpawnFn = (_cmd, args) => {
			if (args[0] === 'checkout') return { stdout: '', exitCode: 1 };
			return { stdout: '', exitCode: 0 };
		};
		const { opts } = makeOpts({ spawnFn: failCheckoutSpawnFn });
		expect(() => runPostAuditAction(opts)).toThrow(/git checkout -b/);
	});

	test('git add failure throws (exit-status guard)', () => {
		const failAddSpawnFn: SpawnFn = (_cmd, args) => {
			if (args[0] === 'add') return { stdout: '', exitCode: 1 };
			return { stdout: '', exitCode: 0 };
		};
		const { opts } = makeOpts({ spawnFn: failAddSpawnFn });
		expect(() => runPostAuditAction(opts)).toThrow(/git add/);
	});

	test('git commit failure throws (exit-status guard)', () => {
		const failCommitSpawnFn: SpawnFn = (_cmd, args) => {
			if (args[0] === 'commit') return { stdout: '', exitCode: 1 };
			return { stdout: '', exitCode: 0 };
		};
		const { opts } = makeOpts({ spawnFn: failCommitSpawnFn });
		expect(() => runPostAuditAction(opts)).toThrow(/git commit/);
	});

	// -------------------------------------------------------------------------
	// plan-escalated path (US-004, CAM-204) - the durable marker was already
	// written unconditionally by runPlanPhaseWithReplan BEFORE this function
	// is ever called; here we only assert the best-effort notify/escalate
	// fan-out and the idle-exit shape.
	// -------------------------------------------------------------------------

	test('plan-escalated: returns escalated kind (US-004)', () => {
		const { opts } = makeOpts({ planResult: ESCALATED_RESULT });
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('escalated');
	});

	test('plan-escalated: escalateFn is called (US-004)', async () => {
		const { opts, escalateCalled } = makeOpts({ planResult: ESCALATED_RESULT });
		runPostAuditAction(opts);
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(1);
	});

	test('plan-escalated: notifyFn is called with [cam] plan escalated prefix (US-004)', () => {
		const { opts, notifyMessages } = makeOpts({ planResult: ESCALATED_RESULT });
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
		expect(notifyMessages[0]).toMatch(/^\[cam\] plan escalated:/);
	});

	test('plan-escalated: notifyFn message includes the final report summary (US-004)', () => {
		const { opts, notifyMessages } = makeOpts({ planResult: ESCALATED_RESULT });
		runPostAuditAction(opts);
		expect(notifyMessages[0]).toContain(ESCALATED_REPORT.summary);
	});

	test('plan-escalated: no branch/commit/setPhase calls (US-004)', () => {
		const { opts, gitCalls, setPhaseCalls } = makeOpts({ planResult: ESCALATED_RESULT });
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
		expect(setPhaseCalls.length).toBe(0);
	});

	test('plan-escalated: absent escalateFn is safe (US-004 best-effort)', () => {
		const { opts } = makeOpts({ planResult: ESCALATED_RESULT, escalateFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('plan-escalated: removeEscalationMarkerFn is NOT called (only convergence removes the marker) (US-004)', () => {
		const { opts, removeMarkerCalled } = makeOpts({ planResult: ESCALATED_RESULT });
		runPostAuditAction(opts);
		expect(removeMarkerCalled.n).toBe(0);
	});

	// -------------------------------------------------------------------------
	// removeEscalationMarkerFn wiring (US-004, CAM-204, AC4)
	// -------------------------------------------------------------------------

	test('proceed-branch: removeEscalationMarkerFn is called exactly once on convergence (AC4)', () => {
		const { opts, removeMarkerCalled } = makeOpts();
		runPostAuditAction(opts);
		expect(removeMarkerCalled.n).toBe(1);
	});

	test('proceed-branch: removeEscalationMarkerFn fires BEFORE the git checkout -b call (AC4)', () => {
		const order: string[] = [];
		const { opts } = makeOpts({
			removeEscalationMarkerFn: () => { order.push('remove-marker'); },
			spawnFn: (cmd, args) => {
				if (args[0] === 'checkout') order.push('git-checkout');
				return { stdout: '', exitCode: 0 };
			},
		});
		runPostAuditAction(opts);
		expect(order).toEqual(['remove-marker', 'git-checkout']);
	});

	test('proceed-branch: absent removeEscalationMarkerFn is safe (AC4 backward compat)', () => {
		const { opts } = makeOpts({ removeEscalationMarkerFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('pause-operator: removeEscalationMarkerFn NOT called (only proceed-branch convergence removes it) (AC4)', () => {
		const { opts, removeMarkerCalled } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		runPostAuditAction(opts);
		expect(removeMarkerCalled.n).toBe(0);
	});

	test('audit-blocked: removeEscalationMarkerFn NOT called (AC4)', () => {
		const { opts, removeMarkerCalled } = makeOpts({ planResult: BLOCKED_RESULT });
		runPostAuditAction(opts);
		expect(removeMarkerCalled.n).toBe(0);
	});

	// -------------------------------------------------------------------------
	// removePreflightFailedMarkerFn wiring (US-004, CAM-215, Option B): fired
	// for EVERY planResult kind that is not itself preflight-failed, not
	// gated on convergence (unlike removeEscalationMarkerFn above) and not
	// gated on issueId.
	// -------------------------------------------------------------------------

	test('audit-approved (proceed-branch): removePreflightFailedMarkerFn is called once (Option B)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ planResult: APPROVED_RESULT });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(1);
	});

	test('planner-failed: removePreflightFailedMarkerFn is called once (Option B)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ planResult: { kind: 'planner-failed' } });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(1);
	});

	test('mutex-busy: removePreflightFailedMarkerFn is called once (Option B)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ planResult: { kind: 'mutex-busy' } });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(1);
	});

	test('audit-approved + pause-operator: removePreflightFailedMarkerFn is still called (not gated on convergence)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ readPlanApprovalFn: () => 'operator' });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(1);
	});

	test('audit-blocked: removePreflightFailedMarkerFn is still called (not gated on convergence)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ planResult: BLOCKED_RESULT });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(1);
	});

	test('plan-escalated: removePreflightFailedMarkerFn is still called (not gated on convergence)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ planResult: ESCALATED_RESULT });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(1);
	});

	test('plan-target-invalid: removePreflightFailedMarkerFn is still called (not gated on issueId)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ planResult: TARGET_INVALID_RESULT });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(1);
	});

	test('preflight-failed: removePreflightFailedMarkerFn is NOT called (the arm writes, never unlinks its own marker)', () => {
		const { opts, removePreflightMarkerCalled } = makeOpts({ planResult: PREFLIGHT_FAILED_RESULT });
		runPostAuditAction(opts);
		expect(removePreflightMarkerCalled.n).toBe(0);
	});

	test('absent removePreflightFailedMarkerFn is safe (backward compat)', () => {
		const { opts } = makeOpts({ removePreflightFailedMarkerFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('absent removePreflightFailedMarkerFn on preflight-failed is safe (backward compat)', () => {
		const { opts } = makeOpts({ planResult: PREFLIGHT_FAILED_RESULT, removePreflightFailedMarkerFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// PostAuditActionResult kinds are exhaustive and distinct
	// -------------------------------------------------------------------------

	test('PostAuditActionResult kinds are exhaustive', () => {
		const kinds: PostAuditActionResult['kind'][] = [
			'branch-created',
			'awaiting-operator-approval',
			'escalated',
			'no-action',
		];
		expect(kinds.every((k) => typeof k === 'string')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Production wiring oracle (US-R1-001)
//
// Unit tests that inject runPlanPhaseFn directly into runSidecarLoop cannot
// detect a missing runPostAuditAction call in the outer production caller
// (makeProductionPlanPhaseFn in sidecar.ts). This source-text oracle catches
// that gap independently of injection tests.
// ---------------------------------------------------------------------------

describe('sidecar.ts production wiring oracle - runPostAuditAction (US-R1-001)', () => {
	const sidecarPath = resolve(import.meta.dir, '..', '..', '..', 'src', 'commands', 'sidecar.ts');
	const source = readFileSync(sidecarPath, 'utf8');

	test('sidecar.ts imports runPostAuditAction from plan-runner.ts', () => {
		expect(source).toContain('runPostAuditAction');
		expect(source).toContain("from '../supervisor/plan-runner.ts'");
	});

	test('makeProductionPlanPhaseFn delegates to runPostPlanActions', () => {
		// US-005 (CAM-155): the post-audit logic was extracted to runPostPlanActions
		// to keep makeProductionPlanPhaseFn under the biome 80-line limit.
		const fnMatch = source.match(/function makeProductionPlanPhaseFn[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		expect(fnMatch?.[0]).toContain('runPostPlanActions(');
	});

	test('runPostPlanActions calls runPostAuditAction', () => {
		// runPostAuditAction lives inside the runPostPlanActions helper.
		const helperMatch = source.match(/function runPostPlanActions[\s\S]*?^\}/m);
		expect(helperMatch).not.toBeNull();
		expect(helperMatch?.[0]).toContain('runPostAuditAction(');
	});

	test('runPostAuditAction call wires setPhaseFn, branchName, readPlanApprovalFn', () => {
		const callMatch = source.match(/runPostAuditAction\(\{[\s\S]*?\}\)/);
		expect(callMatch).not.toBeNull();
		expect(callMatch?.[0]).toContain('setPhaseFn');
		expect(callMatch?.[0]).toContain('branchName');
		expect(callMatch?.[0]).toContain('readPlanApprovalFn');
	});

	// US-004 (CAM-215): the remove seam is sibling to removeEscalationMarkerFn
	// wiring in the same runPostAuditAction call.
	test('sidecar.ts imports removePlanPreflightFailedMarker from plan-preflight-marker.ts', () => {
		expect(source).toContain('removePlanPreflightFailedMarker');
		expect(source).toContain("from '../supervisor/plan-preflight-marker.ts'");
	});

	test('runPostAuditAction call wires removePreflightFailedMarkerFn against PLAN_PREFLIGHT_FAILED_FILENAME', () => {
		const callMatch = source.match(/runPostAuditAction\(\{[\s\S]*?\}\)/);
		expect(callMatch).not.toBeNull();
		expect(callMatch?.[0]).toContain('removePreflightFailedMarkerFn');
		expect(callMatch?.[0]).toContain('removePlanPreflightFailedMarker(');
		expect(callMatch?.[0]).toContain('PLAN_PREFLIGHT_FAILED_FILENAME');
	});
});

// ---------------------------------------------------------------------------
// Re-entry guard oracle (US-R1-002)
//
// makeProductionPlanPhaseFn must transition phase out of 'planning' on
// non-implementing outcomes to prevent the sidecar from re-running the full
// network preflight (git checkout main + git pull + gh prune) on every idle
// tick. This oracle catches a missing or incorrect phase transition.
//
// Implementation: the transition logic lives in the extracted helper
// exitPhaseAfterPlan (biome noExcessiveLinesPerFunction requires the closure
// to stay under 80 lines). Two oracle groups:
//   A. makeProductionPlanPhaseFn wires the call to exitPhaseAfterPlan.
//   B. exitPhaseAfterPlan helper contains the correct phase logic.
// ---------------------------------------------------------------------------

describe('sidecar.ts re-entry guard oracle - phase transition after runPostAuditAction (US-R1-002)', () => {
	const sidecarPath = resolve(import.meta.dir, '..', '..', '..', 'src', 'commands', 'sidecar.ts');
	const source = readFileSync(sidecarPath, 'utf8');

	// Group A: runPostPlanActions wiring assertions
	// US-005 (CAM-155): the post-audit logic was extracted from makeProductionPlanPhaseFn
	// into runPostPlanActions to keep the closure under biome's 80-line limit.
	// makeProductionPlanPhaseFn now delegates to runPostPlanActions.
	const postPlanHelperMatch = source.match(/function runPostPlanActions[\s\S]*?^\}/m);
	const postPlanHelperBody = postPlanHelperMatch?.[0] ?? '';

	test('A: runPostPlanActions captures the postAuditResult return value', () => {
		// The return value must be captured so exitPhaseAfterPlan can inspect it.
		expect(postPlanHelperBody).toContain('postAuditResult');
	});

	test('A: runPostPlanActions calls exitPhaseAfterPlan for the re-entry guard', () => {
		// The extracted helper must be called (proves the guard is wired).
		expect(postPlanHelperBody).toContain('exitPhaseAfterPlan(');
	});

	test('A: runPostPlanActions passes makeSetPhaseFn to exitPhaseAfterPlan', () => {
		// Phase must be written via makeSetPhaseFn (not a bare file write).
		// The call passes postAuditResult + makeSetPhaseFn(claudeDir, cwd) as args.
		const exitCall = postPlanHelperBody.match(/exitPhaseAfterPlan\([^)]+\)/);
		expect(exitCall).not.toBeNull();
		expect(exitCall?.[0]).toContain('makeSetPhaseFn');
	});

	// Group B: exitPhaseAfterPlan helper correctness assertions
	const helperMatch = source.match(/function exitPhaseAfterPlan[\s\S]*?^\}/m);
	const helperBody = helperMatch?.[0] ?? '';

	test('B: exitPhaseAfterPlan is defined in sidecar.ts', () => {
		expect(helperBody).not.toBe('');
	});

	test('B: exitPhaseAfterPlan no-ops on branch-created', () => {
		// branch-created: runPostAuditAction already called setPhaseFn internally.
		expect(helperBody).toContain("'branch-created'");
	});

	test('B: exitPhaseAfterPlan transitions to awaiting-operator on awaiting-operator-approval', () => {
		// operator mode: audit-approved + pause-operator -> awaiting-operator phase.
		expect(helperBody).toContain("'awaiting-operator-approval'");
		expect(helperBody).toContain("'awaiting-operator'");
	});

	test('B: exitPhaseAfterPlan transitions to idle on no-action/escalated outcomes', () => {
		// All other non-implementing outcomes (mutex-busy, preflight-failed,
		// planner/auditor timeout, no-plannable-issue, audit-blocked/escalated)
		// exit to idle so the loop does not re-run preflight every 2 seconds.
		expect(helperBody).toContain("'idle'");
	});
});
