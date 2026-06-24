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

import { join } from 'node:path';
import process from 'node:process';

import { render } from 'ink';
import { createElement } from 'react';

import { mergeIntoConfig } from '../config/toml.ts';
import type { TomlConfig, TomlSection } from '../config/toml.ts';
import { printHint } from '../logging/color.ts';
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
 */
export function mergeConfigChoices(configPath: string, choices: ConfigChoices): void {
	const updates: TomlConfig = {
		models: choices.models as TomlSection,
		backend: { name: choices.backend } as TomlSection,
	};
	mergeIntoConfig(configPath, updates);
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

	return collectViaInk(configPath);
}

// ---------------------------------------------------------------------------
// Ink wizard
// ---------------------------------------------------------------------------

function collectViaInk(configPath: string): Promise<number> {
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
				mergeConfigChoices(configPath, result);
				return resolve(0);
			})
			.catch(() => resolve(1));
	});
}
