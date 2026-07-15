// test/supervisor/golden-sentinel.test.ts
//
// Golden-fixture replay tests (US-001, guards the supervisor-sentinel-parse-
// fragility class: CAM-32/35).
//
// Committed pane-text fixtures under test/fixtures/golden/ capture the
// RENDERED forms a real worker/reviewer pane can emit: markdown code
// span, **bold**, trailing punctuation, and a clean form for the
// CAM_IMPLEMENTER_STATUS sentinel, plus the <review>CLEAN</review> and
// <review>FIXES_PENDING:N</review> tag forms. Each fixture is replayed
// directly against the pure parsers (parseSentinel, parseAnySentinel,
// parseReviewVerdict) so a silent upstream render change fails this test
// instead of silently degrading a real pass.
//
// No live CLI invocation, no tmux: fixtures are read from disk and fed to
// the parsers as plain strings only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseAnySentinel, parseSentinel } from '../../src/supervisor/result.ts';
import { parseReviewVerdict } from '../../src/supervisor/review.ts';

const GOLDEN_DIR = join(import.meta.dir, '..', 'fixtures', 'golden');

function readFixture(name: string): string {
	return readFileSync(join(GOLDEN_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// parseSentinel
// ---------------------------------------------------------------------------

describe('parseSentinel (golden fixtures)', () => {
	test('clean form', () => {
		const parsed = parseSentinel(readFixture('sentinel-clean.txt'));
		expect(parsed).toEqual({ status: 'DONE', storyId: 'US-001', raw: 'CAM_IMPLEMENTER_STATUS=DONE story=US-001' });
	});

	test('markdown code span wrap', () => {
		const parsed = parseSentinel(readFixture('sentinel-codespan.txt'));
		expect(parsed).toEqual({ status: 'DONE', storyId: 'US-001', raw: 'CAM_IMPLEMENTER_STATUS=DONE story=US-001' });
	});

	test('**bold** wrap', () => {
		const parsed = parseSentinel(readFixture('sentinel-bold.txt'));
		expect(parsed).toEqual({ status: 'DONE', storyId: 'US-001', raw: 'CAM_IMPLEMENTER_STATUS=DONE story=US-001' });
	});

	test('trailing punctuation (CAM-35 contract: storyId is NOT polluted)', () => {
		const parsed = parseSentinel(readFixture('sentinel-trailing-punct.txt'));
		expect(parsed).not.toBeNull();
		expect(parsed?.storyId).toBe('US-001');
		expect(parsed?.storyId).not.toContain('.');
		expect(parsed?.storyId).not.toContain('`');
		expect(parsed).toEqual({ status: 'DONE', storyId: 'US-001', raw: 'CAM_IMPLEMENTER_STATUS=DONE story=US-001' });
	});
});

// ---------------------------------------------------------------------------
// parseAnySentinel
// ---------------------------------------------------------------------------

describe('parseAnySentinel (golden fixtures)', () => {
	test('clean sentinel form -> implementer source', () => {
		const match = parseAnySentinel(readFixture('sentinel-clean.txt'));
		expect(match?.source).toBe('implementer');
	});

	test('code-span sentinel form -> implementer source', () => {
		const match = parseAnySentinel(readFixture('sentinel-codespan.txt'));
		expect(match?.source).toBe('implementer');
	});

	test('bold sentinel form -> implementer source', () => {
		const match = parseAnySentinel(readFixture('sentinel-bold.txt'));
		expect(match?.source).toBe('implementer');
	});

	test('trailing-punctuation sentinel form -> implementer source', () => {
		const match = parseAnySentinel(readFixture('sentinel-trailing-punct.txt'));
		expect(match?.source).toBe('implementer');
	});

	test('<review>CLEAN</review> form -> review-tag source', () => {
		const match = parseAnySentinel(readFixture('review-clean.txt'));
		expect(match).toEqual({ source: 'review-tag', raw: '<review>CLEAN</review>' });
	});

	test('<review>FIXES_PENDING:N</review> form -> review-tag source', () => {
		const match = parseAnySentinel(readFixture('review-fixes-pending.txt'));
		expect(match).toEqual({ source: 'review-tag', raw: '<review>FIXES_PENDING:3</review>' });
	});
});

// ---------------------------------------------------------------------------
// parseReviewVerdict
// ---------------------------------------------------------------------------

describe('parseReviewVerdict (golden fixtures)', () => {
	test('<review>CLEAN</review> form', () => {
		const parsed = parseReviewVerdict(readFixture('review-clean.txt'));
		expect(parsed).toEqual({ verdict: 'CLEAN', findingsCount: 0, newStories: [] });
	});

	test('<review>FIXES_PENDING:N</review> form', () => {
		const parsed = parseReviewVerdict(readFixture('review-fixes-pending.txt'));
		expect(parsed).toEqual({ verdict: 'FIXES_PENDING', findingsCount: 3, newStories: [] });
	});
});
