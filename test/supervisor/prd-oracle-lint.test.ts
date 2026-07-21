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
//   zero-match-vacuous rule: flagged forms (US-003, CAM-381)
//   zero-match-vacuous rule: passing cases (US-003, CAM-381)
//   lintPrd: walks stories, carries storyId/command/ruleName/reason
//   lintPrd: criterion with no [oracle:] suffix yields no finding
//   lintPrd: reviewer-judgment / tmux-pty / no-oracle directives are skipped
//   oracle-lint-cases.txt fixture matrix: every row classifies as recorded (US-002, CAM-388)

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES, lintPrd } from '../../src/supervisor/prd-oracle-lint.ts';
import type { PrdShape } from '../../src/commands/status.ts';

const FIXTURE_PATH = 'test/fixtures/oracle-lint/oracle-lint-cases.txt';

// A row that wraps a shell interpreter's -c payload in DOUBLE quotes (as
// opposed to single quotes), e.g. `bash -c "..."` / `sh -c "..."`.
const DOUBLE_QUOTED_WRAPPER_RE = /(?:^|[\s/])(?:sh|bash|zsh|dash)\s+-c\s+"/;

function parseFixtureRows(text: string): string[][] {
	return text
		.trim()
		.split('\n')
		.filter((line) => line.length > 0 && !line.startsWith('#'))
		.map((line) => line.split(' :: '));
}

/**
 * Asserts the fixture matrix satisfies every required shape dimension.
 * Throws (via `expect`) on the first violated dimension, so a mutated/
 * narrowed copy of the fixture makes this function -- and any test built on
 * top of it -- fail loudly instead of silently passing.
 */
function assertFixtureShape(rows: string[][]): void {
	expect(rows.length).toBeGreaterThan(0);
	const doubleQuotedWrapperRows = rows.filter(([, , command]) =>
		DOUBLE_QUOTED_WRAPPER_RE.test(command ?? '')
	).length;
	const backslashEscapeRows = rows.filter(([, , command]) => (command ?? '').includes('\\')).length;
	expect(doubleQuotedWrapperRows).toBeGreaterThan(0);
	expect(backslashEscapeRows).toBeGreaterThan(0);
}

const GREP_RULE_NAME = 'grep-q-plus-list-files';
const FROZEN_COMPARAND_RULE_NAME = 'frozen-comparand';
const ROTATING_ARTIFACT_RULE_NAME = 'rotating-artifact-target';
const ZERO_MATCH_VACUOUS_RULE_NAME = 'zero-match-vacuous';

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

function findZeroMatchVacuousRule() {
	const rule = RULES.find((r) => r.name === ZERO_MATCH_VACUOUS_RULE_NAME);
	if (!rule) throw new Error('zero-match-vacuous rule missing from RULES');
	return rule;
}

// ---------------------------------------------------------------------------
// RULES: named-rules list shape
// ---------------------------------------------------------------------------

describe('RULES: named-rules list shape', () => {
	test('is an array of exactly four rules: grep-q-plus-list-files, frozen-comparand, rotating-artifact-target, zero-match-vacuous', () => {
		expect(RULES).toHaveLength(4);
		expect(RULES.map((r) => r.name)).toEqual([
			GREP_RULE_NAME,
			FROZEN_COMPARAND_RULE_NAME,
			ROTATING_ARTIFACT_RULE_NAME,
			ZERO_MATCH_VACUOUS_RULE_NAME,
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

	test('flags -ne against a literal integer', () => {
		const finding = rule.test('test $(wc -l < scripts/cam/patterns.md) -ne 3');
		expect(finding).not.toBeNull();
	});

	test('flags -gt against a literal integer (the CAM-377 shape)', () => {
		const finding = rule.test('test $(wc -l < scripts/cam/patterns.md) -gt 41');
		expect(finding).not.toBeNull();
	});

	test('flags -lt against a literal integer', () => {
		const finding = rule.test('test $(wc -l < scripts/cam/patterns.md) -lt 3');
		expect(finding).not.toBeNull();
	});

	test('flags != against a literal integer', () => {
		const finding = rule.test('test $(wc -l < scripts/cam/patterns.md) != 3');
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

	test('flags a mainbranch: ref, which is not the main token', () => {
		const finding = rule.test('test $(git grep -c PATTERN mainbranch:file.ts) -eq 1');
		expect(finding).not.toBeNull();
	});

	test('mixed-clause: flags a frozen comparand in one clause even when a DIFFERENT clause carries a live derivation (US-002, CAM-382: the one-token-excuses-three-comparands shape)', () => {
		const finding = rule.test(
			'test $(git show main:a.ts | wc -l) -ge 1 && test $(wc -l < b.ts) -eq 42'
		);
		expect(finding).not.toBeNull();
	});

	test('mixed-clause: flags a frozen comparand in a later clause even when an earlier clause carries a live `git diff main` derivation (US-002, CAM-382: excuse no longer leaks across `;`-separated clauses)', () => {
		const finding = rule.test("git diff main --quiet -- file.ts; test $? -eq 0");
		expect(finding).not.toBeNull();
	});

	test('flags when the only "main" token is a filename stem (main.ts), not a git-ref (US-001, CAM-386, Defect A)', () => {
		const finding = rule.test('test $(git grep -c PATTERN main.ts) -eq 3');
		expect(finding).not.toBeNull();
	});

	test('flags when the only "main" token is a filename stem under a directory (src/main.rs), not a git-ref (US-001, CAM-386, Defect A)', () => {
		const finding = rule.test('test $(git grep -c PATTERN src/main.rs) -eq 3');
		expect(finding).not.toBeNull();
	});

	test('flags a genuine unquoted -eq comparison nested inside a double-quoted command substitution, unaffected by the Defect B recursive quote-stripping (US-002, CAM-386/389)', () => {
		const finding = rule.test('echo "$(test $X -eq 41)"');
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

	test('does not flag when `git diff main` accompanies an integer in the SAME clause', () => {
		const finding = rule.test('test $(git diff main -- file.ts | wc -l) -eq 0');
		expect(finding).toBeNull();
	});

	test('mixed-clause: does not flag when EACH of two `&&`-joined clauses carries its own same-clause derivation-plus-floor (US-002, CAM-382)', () => {
		const finding = rule.test(
			'test $(git show main:a.ts | wc -l) -ge 1 && test $(git diff main -- b.ts | wc -l) -ge 1'
		);
		expect(finding).toBeNull();
	});

	test('does not flag when `git grep ... main` accompanies an integer', () => {
		const finding = rule.test("test $(git grep -c 'PATTERN' main -- file.ts) -ge 1");
		expect(finding).toBeNull();
	});

	test('does not flag a bare `git grep PATTERN main` tree grep (main at end of string, US-001, CAM-386)', () => {
		const finding = rule.test("test $(git grep -c 'PATTERN' main) -ge 1");
		expect(finding).toBeNull();
	});

	test('does not flag a `git grep PATTERN main:src/f.ts` ref (main followed by a colon, US-001, CAM-386)', () => {
		const finding = rule.test("test $(git grep -c 'PATTERN' main:src/f.ts) -ge 1");
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

	test('does not flag an operator embedded behind a second hyphen (--ge 5)', () => {
		const finding = rule.test('cmd --ge 5');
		expect(finding).toBeNull();
	});

	test('does not flag an operator embedded mid-token (foo-eq 42)', () => {
		const finding = rule.test('echo foo-eq 42');
		expect(finding).toBeNull();
	});

	test('does not flag an operator embedded mid-token behind a double-dash flag (--eq 7)', () => {
		const finding = rule.test('run --eq 7');
		expect(finding).toBeNull();
	});

	test('does not flag an operator embedded mid-token inside a command substitution (foo-eq 42)', () => {
		const finding = rule.test('test $(foo-eq 42)');
		expect(finding).toBeNull();
	});

	test('does not flag when a double-quoted command substitution nests inert single-quoted comparand-shaped data (Defect B, US-002, CAM-386/389: the recursive-strip false-positive)', () => {
		const finding = rule.test(String.raw`echo "$(grep -c 'X -eq 1' f.ts)"`);
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
// zero-match-vacuous rule: flagged forms (US-003, CAM-381)
// ---------------------------------------------------------------------------

describe('zero-match-vacuous rule: flagged forms', () => {
	const rule = findZeroMatchVacuousRule();

	test('flags an unguarded sed -n "${L}p" anchor fed by grep -n | head -1 | cut', () => {
		const finding = rule.test(
			'L=$(grep -n PATTERN FILE | head -1 | cut -d: -f1); sed -n "${L}p" FILE | grep -q SOMETHING'
		);
		expect(finding).not.toBeNull();
		expect(finding!.reason).toContain('sed');
	});

	test('flags an unguarded sed anchor with a different variable name (LINE)', () => {
		const finding = rule.test(
			'LINE=$(grep -n X F | head -1 | cut -d: -f1); sed -n "${LINE}p" F | grep -q Y'
		);
		expect(finding).not.toBeNull();
	});

	test('flags a sed anchor guarded only by an -n check on a DIFFERENT variable', () => {
		const finding = rule.test(
			'L=$(grep -n PATTERN FILE | head -1 | cut -d: -f1); test -n "$OTHER"; sed -n "${L}p" FILE | grep -q X'
		);
		expect(finding).not.toBeNull();
	});

	test('flags a grep-fed while read loop with no count guard', () => {
		const finding = rule.test(
			'grep -n PATTERN FILE | while read -r n; do check "$n" || exit 1; done'
		);
		expect(finding).not.toBeNull();
		expect(finding!.reason).toContain('while read');
	});

	test('flags a grep-fed while read loop without -r and a different loop body', () => {
		const finding = rule.test('grep -n PATTERN FILE | while read line; do echo "$line"; done');
		expect(finding).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// zero-match-vacuous rule: passing cases (US-003, CAM-381)
// ---------------------------------------------------------------------------

describe('zero-match-vacuous rule: passing cases', () => {
	const rule = findZeroMatchVacuousRule();

	test('does not flag a sed anchor guarded by test -n "$L" for the same variable', () => {
		const finding = rule.test(
			'L=$(grep -n PATTERN FILE | head -1 | cut -d: -f1); test -n "$L" && sed -n "${L}p" FILE | grep -q X'
		);
		expect(finding).toBeNull();
	});

	test('does not flag a sed anchor guarded by [ -n "$L" ] bracket form', () => {
		const finding = rule.test(
			'L=$(grep -n PATTERN FILE | head -1 | cut -d: -f1); [ -n "$L" ] && sed -n "${L}p" FILE | grep -q X'
		);
		expect(finding).toBeNull();
	});

	test('does not flag a grep-fed while read loop guarded by a grep -c ... -ge 1 count check', () => {
		const finding = rule.test(
			'test $(grep -c PATTERN FILE) -ge 1 && grep -n PATTERN FILE | while read -r n; do check "$n"; done'
		);
		expect(finding).toBeNull();
	});

	test('does not flag a sed -n command with a literal line number, not an empty-anchor pattern', () => {
		const finding = rule.test("sed -n '5p' FILE | grep -q X");
		expect(finding).toBeNull();
	});

	test('does not flag a while read loop fed by something other than grep -n', () => {
		const finding = rule.test('cat FILE | while read -r line; do echo "$line"; done');
		expect(finding).toBeNull();
	});

	test('does not flag a command with neither shape at all', () => {
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

// ---------------------------------------------------------------------------
// oracle-lint-cases.txt fixture matrix (US-002, CAM-388)
// ---------------------------------------------------------------------------
//
// Drives every row of the tracked fixture through the matching named rule
// and asserts it classifies as its recorded expectation, so a future story
// that narrows the fixture matrix (or a regex change that misclassifies a
// row) fails `bun test`, not just the review-time oracle re-run.

describe('oracle-lint-cases.txt fixture matrix', () => {
	test('every row classifies as its recorded ok/flag expectation', async () => {
		const text = await Bun.file(FIXTURE_PATH).text();
		const rows = parseFixtureRows(text);

		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) {
			const [ruleName, expected, command] = row;
			if (ruleName === undefined || expected === undefined || command === undefined) {
				throw new Error(`malformed fixture row (expected "rule :: verdict :: command"): ${JSON.stringify(row)}`);
			}
			const rule = RULES.find((r) => r.name === ruleName);
			if (!rule) {
				throw new Error(`fixture row names unknown rule "${ruleName}": ${JSON.stringify(row)}`);
			}
			const got = rule.test(command) ? 'flag' : 'ok';
			expect({ ruleName, command, got }).toEqual({ ruleName, command, got: expected });
		}
	});
});

// ---------------------------------------------------------------------------
// oracle-lint-cases.txt fixture-shape guard (US-003, CAM-382)
// ---------------------------------------------------------------------------
//
// Extends the fixture matrix's shape guard beyond "at least one row exists":
// it now also requires at least one double-quoted interpreter-wrapper row
// (`bash -c "..."` / `sh -c "..."`) and at least one backslash-escape row,
// and ASSERTS on those counts rather than merely computing them. The
// mutation-sweep test proves the guard is not vacuous: stripping every
// double-quoted-wrapper row out of a temp copy of the fixture must make the
// guard fail.

describe('oracle-lint-cases.txt fixture-shape guard', () => {
	test('the tracked fixture has at least one double-quoted-wrapper row and at least one backslash-escape row', async () => {
		const text = await Bun.file(FIXTURE_PATH).text();
		const rows = parseFixtureRows(text);
		assertFixtureShape(rows);
	});

	test('mutation sweep: stripping every double-quoted-wrapper row out of a temp copy makes the shape guard fail (falsifiability)', async () => {
		const text = await Bun.file(FIXTURE_PATH).text();
		const lines = text.split('\n');
		let strippedCount = 0;
		const mutatedLines = lines.filter((line) => {
			if (line.length === 0 || line.startsWith('#')) return true;
			const command = line.split(' :: ')[2] ?? '';
			if (DOUBLE_QUOTED_WRAPPER_RE.test(command)) {
				strippedCount++;
				return false;
			}
			return true;
		});

		// Print the stripped-row count so a zero-mutation run is visibly
		// vacuous, and assert it's non-zero so this sweep can never silently
		// mutate nothing while still reporting a pass.
		console.log(`mutation sweep: stripped ${strippedCount} double-quoted-wrapper row(s)`);
		expect(strippedCount).toBeGreaterThan(0);

		const dir = mkdtempSync(join(tmpdir(), 'cam-oracle-lint-shape-mutation-'));
		const mutatedPath = join(dir, 'oracle-lint-cases.mutated.txt');
		try {
			writeFileSync(mutatedPath, mutatedLines.join('\n'));
			const mutatedText = await Bun.file(mutatedPath).text();
			const mutatedRows = parseFixtureRows(mutatedText);
			expect(() => assertFixtureShape(mutatedRows)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
