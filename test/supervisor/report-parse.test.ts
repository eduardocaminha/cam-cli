// test/supervisor/report-parse.test.ts
//
// Unit tests for src/supervisor/report-parse.ts (US-001).
//
// Coverage (per AC 2/3/4/7):
//   - parseWorkerReport: valid full report, valid partial (missing gates/notes),
//     missing/mistyped discriminator -> null, malformed nested gates -> null.
//   - parseReviewReport: valid full report, valid partial (missing
//     findings/artifactOfRecord), missing/mistyped discriminator -> null,
//     malformed nested findings entry -> null.
//   - Both parsers never throw, even on invalid JSON text.

import { describe, expect, test } from 'bun:test';
import { parseReviewReport, parseWorkerReport } from '../../src/supervisor/report-parse.ts';

// ---------------------------------------------------------------------------
// parseWorkerReport
// ---------------------------------------------------------------------------

describe('parseWorkerReport', () => {
	test('parses a valid full report', () => {
		const raw = JSON.stringify({
			outcome: 'DONE',
			story: 'US-003',
			gates: { typecheck: 'ok', tests: '42 pass / 0 fail' },
			notes: 'none',
		});
		expect(parseWorkerReport(raw)).toEqual({
			outcome: 'DONE',
			story: 'US-003',
			gates: { typecheck: 'ok', tests: '42 pass / 0 fail' },
			notes: 'none',
		});
	});

	test('parses a valid partial report (missing gates and notes)', () => {
		const raw = JSON.stringify({ outcome: 'DONE', story: 'US-003' });
		expect(parseWorkerReport(raw)).toEqual({ outcome: 'DONE', story: 'US-003' });
	});

	test('missing discriminator (no outcome) -> null', () => {
		const raw = JSON.stringify({ story: 'US-003' });
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('missing discriminator (no story) -> null', () => {
		const raw = JSON.stringify({ outcome: 'DONE' });
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('mistyped discriminator (outcome is a number) -> null', () => {
		const raw = JSON.stringify({ outcome: 1, story: 'US-003' });
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('malformed nested gates (typecheck not a string) -> null', () => {
		const raw = JSON.stringify({
			outcome: 'DONE',
			story: 'US-003',
			gates: { typecheck: 1, tests: '42 pass / 0 fail' },
		});
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('malformed nested gates (not an object) -> null', () => {
		const raw = JSON.stringify({ outcome: 'DONE', story: 'US-003', gates: 'ok' });
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('mistyped notes (not a string) -> null', () => {
		const raw = JSON.stringify({ outcome: 'DONE', story: 'US-003', notes: 42 });
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('parses a valid report with appliedPatternIds', () => {
		const raw = JSON.stringify({
			outcome: 'DONE',
			story: 'US-005',
			appliedPatternIds: ['abc123def456', 'deadbeef0001'],
		});
		expect(parseWorkerReport(raw)).toEqual({
			outcome: 'DONE',
			story: 'US-005',
			appliedPatternIds: ['abc123def456', 'deadbeef0001'],
		});
	});

	test('appliedPatternIds absent -> field omitted, still parses (backward compatible)', () => {
		const raw = JSON.stringify({ outcome: 'DONE', story: 'US-003' });
		const parsed = parseWorkerReport(raw);
		expect(parsed).toEqual({ outcome: 'DONE', story: 'US-003' });
		expect(parsed?.appliedPatternIds).toBeUndefined();
	});

	test('mistyped appliedPatternIds (not an array) -> null', () => {
		const raw = JSON.stringify({ outcome: 'DONE', story: 'US-003', appliedPatternIds: 'abc123' });
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('mistyped appliedPatternIds (array of non-strings) -> null', () => {
		const raw = JSON.stringify({ outcome: 'DONE', story: 'US-003', appliedPatternIds: [1, 2] });
		expect(parseWorkerReport(raw)).toBeNull();
	});

	test('invalid JSON text -> null, never throws', () => {
		expect(() => parseWorkerReport('{not json')).not.toThrow();
		expect(parseWorkerReport('{not json')).toBeNull();
	});

	test('top-level array -> null', () => {
		expect(parseWorkerReport('[]')).toBeNull();
	});

	test('top-level null -> null', () => {
		expect(parseWorkerReport('null')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseReviewReport
// ---------------------------------------------------------------------------

describe('parseReviewReport', () => {
	test('parses a valid full report', () => {
		const raw = JSON.stringify({
			verdict: 'FIXES_PENDING:1',
			findings: [{ severity: 'CRITICAL', text: 'missing guard', file: 'src/x.ts', line: 12 }],
			artifactOfRecord: 'scripts/cam/review-capture.txt',
		});
		expect(parseReviewReport(raw)).toEqual({
			verdict: 'FIXES_PENDING:1',
			findings: [{ severity: 'CRITICAL', text: 'missing guard', file: 'src/x.ts', line: 12 }],
			artifactOfRecord: 'scripts/cam/review-capture.txt',
		});
	});

	test('parses a valid partial report (missing findings and artifactOfRecord)', () => {
		const raw = JSON.stringify({ verdict: 'CLEAN' });
		expect(parseReviewReport(raw)).toEqual({ verdict: 'CLEAN', findings: [] });
	});

	test('missing discriminator (no verdict) -> null', () => {
		const raw = JSON.stringify({ findings: [] });
		expect(parseReviewReport(raw)).toBeNull();
	});

	test('mistyped discriminator (verdict is a number) -> null', () => {
		const raw = JSON.stringify({ verdict: 1 });
		expect(parseReviewReport(raw)).toBeNull();
	});

	test('malformed nested findings entry (missing text) -> null', () => {
		const raw = JSON.stringify({ verdict: 'FIXES_PENDING:1', findings: [{ severity: 'WARNING' }] });
		expect(parseReviewReport(raw)).toBeNull();
	});

	test('malformed nested findings entry (line not a number) -> null', () => {
		const raw = JSON.stringify({
			verdict: 'FIXES_PENDING:1',
			findings: [{ severity: 'WARNING', text: 'x', line: '12' }],
		});
		expect(parseReviewReport(raw)).toBeNull();
	});

	test('findings not an array -> null', () => {
		const raw = JSON.stringify({ verdict: 'CLEAN', findings: 'none' });
		expect(parseReviewReport(raw)).toBeNull();
	});

	test('mistyped artifactOfRecord (not a string) -> null', () => {
		const raw = JSON.stringify({ verdict: 'CLEAN', artifactOfRecord: 42 });
		expect(parseReviewReport(raw)).toBeNull();
	});

	test('invalid JSON text -> null, never throws', () => {
		expect(() => parseReviewReport('{not json')).not.toThrow();
		expect(parseReviewReport('{not json')).toBeNull();
	});
});
