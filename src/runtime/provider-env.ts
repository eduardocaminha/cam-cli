import { mkdirSync } from 'node:fs';

import { buildAllowlistedEnv } from './child-env.ts';

/** Keep only paths to CLI-owned login state; never inherit ambient secrets. */
export function buildProviderAuthEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return buildAllowlistedEnv(source, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
}

/**
 * `codex app-server` hard-fails when CODEX_HOME does not already exist,
 * unlike `claude`, which creates CLAUDE_CONFIG_DIR itself on first use. This
 * runs once at service boot so both a brand-new container volume and one
 * that predates the Codex CLI end up with the directory either way.
 */
export function ensureCodexHome(source: Record<string, string | undefined>): void {
	const codexHome = source['CODEX_HOME'];
	if (codexHome !== undefined && codexHome.length > 0) mkdirSync(codexHome, { recursive: true });
}
