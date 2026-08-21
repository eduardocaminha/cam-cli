import { afterEach, describe, expect, test } from 'bun:test';

import { startWebServer, type SelfUpdateAccess, type WebServerHandle } from '../../src/commands/web.ts';
import type { SelfUpdateSnapshot } from '../../src/runtime/self-update.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const handles: WebServerHandle[] = [];
afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.stop()));
});

function snapshot(enabled = false): SelfUpdateSnapshot {
	return {
		enabled,
		currentVersion: '1.0.0',
		currentCommit: 'a'.repeat(40),
		lastCheckedAt: null,
		available: null,
		result: null,
		availability: { kind: 'development', reason: 'source checkout' },
		applying: false,
	};
}

function server(): { handle: WebServerHandle; writes: boolean[] } {
	let state = snapshot();
	const writes: boolean[] = [];
	const selfUpdate: SelfUpdateAccess = {
		snapshot: () => state,
		setEnabled: (enabled) => {
			writes.push(enabled);
			state = { ...state, enabled };
			return state;
		},
		startScheduler: () => {},
		stop: async () => {},
	};
	const cwd = createTestTmpdir('gship-update-api-');
	const handle = startWebServer({
		cwd,
		port: 0,
		runRuntime: new RunRuntime({ cwd, store: new RunStore(':memory:') }),
		selfUpdate,
		buildSha: null,
	});
	handles.push(handle);
	return { handle, writes };
}

describe('self update API', () => {
	test('reads durable update state', async () => {
		const { handle } = server();
		const response = await fetch(`http://${handle.hostname}:${handle.port}/api/update`);
		expect(response.status).toBe(200);
		expect((await response.json() as { update: SelfUpdateSnapshot }).update.enabled).toBe(false);
	});

	test('persists only an explicit same-origin boolean opt-in', async () => {
		const { handle, writes } = server();
		const url = `http://${handle.hostname}:${handle.port}/api/update`;
		const accepted = await fetch(url, {
			method: 'PUT',
			headers: { origin: `http://${handle.hostname}:${handle.port}`, 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: true }),
		});
		expect(accepted.status).toBe(200);
		expect(writes).toEqual([true]);
		const invalid = await fetch(url, {
			method: 'PUT',
			headers: { origin: `http://${handle.hostname}:${handle.port}`, 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: 'yes' }),
		});
		expect(invalid.status).toBe(400);
		expect(writes).toEqual([true]);
	});

	test('rejects cross-origin policy changes', async () => {
		const { handle, writes } = server();
		const response = await fetch(`http://${handle.hostname}:${handle.port}/api/update`, {
			method: 'PUT',
			headers: { origin: 'https://example.com', 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: true }),
		});
		expect(response.status).toBe(403);
		expect(writes).toEqual([]);
	});
});
