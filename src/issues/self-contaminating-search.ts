// src/issues/self-contaminating-search.ts
//
// Shared leaf detector for the self-contaminating-search oracle class
// (US-002, CAM-474): a recursive text search whose root descends into
// scripts/cam/issues turns the very act of FILING the issue (which writes
// the searched-for text as JSON under that path) into the mechanism that
// satisfies the criterion's own search, with zero implementation.
//
// Exported as one pure predicate so both the filing-time guardrail
// (validateSpec, src/issues/spec.ts, US-002) and the plan-time lint rule
// (src/supervisor/prd-oracle-lint.ts, US-003) share a single detection
// core: two parallel implementations would drift and let filing accept
// what plan time blocks, or the reverse (US-002 story notes).
//
// Pure lexical scan, no I/O: findStoreReachingSearch(command) walks the
// command text for a grep/egrep/fgrep/rg invocation and classifies its
// search root against the fixed store path scripts/cam/issues.
//
// Detection rules:
//   - A search invocation is RECURSIVE when it is grep/egrep/fgrep carrying
//     -r/-R (bundled or separate short flags, or --recursive, or -R's
//     documented long form --dereference-recursive), or when it is rg
//     (ripgrep is recursive by default -- no flag required).
//   - A root is STORE-REACHING when it is '.', or a directory-ancestor-of-
//     or-equal-to scripts/cam/issues ('scripts', 'scripts/cam',
//     'scripts/cam/issues', with or without a trailing slash), or when the
//     invocation carries NO positional root at all (a bare search defaults
//     to cwd). The ancestor test makes the file-vs-directory distinction
//     fall out for free: 'scripts/cam/patterns.md' is not an ancestor of
//     the store, so a single-file root under scripts stays legal even with
//     -r, and 'docs/adr/' is legal. An ABSOLUTE root is resolved the same
//     way: stripped of a leading cwd prefix and re-checked as a relative
//     root when it lives under the current working directory, or matched
//     by its store-path suffix (an absolute root ending in '/scripts',
//     '/scripts/cam', or '/scripts/cam/issues') otherwise, e.g. a search
//     rooted at another checkout of this repo (CAM-474 review round 1).
//   - An explicit '--exclude-dir=issues' (or '--exclude-dir issues')
//     anywhere in the invocation nullifies the finding for that invocation
//     regardless of its roots: this is the sanctioned safe-repair idiom
//     (CAM-460 AC2), and refusing it would break the very fix this
//     detector exists to enable.
//   - A tool-word match only starts an invocation when it is in COMMAND
//     POSITION: the start of `command`, or immediately preceded (ignoring
//     whitespace) by a clause separator ('|', '&', ';'), an opening paren
//     ('(' or the tail of '$(', including subshells), a backtick (the head
//     of a `` `...` `` command substitution), an opening quote (`'` or `"`)
//     whose OWN preceding token (ignoring whitespace) is the shell
//     interpreter's `-c` flag, i.e. the head of a `bash -c '...'` /
//     `sh -c "..."` command-string argument, or an allowlisted prefix word
//     (`xargs`, `env`, `sudo`, `time`, `command`) -- itself possibly
//     preceded by one or more flag/assignment tokens of its own (e.g.
//     `xargs -0 grep ...`, `env FOO=1 grep ...`) (CAM-474 review round 1 +
//     round 2: a bare \b(grep|rg)\b scan with no position check matched
//     inside an unrelated hyphenated token like 'gen-rg-report', a file
//     extension like 'docs/x.rg', a quoted search NEEDLE like
//     grep -q "rg" file, and an echoed word like `bash -c "echo rg"` --
//     all zero-search false positives; round 2 additionally found that this
//     project's own dominant oracle idiom, `bash -c '<search>'`, was itself
//     missed because an opening quote was not a recognized left-context
//     delimiter, and that `env`/`sudo`/`xargs -0`-style prefixes with an
//     intervening flag or assignment were missed too). The quote check is
//     scoped to a preceding `-c` specifically (not every opening quote)
//     because a quoted NEEDLE argument to an unrelated flag, e.g.
//     grep -q "rg" file, is also an opening quote immediately before a tool
//     word but is not an invocation. This check is deliberately
//     raw-text-based, not a full re-tokenization of `command`: a genuine
//     store-reaching search hidden inside a `$(grep ...)`
//     command-substitution wrapper (CAM-460 AC2's own shape) must still be
//     caught, and '(' immediately preceding the tool word covers that
//     without needing to parse the enclosing quotes.
//   - A positional token's trailing shell punctuation (an unbalanced ')',
//     a trailing backtick, or a trailing quote character) is stripped
//     before the token is treated as a root, because the space-free forms
//     of command substitution -- `$(grep -rl X scripts)` and
//     `` `grep -rl X scripts` `` -- leave that closing punctuation glued to
//     the final positional token with no intervening whitespace (CAM-474
//     review round 2): without this, 'scripts)' fails every root check
//     that 'scripts' would pass.
//
// NOT in scope for this detector: quote-stripping the surrounding command
// (a shell interpreter's -c wrapper, a JS probe string, etc). This scanner
// deliberately walks the raw command text, quote-aware only at the token
// level (a quoted span is one atomic token, so a quoted search pattern
// containing spaces or pipes does not fragment into false positional
// tokens). Multiple invocations in one command (e.g. piped through `| wc
// -l`) are each classified independently, stopping at the next clause
// separator.

/** The fixed store directory this detector protects. */
const STORE_PATH = 'scripts/cam/issues';

/**
 * Directory-ancestor-of-or-equal-to prefixes of STORE_PATH ('scripts',
 * 'scripts/cam', 'scripts/cam/issues'), used to match an absolute root that
 * is not under the current working directory by its trailing path segments
 * (see matchesStoreSuffix).
 */
const STORE_PATH_ANCESTOR_PREFIXES = STORE_PATH.split('/').map((_, i, segments) =>
	segments.slice(0, i + 1).join('/'),
);

/** Recognized recursive-by-tool-identity or recursive-flag-capable search tools. */
const SEARCH_TOOL_RE = /\b(grep|egrep|fgrep|rg)\b/g;

/** A clause separator, opening-paren, or backtick character allowed immediately before a tool word (see isCommandPosition). */
const COMMAND_POSITION_CHAR_RE = /[|&;(`]/;

/** The shell-interpreter flag ('-c') whose quoted argument is itself a command string, e.g. `bash -c '...'`. */
const SHELL_DASH_C_FLAG = '-c';

/**
 * Prefix words that make the following tool word command-position, e.g.
 * `xargs grep ...`, `env FOO=1 grep ...`, `sudo grep ...`. May themselves be
 * preceded by their own flag/assignment tokens (isCommandPosition walks
 * those away before checking membership here).
 */
const COMMAND_PREFIX_WORDS = new Set(['xargs', 'env', 'sudo', 'time', 'command']);

/** A `VAR=value`-shaped token, e.g. the `FOO=1` in `env FOO=1 grep ...`. */
const ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A short-option flag group: leading '-' followed by one or more letters. */
const SHORT_FLAG_GROUP_RE = /^-[A-Za-z]+$/;

/** A long-option flag: leading '--' followed by a name, optionally '=value'. */
const LONG_FLAG_RE = /^--[A-Za-z][A-Za-z-]*(?:=.*)?$/;

/** A shell redirection token ('2>', '>', '1>>', '2>/dev/null', ...): never a positional arg. */
const REDIRECTION_RE = /^\d*>{1,2}/;

/** A clause-separator token that ends the current invocation's argument list. */
const CLAUSE_END_RE = /^(?:\||&&|\|\||;)$/;

/** Strips a single layer of matching wrapping quotes (') or (") from a token, if present. */
function unquote(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === "'" || first === '"') && first === last) {
			return token.slice(1, -1);
		}
	}
	return token;
}

/** Counts occurrences of a single character in `s`. */
function countChar(s: string, ch: string): number {
	let n = 0;
	for (const c of s) if (c === ch) n++;
	return n;
}

/**
 * Strips trailing shell punctuation -- an unbalanced ')', a trailing
 * backtick, or a trailing quote character -- that a real invocation leaves
 * glued to its final positional token with no intervening whitespace, e.g.
 * `$(grep -rl X scripts)` tokenizes its root as 'scripts)', and
 * `` `grep -rl X scripts` `` tokenizes its root as 'scripts`' (CAM-474
 * review round 2). Only strips a trailing char that is UNMATCHED within the
 * token itself (an odd quote/backtick count, or more ')' than '(' overall),
 * so a root that legitimately balances one of these chars internally is
 * left untouched.
 */
function stripTrailingShellPunctuation(token: string): string {
	let result = token;
	for (;;) {
		const last = result.at(-1);
		if (last === ')') {
			if (countChar(result, ')') <= countChar(result, '(')) return result;
			result = result.slice(0, -1);
			continue;
		}
		if (last === '`' || last === "'" || last === '"') {
			if (countChar(result, last) % 2 === 0) return result;
			result = result.slice(0, -1);
			continue;
		}
		return result;
	}
}

/**
 * Tokenizes `segment` respecting single/double-quoted spans as atomic
 * tokens (so a quoted search pattern containing spaces, e.g.
 * "gh release create\|action-gh-release", does not fragment into multiple
 * false positional tokens). Whitespace outside quotes separates tokens.
 * An unterminated quote runs to end-of-string rather than throwing.
 */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let i = 0;

	while (i < segment.length) {
		const ch = segment[i];
		if (ch === undefined) break;

		if (ch === "'" || ch === '"') {
			const close = segment.indexOf(ch, i + 1);
			const end = close === -1 ? segment.length : close + 1;
			current += segment.slice(i, end);
			i = end;
			continue;
		}

		if (/\s/.test(ch)) {
			if (current !== '') {
				tokens.push(current);
				current = '';
			}
			i++;
			continue;
		}

		current += ch;
		i++;
	}

	if (current !== '') tokens.push(current);
	return tokens;
}

/**
 * True when `normalized` (an absolute path already stripped of a trailing
 * slash) ends at a directory-ancestor-of-or-equal-to STORE_PATH boundary,
 * e.g. '/Users/me/repo/scripts' or '/Users/me/repo/scripts/cam/issues'.
 * Used as a fallback for an absolute root that does not live under the
 * current process cwd (a different checkout of this repo, a container
 * mount, etc): matching on the trailing segments, guarded by a '/'
 * boundary so 'other-scripts' does not falsely match 'scripts'.
 */
function matchesStoreSuffix(normalized: string): boolean {
	return STORE_PATH_ANCESTOR_PREFIXES.some(
		(prefix) => normalized === prefix || normalized.endsWith(`/${prefix}`),
	);
}

/**
 * True when `root` is '.', or a directory-ancestor-of-or-equal-to
 * scripts/cam/issues, tolerating a trailing slash and a leading './'. An
 * absolute root is resolved by stripping a leading cwd prefix (so it can be
 * checked as a relative root) when it lives under the current working
 * directory, or by matching its store-path suffix otherwise (CAM-474
 * review round 1, US-R1-002): a bare './'-and-trailing-slash normalization
 * left an absolute root like '/Users/me/repo/scripts' unmatched even
 * though it plainly reaches the store.
 */
function isStoreReachingRoot(root: string): boolean {
	if (root === '.' || root === './') return true;

	let normalized = root.replace(/\/+$/, '');
	if (normalized.startsWith('./')) normalized = normalized.slice(2);

	if (normalized.startsWith('/')) {
		const cwdPrefix = `${process.cwd()}/`;
		if (normalized.startsWith(cwdPrefix)) {
			normalized = normalized.slice(cwdPrefix.length);
		} else {
			return matchesStoreSuffix(normalized);
		}
	}

	if (normalized === STORE_PATH) return true;
	return STORE_PATH.startsWith(`${normalized}/`);
}

/**
 * Extracts the whitespace-delimited word ending immediately before index
 * `end` (exclusive) in `command`. Returns the word and the index of its
 * first character, so a caller can continue scanning further left.
 */
function precedingWord(command: string, end: number): { word: string; start: number } {
	let start = end - 1;
	while (start >= 0 && !/\s/.test(command[start] ?? '')) start--;
	return { word: command.slice(start + 1, end), start };
}

/**
 * True when the opening quote at index `quoteIndex` in `command` is the head
 * of a shell-interpreter `-c` command-string argument (`bash -c '...'`,
 * `sh -c "..."`): true exactly when the token immediately preceding the
 * quote (ignoring whitespace) is `-c`. A quoted NEEDLE argument to an
 * unrelated flag (`grep -q "rg" file`) fails this check and is correctly
 * left out of command position.
 */
function isShellDashCQuoteOpen(command: string, quoteIndex: number): boolean {
	let i = quoteIndex - 1;
	while (i >= 0 && /\s/.test(command[i] ?? '')) i--;
	if (i < 0) return false;

	const { word } = precedingWord(command, i + 1);
	return word === SHELL_DASH_C_FLAG;
}

/**
 * Walks the whitespace-separated words ending at index `end` (exclusive)
 * leftward through `command`, skipping over flag ('-0', '-n1', ...) or
 * 'VAR=value' assignment tokens, to find an allowlisted prefix word
 * (xargs/env/sudo/time/command) that may sit one or more tokens before the
 * position `end` marks (CAM-474 review round 2: `env FOO=1 grep ...` and
 * `xargs -0 grep ...` both put a non-prefix token directly before the tool
 * word). Stops and returns false at the first word that is neither an
 * allowlisted prefix nor a flag/assignment token.
 */
function hasCommandPrefixWord(command: string, end: number): boolean {
	while (end > 0) {
		const { word, start } = precedingWord(command, end);

		if (COMMAND_PREFIX_WORDS.has(word)) return true;
		if (!word.startsWith('-') && !ASSIGNMENT_TOKEN_RE.test(word)) return false;

		let j = start;
		while (j >= 0 && /\s/.test(command[j] ?? '')) j--;
		end = j + 1;
	}
	return false;
}

/**
 * True when the tool-word match starting at `matchIndex` in `command` is in
 * COMMAND POSITION: the start of `command`, or immediately preceded
 * (ignoring whitespace) by a clause separator ('|', '&', ';'), an opening
 * paren ('(' -- also covers '$(' since that ends in '('), a backtick (the
 * head of a `` `...` `` command substitution), an opening quote whose own
 * preceding token is the shell interpreter's '-c' flag (see
 * isShellDashCQuoteOpen), or an allowlisted prefix word, possibly preceded
 * by its own flag/assignment tokens (see hasCommandPrefixWord). Rejects a
 * tool word that is merely a substring of an unrelated token (a
 * hyphen-delimited segment, a file extension) or the content of a quoted
 * search pattern/needle sitting inside an already-classified invocation's
 * argument list.
 */
function isCommandPosition(command: string, matchIndex: number): boolean {
	let i = matchIndex - 1;
	while (i >= 0 && /\s/.test(command[i] ?? '')) i--;
	if (i < 0) return true;

	const prevChar = command[i];
	if (prevChar === undefined) return false;
	if (COMMAND_POSITION_CHAR_RE.test(prevChar)) return true;
	if (prevChar === "'" || prevChar === '"') return isShellDashCQuoteOpen(command, i);

	return hasCommandPrefixWord(command, i + 1);
}

/** Per-invocation scan result: what the tokens after the tool word resolved to. */
interface InvocationScan {
	recursive: boolean;
	hasExcludeIssues: boolean;
	roots: string[];
}

/** Mutable accumulator threaded through the per-token classification below. */
interface InvocationScanState extends InvocationScan {
	sawPattern: boolean;
}

/**
 * Resolves one '--exclude-dir...' token against its following token (needed
 * only for the space-separated form, '--exclude-dir issues'): the inline
 * '=value' form is self-contained and never looks at `nextToken`. Returns
 * whether this token's value is 'issues', and how many extra tokens (0 or
 * 1) the space-separated form consumed. Split out of scanInvocationTokens
 * to keep its cognitive complexity within the project's lint ceiling.
 */
function matchExcludeDirIssues(
	token: string,
	nextToken: string | undefined,
): { matched: boolean; consumed: number } {
	const eq = token.indexOf('=');
	if (eq !== -1) {
		return { matched: unquote(token.slice(eq + 1)) === 'issues', consumed: 0 };
	}
	if (nextToken !== undefined && unquote(nextToken) === 'issues') {
		return { matched: true, consumed: 1 };
	}
	return { matched: false, consumed: 0 };
}

/** True when a bundled/separate short-flag-group token carries -r or -R. */
function isRecursiveShortFlag(token: string): boolean {
	return SHORT_FLAG_GROUP_RE.test(token) && /[rR]/.test(token);
}

/**
 * Classifies one non-redirection, non-clause-end token of a search
 * invocation, mutating `state` in place: flags (--exclude-dir, --recursive,
 * --dereference-recursive, bundled -r/-R) update state's flags and are
 * consumed; the first
 * remaining positional token is the search pattern (never a root); every
 * later positional token is a root. Returns the number of EXTRA tokens (0
 * or 1) consumed past `token` itself (only the space-separated
 * '--exclude-dir issues' form consumes one). Split out of
 * scanInvocationTokens to keep its cognitive complexity within the
 * project's lint ceiling.
 */
function applyToken(token: string, nextToken: string | undefined, state: InvocationScanState): number {
	if (token.startsWith('--exclude-dir')) {
		const { matched, consumed } = matchExcludeDirIssues(token, nextToken);
		if (matched) state.hasExcludeIssues = true;
		return consumed;
	}

	if (LONG_FLAG_RE.test(token)) {
		if (token === '--recursive' || token === '--dereference-recursive') state.recursive = true;
		return 0;
	}

	if (SHORT_FLAG_GROUP_RE.test(token)) {
		if (isRecursiveShortFlag(token)) state.recursive = true;
		return 0;
	}

	if (!state.sawPattern) {
		state.sawPattern = true;
		return 0;
	}

	state.roots.push(stripTrailingShellPunctuation(unquote(token)));
	return 0;
}

/**
 * Walks the tokens of one search invocation (already sliced to start right
 * after the tool word), classifying flags/pattern/roots until a clause
 * separator ends the invocation.
 */
function scanInvocationTokens(tokens: string[], tool: string): InvocationScan {
	const state: InvocationScanState = {
		recursive: tool === 'rg',
		hasExcludeIssues: false,
		roots: [],
		sawPattern: false,
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined) continue;
		if (CLAUSE_END_RE.test(token)) break;
		if (REDIRECTION_RE.test(token)) continue;

		i += applyToken(token, tokens[i + 1], state);
	}

	return { recursive: state.recursive, hasExcludeIssues: state.hasExcludeIssues, roots: state.roots };
}

/**
 * Scans `command` for a grep/egrep/fgrep/rg invocation whose recursive
 * search root descends into scripts/cam/issues, and is not excused by an
 * explicit --exclude-dir=issues. Returns the offending root on a match
 * ('.' represents "no positional root given -- defaults to cwd"), or null
 * when no invocation in `command` is store-reaching.
 */
export function findStoreReachingSearch(command: string): { root: string } | null {
	SEARCH_TOOL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = SEARCH_TOOL_RE.exec(command)) !== null) {
		const tool = match[1];
		if (tool === undefined) continue;
		if (!isCommandPosition(command, match.index)) continue;

		const argsStart = match.index + match[0].length;
		const tokens = tokenize(command.slice(argsStart));
		const { recursive, hasExcludeIssues, roots } = scanInvocationTokens(tokens, tool);

		if (!recursive || hasExcludeIssues) continue;

		const effectiveRoots = roots.length === 0 ? ['.'] : roots;
		for (const root of effectiveRoots) {
			if (isStoreReachingRoot(root)) return { root };
		}
	}

	return null;
}
