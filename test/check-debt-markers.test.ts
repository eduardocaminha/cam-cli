// test/check-debt-markers.test.ts
//
// Unit tests for scripts/check-debt-markers.ts (US-003, CAM-60 PRD).
//
// All tests inject in-memory file records; no filesystem reads are made.
//
// Coverage:
//   scanForMarkers: uncited marker exits nonzero and names file:line
//   scanForMarkers: cited via CAM-NNN
//   scanForMarkers: cited via #N
//   scanForMarkers: cited via https?:// URL
//   scanForMarkers: no markers -> empty result
//   scanForMarkers: multiple markers on separate lines
//   scanForMarkers: marker followed by colon (TODO:)
//   scanForMarkers: marker followed by space (FIXME fix)
//   scanForMarkers: US-XXX / CAM-XXX identifiers are NOT matched
//   filterScannablePaths: vendor/ paths are excluded
//   filterScannablePaths: node_modules/ paths are excluded
//   filterScannablePaths: claude-code-harness/ paths are excluded
//   filterScannablePaths: dist/ paths are excluded
//   filterScannablePaths: src/vendor/ subpath excluded (embedded auditor prompt)
//   filterScannablePaths: normal src/ paths are kept

import { describe, expect, test } from 'bun:test';
import { scanForMarkers, filterScannablePaths } from '../scripts/check-debt-markers.ts';

// ---------------------------------------------------------------------------
// scanForMarkers: cited vs uncited classification
// ---------------------------------------------------------------------------

describe('scanForMarkers — uncited marker', () => {
	test('uncited TODO on a line: cited=false, names file:line', () => {
		const results = scanForMarkers([
			{ path: 'src/foo.ts', text: '// TODO: fix something\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(false);
		expect(results[0]!.path).toBe('src/foo.ts');
		expect(results[0]!.line).toBe(1);
		expect(results[0]!.marker).toBe('TODO');
	});

	test('uncited FIXME: cited=false', () => {
		const results = scanForMarkers([
			{ path: 'src/bar.ts', text: 'FIXME: broken logic\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(false);
		expect(results[0]!.marker).toBe('FIXME');
	});

	test('uncited HACK: cited=false', () => {
		const results = scanForMarkers([
			{ path: 'src/baz.ts', text: '// HACK workaround\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(false);
		expect(results[0]!.marker).toBe('HACK');
	});

	test('uncited XXX: cited=false', () => {
		const results = scanForMarkers([
			{ path: 'src/qux.ts', text: '// XXX: revisit this\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(false);
		expect(results[0]!.marker).toBe('XXX');
	});
});

describe('scanForMarkers — cited via tracker reference', () => {
	test('CAM-NNN on same line: cited=true', () => {
		const results = scanForMarkers([
			{ path: 'src/a.ts', text: '// TODO: fix this CAM-42\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(true);
	});

	test('#N on same line: cited=true', () => {
		const results = scanForMarkers([
			{ path: 'src/a.ts', text: '// FIXME: see #7\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(true);
	});

	test('https:// URL on same line: cited=true', () => {
		const results = scanForMarkers([
			{
				path: 'src/a.ts',
				text: '// HACK: workaround, see https://github.com/org/repo/issues/9\n',
			},
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(true);
	});

	test('http:// URL on same line: cited=true', () => {
		const results = scanForMarkers([
			{ path: 'src/a.ts', text: '// TODO: http://example.com/issues/3\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// scanForMarkers: marker syntax (followed by : or whitespace)
// ---------------------------------------------------------------------------

describe('scanForMarkers — marker syntax', () => {
	test('TODO: (colon immediately after): detected', () => {
		const results = scanForMarkers([{ path: 'src/a.ts', text: 'TODO: something\n' }]);
		expect(results).toHaveLength(1);
		expect(results[0]!.marker).toBe('TODO');
	});

	test('FIXME followed by space (no colon): detected', () => {
		const results = scanForMarkers([{ path: 'src/a.ts', text: 'FIXME fix me\n' }]);
		expect(results).toHaveLength(1);
		expect(results[0]!.marker).toBe('FIXME');
	});
});

// ---------------------------------------------------------------------------
// scanForMarkers: US-XXX / CAM-XXX identifiers must NOT be matched
// ---------------------------------------------------------------------------

describe('scanForMarkers — identifier exclusion (US-XXX, CAM-XXX)', () => {
	test('US-XXX placeholder is not matched as a debt marker', () => {
		const results = scanForMarkers([
			{ path: 'src/a.ts', text: '// running US-XXX (N/total)\n' },
		]);
		expect(results).toHaveLength(0);
	});

	test('CAM-XXX placeholder is not matched as a debt marker', () => {
		const results = scanForMarkers([
			{
				path: 'src/a.ts',
				text: '// CAM_IMPLEMENTER_STATUS=DONE story=US-XXX\n',
			},
		]);
		expect(results).toHaveLength(0);
	});

	test('story=US-XXX is not matched', () => {
		const results = scanForMarkers([
			{ path: 'src/a.ts', text: 'const sentinel = "CAM_IMPLEMENTER_STATUS=DONE story=US-XXX";\n' },
		]);
		expect(results).toHaveLength(0);
	});

	test('identifier containing XXX but not as standalone marker is not matched', () => {
		// "YYYXXX" — XXX is preceded by Y (not -), but also the full word is YYYXXX
		// The regex uses \b so YYYXXX contains XXX without a preceding word boundary for XXX alone.
		// Actually \b IS present between Y-X since both are word chars -> would NOT have boundary.
		// Let's be explicit: "statusXXX" should not match.
		const results = scanForMarkers([
			{ path: 'src/a.ts', text: 'const statusXXX = 1;\n' },
		]);
		expect(results).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// scanForMarkers: no markers
// ---------------------------------------------------------------------------

describe('scanForMarkers — no markers', () => {
	test('file with no markers: empty result', () => {
		const results = scanForMarkers([
			{ path: 'src/clean.ts', text: 'const x = 1;\nconst y = 2;\n' },
		]);
		expect(results).toHaveLength(0);
	});

	test('empty text: empty result', () => {
		const results = scanForMarkers([{ path: 'src/empty.ts', text: '' }]);
		expect(results).toHaveLength(0);
	});

	test('empty files list: empty result', () => {
		expect(scanForMarkers([])).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// scanForMarkers: multiple markers across lines and files
// ---------------------------------------------------------------------------

describe('scanForMarkers — multiple markers', () => {
	test('two uncited markers on separate lines: two results with correct line numbers', () => {
		const results = scanForMarkers([
			{
				path: 'src/multi.ts',
				text: 'const a = 1;\n// TODO: first\nconst b = 2;\n// FIXME: second\n',
			},
		]);
		expect(results).toHaveLength(2);
		expect(results[0]!.line).toBe(2);
		expect(results[0]!.marker).toBe('TODO');
		expect(results[1]!.line).toBe(4);
		expect(results[1]!.marker).toBe('FIXME');
	});

	test('markers across two files: results carry correct paths', () => {
		const results = scanForMarkers([
			{ path: 'src/a.ts', text: '// TODO: fix\n' },
			{ path: 'src/b.ts', text: '// HACK: workaround\n' },
		]);
		expect(results).toHaveLength(2);
		expect(results[0]!.path).toBe('src/a.ts');
		expect(results[1]!.path).toBe('src/b.ts');
	});

	test('one file cited, one uncited: correct cited flags', () => {
		const results = scanForMarkers([
			{ path: 'src/good.ts', text: '// TODO: see CAM-10\n' },
			{ path: 'src/bad.ts', text: '// TODO: no ref\n' },
		]);
		expect(results).toHaveLength(2);
		expect(results[0]!.cited).toBe(true);
		expect(results[1]!.cited).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// filterScannablePaths: excluded directories
// ---------------------------------------------------------------------------

describe('filterScannablePaths — excluded directories', () => {
	test('vendor/ paths are excluded', () => {
		expect(filterScannablePaths(['vendor/foo.ts'])).toHaveLength(0);
		expect(filterScannablePaths(['src/vendor/bar.ts'])).toHaveLength(0);
	});

	test('node_modules/ paths are excluded', () => {
		expect(filterScannablePaths(['node_modules/lib/index.ts'])).toHaveLength(0);
	});

	test('claude-code-harness/ paths are excluded', () => {
		expect(filterScannablePaths(['claude-code-harness/agent.ts'])).toHaveLength(0);
	});

	test('dist/ paths are excluded', () => {
		expect(filterScannablePaths(['dist/index.js'])).toHaveLength(0);
		expect(filterScannablePaths(['src/dist/foo.ts'])).toHaveLength(0);
	});

	test('src/vendor/_generated.ts is excluded (embedded auditor prompt)', () => {
		// This is the critical case: the file contains literal marker tokens.
		expect(
			filterScannablePaths(['src/vendor/_generated.ts']),
		).toHaveLength(0);
	});

	test('normal src/ paths are kept', () => {
		const kept = filterScannablePaths([
			'src/commands/run.ts',
			'src/ui/Dashboard.tsx',
			'scripts/check-all.ts',
		]);
		expect(kept).toHaveLength(3);
	});

	test('mix of excluded and normal paths: only normal are kept', () => {
		const kept = filterScannablePaths([
			'src/commands/run.ts',
			'vendor/some.ts',
			'node_modules/pkg/index.ts',
			'scripts/check-all.ts',
		]);
		expect(kept).toHaveLength(2);
		expect(kept).toContain('src/commands/run.ts');
		expect(kept).toContain('scripts/check-all.ts');
	});

	test('empty list: empty result', () => {
		expect(filterScannablePaths([])).toHaveLength(0);
	});
});
