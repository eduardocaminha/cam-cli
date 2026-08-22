import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
import { OPERATOR_PROFILE_LIMITS } from '../../src/runtime/operator-profile.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function startHarness() {
	const runtime = new RunRuntime({
		cwd: createTestTmpdir('gship-operator-profile-runtime-'),
		store: new RunStore(':memory:'),
	});
	const handle = startWebServer({
		port: 0,
		cwd: createTestTmpdir('gship-operator-profile-api-'),
		runRuntime: runtime,
		providerAuth: {
			list: async () => [],
			startCodexLogin: async () => ({ loginId: 'unused', authUrl: 'https://unused.example' }),
			validateClaudeCredential: async () => ({ ok: false, message: 'unused' }),
			close: async () => {},
		},
	});
	const origin = `http://${handle.hostname}:${handle.port}`;
	return {
		origin,
		runtime,
		stop: async () => {
			await handle.stop();
			runtime.close();
		},
	};
}

function put(origin: string, body: unknown, requestOrigin = origin): Promise<Response> {
	return fetch(`${origin}/api/operator-profile`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', origin: requestOrigin },
		body: JSON.stringify(body),
	});
}

describe('operator profile web API', () => {
	test('starts empty and persists the explicit name and IANA timezone', async () => {
		const harness = startHarness();
		try {
			const empty = await fetch(`${harness.origin}/api/operator-profile`);
			expect(await empty.json()).toEqual({ profile: { name: '', timezone: '' } });

			const written = await put(harness.origin, {
				name: '  Eduardo  ',
				timezone: 'America/Sao_Paulo',
			});
			expect(written.status).toBe(200);
			expect(await written.json()).toEqual({
				ok: true,
				profile: { name: 'Eduardo', timezone: 'America/Sao_Paulo' },
			});
			expect(harness.runtime.getOperatorProfile()).toEqual({
				name: 'Eduardo',
				timezone: 'America/Sao_Paulo',
			});
		} finally {
			await harness.stop();
		}
	});

	test('rejects invalid shapes, control text, oversized names and invalid timezones', async () => {
		const harness = startHarness();
		try {
			for (const body of [
				'not an object',
				{ name: 42, timezone: 'UTC' },
				{ name: 'Eduardo\nAdmin', timezone: 'UTC' },
				{ name: 'x'.repeat(OPERATOR_PROFILE_LIMITS.name + 1), timezone: 'UTC' },
				{ name: 'Eduardo', timezone: 'Mars/Olympus' },
			]) {
				const response = await put(harness.origin, body);
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ ok: false, code: 'invalid-request' });
			}
			expect(harness.runtime.getOperatorProfile()).toEqual({ name: '', timezone: '' });
		} finally {
			await harness.stop();
		}
	});

	test('refuses a cross-origin write', async () => {
		const harness = startHarness();
		try {
			const response = await put(
				harness.origin,
				{ name: 'Eduardo', timezone: 'UTC' },
				'http://evil.example',
			);
			expect(response.status).toBe(403);
			expect(harness.runtime.getOperatorProfile()).toEqual({ name: '', timezone: '' });
		} finally {
			await harness.stop();
		}
	});
});
