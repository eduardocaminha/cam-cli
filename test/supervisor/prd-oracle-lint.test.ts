// test/supervisor/prd-oracle-lint.test.ts
//
// Unit tests for src/supervisor/prd-oracle-lint.ts (US-001, CAM-310 PRD).
//
// All tests hit real oracle strings with no I/O (pure functions, in-memory
// PrdShape fixtures only).
//
// Coverage:
//   RULES: named-rules list shape (name + test)
//   grep-q-plus-list-files rule: six flagged grep forms
//   grep-q-plus-list-files rule: four passing grep/non-grep cases
//   lintPrd: walks stories, carries storyId/command/ruleName/reason
//   lintPrd: criterion with no [oracle:] suffix yields no finding
//   lintPrd: reviewer-judgment / tmux-pty / no-oracle directives are skipped

import { describe, expect, test } from 'bun:test';
import { RULES, lintPrd } from '../../src/supervisor/prd-oracle-lint.ts';
import type { PrdShape } from '../../src/commands/status.ts';

const GREP_RULE_NAME = 'grep-q-plus-list-files';

function findGrepRule() {
	const rule = RULES.find((r) => r.name === GREP_RULE_NAME);
	if (!rule) throw new Error('grep-q-plus-list-files rule missing from RULES');
	return rule;
}

// ---------------------------------------------------------------------------
// RULES: named-rules list shape
// ---------------------------------------------------------------------------

describe('RULES: named-rules list shape', () => {
	test('is an array of exactly one rule: grep-q-plus-list-files', () => {
		expect(RULES).toHaveLength(1);
		expect(RULES[0]!.name).toBe(GREP_RULE_NAME);
		expect(typeof RULES[0]!.test).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// grep-q-plus-list-files rule: six flagged forms
// ---------------------------------------------------------------------------

describe('grep-q-plus-list-files rule: flagged forms', () => {
	const rule = findGrepRule();

	test('flags -Lq bundled', () => {
		const finding = rule.test("grep -Lq 'PATTERN' file");
		expect(finding).not.toBeNull();
		expect(finding!.reason).toContain('-q');
	});

	test('flags -qL bundled, reversed order', () => {
		const finding = rule.test("grep -qL 'PATTERN' file");
		expect(finding).not.toBeNull();
	});

	test('flags -lq bundled', () => {
		const finding = rule.test("grep -lq 'PATTERN' file");
		expect(finding).not.toBeNull();
	});

	test('flags -ql bundled, reversed order', () => {
		const finding = rule.test("grep -ql 'PATTERN' file");
		expect(finding).not.toBeNull();
	});

	test('flags -L -q as two separate flag tokens', () => {
		const finding = rule.test("grep -L -q 'PATTERN' file");
		expect(finding).not.toBeNull();
	});

	test('flags -l -q as two separate flag tokens', () => {
		const finding = rule.test("grep -l -q 'PATTERN' file");
		expect(finding).not.toBeNull();
	});

	test('flags a bundled/reordered form with an extra flag interleaved (-qvL)', () => {
		const finding = rule.test("grep -qvL 'PATTERN' file");
		expect(finding).not.toBeNull();
	});

	test('does not match by literal substring -- catches the general class', () => {
		// -Ll has no 'q', must NOT be flagged even though it contains 'L'.
		const finding = rule.test("grep -Ll 'PATTERN' file");
		expect(finding).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// grep-q-plus-list-files rule: passing cases
// ---------------------------------------------------------------------------

describe('grep-q-plus-list-files rule: passing cases', () => {
	const rule = findGrepRule();

	test('correct absence idiom: ! grep -q PATTERN file passes', () => {
		const finding = rule.test("! grep -q 'PATTERN' file");
		expect(finding).toBeNull();
	});

	test('plain grep -q match assertion passes', () => {
		const finding = rule.test("grep -q 'PATTERN' file");
		expect(finding).toBeNull();
	});

	test('grep -L alone passes', () => {
		const finding = rule.test("grep -L 'PATTERN' file");
		expect(finding).toBeNull();
	});

	test('grep -l alone passes', () => {
		const finding = rule.test("grep -l 'PATTERN' file");
		expect(finding).toBeNull();
	});

	test('non-grep command passes', () => {
		const finding = rule.test('bun run typecheck');
		expect(finding).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// lintPrd: PRD walk
// ---------------------------------------------------------------------------

describe('lintPrd', () => {
	test('flags a story whose criterion oracle carries the broken idiom', () => {
		const prd: PrdShape = {
			userStories: [
				{
					id: 'US-999',
					title: 'broken oracle story',
					acceptanceCriteria: ["Some criterion. [oracle: grep -Lq 'X' path/to/file.ts]"],
				},
			],
		};
		const findings = lintPrd(prd);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.storyId).toBe('US-999');
		expect(findings[0]!.command).toBe("grep -Lq 'X' path/to/file.ts");
		expect(findings[0]!.ruleName).toBe(GREP_RULE_NAME);
		expect(findings[0]!.reason.length).toBeGreaterThan(0);
	});

	test('a criterion without an [oracle:] suffix yields no finding', () => {
		const prd: PrdShape = {
			userStories: [
				{
					id: 'US-001',
					title: 'no oracle',
					acceptanceCriteria: ['This criterion has no oracle directive at all.'],
				},
			],
		};
		expect(lintPrd(prd)).toHaveLength(0);
	});

	test('reviewer-judgment, tmux-pty, and no-oracle directives are skipped (no .command to scan)', () => {
		const prd: PrdShape = {
			userStories: [
				{
					id: 'US-002',
					title: 'non-runnable oracle kinds',
					acceptanceCriteria: [
						'Judged by a human. [oracle: reviewer-judgment]',
						'Driven by tmux. [oracle: tmux-pty some-artifact-ref]',
						'Malformed. [oracle: ]',
					],
				},
			],
		};
		expect(lintPrd(prd)).toHaveLength(0);
	});

	test('a clean story with a correct absence-idiom oracle yields no finding', () => {
		const prd: PrdShape = {
			userStories: [
				{
					id: 'US-003',
					title: 'clean story',
					acceptanceCriteria: ["Absent string. [oracle: ! grep -q 'REMOVED' src/foo.ts]"],
				},
			],
		};
		expect(lintPrd(prd)).toHaveLength(0);
	});

	test('walks multiple stories and multiple criteria, preserving story id per finding', () => {
		const prd: PrdShape = {
			userStories: [
				{
					id: 'US-A',
					title: 'a',
					acceptanceCriteria: ["Ok. [oracle: grep -q 'X' file.ts]"],
				},
				{
					id: 'US-B',
					title: 'b',
					acceptanceCriteria: [
						"Broken 1. [oracle: grep -ql 'X' file.ts]",
						"Broken 2. [oracle: grep -qL 'Y' other.ts]",
					],
				},
			],
		};
		const findings = lintPrd(prd);
		expect(findings).toHaveLength(2);
		expect(findings.every((f) => f.storyId === 'US-B')).toBe(true);
	});

	test('empty PRD (no userStories) yields no findings', () => {
		expect(lintPrd({})).toHaveLength(0);
	});
});
