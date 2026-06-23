// scripts/check-coverage.ts
//
// Coverage ratchet gate (US-004, CAM-60 PRD).
//
// Runs `bun test --coverage`, parses the aggregate "All files" row, compares
// each metric (% Funcs, % Lines) against the committed floor in
// scripts/coverage-budget.json, and exits nonzero if any metric is below its
// floor or if a floor was lowered in the staged diff without a tracker ref.
//
// Raising a floor is always allowed.
// Lowering a floor requires a tracker reference (CAM-NNN, #N, or https?://)
// elsewhere in the staged diff of the budget file.
//
// DI pattern mirrors check-file-sizes.ts: pure functions with injectable
// dependencies so unit tests inject in-memory fakes (no real bun test or
// git calls in tests).
//
// Usage: bun scripts/check-coverage.ts

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregate coverage metrics parsed from `bun test --coverage` output. */
export interface CoverageReport {
	/** Overall function coverage percentage (0-100). */
	functions: number;
	/** Overall line coverage percentage (0-100). */
	lines: number;
}

/**
 * Shape of scripts/coverage-budget.json.
 * The `floors` object holds per-metric minimum acceptable percentages.
 */
export interface CoverageBudget {
	floors: {
		functions: number;
		lines: number;
	};
}

export type GetCoverageFn = () => CoverageReport;
export type GetStagedDiffFn = (path: string) => string;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Repo-relative path to the budget file. */
export const BUDGET_PATH = 'scripts/coverage-budget.json';

/** Matches a valid tracker reference: CAM-NNN, #N, or an https?:// URL. */
const TRACKER_REF_RE = /CAM-\d+|#\d+|https?:\/\//;

/**
 * Matches the "All files" aggregate row in `bun test --coverage` output.
 * Columns: % Funcs | % Lines (in that order).
 */
const ALL_FILES_RE = /^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/;

/** Matches a JSON key: number pair from a diff line. */
const KV_RE = /^\s*"([^"]+)":\s*([\d.]+)/;

// ---------------------------------------------------------------------------
// Coverage output parsing
// ---------------------------------------------------------------------------

/**
 * Parse the combined stdout+stderr of `bun test --coverage` and return the
 * aggregate function and line coverage percentages.
 *
 * Returns { functions: 0, lines: 0 } when no "All files" row is found.
 */
export function parseCoverageOutput(output: string): CoverageReport {
	for (const line of output.split('\n')) {
		const m = ALL_FILES_RE.exec(line);
		if (m) {
			return {
				functions: parseFloat(m[1] ?? '0'),
				lines: parseFloat(m[2] ?? '0'),
			};
		}
	}
	return { functions: 0, lines: 0 };
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/**
 * Extract all "key": number pairs from diff lines beginning with the given
 * prefix character ('+' or '-'), skipping header lines (--- / +++).
 */
function parseDiffKv(diffLines: string[], prefix: string): Map<string, number> {
	const result = new Map<string, number>();
	for (const line of diffLines) {
		if (line.startsWith('---') || line.startsWith('+++')) continue;
		if (!line.startsWith(prefix)) continue;
		const m = KV_RE.exec(line.slice(1));
		if (m) result.set(m[1]!, Number(m[2]!));
	}
	return result;
}

/**
 * Parse a unified diff of coverage-budget.json and return every metric key
 * whose numeric floor value was LOWERED (new value < old value).
 */
export function findLoweredFloors(
	diff: string,
): Array<{ metric: string; oldVal: number; newVal: number }> {
	const lines = diff.split('\n');
	const removed = parseDiffKv(lines, '-');
	const added = parseDiffKv(lines, '+');

	const lowered: Array<{ metric: string; oldVal: number; newVal: number }> = [];
	for (const [metric, newVal] of added) {
		const oldVal = removed.get(metric);
		if (oldVal !== undefined && newVal < oldVal) {
			lowered.push({ metric, oldVal, newVal });
		}
	}
	return lowered;
}

// ---------------------------------------------------------------------------
// Default real-world adapters
// ---------------------------------------------------------------------------

function makeDefaultGetCoverage(cwd: string): GetCoverageFn {
	return () => {
		const r = spawnSync('bun', ['test', '--coverage'], {
			encoding: 'utf8',
			cwd,
		});
		const output = (r.stdout ?? '') + (r.stderr ?? '');
		return parseCoverageOutput(output);
	};
}

function makeDefaultGetStagedDiff(cwd: string): GetStagedDiffFn {
	return (path: string) => {
		const r = spawnSync('git', ['diff', '--cached', '-U0', path], {
			encoding: 'utf8',
			cwd,
		});
		return r.stdout ?? '';
	};
}

function makeDefaultReadBudget(budgetPath: string): () => CoverageBudget {
	return () => JSON.parse(readFileSync(budgetPath, 'utf8')) as CoverageBudget;
}

// ---------------------------------------------------------------------------
// Check helpers (extracted to keep checkCoverage cognitive complexity <= 15)
// ---------------------------------------------------------------------------

/** Compare measured coverage against floors; append error strings for failures. */
function checkFloorMet(
	coverage: CoverageReport,
	floors: CoverageBudget['floors'],
	errors: string[],
): void {
	if (coverage.functions < floors.functions) {
		errors.push(
			`functions coverage ${coverage.functions.toFixed(2)}% is below floor ${floors.functions}%`,
		);
	}
	if (coverage.lines < floors.lines) {
		errors.push(
			`lines coverage ${coverage.lines.toFixed(2)}% is below floor ${floors.lines}%`,
		);
	}
}

/** Check staged diff for lowered floors without tracker refs; append errors. */
function checkDiffTrackerRef(diff: string, errors: string[]): void {
	if (diff.length === 0) return;
	const lowered = findLoweredFloors(diff);
	if (lowered.length > 0 && !TRACKER_REF_RE.test(diff)) {
		for (const { metric, oldVal, newVal } of lowered) {
			errors.push(
				`${BUDGET_PATH}: floor for "${metric}" lowered ${oldVal} -> ${newVal}` +
					` without a tracker ref (CAM-NNN, #N, or https?://)`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Core check function (all deps injectable)
// ---------------------------------------------------------------------------

/** Result of the coverage check. */
export interface CoverageResult {
	ok: boolean;
	errors: string[];
}

/**
 * Run the coverage ratchet check with injectable dependencies.
 *
 * Production callers supply no options; tests inject in-memory fakes.
 */
export function checkCoverage(
	options: {
		getCoverage?: GetCoverageFn;
		getStagedDiff?: GetStagedDiffFn;
		readBudget?: () => CoverageBudget;
		cwd?: string;
	} = {},
): CoverageResult {
	const cwd = options.cwd ?? process.cwd();
	const readBudget =
		options.readBudget ?? makeDefaultReadBudget(join(cwd, BUDGET_PATH));
	const getCoverage = options.getCoverage ?? makeDefaultGetCoverage(cwd);
	const getStagedDiff = options.getStagedDiff ?? makeDefaultGetStagedDiff(cwd);

	const budget = readBudget();
	const coverage = getCoverage();
	const errors: string[] = [];

	checkFloorMet(coverage, budget.floors, errors);
	checkDiffTrackerRef(getStagedDiff(BUDGET_PATH), errors);

	return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const result = checkCoverage();
	for (const error of result.errors) {
		process.stderr.write(`check:coverage: ${error}\n`);
	}
	if (!result.ok) {
		process.exit(1);
	}
	process.stdout.write('check:coverage: ok\n');
}
