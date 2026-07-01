// test/supervisor/plan/plan-verdict-report.test.ts
//
// Unit tests for src/supervisor/plan-verdict-report.ts (US-001, CAM-117 Half A).
//
// Coverage:
//   1. PLAN_VERDICT_REPORT_FILENAME is the expected path.
//   2. makeReadPlanVerdict returns null when the file is absent.
//   3. makeReadPlanVerdict returns null on malformed JSON (parse error).
//   4. makeReadPlanVerdict returns null for a top-level JSON array.
//   5. makeReadPlanVerdict returns null for an object with a missing verdict.
//   6. makeReadPlanVerdict returns null for an object with a wrong verdict string.
//   7. makeReadPlanVerdict returns the parsed report for verdict === 'APPROVE'.
//   8. makeReadPlanVerdict returns the parsed report for verdict === 'BLOCK'.
//   9. makeReadPlanVerdict includes full PlanVerdictFinding fields when present.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	PLAN_VERDICT_REPORT_FILENAME,
	makeReadPlanVerdict,
	type PlanVerdictFinding,
	type PlanVerdictReport,
} from '../../../src/supervisor/plan-verdict-report.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('PLAN_VERDICT_REPORT_FILENAME', () => {
	test("is 'scripts/cam/plan-verdict-report.json'", () => {
		expect(PLAN_VERDICT_REPORT_FILENAME).toBe('scripts/cam/plan-verdict-report.json');
	});
});

// ---------------------------------------------------------------------------
// makeReadPlanVerdict — file-based tests using a tmpdir
// ---------------------------------------------------------------------------

describe('makeReadPlanVerdict', () => {
	let tmpDir: string;
	let reportPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-verdict-test-'));
		// Ensure the subdirectory structure mirrors the real path
		const subDir = join(tmpDir, 'scripts', 'cam');
		mkdirSync(subDir, { recursive: true });
		reportPath = join(tmpDir, PLAN_VERDICT_REPORT_FILENAME);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns null when file does not exist', () => {
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null on malformed JSON', () => {
		writeFileSync(reportPath, 'not valid json {{{');
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null for a top-level JSON array', () => {
		writeFileSync(reportPath, JSON.stringify([{ verdict: 'APPROVE' }]));
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null when verdict field is missing', () => {
		writeFileSync(reportPath, JSON.stringify({ summary: 'ok', findings: [] }));
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null when verdict is an unrecognized string', () => {
		writeFileSync(
			reportPath,
			JSON.stringify({ verdict: 'APPROVE_MAYBE', summary: 'ok', findings: [] }),
		);
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null when verdict is a boolean (wrong type)', () => {
		writeFileSync(reportPath, JSON.stringify({ verdict: true, summary: 'ok', findings: [] }));
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()).toBeNull();
	});

	test('returns null when verdict is null', () => {
		writeFileSync(reportPath, JSON.stringify({ verdict: null, summary: 'ok', findings: [] }));
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()).toBeNull();
	});

	test("returns parsed report for verdict === 'APPROVE'", () => {
		const report: PlanVerdictReport = {
			verdict: 'APPROVE',
			summary: 'PRD looks good.',
			findings: [],
		};
		writeFileSync(reportPath, JSON.stringify(report));
		const read = makeReadPlanVerdict(tmpDir);
		const result = read();
		expect(result).not.toBeNull();
		expect(result?.verdict).toBe('APPROVE');
		expect(result?.summary).toBe('PRD looks good.');
		expect(result?.findings).toHaveLength(0);
	});

	test("returns parsed report for verdict === 'BLOCK'", () => {
		const finding: PlanVerdictFinding = {
			id: 'A.completeness-001',
			category: 'A.completeness',
			severity: 'critical',
			storyId: 'US-003',
			description: 'Acceptance criteria are missing an oracle.',
			suggestion: 'Add a grep oracle for the constant.',
		};
		const report: PlanVerdictReport = {
			verdict: 'BLOCK',
			summary: 'Critical finding prevents merge.',
			findings: [finding],
		};
		writeFileSync(reportPath, JSON.stringify(report));
		const read = makeReadPlanVerdict(tmpDir);
		const result = read();
		expect(result).not.toBeNull();
		expect(result?.verdict).toBe('BLOCK');
		expect(result?.summary).toBe('Critical finding prevents merge.');
		expect(result?.findings).toHaveLength(1);
	});

	test('preserves all PlanVerdictFinding fields (id, category, severity, storyId, description, suggestion)', () => {
		const finding: PlanVerdictFinding = {
			id: 'B.atomicity-002',
			category: 'B.atomicity',
			severity: 'important',
			storyId: 'US-007',
			description: 'Story mixes two concerns.',
			suggestion: 'Split into two stories.',
		};
		const report: PlanVerdictReport = {
			verdict: 'BLOCK',
			summary: 'Important finding.',
			findings: [finding],
		};
		writeFileSync(reportPath, JSON.stringify(report));
		const read = makeReadPlanVerdict(tmpDir);
		const result = read();
		const f = result?.findings[0];
		expect(f?.id).toBe('B.atomicity-002');
		expect(f?.category).toBe('B.atomicity');
		expect(f?.severity).toBe('important');
		expect(f?.storyId).toBe('US-007');
		expect(f?.description).toBe('Story mixes two concerns.');
		expect(f?.suggestion).toBe('Split into two stories.');
	});

	test('finding description field is `description`, not `text`', () => {
		// Regression guard: the auditor schema uses `description`, not `text`.
		// A wrong field name would yield undefined at runtime (F-01 from story notes).
		const finding: PlanVerdictFinding = {
			id: 'F.domain-001',
			category: 'F.domain',
			severity: 'suggestion',
			description: 'Minor domain terminology mismatch.',
		};
		expect(finding).toHaveProperty('description');
		expect(finding).not.toHaveProperty('text');
	});

	test('optional fields (storyId, suggestion, metrics) are absent when not provided', () => {
		const report: PlanVerdictReport = {
			verdict: 'APPROVE',
			summary: 'No issues.',
			findings: [
				{
					id: 'C.acceptance-001',
					category: 'C.acceptance',
					severity: 'suggestion',
					description: 'Minor wording.',
					// storyId and suggestion intentionally omitted
				},
			],
		};
		writeFileSync(reportPath, JSON.stringify(report));
		const read = makeReadPlanVerdict(tmpDir);
		const result = read();
		expect(result?.findings[0]?.storyId).toBeUndefined();
		expect(result?.findings[0]?.suggestion).toBeUndefined();
		expect(result?.metrics).toBeUndefined();
	});

	test('preserves optional metrics field when present', () => {
		const report = {
			verdict: 'APPROVE' as const,
			summary: 'All good.',
			findings: [],
			metrics: { critical: 0, important: 0, suggestion: 1 },
		};
		writeFileSync(reportPath, JSON.stringify(report));
		const read = makeReadPlanVerdict(tmpDir);
		const result = read();
		expect(result?.metrics).toEqual({ critical: 0, important: 0, suggestion: 1 });
	});

	test('reader is a stable closure: second call re-reads the file', () => {
		// Writes APPROVE first, then updates to BLOCK; the reader must re-read on each call.
		const reportApprove: PlanVerdictReport = {
			verdict: 'APPROVE',
			summary: 'First read.',
			findings: [],
		};
		writeFileSync(reportPath, JSON.stringify(reportApprove));
		const read = makeReadPlanVerdict(tmpDir);
		expect(read()?.verdict).toBe('APPROVE');

		const reportBlock: PlanVerdictReport = {
			verdict: 'BLOCK',
			summary: 'Second read.',
			findings: [],
		};
		writeFileSync(reportPath, JSON.stringify(reportBlock));
		expect(read()?.verdict).toBe('BLOCK');
	});
});
