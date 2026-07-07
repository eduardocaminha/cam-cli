// test/check-version-skips.test.ts
//
// Unit tests for scripts/check-version-skips.ts (US-005, CAM-201 PRD).
//
// All positive-case inputs are readFileSync'd from
// test/fixtures/version-skip-guard/ rather than embedded as inline string
// literals in this file. This is deliberate: an inline string literal
// containing e.g. "Bun.version" would itself be matched by the real CLI
// scan of test/**/*.ts (this file is not under test/fixtures/, so it is not
// excluded), tripping the debt-marker-style self-reference gotcha
// (patterns.md CAM-60). Only fixtures are the source of positive-case raw
// text; this file's own inline literals never contain a version token.
//
// Coverage:
//   direct Bun.version reference in skipIf: flagged
//   direct process.version reference in todoIf: flagged
//   direct process.versions reference in skipUnless: flagged
//   single-hop derived variable (bunOk = Bun.version...): flagged
//   two-hop derived variable (the real cam/pr-66 incident shape): flagged
//   differently-named derived variable (not a name-only grep): flagged
//   process.platform-conditioned skip: NOT flagged
//   process.env-conditioned skip: NOT flagged
//   capability-probe-conditioned skip (spawnSync tmux -V): NOT flagged
//   no skip forms at all: empty result
//   multiple files: correct per-file path/line

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanForVersionSkips } from '../scripts/check-version-skips.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'version-skip-guard');

function readFixture(name: string): { path: string; text: string } {
	return {
		path: `test/fixtures/version-skip-guard/${name}`,
		text: readFileSync(join(FIXTURE_DIR, name), 'utf8'),
	};
}

// ---------------------------------------------------------------------------
// Fixture files: positive cases (direct version-token references)
// ---------------------------------------------------------------------------

describe('scanForVersionSkips — direct version token (positive fixtures)', () => {
	test('direct-bun-version.ts (Bun.version in skipIf): flagged', () => {
		const results = scanForVersionSkips([readFixture('direct-bun-version.ts')]);
		expect(results).toHaveLength(1);
		expect(results[0]!.form).toBe('skipIf');
		expect(results[0]!.reason).toContain('direct reference');
	});

	test('direct-process-version.ts (process.version in todoIf): flagged', () => {
		const results = scanForVersionSkips([readFixture('direct-process-version.ts')]);
		expect(results).toHaveLength(1);
		expect(results[0]!.form).toBe('todoIf');
	});

	test('process-versions-skipunless.ts (process.versions in skipUnless): flagged', () => {
		const results = scanForVersionSkips([readFixture('process-versions-skipunless.ts')]);
		expect(results).toHaveLength(1);
		expect(results[0]!.form).toBe('skipUnless');
	});
});

// ---------------------------------------------------------------------------
// Fixture files: positive cases (derived-variable chains)
// ---------------------------------------------------------------------------

describe('scanForVersionSkips — derived variable chain (positive fixtures)', () => {
	test('single-hop-derived.ts (bunOk = Bun.version...): flagged', () => {
		const results = scanForVersionSkips([readFixture('single-hop-derived.ts')]);
		expect(results).toHaveLength(1);
		expect(results[0]!.reason).toContain('bunOk');
	});

	test('derived-bun-version.ts (destructure then boolean, the real incident shape): flagged', () => {
		const results = scanForVersionSkips([readFixture('derived-bun-version.ts')]);
		expect(results).toHaveLength(1);
		expect(results[0]!.form).toBe('skipIf');
		expect(results[0]!.reason).toContain('bunVersionOk');
	});

	test('renamed-derived-probe.ts (differently-named probe, not a name-only grep): flagged', () => {
		const results = scanForVersionSkips([readFixture('renamed-derived-probe.ts')]);
		expect(results).toHaveLength(1);
		expect(results[0]!.reason).toContain('runtimeIsModern');
	});
});

// ---------------------------------------------------------------------------
// Fixture files: negative cases (platform/env/capability probes stay legal)
// ---------------------------------------------------------------------------

describe('scanForVersionSkips — fixture files (negative cases, legal skips)', () => {
	test('legal-platform-skip.ts (process.platform): NOT flagged', () => {
		const results = scanForVersionSkips([readFixture('legal-platform-skip.ts')]);
		expect(results).toHaveLength(0);
	});

	test('legal-env-skip.ts (process.env): NOT flagged', () => {
		const results = scanForVersionSkips([readFixture('legal-env-skip.ts')]);
		expect(results).toHaveLength(0);
	});

	test('legal-capability-skip.ts (spawnSync tmux -V probe): NOT flagged', () => {
		const results = scanForVersionSkips([readFixture('legal-capability-skip.ts')]);
		expect(results).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// No skip forms / multiple files
// ---------------------------------------------------------------------------

describe('scanForVersionSkips — no violations / multi-file', () => {
	test('file with no skip forms at all: empty result', () => {
		const results = scanForVersionSkips([
			{ path: 'test/clean.test.ts', text: "test('x', () => {});\n" },
		]);
		expect(results).toHaveLength(0);
	});

	test('empty files list: empty result', () => {
		expect(scanForVersionSkips([])).toHaveLength(0);
	});

	test('multiple files: violation carries correct path, others stay clean', () => {
		const results = scanForVersionSkips([
			readFixture('direct-bun-version.ts'),
			readFixture('legal-platform-skip.ts'),
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe('test/fixtures/version-skip-guard/direct-bun-version.ts');
	});
});
