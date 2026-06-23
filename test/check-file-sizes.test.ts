// test/check-file-sizes.test.ts
//
// Unit tests for scripts/check-file-sizes.ts (US-002, CAM-60 PRD).
//
// All tests inject in-memory fakes for getSizes, readBudget, and getStagedDiff;
// no real filesystem reads or git calls are made.
//
// Coverage:
//   checkFileSizes: all within budget (exit 0)
//   checkFileSizes: one file over budget (exit 1, names file:line)
//   checkFileSizes: multiple files over budget (exit 1, all named)
//   checkFileSizes: staged diff raises ceiling without tracker ref (exit 1)
//   checkFileSizes: staged diff raises ceiling with CAM-NNN ref (exit 0)
//   checkFileSizes: staged diff raises ceiling with #N ref (exit 0)
//   checkFileSizes: staged diff raises ceiling with https URL (exit 0)
//   checkFileSizes: staged diff only lowers ceilings (exit 0, no ref needed)
//   checkFileSizes: staged diff has same ceilings (exit 0)
//   checkFileSizes: no staged diff (empty string) (exit 0, no ref check)
//   findRaisedCeilings: parses raised, lowered, and unchanged entries
//   findRaisedCeilings: skips --- / +++ header lines

import { describe, expect, test } from 'bun:test';
import { checkFileSizes, findRaisedCeilings, BUDGET_PATH } from '../scripts/check-file-sizes.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build the simplest fake diff for a single key raised from oldVal to newVal. */
function raisedDiff(key: string, oldVal: number, newVal: number, extra = ''): string {
	return [
		`--- a/${BUDGET_PATH}`,
		`+++ b/${BUDGET_PATH}`,
		`@@ -1,3 +1,3 @@`,
		` {`,
		`-  "${key}": ${oldVal},`,
		`+  "${key}": ${newVal},${extra}`,
		` }`,
	].join('\n');
}

/** Build a diff where a ceiling is LOWERED. */
function loweredDiff(key: string, oldVal: number, newVal: number): string {
	return [
		`--- a/${BUDGET_PATH}`,
		`+++ b/${BUDGET_PATH}`,
		`@@ -1,3 +1,3 @@`,
		` {`,
		`-  "${key}": ${oldVal},`,
		`+  "${key}": ${newVal},`,
		` }`,
	].join('\n');
}

/** Build a diff with a tracker reference embedded in a comment line. */
function raisedDiffWithRef(key: string, oldVal: number, newVal: number, ref: string): string {
	return [
		`--- a/${BUDGET_PATH}`,
		`+++ b/${BUDGET_PATH}`,
		`@@ -1,4 +1,5 @@`,
		` {`,
		`-  "${key}": ${oldVal},`,
		`+  "${key}": ${newVal},`,
		`+  "_comment": "${ref}",`,
		` }`,
	].join('\n');
}

// ---------------------------------------------------------------------------
// checkFileSizes — budget vs sizes checks
// ---------------------------------------------------------------------------

describe('checkFileSizes — sizes within budget', () => {
	test('all files at or below ceiling: exits ok', () => {
		const result = checkFileSizes({
			readBudget: () => ({ 'src/foo.ts': 100, 'src/bar.ts': 50 }),
			getSizes: () => ({ 'src/foo.ts': 100, 'src/bar.ts': 30 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('files not in sizes are skipped (deleted files)', () => {
		const result = checkFileSizes({
			readBudget: () => ({ 'src/deleted.ts': 50 }),
			getSizes: () => ({}),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
	});
});

describe('checkFileSizes — file exceeds ceiling', () => {
	test('one file over budget: exits fail and names file:line', () => {
		const result = checkFileSizes({
			readBudget: () => ({ 'src/big.ts': 100 }),
			getSizes: () => ({ 'src/big.ts': 150 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		// Must include "file:line" in the form path:actualCount
		expect(result.errors[0]).toContain('src/big.ts:150');
		expect(result.errors[0]).toContain('100');
	});

	test('multiple files over budget: all named in errors', () => {
		const result = checkFileSizes({
			readBudget: () => ({ 'src/a.ts': 10, 'src/b.ts': 20 }),
			getSizes: () => ({ 'src/a.ts': 15, 'src/b.ts': 25 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(2);
		expect(result.errors.some((e) => e.includes('src/a.ts:15'))).toBe(true);
		expect(result.errors.some((e) => e.includes('src/b.ts:25'))).toBe(true);
	});

	test('exactly at ceiling: passes', () => {
		const result = checkFileSizes({
			readBudget: () => ({ 'src/exact.ts': 100 }),
			getSizes: () => ({ 'src/exact.ts': 100 }),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkFileSizes — staged diff tracker-ref check
// ---------------------------------------------------------------------------

describe('checkFileSizes — staged diff: raised ceiling without tracker ref', () => {
	test('raised ceiling with no tracker ref: exits fail', () => {
		const diff = raisedDiff('src/foo.ts', 100, 200);
		const result = checkFileSizes({
			readBudget: () => ({}),
			getSizes: () => ({}),
			getStagedDiff: () => diff,
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes('src/foo.ts'))).toBe(true);
		expect(result.errors.some((e) => e.includes('100'))).toBe(true);
		expect(result.errors.some((e) => e.includes('200'))).toBe(true);
	});

	test('raised ceiling with CAM-NNN ref: exits ok', () => {
		const diff = raisedDiffWithRef('src/foo.ts', 100, 200, 'CAM-123');
		const result = checkFileSizes({
			readBudget: () => ({}),
			getSizes: () => ({}),
			getStagedDiff: () => diff,
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('raised ceiling with #N ref: exits ok', () => {
		const diff = raisedDiffWithRef('src/foo.ts', 100, 200, '#42');
		const result = checkFileSizes({
			readBudget: () => ({}),
			getSizes: () => ({}),
			getStagedDiff: () => diff,
		});
		expect(result.ok).toBe(true);
	});

	test('raised ceiling with https URL ref: exits ok', () => {
		const diff = raisedDiffWithRef('src/foo.ts', 100, 200, 'https://github.com/org/repo/issues/7');
		const result = checkFileSizes({
			readBudget: () => ({}),
			getSizes: () => ({}),
			getStagedDiff: () => diff,
		});
		expect(result.ok).toBe(true);
	});
});

describe('checkFileSizes — staged diff: lowered or unchanged ceilings', () => {
	test('lowered ceiling with no tracker ref: exits ok', () => {
		const diff = loweredDiff('src/foo.ts', 200, 100);
		const result = checkFileSizes({
			readBudget: () => ({}),
			getSizes: () => ({}),
			getStagedDiff: () => diff,
		});
		expect(result.ok).toBe(true);
	});

	test('unchanged value in diff (same old and new): exits ok', () => {
		// A diff where both sides show the same number (no actual change).
		const diff = raisedDiff('src/foo.ts', 100, 100);
		const result = checkFileSizes({
			readBudget: () => ({}),
			getSizes: () => ({}),
			getStagedDiff: () => diff,
		});
		expect(result.ok).toBe(true);
	});

	test('empty diff (nothing staged): exits ok', () => {
		const result = checkFileSizes({
			readBudget: () => ({}),
			getSizes: () => ({}),
			getStagedDiff: () => '',
		});
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// findRaisedCeilings — unit tests
// ---------------------------------------------------------------------------

describe('findRaisedCeilings', () => {
	test('raised entry is returned', () => {
		const diff = raisedDiff('src/foo.ts', 100, 200);
		const raised = findRaisedCeilings(diff);
		expect(raised).toHaveLength(1);
		expect(raised[0]).toEqual({ path: 'src/foo.ts', oldVal: 100, newVal: 200 });
	});

	test('lowered entry is not returned', () => {
		const diff = loweredDiff('src/foo.ts', 200, 100);
		expect(findRaisedCeilings(diff)).toHaveLength(0);
	});

	test('unchanged entry (same value) is not returned', () => {
		const diff = raisedDiff('src/foo.ts', 100, 100);
		expect(findRaisedCeilings(diff)).toHaveLength(0);
	});

	test('header --- / +++ lines are skipped', () => {
		// A minimal diff where the header contains a number-like path that could
		// false-positive if header lines are not filtered.
		const diff = [
			'--- a/scripts/file-size-budget.json',
			'+++ b/scripts/file-size-budget.json',
			'-  "src/foo.ts": 50,',
			'+  "src/foo.ts": 80,',
		].join('\n');
		const raised = findRaisedCeilings(diff);
		expect(raised).toHaveLength(1);
		expect(raised[0]!.path).toBe('src/foo.ts');
	});

	test('mixed raised and lowered: only raised are returned', () => {
		const diff = [
			'--- a/scripts/file-size-budget.json',
			'+++ b/scripts/file-size-budget.json',
			'-  "src/a.ts": 100,',
			'+  "src/a.ts": 200,',
			'-  "src/b.ts": 500,',
			'+  "src/b.ts": 300,',
		].join('\n');
		const raised = findRaisedCeilings(diff);
		expect(raised).toHaveLength(1);
		expect(raised[0]!.path).toBe('src/a.ts');
	});

	test('new key only in added (no old value): not returned as raised', () => {
		// A brand-new entry has no `-` counterpart, so it cannot be "raised".
		const diff = [
			'+  "src/new.ts": 50,',
		].join('\n');
		expect(findRaisedCeilings(diff)).toHaveLength(0);
	});
});
