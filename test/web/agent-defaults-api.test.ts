import { describe, expect, test } from 'bun:test';

import { type ModelProber, startWebServer } from '../../src/commands/web.ts';
import { emptyModelSettings } from '../../src/runtime/model-settings.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function startHarness(
	modelProber: ModelProber = { probe: async () => ({ outcome: 'accepted' }) },
	connected = true,
) {
	const registry = openProjectRegistry(createTestTmpdir('gship-agent-defaults-home-'));
	// An empty row prevents the boot project's local choices from being imported.
	registry.initializeAgentDefaults({});
	const runtime = new RunRuntime({
		cwd: createTestTmpdir('gship-agent-defaults-runtime-'),
		store: new RunStore(':memory:'),
	});
	runtime.selectProvider('claude');
	const projectSettings = emptyModelSettings();
	projectSettings.codex.executor = { model: 'project-only' };
	runtime.setModelSettings(projectSettings);
	const handle = startWebServer({
		port: 0,
		cwd: createTestTmpdir('gship-agent-defaults-api-'),
		projectRegistry: registry,
		runRuntime: runtime,
		modelProber,
		providerAuth: {
			list: async () => [
				{ id: 'claude', installed: true, subscription: connected, label: 'Claude', login: 'external' },
				{ id: 'codex', installed: true, subscription: connected, label: 'Codex', login: 'web' },
			],
			startCodexLogin: async () => ({ loginId: 'unused', authUrl: 'https://unused.example' }),
			validateClaudeCredential: async () => ({ ok: false, message: 'unused' }),
			close: async () => {},
		},
	});
	const origin = `http://${handle.hostname}:${handle.port}`;
	return {
		origin,
		registry,
		stop: async () => {
			await handle.stop();
			runtime.close();
			registry.close();
		},
	};
}

function put(origin: string, body: unknown, requestOrigin = origin): Promise<Response> {
	return fetch(`${origin}/api/agent-defaults`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', origin: requestOrigin },
		body: JSON.stringify(body),
	});
}

describe('global agent defaults web API', () => {
	test('reads only the global registry record, not project runtime settings', async () => {
		const harness = startHarness();
		try {
			const response = await fetch(`${harness.origin}/api/agent-defaults`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ defaults: {} });
		} finally {
			await harness.stop();
		}
	});

	test('writes a complete normalized record, probes changed slots, and clears omitted fields', async () => {
		const probed: Array<{ provider: string; role: string }> = [];
		const harness = startHarness({
			probe: async (provider, role, slot) => {
				probed.push({ provider, role });
				return slot.model === 'refused-model'
					? { outcome: 'refused', message: 'unknown model' }
					: { outcome: 'accepted' };
			},
		});
		try {
			const saved = await put(harness.origin, {
				provider: 'codex',
				modelSettings: { codex: { executor: { model: 'gpt-5-codex', effort: 'high' } } },
			});
			expect(saved.status).toBe(200);
			expect(await saved.json()).toMatchObject({
				ok: true,
				defaults: { provider: 'codex', modelSettings: { codex: { executor: { model: 'gpt-5-codex', effort: 'high' } } } },
				probes: { codex: { executor: { outcome: 'accepted' } } },
			});
			expect(probed).toEqual([{ provider: 'codex', role: 'executor' }]);

			const refused = await put(harness.origin, {
				provider: 'codex',
				modelSettings: { codex: { executor: { model: 'refused-model' } } },
			});
			expect(await refused.json()).toMatchObject({
				defaults: { modelSettings: { codex: { executor: { model: 'gpt-5-codex', effort: 'high' } } } },
				probes: { codex: { executor: { outcome: 'refused', message: 'unknown model' } } },
			});

			const removedModels = await put(harness.origin, { provider: 'claude' });
			expect(await removedModels.json()).toEqual({ ok: true, defaults: { provider: 'claude' }, probes: {} });
			const cleared = await put(harness.origin, {});
			expect(await cleared.json()).toEqual({ ok: true, defaults: {}, probes: {} });
			expect(harness.registry.getAgentDefaults()).toEqual({});
		} finally {
			await harness.stop();
		}
	});

	test('uses the selector refusal for an unconnected provider and rejects invalid or untrusted writes', async () => {
		const harness = startHarness(undefined, false);
		try {
			const originalList = harness.registry.getAgentDefaults();
			const disconnected = await put(harness.origin, { provider: 'claude' });
			expect(disconnected.status).toBe(409);
			expect(await disconnected.json()).toMatchObject({ code: 'provider-not-connected' });
			const invalid = await put(harness.origin, { provider: 'unknown' });
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({ code: 'invalid-provider' });
			const unknownField = await put(harness.origin, { extra: true });
			expect(unknownField.status).toBe(400);
			const untrusted = await put(harness.origin, {}, 'http://attacker.example');
			expect(untrusted.status).toBe(403);
			expect(harness.registry.getAgentDefaults()).toEqual(originalList);
		} finally {
			await harness.stop();
		}
	});
});
