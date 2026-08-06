// scripts/codemod-test-tmpdir.ts
//
// Committed, unit-pinned codemod (US-003, CAM-508 PRD).
//
// Swaps every os-temp-dir-rooted call in a test file for the single
// scratch helper (test/helpers/test-tmpdir.ts, US-002): the mechanization
// this PRD's five migration stories (US-003..US-007) share, so the
// transformation is reviewable and does not depend on an unreproducible
// one-off script (GOTCHA 7).
//
// Recognizes three source spellings and rewrites each to the target
// helper call:
//   1. mkdtempSync(join(tmpdir(), PREFIX))  -> createTestTmpdir(PREFIX)
//   2. mkdtemp(join(tmpdir(), PREFIX))      -> createTestTmpdir(PREFIX)
//      (a preceding `await` is left untouched: createTestTmpdir is
//      synchronous, and `await` on a non-promise resolves immediately --
//      see test/helpers/test-tmpdir.ts.)
//   3. join(tmpdir(), ...REST)              -> join(createTestTmpdir(), ...REST)
//      (the "bare-path" branch: the original call built a path under the
//      shared temp dir without creating a directory itself, e.g. a
//      sentinel file path; the transform creates a real scratch directory
//      via the helper and joins the rest of the path onto it.)
//
// After rewriting call sites, any of `tmpdir` (node:os), `mkdtempSync`
// (node:fs) or `mkdtemp` (node:fs/promises) that is left with zero
// remaining references outside import declarations has its import
// removed (dropping the whole import line once its named-import list is
// empty), and an import for the helper is added.
//
// The transform is a pure string -> string function (transformTestTmpdirSource)
// so it is fully unit-testable without touching the filesystem; the CLI
// entrypoint below is the only I/O, and is what this story runs against
// test/*.test.ts to perform the migration.
//
// Usage: bun scripts/codemod-test-tmpdir.ts <file> [<file> ...]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Call-site patterns
// ---------------------------------------------------------------------------

/**
 * Matches `mkdtempSync(join(tmpdir(), PREFIX))`. PREFIX is captured as a
 * single non-nested argument (every known real call site is a bare string
 * literal, see PRD notes); a prefix expression containing its own
 * unbalanced parenthesis is out of scope for this simple regex-based
 * codemod.
 */
const MKDTEMP_SYNC_RE = /mkdtempSync\(join\(\s*tmpdir\(\)\s*,\s*([^)]*)\)\)/g;

/** Matches `mkdtemp(join(tmpdir(), PREFIX))` (the awaited/async form). */
const MKDTEMP_ASYNC_RE = /mkdtemp\(join\(\s*tmpdir\(\)\s*,\s*([^)]*)\)\)/g;

/**
 * Matches the bare `join(tmpdir(),` prefix of a path-join call that is not
 * itself wrapped in an mkdtemp(Sync) call (those are already rewritten by
 * the two regexes above by the time this one runs).
 */
const BARE_JOIN_RE = /join\(\s*tmpdir\(\)\s*,/g;

// ---------------------------------------------------------------------------
// Import surgery
// ---------------------------------------------------------------------------

/** One (module specifier, named import) pair that may become unused. */
interface ImportTarget {
	moduleSpecifier: string;
	identifier: string;
}

const IMPORT_TARGETS: ImportTarget[] = [
	{ moduleSpecifier: 'node:os', identifier: 'tmpdir' },
	{ moduleSpecifier: 'node:fs', identifier: 'mkdtempSync' },
	{ moduleSpecifier: 'node:fs/promises', identifier: 'mkdtemp' },
	{ moduleSpecifier: 'node:path', identifier: 'join' },
];

function escapeForRegex(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Placeholder swapped in for the `node:os` import statement when it is
 * fully emptied out, so its position in the file survives untouched by
 * the later prunes of the other import targets. Replaced with the real
 * helper import line once all pruning is done.
 */
const HELPER_MARKER = '// __CAM_HELPER_IMPORT_MARKER__';

/**
 * Removes `identifier` from its named-import statement for
 * `moduleSpecifier`, but only when `identifier` has zero references in
 * `bodyForUsageCheck` (the file text with every import statement and
 * comment stripped out). The statement is matched across the whole text
 * (`[\s\S]*?` between the braces), so both a single-line
 * `import { a, b } from 'x';` and a multi-line
 * `import {\n  a,\n  b,\n} from 'x';` block are handled identically.
 * Drops the whole statement once its named-import list becomes empty --
 * or, when `replacementWhenEmptied` is given, substitutes that string in
 * place instead (used to anchor the helper import at the `node:os`
 * import's original position).
 */
function pruneUnusedNamedImport(
	text: string,
	target: ImportTarget,
	bodyForUsageCheck: string,
	replacementWhenEmptied?: string,
): string {
	const specifierPattern = escapeForRegex(target.moduleSpecifier);
	// `[^}]*` (not `[\s\S]*?`) bounds the capture to the very next `}`, so a
	// non-matching earlier import statement's own `}...from '...';` can
	// never be swallowed while backtracking in search of this specifier.
	const blockRe = new RegExp(`import \\{([^}]*)\\} from (['"])${specifierPattern}\\2;`);
	const match = blockRe.exec(text);
	if (!match) return text;

	const names = (match[1] ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!names.includes(target.identifier)) return text;

	const usedElsewhere = new RegExp(`(?<![.\\w])${target.identifier}\\b`).test(bodyForUsageCheck);
	if (usedElsewhere) return text;

	const remaining = names.filter((n) => n !== target.identifier);
	const start = match.index;
	const end = start + match[0].length;

	if (remaining.length > 0) {
		const quote = match[2];
		const replacementText = `import { ${remaining.join(', ')} } from ${quote}${target.moduleSpecifier}${quote};`;
		return text.slice(0, start) + replacementText + text.slice(end);
	}

	if (replacementWhenEmptied !== undefined) {
		return text.slice(0, start) + replacementWhenEmptied + text.slice(end);
	}

	// Fully remove the import statement, including one trailing newline so
	// no blank line is left behind.
	const afterEnd = text[end] === '\n' ? end + 1 : end;
	return text.slice(0, start) + text.slice(afterEnd);
}

/**
 * Text used to check whether an identifier is still referenced in code:
 * strips every import statement (single- or multi-line) and every
 * comment line/trailing comment, so neither a prose mention of `tmpdir`
 * (e.g. "reads a tmpdir cwd") in a header comment, nor the import
 * statement's own named-import list, ever counts as a code reference.
 */
function bodyWithoutImportLines(text: string): string {
	return text
		.replace(/^import\b[\s\S]*?;$/gm, '')
		.split('\n')
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.map((line) => line.replace(/\/\/.*$/, ''))
		.join('\n');
}

/**
 * Scans the leading top-of-file import block and returns the line index
 * right after its last statement, tracking whether we are inside an
 * unterminated multi-line `import { ... } from '...';` statement so a
 * continuation line (no trailing `;`) never looks like the end of the
 * block.
 */
function findImportBlockEnd(lines: string[]): number {
	let insertAt = 0;
	let inImportBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (inImportBlock) {
			if (/;$/.test(line)) {
				inImportBlock = false;
				insertAt = i + 1;
			}
			continue;
		}
		if (/^import\b/.test(line)) {
			if (/;$/.test(line)) {
				insertAt = i + 1;
			} else {
				inImportBlock = true;
			}
		} else if (insertAt > 0) {
			break;
		}
	}
	return insertAt;
}

/**
 * Inserts the helper import line, preferring the `HELPER_MARKER` slot left
 * behind by pruning the `node:os` import. Falls back to inserting after
 * the last line of the leading top-of-file import block when no marker
 * was left (e.g. `tmpdir` was imported alongside other still-used names).
 */
function insertHelperImport(text: string, importSpecifier: string): string {
	const helperLine = `import { createTestTmpdir } from '${importSpecifier}';`;
	if (text.includes(helperLine)) return text;

	if (text.includes(HELPER_MARKER)) {
		return text.replace(HELPER_MARKER, helperLine);
	}

	const lines = text.split('\n');
	lines.splice(findImportBlockEnd(lines), 0, helperLine);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CodemodResult {
	text: string;
	changed: boolean;
}

/**
 * Pure transform: rewrites every recognized os-temp-dir-rooted call in
 * `source` to use the scratch helper, and fixes up imports accordingly.
 *
 * `importSpecifier` is the module specifier the caller wants used for the
 * added `createTestTmpdir` import (e.g. `./helpers/test-tmpdir` for a
 * top-level test/*.test.ts file); see computeHelperImportSpecifier.
 */
export function transformTestTmpdirSource(source: string, importSpecifier: string): CodemodResult {
	let text = source;
	text = text.replace(MKDTEMP_SYNC_RE, (_m, arg: string) => `createTestTmpdir(${arg.trim()})`);
	text = text.replace(MKDTEMP_ASYNC_RE, (_m, arg: string) => `createTestTmpdir(${arg.trim()})`);
	text = text.replace(BARE_JOIN_RE, 'join(createTestTmpdir(),');

	if (text === source) return { text: source, changed: false };

	const bodyForUsageCheck = bodyWithoutImportLines(text);

	for (const target of IMPORT_TARGETS) {
		const replacement = target.moduleSpecifier === 'node:os' ? HELPER_MARKER : undefined;
		text = pruneUnusedNamedImport(text, target, bodyForUsageCheck, replacement);
	}

	text = insertHelperImport(text, importSpecifier);
	return { text, changed: true };
}

/**
 * Computes the relative import specifier for the scratch helper from a
 * repo-relative test file path, e.g. `test/attach-hint.test.ts` ->
 * `./helpers/test-tmpdir`, `test/supervisor/foo.test.ts` -> `../helpers/test-tmpdir`.
 */
export function computeHelperImportSpecifier(repoRelativeFilePath: string): string {
	const fileDir = dirname(repoRelativeFilePath);
	let rel = relative(fileDir, 'test/helpers/test-tmpdir').split(sep).join('/');
	if (!rel.startsWith('.')) rel = `./${rel}`;
	return rel;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const files = process.argv.slice(2);
	if (files.length === 0) {
		process.stderr.write('usage: bun scripts/codemod-test-tmpdir.ts <file> [<file> ...]\n');
		process.exit(1);
	}

	let changedCount = 0;
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		const importSpecifier = computeHelperImportSpecifier(file);
		const result = transformTestTmpdirSource(source, importSpecifier);
		if (result.changed) {
			writeFileSync(file, result.text);
			changedCount++;
			process.stdout.write(`codemod-test-tmpdir: rewrote ${file}\n`);
		}
	}
	process.stdout.write(`codemod-test-tmpdir: ${changedCount}/${files.length} file(s) rewritten\n`);
}
