// test/web/model-settings-api.test.ts
//
// GSHIP-617: the HTTP surface of the per-role model choice. What is asserted is
// the contract the screen depends on -- what a fresh install reads, what a write
// persists, and which shapes are refused -- never the argv the adapters build
// from it, which the adapter tests own.

import { describe, expect, test } from 'bun:test';

import { type ModelProber, startWebServer } from '../../src/commands/web.ts';
import { emptyModelSettings } from '../../src/runtime/model-settings.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface Harness {
	origin: string;
	runtime: RunRuntime;
	stop: () => Promise<void>;
}

/** No test here spawns a real CLI; a save that probes anything accepts by default. */
const ACCEPT_EVERYTHING: ModelProber = { probe: async () => ({ outcome: 'accepted' }) };

function startHarness(name: string, modelProber: ModelProber = ACCEPT_EVERYTHING): Harness {
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
			validateClaudeCredential: async () => ({ ok: false, message: 'unused' }),
			close: async () => {},
		},
		modelProber,
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
			expect(await response.json()).toEqual({ settings: emptyModelSettings(), source: 'provider-default' });
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
				source: 'project',
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
				// Every non-empty slot changed from the empty baseline, so every one
				// of them was probed and accepted.
				probes: {
					claude: {
						orchestrator: { outcome: 'accepted' },
						executor: { outcome: 'accepted' },
						reviewer: { outcome: 'accepted' },
					},
					codex: {
						executor: { outcome: 'accepted' },
					},
				},
			});
			// The durable record is what the next spawn will read.
			expect(harness.runtime.getModelSettings().claude.executor)
				.toEqual({ model: 'opus', effort: 'xhigh' });

			// The record is overwritten whole, and blank text is how the operator
			// goes back to the CLI default. Nothing here is probed: every slot that
			// changed changed to empty, with nothing left to validate.
			const cleared = await put(harness.origin, {
				claude: { executor: { model: '  ', effort: '' } },
			});
			expect(cleared.status).toBe(200);
			expect(await cleared.json()).toEqual({
				ok: true, settings: emptyModelSettings(), source: 'project', probes: {},
			});
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

	// GSHIP-620: model and effort are validated by probing the CLI at save time.
	describe('probing a changed slot at save time', () => {
		test('saves a slot the CLI accepts, and reports the accepted outcome', async () => {
			const harness = startHarness('model-settings-probe-accept', {
				probe: async () => ({ outcome: 'accepted' }),
			});
			try {
				const written = await put(harness.origin, { claude: { executor: { model: 'opus' } } });
				expect(written.status).toBe(200);
				expect(await written.json()).toMatchObject({
					ok: true,
					settings: { claude: { executor: { model: 'opus' } } },
					probes: { claude: { executor: { outcome: 'accepted' } } },
				});
				expect(harness.runtime.getModelSettings().claude.executor).toEqual({ model: 'opus' });
			} finally {
				await harness.stop();
			}
		});

		test('does not persist a slot the CLI explicitly refuses, and returns its own message', async () => {
			const harness = startHarness('model-settings-probe-refuse', {
				probe: async (_providerId, _role, slot) =>
					slot.model === 'ghost-model'
						? { outcome: 'refused', message: 'model "ghost-model" was not found' }
						: { outcome: 'accepted' },
			});
			try {
				// Seed a value that must survive the refused write below untouched.
				await put(harness.origin, { claude: { executor: { model: 'opus' } } });

				const refused = await put(harness.origin, { claude: { executor: { model: 'ghost-model' } } });
				expect(refused.status).toBe(200);
				expect(await refused.json()).toMatchObject({
					ok: true,
					settings: { claude: { executor: { model: 'opus' } } },
					probes: {
						claude: {
							executor: { outcome: 'refused', message: 'model "ghost-model" was not found' },
						},
					},
				});
				expect(harness.runtime.getModelSettings().claude.executor).toEqual({ model: 'opus' });
			} finally {
				await harness.stop();
			}
		});

		test('saves a slot through an inconclusive probe, and reports the validation did not finish', async () => {
			const harness = startHarness('model-settings-probe-inconclusive', {
				probe: async () => ({ outcome: 'inconclusive', message: 'timed out' }),
			});
			try {
				const written = await put(harness.origin, { codex: { reviewer: { model: 'gpt-5' } } });
				expect(written.status).toBe(200);
				expect(await written.json()).toMatchObject({
					ok: true,
					settings: { codex: { reviewer: { model: 'gpt-5' } } },
					probes: { codex: { reviewer: { outcome: 'inconclusive', message: 'timed out' } } },
				});
				// Ambiguous is not refused: an offline operator must not be locked out
				// of Ajustes because the probe itself could not run.
				expect(harness.runtime.getModelSettings().codex.reviewer).toEqual({ model: 'gpt-5' });
			} finally {
				await harness.stop();
			}
		});

		test('probes only the slots whose model or effort changed', async () => {
			const probed: Array<{ providerId: string; role: string }> = [];
			const harness = startHarness('model-settings-probe-changed-only', {
				probe: async (providerId, role) => {
					probed.push({ providerId, role });
					return { outcome: 'accepted' };
				},
			});
			try {
				await put(harness.origin, {
					claude: { orchestrator: { model: 'sonnet' }, executor: { model: 'opus' } },
				});
				expect(probed).toEqual([
					{ providerId: 'claude', role: 'orchestrator' },
					{ providerId: 'claude', role: 'executor' },
				]);
				probed.length = 0;

				// Only the executor's effort changes; the unchanged orchestrator slot
				// must not spawn a second probe process.
				await put(harness.origin, {
					claude: { orchestrator: { model: 'sonnet' }, executor: { model: 'opus', effort: 'high' } },
				});
				expect(probed).toEqual([{ providerId: 'claude', role: 'executor' }]);

				// Clearing every slot back to the CLI default leaves nothing to probe.
				probed.length = 0;
				await put(harness.origin, {});
				expect(probed).toEqual([]);
			} finally {
				await harness.stop();
			}
		});
	});
});
