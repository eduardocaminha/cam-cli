// src/commands/config.ts
//
// `cam config` command: interactive Ink wizard that walks the operator through
// model selection for each cam phase (orchestrator, planner, auditor,
// implementer, reviewer, ship) and backend selection, then persists the
// choices to scripts/cam/project.toml via mergeIntoConfig.
//
// The persistence logic (mergeConfigChoices) is exported as a pure helper so
// unit tests can assert the TOML output without touching the live Ink renderer.
//
// --show (print current config non-interactively) reads the resolved per-phase
// model + backend from project.toml and prints a plain-text table to stdout.
// It does NOT enter the Ink render path: no raw-mode, no TTY requirement.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

import { render } from 'ink';
import { createElement } from 'react';

import { readPhaseModel, readPhaseBackend } from '../config/models.ts';
import type { Phase, LlmPhase } from '../config/models.ts';
import { mergeIntoConfig } from '../config/toml.ts';
import type { TomlConfig, TomlSection } from '../config/toml.ts';
import {
	rewriteFrontmatterModel,
	FRONTMATTER_TARGET_PHASE_PATHS,
	rewriteFrontmatterEffort,
	FRONTMATTER_TARGET_EFFORT_PATHS,
} from '../templates/frontmatter.ts';
import { printHint, printWarning } from '../logging/color.ts';
import { AUTOMERGE_NOTICE } from '../logging/notices.ts';
import { ConfigScreen } from '../ui/ConfigScreen.tsx';
import type { ConfigChoices } from '../ui/ConfigScreen.tsx';
import { applyMergeMode } from './setup-merge-mode.ts';
import type { SpawnFn } from '../release/branch-protection.ts';

export type { ConfigChoices };

// ---------------------------------------------------------------------------
// Auto-merge notice (exported seam for unit tests)
// ---------------------------------------------------------------------------

/**
 * Print the auto-merge prerequisite notice via printHint.
 *
 * Accepts an optional hintFn so tests can capture the output without
 * monkey-patching process.stdout (defaults to printHint from color.ts).
 */
export function printConfigAutomergeHint(
	hintFn: (msg: string) => void = printHint,
): void {
	hintFn(AUTOMERGE_NOTICE);
}

// ---------------------------------------------------------------------------
// Persistence helper (pure — no Ink, unit-testable without a live terminal)
// ---------------------------------------------------------------------------

/**
 * Injectable options for the merge-mode side-effect in mergeConfigChoices.
 * All fields are optional; production defaults use process spawnSync +
 * printHint/printWarning. Inject fakes in unit tests to avoid real gh calls.
 */
export interface MergeModeOpts {
	spawnFn?: SpawnFn;
	emitHint?: (msg: string) => void;
	emitWarning?: (msg: string, hint?: string) => void;
	emitResult?: (msg: string) => void;
	/**
	 * Owner/repo slug (e.g. "acme/my-repo"). Passed directly to applyMergeMode
	 * so tests can bypass the `gh repo view` resolution call.
	 */
	ownerRepo?: string;
}

/**
 * Build the [notify] section update from the wizard's resendRecipient/
 * resendFrom choices. An empty string means "leave unset" (per the wizard
 * contract in ConfigScreen.tsx) and is never written. resend_api_key is
 * NEVER emitted here -- it stays sourced from the RESEND_API_KEY env var
 * only (see readResendConfig).
 *
 * Returns an empty section (`{}`) when neither value is set, so callers can
 * skip the mergeIntoConfig call entirely rather than writing an empty table.
 */
function buildNotifyUpdate(choices: ConfigChoices): TomlSection {
	const notify: TomlSection = {};
	if (choices.resendRecipient !== undefined && choices.resendRecipient !== '') {
		notify['resend_recipient'] = choices.resendRecipient;
	}
	if (choices.resendFrom !== undefined && choices.resendFrom !== '') {
		notify['resend_from'] = choices.resendFrom;
	}
	return notify;
}

/**
 * Persist [ship] merge_mode and invoke the branch-protection helper for
 * ci-gated (no-op for immediate). Extracted from mergeConfigChoices to keep
 * its cognitive complexity under biome's ceiling.
 */
function persistMergeMode(
	configPath: string,
	choices: ConfigChoices,
	mergeModeOpts?: MergeModeOpts,
): void {
	if (choices.mergeMode === undefined) return;

	mergeIntoConfig(configPath, {
		ship: { merge_mode: choices.mergeMode } as TomlSection,
	});

	const prodSpawnFn: SpawnFn = (cmd, args, opts) =>
		spawnSync(cmd, args, { encoding: 'utf8', input: opts.input }) as SpawnSyncReturns<string>;

	applyMergeMode({
		mergeMode: choices.mergeMode,
		spawnFn: mergeModeOpts?.spawnFn ?? prodSpawnFn,
		ownerRepo: mergeModeOpts?.ownerRepo,
		emitHint: mergeModeOpts?.emitHint,
		emitWarning: mergeModeOpts?.emitWarning,
		emitResult: mergeModeOpts?.emitResult,
	});
}

/**
 * Rewrite the `model:` frontmatter line in each project-local .claude/
 * runtime file named in FRONTMATTER_TARGET_PHASE_PATHS, resolved relative to
 * `cwd`. Files that do not exist are silently skipped. Extracted from
 * mergeConfigChoices to keep its cognitive complexity under biome's ceiling.
 */
function rewriteFrontmatterModels(cwd: string, choices: ConfigChoices): void {
	for (const [phase, relPath] of Object.entries(FRONTMATTER_TARGET_PHASE_PATHS)) {
		const fullPath = join(cwd, relPath);
		if (!existsSync(fullPath)) continue;
		const model = choices.models[phase as keyof typeof choices.models];
		if (model === undefined) continue;
		const original = readFileSync(fullPath, 'utf8');
		const updated = rewriteFrontmatterModel(original, model);
		if (updated !== original) {
			writeFileSync(fullPath, updated, 'utf8');
		}
	}
}

/**
 * Rewrite the `effort:` frontmatter line in each project-local .claude/agents/
 * subagent-<phase>.md file named in FRONTMATTER_TARGET_EFFORT_PATHS, resolved
 * relative to `cwd`. Files that do not exist are silently skipped, and the
 * rewrite is skipped entirely when the wizard did not collect efforts
 * (choices.efforts is undefined). Extracted from mergeConfigChoices to keep
 * its cognitive complexity under biome's ceiling.
 */
function rewriteFrontmatterEfforts(cwd: string, choices: ConfigChoices): void {
	if (choices.efforts === undefined) return;
	for (const [phase, relPath] of Object.entries(FRONTMATTER_TARGET_EFFORT_PATHS)) {
		const fullPath = join(cwd, relPath);
		if (!existsSync(fullPath)) continue;
		const effort = choices.efforts[phase as LlmPhase];
		if (effort === undefined) continue;
		const original = readFileSync(fullPath, 'utf8');
		const updated = rewriteFrontmatterEffort(original, effort);
		if (updated !== original) {
			writeFileSync(fullPath, updated, 'utf8');
		}
	}
}

/**
 * Persist `choices` into `configPath` (scripts/cam/project.toml) additively
 * via mergeIntoConfig:
 *
 *   [models]
 *   orchestrator = "<model>"
 *   planner      = "<model>"
 *   ...
 *
 *   [efforts]
 *   orchestrator = "<effort>"                (when choices.efforts is defined)
 *   planner      = "<effort>"
 *   ...                                      (5 LLM phases only, ship excluded)
 *
 *   [backend]
 *   orchestrator = "<backend>"
 *   planner      = "<backend>"
 *   ...                                      (one key per phase, all 6 phases)
 *
 *   [ship]
 *   merge_mode = "immediate"|"ci-gated"   (when choices.mergeMode is defined)
 *
 *   [plan]
 *   plan_approval = "auto"|"operator"     (when choices.planApproval is defined)
 *
 *   [notify]
 *   resend_recipient = "<addr>"           (when choices.resendRecipient is non-empty)
 *   resend_from      = "<addr>"           (when choices.resendFrom is non-empty)
 *
 * resend_api_key is NEVER written to project.toml by this helper: the API key
 * is sourced exclusively from the RESEND_API_KEY environment variable.
 *
 * Pre-existing keys (issue_system, issue_prefix, etc.) are preserved.
 *
 * When `choices.mergeMode` is `"ci-gated"`, invokes the US-002
 * branch-protection helper (configureBranchProtection via applyMergeMode) and
 * prints the configured/verified or fallback-warn result. When `"immediate"`,
 * the helper is NOT invoked.
 *
 * When `cwd` is provided, also rewrites the `model:` frontmatter line in the
 * single project-local .claude/ runtime file for the ship phase (resolved
 * relative to `cwd`) -- the one role whose model is not passed via --model --
 * and, when `choices.efforts` is defined, the `effort:` frontmatter line in
 * each of the 5 LLM-phase `.claude/agents/subagent-<phase>.md` files (never
 * ship, which has no effort concept). Files that do not exist are silently
 * skipped (e.g. a project that has not run `cam init` yet).
 */
export function mergeConfigChoices(
	configPath: string,
	choices: ConfigChoices,
	cwd?: string,
	mergeModeOpts?: MergeModeOpts,
): void {
	const updates: TomlConfig = {
		models: choices.models as TomlSection,
		backend: choices.backend as TomlSection,
	};
	mergeIntoConfig(configPath, updates);

	// Persist [efforts] when the wizard collected per-LLM-phase effort choices
	// (ship is never a key here: LlmPhase excludes it at the type level).
	if (choices.efforts !== undefined) {
		mergeIntoConfig(configPath, {
			efforts: choices.efforts as TomlSection,
		});
	}

	// Persist [plan] plan_approval when the wizard collected it.
	if (choices.planApproval !== undefined) {
		mergeIntoConfig(configPath, {
			plan: { plan_approval: choices.planApproval } as TomlSection,
		});
	}

	// Persist [notify] resend_recipient/resend_from when the wizard collected
	// non-empty values.
	const notify = buildNotifyUpdate(choices);
	if (Object.keys(notify).length > 0) {
		mergeIntoConfig(configPath, { notify });
	}

	persistMergeMode(configPath, choices, mergeModeOpts);

	if (cwd !== undefined) {
		rewriteFrontmatterModels(cwd, choices);
		rewriteFrontmatterEfforts(cwd, choices);
	}
}

// ---------------------------------------------------------------------------
// --show: non-interactive config print (no Ink, no TTY requirement)
// ---------------------------------------------------------------------------

const ORDERED_PHASES: readonly Phase[] = [
	'orchestrator',
	'planner',
	'auditor',
	'implementer',
	'reviewer',
	'ship',
];

/**
 * Print a plain-text table of the current resolved per-phase model + backend
 * to the provided `writer` (defaults to `process.stdout.write`).
 *
 * Non-interactive: safe to call outside a TTY. Does NOT enter the Ink render
 * path. Exported so tests can capture output without intercepting
 * `process.stdout`.
 *
 * Output shape (6 data rows, one per phase, each with its own resolved
 * model + backend column via readPhaseModel/readPhaseBackend):
 *
 *   phase          model   backend
 *   orchestrator   opus    claude
 *   planner        opus    claude
 *   ...
 */
export function printConfigShow(
	configPath: string,
	writer: (s: string) => void = (s) => process.stdout.write(s),
): void {
	// US-002 (CAM-356): resolve backend first per phase and thread it into
	// readPhaseModel so the displayed model column matches what spawn would
	// actually resolve for a codex-backed phase.
	const rows: Array<[string, string, string]> = ORDERED_PHASES.map((phase) => {
		const backend = readPhaseBackend(phase, configPath);
		return [phase, readPhaseModel(phase, configPath, backend), backend] as [string, string, string];
	});

	const phaseWidth = Math.max(...rows.map(([p]) => p.length));
	const modelWidth = Math.max('model'.length, ...rows.map(([, model]) => model.length));
	const header = `${'phase'.padEnd(phaseWidth)}  ${'model'.padEnd(modelWidth)}  backend`;
	const divider = '-'.repeat(header.length);

	writer(header + '\n');
	writer(divider + '\n');
	for (const [phase, model, backend] of rows) {
		writer(`${phase.padEnd(phaseWidth)}  ${model.padEnd(modelWidth)}  ${backend}\n`);
	}
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface RunConfigOptions {
	/** Override the project config path (default: scripts/cam/project.toml in cwd). */
	configPath?: string;
	/** --show: print current config without prompting. */
	show?: boolean;
	/** Injectable writer for --show output (default: process.stdout.write). */
	writer?: (s: string) => void;
}

export async function runConfig(options: RunConfigOptions = {}): Promise<number> {
	const cwd = process.cwd();
	const configPath = options.configPath ?? join(cwd, 'scripts', 'cam', 'project.toml');

	if (options.show) {
		printConfigShow(configPath, options.writer);
		return 0;
	}

	return collectViaInk(configPath, cwd);
}

// ---------------------------------------------------------------------------
// Ink wizard
// ---------------------------------------------------------------------------

function collectViaInk(configPath: string, cwd: string): Promise<number> {
	return new Promise((resolve) => {
		let result: ConfigChoices | null = null;
		const { unmount, waitUntilExit } = render(
			createElement(ConfigScreen, {
				onDone: (choices) => {
					result = choices;
					unmount();
				},
				onCancel: () => {
					result = null;
					unmount();
				},
			}),
		);
		waitUntilExit()
			.then(() => {
				if (result === null) {
					return resolve(1);
				}
				mergeConfigChoices(configPath, result, cwd, {
					emitHint: printHint,
					emitWarning: (msg, hint) => printWarning(msg, hint),
					emitResult: (msg) => process.stdout.write(msg + '\n'),
				});
				printConfigAutomergeHint();
				return resolve(0);
			})
			.catch(() => resolve(1));
	});
}
