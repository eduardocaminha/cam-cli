// scripts/ratchet-diff.ts
//
// Shared ratchet-diff helpers for the check:coverage and check:file-size
// quality-gate scripts (US-001, CAM-120 PRD).
//
// Both check-coverage.ts and check-file-sizes.ts enforce the same
// snapshot-on-adopt, change-direction-locked ratchet pattern against their
// own JSON budget file: improvement is always free, degradation requires a
// tracker reference (CAM-NNN, #N, or https?://) somewhere in the staged diff
// of the budget file. This module holds the pieces that were byte-identical
// between the two scripts: the diff key-value parser, the tracker-ref regex,
// and the staged-diff spawn helper.
//
// DI pattern: makeGetStagedDiff returns an injectable GetStagedDiffFn so
// unit tests supply in-memory fakes (no real git calls in tests).
//
// Usage: bun scripts/check-coverage.ts / bun scripts/check-file-sizes.ts

import { spawnSync } from 'node:child_process';

/** Returns the unified staged diff for a given repo-relative path. */
export type GetStagedDiffFn = (path: string) => string;

/** Matches a valid tracker reference: CAM-NNN, #N, or an https?:// URL. */
export const TRACKER_REF_RE = /CAM-\d+|#\d+|https?:\/\//;

/**
 * Matches a JSON key: number pair from a diff line. The value pattern
 * accepts both integers (file-size ceilings) and floats (coverage floors):
 * a strict superset of the two patterns previously duplicated between
 * check-coverage.ts ([\d.]+) and check-file-sizes.ts (\d+). Integer values
 * still match unambiguously, so no accepted budget syntax changes.
 */
const KV_RE = /^\s*"([^"]+)":\s*([\d.]+)/;

/**
 * Extract all "key": number pairs from diff lines beginning with the given
 * prefix character ('+' or '-'), skipping header lines (--- / +++).
 */
export function parseDiffKv(diffLines: string[], prefix: string): Map<string, number> {
	const result = new Map<string, number>();
	for (const line of diffLines) {
		if (line.startsWith('---') || line.startsWith('+++')) continue;
		if (!line.startsWith(prefix)) continue;
		const m = KV_RE.exec(line.slice(1));
		if (m) result.set(m[1]!, Number(m[2]!));
	}
	return result;
}

/** Build a GetStagedDiffFn that spawns `git diff --cached -U0 <path>` in cwd. */
export function makeGetStagedDiff(cwd: string): GetStagedDiffFn {
	return (path: string) => {
		const r = spawnSync('git', ['diff', '--cached', '-U0', path], {
			encoding: 'utf8',
			cwd,
		});
		return r.stdout ?? '';
	};
}
