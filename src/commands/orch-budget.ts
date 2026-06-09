// src/commands/orch-budget.ts
//
// `cam orch-budget` (CAM-23 US-001): a thin shell surface the orchestrator agent
// invokes to read its own token spend versus the self-handoff threshold. Prints a
// single machine-parseable line and always exits 0 (a missing transcript is 0
// spend, not an error):
//
//   CAM_ORCH_BUDGET=<spend>/<threshold> over=<true|false>
//
// The agent calls this each cycle; when over=true it writes its handoff (US-002)
// and exits so `cam run` respawns it fresh (US-003 / US-004). All token math lives
// in src/orchestrator/budget.ts (pure, tested); this file is just the I/O wiring.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { loadConfig, type TomlSection } from '../config/toml.ts';
import { computeOrchBudget } from '../orchestrator/budget.ts';
import { orchestratorTranscriptPath } from '../transcript/usage.ts';

export interface RunOrchBudgetOptions {
	/** Project root (default: process.cwd()). */
	cwd?: string;
	/** Claude config dir (default: CLAUDE_CONFIG_DIR or ~/.claude). */
	claudeDir?: string;
	/** Raw CAM_ORCH_TOKEN_BUDGET (default: process.env). */
	envBudget?: string;
	/** Output writer (default: process.stdout.write). Injected for tests. */
	write?: (s: string) => void;
}

/**
 * Read `[orchestrator] token_budget` from `scripts/cam/project.toml` if present
 * and numeric. Returns undefined on missing file / parse error / wrong type, so
 * the caller falls through to the env / default precedence.
 */
function readTomlBudget(cwd: string): number | undefined {
	const tomlPath = join(cwd, 'scripts', 'cam', 'project.toml');
	if (!existsSync(tomlPath)) return undefined;
	let config;
	try {
		config = loadConfig(tomlPath);
	} catch {
		return undefined;
	}
	const section = config['orchestrator'];
	if (section !== undefined && typeof section === 'object') {
		const value = (section as TomlSection)['token_budget'];
		if (typeof value === 'number') return value;
	}
	return undefined;
}

/** Implementation of `cam orch-budget`. Returns the process exit code (always 0). */
export function runOrchBudget(options: RunOrchBudgetOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir =
		options.claudeDir ?? (process.env['CLAUDE_CONFIG_DIR'] ?? join(os.homedir(), '.claude'));
	const envBudget = options.envBudget ?? process.env['CAM_ORCH_TOKEN_BUDGET'];
	const write =
		options.write ??
		((s: string) => {
			process.stdout.write(s);
		});

	const budget = computeOrchBudget({
		readTranscript: () => {
			const path = orchestratorTranscriptPath(cwd, claudeDir);
			if (path === null) return null;
			try {
				return readFileSync(path, 'utf8');
			} catch {
				return null;
			}
		},
		envBudget,
		tomlBudget: readTomlBudget(cwd),
	});

	write(`CAM_ORCH_BUDGET=${budget.spend}/${budget.threshold} over=${budget.overBudget}\n`);
	return 0;
}
