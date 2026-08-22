import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CodexAppServer } from '../../src/runtime/codex-app-server.ts';
import { CLAUDE_VALIDATION_COMMAND, NativeProviderAuth } from '../../src/runtime/provider-auth.ts';
import { buildClaudeAuthEnv, buildProviderAuthEnv, ensureCodexHome } from '../../src/runtime/provider-env.ts';
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

// GSHIP-704: the Claude provider's own dedicated-credential boundary, kept
// entirely separate from the shared, credential-blind env above -- Codex's
// commands never see this token, and Claude's own commands only see it via
// `buildClaudeAuthEnv`, never through the generic `buildProviderAuthEnv`.
describe('Claude dedicated credential boundary (GSHIP-704)', () => {
	// CLAUDE_CONFIG_DIR keeps flowing through even with a token present: it
	// also carries session/`--resume` state, and in the container it already
	// names a subpath of the persistent GATESHIP_HOME volume rather than
	// Claude Desktop's own store, so there is nothing to isolate away from
	// there. Auth precedence rests on the Claude CLI's own documented
	// behavior for CLAUDE_CODE_OAUTH_TOKEN, not on deleting the config dir.
	test('a dedicated token rides alongside CLAUDE_CONFIG_DIR, never CODEX_HOME', () => {
		expect(buildClaudeAuthEnv({
			PATH: '/usr/bin',
			CLAUDE_CONFIG_DIR: '/operator/claude',
			CODEX_HOME: '/operator/codex',
		}, 'sk-ant-oat01-secret')).toEqual({
			PATH: '/usr/bin',
			CLAUDE_CONFIG_DIR: '/operator/claude',
			CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret',
		});
	});

	test('an absent or empty token leaves the existing external-login boundary untouched', () => {
		const source = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/operator/claude', CODEX_HOME: '/operator/codex' };
		expect(buildClaudeAuthEnv(source)).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/operator/claude' });
		expect(buildClaudeAuthEnv(source, '')).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/operator/claude' });
	});

	test('reports the dedicated origin only while a credential resolves, external otherwise', async () => {
		let token: string | undefined;
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			resolveClaudeCredential: () => token,
			run: () => ({
				exitCode: 0,
				stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }),
				stderr: '',
			}),
		});

		const external = (await auth.list())[0];
		expect(external).toMatchObject({ login: 'external', subscription: true });

		token = 'sk-ant-oat01-secret';
		const dedicated = (await auth.list())[0];
		expect(dedicated).toMatchObject({ login: 'dedicated', subscription: true });
		await auth.close();
	});

	test('reports a dedicated origin even while the credential fails to resolve a subscription', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			resolveClaudeCredential: () => 'sk-ant-oat01-revoked',
			run: () => ({ exitCode: 1, stdout: '', stderr: 'Invalid API key.' }),
		});
		const claude = (await auth.list())[0];
		// Fails closed (GSHIP-704): never falls back to reporting `external`,
		// which would misdirect the operator toward `claude auth login` instead
		// of toward reconnecting the dedicated credential that actually failed.
		expect(claude).toMatchObject({ login: 'dedicated', subscription: false });
		await auth.close();
	});

	// GSHIP-705: a token from `claude setup-token` authenticates as
	// `oauth_token`, never `claude.ai`. Requiring `claude.ai` reported every
	// dedicated credential as disconnected the moment it was connected.
	test('recognizes a dedicated setup-token login as a connected subscription', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			resolveClaudeCredential: () => 'sk-ant-oat01-secret',
			run: () => ({
				exitCode: 0,
				stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }),
				stderr: '',
			}),
		});
		expect((await auth.list())[0]).toMatchObject({ login: 'dedicated', subscription: true });
		await auth.close();
	});

	test('still refuses an API key: that is pay-per-token access, not the subscription this status claims', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			run: () => ({
				exitCode: 0,
				stdout: JSON.stringify({ loggedIn: true, authMethod: 'apiKey' }),
				stderr: '',
			}),
		});
		expect((await auth.list())[0]).toMatchObject({ login: 'external', subscription: false });
		await auth.close();
	});

	// GSHIP-705: every test below injects its own runner, so this is the one
	// place the argv the service actually spawns is pinned. Its flags were
	// measured against the installed CLI (see CLAUDE_VALIDATION_COMMAND); what
	// this guards is that a later edit cannot quietly re-open a surface or
	// move the positional prompt behind a variadic flag, either of which turns
	// a valid token into a refusal.
	test('the spawned validation argv asks for one tool-free, unpersisted turn', () => {
		const argv = CLAUDE_VALIDATION_COMMAND;
		expect(argv[0]).toBe('claude');
		expect(argv).toContain('--print');
		expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
		// No built-in tool, no inherited MCP server, no skill, no customization.
		expect(argv[argv.indexOf('--tools') + 1]).toBe('');
		expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
		expect(argv).toContain('--strict-mcp-config');
		expect(argv).toContain('--disable-slash-commands');
		expect(argv).toContain('--safe-mode');
		expect(argv).toContain('--no-session-persistence');
		// The prompt is positional and last, and the argument before it is a
		// boolean flag: `--tools` and `--mcp-config` are variadic and would
		// otherwise swallow it as one more of their values.
		const prompt = argv[argv.length - 1] ?? '';
		expect(prompt.startsWith('--')).toBe(false);
		expect(argv[argv.length - 2]).toBe('--no-session-persistence');
	});

	// GSHIP-705: `claude auth status` reports a login for a token the API then
	// refuses, so the decision rests on one real, tool-free inference call
	// carrying exactly the candidate token.
	test('decides a candidate token on an isolated, tool-free inference call', async () => {
		const seen: Array<{ token: string; command: string[] }> = [];
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async (token, command) => {
				seen.push({ token, command });
				return command.includes('--print')
					? { exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }), stderr: '' }
					: {
						exitCode: 0,
						stdout: JSON.stringify({
							loggedIn: true,
							authMethod: 'oauth_token',
							email: 'alice@example.com',
							orgName: 'Acme',
							subscriptionType: 'max',
						}),
						stderr: '',
					};
			},
		});
		const result = await auth.validateClaudeCredential('sk-ant-oat01-candidate');
		expect(result).toEqual({
			ok: true,
			identity: { account: 'alice@example.com', organization: 'Acme', plan: 'max' },
		});
		expect(seen.map((call) => call.token)).toEqual([
			'sk-ant-oat01-candidate',
			'sk-ant-oat01-candidate',
		]);
		const inference = seen[0]?.command ?? [];
		expect(inference).toContain('--print');
		// No tools, no MCP server, no slash command, no inherited customization.
		expect(inference[inference.indexOf('--tools') + 1]).toBe('');
		expect(inference).toContain('--strict-mcp-config');
		expect(inference).toContain('--disable-slash-commands');
		expect(inference).toContain('--safe-mode');
		await auth.close();
	});

	// GSHIP-705: an inference-limited token exposes no identity at all. That is
	// a validated credential with nothing to show, never a failed connection.
	test('validates a token that exposes no identity, without inventing one', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async (_token, command) => command.includes('--print')
				? { exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }), stderr: '' }
				: { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }), stderr: '' },
		});
		expect(await auth.validateClaudeCredential('sk-ant-oat01-anonymous')).toEqual({ ok: true });
		await auth.close();
	});

	// GSHIP-705: the whole reason the status read cannot be the gate.
	test('refuses a token the status read accepts but inference rejects', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async (_token, command) => command.includes('--print')
				? { exitCode: 1, stdout: '', stderr: 'OAuth token revoked.' }
				: {
					exitCode: 0,
					stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', email: 'alice@example.com' }),
					stderr: '',
				},
		});
		const result = await auth.validateClaudeCredential('sk-ant-oat01-revoked');
		expect(result).toEqual({ ok: false, message: 'OAuth token revoked.' });
		await auth.close();
	});

	test('reports the CLI\'s own refusal from its result envelope when nothing reached stderr', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async () => ({
				exitCode: 1,
				stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key provided.' }),
				stderr: '',
			}),
		});
		expect(await auth.validateClaudeCredential('sk-ant-oat01-bad')).toEqual({
			ok: false,
			message: 'Invalid API key provided.',
		});
		await auth.close();
	});

	// Fail-closed: output that is not the envelope `--output-format json`
	// promises never demonstrated that this token reached the API.
	test('refuses a clean exit whose output does not parse as a completed call', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async () => ({ exitCode: 0, stdout: 'not json', stderr: '' }),
		});
		const result = await auth.validateClaudeCredential('sk-ant-oat01-strange');
		expect(result.ok).toBe(false);
		expect(result.message).toBe('Claude refused this token for inference.');
		await auth.close();
	});

	test('never reports identity when the inference call itself was refused', async () => {
		let statusReads = 0;
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async (_token, command) => {
				if (!command.includes('--print')) statusReads += 1;
				return { exitCode: 1, stdout: '', stderr: 'Credit balance is too low.' };
			},
		});
		expect(await auth.validateClaudeCredential('sk-ant-oat01-broke')).toEqual({
			ok: false,
			message: 'Credit balance is too low.',
		});
		expect(statusReads).toBe(0);
		await auth.close();
	});

	// A failed identity read is not a failed credential: inference already
	// answered the only question that decides this.
	test('keeps a validated credential when the identity read itself fails', async () => {
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async (_token, command) => command.includes('--print')
				? { exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }), stderr: '' }
				: { exitCode: 1, stdout: '', stderr: 'status unavailable' },
		});
		expect(await auth.validateClaudeCredential('sk-ant-oat01-candidate')).toEqual({ ok: true });
		await auth.close();
	});

	test('refuses an empty token without spawning a validation process', async () => {
		let calls = 0;
		const auth = new NativeProviderAuth({
			codex: fixtureServer(),
			runClaudeToken: async () => {
				calls += 1;
				return { exitCode: 0, stdout: '{}', stderr: '' };
			},
		});
		expect(await auth.validateClaudeCredential('   ')).toEqual({
			ok: false,
			message: 'A non-empty token is required.',
		});
		expect(calls).toBe(0);
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
