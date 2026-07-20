// src/supervisor/prd-oracle-lint.ts
//
// Pure PRD-oracle linter (US-001, CAM-310 PRD).
//
// Scans a PRD's acceptanceCriteria oracle shell strings for known-broken
// oracle idioms, deterministically, without an LLM auditor pass. Four rules:
//   - grep-q-plus-list-files: catches the self-nullifying `grep -q` + `-L`/`-l`
//     idiom documented empirically in patterns.md (CAM-301/CAM-309): combining
//     the quiet flag with a list-files flag silently negates the intended
//     absence/presence assertion, regardless of flag order, spacing, or bundling.
//   - frozen-comparand: catches an oracle comparing against a literal integer
//     read off main with no live re-derivation token, enforcing the
//     derive-don't-freeze rule (patterns.md:903), US-001 CAM-381. Quote-aware
//     (US-001 CAM-388): a match sitting inside a quoted span (test-input
//     data, a grep search pattern) is ignored, except inside a shell
//     interpreter's `-c '<payload>'` wrapper (sh/bash/zsh/dash), whose
//     payload is unwrapped and still scanned; a non-interpreter command's
//     bare `-c` flag (`grep -c`, `npx tool -c`) is never treated as a
//     wrapper (US-R1-002 CAM-388). An unterminated quote is treated as
//     literal text rather than swallowing the rest of the command, and the
//     POSIX `'\''` single-quote escape idiom is recognized so it never fools
//     the span-close search (US-R1-001 CAM-388).
//   - rotating-artifact-target: catches an oracle asserting against a
//     per-story ROTATING harness state file (scripts/cam/handoff.json or the
//     reviewer's gitignored capture-pane artifact), enforcing the
//     never-target-a-rotating-artifact rule (patterns.md:907), US-002 CAM-381.
//   - zero-match-vacuous: catches an unguarded empty-$L sed line anchor or a
//     grep-fed while-read loop, either of which silently degrades to a
//     vacuous pass when the underlying grep search matches zero lines,
//     enforcing the unguarded-empty-anchor rule (patterns.md:901), US-003
//     CAM-381.
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
 * A shell-interpreter word (sh/bash/zsh/dash) immediately followed by a
 * `-c` flag, at the very end of the text preceding a quote (optionally
 * preceded by a path separator so `/bin/bash -c '...'` still matches).
 * Scoping the wrapper check to an actual interpreter word (rather than any
 * command's bare `-c` flag) is what CAM-388's US-R1-002 reviewer finding
 * required: a non-interpreter `-c` payload such as `grep -c 'test $X -eq
 * 41' file.ts` or `npx tool -c '...'` carries the same trailing-`-c'`
 * shape but is NOT a shell wrapper -- its quoted payload is inert data
 * (a grep search pattern), not a command to unwrap and re-scan.
 */
const SHELL_INTERPRETER_DASH_C_RE = /(?:^|[\s/])(?:sh|bash|zsh|dash)\s+-c\s*$/;

/**
 * True when the single/double quote starting at `quoteStart` in `command` is
 * a `-c '<payload>'` wrapper argument (e.g. `sh -c '...'`, `bash -c "..."`,
 * `/bin/bash -c '...'`): the text immediately preceding the quote, ignoring
 * trailing whitespace, ends in a recognized shell interpreter word followed
 * by the `-c` flag (see SHELL_INTERPRETER_DASH_C_RE above). Such payloads
 * must be UNWRAPPED (recursed into), never deleted, so a genuine live shell
 * comparison inside the wrapper keeps being detected (CAM-388). A `-c` flag
 * belonging to a non-interpreter command (`grep -c`, `npx tool -c`) is NOT a
 * wrapper and falls through to the ordinary quoted-span deletion path.
 */
function isDashCWrapper(command: string, quoteStart: number): boolean {
	return SHELL_INTERPRETER_DASH_C_RE.test(command.slice(0, quoteStart));
}

/**
 * The POSIX single-quote escape idiom: an apparent closing `'` immediately
 * followed by `\''` does NOT terminate the quoted span -- it's the standard
 * shell trick for embedding a literal `'` inside a single-quoted string
 * (`'foo'\''bar'` decodes to `foo'bar`: close, escaped literal quote,
 * reopen). Recognizing this continuation lets a single logical `-c` payload
 * spanning multiple escaped segments (e.g. `sh -c 'echo '\''hi'\''; test
 * $(wc -l < f) -eq 3'`) resolve to ONE quoted span ending at the true final
 * quote, instead of prematurely closing at the first embedded segment and
 * losing the rest of the payload to a non-wrapper (space-replaced) span
 * (CAM-388 US-R1-001).
 */
const SINGLE_QUOTE_ESCAPE_CONTINUATION = "\\''";

/**
 * Finds the index of the quote character that truly closes a span of
 * `quoteChar` opened just before `searchFrom`, skipping past any
 * `'\''` escape-continuation (see SINGLE_QUOTE_ESCAPE_CONTINUATION above)
 * immediately following a candidate closing quote, and, for a DOUBLE-quoted
 * span, past a backslash-escaped `\"` that does not terminate the span
 * either (US-R2-001, CAM-388). POSIX Shell Command Language 2.2.3: inside
 * double quotes a backslash retains its special (escaping) meaning only
 * when followed by `$`, backtick, `"`, `\`, or newline -- so `\"` inside
 * `"..."` is a literal embedded quote, not a close, e.g. `bash -c "echo
 * \"hi\"; test $(wc -l < f) -eq 3"` must resolve the wrapper's payload all
 * the way to the FINAL `"`, not the first `\"`. Whether a candidate closing
 * `"` is actually escaped depends on the parity of the run of backslashes
 * immediately preceding it: an odd run escapes it (skip past), an even run
 * is that many literal backslash pairs (the quote genuinely closes), e.g.
 * `\\"`  (escaped backslash + real close) must still close the span.
 * Single quotes have no backslash-escape meaning at all (only the `'\''`
 * continuation idiom applies to them), so this backslash-parity check is
 * scoped to `quoteChar === '"'` only. Returns -1 when no true closing quote
 * exists anywhere in `command` (an unterminated quote).
 */
function findClosingQuoteIndex(command: string, quoteChar: string, searchFrom: number): number {
	let from = searchFrom;
	while (true) {
		const idx = command.indexOf(quoteChar, from);
		if (idx === -1) return -1;

		if (quoteChar === "'") {
			const continuationStart = idx + 1;
			const continuationEnd = continuationStart + SINGLE_QUOTE_ESCAPE_CONTINUATION.length;
			if (command.slice(continuationStart, continuationEnd) === SINGLE_QUOTE_ESCAPE_CONTINUATION) {
				from = continuationEnd;
				continue;
			}
			return idx;
		}

		let backslashRun = 0;
		let j = idx - 1;
		while (j >= 0 && command[j] === '\\') {
			backslashRun++;
			j--;
		}
		if (backslashRun % 2 === 1) {
			from = idx + 1;
			continue;
		}
		return idx;
	}
}

/**
 * Finds every top-level `$(...)` command-substitution span inside `content`
 * (balanced-paren tracking, so a nested `$(...)` inside the substitution
 * doesn't truncate it early) and returns them concatenated with spaces,
 * discarding everything else (replaced with a space, never bare deletion,
 * same tokens-don't-fuse rule as stripQuotedSpans). Used by stripQuotedSpans
 * to preserve a command substitution's content when it sits inside a
 * DOUBLE-quoted span that is not a `-c` wrapper (US-R2-002, CAM-388): per
 * POSIX Shell Command Language 2.2.3, `"$(cmd)"` still executes `cmd` and
 * substitutes its output -- double quotes suppress word-splitting of the
 * result, not the substitution itself -- so a `$(...)` inside double quotes
 * is live shell syntax, never inert quoted data. Single quotes have no such
 * exception (`'$(cmd)'` is 100% literal text, no substitution happens), so
 * this helper is only ever applied to double-quoted span content.
 */
/**
 * Given `content[dollarIndex] === '$'` and `content[dollarIndex + 1] === '('`,
 * returns the index immediately past the `)` that balances the opening `(`
 * (balanced-paren depth counting, so a nested `$(...)` doesn't close early).
 * Falls off the end of `content` (returns `content.length`) for an
 * unterminated substitution. Split out of extractCommandSubstitutionSpans to
 * keep that function's cognitive complexity within the project's lint ceiling.
 */
function findCommandSubstitutionEnd(content: string, dollarIndex: number): number {
	let depth = 1;
	let j = dollarIndex + 2;
	while (j < content.length && depth > 0) {
		if (content[j] === '(') depth++;
		else if (content[j] === ')') depth--;
		j++;
	}
	return j;
}

function extractCommandSubstitutionSpans(content: string): string {
	let out = '';
	let i = 0;

	while (i < content.length) {
		if (content[i] === '$' && content[i + 1] === '(') {
			const end = findCommandSubstitutionEnd(content, i);
			out += ` ${content.slice(i, end)} `;
			i = end;
		} else {
			out += ' ';
			i++;
		}
	}

	return out;
}

/**
 * Strips single/double-quoted spans out of `command` before frozen-comparand
 * scanning, so an operator+integer byte pattern that is merely quoted TEST
 * DATA (a JS array literal element, a grep search pattern) is never mistaken
 * for a live shell comparison (CAM-388, the self-referential oracle trap: a
 * behavioral oracle about this very rule must embed comparison-shaped
 * strings as data, which the unstripped flat regex could not tell apart from
 * a real comparison). A shell interpreter's `-c '<payload>'` wrapper
 * argument is the one exception: its payload is UNWRAPPED (recursively
 * stripped and spliced back unquoted) rather than deleted, so `sh -c 'test
 * $(wc -l < f) -eq 3'` keeps flagging -- the quotes there wrap a real shell
 * command, not inert data. A non-interpreter command's bare `-c` flag
 * (`grep -c 'test $X -eq 41' file.ts`, `npx tool -c '...'`) is NOT a wrapper
 * (US-R1-002 CAM-388): its quoted payload is ordinary inert data and is
 * deleted like any other quoted span, never unwrapped and rescanned.
 * Every other quoted span is replaced with a single space (never simple
 * deletion) so tokens on either side of the span don't fuse into a new one
 * -- EXCEPT a non-wrapper DOUBLE-quoted span, whose `$(...)` command
 * substitution(s), if any, are preserved verbatim via
 * extractCommandSubstitutionSpans above rather than blanked (US-R2-002,
 * CAM-388): `test $(wc -l < "$(git show main:f.ts)") -eq 42` is not a `-c`
 * wrapper, but the `"$(git show main:f.ts)"` span still executes a live
 * `git show main:` re-derivation regardless of the surrounding double
 * quotes, so blanking it whole (the pre-US-R2-002 behavior) silently
 * destroyed the derivation token LIVE_DERIVATION_RE depends on, turning a
 * legitimately re-derived comparand into a false-positive frozen one. A
 * SINGLE-quoted span never gets this treatment -- `'$(...)'` performs no
 * substitution at all in POSIX shell, so its content is genuinely inert and
 * stays fully blanked.
 *
 * Two edge cases fixed by US-R1-001 (CAM-388, reviewer finding at
 * prd-oracle-lint.ts:200): a quote with no matching close is treated as
 * ordinary literal text (never consumed to end-of-string -- an unmatched
 * apostrophe is not proof the remainder of the command is quoted data), and
 * the `'\''` POSIX single-quote escape idiom is recognized via
 * findClosingQuoteIndex above so it doesn't fool the span-close search. A
 * third edge case fixed by US-R2-001 (CAM-388, reviewer finding at
 * prd-oracle-lint.ts:222): a backslash-escaped `\"` inside a DOUBLE-quoted
 * span (`bash -c "echo \"hi\"; test $(wc -l < f) -eq 3"`) does not close the
 * span either -- findClosingQuoteIndex now skips past it via a
 * backslash-run parity check, so a genuine live comparison later in a
 * double-quoted `-c` wrapper is no longer silently excused.
 */
function stripQuotedSpans(command: string): string {
	let out = '';
	let i = 0;

	while (i < command.length) {
		const ch = command[i];
		if (ch === "'" || ch === '"') {
			const closeIdx = findClosingQuoteIndex(command, ch, i + 1);
			if (closeIdx === -1) {
				out += ch;
				i++;
				continue;
			}
			const content = command.slice(i + 1, closeIdx);
			if (isDashCWrapper(command, i)) {
				out += ` ${stripQuotedSpans(content)} `;
			} else if (ch === '"') {
				out += extractCommandSubstitutionSpans(content);
			} else {
				out += ' ';
			}
			i = closeIdx + 1;
		} else {
			out += ch;
			i++;
		}
	}

	return out;
}

/**
 * True when `command` compares against a literal integer via -eq/-ge/-le/==
 * with no live `main`-re-derivation token present anywhere in the command.
 * Both regexes are run against the SAME quote-stripped text (see
 * stripQuotedSpans). A derivation token that lives inside a `-c` wrapper
 * payload, or inside a `$(...)` command substitution nested in a DOUBLE-quoted
 * span, still excuses the comparand, because stripQuotedSpans preserves both
 * (US-R2-002, CAM-388: a non-`-c` double-quoted `$(...)` still executes, so
 * blanking it whole would silently discard a live derivation token). A
 * derivation token that is merely quoted inert TEXT (single-quoted, or
 * double-quoted with no `$(...)`) does not survive stripping and does not
 * excuse the comparand -- exactly like a comparand that is merely quoted test
 * data never trips the rule in the first place.
 */
function hasFrozenIntegerComparand(command: string): boolean {
	const stripped = stripQuotedSpans(command);
	if (!INTEGER_COMPARAND_RE.test(stripped)) return false;
	return !LIVE_DERIVATION_RE.test(stripped);
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

// ---------------------------------------------------------------------------
// zero-match-vacuous rule
// ---------------------------------------------------------------------------

/**
 * Matches the unguarded empty-$L sed anchor shape (patterns.md:901):
 * `sed -n "${VAR}p" FILE` where VAR was derived from a grep/head/cut
 * pipeline capturing a line number. `sed -n "p" FILE` (an empty range, i.e.
 * VAR was empty) silently degrades to printing the WHOLE file instead of
 * failing, so any keyword-presence probe piped after it can be satisfied by
 * content anywhere in the file. Captures the variable name so the guard
 * check below can look for a `test -n "$VAR"` / `[ -n "$VAR" ]` guard
 * scoped to that exact same name, not just any -n guard in the command.
 */
const SED_LINE_ANCHOR_RE = /sed\s+-n\s+"\$\{([A-Za-z_][A-Za-z0-9_]*)\}p"/;

/**
 * True when `command` contains an unguarded empty-$L sed line anchor: the
 * anchor shape is present, and no `test -n "$VAR"` / `[ -n "$VAR" ]` guard
 * for that exact variable name precedes it anywhere in the command.
 */
function hasUnguardedSedLineAnchor(command: string): boolean {
	const match = SED_LINE_ANCHOR_RE.exec(command);
	if (match === null) return false;
	const varName = match[1];
	if (varName === undefined) return false;
	const guardRe = new RegExp(`(?:test\\s+-n|\\[\\s+-n)\\s+"\\$${varName}"`);
	return !guardRe.test(command);
}

/**
 * Matches a grep-fed `while read` loop: `grep -n PATTERN FILE | while read
 * ...`. Zero matches means zero loop iterations, so the pipeline silently
 * exits 0 (vacuously "passing") instead of failing when the searched-for
 * pattern is absent, unless the match count was verified first.
 */
const GREP_FED_WHILE_READ_RE = /grep\s+-n\b[^|]*\|\s*(?:[A-Za-z0-9_]+\s+)?while\s+read\b/;

/**
 * A count-check guard: an explicit `grep -c ... -ge N` (N >= 1) comparison
 * anywhere in the command, proving the caller verified at least one match
 * exists before trusting the while-read loop's silence as a pass.
 */
const GREP_COUNT_GUARD_RE = /grep\s+-c\b[^\n]*-ge\s*[1-9]/;

/**
 * True when `command` contains a grep-fed while-read loop with no
 * accompanying grep -c match-count guard anywhere in the command.
 */
function hasUnguardedGrepFedWhileRead(command: string): boolean {
	if (!GREP_FED_WHILE_READ_RE.test(command)) return false;
	return !GREP_COUNT_GUARD_RE.test(command);
}

/**
 * The zero-match-vacuous rule (US-003, CAM-381): flags an oracle whose
 * apparent single-line assertion silently degrades to a vacuous pass when
 * its underlying grep search matches zero lines, enforcing the
 * unguarded-empty-anchor rule (patterns.md:901). Two shapes are covered:
 * an unguarded `sed -n "${L}p"` anchor (empty range prints the whole file
 * instead of failing) and a grep-fed `while read` loop (zero matches means
 * zero iterations, so the loop's own failure checks never run).
 */
const ZERO_MATCH_VACUOUS_RULE: OracleLintRule = {
	name: 'zero-match-vacuous',
	test(command: string): RuleFinding | null {
		if (hasUnguardedSedLineAnchor(command)) {
			return {
				reason:
					'oracle derives a sed line anchor (sed -n "${VAR}p") from a grep/head/cut ' +
					'pipeline with no test -n "$VAR" / [ -n "$VAR" ] guard for that exact ' +
					'variable -- an empty VAR degrades sed -n "p" to printing the WHOLE file ' +
					"instead of failing, so a keyword-presence probe piped after it can be " +
					'satisfied by content anywhere in the file, returning GREEN exactly when ' +
					'the targeted anchor is absent (patterns.md:901)',
			};
		}
		if (hasUnguardedGrepFedWhileRead(command)) {
			return {
				reason:
					'oracle pipes grep -n into a while read loop with no accompanying grep -c ' +
					'match-count guard (-ge 1) -- zero matches means zero loop iterations, so ' +
					'the pipeline exits 0 vacuously instead of failing when the searched-for ' +
					'pattern is absent; check the match COUNT before trusting a while read ' +
					"loop's silence as a pass (patterns.md:901)",
			};
		}
		return null;
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
	ZERO_MATCH_VACUOUS_RULE,
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
