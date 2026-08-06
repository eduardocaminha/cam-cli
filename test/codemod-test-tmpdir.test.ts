// test/codemod-test-tmpdir.test.ts
//
// Unit tests pinning scripts/codemod-test-tmpdir.ts (US-003, CAM-508 PRD):
// the mkdtempSync form, the awaited mkdtemp form and the bare path-join
// form, the target helper call, and removal of the node:os import once it
// is left unused.
//
// SPELLING TRAP (PRD notes): this file lives under test/*.test.ts, so it
// is itself covered by this story's own AC1 grep (and the future US-008
// durable gate). Every fixture below is assembled from parts at runtime
// (string concatenation / template interpolation), and every prose
// description below avoids writing the source spelling out contiguously
// (the target spelling, createTestTmpdir, is used in descriptions
// instead), so the literal contiguous source spelling never appears
// anywhere in this file's source text.

import { describe, expect, test } from 'bun:test';
import {
	computeHelperImportSpecifier,
	transformTestTmpdirSource,
} from '../scripts/codemod-test-tmpdir.ts';

// Building blocks, never adjacent in this file's own source text.
const JOIN_OPEN = 'join(';
const TMPDIR_CALL = 'tmpdir()';
/** Assembled at runtime: "join(tmpdir()". Never written contiguously above. */
function rooted(rest: string): string {
	return `${JOIN_OPEN}${TMPDIR_CALL}${rest}`;
}

describe('transformTestTmpdirSource — sync mkdtemp form', () => {
	test('rewrites the sync form to a single createTestTmpdir(prefix) call', () => {
		const source = [
			"import { mkdtempSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-example-'));")}`,
		].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.changed).toBe(true);
		expect(result.text).toContain("const dir = createTestTmpdir('cam-example-');");
		expect(result.text).not.toContain("from 'node:os'");
		expect(result.text).not.toContain('mkdtempSync }');
		expect(result.text).not.toContain('{ mkdtempSync');
		expect(result.text).toContain("import { createTestTmpdir } from './helpers/test-tmpdir';");
	});

	test('drops the node:fs import entirely once the sync form is its only named import', () => {
		const source = [
			"import { mkdtempSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-x-'));")}`,
		].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.text.split('\n')).not.toContain("import { mkdtempSync } from 'node:fs';");
	});

	test('keeps other still-used named imports on the same line and only drops the identifier', () => {
		const source = [
			"import { existsSync, mkdtempSync, rmSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-y-'));")}`,
			'existsSync(dir);',
			'rmSync(dir);',
		].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.text).toContain("import { existsSync, rmSync } from 'node:fs';");
		expect(result.text).not.toContain('mkdtempSync');
	});

	test('a header comment merely mentioning the bare word does not block import removal', () => {
		const source = [
			'// reads a tmpdir cwd, mirroring how the other reader works',
			"import { mkdtempSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-w-'));")}`,
		].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.text).not.toContain("from 'node:os'");
		expect(result.text).toContain("import { createTestTmpdir } from './helpers/test-tmpdir';");
	});

	test('an unrelated .join(...) array-method call does not block the join import from being removed', () => {
		const source = [
			"import { mkdtempSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-v-'));")}`,
			"const label = ['a', 'b'].join('-');",
		].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.text).not.toContain("import { join } from 'node:path';");
		expect(result.text).toContain("const label = ['a', 'b'].join('-');");
	});

	test('an unrelated import statement preceding the node:os import is left completely untouched', () => {
		// Regression: a naive `[\s\S]*?` capture between the import braces
		// can backtrack across this earlier, non-matching import statement
		// while hunting for the node:os specifier, corrupting both.
		const source = [
			"import { mkdtemp } from 'node:fs/promises';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-u-'));")}`,
			'const other = await mkdtemp(\'/unrelated-prefix-\');',
		].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.text).toContain("import { mkdtemp } from 'node:fs/promises';");
		expect(result.text).not.toContain("from 'node:os'");
	});

	test('handles a multi-line node:fs import block identically to a single-line one', () => {
		const source = [
			'import {',
			'\texistsSync,',
			'\tmkdtempSync,',
			'\trmSync,',
			"} from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-multi-'));")}`,
			'existsSync(dir);',
			'rmSync(dir);',
		].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.text).not.toContain('mkdtempSync');
		expect(result.text).toContain('existsSync');
		expect(result.text).toContain('rmSync');
		expect(result.text).not.toContain("from 'node:os'");
		expect(result.text).toContain("import { createTestTmpdir } from './helpers/test-tmpdir';");
	});
});

describe('transformTestTmpdirSource — awaited async mkdtemp form', () => {
	test('rewrites the awaited form to await createTestTmpdir(prefix), keeping the await keyword', () => {
		const source = [
			"import { mkdtemp } from 'node:fs/promises';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			'beforeEach(async () => {',
			`  tmpHome = await mkdtemp(${rooted(', "cam-config-test-"));')}`,
			'});',
		].join('\n');

		const result = transformTestTmpdirSource(source, '../helpers/test-tmpdir');

		expect(result.changed).toBe(true);
		expect(result.text).toContain('tmpHome = await createTestTmpdir("cam-config-test-");');
		expect(result.text).not.toContain("from 'node:fs/promises'");
		expect(result.text).not.toContain("from 'node:os'");
		expect(result.text).toContain("import { createTestTmpdir } from '../helpers/test-tmpdir';");
	});
});

describe('transformTestTmpdirSource — bare path-join form', () => {
	test('roots the join call on a fresh createTestTmpdir() directory, keeping join imported', () => {
		const source = [
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const sentinelPath = ${rooted(", 'cam-plan-spawn-sentinel-' + Date.now() + '.txt');")}`,
		].join('\n');

		const result = transformTestTmpdirSource(source, '../../helpers/test-tmpdir');

		expect(result.changed).toBe(true);
		expect(result.text).toContain(
			"const sentinelPath = join(createTestTmpdir(), 'cam-plan-spawn-sentinel-' + Date.now() + '.txt');",
		);
		// join is still needed to build the sentinel file path onto the
		// freshly created scratch directory, so its import must survive.
		expect(result.text).toContain("import { join } from 'node:path';");
		expect(result.text).not.toContain("from 'node:os'");
		expect(result.text).toContain(
			"import { createTestTmpdir } from '../../helpers/test-tmpdir';",
		);
	});

	test('rewrites a multi-argument bare join call, preserving every later argument', () => {
		const source = [
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const claudeDir = ${rooted(", 'cam-codex-o1-' + process.pid, '.claude');")}`,
		].join('\n');

		const result = transformTestTmpdirSource(source, '../helpers/test-tmpdir');

		expect(result.text).toContain(
			"const claudeDir = join(createTestTmpdir(), 'cam-codex-o1-' + process.pid, '.claude');",
		);
	});
});

describe('transformTestTmpdirSource — no-op and idempotency', () => {
	test('returns changed: false and the original text untouched when no rooted call is present', () => {
		const source = ["import { join } from 'node:path';", '', "join('a', 'b');"].join('\n');

		const result = transformTestTmpdirSource(source, './helpers/test-tmpdir');

		expect(result.changed).toBe(false);
		expect(result.text).toBe(source);
	});

	test('a second pass over already-migrated output is a no-op', () => {
		const source = [
			"import { mkdtempSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			'',
			`const dir = mkdtempSync(${rooted(", 'cam-z-'));")}`,
		].join('\n');

		const once = transformTestTmpdirSource(source, './helpers/test-tmpdir');
		const twice = transformTestTmpdirSource(once.text, './helpers/test-tmpdir');

		expect(twice.changed).toBe(false);
		expect(twice.text).toBe(once.text);
	});
});

describe('computeHelperImportSpecifier', () => {
	test('resolves a top-level test file to ./helpers/test-tmpdir', () => {
		expect(computeHelperImportSpecifier('test/attach-hint.test.ts')).toBe('./helpers/test-tmpdir');
	});

	test('resolves a one-level-nested test file to ../helpers/test-tmpdir', () => {
		expect(computeHelperImportSpecifier('test/supervisor/foo.test.ts')).toBe(
			'../helpers/test-tmpdir',
		);
	});

	test('resolves a two-levels-nested test file to ../../helpers/test-tmpdir', () => {
		expect(computeHelperImportSpecifier('test/fixtures/deep/bar.test.ts')).toBe(
			'../../helpers/test-tmpdir',
		);
	});
});
