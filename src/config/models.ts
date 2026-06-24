// src/config/models.ts
//
// Single source of truth for per-phase model selection and backend choice.
// Values are read from `scripts/cam/project.toml` (project-scoped, resolved
// from cwd). The per-user `~/.config/cam/config.toml` and `CAM_CONFIG_PATH`
// are NOT consulted here: those target the user config (see permission-mode.ts).
//
// The default values below are applied when the config file is missing, when a
// section or key is absent, when the file is malformed TOML, or when the value
// is a non-string. This mirrors the try/catch/default pattern in
// `src/config/permission-mode.ts:47-61`.

import { join } from 'node:path';
import process from 'node:process';

import { loadConfig } from './toml.ts';

/**
 * The phases recognized by cam. Each phase can be configured with a model
 * in the `[models]` section of `scripts/cam/project.toml`.
 */
export type Phase =
	| 'orchestrator'
	| 'planner'
	| 'auditor'
	| 'implementer'
	| 'reviewer'
	| 'ship';

/**
 * Default model per phase and backend. Applied when the project config is
 * missing, malformed, or lacks the requested key.
 *
 * - orchestrator/planner/auditor/reviewer: claude-opus-4-8 (deep reasoning phases)
 * - implementer/ship: claude-sonnet-4-6 (high-throughput execution phases)
 * - backend: claude (the default Claude Code backend)
 */
export const DEFAULTS: Record<Phase | 'backend', string> = {
	orchestrator: 'claude-opus-4-8',
	planner: 'claude-opus-4-8',
	auditor: 'claude-opus-4-8',
	reviewer: 'claude-opus-4-8',
	implementer: 'claude-sonnet-4-6',
	ship: 'claude-sonnet-4-6',
	backend: 'claude',
};

function defaultProjectConfigPath(): string {
	return join(process.cwd(), 'scripts', 'cam', 'project.toml');
}

/**
 * Read the model for `phase` from the project config. Returns the configured
 * value when it is present and a non-empty string; otherwise returns
 * `DEFAULTS[phase]`.
 *
 * The function is **defensive on every error path**: a missing file, a
 * malformed TOML file, a missing `[models]` section, a missing key, or a
 * non-string value all fall back to the default. The rationale mirrors
 * `readPermissionMode`: the autonomous loop must never be blocked by a
 * misconfigured project.toml.
 *
 * @param phase    The cam phase to resolve a model for.
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 *                    Used by tests to target a tmp fixture without modifying
 *                    the real project config.
 */
export function readPhaseModel(phase: Phase, configPath?: string): string {
	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const modelsSection = config['models'];
		if (modelsSection !== undefined && modelsSection !== null && typeof modelsSection === 'object') {
			const value = (modelsSection as Record<string, unknown>)[phase];
			if (typeof value === 'string' && value.length > 0) {
				return value;
			}
		}
	} catch {
		// Malformed TOML or fs read error: fall back to default.
	}
	return DEFAULTS[phase];
}

/**
 * Read the backend from the project config. Returns the configured value when
 * present and a non-empty string; otherwise returns `DEFAULTS.backend`.
 *
 * The backend is stored as a top-level `backend` key in
 * `scripts/cam/project.toml` (not nested under a section).
 *
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 */
export function readBackend(configPath?: string): string {
	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const value = config['backend'];
		// Scalar form: backend = "claude"
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
		// Section form written by mergeConfigChoices: [backend]\nname = "<backend>"
		if (value !== null && value !== undefined && typeof value === 'object') {
			const name = (value as Record<string, unknown>)['name'];
			if (typeof name === 'string' && name.length > 0) {
				return name;
			}
		}
	} catch {
		// Malformed TOML or fs read error: fall back to default.
	}
	return DEFAULTS.backend;
}
