// test/plan-in-progress-conflict-sidecar.test.ts
//
// Unit + wiring tests for US-004 (CAM-241/153): in-progress-work conflict
// gate at plan start.
//
// Acceptance criteria proved:
//   AC2/AC3: runPostAuditAction on a planResult of { kind: 'in-progress-conflict' }
//        returns { kind: 'in-progress-conflict' } and calls NEITHER setPhaseFn
//        NOR notifyFn NOR escalateFn -- the gate write (detectInProgressConflictFn's
//        writer seam) already flipped the phase and pushed the notify BEFORE
//        runPlanPhase ever returned this kind.
//   AC3: exitPhaseAfterPlan (sidecar.ts) leaves the phase untouched for
//        'in-progress-conflict', mirroring 'branch-created' -- proved via a
//        source-text oracle (the function is not exported).
//   AC2: production wiring -- runProductionPlanPhaseWithReplan threads
//        detectInProgressConflictFn/writeInProgressConflictGateFn into its
//        runPlanPhaseWithReplan call; makeProductionGatePhaseFn's registry
//        resolves the 'in-progress-conflict' discriminator via
//        makeInProgressConflictResolver (never hard-coded).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	runPostAuditAction,
	type RunPostAuditOptions,
	type PlanPhaseResult,
} from '../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../src/supervisor/loop.ts';
import type { LoopPhase } from '../src/commands/status.ts';
import type { PlanApproval } from '../src/config/models.ts';

// ---------------------------------------------------------------------------
// AC2/AC3: runPostAuditAction leaves phase/notify/escalate untouched
// ---------------------------------------------------------------------------

describe('AC2/AC3: runPostAuditAction on in-progress-conflict', () => {
	test('returns { kind: "in-progress-conflict" } and calls neither setPhaseFn, notifyFn, nor escalateFn', () => {
		const setPhaseCalls: LoopPhase[] = [];
		const notifyMessages: string[] = [];
		const escalateCalled = { n: 0 };

		const spawnFn: SpawnFn = () => ({ stdout: '', exitCode: 0 });
		const planResult: PlanPhaseResult = { kind: 'in-progress-conflict' };

		const opts: RunPostAuditOptions = {
			planResult,
			spawnFn,
			setPhaseFn: (phase) => { setPhaseCalls.push(phase); },
			issueNumber: 153,
			readPlanApprovalFn: (): PlanApproval => 'auto',
			escalateFn: async () => { escalateCalled.n++; },
			notifyFn: (msg) => { notifyMessages.push(msg); },
		};

		const result = runPostAuditAction(opts);

		expect(result).toEqual({ kind: 'in-progress-conflict' });
		expect(setPhaseCalls).toEqual([]);
		expect(notifyMessages).toEqual([]);
		expect(escalateCalled.n).toBe(0);
	});

	test('still calls removePreflightFailedMarkerFn (best-effort GC applies to every non-preflight-failed kind)', () => {
		const removeCalled = { n: 0 };
		const opts: RunPostAuditOptions = {
			planResult: { kind: 'in-progress-conflict' },
			spawnFn: () => ({ stdout: '', exitCode: 0 }),
			setPhaseFn: () => {},
			issueNumber: 153,
			readPlanApprovalFn: (): PlanApproval => 'auto',
			removePreflightFailedMarkerFn: () => { removeCalled.n++; },
		};
		runPostAuditAction(opts);
		expect(removeCalled.n).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC3: source-text oracle -- exitPhaseAfterPlan skips the phase flip for
// 'in-progress-conflict' (mirrors 'branch-created')
// ---------------------------------------------------------------------------

describe('AC3: sidecar.ts source-text oracle -- exitPhaseAfterPlan guard', () => {
	const src = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	test('exitPhaseAfterPlan early-returns for both branch-created and in-progress-conflict', () => {
		const fnMatch = src.match(/function exitPhaseAfterPlan[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain("result.kind === 'branch-created'");
		expect(body).toContain("result.kind === 'in-progress-conflict'");
	});
});

// ---------------------------------------------------------------------------
// AC2: production wiring oracles
// ---------------------------------------------------------------------------

describe('AC2: production wiring -- detect/write threaded into runPlanPhaseWithReplan', () => {
	const src = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	test('runProductionPlanPhaseWithReplan wires detectInProgressConflictFn and writeInProgressConflictGateFn', () => {
		const fnMatch = src.match(/function runProductionPlanPhaseWithReplan[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain('detectInProgressConflictFn: makeDetectInProgressConflictFn(cwd, loopSpawnFn)');
		expect(body).toContain('writeInProgressConflictGateFn: makeWriteInProgressConflictGateFn(');
	});

	test("makeProductionGatePhaseFn's registry resolves 'in-progress-conflict' via makeInProgressConflictResolver (never hard-coded)", () => {
		const fnMatch = src.match(/function makeProductionGatePhaseFn[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain('GateResolutionRegistry');
		expect(body).toContain('[IN_PROGRESS_CONFLICT_GATE]: makeInProgressConflictResolver(');
		expect(body).toContain('pollAndResolveGate(filePath, registry, setPhase)');
	});
});
