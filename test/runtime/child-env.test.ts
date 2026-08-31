import { describe, expect, test } from 'bun:test';

import { buildAllowlistedEnv, buildGithubCliEnv } from '../../src/runtime/child-env.ts';
import { buildClaudeEnv } from '../../src/runtime/claude-cli-process.ts';
import { captureBootClaudeToken, resolveClaudeCredential } from '../../src/runtime/claude-credential.ts';
import { buildCodexEnv } from '../../src/runtime/codex-cli-executor.ts';

const SOURCE = {
	PATH: '/usr/local/bin:/usr/bin',
	HOME: '/operator',
	LANG: 'pt_BR.UTF-8',
	RESEND_API_KEY: 're_secret',
	GH_TOKEN: 'github_pat_secret',
	GITHUB_TOKEN: 'github_token_secret',
	ANTHROPIC_API_KEY: 'anthropic_secret',
	OPENAI_API_KEY: 'openai_secret',
};

describe('child-process environment boundary', () => {
	test('copies only base runtime values and explicitly admitted additions', () => {
		expect(buildAllowlistedEnv({ ...SOURCE, CUSTOM_HOME: '/custom' }, ['CUSTOM_HOME']))
			.toEqual({
				PATH: '/usr/local/bin:/usr/bin',
				HOME: '/operator',
				LANG: 'pt_BR.UTF-8',
				CUSTOM_HOME: '/custom',
			});
	});

	test('agent environments preserve CLI homes without inheriting unrelated secrets', () => {
		expect(buildClaudeEnv({ ...SOURCE, CLAUDE_CONFIG_DIR: '/operator/claude' })).toEqual({
			PATH: '/usr/local/bin:/usr/bin',
			HOME: '/operator',
			LANG: 'pt_BR.UTF-8',
			CLAUDE_CONFIG_DIR: '/operator/claude',
			DISABLE_UPDATES: '1',
		});
		expect(buildCodexEnv({ ...SOURCE, CODEX_HOME: '/operator/codex' })).toEqual({
			PATH: '/usr/local/bin:/usr/bin',
			HOME: '/operator',
			LANG: 'pt_BR.UTF-8',
			CODEX_HOME: '/operator/codex',
		});
	});

	// GSHIP-704: the dedicated Claude subscription token, resolved at the
	// provider boundary and passed here explicitly -- never read off `source`
	// itself, so a value only sitting in the caller's own environment cannot
	// leak in through this function's normal allowlist path. CLAUDE_CONFIG_DIR
	// still reaches the child unchanged: it also carries session/`--resume`
	// state (and, in the container, a subpath of the persistent GATESHIP_HOME
	// volume rather than Claude Desktop's own store), so auth precedence rests
	// on the Claude CLI's own documented behavior for this env var, not on
	// Gateship deleting the config dir.
	test('a dedicated Claude token rides alongside CLAUDE_CONFIG_DIR, never displacing it', () => {
		expect(buildClaudeEnv(
			{ ...SOURCE, CLAUDE_CONFIG_DIR: '/operator/claude' },
			'sk-ant-oat01-secret',
		)).toEqual({
			PATH: '/usr/local/bin:/usr/bin',
			HOME: '/operator',
			LANG: 'pt_BR.UTF-8',
			CLAUDE_CONFIG_DIR: '/operator/claude',
			CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret',
			DISABLE_UPDATES: '1',
		});
		// The orchestrator, executor and reviewer all resolve to no dedicated
		// credential the same way: an absent or empty token leaves the existing
		// external-login boundary exactly as it read before this issue.
		expect(buildClaudeEnv({ ...SOURCE, CLAUDE_CONFIG_DIR: '/operator/claude' }, undefined)).toEqual(
			buildClaudeEnv({ ...SOURCE, CLAUDE_CONFIG_DIR: '/operator/claude' }),
		);
		expect(buildClaudeEnv({ ...SOURCE, CLAUDE_CONFIG_DIR: '/operator/claude' }, '')).toEqual(
			buildClaudeEnv({ ...SOURCE, CLAUDE_CONFIG_DIR: '/operator/claude' }),
		);
	});

	test('never reads a dedicated token that only happens to sit in the source environment', () => {
		expect(buildClaudeEnv({ ...SOURCE, CLAUDE_CODE_OAUTH_TOKEN: 'ambient-value' }))
			.not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
	});

	test('GitHub CLI always uses its credential store rather than ambient tokens', () => {
		expect(buildGithubCliEnv({
			...SOURCE,
			GH_CONFIG_DIR: '/operator/gh',
			GH_REPO: 'someone/else',
			GH_HOST: 'unexpected.example',
		})).toEqual({
			PATH: '/usr/local/bin:/usr/bin',
			HOME: '/operator',
			LANG: 'pt_BR.UTF-8',
			GH_CONFIG_DIR: '/operator/gh',
			GH_PROMPT_DISABLED: '1',
		});
	});
});

// GSHIP-704: the dedicated Claude credential's own boot-time environment
// variable must never stay ambient in the service's `process.env`, including
// for owned commands that might explicitly forward their caller environment.
describe('captureBootClaudeToken (GSHIP-704)', () => {
	test('removes the token from the given environment and returns it as a snapshot', () => {
		const env: Record<string, string | undefined> = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-boot' };
		const snapshot = captureBootClaudeToken(env);
		expect(snapshot).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-boot' });
		// The live environment object itself no longer carries it: this is what
		// keeps it out of `runOwnedCommand`'s own `process.env` default.
		expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
		expect(env).toEqual({ PATH: '/usr/bin' });
	});

	test('returns an empty snapshot, and changes nothing, when no token was ever set', () => {
		const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
		expect(captureBootClaudeToken(env)).toEqual({});
		expect(env).toEqual({ PATH: '/usr/bin' });
	});

	// The two functions compose exactly as the composition root uses them: the
	// captured snapshot alone is enough for `resolveClaudeCredential` to keep
	// resolving to the boot-provisioned token, with nothing left in `env`.
	test('a captured token still resolves through resolveClaudeCredential from the snapshot alone', () => {
		const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-boot' };
		const snapshot = captureBootClaudeToken(env);
		expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
		expect(resolveClaudeCredential('/unused/gateship-home', snapshot)).toBe('sk-ant-oat01-boot');
	});

	test('mutates the real process.env when called with its default argument', () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-real-boot';
		try {
			const snapshot = captureBootClaudeToken();
			expect(snapshot).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-real-boot' });
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			// The exact condition `runOwnedCommand`'s `env: input.env ?? process.env`
			// default would see: the key is gone, not merely falsy.
			expect('CLAUDE_CODE_OAUTH_TOKEN' in process.env).toBe(false);
		} finally {
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		}
	});
});
