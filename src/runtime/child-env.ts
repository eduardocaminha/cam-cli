/**
 * Environment values a subscription-backed child needs to find executables,
 * its home directory and local CLI login state. Everything else is excluded by
 * default so adding an unrelated secret to the Gateship service cannot silently
 * pass it to an agent or to GitHub CLI.
 */
const BASE_ENV_KEYS = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'TMPDIR',
	'TMP',
	'TEMP',
	'LANG',
	'LANGUAGE',
	'LC_ALL',
	'LC_CTYPE',
	'TERM',
	'COLORTERM',
	'NO_COLOR',
	'XDG_CONFIG_HOME',
	'XDG_CACHE_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'XDG_RUNTIME_DIR',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'__CF_USER_TEXT_ENCODING',
] as const;

export function buildAllowlistedEnv(
	source: Record<string, string | undefined>,
	additionalKeys: readonly string[] = [],
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const key of [...BASE_ENV_KEYS, ...additionalKeys]) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** GitHub CLI owns auth; Gateship deliberately passes no token variables. */
export function buildGithubCliEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return {
		...buildAllowlistedEnv(source, [
			'GH_CONFIG_DIR',
			'GH_NO_UPDATE_NOTIFIER',
		]),
		GH_PROMPT_DISABLED: '1',
	};
}
