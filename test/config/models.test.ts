// test/config/models.test.ts
//
// Tests for src/config/models.ts: readPhaseModel, readBackend, and DEFAULTS.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { DEFAULTS, readBackend, readPhaseModel } from '../../src/config/models.ts';

// ---------------------------------------------------------------------------
// Fixtures helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-models-test-'));
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
// DEFAULTS map
// ---------------------------------------------------------------------------

describe('DEFAULTS', () => {
	test('orchestrator defaults to claude-opus-4-8', () => {
		expect(DEFAULTS.orchestrator).toBe('claude-opus-4-8');
	});

	test('planner defaults to claude-opus-4-8', () => {
		expect(DEFAULTS.planner).toBe('claude-opus-4-8');
	});

	test('auditor defaults to claude-opus-4-8', () => {
		expect(DEFAULTS.auditor).toBe('claude-opus-4-8');
	});

	test('reviewer defaults to claude-opus-4-8', () => {
		expect(DEFAULTS.reviewer).toBe('claude-opus-4-8');
	});

	test('implementer defaults to claude-sonnet-4-6', () => {
		expect(DEFAULTS.implementer).toBe('claude-sonnet-4-6');
	});

	test('ship defaults to claude-sonnet-4-6', () => {
		expect(DEFAULTS.ship).toBe('claude-sonnet-4-6');
	});

	test('backend defaults to claude', () => {
		expect(DEFAULTS.backend).toBe('claude');
	});
});

// ---------------------------------------------------------------------------
// readPhaseModel: happy path
// ---------------------------------------------------------------------------

describe('readPhaseModel - happy path', () => {
	test('reads a configured model from [models] section', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "claude-custom-model"
`);
		expect(readPhaseModel('orchestrator', path)).toBe('claude-custom-model');
	});

	test('reads implementer model from config', () => {
		const path = writeTmpToml(`
[models]
implementer = "claude-haiku-3-5"
`);
		expect(readPhaseModel('implementer', path)).toBe('claude-haiku-3-5');
	});

	test('reads multiple phases independently', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "model-a"
reviewer = "model-b"
`);
		expect(readPhaseModel('orchestrator', path)).toBe('model-a');
		expect(readPhaseModel('reviewer', path)).toBe('model-b');
	});
});

// ---------------------------------------------------------------------------
// readPhaseModel: fallback paths (5 defensive paths)
// ---------------------------------------------------------------------------

describe('readPhaseModel - fallback on missing file', () => {
	test('returns default when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		expect(readPhaseModel('orchestrator', nonExistentPath)).toBe('claude-opus-4-8');
		expect(readPhaseModel('implementer', nonExistentPath)).toBe('claude-sonnet-4-6');
	});
});

describe('readPhaseModel - fallback on missing section', () => {
	test('returns default when [models] section is absent', () => {
		const path = writeTmpToml(`
issue_system = "none"
backend = "claude"
`);
		expect(readPhaseModel('orchestrator', path)).toBe('claude-opus-4-8');
	});
});

describe('readPhaseModel - fallback on missing key', () => {
	test('returns default when phase key is absent from [models]', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "custom-model"
`);
		// 'planner' key is absent
		expect(readPhaseModel('planner', path)).toBe('claude-opus-4-8');
	});
});

describe('readPhaseModel - fallback on malformed TOML', () => {
	test('returns default when TOML is malformed', () => {
		const path = writeTmpToml(`
[models
orchestrator = "custom-model"
`);
		expect(readPhaseModel('orchestrator', path)).toBe('claude-opus-4-8');
	});
});

describe('readPhaseModel - fallback on non-string value', () => {
	test('returns default when model value is a number', () => {
		const path = writeTmpToml(`
[models]
orchestrator = 42
`);
		expect(readPhaseModel('orchestrator', path)).toBe('claude-opus-4-8');
	});

	test('returns default when model value is a boolean', () => {
		const path = writeTmpToml(`
[models]
orchestrator = true
`);
		expect(readPhaseModel('orchestrator', path)).toBe('claude-opus-4-8');
	});
});

// ---------------------------------------------------------------------------
// readBackend: happy path
// ---------------------------------------------------------------------------

describe('readBackend - happy path', () => {
	test('reads backend from top-level key', () => {
		const path = writeTmpToml(`
backend = "anthropic"
`);
		expect(readBackend(path)).toBe('anthropic');
	});

	test('reads backend alongside [models] section', () => {
		const path = writeTmpToml(`
backend = "custom-backend"

[models]
orchestrator = "model-a"
`);
		expect(readBackend(path)).toBe('custom-backend');
	});
});

// ---------------------------------------------------------------------------
// readBackend: fallback paths (5 defensive paths)
// ---------------------------------------------------------------------------

describe('readBackend - fallback on missing file', () => {
	test('returns default when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		expect(readBackend(nonExistentPath)).toBe('claude');
	});
});

describe('readBackend - fallback on missing key', () => {
	test('returns default when backend key is absent', () => {
		const path = writeTmpToml(`
issue_system = "none"
`);
		expect(readBackend(path)).toBe('claude');
	});
});

describe('readBackend - fallback on malformed TOML', () => {
	test('returns default when TOML is malformed', () => {
		const path = writeTmpToml(`backend = `);
		expect(readBackend(path)).toBe('claude');
	});
});

describe('readBackend - fallback on non-string value', () => {
	test('returns default when backend value is a number', () => {
		const path = writeTmpToml(`backend = 99`);
		expect(readBackend(path)).toBe('claude');
	});

	test('returns default when backend value is a boolean', () => {
		const path = writeTmpToml(`backend = false`);
		expect(readBackend(path)).toBe('claude');
	});
});

// ---------------------------------------------------------------------------
// configPath seam: override uses the provided path, not cwd/project.toml
// ---------------------------------------------------------------------------

describe('configPath override', () => {
	test('readPhaseModel uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "seam-model"
`);
		// Without the override we would read scripts/cam/project.toml from cwd.
		// With the override we get the fixture value.
		expect(readPhaseModel('orchestrator', path)).toBe('seam-model');
	});

	test('readBackend uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`backend = "seam-backend"`);
		expect(readBackend(path)).toBe('seam-backend');
	});
});
