// test/release/changelog.test.ts
//
// Unit tests for rollChangelog (src/release/changelog.ts).
//
// Verifies: heading roll, body preservation, fresh [Unreleased] insertion,
// and edge cases. The function is pure (no filesystem I/O), so no fakes needed.
//
// AC-1: export function rollChangelog exists.
// AC-2: body preserved under rolled version heading (no lines dropped).
// AC-3: pure -- takes strings, returns string (verified by design; no FS seams).
//
// US-004 (CAM-89).

import { describe, expect, test } from 'bun:test';
import { rollChangelog } from '../../src/release/changelog.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASIC_CHANGELOG = `# Changelog

All notable changes to cam-cli are documented here.

---

## [Unreleased]

### Added

- Supervisor verifies each worker pass landed on origin.

### Changed

- Retired the stop-hook loop driver.
`;

// ---------------------------------------------------------------------------
// Tests: heading roll
// ---------------------------------------------------------------------------

describe('rollChangelog - heading roll', () => {
	test('renames ## [Unreleased] to ## [X.Y.Z] - YYYY-MM-DD', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		expect(result).toContain('## [0.2.0] - 2026-06-26');
	});

	test('inserts a fresh empty ## [Unreleased] above the versioned heading', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		const unreleasedIdx = result.indexOf('## [Unreleased]');
		const versionedIdx = result.indexOf('## [0.2.0] - 2026-06-26');
		expect(unreleasedIdx).toBeGreaterThanOrEqual(0);
		expect(versionedIdx).toBeGreaterThan(unreleasedIdx);
	});

	test('exactly one ## [Unreleased] heading remains', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		const matches = [...result.matchAll(/## \[Unreleased\]/g)];
		expect(matches).toHaveLength(1);
	});

	test('date and version appear verbatim in the heading', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '1.0.0', '2030-12-31');
		expect(result).toContain('## [1.0.0] - 2030-12-31');
	});
});

// ---------------------------------------------------------------------------
// Tests: body preservation (AC-2)
// ---------------------------------------------------------------------------

describe('rollChangelog - body preservation', () => {
	test('preserves ### Added subsection under versioned heading', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		const versionedIdx = result.indexOf('## [0.2.0] - 2026-06-26');
		const addedIdx = result.indexOf('### Added');
		const bulletIdx = result.indexOf('- Supervisor verifies');
		// Added section and its bullet appear after the versioned heading
		expect(addedIdx).toBeGreaterThan(versionedIdx);
		expect(bulletIdx).toBeGreaterThan(addedIdx);
	});

	test('preserves ### Changed subsection under versioned heading', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		const versionedIdx = result.indexOf('## [0.2.0] - 2026-06-26');
		const changedIdx = result.indexOf('### Changed');
		const bulletIdx = result.indexOf('- Retired the stop-hook');
		expect(changedIdx).toBeGreaterThan(versionedIdx);
		expect(bulletIdx).toBeGreaterThan(changedIdx);
	});

	test('preserves content before ## [Unreleased] (header, separator)', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		expect(result).toContain('# Changelog');
		expect(result).toContain('---');
		expect(result.startsWith('# Changelog')).toBe(true);
	});

	test('no body lines are dropped', () => {
		const lines = BASIC_CHANGELOG.split('\n');
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		// Every non-empty, non-heading body line from the original must appear in the result
		for (const line of lines) {
			if (line.trim() === '' || line === '## [Unreleased]') continue;
			expect(result).toContain(line);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: edge cases
// ---------------------------------------------------------------------------

describe('rollChangelog - edge cases', () => {
	test('returns text unchanged when ## [Unreleased] is absent', () => {
		const noUnreleased = '# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- item\n';
		const result = rollChangelog(noUnreleased, '0.2.0', '2026-06-26');
		expect(result).toBe(noUnreleased);
	});

	test('works with empty body under [Unreleased]', () => {
		const emptyBody = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- old item\n';
		const result = rollChangelog(emptyBody, '0.2.0', '2026-06-26');
		expect(result).toContain('## [Unreleased]');
		expect(result).toContain('## [0.2.0] - 2026-06-26');
		// Prior versioned section preserved
		expect(result).toContain('## [0.1.0] - 2026-01-01');
		expect(result).toContain('- old item');
	});

	test('fresh [Unreleased] is empty (no subsection body between it and the versioned heading)', () => {
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26');
		// The text between ## [Unreleased] and ## [0.2.0] - 2026-06-26
		// should only be whitespace/newlines (no Added/Changed content)
		const unreleasedIdx = result.indexOf('## [Unreleased]');
		const versionedIdx = result.indexOf('## [0.2.0] - 2026-06-26');
		const between = result.slice(unreleasedIdx + '## [Unreleased]'.length, versionedIdx);
		expect(between.trim()).toBe('');
	});
});
