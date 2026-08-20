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

import { startWebServer } from '../../src/commands/web.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface Harness {
	origin: string;
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
		stop: async () => {
			await handle.stop();
			runtime.close();
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
