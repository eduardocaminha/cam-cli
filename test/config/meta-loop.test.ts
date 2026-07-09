// test/config/meta-loop.test.ts
//
// Tests for readMetaLoop in src/config/models.ts.
// Covers the resolution paths required by US-001 (CAM-132, CAM-139):
//   1. Explicit 'observe' -> returns 'observe'
//   1b. Explicit 'auto' -> returns 'auto'
//   2. Absent (no [loop] section, no key, absent file) -> default 'off'
//   3. Any other string value (incl. 'OBSERVE', 'AUTO') -> falls back to 'off'
//   4. Non-string value -> falls back to 'off'
//   5. Malformed TOML -> falls back to 'off'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { readMetaLoop } from '../../src/config/models.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-meta-loop-test-'));
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
// Resolution path 1: explicit 'observe'
// ---------------------------------------------------------------------------

describe('readMetaLoop - explicit observe', () => {
	test('returns "observe" when [loop] meta_loop = "observe"', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "observe"
`);
		expect(readMetaLoop(path)).toBe('observe');
	});

	test('reads meta_loop alongside other sections', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "claude-opus-4-8"

[loop]
meta_loop = "observe"
`);
		expect(readMetaLoop(path)).toBe('observe');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 1b: explicit 'auto'
// ---------------------------------------------------------------------------

describe('readMetaLoop - explicit auto', () => {
	test('returns "auto" when [loop] meta_loop = "auto"', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "auto"
`);
		expect(readMetaLoop(path)).toBe('auto');
	});

	test('reads meta_loop = "auto" alongside other sections', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "claude-opus-4-8"

[loop]
meta_loop = "auto"
`);
		expect(readMetaLoop(path)).toBe('auto');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 2: absent (default 'off')
// ---------------------------------------------------------------------------

describe('readMetaLoop - absent (default off)', () => {
	test('returns "off" when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		expect(readMetaLoop(nonExistentPath)).toBe('off');
	});

	test('returns "off" when [loop] section is absent', () => {
		const path = writeTmpToml(`
issue_system = "local"
backend = "claude"
`);
		expect(readMetaLoop(path)).toBe('off');
	});

	test('returns "off" when meta_loop key is absent from [loop]', () => {
		const path = writeTmpToml(`
[loop]
other_key = "some-value"
`);
		expect(readMetaLoop(path)).toBe('off');
	});

	test('returns "off" when value is explicitly "off"', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "off"
`);
		expect(readMetaLoop(path)).toBe('off');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 3: wrong string value (unknown -> off, fail-closed)
// ---------------------------------------------------------------------------

describe('readMetaLoop - unknown string value', () => {
	test('returns "off" for value "OBSERVE" (case-sensitive)', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "OBSERVE"
`);
		expect(readMetaLoop(path)).toBe('off');
	});

	test('returns "off" for value "AUTO" (case-sensitive)', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "AUTO"
`);
		expect(readMetaLoop(path)).toBe('off');
	});

	test('returns "off" for value "on"', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "on"
`);
		expect(readMetaLoop(path)).toBe('off');
	});

	test('returns "off" for value "observ" (truncated)', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "observ"
`);
		expect(readMetaLoop(path)).toBe('off');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 4: non-string value (falls back to 'off')
// ---------------------------------------------------------------------------

describe('readMetaLoop - non-string value', () => {
	test('returns "off" when value is a number', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = 1
`);
		expect(readMetaLoop(path)).toBe('off');
	});

	test('returns "off" when value is a boolean', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = true
`);
		expect(readMetaLoop(path)).toBe('off');
	});

	test('returns "off" when value is empty string', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = ""
`);
		expect(readMetaLoop(path)).toBe('off');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 5: malformed TOML (falls back to 'off')
// ---------------------------------------------------------------------------

describe('readMetaLoop - malformed TOML', () => {
	test('returns "off" when TOML is malformed', () => {
		const path = writeTmpToml(`
[loop
meta_loop = "observe"
`);
		expect(readMetaLoop(path)).toBe('off');
	});
});

// ---------------------------------------------------------------------------
// configPath seam: override uses provided path, not cwd/project.toml
// ---------------------------------------------------------------------------

describe('readMetaLoop - configPath override', () => {
	test('uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "observe"
`);
		expect(readMetaLoop(path)).toBe('observe');
	});
});
