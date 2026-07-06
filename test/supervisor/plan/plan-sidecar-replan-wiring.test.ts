// test/supervisor/plan/plan-sidecar-replan-wiring.test.ts
//
// Production wiring oracle for US-004 (CAM-204): wire the re-plan loop, pane
// teardown, and durable escalation into the sidecar.
//
// Unit tests injecting options.runPlanPhaseFn directly into runSidecarLoop
// (as loop.test.ts / plan-phase-crash-safety.test.ts do) cannot detect a
// missing/incorrect wiring of runPlanPhaseWithReplan + the real
// teardownPlanPanesFn / writeEscalationMarkerFn / removeEscalationMarkerFn
// seams inside makeProductionPlanPhaseFn / runPostPlanActions in
// src/commands/sidecar.ts (those closures are not exported: tests inject
// options.runPlanPhaseFn directly, per the established pattern for
// buildPlanContainerOpts / makePlanPaneHelpers). A source-text oracle catches
// wiring regressions independently, mirroring the precedent in
// plan-runner-postaudit.test.ts ("production wiring oracle (US-R1-001)") and
// plan-phase-crash-safety.test.ts (AC1 source-text oracle).
//
// Coverage:
//   AC1. makeProductionPlanPhaseFn calls runPlanPhaseWithReplan (not bare
//        runPlanPhase), wiring a real teardownPlanPanesFn (kill-pane, fresh
//        marker read, never respawn-pane -k) and a real writeEscalationMarkerFn
//        targeting the .claude/ dir via writePlanEscalatedMarker.
//   AC3. The teardown helper uses 'kill-pane' (never 'respawn-pane') so the
//        pane-count mutex returns to 'available' on all three production
//        paths (approve, each re-plan boundary, escalate) -- those three call
//        sites live inside runPlanPhaseWithReplan itself (US-003), which this
//        wiring now drives for real.
//   AC4. runPostPlanActions wires removeEscalationMarkerFn to
//        removePlanEscalatedMarker so a converging run clears any stale
//        BLOCK marker.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sidecarPath = resolve(import.meta.dir, '..', '..', '..', 'src', 'commands', 'sidecar.ts');
const source = readFileSync(sidecarPath, 'utf8');

describe('sidecar.ts production wiring oracle - re-plan loop + teardown + escalation (US-004, CAM-204)', () => {
	// -------------------------------------------------------------------------
	// AC1: runPlanPhaseWithReplan wiring (replaces bare runPlanPhase)
	// -------------------------------------------------------------------------

	test('sidecar.ts imports runPlanPhaseWithReplan from plan-runner.ts', () => {
		expect(source).toContain('runPlanPhaseWithReplan');
		expect(source).toContain("from '../supervisor/plan-runner.ts'");
	});

	test('sidecar.ts does NOT import the bare runPlanPhase symbol', () => {
		const importLine = source.split('\n').find((l) => l.includes("from '../supervisor/plan-runner.ts'"));
		expect(importLine).toBeDefined();
		// Guard against a bare `runPlanPhase` re-appearing alongside
		// runPlanPhaseWithReplan in the import specifier list.
		expect(importLine ?? '').not.toMatch(/[^.]\brunPlanPhase\b(?!WithReplan)/);
	});

	test('makeProductionPlanPhaseFn calls runProductionPlanPhaseWithReplan', () => {
		// Extracted (biome 80-line limit) into runProductionPlanPhaseWithReplan,
		// which itself calls runPlanPhaseWithReplan.
		const fnMatch = source.match(/function makeProductionPlanPhaseFn[\s\S]*?\n\}/);
		expect(fnMatch).not.toBeNull();
		expect(fnMatch?.[0]).toContain('runProductionPlanPhaseWithReplan({');
	});

	test('runProductionPlanPhaseWithReplan calls runPlanPhaseWithReplan', () => {
		const fnMatch = source.match(/function runProductionPlanPhaseWithReplan[\s\S]*?\n\}/);
		expect(fnMatch).not.toBeNull();
		expect(fnMatch?.[0]).toContain('runPlanPhaseWithReplan({');
	});

	test('the runPlanPhaseWithReplan call wires teardownPlanPanesFn', () => {
		const callMatch = source.match(/runPlanPhaseWithReplan\(\{[\s\S]*?\n\t\}\);/);
		expect(callMatch).not.toBeNull();
		expect(callMatch?.[0]).toContain('teardownPlanPanesFn:');
	});

	test('the runPlanPhaseWithReplan call wires writeEscalationMarkerFn', () => {
		const callMatch = source.match(/runPlanPhaseWithReplan\(\{[\s\S]*?\n\t\}\);/);
		expect(callMatch).not.toBeNull();
		expect(callMatch?.[0]).toContain('writeEscalationMarkerFn:');
	});

	// -------------------------------------------------------------------------
	// AC1/AC3: real teardown helper -- kill-pane, fresh marker read, never
	// respawn-pane -k (mirrors host.ts:398 teardownWorkerPaneFn, CAM-188)
	// -------------------------------------------------------------------------

	test('makeTeardownPlanPanesFn is defined and used to build teardownPlanPanesFn', () => {
		expect(source).toContain('function makeTeardownPlanPanesFn(');
		expect(source).toContain('teardownPlanPanesFn: makeTeardownPlanPanesFn(claudeDir)');
	});

	test('makeTeardownPlanPanesFn reads the worker pane marker fresh on every call', () => {
		const fnMatch = source.match(/function makeTeardownPlanPanesFn[\s\S]*?\n\}/);
		expect(fnMatch).not.toBeNull();
		expect(fnMatch?.[0]).toContain('readWorkerPaneMarker(claudeDir)');
	});

	test('makeTeardownPlanPanesFn uses kill-pane, never respawn-pane', () => {
		const fnMatch = source.match(/function makeTeardownPlanPanesFn[\s\S]*?\n\}/);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain("'kill-pane'");
		expect(body).not.toContain('respawn-pane');
	});

	test('makeTeardownPlanPanesFn never throws (best-effort try/catch)', () => {
		const fnMatch = source.match(/function makeTeardownPlanPanesFn[\s\S]*?\n\}/);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain('try {');
		expect(body).toContain('catch {');
	});

	// -------------------------------------------------------------------------
	// AC1: real escalation-marker writer -- targets the .claude/ dir via
	// writePlanEscalatedMarker (US-002, CAM-204), stamping writtenAt itself.
	// -------------------------------------------------------------------------

	test('sidecar.ts imports writePlanEscalatedMarker, removePlanEscalatedMarker, PLAN_ESCALATED_FILENAME', () => {
		expect(source).toContain('writePlanEscalatedMarker');
		expect(source).toContain('removePlanEscalatedMarker');
		expect(source).toContain('PLAN_ESCALATED_FILENAME');
		expect(source).toContain("from '../supervisor/plan-escalation.ts'");
	});

	test('makeWriteEscalationMarkerFn is defined, targets claudeDir, and stamps writtenAt', () => {
		expect(source).toContain('function makeWriteEscalationMarkerFn(');
		const fnMatch = source.match(/function makeWriteEscalationMarkerFn[\s\S]*?\n\}/);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		expect(body).toContain('join(claudeDir, PLAN_ESCALATED_FILENAME)');
		expect(body).toContain('writtenAt:');
		expect(body).toContain('writePlanEscalatedMarker(');
	});

	test('writeEscalationMarkerFn is wired via makeWriteEscalationMarkerFn(claudeDir)', () => {
		expect(source).toContain('writeEscalationMarkerFn: makeWriteEscalationMarkerFn(claudeDir)');
	});

	// -------------------------------------------------------------------------
	// AC4: converging run removes any stale plan-escalation marker
	// -------------------------------------------------------------------------

	test('runPostPlanActions wires removeEscalationMarkerFn to removePlanEscalatedMarker', () => {
		const helperMatch = source.match(/function runPostPlanActions[\s\S]*?\n\}/);
		expect(helperMatch).not.toBeNull();
		const body = helperMatch?.[0] ?? '';
		expect(body).toContain('removeEscalationMarkerFn:');
		expect(body).toContain('removePlanEscalatedMarker(');
		expect(body).toContain('join(o.claudeDir, PLAN_ESCALATED_FILENAME)');
	});
});
