// test/check-coverage.test.ts
//
// Unit tests for scripts/check-coverage.ts (US-004, CAM-60 PRD).
//
// All tests inject in-memory fakes for getCoverage, getStagedDiff, and
// readBudget; no real bun test or git calls are made.
//
// Coverage:
//   checkCoverage: coverage at floors (exits ok)
//   checkCoverage: coverage above floors (exits ok)
//   checkCoverage: functions below floor (exits fail, names metric)
//   checkCoverage: lines below floor (exits fail, names metric)
//   checkCoverage: both metrics below floor (exits fail, names both)
//   checkCoverage: measured within tolerance band (exits ok)
//   checkCoverage: measured beyond tolerance band (exits fail, names metric)
//   checkCoverage: floor raised in diff (exits ok, raising always allowed)
//   checkCoverage: floor lowered with CAM-NNN ref (exits ok)
//   checkCoverage: floor lowered with #N ref (exits ok)
//   checkCoverage: floor lowered with https URL (exits ok)
//   checkCoverage: floor lowered without tracker ref (exits fail)
//   checkCoverage: both floors lowered without tracker ref (exits fail, names both)
//   checkCoverage: no staged diff (exits ok, no ref check)
//   parseCoverageOutput: parses "All files" row correctly
//   parseCoverageOutput: returns zeros when row absent
//   findLoweredFloors: detects lowered metrics
//   findLoweredFloors: does not flag raised metrics
//   findLoweredFloors: skips --- / +++ header lines
//   findLoweredFloors: ignores string-valued keys (_ref)

import { describe, expect, test } from 'bun:test';
import {
	checkCoverage,
	parseCoverageOutput,
	findLoweredFloors,
	BUDGET_PATH,
	type CoverageBudget,
	type CoverageReport,
} from '../scripts/check-coverage.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_FLOORS: CoverageBudget['floors'] = { functions: 75.0, lines: 80.0 };

function makeBudget(floors: Partial<CoverageBudget['floors']> = {}): () => CoverageBudget {
	return () => ({ floors: { ...DEFAULT_FLOORS, ...floors } });
}

function makeCoverage(report: Partial<CoverageReport> = {}): () => CoverageReport {
	return () => ({ functions: 80.0, lines: 85.0, ...report });
}

/** Build a diff where a floor is LOWERED (new < old). */
function loweredDiff(
	metric: string,
	oldVal: number,
	newVal: number,
	extra = '',
): string {
	return [
		`--- a/${BUDGET_PATH}`,
		`+++ b/${BUDGET_PATH}`,
		`@@ -3,3 +3,3 @@`,
		`   "floors": {`,
		`-    "${metric}": ${oldVal},`,
		`+    "${metric}": ${newVal},${extra}`,
		`   }`,
	].join('\n');
}

/** Build a diff where a floor is RAISED (new > old). */
function raisedDiff(metric: string, oldVal: number, newVal: number): string {
	return [
		`--- a/${BUDGET_PATH}`,
		`+++ b/${BUDGET_PATH}`,
		`@@ -3,3 +3,3 @@`,
		`   "floors": {`,
		`-    "${metric}": ${oldVal},`,
		`+    "${metric}": ${newVal},`,
		`   }`,
	].join('\n');
}

/** Build a diff that lowers a floor AND embeds a tracker ref in a comment line. */
function loweredDiffWithRef(
	metric: string,
	oldVal: number,
	newVal: number,
	ref: string,
): string {
	return [
		`--- a/${BUDGET_PATH}`,
		`+++ b/${BUDGET_PATH}`,
		`@@ -2,5 +2,6 @@`,
		` {`,
		`-  "${metric}": ${oldVal},`,
		`+  "${metric}": ${newVal},`,
		`+  "_ref": "${ref}",`,
		` }`,
	].join('\n');
}

// ---------------------------------------------------------------------------
// checkCoverage: floor checks
// ---------------------------------------------------------------------------

describe('checkCoverage — coverage at or above floors', () => {
	test('all metrics exactly at floor: exits ok', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 75.0, lines: 80.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('all metrics above floor: exits ok', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 90.0, lines: 95.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

describe('checkCoverage — coverage below floors', () => {
	test('functions below floor: exits fail, names metric', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 70.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('functions');
		expect(result.errors[0]).toContain('70.00%');
		expect(result.errors[0]).toContain('75%');
	});

	test('lines below floor: exits fail, names metric', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 75.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('lines');
		expect(result.errors[0]).toContain('75.00%');
		expect(result.errors[0]).toContain('80%');
	});

	test('both metrics below floor: exits fail, names both', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 70.0, lines: 75.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(2);
		const msgs = result.errors.join('\n');
		expect(msgs).toContain('functions');
		expect(msgs).toContain('lines');
	});
});

// ---------------------------------------------------------------------------
// checkCoverage: cross-environment tolerance band (CAM-60 follow-up, PR #66)
// ---------------------------------------------------------------------------

describe('checkCoverage — floor comparison tolerance band', () => {
	test('measured within 0.5pp tolerance below floor: exits ok', () => {
		// floor 80, measured 79.7 => 0.3pp below, inside the 0.5pp slack
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 79.7, lines: 79.7 }),
			readBudget: makeBudget({ functions: 80.0, lines: 80.0 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('measured beyond 0.5pp tolerance below floor: exits fail, names metric', () => {
		// floor 80, measured 79.0 => 1.0pp below, outside the 0.5pp slack
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 79.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 80.0, lines: 80.0 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('functions');
		expect(result.errors[0]).toContain('79.00%');
		expect(result.errors[0]).toContain('80%');
	});
});

// ---------------------------------------------------------------------------
// checkCoverage: floor raising is always allowed
// ---------------------------------------------------------------------------

describe('checkCoverage — raising a floor is always allowed', () => {
	test('floor raised in diff, coverage >= new floor: exits ok', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => raisedDiff('functions', 75.0, 78.0),
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('floor raised in diff, no tracker ref present: exits ok (no ref needed)', () => {
		// Raising never requires a tracker ref; only lowering does.
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 90.0, lines: 90.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => raisedDiff('lines', 80.0, 85.0),
		});
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkCoverage: floor lowering requires tracker ref
// ---------------------------------------------------------------------------

describe('checkCoverage — lowering a floor without tracker ref', () => {
	test('floor lowered, no tracker ref: exits fail', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => loweredDiff('functions', 75.0, 72.0),
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain(BUDGET_PATH);
		expect(result.errors[0]).toContain('"functions"');
		expect(result.errors[0]).toContain('75 -> 72');
		expect(result.errors[0]).toContain('tracker ref');
	});

	test('both floors lowered, no tracker ref: exits fail, names both', () => {
		const diff = [
			`--- a/${BUDGET_PATH}`,
			`+++ b/${BUDGET_PATH}`,
			`@@ -3,4 +3,4 @@`,
			`   "floors": {`,
			`-    "functions": 75.0,`,
			`+    "functions": 70.0,`,
			`-    "lines": 80.0`,
			`+    "lines": 75.0`,
			`   }`,
		].join('\n');

		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => diff,
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(2);
		const msgs = result.errors.join('\n');
		expect(msgs).toContain('"functions"');
		expect(msgs).toContain('"lines"');
	});
});

describe('checkCoverage — lowering a floor WITH tracker ref passes', () => {
	test('floor lowered with CAM-NNN ref: exits ok', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => loweredDiffWithRef('functions', 75.0, 72.0, 'CAM-123'),
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('floor lowered with #N ref: exits ok', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () => loweredDiffWithRef('lines', 80.0, 77.0, '#42'),
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('floor lowered with https URL: exits ok', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 85.0 }),
			readBudget: makeBudget({ functions: 75.0, lines: 80.0 }),
			getStagedDiff: () =>
				loweredDiffWithRef('functions', 75.0, 73.0, 'https://github.com/org/repo/issues/5'),
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

describe('checkCoverage — no staged diff', () => {
	test('empty diff: exits ok, no ref check performed', () => {
		const result = checkCoverage({
			getCoverage: makeCoverage({ functions: 80.0, lines: 85.0 }),
			readBudget: makeBudget(),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// parseCoverageOutput
// ---------------------------------------------------------------------------

describe('parseCoverageOutput', () => {
	test('parses "All files" row from bun test --coverage output', () => {
		const output = [
			'File                              | % Funcs | % Lines | Uncovered Line #s',
			'----------------------------------|---------|---------|-------------------',
			'src/foo.ts                        |  100.00 |  100.00 |',
			'src/bar.ts                        |   80.00 |   90.00 | 12,34',
			'----------------------------------|---------|---------|-------------------',
			'All files                         |   75.79 |   78.61 |',
			'----------------------------------|---------|---------|-------------------',
		].join('\n');

		const report = parseCoverageOutput(output);
		expect(report.functions).toBe(75.79);
		expect(report.lines).toBe(78.61);
	});

	test('returns zeros when "All files" row is absent', () => {
		const report = parseCoverageOutput('no coverage data here');
		expect(report.functions).toBe(0);
		expect(report.lines).toBe(0);
	});

	test('handles output in stderr (combined with stdout)', () => {
		const stderr = 'All files                         |   90.00 |   95.00 |';
		const report = parseCoverageOutput(stderr);
		expect(report.functions).toBe(90.0);
		expect(report.lines).toBe(95.0);
	});

	test('parses integer percentages (100.00)', () => {
		const output = 'All files                         |  100.00 |  100.00 |';
		const report = parseCoverageOutput(output);
		expect(report.functions).toBe(100.0);
		expect(report.lines).toBe(100.0);
	});
});

// ---------------------------------------------------------------------------
// findLoweredFloors
// ---------------------------------------------------------------------------

describe('findLoweredFloors', () => {
	test('detects a lowered floor', () => {
		const diff = loweredDiff('functions', 75.0, 72.0);
		const result = findLoweredFloors(diff);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ metric: 'functions', oldVal: 75, newVal: 72 });
	});

	test('does not flag a raised floor', () => {
		const diff = raisedDiff('functions', 75.0, 78.0);
		const result = findLoweredFloors(diff);
		expect(result).toHaveLength(0);
	});

	test('does not flag unchanged floors', () => {
		const diff = [
			`--- a/${BUDGET_PATH}`,
			`+++ b/${BUDGET_PATH}`,
			`@@ -1,3 +1,3 @@`,
			`-  "functions": 75.0,`,
			`+  "functions": 75.0,`,
		].join('\n');
		const result = findLoweredFloors(diff);
		expect(result).toHaveLength(0);
	});

	test('skips --- / +++ header lines', () => {
		// A diff where the header line itself has numeric values must not trip the parser
		const diff = [
			`--- a/scripts/coverage-budget.json`,
			`+++ b/scripts/coverage-budget.json`,
			`@@ -1,1 +1,1 @@`,
			`-  "lines": 80.0`,
			`+  "lines": 78.0`,
		].join('\n');
		const result = findLoweredFloors(diff);
		// Only the actual -/+ content lines are matched; headers are skipped
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ metric: 'lines', oldVal: 80, newVal: 78 });
	});

	test('ignores string-valued keys like _ref', () => {
		const diff = [
			`--- a/${BUDGET_PATH}`,
			`+++ b/${BUDGET_PATH}`,
			`@@ -1,2 +1,2 @@`,
			`-  "_ref": "CAM-60 old description",`,
			`+  "_ref": "CAM-60 new description",`,
		].join('\n');
		// _ref has string value, KV_RE only matches numeric values
		const result = findLoweredFloors(diff);
		expect(result).toHaveLength(0);
	});

	test('detects lowered floor when multiple metrics in diff', () => {
		const diff = [
			`--- a/${BUDGET_PATH}`,
			`+++ b/${BUDGET_PATH}`,
			`@@ -3,4 +3,4 @@`,
			`   "floors": {`,
			`-    "functions": 75.0,`,
			`+    "functions": 80.0,`,
			`-    "lines": 80.0`,
			`+    "lines": 75.0`,
			`   }`,
		].join('\n');
		const result = findLoweredFloors(diff);
		// functions raised (80 > 75): not lowered
		// lines lowered (75 < 80): detected
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ metric: 'lines', oldVal: 80, newVal: 75 });
	});
});
