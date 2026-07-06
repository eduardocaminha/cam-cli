// test/supervisor/plan/plan-replan.test.ts
//
// Unit tests for buildReplanPlannerTaskPrompt + MAX_REPLAN_ROUNDS
// (US-001, CAM-204).
//
// Coverage (AC1, AC2):
//   1. Names the exact issue id.
//   2. Forbids backlog re-selection.
//   3. Instructs writing the PRD to scripts/cam/prd.json.
//   4. Embeds each finding's description AND suggestion verbatim.
//   5. Findings without a suggestion render description-only (no 'undefined').
//   6. Multiple findings are all embedded.
//   7. Empty findings array produces a valid prompt (no crash, no 'undefined').
//   8. MAX_REPLAN_ROUNDS is exported and equals 2.

import { describe, expect, test } from 'bun:test';
import {
	buildReplanPlannerTaskPrompt,
	MAX_REPLAN_ROUNDS,
} from '../../../src/supervisor/plan-runner.ts';
import type { PlanVerdictFinding } from '../../../src/supervisor/plan-verdict-report.ts';

describe('buildReplanPlannerTaskPrompt', () => {
	test('names the exact issue id', () => {
		const prompt = buildReplanPlannerTaskPrompt('CAM-204', []);
		expect(prompt).toContain('CAM-204');
	});

	test('forbids backlog re-selection', () => {
		const prompt = buildReplanPlannerTaskPrompt('CAM-204', []);
		expect(prompt).toContain('Do not re-select from the backlog');
	});

	test('instructs writing the PRD to scripts/cam/prd.json', () => {
		const prompt = buildReplanPlannerTaskPrompt('CAM-204', []);
		expect(prompt).toContain('scripts/cam/prd.json');
	});

	test('embeds a finding description and suggestion verbatim', () => {
		const findings: PlanVerdictFinding[] = [
			{
				id: 'A.001',
				category: 'A.completeness',
				severity: 'critical',
				description: 'Missing acceptance criteria for US-002',
				suggestion: 'Add an oracle-backed AC for US-002',
			},
		];
		const prompt = buildReplanPlannerTaskPrompt('CAM-204', findings);
		expect(prompt).toContain('Missing acceptance criteria for US-002');
		expect(prompt).toContain('Add an oracle-backed AC for US-002');
	});

	test('finding without a suggestion renders description-only (no undefined text)', () => {
		const findings: PlanVerdictFinding[] = [
			{
				id: 'A.002',
				category: 'A.completeness',
				severity: 'important',
				description: 'Story notes are too sparse',
			},
		];
		const prompt = buildReplanPlannerTaskPrompt('CAM-204', findings);
		expect(prompt).toContain('Story notes are too sparse');
		expect(prompt).not.toContain('undefined');
	});

	test('embeds multiple findings, mixed suggestion presence', () => {
		const findings: PlanVerdictFinding[] = [
			{
				id: 'A.001',
				category: 'A.completeness',
				severity: 'critical',
				description: 'First finding description',
				suggestion: 'First finding suggestion',
			},
			{
				id: 'A.002',
				category: 'A.completeness',
				severity: 'important',
				description: 'Second finding description',
			},
		];
		const prompt = buildReplanPlannerTaskPrompt('CAM-204', findings);
		expect(prompt).toContain('First finding description');
		expect(prompt).toContain('First finding suggestion');
		expect(prompt).toContain('Second finding description');
		expect(prompt).not.toContain('undefined');
	});

	test('empty findings array produces a valid prompt with no undefined text', () => {
		const prompt = buildReplanPlannerTaskPrompt('CAM-204', []);
		expect(prompt).not.toContain('undefined');
		expect(prompt.length).toBeGreaterThan(0);
	});
});

describe('MAX_REPLAN_ROUNDS', () => {
	test('is exported and equals 2', () => {
		expect(MAX_REPLAN_ROUNDS).toBe(2);
	});
});
