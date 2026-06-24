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
// --show (print current config without prompting) is stubbed here and
// implemented in US-008.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { render } from 'ink';
import { createElement } from 'react';

import { mergeIntoConfig } from '../config/toml.ts';
import type { TomlConfig, TomlSection } from '../config/toml.ts';
import { printHint } from '../logging/color.ts';
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
// Public entrypoint
// ---------------------------------------------------------------------------

export interface RunConfigOptions {
	/** Override the project config path (default: scripts/cam/project.toml in cwd). */
	configPath?: string;
	/** --show: print current config without prompting (implemented in US-008). */
	show?: boolean;
}

export async function runConfig(options: RunConfigOptions = {}): Promise<number> {
	const cwd = process.cwd();
	const configPath = options.configPath ?? join(cwd, 'scripts', 'cam', 'project.toml');

	if (options.show) {
		printHint('--show is implemented in US-008');
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
