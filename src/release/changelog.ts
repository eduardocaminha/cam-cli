// src/release/changelog.ts
//
// generateReleaseBody -- pure function that takes branch commit subjects and
// returns Keep-a-Changelog subsection text placing feat/feat! subjects under
// ### Added and fix/fix! subjects under ### Fixed. No-bump subjects (chore:,
// docs:, free text, CAM-NN) are excluded. Empty subsections are omitted.
//
// rollChangelog -- pure transform that rolls CHANGELOG.md from Keep-a-Changelog
// format's [Unreleased] section into a versioned release section.
//
// The transform locates the literal `## [Unreleased]` heading and:
//   1. Inserts a fresh empty `## [Unreleased]` directly above it.
//   2. Renames the old heading to `## [X.Y.Z] - YYYY-MM-DD`.
//
// When an optional `releaseBody` string is provided (generated from commits
// via generateReleaseBody), that body is used for the versioned section instead
// of the prior hand-maintained [Unreleased] body. When absent, the old body is
// preserved verbatim (backward-compat legacy behaviour).
//
// Both functions are pure: they accept strings and return strings without
// performing any filesystem reads or writes.
//
// US-004 (CAM-89), US-006 (CAM-89).

const UNRELEASED_HEADING = '## [Unreleased]';

// ---------------------------------------------------------------------------
// Regexes for conventional-commit prefix detection (consistent with bump.ts)
// ---------------------------------------------------------------------------

/**
 * Matches feat: / feat(<scope>): / feat!: / feat(<scope>)!:
 * Subjects matching this are placed under ### Added.
 */
const FEAT_SUBJECT_RE = /^feat(?:\([^)]*\))?!?:/;

/**
 * Matches fix: / fix(<scope>): / fix!: / fix(<scope>)!:
 * Subjects matching this are placed under ### Fixed.
 */
const FIX_SUBJECT_RE = /^fix(?:\([^)]*\))?!?:/;

/**
 * Strips the conventional-commit prefix (type(scope)!: ) from a subject line,
 * leaving only the prose description.
 *
 * Examples:
 *   "feat: Add foo"          -> "Add foo"
 *   "feat(scope): Add bar"   -> "Add bar"
 *   "feat!: Breaking add"    -> "Breaking add"
 *   "fix(ui)!: Patch crash"  -> "Patch crash"
 */
const STRIP_PREFIX_RE = /^[a-z]+(?:\([^)]*\))?!?:\s*/;

function stripPrefix(subject: string): string {
	return subject.replace(STRIP_PREFIX_RE, '');
}

// ---------------------------------------------------------------------------
// generateReleaseBody
// ---------------------------------------------------------------------------

/**
 * Generate a Keep-a-Changelog release body from classified commit subjects.
 *
 * - `feat:` / `feat!:` subjects (with any scope) -> `### Added`
 * - `fix:` / `fix!:` subjects (with any scope)   -> `### Fixed`
 * - All other subjects (chore:, docs:, free text, CAM-NN:) are excluded.
 * - Empty subsections are omitted rather than emitting an empty heading.
 *
 * @param subjects - Array of git commit subject strings (one per commit).
 * @returns Subsection text ready to embed under a `## [X.Y.Z]` heading,
 *          or an empty string when there are no feat/fix subjects.
 */
export function generateReleaseBody(subjects: string[]): string {
	const addedItems: string[] = [];
	const fixedItems: string[] = [];

	for (const subject of subjects) {
		if (FEAT_SUBJECT_RE.test(subject)) {
			addedItems.push(stripPrefix(subject));
		} else if (FIX_SUBJECT_RE.test(subject)) {
			fixedItems.push(stripPrefix(subject));
		}
		// chore:, docs:, refactor:, CAM-NN:, free text -> excluded
	}

	const sections: string[] = [];
	if (addedItems.length > 0) {
		sections.push(`### Added\n\n${addedItems.map((i) => `- ${i}`).join('\n')}`);
	}
	if (fixedItems.length > 0) {
		sections.push(`### Fixed\n\n${fixedItems.map((i) => `- ${i}`).join('\n')}`);
	}

	return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// rollChangelog
// ---------------------------------------------------------------------------

/**
 * Roll the CHANGELOG `## [Unreleased]` section into a versioned release heading.
 *
 * When `releaseBody` is provided, that text becomes the body of the new versioned
 * section (replacing whatever hand-maintained content was under [Unreleased]).
 * When `releaseBody` is absent, the old body is preserved verbatim.
 *
 * @param text        - Full CHANGELOG.md content.
 * @param version     - New version string, e.g. `"0.2.0"`.
 * @param date        - Release date string in `YYYY-MM-DD` format.
 * @param releaseBody - Optional body from generateReleaseBody(); when present,
 *                      replaces the hand-maintained [Unreleased] body.
 * @returns Transformed text (original returned unchanged if no [Unreleased] heading exists).
 */
export function rollChangelog(text: string, version: string, date: string, releaseBody?: string): string {
	const idx = text.indexOf(UNRELEASED_HEADING);
	if (idx === -1) return text;

	const before = text.slice(0, idx);
	const after = text.slice(idx + UNRELEASED_HEADING.length);

	if (releaseBody !== undefined) {
		// Locate the next `## ` heading in `after` so we can skip the old
		// hand-maintained body and preserve everything after it (prior releases, etc.).
		// `## ` (two hashes + space) matches version headings but NOT subsections (### ).
		const nextHeadingMatch = /\n## /.exec(after);
		const oldBodyEnd = nextHeadingMatch?.index ?? after.length;
		const tail = after.slice(oldBodyEnd);

		const bodyPart = releaseBody.length > 0 ? `\n\n${releaseBody}\n` : '\n';
		return `${before}## [Unreleased]\n\n## [${version}] - ${date}${bodyPart}${tail}`;
	}

	// Legacy: preserve old body verbatim (no releaseBody provided).
	return `${before}## [Unreleased]\n\n## [${version}] - ${date}${after}`;
}
