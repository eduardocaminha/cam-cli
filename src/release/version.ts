// src/release/version.ts
//
// Version computation and atomic writer for conventional-commits release flow.
//
// computeNextVersion: pure function mapping (current, bump) -> next version string.
//   0.x convention: while major is 0, a 'major' bump maps to a minor increment
//   (e.g. 0.1.2 + major -> 0.2.0, never 1.0.0).
//
// applyVersionToVersionTs / applyVersionToPackageJson: pure text transforms that
//   rewrite the version literal in src/version.ts and package.json respectively,
//   leaving both files otherwise byte-identical. Testable without real fs (DI'd
//   style mirroring src/commands/ship-finalize.ts).
//
// US-002 (CAM-89).

import type { BumpLevel } from './bump.ts';

/**
 * Compute the next semver string from `current` given a `bump` level.
 *
 * 0.x convention: while the MAJOR component of `current` is 0,
 * a `major` bump is demoted to a MINOR increment.
 * This means `computeNextVersion('0.1.2', 'major')` returns `'0.2.0'`,
 * and no input to this function can produce `'1.0.0'` while major is 0.
 */
export function computeNextVersion(current: string, bump: BumpLevel): string {
	if (bump === 'none') return current;

	const parts = current.split('.');
	const major = parseInt(parts[0] ?? '0', 10);
	const minor = parseInt(parts[1] ?? '0', 10);
	const patch = parseInt(parts[2] ?? '0', 10);

	if (bump === 'patch') {
		return `${major}.${minor}.${patch + 1}`;
	}
	if (bump === 'minor') {
		return `${major}.${minor + 1}.0`;
	}
	// bump === 'major': apply 0.x convention
	if (major === 0) {
		// Pre-1.0: demotion to minor increment
		return `${major}.${minor + 1}.0`;
	}
	return `${major + 1}.0.0`;
}

/**
 * Pure text transform: rewrites the version literal in src/version.ts.
 *
 * Matches the exact literal `export const CAM_VERSION = '<old>';` (single
 * quotes, semicolon) and replaces the version string in-place, returning the
 * updated text. All other bytes are preserved.
 */
export function applyVersionToVersionTs(text: string, newVersion: string): string {
	return text.replace(
		/^(export const CAM_VERSION = ')[^']+(';)$/m,
		`$1${newVersion}$2`,
	);
}

/**
 * Pure text transform: rewrites the top-level "version" field in package.json.
 *
 * Matches `"version": "<old>"` (any leading whitespace) and replaces the
 * version string in-place, returning the updated text. All other bytes are
 * preserved.
 */
export function applyVersionToPackageJson(text: string, newVersion: string): string {
	return text.replace(
		/^(\s*"version"\s*:\s*")[^"]+(")/m,
		`$1${newVersion}$2`,
	);
}
