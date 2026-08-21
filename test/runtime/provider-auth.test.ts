import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CodexAppServer } from '../../src/runtime/codex-app-server.ts';
import { NativeProviderAuth } from '../../src/runtime/provider-auth.ts';
import { buildProviderAuthEnv, ensureCodexHome } from '../../src/runtime/provider-env.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'runtime', 'codex-app-server-fixture.ts');
const openServers = new Set<CodexAppServer>();

function fixtureServer(extraArgs: readonly string[] = []): CodexAppServer {
	const server = new CodexAppServer({ command: ['bun', FIXTURE, ...extraArgs] });
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
			PATH: '/usr/bin',
			ANTHROPIC_API_KEY: 'secret',
			CLAUDE_CODE_OAUTH_TOKEN: 'secret',
			OPENAI_API_KEY: 'secret',
			CODEX_ACCESS_TOKEN: 'secret',
			GH_TOKEN: 'secret',
			RESEND_API_KEY: 'secret',
			CODEX_HOME: '/operator/codex',
		})).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/operator/codex' });
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

// GSHIP-664: a credential-blind account/rateLimits/read call, layered onto the
// same `list()` an operator already polls -- never a second route, table or
// poll loop, and never able to fail Codex's own authentication status.
describe('codex subscription usage', () => {
	test('normalizes the reported windows, credit summary, spend-limit summary and reset-credit count', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(['--usage-mode=reported']),
			run: () => ({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }),
			now: () => '2026-08-21T09:00:00.000Z',
		});
		const codex = (await auth.list())[1];

		expect(codex?.usage).toEqual({
			windows: [
				{
					window: 'primary',
					usedPercent: 21,
					windowMinutes: 10_080,
					observedAt: '2026-08-21T09:00:00.000Z',
					resetsAt: '2026-08-27T14:38:18.000Z',
				},
				{
					window: 'secondary',
					usedPercent: 5,
					windowMinutes: 300,
					observedAt: '2026-08-21T09:00:00.000Z',
					resetsAt: '2026-08-21T08:03:39.000Z',
				},
			],
			credits: { hasCredits: false, unlimited: false, balance: '0' },
			spendLimit: { limit: '$100.00', used: '$42.00', remainingPercent: 58, resetsAt: '2026-08-27T14:38:18.000Z' },
			resetCreditCount: 2,
		});
		// Never the opaque per-limit-id breakdown or identifiers the wire response also carried.
		expect(JSON.stringify(codex?.usage)).not.toContain('limitId');
		expect(JSON.stringify(codex?.usage)).not.toContain('rateLimitsByLimitId');
		await auth.close();
	});

	test('reads as unavailable, never zero, when nothing was ever reported', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			run: () => ({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }),
		});
		const codex = (await auth.list())[1];
		expect(codex).not.toHaveProperty('usage');
		await auth.close();
	});

	test('drops a malformed usedPercent instead of showing a false reading', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(['--usage-mode=malformed']),
			run: () => ({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }),
		});
		const codex = (await auth.list())[1];
		expect(codex).not.toHaveProperty('usage');
		await auth.close();
	});

	test('a failed usage read never fails Codex authentication itself', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(['--usage-mode=error']),
			run: () => ({
				exitCode: 0,
				stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
				stderr: '',
			}),
		});
		const statuses = await auth.list();
		const codex = statuses[1];
		expect(codex).toMatchObject({ id: 'codex', installed: true, subscription: true, plan: 'plus' });
		expect(codex).not.toHaveProperty('usage');
		await auth.close();
	});
});

describe('ensureCodexHome', () => {
	test('creates CODEX_HOME (and any missing parents) when set', () => {
		const root = createTestTmpdir('gship-test-codex-home-');
		const codexHome = join(root, 'nested', 'codex');
		expect(existsSync(codexHome)).toBe(false);

		ensureCodexHome({ CODEX_HOME: codexHome });

		expect(existsSync(codexHome)).toBe(true);
	});

	test('is a no-op, on an existing volume, whose codex directory already exists', () => {
		const root = createTestTmpdir('gship-test-codex-home-');
		ensureCodexHome({ CODEX_HOME: root });
		expect(() => ensureCodexHome({ CODEX_HOME: root })).not.toThrow();
	});

	test('does nothing outside the container image, where CODEX_HOME is unset', () => {
		expect(() => ensureCodexHome({})).not.toThrow();
		expect(() => ensureCodexHome({ CODEX_HOME: '' })).not.toThrow();
	});
});
