// test/suggestion-followups.test.ts
//
// Tests for src/supervisor/suggestion-followups.ts (US-002, CAM-189 PRD).
//
// Coverage (acceptance criteria):
//   AC1: fingerprintFinding is stable, and distinct-location / distinct-text
//        findings never collide, including missing-file and missing-line cases.
//   AC2: buildFollowUpIssue produces a truncated title, a description with the
//        full text, provenance (source/round/file:line), and a fingerprint line.
//   AC3: dedupSuggestions skips a SUGGESTION whose fingerprint already appears
//        in an open issue's description, and collapses in-batch duplicates.
//   AC4: extractSuggestions filters out CRITICAL and WARNING severities.

import { describe, expect, test } from 'bun:test';
import {
	fingerprintFinding,
	buildFollowUpIssue,
	extractSuggestions,
	dedupSuggestions,
} from '../src/supervisor/suggestion-followups.ts';
import type { ReviewFinding, ReviewReport } from '../src/supervisor/review-report.ts';
import type { IssueEntry } from '../src/issues/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
	return {
		severity: 'SUGGESTION',
		text: 'Consider extracting this helper.',
		...overrides,
	};
}

function makeIssueEntry(overrides: Partial<IssueEntry> = {}): IssueEntry {
	return {
		id: 'CAM-9999',
		title: 'Some idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-07-08T00:00:00Z',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// fingerprintFinding
// ---------------------------------------------------------------------------

describe('fingerprintFinding', () => {
	test('is deterministic for the same finding', () => {
		const finding = makeFinding({ file: 'src/a.ts', line: 10 });
		expect(fingerprintFinding(finding)).toBe(fingerprintFinding(finding));
	});

	test('returns a lowercase hex string', () => {
		const finding = makeFinding();
		expect(fingerprintFinding(finding)).toMatch(/^[0-9a-f]+$/);
	});

	test('same text, different file -> different fingerprint', () => {
		const a = makeFinding({ file: 'src/a.ts', line: 10 });
		const b = makeFinding({ file: 'src/b.ts', line: 10 });
		expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
	});

	test('same text, different line -> different fingerprint', () => {
		const a = makeFinding({ file: 'src/a.ts', line: 10 });
		const b = makeFinding({ file: 'src/a.ts', line: 20 });
		expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
	});

	test('missing file does not collide across distinct texts', () => {
		const a = makeFinding({ file: undefined, text: 'Text A' });
		const b = makeFinding({ file: undefined, text: 'Text B' });
		expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
	});

	test('missing line does not collide across distinct texts', () => {
		const a = makeFinding({ file: 'src/a.ts', line: undefined, text: 'Text A' });
		const b = makeFinding({ file: 'src/a.ts', line: undefined, text: 'Text B' });
		expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
	});

	test('same-text-different-location: identical text, one has file+line, one has neither', () => {
		const withLocation = makeFinding({ file: 'src/a.ts', line: 5, text: 'Same text' });
		const withoutLocation = makeFinding({ file: undefined, line: undefined, text: 'Same text' });
		expect(fingerprintFinding(withLocation)).not.toBe(fingerprintFinding(withoutLocation));
	});
});

// ---------------------------------------------------------------------------
// buildFollowUpIssue
// ---------------------------------------------------------------------------

describe('buildFollowUpIssue', () => {
	test('title equals the finding text when short enough', () => {
		const finding = makeFinding({ text: 'Short suggestion.' });
		const { title } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(title).toBe('Short suggestion.');
	});

	test('title is truncated with an ellipsis when the finding text is long', () => {
		const longText = 'x'.repeat(200);
		const finding = makeFinding({ text: longText });
		const { title } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(title.length).toBeLessThan(longText.length);
		expect(title.endsWith('…')).toBe(true);
	});

	test('description contains the full finding text', () => {
		const finding = makeFinding({ text: 'Full finding text goes here.' });
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(description).toContain('Full finding text goes here.');
	});

	test('description contains the source branch or cycle id', () => {
		const finding = makeFinding();
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(description).toContain('Source: cam/pr-189-suggestion-followups');
	});

	test('description contains the review round when provided', () => {
		const finding = makeFinding();
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups', round: 2 });
		expect(description).toContain('Review round: 2');
	});

	test('description omits a round line when round is not provided', () => {
		const finding = makeFinding();
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(description).not.toContain('Review round:');
	});

	test('description contains file:line when both are present', () => {
		const finding = makeFinding({ file: 'src/foo.ts', line: 42 });
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(description).toContain('Location: src/foo.ts:42');
	});

	test('description contains just the file when line is absent', () => {
		const finding = makeFinding({ file: 'src/foo.ts', line: undefined });
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(description).toContain('Location: src/foo.ts');
		expect(description).not.toContain('src/foo.ts:');
	});

	test('description omits a Location line when file is absent', () => {
		const finding = makeFinding({ file: undefined, line: undefined });
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(description).not.toContain('Location:');
	});

	test('description embeds a suggestion-fingerprint line matching fingerprintFinding', () => {
		const finding = makeFinding({ file: 'src/foo.ts', line: 42 });
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		expect(description).toContain(`suggestion-fingerprint: ${fingerprintFinding(finding)}`);
	});
});

// ---------------------------------------------------------------------------
// extractSuggestions
// ---------------------------------------------------------------------------

describe('extractSuggestions', () => {
	test('filters out CRITICAL and WARNING, keeps SUGGESTION', () => {
		const report: ReviewReport = {
			verdict: 'CLEAN',
			findings: [
				makeFinding({ severity: 'CRITICAL', text: 'blocking issue' }),
				makeFinding({ severity: 'WARNING', text: 'warning issue' }),
				makeFinding({ severity: 'SUGGESTION', text: 'nice to have' }),
			],
		};
		const result = extractSuggestions(report);
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toBe('nice to have');
	});

	test('returns an empty array when there are no findings', () => {
		const report: ReviewReport = { verdict: 'CLEAN', findings: [] };
		expect(extractSuggestions(report)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// dedupSuggestions
// ---------------------------------------------------------------------------

describe('dedupSuggestions', () => {
	test('AC fixture: 2 SUGGESTIONs, one already open, yields exactly 1 to-file', () => {
		const alreadyFiled = makeFinding({ text: 'Already filed suggestion', file: 'src/a.ts', line: 1 });
		const newOne = makeFinding({ text: 'Brand new suggestion', file: 'src/b.ts', line: 2 });

		const { description } = buildFollowUpIssue(alreadyFiled, { source: 'cam/pr-189-suggestion-followups' });
		const backlog: IssueEntry[] = [
			makeIssueEntry({ id: 'CAM-1', status: 'open', description }),
		];

		const report: ReviewReport = { verdict: 'CLEAN', findings: [alreadyFiled, newOne] };

		const toFile = dedupSuggestions(backlog, report);
		expect(toFile).toHaveLength(1);
		expect(toFile[0]?.text).toBe('Brand new suggestion');
	});

	test('collapses duplicates within the same report batch', () => {
		const finding = makeFinding({ text: 'Duplicate in-batch suggestion', file: 'src/a.ts', line: 1 });
		const sameFinding = makeFinding({ text: 'Duplicate in-batch suggestion', file: 'src/a.ts', line: 1 });
		const report: ReviewReport = { verdict: 'CLEAN', findings: [finding, sameFinding] };

		const toFile = dedupSuggestions([], report);
		expect(toFile).toHaveLength(1);
	});

	test('does not dedup against a non-open (abandoned) backlog entry', () => {
		const finding = makeFinding({ text: 'Reopened idea', file: 'src/a.ts', line: 1 });
		const { description } = buildFollowUpIssue(finding, { source: 'cam/pr-189-suggestion-followups' });
		const backlog: IssueEntry[] = [
			makeIssueEntry({ id: 'CAM-1', status: 'abandoned', description }),
		];
		const report: ReviewReport = { verdict: 'CLEAN', findings: [finding] };

		const toFile = dedupSuggestions(backlog, report);
		expect(toFile).toHaveLength(1);
	});

	test('ignores non-SUGGESTION severities entirely', () => {
		const report: ReviewReport = {
			verdict: 'CLEAN',
			findings: [makeFinding({ severity: 'CRITICAL', text: 'blocking issue' })],
		};
		expect(dedupSuggestions([], report)).toEqual([]);
	});

	test('tolerates backlog entries with no description', () => {
		const finding = makeFinding({ text: 'No crash please' });
		const backlog: IssueEntry[] = [makeIssueEntry({ id: 'CAM-1', status: 'open', description: undefined })];
		const report: ReviewReport = { verdict: 'CLEAN', findings: [finding] };

		const toFile = dedupSuggestions(backlog, report);
		expect(toFile).toHaveLength(1);
	});
});
