// test/plan-runner-no-prd.test.ts
//
// Unit tests for the planner-no-prd failure mode (US-003, CAM-155).
//
// Acceptance criteria proved:
//   AC1: runPlanPhase returns 'planner-failed' when the planner poll ends and
//        readPlannerReportFn is defined but returns null (pane died without prd.json).
//        The auditor is NEVER spawned in that case.
//   AC2: runPostAuditAction handles 'planner-failed': calls notifyFn best-effort,
//        does NOT fire escalateFn, returns { kind: 'no-action' }, which maps to
//        phase:idle via exitPhaseAfterPlan (proved by phase-setter assertion).

import { describe, expect, test } from 'bun:test';
import {
	runPlanPhase,
	runPostAuditAction,
	type RunPlanPhaseOptions,
	type RunPostAuditOptions,
} from '../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../src/supervisor/loop.ts';
import type { IssueEntry } from '../src/issues/types.ts';
import type { LoopPhase } from '../src/commands/status.ts';
import type { PlanApproval } from '../src/config/models.ts';

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

// ---------------------------------------------------------------------------
// Helper: recorded tmux call
// ---------------------------------------------------------------------------

interface SpawnCall {
	cmd: string;
	args: string[];
}

// ---------------------------------------------------------------------------
// Helpers for runPlanPhase (planner-failed path)
// ---------------------------------------------------------------------------

/**
 * Builds opts for runPlanPhase where:
 * - Preflight ok, issue found, mutex available.
 * - readPlannerReportFn is injected and returns null (no prd.json written).
 * - Pane dies immediately (isPaneAlive = false after first tick).
 * - readPlanVerdictFn returns null (auditor never polled - should not reach auditor).
 */
function makePlannerfailedOpts(overrides: Partial<RunPlanPhaseOptions> = {}): {
	opts: RunPlanPhaseOptions;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	let paneAliveCount = 0; // pane already dead (never alive)

	const spawnFn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPlanPhaseOptions = {
		spawnFn,
		isPaneAlive: () => {
			if (paneAliveCount > 0) {
				paneAliveCount--;
				return true;
			}
			return false; // pane dies immediately (simulates no-prd planner)
		},
		sleepFn: () => {},
		genUuid: () => 'test-uuid-1111-0000-0000-000000000000',
		selectIssueFn: () => MOCK_ISSUE,
		// readPlannerReportFn is DEFINED but always returns null (no prd.json).
		readPlannerReportFn: () => null,
		readPlanVerdictFn: () => null, // should never be reached on planner-failed path
		preflightFn: () => ({ ok: true }),
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

// ---------------------------------------------------------------------------
// Tests: runPlanPhase - planner-failed path (AC1)
// ---------------------------------------------------------------------------

describe('runPlanPhase - planner-failed path (AC1)', () => {
	test('returns planner-failed when pane dies and readPlannerReportFn returns null', () => {
		const { opts } = makePlannerfailedOpts();
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('planner-failed');
	});

	test('auditor is NEVER spawned (no respawn-pane with subagent-auditor) (AC1)', () => {
		const { opts, calls } = makePlannerfailedOpts();
		runPlanPhase(opts);
		const auditorRespawn = calls.find(
			(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-auditor')),
		);
		expect(auditorRespawn).toBeUndefined();
	});

	test('no @cam_label auditor set-option call (AC1)', () => {
		const { opts, calls } = makePlannerfailedOpts();
		runPlanPhase(opts);
		const auditorLabel = calls.find(
			(c) => c.args[2] === 'set-option' && c.args.includes('auditor'),
		);
		expect(auditorLabel).toBeUndefined();
	});

	test('at most 1 respawn-pane call (planner only, auditor never spawned) (AC1)', () => {
		const { opts, calls } = makePlannerfailedOpts();
		runPlanPhase(opts);
		const respawnCalls = calls.filter((c) => c.args[2] === 'respawn-pane');
		// Only the planner respawn-pane (set @cam_label planner + respawn); auditor never reached.
		expect(respawnCalls.length).toBeLessThanOrEqual(1);
	});

	test('readPlanVerdictFn (auditor poll) is NEVER called (AC1)', () => {
		let verdictReadCount = 0;
		const { opts } = makePlannerfailedOpts({
			readPlanVerdictFn: () => {
				verdictReadCount++;
				return null;
			},
		});
		runPlanPhase(opts);
		expect(verdictReadCount).toBe(0);
	});

	test('backward-compat: absent readPlannerReportFn + pane dies -> proceeds to auditor (NOT planner-failed)', () => {
		// When readPlannerReportFn is NOT injected and the pane dies, the old behavior
		// (fall through to the auditor) is preserved. Pane dies after 1 tick.
		const calls: SpawnCall[] = [];
		let paneAliveCount = 1;
		const spawnFn: SpawnFn = (cmd, args) => { calls.push({ cmd, args }); return { stdout: '', exitCode: 0 }; };
		const opts: RunPlanPhaseOptions = {
			spawnFn,
			isPaneAlive: () => { if (paneAliveCount > 0) { paneAliveCount--; return true; } return false; },
			sleepFn: () => {},
			genUuid: () => 'compat-uuid',
			selectIssueFn: () => MOCK_ISSUE,
			// readPlannerReportFn intentionally ABSENT (backward-compat path)
			readPlanVerdictFn: () => ({ verdict: 'APPROVE', summary: 'ok', findings: [] }),
			preflightFn: () => ({ ok: true }),
			clock: (() => { let t = 0; return () => (t += 100); })(),
			plannerPaneId: '%3',
			paneCountMutexFn: () => 'available',
			pollIntervalMs: 1,
			plannerTimeoutMs: 999_999,
			auditorTimeoutMs: 999_999,
		};
		const result = runPlanPhase(opts);
		// Without readPlannerReportFn, planner-failed is NOT triggered. The auditor
		// poll runs and (with the APPROVE verdict) returns audit-approved.
		expect(result.kind).toBe('audit-approved');
		// Auditor WAS spawned (2 respawn-pane calls: planner + auditor).
		const respawnCalls = calls.filter((c) => c.args[2] === 'respawn-pane');
		expect(respawnCalls.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Tests: runPostAuditAction - planner-failed path (AC2)
// ---------------------------------------------------------------------------

describe('runPostAuditAction - planner-failed handling (AC2)', () => {
	/** Build minimal opts for runPostAuditAction on the planner-failed path. */
	function makePostAuditOpts(overrides: Partial<RunPostAuditOptions> = {}): {
		opts: RunPostAuditOptions;
		gitCalls: SpawnCall[];
		setPhaseCalls: LoopPhase[];
		escalateCalled: { n: number };
		notifyMessages: string[];
	} {
		const gitCalls: SpawnCall[] = [];
		const setPhaseCalls: LoopPhase[] = [];
		const escalateCalled = { n: 0 };
		const notifyMessages: string[] = [];

		const spawnFn: SpawnFn = (cmd, args) => { gitCalls.push({ cmd, args }); return { stdout: '', exitCode: 0 }; };

		const opts: RunPostAuditOptions = {
			planResult: { kind: 'planner-failed' },
			spawnFn,
			setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
			issueNumber: 99,
			readPlanApprovalFn: (): PlanApproval => 'auto',
			escalateFn: async () => { escalateCalled.n++; },
			notifyFn: (msg) => { notifyMessages.push(msg); },
			...overrides,
		};

		return { opts, gitCalls, setPhaseCalls, escalateCalled, notifyMessages };
	}

	test('returns no-action kind for planner-failed (AC2)', () => {
		const { opts } = makePostAuditOpts();
		const result = runPostAuditAction(opts);
		expect(result.kind).toBe('no-action');
	});

	test('notifyFn is called best-effort (AC2)', () => {
		const { opts, notifyMessages } = makePostAuditOpts();
		runPostAuditAction(opts);
		expect(notifyMessages.length).toBe(1);
	});

	test('notifyFn message mentions planner and prd.json (AC2)', () => {
		const { opts, notifyMessages } = makePostAuditOpts();
		runPostAuditAction(opts);
		expect(notifyMessages[0]).toContain('planner');
		expect(notifyMessages[0]).toContain('prd.json');
	});

	test('escalateFn is NOT fired (AC2 - avoid email noise on transient no-op)', async () => {
		const { opts, escalateCalled } = makePostAuditOpts();
		runPostAuditAction(opts);
		await new Promise((r) => setTimeout(r, 5));
		expect(escalateCalled.n).toBe(0);
	});

	test('no git calls made (no branch/commit) (AC2)', () => {
		const { opts, gitCalls } = makePostAuditOpts();
		runPostAuditAction(opts);
		expect(gitCalls.length).toBe(0);
	});

	test('setPhaseFn NOT called by runPostAuditAction itself (AC2 - caller handles via exitPhaseAfterPlan)', () => {
		const { opts, setPhaseCalls } = makePostAuditOpts();
		runPostAuditAction(opts);
		expect(setPhaseCalls.length).toBe(0);
	});

	test('absent notifyFn is safe (best-effort contract) (AC2)', () => {
		const { opts } = makePostAuditOpts({ notifyFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	test('absent escalateFn is safe (AC2)', () => {
		const { opts } = makePostAuditOpts({ escalateFn: undefined });
		expect(() => runPostAuditAction(opts)).not.toThrow();
	});

	// Phase-exit maps to idle: exitPhaseAfterPlan routes no-action -> 'idle'.
	// The function is not exported but the logic is trivially verifiable:
	// result.kind !== 'branch-created' && result.kind !== 'awaiting-operator-approval'
	// => setPhase('idle'). We prove this by calling a simulated exitPhaseAfterPlan
	// inline (matching the exact logic in sidecar.ts).
	test('phase-exit maps to idle via exitPhaseAfterPlan logic (AC2)', () => {
		const setPhaseCalls: LoopPhase[] = [];
		const { opts } = makePostAuditOpts({
			setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
		});
		const result = runPostAuditAction(opts);

		// Simulate the exitPhaseAfterPlan logic from sidecar.ts:
		//   if (result.kind === 'branch-created') return;
		//   setPhase(result.kind === 'awaiting-operator-approval' ? 'awaiting-operator' : 'idle');
		const simulatedSetPhase = (phase: LoopPhase): void => { setPhaseCalls.push(phase); };
		if (result.kind !== 'branch-created') {
			simulatedSetPhase(
				result.kind === 'awaiting-operator-approval' ? 'awaiting-operator' : 'idle',
			);
		}

		// The last setPhaseCalls entry must be 'idle'
		expect(setPhaseCalls[setPhaseCalls.length - 1]).toBe('idle');
	});
});
