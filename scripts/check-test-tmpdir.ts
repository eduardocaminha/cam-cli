// scripts/check-test-tmpdir.ts
//
// Test-tmpdir-root gate (US-008, CAM-508 PRD).
//
// Scans a tree for a tmpdir() call reaching a path-construction site, the
// pattern this PRD's migration (US-001..US-007) replaced with the single
// scratch helper (test/helpers/test-tmpdir.ts::createTestTmpdir). Flags a
// call to node:os's tmpdir export -- bare (`tmpdir()`), namespaced
// (`os.tmpdir()`), or a same-file aliased import binding
// (`import { tmpdir as X } from 'node:os'` then `X()`) -- when that call
// feeds either:
//   (i)  a `join(...)` call as its first argument (covers the bare
//        path-join form and, since they textually nest a join(...tmpdir()..)
//        call, the mkdtempSync(join(...)) and awaited mkdtemp(join(...))
//        forms too); or
//   (ii) a template-literal interpolation that also carries a path
//        separator elsewhere in the same literal (a genuine path build,
//        not a bare reference).
//
// Deliberately does NOT flag a tmpdir() reference used only as a
// comparand (e.g. `dir.startsWith(tmpdir())`): no join, no template-literal
// path construction, nothing to root.
//
// Ships with a working allowlist mechanism (per-entry path + reason) that
// is empty in this issue: its only legitimate future consumers are the
// product leak-regression tests of the sister issue. An allowlist entry
// naming a path this scan never touched fails the gate outright, so a
// stale entry can never outlive its own justification.
//
// Exports:
//   filterScannablePaths(paths)         - drop excluded-dir entries
//   scanForTmpdirRoots(files, allowlist) - classify tmpdir roots + validate allowlist
//
// Usage: bun scripts/check-test-tmpdir.ts [scanRoot] [--print-allowlist]

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { Glob } from 'bun';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directory segments whose files must be excluded from the scan. Mirrors
 * scripts/check-test-sleeps.ts EXCLUDED_DIRS, plus the repo-local test
 * scratch root (test/helpers/test-tmpdir.ts) so a leftover scratch
 * directory can never be mistaken for a rooting site.
 */
const EXCLUDED_DIRS = ['vendor/', 'node_modules/', 'claude-code-harness/', 'dist/', '.cam-test-tmp'];

/** One (path, human reason) pair suppressing a known finding at that path. */
export interface TmpdirAllowlistEntry {
	path: string;
	reason: string;
}

/**
 * The real allowlist. Empty by design in this issue: nothing in the
 * migrated tree needs it (US-007 drove the tree-wide rooting count to
 * zero). Populate only with a per-entry reason; a dangling entry (naming a
 * path this scan does not reach) fails the gate.
 */
export const ALLOWLIST: TmpdirAllowlistEntry[] = [];

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** One entry per tmpdir-root occurrence found, or per invalid allowlist entry. */
export interface TmpdirRootResult {
	/** Repo-relative (or scan-root-relative) file path. */
	path: string;
	/** 1-indexed line number, or 0 for a dangling allowlist entry. */
	line: number;
	/** Which reaching form matched, or that an allowlist entry is stale. */
	kind: 'join' | 'template-literal' | 'stale-allowlist-entry';
}

// ---------------------------------------------------------------------------
// Pure exported functions
// ---------------------------------------------------------------------------

/**
 * Filter a list of scanned file paths, keeping only those that do not fall
 * under an excluded directory segment.
 */
export function filterScannablePaths(paths: string[]): string[] {
	return paths.filter((p) => !EXCLUDED_DIRS.some((dir) => p.includes(dir)));
}

function escapeAlternative(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds same-file aliased bindings of node:os's `tmpdir` export, e.g.
 * `import { tmpdir as getTmp } from 'node:os'` returns `['getTmp']`. A
 * plain `import { tmpdir } from 'node:os'` (no `as`) contributes nothing
 * here: the bare name `tmpdir` is always checked regardless.
 */
function discoverAliasNames(text: string): string[] {
	const names: string[] = [];
	const importRe = /import\s*\{([^}]*)\}\s*from\s*(['"])node:os\2/g;
	let m: RegExpExecArray | null = importRe.exec(text);
	while (m !== null) {
		const specifiers = (m[1] ?? '').split(',').map((s) => s.trim());
		for (const specifier of specifiers) {
			const aliasMatch = /^tmpdir\s+as\s+(\w+)$/.exec(specifier);
			if (aliasMatch?.[1]) names.push(aliasMatch[1]);
		}
		m = importRe.exec(text);
	}
	return names;
}

/**
 * Builds this file's tmpdir-root detection regexes from its own discovered
 * aliases: a call is recognized bare (`tmpdir()`), namespaced
 * (`<ident>.tmpdir()`), or via any same-file alias.
 */
function buildRootRegexes(text: string): { join: RegExp; template: RegExp } {
	const names = ['tmpdir', ...discoverAliasNames(text)].map(escapeAlternative);
	const callSrc = `(?:\\w+\\.)?(?:${names.join('|')})\\(\\)`;
	return {
		join: new RegExp(`join\\(\\s*${callSrc}\\s*,`, 'g'),
		template: new RegExp(
			`\`[^\`\n]*\\/[^\`\n]*\\$\\{\\s*${callSrc}\\s*\\}[^\`\n]*\`|` +
				`\`[^\`\n]*\\$\\{\\s*${callSrc}\\s*\\}[^\`\n]*\\/[^\`\n]*\``,
			'g',
		),
	};
}

/** Finds allowlist entries whose `path` matches none of `knownPaths` (stale entries). */
function findStaleAllowlistEntries(
	allowlist: TmpdirAllowlistEntry[],
	knownPaths: Set<string>,
): TmpdirRootResult[] {
	return allowlist
		.filter((entry) => !knownPaths.has(entry.path))
		.map((entry) => ({ path: entry.path, line: 0, kind: 'stale-allowlist-entry' as const }));
}

/** Scans one file's text for tmpdir-root occurrences, line by line. */
function scanFileForRoots(path: string, text: string): TmpdirRootResult[] {
	const results: TmpdirRootResult[] = [];
	const { join: joinRootRe, template: templateRootRe } = buildRootRegexes(text);
	const lines = text.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i] ?? '';
		// A comment line (//, *, /* leading) only documents the pattern in
		// prose; it is never executable code reaching a path-construction
		// site. Same convention as this PRD's tree-wide oracle.
		if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;

		joinRootRe.lastIndex = 0;
		while (joinRootRe.exec(lineText) !== null) {
			results.push({ path, line: i + 1, kind: 'join' });
		}

		templateRootRe.lastIndex = 0;
		while (templateRootRe.exec(lineText) !== null) {
			results.push({ path, line: i + 1, kind: 'template-literal' });
		}
	}

	return results;
}

/**
 * Scan a list of in-memory file records for a tmpdir() call reaching a
 * path-construction site, honoring `allowlist` suppressions.
 *
 * Each file is supplied as { path, text }; the filesystem is never touched
 * here, so callers inject content for full testability. An allowlist entry
 * whose `path` does not match any scanned file's `path` is itself reported
 * as a `stale-allowlist-entry` finding, failing the gate.
 */
export function scanForTmpdirRoots(
	files: { path: string; text: string }[],
	allowlist: TmpdirAllowlistEntry[] = ALLOWLIST,
): TmpdirRootResult[] {
	const knownPaths = new Set(files.map((f) => f.path));
	const allowedPaths = new Set(allowlist.map((e) => e.path));

	const staleEntries = findStaleAllowlistEntries(allowlist, knownPaths);
	const rootFindings = files
		.filter(({ path }) => !allowedPaths.has(path))
		.flatMap(({ path, text }) => scanFileForRoots(path, text));

	return [...staleEntries, ...rootFindings];
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const argv = process.argv.slice(2);

	if (argv.includes('--print-allowlist')) {
		for (const entry of ALLOWLIST) {
			process.stdout.write(`${entry.path}: ${entry.reason}\n`);
		}
		process.exit(0);
	}

	const scanRootArg = argv.find((a) => !a.startsWith('--'));
	const baseDir = scanRootArg !== undefined ? resolve(scanRootArg) : process.cwd();

	const glob = new Glob('test/**/*.{ts,tsx}');
	const allPaths = [...glob.scanSync({ cwd: baseDir })];
	const paths = filterScannablePaths(allPaths);

	const files = paths.map((p) => ({
		path: p,
		text: readFileSync(join(baseDir, p), 'utf8'),
	}));

	const findings = scanForTmpdirRoots(files);

	for (const f of findings) {
		if (f.kind === 'stale-allowlist-entry') {
			process.stderr.write(
				`check:test-tmpdir: allowlist entry "${f.path}" does not match any scanned file\n`,
			);
			continue;
		}
		process.stderr.write(
			`check:test-tmpdir: ${f.path}:${f.line}: tmpdir() call reaches a path-construction site (${f.kind}) — ` +
				`use test/helpers/test-tmpdir.ts's createTestTmpdir() instead\n`,
		);
	}

	if (findings.length > 0) {
		process.exit(1);
	}

	process.stdout.write('check:test-tmpdir: ok\n');
}
