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
//   frozen-comparand rule: flagged forms (US-001, CAM-381)
//   frozen-comparand rule: passing cases (US-001, CAM-381)
//   rotating-artifact-target rule: flagged forms (US-002, CAM-381)
//   rotating-artifact-target rule: passing cases (US-002, CAM-381)
//   lintPrd: walks stories, carries storyId/command/ruleName/reason
//   lintPrd: criterion with no [oracle:] suffix yields no finding
//   lintPrd: reviewer-judgment / tmux-pty / no-oracle directives are skipped

import { describe, expect, test } from 'bun:test';
import { RULES, lintPrd } from '../../src/supervisor/prd-oracle-lint.ts';
import type { PrdShape } from '../../src/commands/status.ts';

const GREP_RULE_NAME = 'grep-q-plus-list-files';
const FROZEN_COMPARAND_RULE_NAME = 'frozen-comparand';
const ROTATING_ARTIFACT_RULE_NAME = 'rotating-artifact-target';

function findGrepRule() {
	const rule = RULES.find((r) => r.name === GREP_RULE_NAME);
	if (!rule) throw new Error('grep-q-plus-list-files rule missing from RULES');
	return rule;
}

function findFrozenComparandRule() {
	const rule = RULES.find((r) => r.name === FROZEN_COMPARAND_RULE_NAME);
	if (!rule) throw new Error('frozen-comparand rule missing from RULES');
	return rule;
}

function findRotatingArtifactRule() {
	const rule = RULES.find((r) => r.name === ROTATING_ARTIFACT_RULE_NAME);
	if (!rule) throw new Error('rotating-artifact-target rule missing from RULES');
	return rule;
}

// ---------------------------------------------------------------------------
// RULES: named-rules list shape
// ---------------------------------------------------------------------------

describe('RULES: named-rules list shape', () => {
	test('is an array of exactly three rules: grep-q-plus-list-files, frozen-comparand, rotating-artifact-target', () => {
		expect(RULES).toHaveLength(3);
		expect(RULES.map((r) => r.name)).toEqual([
			GREP_RULE_NAME,
			FROZEN_COMPARAND_RULE_NAME,
			ROTATING_ARTIFACT_RULE_NAME,
		]);
		for (const rule of RULES) {
			expect(typeof rule.test).toBe('function');
		}
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
// frozen-comparand rule: flagged forms (US-001, CAM-381)
// ---------------------------------------------------------------------------

describe('frozen-comparand rule: flagged forms', () => {
	const rule = findFrozenComparandRule();

	test('flags -eq against a literal integer with no live derivation', () => {
		const finding = rule.test('test $(wc -l < scripts/cam/patterns.md) -eq 42');
		expect(finding).not.toBeNull();
		expect(finding!.reason).toContain('literal integer');
	});

	test('flags -ge against a literal integer', () => {
		const finding = rule.test("[ $(git grep -c 'TODO' src/foo.ts) -ge 5 ]");
		expect(finding).not.toBeNull();
	});

	test('flags -le against a literal integer', () => {
		const finding = rule.test('[ $(cat file.ts | wc -l) -le 100 ]');
		expect(finding).not.toBeNull();
	});

	test('flags == against a literal integer', () => {
		const finding = rule.test('[[ $(some_count) == 7 ]]');
		expect(finding).not.toBeNull();
	});

	test('flags a wc -l pipeline frozen against HEAD, not main (git show present but not main)', () => {
		const finding = rule.test('test $(git show HEAD:file.ts | wc -l) -eq 88');
		expect(finding).not.toBeNull();
	});

	test('flags -eq even when git diff is present but not scoped to main', () => {
		const finding = rule.test('test $(git diff --stat | wc -l) -eq 3');
		expect(finding).not.toBeNull();
	});

	test('flags -eq even when git grep is present but never mentions main', () => {
		const finding = rule.test("test $(git grep -c 'PATTERN' -- file.ts) -eq 1");
		expect(finding).not.toBeNull();
	});

	test('does not match main by literal substring -- mainbranch is not the main token', () => {
		const finding = rule.test('test $(git grep -c PATTERN mainbranch:file.ts) -eq 1');
		expect(finding).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// frozen-comparand rule: passing cases (US-001, CAM-381)
// ---------------------------------------------------------------------------

describe('frozen-comparand rule: passing cases', () => {
	const rule = findFrozenComparandRule();

	test('does not flag when a live `git show main:` derivation accompanies an integer', () => {
		const finding = rule.test(
			"test $(git show main:file.ts | wc -l) -ge 1 && test $(wc -l < file.ts) -eq $(git show main:file.ts | wc -l)"
		);
		expect(finding).toBeNull();
	});

	test('does not flag when `git diff main` accompanies an integer', () => {
		const finding = rule.test("git diff main --quiet -- file.ts; test $? -eq 0");
		expect(finding).toBeNull();
	});

	test('does not flag when `git grep ... main` accompanies an integer', () => {
		const finding = rule.test("test $(git grep -c 'PATTERN' main -- file.ts) -ge 1");
		expect(finding).toBeNull();
	});

	test('does not flag a command with no integer comparand at all', () => {
		const finding = rule.test('bun run typecheck');
		expect(finding).toBeNull();
	});

	test('does not flag a plain grep -q command', () => {
		const finding = rule.test("grep -q 'PATTERN' file.ts");
		expect(finding).toBeNull();
	});

	test('does not flag a fully live comparison of two `git show main:`-derived values', () => {
		const finding = rule.test(
			'test $(git show main:file.ts | wc -l) -eq $(wc -l < file.ts)'
		);
		expect(finding).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// rotating-artifact-target rule: flagged forms (US-002, CAM-381)
// ---------------------------------------------------------------------------

describe('rotating-artifact-target rule: flagged forms', () => {
	const rule = findRotatingArtifactRule();

	test('flags a plain grep -q against scripts/cam/handoff.json', () => {
		const finding = rule.test("grep -q 'self-nullifying-oracle' scripts/cam/handoff.json");
		expect(finding).not.toBeNull();
		expect(finding!.reason).toContain('ROTATING');
	});

	test('flags a file-assert negated absence check against scripts/cam/handoff.json', () => {
		const finding = rule.test("! grep -q 'stale-token' scripts/cam/handoff.json");
		expect(finding).not.toBeNull();
	});

	test('flags scripts/cam/handoff.json quoted inside a larger pipeline', () => {
		const finding = rule.test('cat "scripts/cam/handoff.json" | grep -c retryBaseMs');
		expect(finding).not.toBeNull();
	});

	test('flags a grep against the reviewer capture-pane artifact scripts/cam/review-artifact.txt', () => {
		const finding = rule.test("grep -q 'CLEAN' scripts/cam/review-artifact.txt");
		expect(finding).not.toBeNull();
	});

	test('flags scripts/cam/review-artifact.txt embedded in a named-command test check', () => {
		const finding = rule.test(
			"test -f scripts/cam/review-artifact.txt && grep -q 'verdict' scripts/cam/review-artifact.txt"
		);
		expect(finding).not.toBeNull();
	});

	test('flags a wc -l comparison against scripts/cam/handoff.json', () => {
		const finding = rule.test('test $(wc -l < scripts/cam/handoff.json) -ge 1');
		expect(finding).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// rotating-artifact-target rule: passing cases (US-002, CAM-381)
// ---------------------------------------------------------------------------

describe('rotating-artifact-target rule: passing cases', () => {
	const rule = findRotatingArtifactRule();

	test('does not flag an oracle targeting a durable tracked source file', () => {
		const finding = rule.test("grep -q 'ROTATING_ARTIFACT_RULE' src/supervisor/prd-oracle-lint.ts");
		expect(finding).toBeNull();
	});

	test('does not flag an oracle targeting a durable tracked test file', () => {
		const finding = rule.test(
			"grep -q 'rotating-artifact-target' test/supervisor/prd-oracle-lint.test.ts"
		);
		expect(finding).toBeNull();
	});

	test('does not flag an oracle targeting scripts/cam/patterns.md (durable, versioned)', () => {
		const finding = rule.test("grep -q 'never target' scripts/cam/patterns.md");
		expect(finding).toBeNull();
	});

	test('does not flag a command with no file reference at all', () => {
		const finding = rule.test('bun run typecheck');
		expect(finding).toBeNull();
	});

	test('does not flag scripts/cam/review-report.json, the structured (non-rotating-target) sibling file', () => {
		const finding = rule.test("grep -q 'CLEAN' scripts/cam/review-report.json");
		expect(finding).toBeNull();
	});

	test('does not flag the string "handoff.json" without the scripts/cam/ prefix', () => {
		const finding = rule.test("grep -q 'handoff.json' README.md");
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
