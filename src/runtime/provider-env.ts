/** Keep CLI-owned login state while excluding API keys and injected tokens. */
export function buildProviderAuthEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const env = { ...source };
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	delete env.OPENAI_API_KEY;
	delete env.CODEX_API_KEY;
	delete env.CODEX_ACCESS_TOKEN;
	return env;
}
