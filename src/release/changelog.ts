// src/release/changelog.ts
//
// rollChangelog -- pure transform that rolls CHANGELOG.md from Keep-a-Changelog
// format's [Unreleased] section into a versioned release section.
//
// The transform locates the literal `## [Unreleased]` heading and:
//   1. Inserts a fresh empty `## [Unreleased]` directly above it.
//   2. Renames the old heading to `## [X.Y.Z] - YYYY-MM-DD`.
//
// All existing body content (### Added / ### Changed subsections) is preserved
// verbatim under the new versioned heading.
//
// The function is pure: it accepts strings and returns a string without
// performing any filesystem reads or writes.
//
// US-004 (CAM-89).

const UNRELEASED_HEADING = '## [Unreleased]';

/**
 * Roll the CHANGELOG `## [Unreleased]` section into a versioned release heading.
 *
 * @param text    - Full CHANGELOG.md content.
 * @param version - New version string, e.g. `"0.2.0"`.
 * @param date    - Release date string in `YYYY-MM-DD` format.
 * @returns Transformed text (original returned unchanged if no [Unreleased] heading exists).
 */
export function rollChangelog(text: string, version: string, date: string): string {
	const idx = text.indexOf(UNRELEASED_HEADING);
	if (idx === -1) return text;

	const before = text.slice(0, idx);
	const after = text.slice(idx + UNRELEASED_HEADING.length);

	return `${before}## [Unreleased]\n\n## [${version}] - ${date}${after}`;
}
