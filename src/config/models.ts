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
 * Resend notification config.
 */
export interface ResendConfig {
	/** Resend API key. Empty string when unconfigured. */
	apiKey: string;
	/** Recipient email. Empty string when unconfigured. */
	recipient: string;
}

/**
 * Read the Resend notification config.
 *
 * API key resolution order (mirrors the LINEAR_API_KEY convention):
 *   1. `RESEND_API_KEY` environment variable (canonical, not git-tracked).
 *   2. `resend_api_key` in `[notify]` of project.toml (backward compat only).
 *
 * Recipient is always read from `[notify] resend_recipient` in project.toml.
 *
 * Returns `{ apiKey: '', recipient: '' }` when neither source is configured.
 *
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 */
export function readResendConfig(configPath?: string): ResendConfig {
	// Canonical source: RESEND_API_KEY env var (not git-tracked).
	const envApiKey = process.env['RESEND_API_KEY'] ?? '';

	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const notifySection = config['notify'];
		if (notifySection !== undefined && notifySection !== null && typeof notifySection === 'object') {
			const section = notifySection as Record<string, unknown>;
			// Env var takes priority; fall back to TOML for backward compat.
			const apiKey = envApiKey !== '' ? envApiKey :
				(typeof section['resend_api_key'] === 'string' ? section['resend_api_key'] : '');
			const recipient = typeof section['resend_recipient'] === 'string' ? section['resend_recipient'] : '';
			return { apiKey, recipient };
		}
	} catch {
		// Malformed TOML or fs read error: fall back to env-only.
	}
	return { apiKey: envApiKey, recipient: '' };
}

/**
 * Worker isolation mode. `"container"` spawns workers inside the container;
 * `"host"` spawns on the host (the default, fail-closed).
 */
export type WorkerIsolation = 'host' | 'container';

/**
 * The meta-loop mode. `"observe"` enables the inter-cycle drainer;
 * `"off"` disables it (the default, fail-closed).
 */
export type MetaLoop = 'off' | 'observe';

/**
 * Read the meta-loop mode from the project config. Returns `"observe"` only
 * when `[loop] meta_loop = "observe"` is set exactly; returns `"off"` in
 * every other case (missing file, missing section, missing key, malformed
 * TOML, non-string, or any value other than `"observe"`).
 *
 * The default `"off"` is fail-closed: a typo (e.g. `"auto"`, `"OBSERVE"`)
 * never arms the inter-cycle drainer.
 *
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 *                    Used by tests to target a tmp fixture without modifying
 *                    the real project config.
 */
export function readMetaLoop(configPath?: string): MetaLoop {
	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const loopSection = config['loop'];
		if (loopSection !== undefined && loopSection !== null && typeof loopSection === 'object') {
			const value = (loopSection as Record<string, unknown>)['meta_loop'];
			if (value === 'observe') {
				return 'observe';
			}
		}
	} catch {
		// Malformed TOML or fs read error: fall back to default.
	}
	return 'off';
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

/**
 * Read the worker isolation mode from the project config. Returns `"container"`
 * only when `[loop] worker_isolation = "container"` is set exactly; returns
 * `"host"` in every other case (missing file, missing [loop] section, missing
 * key, malformed TOML, non-string, or any value other than `"container"`).
 *
 * The default `"host"` is fail-closed: a typo or missing config never silently
 * enables container routing.
 *
 * @param configPath  Override the config file path (default:
 *                    `scripts/cam/project.toml` resolved from `process.cwd()`).
 *                    Used by tests to target a tmp fixture without modifying
 *                    the real project config.
 */
export function readWorkerIsolation(configPath?: string): WorkerIsolation {
	const path = configPath ?? defaultProjectConfigPath();
	try {
		const config = loadConfig(path);
		const loopSection = config['loop'];
		if (loopSection !== undefined && loopSection !== null && typeof loopSection === 'object') {
			const value = (loopSection as Record<string, unknown>)['worker_isolation'];
			if (value === 'container') {
				return 'container';
			}
		}
	} catch {
		// Malformed TOML or fs read error: fall back to default.
	}
	return 'host';
}
