import { buildAllowlistedEnv } from './child-env.ts';

/** Keep only paths to CLI-owned login state; never inherit ambient secrets. */
export function buildProviderAuthEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return buildAllowlistedEnv(source, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
}
