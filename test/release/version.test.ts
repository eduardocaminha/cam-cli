// test/release/version.test.ts
//
// US-002 acceptance: computeNextVersion (0.x convention) + pure text-transform
// atomic writers for src/version.ts and package.json.

import { describe, expect, test } from 'bun:test';

import {
	applyVersionToPackageJson,
	applyVersionToVersionTs,
	computeNextVersion,
} from '../../src/release/version.ts';

// ---------------------------------------------------------------------------
// computeNextVersion
// ---------------------------------------------------------------------------

describe('computeNextVersion', () => {
	test('patch bump increments patch', () => {
		expect(computeNextVersion('0.1.2', 'patch')).toBe('0.1.3');
	});

	test('minor bump increments minor and resets patch', () => {
		expect(computeNextVersion('0.1.2', 'minor')).toBe('0.2.0');
	});

	test('major bump on 0.x demotes to minor increment (0.x convention)', () => {
		expect(computeNextVersion('0.1.2', 'major')).toBe('0.2.0');
	});

	test('major bump NEVER returns 1.0.0 from any 0.x version', () => {
		expect(computeNextVersion('0.1.2', 'major')).not.toBe('1.0.0');
		expect(computeNextVersion('0.9.0', 'major')).not.toBe('1.0.0');
		expect(computeNextVersion('0.0.1', 'major')).not.toBe('1.0.0');
	});

	test('none bump returns current unchanged', () => {
		expect(computeNextVersion('0.1.2', 'none')).toBe('0.1.2');
	});

	test('none bump on any version returns current unchanged', () => {
		expect(computeNextVersion('1.2.3', 'none')).toBe('1.2.3');
	});

	test('major bump on 1.x uses standard semver (increments major)', () => {
		expect(computeNextVersion('1.2.3', 'major')).toBe('2.0.0');
	});

	test('minor bump on 1.x increments minor and resets patch', () => {
		expect(computeNextVersion('1.2.3', 'minor')).toBe('1.3.0');
	});

	test('patch bump on 1.x increments patch', () => {
		expect(computeNextVersion('1.2.3', 'patch')).toBe('1.2.4');
	});

	test('0.x major bump: 0.9.0 -> 0.10.0 (never 1.0.0)', () => {
		expect(computeNextVersion('0.9.0', 'major')).toBe('0.10.0');
	});
});

// ---------------------------------------------------------------------------
// applyVersionToVersionTs
// ---------------------------------------------------------------------------

describe('applyVersionToVersionTs', () => {
	const SAMPLE = [
		'// src/version.ts',
		'//',
		"// Single source of truth for the cam-cli version string.",
		'',
		"export const CAM_VERSION = '0.1.2';",
		'',
	].join('\n');

	test('rewrites the version literal', () => {
		const result = applyVersionToVersionTs(SAMPLE, '0.2.0');
		expect(result).toContain("export const CAM_VERSION = '0.2.0';");
	});

	test('preserves all other bytes byte-identical', () => {
		const result = applyVersionToVersionTs(SAMPLE, '0.2.0');
		expect(result).toBe(SAMPLE.replace("'0.1.2'", "'0.2.0'"));
	});

	test('handles the real src/version.ts single-line format', () => {
		const line = "export const CAM_VERSION = '0.1.2';";
		const result = applyVersionToVersionTs(line, '0.2.0');
		expect(result).toBe("export const CAM_VERSION = '0.2.0';");
	});

	test('does not rewrite when version is already the target', () => {
		const line = "export const CAM_VERSION = '0.2.0';";
		const result = applyVersionToVersionTs(line, '0.2.0');
		expect(result).toBe("export const CAM_VERSION = '0.2.0';");
	});
});

// ---------------------------------------------------------------------------
// applyVersionToPackageJson
// ---------------------------------------------------------------------------

describe('applyVersionToPackageJson', () => {
	const SAMPLE = [
		'{',
		'  "name": "cam-cli",',
		'  "version": "0.1.2",',
		'  "module": "index.ts"',
		'}',
	].join('\n');

	test('rewrites the top-level version field', () => {
		const result = applyVersionToPackageJson(SAMPLE, '0.2.0');
		expect(result).toContain('"version": "0.2.0"');
	});

	test('preserves all other bytes byte-identical', () => {
		const result = applyVersionToPackageJson(SAMPLE, '0.2.0');
		expect(result).toBe(SAMPLE.replace('"version": "0.1.2"', '"version": "0.2.0"'));
	});

	test('handles the real package.json field format (leading whitespace + trailing comma)', () => {
		const line = '  "version": "0.1.2",';
		const result = applyVersionToPackageJson(line, '0.2.0');
		expect(result).toBe('  "version": "0.2.0",');
	});

	test('does not rewrite when version is already the target', () => {
		const line = '  "version": "0.2.0",';
		const result = applyVersionToPackageJson(line, '0.2.0');
		expect(result).toBe('  "version": "0.2.0",');
	});
});
