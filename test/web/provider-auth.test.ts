import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { ProviderCallError } from '../../src/runtime/agent-session.ts';
import type { ProviderAuth, ProviderStatus } from '../../src/runtime/provider-auth.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const providers: ProviderStatus[] = [
	{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', plan: 'max', login: 'external' },
	{ id: 'codex', installed: true, subscription: false, label: 'Codex', login: 'web' },
];

function fakeAuth(): ProviderAuth {
	return {
		list: async () => providers,
		startCodexLogin: async () => ({ loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' }),
		validateClaudeCredential: async () => ({ ok: false, message: 'unused' }),
		close: async () => {},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for provider hold');
		await Bun.sleep(5);
	}
}

describe('provider auth web API', () => {
	test('returns credential-blind status and starts Codex managed login', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-provider-web-runtime-'),
			store: new RunStore(':memory:'),
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-provider-web-'),
			runRuntime: runtime,
			providerAuth: fakeAuth(),
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const status = await fetch(`${origin}/api/providers`);
			expect(status.status).toBe(200);
			expect(await status.json()).toEqual({
				providers: providers.map((provider) => (
					provider.id === 'claude'
						? { ...provider, credential: { envManaged: false } }
						: provider
				)),
				selected: 'claude',
				source: 'provider-default',
			});

			const login = await fetch(`${origin}/api/providers/codex/login`, {
				method: 'POST',
				headers: { origin },
			});
			expect(login.status).toBe(200);
			expect(await login.json()).toEqual({
				ok: true,
				login: { loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' },
			});
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('reports an observed provider hold separately from subscription login', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-provider-availability-runtime-'),
			store: new RunStore(':memory:'),
			newId: () => 'run-provider-availability',
			// Before the hold's own retryAt, so the run rests on it for the
			// whole test instead of taking its automatic retry (GSHIP-711).
			now: () => '2026-08-20T12:00:00.000Z',
			executor: {
				execute: async () => {
					throw new ProviderCallError(
						'claude',
						'usage-limit',
						'Claude usage limit reached.',
						{ retryAt: '2026-08-20T12:10:00.000Z' },
					);
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		runtime.startRun('GSHIP-700');
		await waitFor(() => runtime.listRuns()[0]?.state === 'waiting-provider');
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-provider-availability-web-'),
			runRuntime: runtime,
			providerAuth: fakeAuth(),
		});
		try {
			const payload = await (await fetch(
				`http://${handle.hostname}:${handle.port}/api/providers`,
			)).json() as { providers: Array<Record<string, unknown>> };
			expect(payload.providers[0]).toMatchObject({
				id: 'claude',
				subscription: true,
				availability: {
					kind: 'usage-limit',
					retryAt: '2026-08-20T12:10:00.000Z',
				},
			});
			expect(payload.providers[1]).not.toHaveProperty('availability');
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	});

	// GSHIP-664: Claude's usage is derived from this process's own event log --
	// never a live provider call -- so a rate-limit event a real invocation
	// already recorded is enough, with no run in flight and no executor at all.
	test('attaches Claude usage windows derived from recorded rate-limit events', async () => {
		const store = new RunStore(':memory:');
		store.createRun({
			id: 'run-usage-api',
			issueId: 'GSHIP-701',
			sessionId: 'session-usage-api',
			workspacePath: '/workspaces/run-usage-api',
			createdAt: '2026-08-20T09:00:00.000Z',
		});
		store.appendEvent({
			runId: 'run-usage-api',
			kind: 'provider.rate-limit',
			createdAt: '2026-08-20T09:05:00.000Z',
			payload: { status: 'allowed_warning', limit: 'seven_day', usedPercent: 78, retryAt: '2026-08-27T09:05:00.000Z' },
		});
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-provider-usage-runtime-'),
			store,
			now: () => '2026-08-20T09:06:00.000Z',
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-provider-usage-web-'),
			runRuntime: runtime,
			providerAuth: fakeAuth(),
		});
		try {
			const payload = await (await fetch(
				`http://${handle.hostname}:${handle.port}/api/providers`,
			)).json() as { providers: Array<Record<string, unknown>> };
			expect(payload.providers[0]).toMatchObject({
				id: 'claude',
				usage: {
					windows: [{
						window: 'seven_day',
						status: 'allowed_warning',
						usedPercent: 78,
						observedAt: '2026-08-20T09:05:00.000Z',
						resetsAt: '2026-08-27T09:05:00.000Z',
					}],
				},
			});
			expect(payload.providers[1]).not.toHaveProperty('usage');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('leaves Claude usage absent when no invocation has ever reported a window', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-provider-no-usage-runtime-'),
			store: new RunStore(':memory:'),
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-provider-no-usage-web-'),
			runRuntime: runtime,
			providerAuth: fakeAuth(),
		});
		try {
			const payload = await (await fetch(
				`http://${handle.hostname}:${handle.port}/api/providers`,
			)).json() as { providers: Array<Record<string, unknown>> };
			expect(payload.providers[0]).not.toHaveProperty('usage');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('selects only a connected subscription for future runs', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-provider-select-runtime-'),
			store: new RunStore(':memory:'),
		});
		const connected: ProviderAuth = {
			list: async () => providers.map((provider) => (
				provider.id === 'codex' ? { ...provider, subscription: true } : provider
			)),
			startCodexLogin: async () => ({ loginId: 'unused', authUrl: 'https://chatgpt.com' }),
			validateClaudeCredential: async () => ({ ok: false, message: 'unused' }),
			close: async () => {},
		};
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-provider-select-'),
			runRuntime: runtime,
			providerAuth: connected,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const response = await fetch(`${origin}/api/providers/codex/select`, {
				method: 'POST',
				headers: { origin },
			});
			expect(response.status).toBe(200);
			expect(runtime.getSelectedProvider()).toBe('codex');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects cross-origin login starts', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-provider-origin-runtime-'),
			store: new RunStore(':memory:'),
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-provider-origin-'),
			runRuntime: runtime,
			providerAuth: fakeAuth(),
		});
		try {
			const response = await fetch(
				`http://${handle.hostname}:${handle.port}/api/providers/codex/login`,
				{ method: 'POST', headers: { origin: 'https://attacker.example' } },
			);
			expect(response.status).toBe(403);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});
});

// GSHIP-704: connect, reconnect, rotate and disconnect the Claude provider's
// own dedicated subscription credential, always without the secret coming
// back through any response.
describe('dedicated Claude credential web API', () => {
	function fakeAuthValidating(outcome: {
		ok: boolean;
		identity?: { account?: string; organization?: string; plan?: string };
		message?: string;
	}): ProviderAuth {
		return {
			...fakeAuth(),
			validateClaudeCredential: async () => outcome,
		};
	}

	async function serverWithHome(providerAuth: ProviderAuth) {
		const gateshipHome = createTestTmpdir('gship-claude-credential-home-');
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-claude-credential-runtime-'),
			store: new RunStore(':memory:'),
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-claude-credential-web-'),
			gateshipHome,
			runRuntime: runtime,
			providerAuth,
		});
		return { handle, runtime, gateshipHome, origin: `http://${handle.hostname}:${handle.port}` };
	}

	test('validates before persisting, then confirms what was validated -- never the token', async () => {
		const { handle, runtime, gateshipHome, origin } = await serverWithHome(fakeAuthValidating({
			ok: true,
			identity: { account: 'alice@example.com', organization: 'Acme', plan: 'max' },
		}));
		try {
			const response = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ token: 'sk-ant-oat01-super-secret' }),
			});
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toEqual({
				ok: true,
				validated: 'inference',
				identity: { account: 'alice@example.com', organization: 'Acme', plan: 'max' },
			});
			expect(JSON.stringify(body)).not.toContain('sk-ant-oat01-super-secret');
			expect(existsSync(join(gateshipHome, 'claude-credential'))).toBe(true);

			const status = await (await fetch(`${origin}/api/providers`)).json() as {
				providers: Array<Record<string, unknown>>;
			};
			expect(status.providers[0]).toMatchObject({
				id: 'claude',
				credential: { envManaged: false },
			});
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects an invalid token without persisting it', async () => {
		const { handle, runtime, gateshipHome, origin } = await serverWithHome(fakeAuthValidating({
			ok: false,
			message: 'Invalid API key.',
		}));
		try {
			const response = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ token: 'sk-ant-oat01-wrong' }),
			});
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({
				ok: false,
				code: 'invalid-token',
				message: 'Invalid API key.',
			});
			expect(existsSync(join(gateshipHome, 'claude-credential'))).toBe(false);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	// GSHIP-705: an inference-limited token exposes no email, organization or
	// plan. The route confirms exactly what it validated and omits identity
	// rather than promising empty fields a client could read as "no account".
	test('confirms a validated credential that exposes no identity, without inventing one', async () => {
		const { handle, runtime, gateshipHome, origin } = await serverWithHome(fakeAuthValidating({ ok: true }));
		try {
			const response = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ token: 'sk-ant-oat01-anonymous' }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, validated: 'inference' });
			expect(existsSync(join(gateshipHome, 'claude-credential'))).toBe(true);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('disconnect removes the file-backed credential and reports whether one was present', async () => {
		const { handle, runtime, gateshipHome, origin } = await serverWithHome(fakeAuthValidating({ ok: true }));
		try {
			await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ token: 'sk-ant-oat01-rotate-me' }),
			});
			expect(existsSync(join(gateshipHome, 'claude-credential'))).toBe(true);

			const first = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'DELETE',
				headers: { origin },
			});
			expect(first.status).toBe(200);
			expect(await first.json()).toEqual({ ok: true, removed: true });
			expect(existsSync(join(gateshipHome, 'claude-credential'))).toBe(false);

			const second = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'DELETE',
				headers: { origin },
			});
			expect(await second.json()).toEqual({ ok: true, removed: false });
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects cross-origin connect and disconnect requests', async () => {
		const { handle, runtime, origin } = await serverWithHome(fakeAuthValidating({ ok: true }));
		try {
			const put = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'PUT',
				headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
				body: JSON.stringify({ token: 'sk-ant-oat01-x' }),
			});
			expect(put.status).toBe(403);
			const del = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'DELETE',
				headers: { origin: 'https://attacker.example' },
			});
			expect(del.status).toBe(403);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects an empty or missing token without calling the validator', async () => {
		let calls = 0;
		const providerAuth: ProviderAuth = {
			...fakeAuth(),
			validateClaudeCredential: async () => {
				calls += 1;
				return { ok: true };
			},
		};
		const { handle, runtime, origin } = await serverWithHome(providerAuth);
		try {
			const response = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ token: '   ' }),
			});
			expect(response.status).toBe(400);
			expect(calls).toBe(0);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	// GSHIP-704: a token provisioned through the service's own boot
	// environment (the supported automated-install path) must be captured and
	// removed from `process.env` at composition, not left ambient for an owned
	// child command to receive through an explicitly forwarded environment.
	test('captures a boot-provisioned token out of process.env instead of leaving it ambient', async () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-boot-provisioned';
		let handle: Awaited<ReturnType<typeof serverWithHome>>['handle'] | undefined;
		let runtime: Awaited<ReturnType<typeof serverWithHome>>['runtime'] | undefined;
		try {
			const server = await serverWithHome(fakeAuthValidating({ ok: true }));
			handle = server.handle;
			runtime = server.runtime;
			// The composition root already captured and deleted it by the time
			// `startWebServer` returns -- a verification command or git spawned
			// afterward, which builds a child allowlist, cannot see it.
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect('CLAUDE_CODE_OAUTH_TOKEN' in process.env).toBe(false);

			// The captured value still resolves for Claude's own children: status
			// correctly reports the credential as environment-managed, from the
			// snapshot alone, even though process.env no longer carries it.
			const status = await (await fetch(`${server.origin}/api/providers`)).json() as {
				providers: Array<Record<string, unknown>>;
			};
			expect(status.providers[0]).toMatchObject({
				id: 'claude',
				credential: { envManaged: true },
			});
		} finally {
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			if (handle !== undefined) await handle.stop();
			runtime?.close();
		}
	});

	// GSHIP-704: CLAUDE_CODE_OAUTH_TOKEN always wins over the file, so a write
	// or a removal here would have no effect on what actually authenticates.
	// PUT and DELETE both refuse explicitly rather than reporting a fabricated
	// success, and never touch the file GATESHIP_HOME would otherwise own.
	test('refuses to connect or disconnect while CLAUDE_CODE_OAUTH_TOKEN manages the credential', async () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-env-managed';
		let calls = 0;
		const providerAuth: ProviderAuth = {
			...fakeAuth(),
			validateClaudeCredential: async () => {
				calls += 1;
				return { ok: true, identity: { account: 'unused@example.com' } };
			},
		};
		let handle: Awaited<ReturnType<typeof serverWithHome>>['handle'] | undefined;
		let runtime: Awaited<ReturnType<typeof serverWithHome>>['runtime'] | undefined;
		try {
			const server = await serverWithHome(providerAuth);
			handle = server.handle;
			runtime = server.runtime;
			const { gateshipHome, origin } = server;

			const put = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ token: 'sk-ant-oat01-alternate-client' }),
			});
			expect(put.status).toBe(409);
			expect(await put.json()).toMatchObject({ ok: false, code: 'env-managed' });
			// The candidate token was never even validated: the request is refused
			// before it could create a file with no effect.
			expect(calls).toBe(0);
			expect(existsSync(join(gateshipHome, 'claude-credential'))).toBe(false);

			const del = await fetch(`${origin}/api/providers/claude/credential`, {
				method: 'DELETE',
				headers: { origin },
			});
			expect(del.status).toBe(409);
			expect(await del.json()).toMatchObject({ ok: false, code: 'env-managed' });
		} finally {
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			if (handle !== undefined) await handle.stop();
			runtime?.close();
		}
	});
});
