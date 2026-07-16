// test/plan-approval-gate.test.ts
//
// Unit tests: plan-approval gate module (US-001, CAM-241/153/312).
//
// Acceptance criteria proved:
//   AC1/AC2: PLAN_APPROVAL_GATE + PLAN_APPROVAL_OPTIONS identity (also
//            proved directly via file-assert oracles on the source file).
//   AC3: buildPlanApprovalContext summarizes title, story count, and
//        per-story acceptance-criteria counts; null/empty prd is safe.
//   AC4: makePlanApprovalResolver's approve/reject behavior.
//   AC5: the resolver fails safe to 'idle' on an unexpected/absent decision.

import { test, expect } from 'bun:test';

import {
	PLAN_APPROVAL_GATE,
	PLAN_APPROVAL_OPTIONS,
	buildPlanApprovalContext,
	makePlanApprovalResolver,
	type PlanApprovalResolverDeps,
} from '../src/supervisor/plan-approval-gate.ts';
import type { CamGate } from '../src/supervisor/gate.ts';

// ---------------------------------------------------------------------------
// Identity (AC1, AC2)
// ---------------------------------------------------------------------------

test('PLAN_APPROVAL_GATE is the exact discriminator string', () => {
	expect(PLAN_APPROVAL_GATE).toBe('plan-approval');
});

test('PLAN_APPROVAL_OPTIONS is exactly ["approve", "reject"] in that order', () => {
	expect(PLAN_APPROVAL_OPTIONS).toEqual(['approve', 'reject']);
});

// ---------------------------------------------------------------------------
// buildPlanApprovalContext (AC3)
// ---------------------------------------------------------------------------

test('buildPlanApprovalContext summarizes title, story count, and per-story AC counts', () => {
	const summary = buildPlanApprovalContext({
		title: 'Widget rollout',
		userStories: [
			{ id: 'US-001', acceptanceCriteria: ['a', 'b', 'c'] },
			{ id: 'US-002', acceptanceCriteria: ['a'] },
		],
	});
	expect(summary).toContain('Widget rollout');
	expect(summary).toContain('Story count: 2');
	expect(summary).toContain('US-001: 3 acceptance criteria');
	expect(summary).toContain('US-002: 1 acceptance criteria');
});

test('buildPlanApprovalContext falls back to description when title is absent', () => {
	const summary = buildPlanApprovalContext({
		description: 'Turn the dead-end into a real gate.',
		userStories: [{ id: 'US-001', acceptanceCriteria: [] }],
	});
	expect(summary).toContain('Turn the dead-end into a real gate.');
	expect(summary).toContain('US-001: 0 acceptance criteria');
});

test('buildPlanApprovalContext yields a safe non-throwing fallback line for null prd', () => {
	expect(() => buildPlanApprovalContext(null)).not.toThrow();
	const summary = buildPlanApprovalContext(null);
	expect(typeof summary).toBe('string');
	expect(summary.length).toBeGreaterThan(0);
});

test('buildPlanApprovalContext yields a safe non-throwing fallback line for an empty prd', () => {
	expect(() => buildPlanApprovalContext({})).not.toThrow();
	const summary = buildPlanApprovalContext({});
	expect(typeof summary).toBe('string');
	expect(summary).toContain('0 user stories');
});

// ---------------------------------------------------------------------------
// makePlanApprovalResolver (AC4, AC5)
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<PlanApprovalResolverDeps> = {}): {
	deps: PlanApprovalResolverDeps;
	calls: string[];
} {
	const calls: string[] = [];
	const deps: PlanApprovalResolverDeps = {
		proceedBranchFn: () => calls.push('proceedBranch'),
		removePrdFn: () => calls.push('removePrd'),
		notifyFn: (line: string) => calls.push(`notify:${line}`),
		...overrides,
	};
	return { deps, calls };
}

function gateWithDecision(decision: string | undefined): CamGate {
	const gate: CamGate = { gate: PLAN_APPROVAL_GATE, options: [...PLAN_APPROVAL_OPTIONS], context: 'ctx' };
	if (decision !== undefined) gate.decision = decision;
	return gate;
}

test("resolver: 'approve' calls proceedBranchFn and returns 'implementing'", () => {
	const { deps, calls } = makeDeps();
	const resolver = makePlanApprovalResolver(deps);
	const phase = resolver(gateWithDecision('approve'));
	expect(phase).toBe('implementing');
	expect(calls).toEqual(['proceedBranch']);
});

test("resolver: 'reject' calls removePrdFn then notifyFn, and returns 'idle'", () => {
	const { deps, calls } = makeDeps();
	const resolver = makePlanApprovalResolver(deps);
	const phase = resolver(gateWithDecision('reject'));
	expect(phase).toBe('idle');
	expect(calls.length).toBe(2);
	expect(calls[0]).toBe('removePrd');
	expect(calls[1]?.startsWith('notify:')).toBe(true);
});

test("resolver: 'approve' never calls removePrdFn or notifyFn", () => {
	const { deps, calls } = makeDeps();
	const resolver = makePlanApprovalResolver(deps);
	resolver(gateWithDecision('approve'));
	expect(calls).not.toContain('removePrd');
	expect(calls.some((c) => c.startsWith('notify:'))).toBe(false);
});

test("resolver: an unexpected decision fails safe to 'idle' without calling any deps", () => {
	const { deps, calls } = makeDeps();
	const resolver = makePlanApprovalResolver(deps);
	const phase = resolver(gateWithDecision('something-else'));
	expect(phase).toBe('idle');
	expect(calls).toEqual([]);
});

test("resolver: an absent decision fails safe to 'idle' without calling any deps", () => {
	const { deps, calls } = makeDeps();
	const resolver = makePlanApprovalResolver(deps);
	const phase = resolver(gateWithDecision(undefined));
	expect(phase).toBe('idle');
	expect(calls).toEqual([]);
});
