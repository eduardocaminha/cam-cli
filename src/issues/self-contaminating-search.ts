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
//     -r/-R (bundled or separate short flags, or --recursive), or when it is
//     rg (ripgrep is recursive by default -- no flag required).
//   - A root is STORE-REACHING when it is '.', or a directory-ancestor-of-
//     or-equal-to scripts/cam/issues ('scripts', 'scripts/cam',
//     'scripts/cam/issues', with or without a trailing slash), or when the
//     invocation carries NO positional root at all (a bare search defaults
//     to cwd). The ancestor test makes the file-vs-directory distinction
//     fall out for free: 'scripts/cam/patterns.md' is not an ancestor of
//     the store, so a single-file root under scripts stays legal even with
//     -r, and 'docs/adr/' is legal.
//   - An explicit '--exclude-dir=issues' (or '--exclude-dir issues')
//     anywhere in the invocation nullifies the finding for that invocation
//     regardless of its roots: this is the sanctioned safe-repair idiom
//     (CAM-460 AC2), and refusing it would break the very fix this
//     detector exists to enable.
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

/** Recognized recursive-by-tool-identity or recursive-flag-capable search tools. */
const SEARCH_TOOL_RE = /\b(grep|egrep|fgrep|rg)\b/g;

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
 * True when `root` is '.', or a directory-ancestor-of-or-equal-to
 * scripts/cam/issues, tolerating a trailing slash and a leading './'.
 */
function isStoreReachingRoot(root: string): boolean {
	if (root === '.' || root === './') return true;

	let normalized = root.replace(/\/+$/, '');
	if (normalized.startsWith('./')) normalized = normalized.slice(2);

	if (normalized === STORE_PATH) return true;
	return STORE_PATH.startsWith(`${normalized}/`);
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
 * bundled -r/-R) update state's flags and are consumed; the first
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
		if (token === '--recursive') state.recursive = true;
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

	state.roots.push(unquote(token));
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
