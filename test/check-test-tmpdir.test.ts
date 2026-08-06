// test/check-test-tmpdir.test.ts
//
// Unit tests for scripts/check-test-tmpdir.ts (US-008, CAM-508 PRD).
//
// All tests inject in-memory file records; no filesystem reads are made.
//
// SPELLING TRAP (this PRD's GOTCHA, see scripts/cam/prd.json US-003/US-008
// notes): this file lives under test/ and is itself covered both by the
// tree-wide rooting oracle and by the gate this file tests, running live
// over its own source (AC1's real-tree run). No fixture below may spell out
// a rooting call contiguously in THIS file's own source text. Every
// flaggable fixture is assembled at runtime through the two generic,
// parameterized helpers below (bareCall, pathJoin): their own bodies never
// mention "tmpdir" literally, and every call site only ever passes the name
// as a bare quoted argument (never followed by a literal "(" in source), so
// neither this gate's own regexes nor the tree-wide oracle can ever match
// this file's source, no matter which name is plugged in at a call site.
//
// Coverage:
//   scanForTmpdirRoots: mkdtempSync form fires
//   scanForTmpdirRoots: awaited mkdtemp form fires
//   scanForTmpdirRoots: bare path-join form fires
//   scanForTmpdirRoots: namespaced os.tmpdir() call fires
//   scanForTmpdirRoots: template-literal interpolation form fires
//   scanForTmpdirRoots: same-file aliased binding form fires
//   scanForTmpdirRoots: bare comparand reference does NOT fire
//   scanForTmpdirRoots: allowlist entry matching an existing file suppresses it
//   scanForTmpdirRoots: allowlist entry matching no existing file fails the gate
//   scanForTmpdirRoots: allowlist entry matching an existing file with zero
//     findings is itself stale (US-R2-002)
//   scanForTmpdirRoots: an allowlisted file is scanned, not skipped up front
//     (US-R2-002)
//   filterScannablePaths: excluded dirs (including the scratch root) are dropped

import { describe, expect, test } from 'bun:test';
import { filterScannablePaths, scanForTmpdirRoots } from '../scripts/check-test-tmpdir.ts';

/** `name()`. Parameterized so this function's own source never spells a literal call. */
function bareCall(name: string): string {
	return `${name}()`;
}

/** `join(inner, rest)`. Parameterized so "join(" is never adjacent to a literal name in source. */
function pathJoin(inner: string, rest: string): string {
	return `join(${inner}, ${rest})`;
}

// ---------------------------------------------------------------------------
// scanForTmpdirRoots: flaggable forms
// ---------------------------------------------------------------------------

// These fixtures pass an explicit empty allowlist ([]): they exercise the
// classification logic in isolation, over a synthetic single-file `files`
// set that never includes the real ALLOWLIST's target path, so relying on
// the default ALLOWLIST parameter here would spuriously report that real
// entry as stale (US-R1-001, once ALLOWLIST held its first real entry).
describe('scanForTmpdirRoots — flaggable forms', () => {
	test('mkdtempSync form fires: names path:line, kind=join', () => {
		const text = `const p = mkdtempSync(${pathJoin(bareCall('tmpdir'), "'prefix'")});\n`;
		const results = scanForTmpdirRoots([{ path: 'test/foo.test.ts', text }], []);
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe('test/foo.test.ts');
		expect(results[0]!.line).toBe(1);
		expect(results[0]!.kind).toBe('join');
	});

	test('awaited mkdtemp form fires: kind=join', () => {
		const text = `const p = await mkdtemp(${pathJoin(bareCall('tmpdir'), "'prefix'")});\n`;
		const results = scanForTmpdirRoots([{ path: 'test/foo.test.ts', text }], []);
		expect(results).toHaveLength(1);
		expect(results[0]!.kind).toBe('join');
	});

	test('bare path-join form fires: kind=join', () => {
		const text = `const p = ${pathJoin(bareCall('tmpdir'), "'sentinel.txt'")};\n`;
		const results = scanForTmpdirRoots([{ path: 'test/foo.test.ts', text }], []);
		expect(results).toHaveLength(1);
		expect(results[0]!.kind).toBe('join');
	});

	test('namespaced os.tmpdir() call fires: kind=join', () => {
		const text = `const p = ${pathJoin(bareCall('os.tmpdir'), "'prefix'")};\n`;
		const results = scanForTmpdirRoots([{ path: 'test/foo.test.ts', text }], []);
		expect(results).toHaveLength(1);
		expect(results[0]!.kind).toBe('join');
	});

	test('template-literal interpolation form fires: kind=template-literal', () => {
		const text = `const p = \`\${${bareCall('tmpdir')}}/leak-probe-dir\`;\n`;
		const results = scanForTmpdirRoots([{ path: 'test/foo.test.ts', text }], []);
		expect(results).toHaveLength(1);
		expect(results[0]!.kind).toBe('template-literal');
	});

	test('same-file aliased binding form fires: kind=join', () => {
		const importLine = "import { tmpdir as getTmp } from 'node:os';";
		const callLine = `const p = ${pathJoin(bareCall('getTmp'), "'prefix'")};`;
		const text = `${importLine}\n${callLine}\n`;
		const results = scanForTmpdirRoots([{ path: 'test/foo.test.ts', text }], []);
		expect(results).toHaveLength(1);
		expect(results[0]!.kind).toBe('join');
	});
});

// ---------------------------------------------------------------------------
// scanForTmpdirRoots: comparand usage must NOT match (GOTCHA 8)
// ---------------------------------------------------------------------------

describe('scanForTmpdirRoots — comparand usage is not a rooting site', () => {
	test('bare tmpdir() used only as a comparand is NOT matched (GOTCHA 8)', () => {
		const text = `!dir.startsWith(${bareCall('tmpdir')})\n`;
		const results = scanForTmpdirRoots([{ path: 'test/helpers/test-tmpdir.test.ts', text }], []);
		expect(results).toHaveLength(0);
	});

	test('no tmpdir reference at all -> empty result', () => {
		const results = scanForTmpdirRoots(
			[{ path: 'test/foo.test.ts', text: 'expect(1).toBe(1);\n' }],
			[],
		);
		expect(results).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// scanForTmpdirRoots: allowlist mechanism (AC3)
// ---------------------------------------------------------------------------

describe('scanForTmpdirRoots — allowlist mechanism', () => {
	test('an entry matching an existing file suppresses that file finding', () => {
		const text = `const p = ${pathJoin(bareCall('tmpdir'), "'prefix'")};\n`;
		const files = [{ path: 'test/foo.test.ts', text }];
		const results = scanForTmpdirRoots(files, [
			{ path: 'test/foo.test.ts', reason: 'synthetic allowlist test, US-008' },
		]);
		expect(results).toHaveLength(0);
	});

	test('an entry matching no existing file fails the gate', () => {
		const files = [{ path: 'test/foo.test.ts', text: 'expect(1).toBe(1);\n' }];
		const results = scanForTmpdirRoots(files, [
			{ path: 'test/nonexistent.test.ts', reason: 'synthetic dangling entry, US-008' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.kind).toBe('stale-allowlist-entry');
		expect(results[0]!.path).toBe('test/nonexistent.test.ts');
	});

	test('an entry matching an existing file that suppressed zero findings is stale (US-R2-002)', () => {
		// The allowlisted path exists in `files`, but its text carries no
		// tmpdir-root call: the entry has nothing left to justify.
		const files = [{ path: 'test/foo.test.ts', text: 'expect(1).toBe(1);\n' }];
		const results = scanForTmpdirRoots(files, [
			{ path: 'test/foo.test.ts', reason: 'synthetic zero-suppression entry, US-R2-002' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.kind).toBe('stale-allowlist-entry');
		expect(results[0]!.path).toBe('test/foo.test.ts');
	});

	test('an allowlisted file IS scanned (not skipped up front): a second, non-allowlisted file with the same finding still fires (US-R2-002)', () => {
		const text = `const p = ${pathJoin(bareCall('tmpdir'), "'prefix'")};\n`;
		const files = [
			{ path: 'test/foo.test.ts', text },
			{ path: 'test/bar.test.ts', text },
		];
		const results = scanForTmpdirRoots(files, [
			{ path: 'test/foo.test.ts', reason: 'synthetic allowlist test, US-R2-002' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.path).toBe('test/bar.test.ts');
		expect(results[0]!.kind).toBe('join');
	});

	test('the real ALLOWLIST holds exactly the CAM-508 GOTCHA 10(a) entry', async () => {
		const { ALLOWLIST } = await import('../scripts/check-test-tmpdir.ts');
		expect(ALLOWLIST).toHaveLength(1);
		expect(ALLOWLIST[0]!.path).toBe('test/vendor/check-agent-frontmatter-standalone.test.ts');
		expect(ALLOWLIST[0]!.reason.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// filterScannablePaths
// ---------------------------------------------------------------------------

describe('filterScannablePaths', () => {
	test('vendor/ paths are excluded', () => {
		expect(filterScannablePaths(['vendor/foo.ts'])).toEqual([]);
	});

	test('node_modules/ paths are excluded', () => {
		expect(filterScannablePaths(['node_modules/foo/bar.ts'])).toEqual([]);
	});

	test('claude-code-harness/ paths are excluded', () => {
		expect(filterScannablePaths(['claude-code-harness/foo.ts'])).toEqual([]);
	});

	test('dist/ paths are excluded', () => {
		expect(filterScannablePaths(['dist/foo.ts'])).toEqual([]);
	});

	test('the scratch root (.cam-test-tmp) is excluded (GOTCHA 3)', () => {
		expect(filterScannablePaths(['.cam-test-tmp/abc123/foo.test.ts'])).toEqual([]);
	});

	test('normal test/ paths are kept', () => {
		expect(filterScannablePaths(['test/foo.test.ts'])).toEqual(['test/foo.test.ts']);
	});

	test('US-R1-001: a nested test/vendor/ path is KEPT, not swallowed by the top-level vendor/ exclusion', () => {
		expect(filterScannablePaths(['test/vendor/some-test.test.ts'])).toEqual([
			'test/vendor/some-test.test.ts',
		]);
	});
});
