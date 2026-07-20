// src/supervisor/prd-oracle-lint.ts
//
// Pure PRD-oracle linter (US-001, CAM-310 PRD).
//
// Scans a PRD's acceptanceCriteria oracle shell strings for known-broken
// oracle idioms, deterministically, without an LLM auditor pass. Three rules:
//   - grep-q-plus-list-files: catches the self-nullifying `grep -q` + `-L`/`-l`
//     idiom documented empirically in patterns.md (CAM-301/CAM-309): combining
//     the quiet flag with a list-files flag silently negates the intended
//     absence/presence assertion, regardless of flag order, spacing, or bundling.
//   - frozen-comparand: catches an oracle comparing against a literal integer
//     read off main with no live re-derivation token, enforcing the
//     derive-don't-freeze rule (patterns.md:903), US-001 CAM-381.
//   - rotating-artifact-target: catches an oracle asserting against a
//     per-story ROTATING harness state file (scripts/cam/handoff.json or the
//     reviewer's gitignored capture-pane artifact), enforcing the
//     never-target-a-rotating-artifact rule (patterns.md:907), US-002 CAM-381.
//
// Design (mirrors scripts/check-test-sleeps.ts's pure-scanner shape):
//   - Rules are a named-rules list: array of { name, test(command): finding | null }.
//     Adding a future rule is a one-liner: push another entry onto RULES.
//   - The walk reuses parseOracleDirectives (behavioral-gate.ts) to extract the
//     runnable oracle command string per criterion; never re-implements oracle
//     parsing.
//   - Pure, no I/O: the walk consumes an already-parsed PrdShape (the same
//     minimal read-model status.ts uses), never reads a file itself.
//
// Usage: lintPrd(prd) -> PrdOracleLintFinding[]

import { parseOracleDirectives } from './behavioral-gate.ts';
import type { PrdShape } from '../commands/status.ts';

// ---------------------------------------------------------------------------
// Rule types
// ---------------------------------------------------------------------------

/** Returned by a rule's test() when the command trips that rule. */
export interface RuleFinding {
	/** Human-readable why-broken description. */
	reason: string;
}

/**
 * One named rule in the scanner's named-rules list: { name, test(command) }.
 * test() returns a RuleFinding when the command trips the rule, else null.
 */
export interface OracleLintRule {
	name: string;
	test(command: string): RuleFinding | null;
}

/** One finding surfaced by lintPrd: story id + offending command + rule + why. */
export interface PrdOracleLintFinding {
	/** The userStory id the offending criterion belongs to. */
	storyId: string;
	/** The offending oracle command string (the parsed directive's .command). */
	command: string;
	/** The name of the rule that flagged this command. */
	ruleName: string;
	/** Human-readable why-broken description. */
	reason: string;
}

// ---------------------------------------------------------------------------
// grep-q-plus-list-files rule
// ---------------------------------------------------------------------------

/**
 * Matches the `grep` word so we can walk the flag tokens that immediately
 * follow each invocation (handles multiple grep calls in one pipeline).
 */
const GREP_WORD_RE = /\bgrep\b/g;

/** A short-option flag group: a leading '-' followed by one or more letters. */
const SHORT_FLAG_GROUP_RE = /^-[A-Za-z]+$/;

/**
 * Collect every flag letter attached to the grep invocation starting at
 * `grepEnd` (the index right after the matched "grep" word) in `command`.
 * Walks whitespace-separated tokens, consuming consecutive short-flag groups
 * (bundled or separate, in any order) and stopping at the first token that
 * isn't a short-flag group (the pattern/file argument, or end of string).
 *
 * No full shell tokenizer: this is intentionally regex/token-based, matching
 * the general flag CLASS, never a literal substring like '-Lq'.
 */
function collectGrepFlagChars(command: string, grepEnd: number): Set<string> {
	const rest = command.slice(grepEnd).trimStart();
	const tokens = rest.length === 0 ? [] : rest.split(/\s+/);
	const chars = new Set<string>();

	for (const token of tokens) {
		if (!SHORT_FLAG_GROUP_RE.test(token)) break;
		for (const ch of token.slice(1)) chars.add(ch);
	}

	return chars;
}

/**
 * True when a single grep invocation's flags include BOTH the quiet flag (q)
 * AND a list-files flag (L or l), in any order/spacing/bundling.
 */
function hasConflictingGrepFlags(command: string): boolean {
	GREP_WORD_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = GREP_WORD_RE.exec(command)) !== null) {
		const grepEnd = match.index + match[0].length;
		const flagChars = collectGrepFlagChars(command, grepEnd);
		if (flagChars.has('q') && (flagChars.has('L') || flagChars.has('l'))) {
			return true;
		}
	}
	return false;
}

/**
 * The grep-q-plus-list-files rule: flags a grep invocation whose flags
 * combine -q (quiet) with -L/-l (list-files), the self-nullifying idiom
 * documented in patterns.md (CAM-301/CAM-309). The correct absence idiom
 * ('! grep -q PATTERN file') carries no -L/-l flag and is never flagged.
 */
const GREP_Q_LIST_FILES_RULE: OracleLintRule = {
	name: 'grep-q-plus-list-files',
	test(command: string): RuleFinding | null {
		if (!hasConflictingGrepFlags(command)) return null;
		return {
			reason:
				"grep invocation combines the quiet flag -q with a list-files flag -L/-l " +
				"(any order/spacing/bundling: -Lq, -qL, -lq, -ql, -L -q, -l -q all match); " +
				"-q silently nullifies -L/-l's inversion so the exit code mirrors plain " +
				"match-found, not absence-of-match -- use '! grep -q PATTERN file' to " +
				"assert absence, or plain 'grep -q PATTERN file' to assert presence",
		};
	},
};

// ---------------------------------------------------------------------------
// frozen-comparand rule
// ---------------------------------------------------------------------------

/**
 * Matches a shell numeric-test operator (-eq/-ge/-le) or the `==` string-test
 * operator immediately followed by a literal integer (a frozen comparand).
 * A `wc -l` (or any other) pipeline compared this way is caught by the same
 * pattern: the regex targets the operator+literal pair, not the left-hand
 * side, so it doesn't matter what produced the left-hand value.
 */
const INTEGER_COMPARAND_RE = /(?:-eq|-ge|-le|==)\s*\d+\b/;

/**
 * A live re-derivation token: the comparand is (at least in part) recomputed
 * against `main` at check time rather than frozen once during authoring.
 * Matches `git show main:<path>`, `git diff main`, or any `git grep ...`
 * invocation that also mentions `main`.
 */
const LIVE_DERIVATION_RE = /git\s+show\s+main:|git\s+diff\s+main\b|git\s+grep\b[^\n]*\bmain\b/;

/**
 * True when `command` compares against a literal integer via -eq/-ge/-le/==
 * with no live `main`-re-derivation token present anywhere in the command.
 */
function hasFrozenIntegerComparand(command: string): boolean {
	if (!INTEGER_COMPARAND_RE.test(command)) return false;
	return !LIVE_DERIVATION_RE.test(command);
}

/**
 * The frozen-comparand rule (US-001, CAM-381): flags an oracle comparing
 * against a literal integer read off main with no live re-derivation token,
 * enforcing the derive-don't-freeze rule (patterns.md:903). A comparand that
 * carries a live `git show main:` / `git diff main` / `git grep ... main`
 * derivation alongside an integer is never flagged: the presence of the live
 * token is what proves the comparand is re-derived at check time, not frozen.
 */
const FROZEN_COMPARAND_RULE: OracleLintRule = {
	name: 'frozen-comparand',
	test(command: string): RuleFinding | null {
		if (!hasFrozenIntegerComparand(command)) return null;
		return {
			reason:
				'oracle compares against a literal integer (-eq/-ge/-le/== N, or a ' +
				"'wc -l'-style pipeline compared the same way) with no live " +
				"re-derivation token ('git show main:<path>', 'git diff main', or " +
				"'git grep ... main') anywhere in the command -- a frozen literal " +
				'rots silently the moment a later commit edits the compared file on ' +
				'main; re-derive the comparand at check time instead (patterns.md:903)',
		};
	},
};

// ---------------------------------------------------------------------------
// rotating-artifact-target rule
// ---------------------------------------------------------------------------

/**
 * The fixed literal list of per-story ROTATING harness state files
 * (patterns.md:907): each is overwritten every story/review cycle, so an
 * oracle asserting against one passes or fails by coincidence of whichever
 * story's rotation happens to be at HEAD, not by the story under review's
 * actual correctness. `scripts/cam/handoff.json` is overwritten by every
 * implementer story; `scripts/cam/review-artifact.txt` is the reviewer's
 * gitignored Layer B capture-pane exit file (patterns.md:224), consumed-once
 * per review round. Matches the literal path substring anywhere in the
 * command (quoted, unquoted, or embedded in a larger shell pipeline) since
 * the target set is a fixed literal list, not a general path pattern.
 */
const ROTATING_ARTIFACT_TARGET_RE = /scripts\/cam\/(?:handoff\.json|review-artifact\.txt)/;

/**
 * True when `command` asserts against one of the fixed rotating-artifact
 * targets above.
 */
function targetsRotatingArtifact(command: string): boolean {
	return ROTATING_ARTIFACT_TARGET_RE.test(command);
}

/**
 * The rotating-artifact-target rule (US-002, CAM-381): flags an oracle
 * asserting against a per-story rotating harness state file, enforcing the
 * never-target-a-rotating-artifact rule (patterns.md:907). A criterion
 * needing to attest that some text was produced must point at a durable
 * surface instead: the edited file itself, or a fact recoverable from
 * tracked source/test files.
 */
const ROTATING_ARTIFACT_RULE: OracleLintRule = {
	name: 'rotating-artifact-target',
	test(command: string): RuleFinding | null {
		if (!targetsRotatingArtifact(command)) return null;
		return {
			reason:
				'oracle asserts against a per-story ROTATING harness state file ' +
				'(scripts/cam/handoff.json or scripts/cam/review-artifact.txt) -- both ' +
				'are overwritten every story/review cycle, so a criterion pointing at ' +
				"either one passes or fails by coincidence of whichever story's " +
				"rotation happens to be at HEAD, not by the story's actual correctness; " +
				'point the oracle at a durable tracked source/test file instead ' +
				'(patterns.md:907)',
		};
	},
};

/**
 * The named-rules list (array of { name, test(command): finding | null }).
 * Adding a future rule is a one-liner: push another OracleLintRule here.
 */
export const RULES: OracleLintRule[] = [
	GREP_Q_LIST_FILES_RULE,
	FROZEN_COMPARAND_RULE,
	ROTATING_ARTIFACT_RULE,
];

// ---------------------------------------------------------------------------
// PRD walk
// ---------------------------------------------------------------------------

/**
 * Apply every rule to one story's acceptanceCriteria[], returning the
 * findings for that story only. Extracted from lintPrd to keep its
 * cognitive complexity within the lint budget.
 */
function lintStoryCriteria(storyId: string, criteria: string[]): PrdOracleLintFinding[] {
	const findings: PrdOracleLintFinding[] = [];
	const criterionOracles = parseOracleDirectives(criteria);

	for (const { directive } of criterionOracles) {
		if (directive.kind !== 'named-command' && directive.kind !== 'file-assert') continue;
		const command = directive.command;

		for (const rule of RULES) {
			const finding = rule.test(command);
			if (finding !== null) {
				findings.push({ storyId, command, ruleName: rule.name, reason: finding.reason });
			}
		}
	}

	return findings;
}

/**
 * Walk every userStory's acceptanceCriteria[], extracting each criterion's
 * [oracle: ...] directive via parseOracleDirectives and applying every rule
 * to named-command / file-assert oracle commands. Criteria with no oracle,
 * or a reviewer-judgment / tmux-pty directive, are skipped (no .command to
 * scan). Pure: no I/O, consumes the already-parsed PrdShape read-model.
 */
export function lintPrd(prd: PrdShape): PrdOracleLintFinding[] {
	const findings: PrdOracleLintFinding[] = [];
	const stories = prd.userStories ?? [];

	for (const story of stories) {
		findings.push(...lintStoryCriteria(story.id, story.acceptanceCriteria ?? []));
	}

	return findings;
}
