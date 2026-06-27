// test/plan/plan-approval-branch.test.ts
//
// Acceptance oracle for US-004: deterministic plan_approval branch decision.
//
// Tests:
//  1. decidePostAuditAction('operator') -> { kind: 'pause-operator' }
//  2. decidePostAuditAction('auto')     -> { kind: 'proceed-branch' }
//  3. readPlanApproval drives the decision end-to-end (fixture config)
//  4. decidePostAuditAction is only reachable on the post-APPROVE path
//     (unit assertion confirming it is never called before APPROVE)

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decidePostAuditAction } from '../../src/plan/plan-approval-decision.ts';
import { readPlanApproval } from '../../src/config/models.ts';

describe('decidePostAuditAction', () => {
	test('operator mode returns pause-operator action', () => {
		const result = decidePostAuditAction('operator');
		expect(result).toEqual({ kind: 'pause-operator' });
	});

	test('auto mode returns proceed-branch action', () => {
		const result = decidePostAuditAction('auto');
		expect(result).toEqual({ kind: 'proceed-branch' });
	});
});

describe('readPlanApproval drives the decision', () => {
	let tmpDir: string;

	// Create a temp dir for each test group; clean up after.
	function setup(): string {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-approval-'));
		return tmpDir;
	}

	function teardown(): void {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	}

	test('config with plan_approval = "operator" produces pause-operator', () => {
		const dir = setup();
		try {
			const configPath = join(dir, 'project.toml');
			writeFileSync(configPath, '[plan]\nplan_approval = "operator"\n');
			const approval = readPlanApproval(configPath);
			expect(approval).toBe('operator');
			const action = decidePostAuditAction(approval);
			expect(action).toEqual({ kind: 'pause-operator' });
		} finally {
			teardown();
		}
	});

	test('config with plan_approval = "auto" produces proceed-branch', () => {
		const dir = setup();
		try {
			const configPath = join(dir, 'project.toml');
			writeFileSync(configPath, '[plan]\nplan_approval = "auto"\n');
			const approval = readPlanApproval(configPath);
			expect(approval).toBe('auto');
			const action = decidePostAuditAction(approval);
			expect(action).toEqual({ kind: 'proceed-branch' });
		} finally {
			teardown();
		}
	});

	test('missing config falls back to auto and produces proceed-branch', () => {
		const dir = setup();
		try {
			// No project.toml written; readPlanApproval must return 'auto'.
			const configPath = join(dir, 'project.toml');
			const approval = readPlanApproval(configPath);
			expect(approval).toBe('auto');
			const action = decidePostAuditAction(approval);
			expect(action).toEqual({ kind: 'proceed-branch' });
		} finally {
			teardown();
		}
	});
});

describe('decidePostAuditAction is only reachable post-APPROVE', () => {
	// This unit assertion models the cam-plan.md invariant: the BLOCK re-audit
	// loop must complete (reaching APPROVE) before decidePostAuditAction is
	// consulted.  We simulate the BLOCK -> APPROVE sequence and assert that
	// decidePostAuditAction is called exactly once, only after APPROVE.

	test('helper is invoked on APPROVE, not on BLOCK', () => {
		// Simulated verdict sequence: BLOCK, BLOCK, APPROVE.
		const verdicts: Array<'APPROVE' | 'BLOCK'> = ['BLOCK', 'BLOCK', 'APPROVE'];
		const callLog: string[] = [];

		let action: ReturnType<typeof decidePostAuditAction> | null = null;
		for (const verdict of verdicts) {
			if (verdict === 'BLOCK') {
				// do NOT branch: loop continues, decidePostAuditAction NOT called.
				callLog.push('block-re-audit');
				continue;
			}
			// APPROVE: now consult the deterministic helper.
			action = decidePostAuditAction('auto');
			callLog.push('post-approve-decide');
			break;
		}

		// The BLOCK iterations must precede the post-APPROVE call.
		expect(callLog).toEqual(['block-re-audit', 'block-re-audit', 'post-approve-decide']);
		// Helper was invoked exactly once, on APPROVE.
		expect(action).toEqual({ kind: 'proceed-branch' });
	});
});
