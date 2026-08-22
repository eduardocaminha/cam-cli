import { mkdirSync } from 'node:fs';

import { buildAllowlistedEnv } from './child-env.ts';

/** Keep only paths to CLI-owned login state; never inherit ambient secrets. */
export function buildProviderAuthEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return buildAllowlistedEnv(source, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
}

/** Read by `claude setup-token`, never by any other provider (GSHIP-704). */
export const CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * The Claude provider's own credential boundary (GSHIP-704), used only by
 * Gateship-owned Claude CLI spawns -- the auth-status probe, orchestrator,
 * executor, reviewer, the model/effort save probe, and the isolated
 * candidate-token validation spawn -- never by Codex, `gh`, or a project's
 * own commands. `CLAUDE_CONFIG_DIR` still passes
 * through unchanged, present or not: it also carries session/`--resume`
 * state, and in the canonical Docker path it names a subpath of the
 * persistent `GATESHIP_HOME` volume, not Claude Desktop's own store -- there
 * is nothing there to isolate away from, and dropping it would break
 * `--resume` across a container recreate for no isolation gained. Auth
 * precedence instead rests on the Claude CLI's own documented behavior for
 * `CLAUDE_CODE_OAUTH_TOKEN`: when set, the CLI authenticates with it and does
 * not fall back to reading a credential out of `CLAUDE_CONFIG_DIR` on
 * failure, so a revoked or expired token still fails closed. Absent or empty
 * token leaves the boundary exactly as it was before this issue.
 */
export function buildClaudeAuthEnv(
	source: Record<string, string | undefined>,
	token?: string,
): Record<string, string | undefined> {
	const base = buildAllowlistedEnv(source, ['CLAUDE_CONFIG_DIR']);
	const hasToken = token !== undefined && token.length > 0;
	return hasToken ? { ...base, [CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR]: token } : base;
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
