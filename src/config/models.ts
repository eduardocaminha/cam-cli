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
/**
 * The merge mode for `cam ship`. `"immediate"` merges as soon as the PR is
 * created; `"ci-gated"` waits for CI to pass before merging.
 */
export type MergeMode = 'immediate' | 'ci-gated';

/**
 * The plan approval mode. `"auto"` lets the sidecar proceed automatically
 * after grill; `"operator"` requires a human gate before the loop advances.
 */
export type PlanApproval = 'auto' | 'operator';

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

/**
 * Read the merge mode for `cam ship` from the project config. Returns
 * `"ci-gated"` only when `[ship] merge_mode = "ci-gated"` is set exactly;
 * returns `"immediate"` in every other case (missing file, missing section,
 * missing key, malformed TOML, or any value other than `"ci-gated"`).
 *
 * The default `"immediate"` preserves the CAM-84 behavior byte-for-byte for
 * existing projects that have no `[ship]` section in their project.toml.
 *
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 *                    Used by tests to target a tmp fixture without modifying
 *                    the real project config.
 */
export function readMergeMode(configPath?: string): MergeMode {
	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const shipSection = config['ship'];
		if (shipSection !== undefined && shipSection !== null && typeof shipSection === 'object') {
			const value = (shipSection as Record<string, unknown>)['merge_mode'];
			if (value === 'ci-gated') {
				return 'ci-gated';
			}
		}
	} catch {
		// Malformed TOML or fs read error: fall back to default.
	}
	return 'immediate';
}

/**
 * Resend notification config read from `[notify]` in project.toml.
 */
export interface ResendConfig {
	/** Resend API key. Empty string when unconfigured. */
	apiKey: string;
	/** Recipient email. Empty string when unconfigured. */
	recipient: string;
}

/**
 * Read the Resend notification config from the project config.
 * Returns `{ apiKey: '', recipient: '' }` when the section or keys are absent,
 * malformed, or non-string — preserving the defensive try/catch/default pattern.
 *
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 */
export function readResendConfig(configPath?: string): ResendConfig {
	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const notifySection = config['notify'];
		if (notifySection !== undefined && notifySection !== null && typeof notifySection === 'object') {
			const section = notifySection as Record<string, unknown>;
			const apiKey = typeof section['resend_api_key'] === 'string' ? section['resend_api_key'] : '';
			const recipient = typeof section['resend_recipient'] === 'string' ? section['resend_recipient'] : '';
			return { apiKey, recipient };
		}
	} catch {
		// Malformed TOML or fs read error: fall back to empty.
	}
	return { apiKey: '', recipient: '' };
}

/**
 * Read the plan approval mode from the project config. Returns `"operator"`
 * only when `[plan] plan_approval = "operator"` is set exactly; returns
 * `"auto"` in every other case (missing file, missing section, missing key,
 * malformed TOML, non-string, or any value other than `"operator"`).
 *
 * The default `"auto"` allows the sidecar to advance without a human gate
 * for projects that have not opted in to operator approval.
 *
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 *                    Used by tests to target a tmp fixture without modifying
 *                    the real project config.
 */
export function readPlanApproval(configPath?: string): PlanApproval {
	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const planSection = config['plan'];
		if (planSection !== undefined && planSection !== null && typeof planSection === 'object') {
			const value = (planSection as Record<string, unknown>)['plan_approval'];
			if (value === 'operator') {
				return 'operator';
			}
		}
	} catch {
		// Malformed TOML or fs read error: fall back to default.
	}
	return 'auto';
}
