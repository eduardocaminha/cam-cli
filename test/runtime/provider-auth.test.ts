import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { CodexAppServer } from '../../src/runtime/codex-app-server.ts';
import { NativeProviderAuth } from '../../src/runtime/provider-auth.ts';
import { buildProviderAuthEnv } from '../../src/runtime/provider-env.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'runtime', 'codex-app-server-fixture.ts');
const openServers = new Set<CodexAppServer>();

function fixtureServer(): CodexAppServer {
	const server = new CodexAppServer({ command: ['bun', FIXTURE] });
	openServers.add(server);
	return server;
}

afterEach(async () => {
	await Promise.all([...openServers].map((server) => server.close()));
	openServers.clear();
});

describe('credential-blind provider auth', () => {
	test('does not let API or injected OAuth environment values choose auth mode', () => {
		expect(buildProviderAuthEnv({
			ANTHROPIC_API_KEY: 'secret',
			CLAUDE_CODE_OAUTH_TOKEN: 'secret',
			OPENAI_API_KEY: 'secret',
			CODEX_ACCESS_TOKEN: 'secret',
			CODEX_HOME: '/operator/codex',
		})).toEqual({ CODEX_HOME: '/operator/codex' });
	});

	test('reads subscription state without exposing account identity or tokens', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			run: () => ({
				exitCode: 0,
				stdout: JSON.stringify({
					loggedIn: true,
					authMethod: 'claude.ai',
					subscriptionType: 'max',
					email: 'not-exposed@example.com',
				}),
				stderr: '',
			}),
		});
		const statuses = await auth.list();

		expect(statuses).toEqual([
			{
				id: 'claude',
				installed: true,
				subscription: true,
				label: 'Claude Code',
				login: 'external',
				plan: 'max',
			},
			{
				id: 'codex',
				installed: true,
				subscription: true,
				label: 'Codex',
				login: 'web',
				plan: 'plus',
			},
		]);
		expect(JSON.stringify(statuses)).not.toContain('not-exposed@example.com');
		await auth.close();
	});

	test('starts the managed ChatGPT browser flow through app-server', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			run: () => ({ exitCode: 1, stdout: '', stderr: 'not signed in' }),
		});
		expect(await auth.startCodexLogin()).toEqual({
			loginId: 'login-1',
			authUrl: 'https://chatgpt.com/login-fixture',
		});
		await auth.close();
	});

	test('does not accept API-key Claude auth as subscription', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			run: () => ({
				exitCode: 0,
				stdout: JSON.stringify({ loggedIn: true, authMethod: 'apiKey' }),
				stderr: '',
			}),
		});
		const claude = (await auth.list())[0];
		expect(claude?.subscription).toBe(false);
		await auth.close();
	});
});
