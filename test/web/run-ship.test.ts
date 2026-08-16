// test/web/run-ship.test.ts
//
// CAM-579 acceptance criterion 3: the web exposes a same-origin
// POST /api/runs/:runId/ship that answers 202 without waiting for CI, the
// production composition carries the real GitHub shipper, and ship progress
// reaches the browser over the SQLite-backed SSE stream already in place.

import { describe, expect, test } from 'bun:test';

import { createDefaultRunRuntimeOptions, startWebServer } from '../../src/commands/web.ts';
import { GithubShipper } from '../../src/runtime/github-shipper.ts';
import { RunRuntime, type RuntimeShipResult } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

interface ShipHarness {
	runtime: RunRuntime;
	/** Resolves the pending ship, standing in for CI going green. */
	release: () => void;
	started: () => boolean;
}

function createShipRuntime(): ShipHarness {
	let release = (): void => {};
	let started = false;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const runtime = new RunRuntime({
		cwd: '/project',
		store: new RunStore(':memory:'),
		newId: () => 'run-web-ship',
		newSessionId: () => 'session-web-ship',
		executor: { execute: async () => ({ outcome: 'completed', summary: 'change written' }) },
		verifier: { verify: async () => ({ ok: true }) },
		shipper: {
			ship: async (input): Promise<RuntimeShipResult> => {
				started = true;
				input.emit('ship.automerge-armed', { prNumber: 385 });
				await released;
				return { outcome: 'merged', prNumber: 385 };
			},
		},
	});
	return { runtime, release, started: () => started };
}

async function readStream(body: ReadableStream<Uint8Array>, until: string): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	try {
		for (let read = 0; read < 64; read += 1) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
			if (text.includes(until)) break;
		}
	} finally {
		await reader.cancel();
	}
	return text;
}

describe('POST /api/runs/:runId/ship', () => {
	test('answers 202 while the ship is still waiting on GitHub, then streams the merge', async () => {
		const { runtime, release, started } = createShipRuntime();
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-web-ship-'),
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;

		try {
			const run = runtime.startRun('CAM-579');
			await waitForCondition(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

			const accepted = await fetch(`${origin}/api/runs/${run.id}/ship`, {
				method: 'POST',
				headers: { origin },
			});
			expect(accepted.status).toBe(202);
			expect(await accepted.json()).toMatchObject({
				ok: true,
				run: { id: run.id, state: 'ready-to-ship' },
			});
			// The request returned while the shipper is still waiting for the merge.
			expect(started()).toBe(true);
			expect(runtime.getRun(run.id)?.state).toBe('ready-to-ship');

			release();
			await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');

			const stream = await fetch(`${origin}/api/events?after=0`);
			expect(stream.headers.get('content-type')).toContain('text/event-stream');
			const text = await readStream(stream.body as ReadableStream<Uint8Array>, 'run.shipped');
			expect(text).toContain('"kind":"run.ship-started"');
			expect(text).toContain('"kind":"ship.automerge-armed"');
			expect(text).toContain('"kind":"run.shipped"');
			expect(text).toContain('"prNumber":385');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects a cross-origin ship, an unknown run and a run that is not ready', async () => {
		const { runtime, release } = createShipRuntime();
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-web-ship-guards-'),
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;

		try {
			const run = runtime.startRun('CAM-579');
			await waitForCondition(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

			const foreign = await fetch(`${origin}/api/runs/${run.id}/ship`, {
				method: 'POST',
				headers: { origin: 'http://evil.example' },
			});
			expect(foreign.status).toBe(403);

			const missing = await fetch(`${origin}/api/runs/nope/ship`, {
				method: 'POST',
				headers: { origin },
			});
			expect(missing.status).toBe(404);

			const first = await fetch(`${origin}/api/runs/${run.id}/ship`, {
				method: 'POST',
				headers: { origin },
			});
			expect(first.status).toBe(202);
			// The ship already owns the run: a second request is refused, not queued.
			const second = await fetch(`${origin}/api/runs/${run.id}/ship`, {
				method: 'POST',
				headers: { origin },
			});
			expect(second.status).toBe(409);
			expect(await second.json()).toMatchObject({ ok: false, code: 'run-not-shippable' });

			release();
			await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('the production runtime is composed with the real GitHub shipper', () => {
		const options = createDefaultRunRuntimeOptions(createTestTmpdir('gship-web-ship-prod-'));
		try {
			expect(options.shipper).toBeInstanceOf(GithubShipper);
		} finally {
			options.store.close();
		}
	});

	// The browser half of this endpoint -- that the screen only offers "Shipar"
	// in ready-to-ship, and that the client posts to this exact path -- is
	// covered by test/web/ui-client.test.tsx against the real component, rather
	// than by matching the served page's source text.
});
