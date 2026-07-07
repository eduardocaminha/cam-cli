// scripts/check-version-skips.ts
//
// Toolchain-version-skip guard gate (US-005, CAM-201 PRD).
//
// Scans test files under test/ and FAILS when a skip form (skipIf / .skip /
// skipUnless / todoIf) is conditioned, directly or via a same-file variable
// derived from them, on Bun.version, process.version, or process.versions.
//
// This is the exact anti-pattern that caused the cam/pr-66 green-in-container/
// red-in-CI incident (CAM-201): a worker gated an Ink stdin-timing test on
// `bunVersionOk` (itself derived from `Bun.version.split('.')`), so the
// container (bun 1.2.23) silently skipped the test while the host/CI
// (bun >=1.3) ran it and failed.
//
// Does NOT flag skips conditioned on process.platform, process.env, or
// capability probes (e.g. `spawnSync('tmux', ...)`, `Bun.which(...)`): those
// remain legal (CAM-59 real-tmux/git availability skips in test/integration/).
//
// Excludes test/fixtures/ from the real scan so the guard's own positive/
// negative fixtures do not trip it (CAM-60 debt-marker self-reference
// gotcha: scan only test/, not scripts/, to avoid the guard tripping on its
// own source).
//
// Exports:
//   scanForVersionSkips(files) - classify skip-form call sites as violations
//
// Usage: bun scripts/check-version-skips.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { Glob } from 'bun';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory segment excluded from the real scan (guard's own fixtures). */
const EXCLUDED_DIR = 'test/fixtures/';

/** Skip-form method names this gate inspects. Matched as `.<form>(`. */
const SKIP_FORMS = ['skipIf', 'skipUnless', 'todoIf', 'skip'] as const;

/** Matches a literal reference to Bun.version, process.version, or process.versions. */
const VERSION_TOKEN_RE = /Bun\.version\b|process\.version\b|process\.versions\b/;

/** Matches a top-level const/let/var declaration; captures LHS (name or destructure) and RHS. */
const ASSIGN_RE = /\b(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);?/g;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** One entry per skip-form call site conditioned on a toolchain version. */
export interface VersionSkipViolation {
	/** Repo-relative file path. */
	path: string;
	/** 1-indexed line number of the skip-form call. */
	line: number;
	/** The matched skip-form name (skipIf, skipUnless, todoIf, or skip). */
	form: string;
	/** Human-readable reason: direct reference or via which derived variable. */
	reason: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract identifier tokens from an LHS fragment (plain name or destructure pattern). */
function extractNames(lhs: string): string[] {
	return [...lhs.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
}

/**
 * Find the index of the ')' matching the '(' at openIdx, accounting for
 * nested parens. Returns -1 if unbalanced (falls back to end-of-line scan).
 */
function findMatchingParenEnd(text: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Two-pass fixed-point over the file text: collect every identifier whose
 * declaration RHS references a version token (pass 1: e.g. destructured
 * `[_bunMajorStr, _bunMinorStr] = Bun.version.split('.')`) OR references an
 * already-known-derived identifier (pass 2: e.g. `bunVersionOk` built from
 * `_bunMajorStr`/`_bunMinorStr`). This mirrors the real incident shape
 * (patterns.md CAM-186/CAM-201): a module-level const derived from
 * Bun.version, later consumed by a differently-named boolean, then used
 * in skipIf.
 */
function collectDerivedVars(text: string): Set<string> {
	const derived = new Set<string>();
	for (let iteration = 0; iteration < 2; iteration++) {
		ASSIGN_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = ASSIGN_RE.exec(text)) !== null) {
			const lhs = m[1] ?? '';
			const rhs = m[2] ?? '';
			const directHit = VERSION_TOKEN_RE.test(rhs);
			const derivedHit = [...derived].some((v) => new RegExp(`\\b${v}\\b`).test(rhs));
			if (directHit || derivedHit) {
				for (const name of extractNames(lhs)) derived.add(name);
			}
		}
	}
	return derived;
}

// ---------------------------------------------------------------------------
// Call-site classification (extracted to keep scanForVersionSkips's
// cognitive complexity low; see patterns.md "Biome cognitive complexity"
// bullet -- prefer helper extraction over a grandfathered override)
// ---------------------------------------------------------------------------

/**
 * Classify a single skip-form call site (already located by the caller at
 * `openIdx`, the index of the call's opening paren) as a violation, or
 * return null when its argument does not reference a toolchain version.
 */
function classifyCallSite(
	path: string,
	lineNumber: number,
	form: string,
	line: string,
	openIdx: number,
	derivedVars: Set<string>,
): VersionSkipViolation | null {
	const closeIdx = findMatchingParenEnd(line, openIdx);
	const argText = closeIdx >= 0 ? line.slice(openIdx + 1, closeIdx) : line.slice(openIdx + 1);

	if (VERSION_TOKEN_RE.test(argText)) {
		return {
			path,
			line: lineNumber,
			form,
			reason: 'direct reference to Bun.version/process.version(s)',
		};
	}

	const hitVar = [...derivedVars].find((v) => new RegExp(`\\b${v}\\b`).test(argText));
	if (hitVar) {
		return {
			path,
			line: lineNumber,
			form,
			reason: `via same-file variable '${hitVar}' derived from Bun.version/process.version(s)`,
		};
	}

	return null;
}

/** Find every skip-form violation on a single line, across all SKIP_FORMS. */
function findViolationsInLine(
	path: string,
	lineNumber: number,
	line: string,
	derivedVars: Set<string>,
): VersionSkipViolation[] {
	const violations: VersionSkipViolation[] = [];

	for (const form of SKIP_FORMS) {
		const tokenRe = new RegExp(`\\.${form}\\(`, 'g');
		let tm: RegExpExecArray | null;
		while ((tm = tokenRe.exec(line)) !== null) {
			const openIdx = tm.index + tm[0].length - 1;
			const violation = classifyCallSite(path, lineNumber, form, line, openIdx, derivedVars);
			if (violation) violations.push(violation);
		}
	}

	return violations;
}

// ---------------------------------------------------------------------------
// Pure exported function
// ---------------------------------------------------------------------------

/**
 * Scan a list of in-memory file records for toolchain-version-conditioned
 * skips. Each file is supplied as { path, text }; the function does NOT read
 * the filesystem, so callers inject content for full testability.
 */
export function scanForVersionSkips(
	files: { path: string; text: string }[],
): VersionSkipViolation[] {
	const violations: VersionSkipViolation[] = [];

	for (const { path, text } of files) {
		const derivedVars = collectDerivedVars(text);
		const lines = text.split('\n');

		for (let i = 0; i < lines.length; i++) {
			violations.push(...findViolationsInLine(path, i + 1, lines[i] ?? '', derivedVars));
		}
	}

	return violations;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const cwd = process.cwd();

	const glob = new Glob('test/**/*.{ts,tsx}');
	const allPaths = [...glob.scanSync({ cwd })];
	const paths = allPaths.filter((p) => !p.includes(EXCLUDED_DIR));

	const files = paths.map((p) => ({
		path: p,
		text: readFileSync(join(cwd, p), 'utf8'),
	}));

	const violations = scanForVersionSkips(files);

	for (const v of violations) {
		process.stderr.write(
			`check:version-skips: ${v.path}:${v.line}: ${v.form}(...) conditioned ${v.reason}\n`,
		);
	}

	if (violations.length > 0) {
		process.exit(1);
	}

	process.stdout.write('check:version-skips: ok\n');
}
