// src/config/issue-system.ts
//
// Central reader for `issue_system` in scripts/cam/project.toml.
//
// Unlike the other project.toml readers in this directory (readMergeMode,
// readPlanApproval, readWorkerIsolation, etc.), which are defensive-by-default
// (any unrecognized value silently falls back to a safe default),
// readIssueSystem is deliberately noisy: a truly-unrecognized value throws.
// issue_system selects which backend owns issue-close semantics
// (ship-finalize.ts, ship-pr.ts); silently mapping a typo'd value to a
// fallback would make the local-backend close/stash gates skip silently
// instead of failing loud (US-002, CAM-236). The one deliberate exception is
// the deprecated `none` alias, which normalizes to `local` instead of
// throwing: existing project.toml files written before the rename are never
// rewritten by mergeIntoConfig, so `none` must keep working (US-001, CAM-239).
//
// Takes an already-parsed config object rather than a configPath, mirroring
// ship-finalize.ts's existing call site: `parseToml` runs once, and the
// resulting object is passed straight to readIssueSystem instead of
// re-reading + re-parsing the file.

/**
 * The issue backend selected for a project. `'local'` is the default: issues
 * are tracked in `scripts/cam/issues/` and closed via closeIssueOnMain.
 * `'github'`/`'linear'` defer issue-close to the external system.
 */
export type IssueSystem = 'linear' | 'github' | 'local';

const VALID_ISSUE_SYSTEMS: readonly IssueSystem[] = ['linear', 'github', 'local'];

/**
 * Read `issue_system` from an already-parsed project.toml config object.
 *
 * - Absent key -> `'local'` (the default backend).
 * - Value in `{linear, github, local}` -> returned as-is.
 * - Deprecated alias `'none'` -> normalized to `'local'` (mergeIntoConfig
 *   never rewrites an existing project.toml, so pre-rename projects still
 *   have `issue_system = "none"` on disk).
 * - Any other value -> throws.
 */
export function readIssueSystem(config: Record<string, unknown>): IssueSystem {
	const value = config['issue_system'];
	if (value === undefined) return 'local';
	if (value === 'none') return 'local';
	if (typeof value === 'string' && (VALID_ISSUE_SYSTEMS as readonly string[]).includes(value)) {
		return value as IssueSystem;
	}
	throw new Error(`issue_system invalido: '${String(value)}', esperado linear|github|local`);
}
