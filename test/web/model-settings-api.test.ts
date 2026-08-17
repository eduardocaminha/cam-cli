// test/web/model-settings-api.test.ts
//
// GSHIP-617: the HTTP surface of the per-role model choice. What is asserted is
// the contract the screen depends on -- what a fresh install reads, what a write
// persists, and which shapes are refused -- never the argv the adapters build
// from it, which the adapter tests own.

import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
import { emptyModelSettings } from '../../src/runtime/model-settings.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface Harness {
	origin: string;
	runtime: RunRuntime;
	stop: () => Promise<void>;
}

function startHarness(name: string): Harness {
	const runtime = new RunRuntime({
		cwd: createTestTmpdir(`gship-${name}-runtime-`),
		store: new RunStore(':memory:'),
	});
	const handle = startWebServer({
		port: 0,
		cwd: createTestTmpdir(`gship-${name}-`),
		runRuntime: runtime,
		providerAuth: {
			list: async () => [],
			startCodexLogin: async () => ({ loginId: 'unused', authUrl: 'https://unused.example' }),
			close: async () => {},
		},
	});
	return {
		origin: `http://${handle.hostname}:${handle.port}`,
		runtime,
		stop: async () => {
			await handle.stop();
			runtime.close();
		},
	};
}

function put(origin: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${origin}/api/model-settings`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', origin, ...headers },
		body: JSON.stringify(body),
	});
}

describe('per-role model settings web API', () => {
	test('reads the empty choice before anything is configured', async () => {
		const harness = startHarness('model-settings-read');
		try {
			const response = await fetch(`${harness.origin}/api/model-settings`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ settings: emptyModelSettings() });
		} finally {
			await harness.stop();
		}
	});

	test('persists a slot per provider and role, and clears one with empty text', async () => {
		const harness = startHarness('model-settings-write');
		try {
			const written = await put(harness.origin, {
				claude: {
					orchestrator: { model: 'sonnet' },
					executor: { model: 'opus', effort: 'xhigh' },
					reviewer: { effort: 'high' },
				},
				codex: { executor: { model: 'gpt-5-codex', effort: 'high' } },
			});
			expect(written.status).toBe(200);
			expect(await written.json()).toEqual({
				ok: true,
				settings: {
					claude: {
						orchestrator: { model: 'sonnet' },
						executor: { model: 'opus', effort: 'xhigh' },
						reviewer: { effort: 'high' },
					},
					codex: {
						orchestrator: {},
						executor: { model: 'gpt-5-codex', effort: 'high' },
						reviewer: {},
					},
				},
			});
			// The durable record is what the next spawn will read.
			expect(harness.runtime.getModelSettings().claude.executor)
				.toEqual({ model: 'opus', effort: 'xhigh' });

			// The record is overwritten whole, and blank text is how the operator
			// goes back to the CLI default.
			const cleared = await put(harness.origin, {
				claude: { executor: { model: '  ', effort: '' } },
			});
			expect(cleared.status).toBe(200);
			expect(await cleared.json()).toEqual({ ok: true, settings: emptyModelSettings() });
			expect(harness.runtime.getModelSettings()).toEqual(emptyModelSettings());
		} finally {
			await harness.stop();
		}
	});

	test('refuses a value argv could not carry, and an unknown provider or role', async () => {
		const harness = startHarness('model-settings-refusals');
		try {
			const spaced = await put(harness.origin, {
				claude: { executor: { model: 'claude opus' } },
			});
			expect(spaced.status).toBe(400);
			expect(await spaced.json()).toMatchObject({ ok: false, code: 'invalid-request' });

			const wrongType = await put(harness.origin, { claude: { executor: { effort: 3 } } });
			expect(wrongType.status).toBe(400);

			const unknownProvider = await put(harness.origin, { gemini: { executor: {} } });
			expect(unknownProvider.status).toBe(400);
			expect((await unknownProvider.json() as { message: string }).message).toContain('gemini');

			const unknownRole = await put(harness.origin, { claude: { planner: {} } });
			expect(unknownRole.status).toBe(400);
			expect((await unknownRole.json() as { message: string }).message).toContain('planner');

			const unknownField = await put(harness.origin, {
				claude: { executor: { fallbackModel: 'sonnet' } },
			});
			expect(unknownField.status).toBe(400);

			const notAnObject = await put(harness.origin, ['claude']);
			expect(notAnObject.status).toBe(400);

			// Nothing above was persisted.
			expect(harness.runtime.getModelSettings()).toEqual(emptyModelSettings());
		} finally {
			await harness.stop();
		}
	});

	test('refuses a cross-origin write while leaving the read open', async () => {
		const harness = startHarness('model-settings-origin');
		try {
			const response = await put(harness.origin, {
				claude: { executor: { model: 'opus' } },
			}, { origin: 'https://attacker.example' });
			expect(response.status).toBe(403);
			expect(harness.runtime.getModelSettings()).toEqual(emptyModelSettings());
			expect((await fetch(`${harness.origin}/api/model-settings`)).status).toBe(200);
		} finally {
			await harness.stop();
		}
	});
});
