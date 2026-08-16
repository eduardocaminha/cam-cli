import { describe, expect, test } from 'bun:test';

import { buildAllowlistedEnv, buildGithubCliEnv } from '../../src/runtime/child-env.ts';
import { buildClaudeEnv } from '../../src/runtime/claude-cli-process.ts';
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
		});
		expect(buildCodexEnv({ ...SOURCE, CODEX_HOME: '/operator/codex' })).toEqual({
			PATH: '/usr/local/bin:/usr/bin',
			HOME: '/operator',
			LANG: 'pt_BR.UTF-8',
			CODEX_HOME: '/operator/codex',
		});
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
