// test/config/models.test.ts
//
// Tests for src/config/models.ts: readPhaseModel, readBackend, readMergeMode,
// readOrchContextWindow, and DEFAULTS.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
	DEFAULTS,
	DEFAULT_ORCH_CONTEXT_WINDOW,
	readBackend,
	readMergeMode,
	readOrchContextWindow,
	readPhaseModel,
	readResendConfig,
} from '../../src/config/models.ts';
import type { Phase } from '../../src/config/models.ts';
import { MODEL_OPTIONS } from '../../src/ui/ConfigScreen.tsx';
import { loadConfig } from '../../src/config/toml.ts';

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
	test('orchestrator defaults to the opus tier alias', () => {
		expect(DEFAULTS.orchestrator).toBe('opus');
	});

	test('planner defaults to the opus tier alias', () => {
		expect(DEFAULTS.planner).toBe('opus');
	});

	test('auditor defaults to the opus tier alias', () => {
		expect(DEFAULTS.auditor).toBe('opus');
	});

	test('reviewer defaults to the opus tier alias', () => {
		expect(DEFAULTS.reviewer).toBe('opus');
	});

	test('implementer defaults to the sonnet tier alias', () => {
		expect(DEFAULTS.implementer).toBe('sonnet');
	});

	test('ship defaults to the sonnet tier alias', () => {
		expect(DEFAULTS.ship).toBe('sonnet');
	});

	test('backend defaults to claude', () => {
		expect(DEFAULTS.backend).toBe('claude');
	});
});

// ---------------------------------------------------------------------------
// US-001 (CAM-287): DEFAULTS are CLI tier aliases (ADR-0034), not dated ids,
// and both a tier alias and a custom dated id flow through readPhaseModel
// verbatim (no allowlist rejection) since the CLI validates at spawn.
// ---------------------------------------------------------------------------

describe('DEFAULTS are tier aliases, not dated ids (US-001)', () => {
	test('every non-backend DEFAULTS value is a bare tier alias (no dated claude-* id)', () => {
		const nonBackendEntries = Object.entries(DEFAULTS).filter(([key]) => key !== 'backend');
		for (const [, model] of nonBackendEntries) {
			expect(model.startsWith('claude-')).toBe(false);
		}
	});

	test('the reconciled DEFAULTS resolve through readPhaseModel unchanged (no configured project.toml)', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		const phases: readonly Phase[] = ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer', 'ship'];
		for (const phase of phases) {
			expect(readPhaseModel(phase, nonExistentPath)).toBe(DEFAULTS[phase]);
		}
	});
});

describe('readPhaseModel - verbatim passthrough, no allowlist rejection (US-001)', () => {
	test('a tier alias (sonnet) flows through unchanged', () => {
		const path = writeTmpToml(`
[models]
implementer = "sonnet"
`);
		expect(readPhaseModel('implementer', path)).toBe('sonnet');
	});

	test('a custom dated id flows through unchanged', () => {
		const path = writeTmpToml(`
[models]
implementer = "claude-sonnet-4-5-20250929"
`);
		expect(readPhaseModel('implementer', path)).toBe('claude-sonnet-4-5-20250929');
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
		expect(readPhaseModel('orchestrator', nonExistentPath)).toBe('opus');
		expect(readPhaseModel('implementer', nonExistentPath)).toBe('sonnet');
	});
});

describe('readPhaseModel - fallback on missing section', () => {
	test('returns default when [models] section is absent', () => {
		const path = writeTmpToml(`
issue_system = "local"
backend = "claude"
`);
		expect(readPhaseModel('orchestrator', path)).toBe('opus');
	});
});

describe('readPhaseModel - fallback on missing key', () => {
	test('returns default when phase key is absent from [models]', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "custom-model"
`);
		// 'planner' key is absent
		expect(readPhaseModel('planner', path)).toBe('opus');
	});
});

describe('readPhaseModel - fallback on malformed TOML', () => {
	test('returns default when TOML is malformed', () => {
		const path = writeTmpToml(`
[models
orchestrator = "custom-model"
`);
		expect(readPhaseModel('orchestrator', path)).toBe('opus');
	});
});

describe('readPhaseModel - fallback on non-string value', () => {
	test('returns default when model value is a number', () => {
		const path = writeTmpToml(`
[models]
orchestrator = 42
`);
		expect(readPhaseModel('orchestrator', path)).toBe('opus');
	});

	test('returns default when model value is a boolean', () => {
		const path = writeTmpToml(`
[models]
orchestrator = true
`);
		expect(readPhaseModel('orchestrator', path)).toBe('opus');
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
issue_system = "local"
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

// ---------------------------------------------------------------------------
// readMergeMode: happy path
// ---------------------------------------------------------------------------

describe('readMergeMode - happy path', () => {
	test('returns "ci-gated" when [ship] merge_mode = "ci-gated"', () => {
		const path = writeTmpToml(`
[ship]
merge_mode = "ci-gated"
`);
		expect(readMergeMode(path)).toBe('ci-gated');
	});

	test('returns "immediate" when [ship] merge_mode = "immediate"', () => {
		const path = writeTmpToml(`
[ship]
merge_mode = "immediate"
`);
		expect(readMergeMode(path)).toBe('immediate');
	});

	test('reads merge_mode alongside [models] section', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "model-a"

[ship]
merge_mode = "ci-gated"
`);
		expect(readMergeMode(path)).toBe('ci-gated');
	});
});

// ---------------------------------------------------------------------------
// readMergeMode: fallback paths (defensive default = "immediate")
// ---------------------------------------------------------------------------

describe('readMergeMode - fallback on missing file', () => {
	test('returns "immediate" when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		expect(readMergeMode(nonExistentPath)).toBe('immediate');
	});
});

describe('readMergeMode - fallback on missing [ship] section', () => {
	test('returns "immediate" when [ship] section is absent', () => {
		const path = writeTmpToml(`
issue_system = "local"
backend = "claude"
`);
		expect(readMergeMode(path)).toBe('immediate');
	});
});

describe('readMergeMode - fallback on missing merge_mode key', () => {
	test('returns "immediate" when merge_mode key is absent from [ship]', () => {
		const path = writeTmpToml(`
[ship]
other_key = "some-value"
`);
		expect(readMergeMode(path)).toBe('immediate');
	});
});

describe('readMergeMode - fallback on malformed TOML', () => {
	test('returns "immediate" when TOML is malformed', () => {
		const path = writeTmpToml(`
[ship
merge_mode = "ci-gated"
`);
		expect(readMergeMode(path)).toBe('immediate');
	});
});

describe('readMergeMode - fallback on non-"ci-gated" values', () => {
	test('returns "immediate" when value is an unrecognized string', () => {
		const path = writeTmpToml(`
[ship]
merge_mode = "unknown-value"
`);
		expect(readMergeMode(path)).toBe('immediate');
	});

	test('returns "immediate" when value is a number', () => {
		const path = writeTmpToml(`
[ship]
merge_mode = 1
`);
		expect(readMergeMode(path)).toBe('immediate');
	});

	test('returns "immediate" when value is a boolean', () => {
		const path = writeTmpToml(`
[ship]
merge_mode = true
`);
		expect(readMergeMode(path)).toBe('immediate');
	});

	test('returns "immediate" when value is empty string', () => {
		const path = writeTmpToml(`
[ship]
merge_mode = ""
`);
		expect(readMergeMode(path)).toBe('immediate');
	});
});

describe('readMergeMode - configPath override', () => {
	test('uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`
[ship]
merge_mode = "ci-gated"
`);
		expect(readMergeMode(path)).toBe('ci-gated');
	});
});

// ---------------------------------------------------------------------------
// readResendConfig - resend_from (US-001)
// ---------------------------------------------------------------------------

describe('readResendConfig - resend_from', () => {
	test('returns the configured resend_from value', () => {
		const path = writeTmpToml(`
[notify]
resend_from = "escalations@example.com"
`);
		expect(readResendConfig(path).from).toBe('escalations@example.com');
	});

	test('returns from === "" when resend_from is absent', () => {
		const path = writeTmpToml(`
[notify]
resend_recipient = "ops@example.com"
`);
		expect(readResendConfig(path).from).toBe('');
	});
});

// ---------------------------------------------------------------------------
// readOrchContextWindow
// ---------------------------------------------------------------------------

describe('readOrchContextWindow - happy path', () => {
	test('returns the configured integer value', () => {
		const path = writeTmpToml(`
[loop]
orch_context_window = 500000
`);
		expect(readOrchContextWindow(path)).toBe(500_000);
	});
});

describe('readOrchContextWindow - fallback on missing file', () => {
	test('returns the 200000 default when the file does not exist', () => {
		const path = join(tmpDir, 'does-not-exist.toml');
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
		expect(readOrchContextWindow(path)).toBe(200_000);
	});
});

describe('readOrchContextWindow - fallback on missing [loop] section', () => {
	test('returns the default when [loop] is absent', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "claude-opus-4-8"
`);
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
	});
});

describe('readOrchContextWindow - fallback on missing key', () => {
	test('returns the default when orch_context_window is absent from [loop]', () => {
		const path = writeTmpToml(`
[loop]
meta_loop = "off"
`);
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
	});
});

describe('readOrchContextWindow - fallback on malformed TOML', () => {
	test('returns the default and never throws', () => {
		const path = writeTmpToml('not valid toml !!!\n');
		expect(() => readOrchContextWindow(path)).not.toThrow();
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
	});
});

describe('readOrchContextWindow - fallback on non-integer value', () => {
	test('returns the default for a string value', () => {
		const path = writeTmpToml(`
[loop]
orch_context_window = "200000"
`);
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
	});

	test('returns the default for a float value', () => {
		const path = writeTmpToml(`
[loop]
orch_context_window = 200000.5
`);
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
	});
});

describe('readOrchContextWindow - fallback on <= 0 value', () => {
	test('returns the default for zero', () => {
		const path = writeTmpToml(`
[loop]
orch_context_window = 0
`);
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
	});

	test('returns the default for a negative value', () => {
		const path = writeTmpToml(`
[loop]
orch_context_window = -1
`);
		expect(readOrchContextWindow(path)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
	});
});

describe('readOrchContextWindow - configPath override', () => {
	test('uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`
[loop]
orch_context_window = 300000
`);
		expect(readOrchContextWindow(path)).toBe(300_000);
	});
});

// ---------------------------------------------------------------------------
// DEFAULTS vs MODEL_OPTIONS: drift guard (US-001, CAM-286)
//
// The picker (ConfigScreen.tsx MODEL_OPTIONS) and the fallback (models.ts
// DEFAULTS) are two independently-maintained hardcoded lists. This guard
// fails the moment either list drifts from the other for a non-backend phase.
// ---------------------------------------------------------------------------

describe('DEFAULTS vs MODEL_OPTIONS consistency', () => {
	const optionValues = new Set(MODEL_OPTIONS.map((o) => o.value));

	test('every non-backend DEFAULTS value is a selectable MODEL_OPTIONS value', () => {
		const nonBackendEntries = Object.entries(DEFAULTS).filter(([key]) => key !== 'backend');
		expect(nonBackendEntries.length).toBeGreaterThan(0);
		for (const [, model] of nonBackendEntries) {
			expect(optionValues.has(model)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// readPhaseModel vs the repo's own scripts/cam/project.toml (drift guard)
//
// For each Phase, the value cam actually spawns with (readPhaseModel against
// the real repo config) must equal what's configured there, and must be a
// known/selectable model id (or the DEFAULTS fallback when the key is
// omitted from [models]).
// ---------------------------------------------------------------------------

describe('readPhaseModel vs repo project.toml (drift guard)', () => {
	const repoConfigPath = join(process.cwd(), 'scripts', 'cam', 'project.toml');
	const rawConfig = loadConfig(repoConfigPath);
	const modelsSection = (rawConfig['models'] ?? {}) as Record<string, unknown>;
	const optionValues = new Set(MODEL_OPTIONS.map((o) => o.value));

	const phases: readonly Phase[] = ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer', 'ship'];

	for (const phase of phases) {
		test(`${phase}: readPhaseModel matches the configured value and is a known model`, () => {
			const configured = modelsSection[phase];
			const expected = typeof configured === 'string' && configured.length > 0 ? configured : DEFAULTS[phase];
			const actual = readPhaseModel(phase, repoConfigPath);
			expect(actual).toBe(expected);
			expect(optionValues.has(actual) || actual === DEFAULTS[phase]).toBe(true);
		});
	}
});
