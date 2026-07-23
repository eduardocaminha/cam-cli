// test/commands/sidecar.test.ts
//
// Tests for the production review-phase closure (US-004, CAM-403):
// makeProductionReviewPhaseFn, wired into the sidecar loop via
// buildReviewPhaseDeps / SidecarOptions.runReviewPhaseFn and dispatched from
// runSidecarLoop's phase:review branch (US-003, CAM-403; see
// test/supervisor/loop.test.ts's "review-phase dispatch" describe block for
// the loop-level dispatch/crash-survival coverage this file does not repeat).
//
// Coverage:
//   AC1: sidecar.ts source-text oracle -- makeProductionReviewPhaseFn wraps
//        its body in try/finally, ALWAYS resets phase to idle in the finally
//        block (even when reviewDispatch throws), and calls reviewDispatch
//        exactly once per invocation (drives exactly one round, one reviewer
//        verdict).
//   AC3: source-text oracle -- the reviewDispatch call is not wrapped in any
//        loop construct (while/for), so fix-story burn-down is NOT
//        auto-chained inside the closure: one phase:review tick equals one
//        round, then the finally block resets phase to idle for the
//        orchestrator to narrate and drive `cam next`.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AC1/AC3: sidecar.ts source-text oracle -- makeProductionReviewPhaseFn', () => {
	const sidecarSrc = readFileSync(resolve(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');

	const fnStart = sidecarSrc.indexOf('function makeProductionReviewPhaseFn(');
	const fnEnd = sidecarSrc.indexOf('\nfunction ', fnStart + 1);
	const fnBody = fnStart >= 0 ? sidecarSrc.slice(fnStart, fnEnd > 0 ? fnEnd : undefined) : '';

	test('makeProductionReviewPhaseFn exists', () => {
		expect(fnStart).toBeGreaterThan(-1);
	});

	test('wraps its body in try / finally', () => {
		expect(fnBody).toContain('try {');
		expect(fnBody).toContain('finally {');
	});

	test('ALWAYS resets phase to idle in the finally block (AC1: even when reviewDispatch throws)', () => {
		const finallyIdx = fnBody.indexOf('finally {');
		const finallyBlock = fnBody.slice(finallyIdx);
		expect(finallyBlock).toContain("setPhase('idle')");
	});

	test('catch block logs a sidecar-exit event with reason review-phase-crash', () => {
		expect(fnBody).toContain("'sidecar-exit'");
		expect(fnBody).toContain("'review-phase-crash'");
	});

	test('builds makeReviewDispatch and calls reviewDispatch exactly once per invocation (AC1: one round)', () => {
		const dispatchBuildCount = (fnBody.match(/makeReviewDispatch\(/g) ?? []).length;
		const dispatchCallCount = (fnBody.match(/reviewDispatch\(randomUUID\(\)\)/g) ?? []).length;
		expect(dispatchBuildCount).toBe(1);
		expect(dispatchCallCount).toBe(1);
	});

	test('the reviewDispatch call is not wrapped in a while/for loop (AC3: fix-story burn-down is not auto-chained)', () => {
		expect(fnBody).not.toMatch(/\bwhile\s*\(/);
		expect(fnBody).not.toMatch(/\bfor\s*\(/);
	});

	test('does not re-resolve the reviewer backend here (AC2: resolved inside makeReviewDispatch itself)', () => {
		expect(fnBody).not.toContain('readPhaseBackend(');
	});

	test('wires the structured review-report reader + clearer (US-002/US-R1-001 precedent)', () => {
		expect(fnBody).toContain('makeReadReviewReport(');
		expect(fnBody).toContain('makeClearReviewReport(');
	});
});
