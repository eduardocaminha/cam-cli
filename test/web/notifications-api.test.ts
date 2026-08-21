// test/web/notifications-api.test.ts
//
// GSHIP-653 review: `sendNotificationChannelTest` looks up the requested
// channel in a plain object keyed by `ntfy`/`resend`. `channelId` comes
// straight from the URL, so a name that only exists on `Object.prototype`
// (`toString`, `constructor`, `__proto__`, ...) used to resolve to an
// inherited value instead of `undefined`, skipping the 404 branch entirely
// and crashing further down on `test.send is not a function`. What is
// asserted here is the actual HTTP contract: every one of those names, and an
// ordinary unknown name, gets the same 404 `unknown-channel` a real caller
// would see for a typo -- never a 500.

import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import {
	RESEND_API_KEY_ENV_VAR,
	RESEND_API_KEY_FILE_PATH,
	RESEND_FROM_ENV_VAR,
	RESEND_SETTINGS_FILE_PATH,
	RESEND_TO_ENV_VAR,
} from '../../src/runtime/remote-notifier.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface Harness {
	cwd: string;
	origin: string;
	stop: () => Promise<void>;
}

const RESEND_ENVIRONMENT_VARIABLES = [
	RESEND_API_KEY_ENV_VAR,
	RESEND_FROM_ENV_VAR,
	RESEND_TO_ENV_VAR,
] as const;

type ResendEnvironment = Partial<Record<(typeof RESEND_ENVIRONMENT_VARIABLES)[number], string>>;

function replaceResendEnvironment(values: ResendEnvironment): void {
	for (const variable of RESEND_ENVIRONMENT_VARIABLES) delete process.env[variable];
	for (const [variable, value] of Object.entries(values)) process.env[variable] = value;
}

function startHarness(name: string): Harness {
	const inheritedResendEnvironment = Object.fromEntries(
		RESEND_ENVIRONMENT_VARIABLES.flatMap((variable) => {
			const value = process.env[variable];
			return value === undefined ? [] : [[variable, value]];
		}),
	) as ResendEnvironment;
	replaceResendEnvironment({});
	const cwd = createTestTmpdir(`gship-${name}-`);
	const runtime = new RunRuntime({
		cwd: createTestTmpdir(`gship-${name}-runtime-`),
		store: new RunStore(':memory:'),
	});
	const handle = startWebServer({
		port: 0,
		cwd,
		runRuntime: runtime,
		providerAuth: {
			list: async () => [],
			startCodexLogin: async () => ({ loginId: 'unused', authUrl: 'https://unused.example' }),
			close: async () => {},
		},
	});
	return {
		cwd,
		origin: `http://${handle.hostname}:${handle.port}`,
		stop: async () => {
			try {
				await handle.stop();
				runtime.close();
			} finally {
				replaceResendEnvironment(inheritedResendEnvironment);
			}
		},
	};
}

function postChannelTest(origin: string, channelId: string): Promise<Response> {
	return fetch(`${origin}/api/notifications/${channelId}/test`, { method: 'POST', headers: { origin } });
}

describe('POST /api/notifications/:channelId/test', () => {
	test('an inherited Object.prototype name is refused as unknown, not resolved as a channel', async () => {
		const harness = startHarness('notifications-proto');
		try {
			// `toString`, `constructor` and `__proto__` all resolve to a defined
			// value on a plain object even though none was ever set as a key --
			// exactly the gap a bare `NOTIFICATION_CHANNEL_TESTS[channelId]` lookup
			// fell into.
			for (const channelId of ['toString', 'constructor', '__proto__']) {
				const response = await postChannelTest(harness.origin, channelId);
				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({ ok: false, code: 'unknown-channel' });
			}
		} finally {
			await harness.stop();
		}
	});

	test('an ordinary unknown channel name is refused the same way', async () => {
		const harness = startHarness('notifications-unknown');
		try {
			const response = await postChannelTest(harness.origin, 'sms');
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ ok: false, code: 'unknown-channel' });
		} finally {
			await harness.stop();
		}
	});
});

describe('Resend Settings API (GSHIP-688)', () => {
	test('same-origin save persists non-secrets and a mode-0600 write-only key', async () => {
		const harness = startHarness('resend-save');
		const apiKey = 'secret-never-returned';
		try {
			const response = await fetch(`${harness.origin}/api/notifications/resend`, {
				method: 'PUT',
				headers: { origin: harness.origin, 'content-type': 'application/json' },
				body: JSON.stringify({
					from: 'Gateship <ops@example.com>',
					to: 'operator@example.com',
					apiKey,
				}),
			});
			expect(response.status).toBe(200);
			const responseText = await response.text();
			expect(responseText).not.toContain(apiKey);
			expect(statSync(join(harness.cwd, RESEND_API_KEY_FILE_PATH)).mode & 0o777).toBe(0o600);
			expect(readFileSync(join(harness.cwd, RESEND_API_KEY_FILE_PATH), 'utf8')).toBe(`${apiKey}\n`);
			expect(JSON.parse(readFileSync(join(harness.cwd, RESEND_SETTINGS_FILE_PATH), 'utf8'))).toEqual({
				from: 'Gateship <ops@example.com>',
				to: 'operator@example.com',
			});

			const statusText = await (await fetch(`${harness.origin}/api/notifications`)).text();
			expect(statusText).not.toContain(apiKey);
			expect(JSON.parse(statusText).channels.resend).toMatchObject({
				configured: true,
				from: 'Gateship <ops@example.com>',
				to: 'operator@example.com',
				fileCredentialExists: true,
				externallyManaged: { apiKey: false, from: false, to: false },
			});
		} finally {
			await harness.stop();
		}
	});

	test('each environment field independently overrides only its file-backed value', async () => {
		const harness = startHarness('resend-environment');
		try {
			const saved = await fetch(`${harness.origin}/api/notifications/resend`, {
				method: 'PUT',
				headers: { origin: harness.origin, 'content-type': 'application/json' },
				body: JSON.stringify({
					from: 'File sender <file@example.com>',
					to: 'file-recipient@example.com',
					apiKey: 'file-key',
				}),
			});
			expect(saved.status).toBe(200);

			const resendStatus = async () => JSON.parse(
				await (await fetch(`${harness.origin}/api/notifications`)).text(),
			).channels.resend;

			replaceResendEnvironment({ [RESEND_FROM_ENV_VAR]: 'Environment sender <env@example.com>' });
			expect(await resendStatus()).toMatchObject({
				configured: true,
				from: 'Environment sender <env@example.com>',
				to: 'file-recipient@example.com',
				externallyManaged: { apiKey: false, from: true, to: false },
			});

			replaceResendEnvironment({ [RESEND_TO_ENV_VAR]: 'env-recipient@example.com' });
			expect(await resendStatus()).toMatchObject({
				configured: true,
				from: 'File sender <file@example.com>',
				to: 'env-recipient@example.com',
				externallyManaged: { apiKey: false, from: false, to: true },
			});

			replaceResendEnvironment({ [RESEND_API_KEY_ENV_VAR]: 'environment-key' });
			const removed = await fetch(`${harness.origin}/api/notifications/resend/credential`, {
				method: 'DELETE', headers: { origin: harness.origin },
			});
			expect(removed.status).toBe(200);
			expect(await resendStatus()).toMatchObject({
				configured: true,
				from: 'File sender <file@example.com>',
				to: 'file-recipient@example.com',
				fileCredentialExists: false,
				externallyManaged: { apiKey: true, from: false, to: false },
			});
		} finally {
			await harness.stop();
		}
	});

	test('blank key preserves the credential, removal deletes only its file, and cross-origin writes are refused', async () => {
		const harness = startHarness('resend-remove');
		try {
			const save = (apiKey: string, origin = harness.origin) => fetch(`${harness.origin}/api/notifications/resend`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ from: 'sender', to: 'recipient', apiKey }),
			});
			expect((await save('first-key')).status).toBe(200);
			expect((await save('')).status).toBe(200);
			expect(readFileSync(join(harness.cwd, RESEND_API_KEY_FILE_PATH), 'utf8')).toBe('first-key\n');
			expect((await save('stolen', 'https://evil.example')).status).toBe(403);
			expect(readFileSync(join(harness.cwd, RESEND_API_KEY_FILE_PATH), 'utf8')).toBe('first-key\n');

			const removed = await fetch(`${harness.origin}/api/notifications/resend/credential`, {
				method: 'DELETE', headers: { origin: harness.origin },
			});
			expect(removed.status).toBe(200);
			expect(await removed.text()).not.toContain('first-key');
			expect(() => readFileSync(join(harness.cwd, RESEND_API_KEY_FILE_PATH), 'utf8')).toThrow();
			expect(JSON.parse(readFileSync(join(harness.cwd, RESEND_SETTINGS_FILE_PATH), 'utf8'))).toEqual({
				from: 'sender', to: 'recipient',
			});
		} finally {
			await harness.stop();
		}
	});

	test('validation is bounded and errors never echo supplied values', async () => {
		const harness = startHarness('resend-invalid');
		try {
			const secret = 'must-not-echo';
			const response = await fetch(`${harness.origin}/api/notifications/resend`, {
				method: 'PUT',
				headers: { origin: harness.origin, 'content-type': 'application/json' },
				body: JSON.stringify({ from: '', to: 'recipient', apiKey: secret }),
			});
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain(secret);
		} finally {
			await harness.stop();
		}
	});
});
