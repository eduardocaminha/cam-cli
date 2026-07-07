// test/config/toolchain.test.ts
//
// Tests for src/config/toolchain.ts: readPinnedBunVersion, readPinnedNodeVersion.

import { describe, expect, test } from 'bun:test';

import { readPinnedBunVersion, readPinnedNodeVersion } from '../../src/config/toolchain.ts';

// ---------------------------------------------------------------------------
// readPinnedBunVersion
// ---------------------------------------------------------------------------

describe('readPinnedBunVersion', () => {
	test('returns the trimmed exact semver from a well-formed file', () => {
		const result = readPinnedBunVersion('fake-path', () => '1.3.13\n');
		expect(result).toBe('1.3.13');
	});

	test('trims surrounding whitespace', () => {
		const result = readPinnedBunVersion('fake-path', () => '  1.3.13  \n\n');
		expect(result).toBe('1.3.13');
	});

	test('returns null when the file is missing (reader throws)', () => {
		const result = readPinnedBunVersion('fake-path', () => {
			throw new Error('ENOENT');
		});
		expect(result).toBeNull();
	});

	test('returns null for malformed content (not exact semver)', () => {
		const result = readPinnedBunVersion('fake-path', () => 'latest\n');
		expect(result).toBeNull();
	});

	test('returns null for a version with a prefix', () => {
		const result = readPinnedBunVersion('fake-path', () => 'v1.3.13\n');
		expect(result).toBeNull();
	});

	test('returns null for a range instead of an exact version', () => {
		const result = readPinnedBunVersion('fake-path', () => '^1.3.13\n');
		expect(result).toBeNull();
	});

	test('returns null for empty content', () => {
		const result = readPinnedBunVersion('fake-path', () => '');
		expect(result).toBeNull();
	});

	test('reads the real repo-root .bun-version file with default args', () => {
		const result = readPinnedBunVersion();
		expect(result).toBe('1.3.13');
	});
});

// ---------------------------------------------------------------------------
// readPinnedNodeVersion
// ---------------------------------------------------------------------------

describe('readPinnedNodeVersion', () => {
	test('returns the version from a well-formed nodejs line', () => {
		const result = readPinnedNodeVersion('fake-path', () => 'nodejs 22.23.1\n');
		expect(result).toBe('22.23.1');
	});

	test('finds the nodejs line among other asdf entries', () => {
		const result = readPinnedNodeVersion(
			'fake-path',
			() => 'ruby 3.3.0\nnodejs 22.23.1\npython 3.12.0\n',
		);
		expect(result).toBe('22.23.1');
	});

	test('trims surrounding whitespace on the line', () => {
		const result = readPinnedNodeVersion('fake-path', () => '  nodejs 22.23.1  \n');
		expect(result).toBe('22.23.1');
	});

	test('returns null when the file is missing (reader throws)', () => {
		const result = readPinnedNodeVersion('fake-path', () => {
			throw new Error('ENOENT');
		});
		expect(result).toBeNull();
	});

	test('returns null when there is no nodejs line', () => {
		const result = readPinnedNodeVersion('fake-path', () => 'ruby 3.3.0\n');
		expect(result).toBeNull();
	});

	test('returns null for a malformed nodejs line (not exact semver)', () => {
		const result = readPinnedNodeVersion('fake-path', () => 'nodejs lts\n');
		expect(result).toBeNull();
	});

	test('returns null for a nodejs line with a v-prefix', () => {
		const result = readPinnedNodeVersion('fake-path', () => 'nodejs v22.23.1\n');
		expect(result).toBeNull();
	});

	test('returns null for empty content', () => {
		const result = readPinnedNodeVersion('fake-path', () => '');
		expect(result).toBeNull();
	});

	test('reads the real repo-root .tool-versions file with default args', () => {
		const result = readPinnedNodeVersion();
		expect(result).toBe('22.23.1');
	});
});
