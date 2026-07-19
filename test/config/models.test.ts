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
	EFFORT_DEFAULTS,
	readBackend,
	readMergeMode,
	readOrchContextWindow,
	readPhaseBackend,
	readPhaseEffort,
	readPhaseModel,
	readResendConfig,
} from '../../src/config/models.ts';
import type { LlmPhase, Phase } from '../../src/config/models.ts';
import { MODEL_OPTIONS } from '../../src/ui/ConfigScreen.tsx';
import { loadConfig } from '../../src/config/toml.ts';
import { isClaudeAliasModel } from '../../src/supervisor/codex-auth.ts';

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
// readPhaseModel: backend-aware resolution (US-001, CAM-356)
// ---------------------------------------------------------------------------

describe('readPhaseModel - backend-aware resolution (US-001)', () => {
	test('a codex-backed phase resolves the codex slug from a nested [models.codex] sub-table', () => {
		const path = writeTmpToml(`
[models]
implementer = "sonnet"

[models.codex]
implementer = "gpt-5-codex"
`);
		expect(readPhaseModel('implementer', path, 'codex')).toBe('gpt-5-codex');
	});

	test('a claude-backed phase ignores a present [models.codex] sub-table and resolves the flat value', () => {
		const path = writeTmpToml(`
[models]
implementer = "sonnet"

[models.codex]
implementer = "gpt-5-codex"
`);
		expect(readPhaseModel('implementer', path, 'claude')).toBe('sonnet');
	});

	test('backend omitted resolves the flat value unchanged (pre-existing 2-arg call shape)', () => {
		const path = writeTmpToml(`
[models]
implementer = "sonnet"

[models.codex]
implementer = "gpt-5-codex"
`);
		expect(readPhaseModel('implementer', path)).toBe('sonnet');
	});

	test('non-claude backend with no matching nested key falls back to the flat [models].<phase> value', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "custom-model"

[models.codex]
implementer = "gpt-5-codex"
`);
		expect(readPhaseModel('orchestrator', path, 'codex')).toBe('custom-model');
	});

	test('non-claude backend with no nested [models.<backend>] table at all falls back to the flat value', () => {
		const path = writeTmpToml(`
[models]
implementer = "sonnet"
`);
		expect(readPhaseModel('implementer', path, 'codex')).toBe('sonnet');
	});

	test('non-claude backend with neither nested nor flat value falls back to DEFAULTS[phase]', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "custom-model"
`);
		expect(readPhaseModel('implementer', path, 'codex')).toBe('sonnet');
	});

	test('a [models.codex] sub-table present but the requested phase is claude-backed: flat lookup skips the nested object and falls through to DEFAULTS', () => {
		const path = writeTmpToml(`
[models.codex]
implementer = "gpt-5-codex"
`);
		// 'implementer' has no flat [models].implementer entry; only the nested
		// [models.codex].implementer entry exists. A claude-backed request must
		// NOT pick up the nested table nor treat [models] itself (which is now
		// the object { codex: { implementer: ... } }) as a model string.
		expect(readPhaseModel('implementer', path, 'claude')).toBe('sonnet');
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
// readPhaseBackend (US-001, CAM-349): per-phase backend accessor, mirrors
// readPhaseModel with a 3-link fallback chain (per-phase -> global -> DEFAULTS).
// ---------------------------------------------------------------------------

describe('readPhaseBackend - per-phase key wins', () => {
	test('resolves the per-phase key under [backend] when present', () => {
		const path = writeTmpToml(`
[backend]
implementer = "codex"
`);
		expect(readPhaseBackend('implementer', path)).toBe('codex');
	});

	test('different phases can resolve to different per-phase backends', () => {
		const path = writeTmpToml(`
[backend]
implementer = "codex"
reviewer = "claude"
`);
		expect(readPhaseBackend('implementer', path)).toBe('codex');
		expect(readPhaseBackend('reviewer', path)).toBe('claude');
	});
});

describe('readPhaseBackend - falls back to the existing global form', () => {
	test('falls back to the top-level scalar form when no per-phase key is set', () => {
		const path = writeTmpToml(`backend = "anthropic"`);
		expect(readPhaseBackend('implementer', path)).toBe('anthropic');
	});

	test('falls back to [backend].name when no per-phase key is set', () => {
		const path = writeTmpToml(`
[backend]
name = "anthropic"
`);
		expect(readPhaseBackend('implementer', path)).toBe('anthropic');
	});

	test('per-phase key wins over [backend].name for that phase, [backend].name still serves other phases', () => {
		const path = writeTmpToml(`
[backend]
name = "claude"
implementer = "codex"
`);
		expect(readPhaseBackend('implementer', path)).toBe('codex');
		expect(readPhaseBackend('reviewer', path)).toBe('claude');
	});
});

describe('readPhaseBackend - fallback to DEFAULTS.backend', () => {
	test('returns default when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		expect(readPhaseBackend('implementer', nonExistentPath)).toBe('claude');
	});

	test('returns default when [backend] section is absent', () => {
		const path = writeTmpToml(`issue_system = "local"`);
		expect(readPhaseBackend('implementer', path)).toBe('claude');
	});

	test('returns default when TOML is malformed', () => {
		const path = writeTmpToml(`backend = `);
		expect(readPhaseBackend('implementer', path)).toBe('claude');
	});

	test('returns default when the per-phase and name values are non-string', () => {
		const path = writeTmpToml(`
[backend]
implementer = 99
name = false
`);
		expect(readPhaseBackend('implementer', path)).toBe('claude');
	});

	test('returns default when the scalar backend value is a number', () => {
		const path = writeTmpToml(`backend = 99`);
		expect(readPhaseBackend('implementer', path)).toBe('claude');
	});
});

describe('readPhaseBackend - back-compat with an existing [backend] name-only project.toml', () => {
	test('a project.toml carrying only [backend] name = "claude" resolves to "claude" for every phase', () => {
		const path = writeTmpToml(`
[backend]
name = "claude"
`);
		const phases: readonly Phase[] = ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer', 'ship'];
		for (const phase of phases) {
			expect(readPhaseBackend(phase, path)).toBe('claude');
		}
	});
});

describe('readPhaseBackend - configPath seam', () => {
	test('uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`
[backend]
implementer = "seam-backend"
`);
		expect(readPhaseBackend('implementer', path)).toBe('seam-backend');
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
// the real repo config) must equal what's configured there. The "known
// model" check is backend-conditional (US-003, CAM-356): a claude-backed
// phase is still checked against MODEL_OPTIONS/DEFAULTS, but a codex-backed
// phase only needs to NOT be a claude tier alias -- asserting a positive
// codex-slug allowlist would drift with the account's available models
// (gpt-5.5/gpt-5.6-sol valid, all *-codex rejected on this login) and falsely
// redden the suite the moment the codex model lineup changes.
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

			const backend = readPhaseBackend(phase, repoConfigPath);
			if (backend === 'claude') {
				expect(optionValues.has(actual) || actual === DEFAULTS[phase]).toBe(true);
			} else {
				expect(isClaudeAliasModel(actual)).toBe(false);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// EFFORT_DEFAULTS (US-001)
// ---------------------------------------------------------------------------

describe('EFFORT_DEFAULTS', () => {
	test('has exactly the 5 LLM phases and no others (ship omitted)', () => {
		expect(Object.keys(EFFORT_DEFAULTS).sort()).toEqual(
			['auditor', 'implementer', 'orchestrator', 'planner', 'reviewer'].sort(),
		);
	});

	test('orchestrator/planner/auditor/reviewer default to xhigh', () => {
		expect(EFFORT_DEFAULTS.orchestrator).toBe('xhigh');
		expect(EFFORT_DEFAULTS.planner).toBe('xhigh');
		expect(EFFORT_DEFAULTS.auditor).toBe('xhigh');
		expect(EFFORT_DEFAULTS.reviewer).toBe('xhigh');
	});

	test('implementer defaults to high', () => {
		expect(EFFORT_DEFAULTS.implementer).toBe('high');
	});
});

// ---------------------------------------------------------------------------
// readPhaseEffort: happy path
// ---------------------------------------------------------------------------

const LLM_PHASES: readonly LlmPhase[] = ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer'];

describe('readPhaseEffort - happy path', () => {
	test('reads a configured effort from [efforts] section', () => {
		const path = writeTmpToml(`
[efforts]
orchestrator = "medium"
`);
		expect(readPhaseEffort('orchestrator', path)).toBe('medium');
	});

	test('reads multiple phases independently', () => {
		const path = writeTmpToml(`
[efforts]
planner = "high"
implementer = "low"
`);
		expect(readPhaseEffort('planner', path)).toBe('high');
		expect(readPhaseEffort('implementer', path)).toBe('low');
	});
});

// ---------------------------------------------------------------------------
// readPhaseEffort: fallback paths (mirrors readPhaseModel's 5 defensive paths)
// ---------------------------------------------------------------------------

describe('readPhaseEffort - fallback on missing file', () => {
	test('returns EFFORT_DEFAULTS for every LLM phase when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		for (const phase of LLM_PHASES) {
			expect(readPhaseEffort(phase, nonExistentPath)).toBe(EFFORT_DEFAULTS[phase]);
		}
	});
});

describe('readPhaseEffort - fallback on missing section', () => {
	test('returns the default when [efforts] section is absent', () => {
		const path = writeTmpToml(`
issue_system = "local"
backend = "claude"
`);
		expect(readPhaseEffort('orchestrator', path)).toBe(EFFORT_DEFAULTS.orchestrator);
	});
});

describe('readPhaseEffort - fallback on missing key', () => {
	test('returns the default when phase key is absent from [efforts]', () => {
		const path = writeTmpToml(`
[efforts]
orchestrator = "custom-effort"
`);
		// 'planner' key is absent
		expect(readPhaseEffort('planner', path)).toBe(EFFORT_DEFAULTS.planner);
	});
});

describe('readPhaseEffort - fallback on malformed TOML', () => {
	test('returns the default when TOML is malformed', () => {
		const path = writeTmpToml(`
[efforts
orchestrator = "custom-effort"
`);
		expect(readPhaseEffort('orchestrator', path)).toBe(EFFORT_DEFAULTS.orchestrator);
	});
});

describe('readPhaseEffort - fallback on non-string value', () => {
	test('returns the default when effort value is a number', () => {
		const path = writeTmpToml(`
[efforts]
orchestrator = 42
`);
		expect(readPhaseEffort('orchestrator', path)).toBe(EFFORT_DEFAULTS.orchestrator);
	});

	test('returns the default when effort value is a boolean', () => {
		const path = writeTmpToml(`
[efforts]
orchestrator = true
`);
		expect(readPhaseEffort('orchestrator', path)).toBe(EFFORT_DEFAULTS.orchestrator);
	});

	test('returns the default when effort value is an empty string', () => {
		const path = writeTmpToml(`
[efforts]
orchestrator = ""
`);
		expect(readPhaseEffort('orchestrator', path)).toBe(EFFORT_DEFAULTS.orchestrator);
	});
});

describe('readPhaseEffort - configPath override', () => {
	test('uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`
[efforts]
orchestrator = "seam-effort"
`);
		expect(readPhaseEffort('orchestrator', path)).toBe('seam-effort');
	});
});

// ---------------------------------------------------------------------------
// LlmPhase is ship-free at the type level (US-001, AC-3)
//
// This is a compile-time-only assertion: `bun run typecheck` must fail if the
// `// @ts-expect-error` below stops being an error (e.g. if LlmPhase is
// widened back to include 'ship'). No runtime assertion is meaningful here.
// ---------------------------------------------------------------------------

describe('LlmPhase excludes ship at the type level', () => {
	test('an efforts record including ship is a type error (compile-time only)', () => {
		const efforts: Record<LlmPhase, string> = {
			orchestrator: 'xhigh',
			planner: 'xhigh',
			auditor: 'xhigh',
			implementer: 'high',
			reviewer: 'xhigh',
			// @ts-expect-error: 'ship' is not a valid LlmPhase key; efforts records
			// must be ship-free at the type level (ADR-0009: ship is deterministic).
			ship: 'sonnet',
		};
		expect(Object.keys(efforts).length).toBe(6);
	});
});
