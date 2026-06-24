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

import { render } from 'ink';
import { createElement } from 'react';

import { readPhaseModel, readBackend } from '../config/models.ts';
import type { Phase } from '../config/models.ts';
import { mergeIntoConfig } from '../config/toml.ts';
import type { TomlConfig, TomlSection } from '../config/toml.ts';
import {
	rewriteFrontmatterModel,
	FRONTMATTER_TARGET_PHASE_PATHS,
} from '../templates/frontmatter.ts';
import { ConfigScreen } from '../ui/ConfigScreen.tsx';
import type { ConfigChoices } from '../ui/ConfigScreen.tsx';

export type { ConfigChoices };

// ---------------------------------------------------------------------------
// Persistence helper (pure — no Ink, unit-testable without a live terminal)
// ---------------------------------------------------------------------------

/**
 * Persist `choices` into `configPath` (scripts/cam/project.toml) additively
 * via mergeIntoConfig:
 *
 *   [models]
 *   orchestrator = "<model>"
 *   planner      = "<model>"
 *   ...
 *
 *   [backend]
 *   name = "<backend>"
 *
 * Pre-existing keys (issue_system, issue_prefix, etc.) are preserved.
 *
 * When `cwd` is provided, also rewrites the `model:` frontmatter line in the
 * three project-local .claude/ runtime files for planner, auditor, and ship
 * phases (resolved relative to `cwd`). Files that do not exist are silently
 * skipped (e.g. a project that has not run `cam init` yet).
 */
export function mergeConfigChoices(
	configPath: string,
	choices: ConfigChoices,
	cwd?: string,
): void {
	const updates: TomlConfig = {
		models: choices.models as TomlSection,
		backend: { name: choices.backend } as TomlSection,
	};
	mergeIntoConfig(configPath, updates);

	if (cwd !== undefined) {
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
 * Output shape (7 data rows: 6 phases + 1 backend):
 *
 *   phase          model
 *   orchestrator   claude-opus-4-8
 *   planner        claude-opus-4-8
 *   ...
 *   backend        claude
 */
export function printConfigShow(
	configPath: string,
	writer: (s: string) => void = (s) => process.stdout.write(s),
): void {
	const rows: Array<[string, string]> = [
		...ORDERED_PHASES.map((phase) => [phase, readPhaseModel(phase, configPath)] as [string, string]),
		['backend', readBackend(configPath)],
	];

	const phaseWidth = Math.max(...rows.map(([p]) => p.length));
	const header = `${'phase'.padEnd(phaseWidth)}  model`;
	const divider = '-'.repeat(header.length);

	writer(header + '\n');
	writer(divider + '\n');
	for (const [phase, model] of rows) {
		writer(`${phase.padEnd(phaseWidth)}  ${model}\n`);
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
				mergeConfigChoices(configPath, result, cwd);
				return resolve(0);
			})
			.catch(() => resolve(1));
	});
}
