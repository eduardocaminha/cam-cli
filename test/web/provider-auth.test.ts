import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
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
		close: async () => {},
	};
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
			expect(await status.json()).toEqual({ providers, selected: 'claude' });

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
