// scripts/check-file-sizes.ts
//
// File-size ratchet gate (US-002, CAM-60 PRD).
//
// Snapshot the per-file LOC ceilings in scripts/file-size-budget.json.
// Two checks:
//   1. Every file listed in the budget must be at or below its ceiling.
//   2. When the staged diff of the budget RAISES a ceiling, the diff must
//      contain at least one tracker reference (CAM-NNN, #N, or https?://).
//      Lowering a ceiling or making no change to a ceiling always passes.
//
// DI pattern mirrors check-all.ts SpawnFn: pure functions with injectable
// dependencies so unit tests inject in-memory fakes (no real git/fs calls).
// The diff key-value parser, tracker-ref regex, and staged-diff spawn helper
// are shared with check-coverage.ts via scripts/ratchet-diff.ts (US-001,
// CAM-120 PRD).
//
// Usage: bun scripts/check-file-sizes.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { Glob } from 'bun';
import { parseDiffKv, TRACKER_REF_RE, makeGetStagedDiff } from './ratchet-diff.ts';
import type { GetStagedDiffFn } from './ratchet-diff.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types
// ---------------------------------------------------------------------------

/** Returns the current line counts for all tracked files (repo-relative keys). */
export type GetSizesFn = () => Record<string, number>;

/** Returns the per-file LOC budget as { "repo/relative/path": ceilingLineCount }. */
export type ReadBudgetFn = () => Record<string, number>;

export type { GetStagedDiffFn };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface FileSizeResult {
	ok: boolean;
	errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Repo-relative path to the budget file (used as the key and as the diff target). */
export const BUDGET_PATH = 'scripts/file-size-budget.json';

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string and return every JSON key whose numeric value
 * was RAISED (new value > old value).
 *
 * Expects diffs from `git diff --cached -U0 scripts/file-size-budget.json`.
 */
export function findRaisedCeilings(
	diff: string,
): Array<{ path: string; oldVal: number; newVal: number }> {
	const lines = diff.split('\n');
	const removed = parseDiffKv(lines, '-');
	const added = parseDiffKv(lines, '+');

	const raised: Array<{ path: string; oldVal: number; newVal: number }> = [];
	for (const [path, newVal] of added) {
		const oldVal = removed.get(path);
		if (oldVal !== undefined && newVal > oldVal) {
			raised.push({ path, oldVal, newVal });
		}
	}
	return raised;
}

// ---------------------------------------------------------------------------
// Default real-world adapters (defined as top-level fns to keep complexity low)
// ---------------------------------------------------------------------------

function makeDefaultReadBudget(budgetPath: string): ReadBudgetFn {
	return () => {
		const content = readFileSync(budgetPath, 'utf8');
		return JSON.parse(content) as Record<string, number>;
	};
}

function makeDefaultGetSizes(cwd: string): GetSizesFn {
	return () => {
		const result: Record<string, number> = {};
		const glob = new Glob('{src,scripts,test}/**/*.{ts,tsx}');
		for (const file of glob.scanSync({ cwd })) {
			const content = readFileSync(join(cwd, file), 'utf8');
			result[file] = content.split('\n').length;
		}
		return result;
	};
}

// ---------------------------------------------------------------------------
// Check helpers (extracted to keep checkFileSizes cognitive complexity <= 15)
// ---------------------------------------------------------------------------

/** Check each budgeted file against actual sizes; append error strings. */
function checkSizeCeilings(
	budget: Record<string, number>,
	sizes: Record<string, number>,
	errors: string[],
): void {
	for (const [path, ceiling] of Object.entries(budget)) {
		const actual = sizes[path];
		if (actual === undefined) continue;
		if (actual > ceiling) {
			errors.push(`${path}:${actual} exceeds budget ceiling of ${ceiling} lines`);
		}
	}
}

/** Check staged diff of the budget for raised ceilings without tracker refs; append errors. */
function checkDiffTrackerRef(diff: string, errors: string[]): void {
	if (diff.length === 0) return;
	const raised = findRaisedCeilings(diff);
	if (raised.length > 0 && !TRACKER_REF_RE.test(diff)) {
		for (const { path, oldVal, newVal } of raised) {
			errors.push(
				`${BUDGET_PATH}: ceiling for "${path}" raised ${oldVal} -> ${newVal}` +
					` without a tracker ref (CAM-NNN, #N, or https?://)`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Core check function (all deps injectable)
// ---------------------------------------------------------------------------

/**
 * Run both file-size checks:
 *   1. Actual sizes vs budget ceilings.
 *   2. Staged diff of the budget for raised ceilings without tracker refs.
 *
 * Returns a FileSizeResult with ok flag and human-readable error strings.
 * The CLI entrypoint writes errors to stderr and exits nonzero on failure.
 */
export function checkFileSizes(options: {
	getSizes?: GetSizesFn;
	readBudget?: ReadBudgetFn;
	getStagedDiff?: GetStagedDiffFn;
	cwd?: string;
} = {}): FileSizeResult {
	const cwd = options.cwd ?? process.cwd();
	const readBudget = options.readBudget ?? makeDefaultReadBudget(join(cwd, BUDGET_PATH));
	const getSizes = options.getSizes ?? makeDefaultGetSizes(cwd);
	const getStagedDiff = options.getStagedDiff ?? makeGetStagedDiff(cwd);

	const errors: string[] = [];
	checkSizeCeilings(readBudget(), getSizes(), errors);
	checkDiffTrackerRef(getStagedDiff(BUDGET_PATH), errors);
	return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const result = checkFileSizes();
	for (const error of result.errors) {
		process.stderr.write(`check:file-size: ${error}\n`);
	}
	if (!result.ok) {
		process.exit(1);
	}
	process.stdout.write('check:file-size: ok\n');
}
