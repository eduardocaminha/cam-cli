// test/release/changelog.test.ts
//
// Unit tests for rollChangelog and generateReleaseBody (src/release/changelog.ts).
//
// Verifies: heading roll, body preservation, fresh [Unreleased] insertion,
// generated-body routing (feat->Added, fix->Fixed), exclusions, empty-subsection
// omission, and edge cases. Both functions are pure (no filesystem I/O).
//
// US-004 (CAM-89): rollChangelog -- heading roll, body preservation.
// US-006 (CAM-89): generateReleaseBody -- AC-1, AC-2, AC-3.
//
// US-004 (CAM-89), US-006 (CAM-89).

import { describe, expect, test } from 'bun:test';
import { generateReleaseBody, rollChangelog } from '../../src/release/changelog.ts';

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
// Tests: line-anchored heading match (US-001, CAM-98)
// ---------------------------------------------------------------------------

// Mirrors the shape of the live 0.2.0-era corruption: the intro prose
// mentions the literal, backtick-quoted `## [Unreleased]` text (as part of a
// format description) BEFORE the real full-line heading appears further down.
const PROSE_MENTIONS_HEADING_CHANGELOG = `# Changelog

All notable changes to cam-cli are documented here.

Format: \`## [X.Y.Z] - YYYY-MM-DD\` for releases; \`## [Unreleased]\` for pending work.

---

## [Unreleased]

### Added

- Real pending change.
`;

describe('rollChangelog - line-anchored heading match (US-001)', () => {
	test('prose mention of `## [Unreleased]` before the real heading is left byte-identical', () => {
		const result = rollChangelog(PROSE_MENTIONS_HEADING_CHANGELOG, '0.2.0', '2026-06-26');
		const proseLine = 'Format: `## [X.Y.Z] - YYYY-MM-DD` for releases; `## [Unreleased]` for pending work.';
		expect(result).toContain(proseLine);
	});

	test('the real heading (further down) is the one that gets rolled', () => {
		const result = rollChangelog(PROSE_MENTIONS_HEADING_CHANGELOG, '0.2.0', '2026-06-26');
		expect(result).toContain('## [0.2.0] - 2026-06-26');
		expect(result).toContain('- Real pending change.');
	});

	test('regression: reproduces the live 0.2.0-era corruption shape -- exactly one full-line ## [Unreleased] heading survives', () => {
		const result = rollChangelog(PROSE_MENTIONS_HEADING_CHANGELOG, '0.2.0', '2026-06-26');
		const fullLineMatches = [...result.matchAll(/^## \[Unreleased\][ \t]*$/gm)];
		expect(fullLineMatches).toHaveLength(1);
	});

	test('a substring match inside prose with no real line-anchored heading is left unchanged', () => {
		const noRealHeading = '# Changelog\n\nSee `## [Unreleased]` in the format docs.\n\n## [0.1.0] - 2026-01-01\n\n- item\n';
		const result = rollChangelog(noRealHeading, '0.2.0', '2026-06-26');
		expect(result).toBe(noRealHeading);
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

// ---------------------------------------------------------------------------
// Tests: generateReleaseBody (AC-1, AC-2, AC-3 -- US-006)
// ---------------------------------------------------------------------------

describe('generateReleaseBody - routing (AC-1)', () => {
	test('feat: subject appears under ### Added', () => {
		const body = generateReleaseBody(['feat: add new command']);
		expect(body).toContain('### Added');
		expect(body).toContain('- add new command');
	});

	test('feat!: subject appears under ### Added', () => {
		const body = generateReleaseBody(['feat!: drop legacy flag']);
		expect(body).toContain('### Added');
		expect(body).toContain('- drop legacy flag');
	});

	test('feat(scope): subject appears under ### Added', () => {
		const body = generateReleaseBody(['feat(cli): add --json flag']);
		expect(body).toContain('### Added');
		expect(body).toContain('- add --json flag');
	});

	test('feat(scope)!: subject appears under ### Added', () => {
		const body = generateReleaseBody(['feat(api)!: rename endpoint']);
		expect(body).toContain('### Added');
		expect(body).toContain('- rename endpoint');
	});

	test('fix: subject appears under ### Fixed', () => {
		const body = generateReleaseBody(['fix: correct off-by-one']);
		expect(body).toContain('### Fixed');
		expect(body).toContain('- correct off-by-one');
	});

	test('fix!: subject appears under ### Fixed', () => {
		const body = generateReleaseBody(['fix!: breaking fix for crash']);
		expect(body).toContain('### Fixed');
		expect(body).toContain('- breaking fix for crash');
	});

	test('fix(scope): subject appears under ### Fixed', () => {
		const body = generateReleaseBody(['fix(ui): patch button color']);
		expect(body).toContain('### Fixed');
		expect(body).toContain('- patch button color');
	});

	test('multiple feat + fix subjects produce both subsections', () => {
		const body = generateReleaseBody([
			'feat: add alpha',
			'fix: correct beta',
			'feat(scope): add gamma',
		]);
		expect(body).toContain('### Added');
		expect(body).toContain('- add alpha');
		expect(body).toContain('- add gamma');
		expect(body).toContain('### Fixed');
		expect(body).toContain('- correct beta');
	});

	test('### Added appears before ### Fixed in output', () => {
		const body = generateReleaseBody(['fix: fix bug', 'feat: add thing']);
		const addedIdx = body.indexOf('### Added');
		const fixedIdx = body.indexOf('### Fixed');
		expect(addedIdx).toBeGreaterThanOrEqual(0);
		expect(fixedIdx).toBeGreaterThan(addedIdx);
	});

	test('prefix is stripped: bullet reads as prose (no type:scope: remnant)', () => {
		const body = generateReleaseBody(['feat(release): auto-generate changelog body']);
		expect(body).toContain('- auto-generate changelog body');
		expect(body).not.toContain('feat(release):');
	});
});

describe('generateReleaseBody - exclusions (AC-2)', () => {
	test('chore: subject is excluded', () => {
		const body = generateReleaseBody(['chore(cam): mark US-004 done']);
		expect(body).toBe('');
	});

	test('docs: subject is excluded', () => {
		const body = generateReleaseBody(['docs: update README']);
		expect(body).toBe('');
	});

	test('refactor: subject is excluded', () => {
		const body = generateReleaseBody(['refactor: extract helper']);
		expect(body).toBe('');
	});

	test('CAM-NN: free-text subject is excluded', () => {
		const body = generateReleaseBody(['CAM-89: write initial PRD']);
		expect(body).toBe('');
	});

	test('unrecognized free-text subject is excluded', () => {
		const body = generateReleaseBody(['Initial commit']);
		expect(body).toBe('');
	});

	test('mixed: only feat/fix subjects appear, chore excluded', () => {
		const body = generateReleaseBody([
			'chore(cam): mark done',
			'feat: add ship bump step',
			'docs: update README',
			'fix: correct version regex',
			'refactor: extract helper',
		]);
		expect(body).toContain('- add ship bump step');
		expect(body).toContain('- correct version regex');
		expect(body).not.toContain('chore');
		expect(body).not.toContain('docs');
		expect(body).not.toContain('refactor');
	});
});

describe('generateReleaseBody - empty subsection omission (AC-3)', () => {
	test('when no feat commits, ### Added is omitted', () => {
		const body = generateReleaseBody(['fix: fix the thing']);
		expect(body).not.toContain('### Added');
		expect(body).toContain('### Fixed');
	});

	test('when no fix commits, ### Fixed is omitted', () => {
		const body = generateReleaseBody(['feat: add the thing']);
		expect(body).not.toContain('### Fixed');
		expect(body).toContain('### Added');
	});

	test('empty subject list returns empty string', () => {
		expect(generateReleaseBody([])).toBe('');
	});

	test('all-none subjects return empty string', () => {
		const body = generateReleaseBody(['chore: cleanup', 'docs: update', 'refactor: extract']);
		expect(body).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Tests: rollChangelog with releaseBody (AC-4 integration -- US-006)
// ---------------------------------------------------------------------------

describe('rollChangelog - with releaseBody (US-006)', () => {
	test('generated body replaces hand-maintained body in versioned section', () => {
		const releaseBody = generateReleaseBody(['feat: new command', 'fix: correct typo']);
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26', releaseBody);
		// Generated entries are present
		expect(result).toContain('- new command');
		expect(result).toContain('- correct typo');
		// Hand-maintained entries from BASIC_CHANGELOG are NOT in the versioned section
		expect(result).not.toContain('- Supervisor verifies each worker pass landed on origin.');
		expect(result).not.toContain('- Retired the stop-hook loop driver.');
	});

	test('fresh [Unreleased] is empty above the versioned heading', () => {
		const releaseBody = generateReleaseBody(['feat: add thing']);
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26', releaseBody);
		const unreleasedIdx = result.indexOf('## [Unreleased]');
		const versionedIdx = result.indexOf('## [0.2.0] - 2026-06-26');
		const between = result.slice(unreleasedIdx + '## [Unreleased]'.length, versionedIdx);
		expect(between.trim()).toBe('');
	});

	test('prior versioned sections are preserved after the generated body', () => {
		const withPrior = BASIC_CHANGELOG + '\n## [0.1.0] - 2026-01-01\n\n- prior item\n';
		const releaseBody = generateReleaseBody(['fix: fix bug']);
		const result = rollChangelog(withPrior, '0.2.0', '2026-06-26', releaseBody);
		expect(result).toContain('## [0.1.0] - 2026-01-01');
		expect(result).toContain('- prior item');
	});

	test('empty releaseBody (all chore) produces versioned heading with no subsections', () => {
		const releaseBody = generateReleaseBody(['chore: only chore commits']);
		expect(releaseBody).toBe('');
		const result = rollChangelog(BASIC_CHANGELOG, '0.2.0', '2026-06-26', releaseBody);
		const versionedIdx = result.indexOf('## [0.2.0] - 2026-06-26');
		expect(versionedIdx).toBeGreaterThanOrEqual(0);
		// Hand-maintained body is gone when releaseBody is provided (even empty)
		expect(result).not.toContain('- Supervisor verifies each worker pass landed on origin.');
	});
});
