// test/commands/config-persist.test.ts
//
// Unit tests for the pure persistence helper in src/commands/config.ts.
// No Ink rendering — only mergeConfigChoices + the toml reader round-trip.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { mergeConfigChoices } from '../../src/commands/config.ts';
import type { ConfigChoices } from '../../src/commands/config.ts';
import { loadConfig } from '../../src/config/toml.ts';
import { readPhaseModel, readBackend, DEFAULTS } from '../../src/config/models.ts';
import type { Phase } from '../../src/config/models.ts';
import { FRONTMATTER_TARGET_PHASE_PATHS } from '../../src/templates/frontmatter.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PHASES: readonly Phase[] = [
	'orchestrator',
	'planner',
	'auditor',
	'implementer',
	'reviewer',
	'ship',
];

function makeChoices(
	modelOverride = 'claude-sonnet-4-6',
	backend = 'claude',
): ConfigChoices {
	return {
		models: Object.fromEntries(
			PHASES.map((p) => [p, modelOverride]),
		) as Record<Phase, string>,
		backend,
	};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-config-persist-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('mergeConfigChoices writes [models] section with all phases', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeConfigChoices(configPath, makeChoices('claude-opus-4-8'));

	const config = loadConfig(configPath);
	const models = config['models'] as Record<string, unknown>;
	expect(typeof models).toBe('object');
	for (const phase of PHASES) {
		expect(models[phase]).toBe('claude-opus-4-8');
	}
});

test('mergeConfigChoices writes [backend] section with name key', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeConfigChoices(configPath, makeChoices('claude-sonnet-4-6', 'claude'));

	const config = loadConfig(configPath);
	const backend = config['backend'] as Record<string, unknown>;
	expect(typeof backend).toBe('object');
	expect(backend['name']).toBe('claude');
});

test('mergeConfigChoices does not clobber issue_system or issue_prefix', () => {
	const configPath = join(tmpDir, 'project.toml');
	writeFileSync(configPath, 'issue_system = "linear"\nissue_prefix = "CAM"\n', 'utf8');

	mergeConfigChoices(configPath, makeChoices());

	const config = loadConfig(configPath);
	expect(config['issue_system']).toBe('linear');
	expect(config['issue_prefix']).toBe('CAM');
});

test('readBackend reads from [backend] section written by mergeConfigChoices', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeConfigChoices(configPath, makeChoices('claude-opus-4-8', 'codex'));

	expect(readBackend(configPath)).toBe('codex');
});

test('readPhaseModel reads from [models] section written by mergeConfigChoices', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeConfigChoices(configPath, makeChoices('claude-haiku-3-5'));

	for (const phase of PHASES) {
		expect(readPhaseModel(phase, configPath)).toBe('claude-haiku-3-5');
	}
});

test('second mergeConfigChoices call overwrites prior model choices', () => {
	const configPath = join(tmpDir, 'project.toml');
	mergeConfigChoices(configPath, makeChoices('claude-opus-4-8', 'claude'));
	mergeConfigChoices(configPath, makeChoices('claude-sonnet-4-6', 'codex'));

	const config = loadConfig(configPath);
	const models = config['models'] as Record<string, unknown>;
	for (const phase of PHASES) {
		expect(models[phase]).toBe('claude-sonnet-4-6');
	}
	const backend = config['backend'] as Record<string, unknown>;
	expect(backend['name']).toBe('codex');
});

test('mergeConfigChoices preserves per-phase defaults for missing phases', () => {
	// When all phases are passed, each should read back correctly
	const configPath = join(tmpDir, 'project.toml');
	const choices: ConfigChoices = {
		models: {
			orchestrator: DEFAULTS['orchestrator'],
			planner: DEFAULTS['planner'],
			auditor: DEFAULTS['auditor'],
			implementer: DEFAULTS['implementer'],
			reviewer: DEFAULTS['reviewer'],
			ship: DEFAULTS['ship'],
		},
		backend: DEFAULTS['backend'],
	};
	mergeConfigChoices(configPath, choices);

	for (const phase of PHASES) {
		expect(readPhaseModel(phase, configPath)).toBe(DEFAULTS[phase]);
	}
	expect(readBackend(configPath)).toBe(DEFAULTS['backend']);
});

test('mergeConfigChoices rewrites only the ship frontmatter and leaves planner/auditor agent files unmodified', () => {
	const configPath = join(tmpDir, 'project.toml');

	const shipRelPath = FRONTMATTER_TARGET_PHASE_PATHS['ship']!;
	const shipPath = join(tmpDir, shipRelPath);
	mkdirSync(dirname(shipPath), { recursive: true });
	writeFileSync(shipPath, '---\nmodel: claude-sonnet-4-6\n---\nShip steps.', 'utf8');

	const plannerPath = join(tmpDir, '.claude', 'agents', 'subagent-planner.md');
	const auditorPath = join(tmpDir, '.claude', 'agents', 'subagent-auditor.md');
	mkdirSync(dirname(plannerPath), { recursive: true });
	const plannerOriginal = '---\nname: subagent-planner\n---\nbody';
	const auditorOriginal = '---\nname: subagent-auditor\n---\nbody';
	writeFileSync(plannerPath, plannerOriginal, 'utf8');
	writeFileSync(auditorPath, auditorOriginal, 'utf8');

	mergeConfigChoices(configPath, makeChoices('claude-opus-4-8'), tmpDir);

	expect(readFileSync(shipPath, 'utf8')).toContain('model: claude-opus-4-8');
	expect(readFileSync(plannerPath, 'utf8')).toBe(plannerOriginal);
	expect(readFileSync(auditorPath, 'utf8')).toBe(auditorOriginal);
});
