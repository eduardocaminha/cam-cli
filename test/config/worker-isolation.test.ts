// test/config/worker-isolation.test.ts
//
// Tests for readWorkerIsolation in src/config/models.ts.
// Covers the resolution paths required by US-001 (CAM-152):
//   1. Explicit 'container' -> returns 'container'
//   2. Absent (no file, no [loop] section, no key) -> default 'host'
//   3. Any other string value (incl. 'bogus', 'HOST', 'CONTAINER') -> 'host'
//   4. Non-string value -> 'host'
//   5. Malformed TOML -> 'host'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { readWorkerIsolation } from '../../src/config/models.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-worker-isolation-test-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpToml(content: string): string {
	const path = join(tmpDir, 'project.toml');
	writeFileSync(path, content, 'utf8');
	return path;
}

// ---------------------------------------------------------------------------
// Resolution path 1: explicit 'container'
// ---------------------------------------------------------------------------

describe('readWorkerIsolation - explicit container', () => {
	test('returns "container" when [loop] worker_isolation = "container"', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "container"
`);
		expect(readWorkerIsolation(path)).toBe('container');
	});

	test('reads worker_isolation alongside other [loop] keys', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "observe"
worker_isolation = "container"
`);
		expect(readWorkerIsolation(path)).toBe('container');
	});

	test('reads worker_isolation alongside other sections', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "claude-opus-4-8"

[loop]
worker_isolation = "container"
`);
		expect(readWorkerIsolation(path)).toBe('container');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 2: absent (default 'host')
// ---------------------------------------------------------------------------

describe('readWorkerIsolation - absent (default host)', () => {
	test('returns "host" when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		expect(readWorkerIsolation(nonExistentPath)).toBe('host');
	});

	test('returns "host" when [loop] section is absent', () => {
		const path = writeTmpToml(`
issue_system = "none"
backend = "claude"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});

	test('returns "host" when worker_isolation key is absent from [loop]', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "observe"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});

	test('returns "host" when value is explicitly "host"', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "host"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 3: wrong string value (AC#1 DI fixture: 'bogus' -> 'host')
// ---------------------------------------------------------------------------

describe('readWorkerIsolation - unknown string value', () => {
	test('returns "host" for value "bogus" (AC fixture)', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "bogus"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});

	test('returns "host" for value "CONTAINER" (case-sensitive)', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "CONTAINER"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});

	test('returns "host" for value "HOST" (case-sensitive)', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "HOST"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});

	test('returns "host" for value "docker" (unrecognized)', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "docker"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 4: non-string value (falls back to 'host')
// ---------------------------------------------------------------------------

describe('readWorkerIsolation - non-string value', () => {
	test('returns "host" when value is a number', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = 1
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});

	test('returns "host" when value is a boolean', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = true
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});

	test('returns "host" when value is empty string', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = ""
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 5: malformed TOML (falls back to 'host')
// ---------------------------------------------------------------------------

describe('readWorkerIsolation - malformed TOML', () => {
	test('returns "host" when TOML is malformed', () => {
		const path = writeTmpToml(`
[loop
worker_isolation = "container"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});
});

// ---------------------------------------------------------------------------
// configPath seam: DI override uses provided path, not cwd/project.toml
// ---------------------------------------------------------------------------

describe('readWorkerIsolation - configPath DI override', () => {
	test('uses configPath arg instead of cwd default (container)', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "container"
`);
		expect(readWorkerIsolation(path)).toBe('container');
	});

	test('uses configPath arg instead of cwd default (bogus -> host)', () => {
		const path = writeTmpToml(`
[loop]
worker_isolation = "bogus"
`);
		expect(readWorkerIsolation(path)).toBe('host');
	});
});
