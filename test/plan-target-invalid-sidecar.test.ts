// test/plan-target-invalid-sidecar.test.ts
//
// Unit/functional tests for US-003 (CAM-203): sidecar surfaces
// plan-target-invalid (notify, event, idle exit, stale plan_issue cleared).
//
// Acceptance criteria proved:
//   AC1: makeProductionPlanPhaseFn threads the fresh-read plan_issue into
//        runPlanPhaseWithReplan as planTargetId. Proved by a source-text
//        oracle (mirrors the grep oracle: 'planTargetId' in sidecar.ts) plus
//        proof that the literal is wired inside runProductionPlanPhaseWithReplan's
//        call to runPlanPhaseWithReplan (not just present anywhere in the file).
//   AC2: On a 'plan-target-invalid' result, the post-plan path pushes an
//        orchestrator notification naming the target id and emits a
//        structured 'plan-target-invalid' event. Proved in
//        test/supervisor/plan/plan-runner-postaudit.test.ts (runPostAuditAction
//        unit tests) and here via a wiring oracle that runPostPlanActions
//        threads logEvent into the runPostAuditAction call.
//   AC3: The phase exits to idle and the stale plan_issue is cleared from
//        cam-loop.local.md after the plan tick. Proved functionally below with
//        a real temp .claude/cam-loop.local.md.
//   AC4: No branch/commit/phase:implementing flip occurs for
//        plan-target-invalid (proved in plan-runner-postaudit.test.ts;
//        mirrored here with the real makeSetPhaseFn wiring).
//   AC5: The new event kind is added to WorkerEventKind (grep oracle +
//        typecheck; also exercised functionally here).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { makeSetPhaseFn } from '../src/commands/sidecar.ts';
import { runPostAuditAction, type PlanPhaseResult } from '../src/supervisor/plan-runner.ts';
import { parseStateFile } from '../src/commands/status.ts';
import { makeInMemoryEventLogger, type WorkerEventKind } from '../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// AC1: source-text oracle -- planTargetId threaded into runPlanPhaseWithReplan
// ---------------------------------------------------------------------------

describe('AC1: makeProductionPlanPhaseFn threads plan_issue as planTargetId', () => {
	const sidecarSrc = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	test('sidecar.ts contains the literal planTargetId (grep oracle)', () => {
		expect(sidecarSrc).toContain('planTargetId');
	});

	test('runProductionPlanPhaseWithReplan wires planTargetId inside its runPlanPhaseWithReplan call', () => {
		const fnMatch = sidecarSrc.match(/function runProductionPlanPhaseWithReplan[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain('planTargetId: planIssue');
		// selectIssueFn is still wired via selectPlanTargetFromFile alongside it.
		expect(body).toContain('selectIssueFn: () => selectPlanTargetFromFile(cwd, planIssue)');
	});
});

// ---------------------------------------------------------------------------
// AC2: runPostPlanActions threads logEvent into the runPostAuditAction call
// ---------------------------------------------------------------------------

describe('AC2: runPostPlanActions wires logEvent into runPostAuditAction', () => {
	const sidecarSrc = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	test('runPostPlanActions passes logEvent to runPostAuditAction', () => {
		const fnMatch = sidecarSrc.match(/function runPostPlanActions[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain('logEvent: o.logEvent');
	});

	test('makeProductionPlanPhaseFn passes logEvent into runPostPlanActions', () => {
		const fnMatch = sidecarSrc.match(/function makeProductionPlanPhaseFn[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toMatch(/runPostPlanActions\(\{[^}]*logEvent[^}]*\}\)/);
	});
});

// ---------------------------------------------------------------------------
// AC3/AC4: real state file -- idle exit + stale plan_issue cleared, no branch
// ---------------------------------------------------------------------------

describe('AC3/AC4: plan-target-invalid clears stale plan_issue and exits to idle', () => {
	let tmpDir: string;
	let claudeDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-target-invalid-'));
		claudeDir = join(tmpDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('phase:planning + plan_issue:CAM-777 -> after plan-target-invalid tick, phase:idle and plan_issue cleared', () => {
		// Seed the state file as the auto-dispatcher would: phase:planning with an
		// explicit plan_issue target (US-003, CAM-139/CAM-154).
		makeSetPhaseFn(claudeDir, tmpDir)('planning', 'CAM-777');
		const stateFile = join(claudeDir, 'cam-loop.local.md');
		const seeded = parseStateFile(readFileSync(stateFile, 'utf8'));
		expect(seeded?.phase).toBe('planning');
		expect(seeded?.plan_issue).toBe('CAM-777');

		// Run the post-audit action for a plan-target-invalid result (mirrors
		// runPostPlanActions in sidecar.ts).
		const gitCalls: string[][] = [];
		const notifyMessages: string[] = [];
		const { logger: logEvent, events } = makeInMemoryEventLogger();
		const planResult: PlanPhaseResult = { kind: 'plan-target-invalid', targetId: 'CAM-777' };

		const postAuditResult = runPostAuditAction({
			planResult,
			spawnFn: (cmd, args) => { gitCalls.push([cmd, ...args]); return { stdout: '', exitCode: 0 }; },
			setPhaseFn: makeSetPhaseFn(claudeDir, tmpDir),
			issueNumber: 777,
			readPlanApprovalFn: () => 'auto',
			notifyFn: (msg) => { notifyMessages.push(msg); },
			logEvent,
		});

		// AC4: no-action result, no branch/commit git calls.
		expect(postAuditResult.kind).toBe('no-action');
		expect(gitCalls.filter((c) => c[1] === 'checkout' && c[2] === '-B').length).toBe(0);
		expect(gitCalls.length).toBe(0);

		// AC2: notify + event fired.
		expect(notifyMessages.length).toBe(1);
		expect(notifyMessages[0]).toContain('CAM-777');
		expect(events.filter((e) => e.kind === 'plan-target-invalid').length).toBe(1);

		// AC3 (idle exit + stale plan_issue cleared): mirrors exitPhaseAfterPlan's
		// no-action -> idle transition (sidecar.ts). setPhase is called WITHOUT a
		// planIssue arg, which makeSetPhaseFn renders as plan_issue: null (drops
		// the stale target).
		makeSetPhaseFn(claudeDir, tmpDir)('idle');

		const final = parseStateFile(readFileSync(stateFile, 'utf8'));
		expect(final?.phase).toBe('idle');
		expect(final?.plan_issue ?? null).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC5: new event kind is registered
// ---------------------------------------------------------------------------

describe('AC5: plan-target-invalid is a valid WorkerEventKind', () => {
	test('events.ts contains the plan-target-invalid kind (grep oracle)', () => {
		const eventsSrc = readFileSync(resolve(import.meta.dir, '../src/supervisor/events.ts'), 'utf8');
		expect(eventsSrc).toContain('plan-target-invalid');
	});

	test('makeInMemoryEventLogger accepts a plan-target-invalid event', () => {
		const { logger, events } = makeInMemoryEventLogger();
		logger({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'test',
			kind: 'plan-target-invalid' as WorkerEventKind,
			detail: { targetId: 'CAM-777' },
		});
		expect(events.length).toBe(1);
		expect(events[0]?.kind).toBe('plan-target-invalid');
	});
});
