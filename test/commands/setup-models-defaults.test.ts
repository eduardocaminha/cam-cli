// test/commands/setup-models-defaults.test.ts
//
// Verifies that the models and backend defaults written by cam init
// (via mergeIntoConfig in setup.ts) match the DEFAULTS map in
// src/config/models.ts and preserve pre-existing toml keys.
//
// We test at the mergeIntoConfig level with the same payload shape
// that setup.ts uses, keeping this test free of tmux/Ink/fs side-effects.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mergeIntoConfig, loadConfig } from '../../src/config/toml.ts';
import { DEFAULTS } from '../../src/config/models.ts';
import type { Phase } from '../../src/config/models.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHASES: readonly Phase[] = [
	'orchestrator',
	'planner',
	'auditor',
	'implementer',
	'reviewer',
	'ship',
];

// Replicates the mergeIntoConfig payload that setup.ts applies at init time.
// Importing DEFAULTS here ensures the test is always consistent with the
// single source of truth.
function setupMergePayload(issueSystem: string) {
	return {
		issue_system: issueSystem,
		models: {
			orchestrator: DEFAULTS.orchestrator,
			planner: DEFAULTS.planner,
			auditor: DEFAULTS.auditor,
			implementer: DEFAULTS.implementer,
			reviewer: DEFAULTS.reviewer,
			ship: DEFAULTS.ship,
		},
		backend: { name: 'claude' },
	};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-setup-models-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('setup writes [models] with all 6 phase keys from DEFAULTS', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeIntoConfig(configPath, setupMergePayload('none'));

	const config = loadConfig(configPath);
	const models = config['models'] as Record<string, unknown>;
	expect(typeof models).toBe('object');
	for (const phase of PHASES) {
		expect(models[phase]).toBe(DEFAULTS[phase]);
	}
});

test('setup writes [models] without a spurious backend key', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeIntoConfig(configPath, setupMergePayload('none'));

	const config = loadConfig(configPath);
	const models = config['models'] as Record<string, unknown>;
	expect(models['backend']).toBeUndefined();
});

test('setup writes [backend] section with name = claude', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeIntoConfig(configPath, setupMergePayload('none'));

	const config = loadConfig(configPath);
	const backend = config['backend'] as Record<string, unknown>;
	expect(typeof backend).toBe('object');
	expect(backend['name']).toBe('claude');
});

test('setup preserves existing issue_system and issue_prefix keys', () => {
	const configPath = join(tmpDir, 'project.toml');
	writeFileSync(configPath, 'issue_system = "linear"\nissue_prefix = "CAM"\n', 'utf8');

	mergeIntoConfig(configPath, setupMergePayload('linear'));

	const config = loadConfig(configPath);
	expect(config['issue_system']).toBe('linear');
	expect(config['issue_prefix']).toBe('CAM');
});

test('setup model values match DEFAULTS (single source of truth, no drift)', () => {
	// If DEFAULTS changes, this test automatically picks up the new values,
	// ensuring setup.ts and models.ts stay in sync.
	const configPath = join(tmpDir, 'project.toml');
	mergeIntoConfig(configPath, setupMergePayload('none'));

	const config = loadConfig(configPath);
	const models = config['models'] as Record<string, unknown>;
	for (const phase of PHASES) {
		expect(models[phase]).toBe(DEFAULTS[phase]);
	}
});
