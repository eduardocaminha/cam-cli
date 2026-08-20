import { describe, expect, test } from 'bun:test';

import { createRunEventStream, startWebServer } from '../../src/commands/web.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

async function waitForReady(runtime: RunRuntime, runId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (runtime.getRun(runId)?.state !== 'ready-to-ship') {
		if (Date.now() >= deadline) throw new Error('timed out waiting for ready-to-ship');
		await Bun.sleep(5);
	}
}

describe('durable web run API', () => {
	test('disables Bun idle timeout for the long-lived SSE request', async () => {
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const request = new Request('http://127.0.0.1/api/events');
		const calls: Array<{ request: Request; seconds: number }> = [];
		const response = createRunEventStream(runtime, request, {
			timeout(requestArg, seconds) {
				calls.push({ request: requestArg, seconds });
			},
		});

		try {
			expect(calls).toEqual([{ request, seconds: 0 }]);
			expect(response.headers.get('content-type')).toContain('text/event-stream');
		} finally {
			await response.body?.cancel();
			runtime.close();
		}
	});

	test('starts a run, lists it and streams persisted state events over SSE', async () => {
		const cwd = createTestTmpdir('gship-run-api-');
		const store = new RunStore(':memory:');
		let releaseExecution = (): void => {};
		const executionReleased = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-http',
			newSessionId: () => 'session-http',
			executor: {
				execute: async ({ emit }) => {
					emit('executor.output', { text: 'started' });
					await executionReleased;
					return { outcome: 'completed', summary: 'HTTP path complete.' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const handle = startWebServer({
			port: 0,
			cwd,
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;

		try {
			const startedResponse = await fetch(`${origin}/api/runs`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ issueId: 'GSHIP-12' }),
			});
			expect(startedResponse.status).toBe(202);
			const started = await startedResponse.json() as { run: { id: string } };

			const streamResponse = await fetch(`${origin}/api/events?after=0`);
			expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
			const reader = streamResponse.body?.getReader();
			expect(reader).toBeDefined();
			const firstChunk = await reader?.read();
			const firstText = new TextDecoder().decode(firstChunk?.value);
			expect(firstText).toContain('event: run-event');
			expect(firstText).toContain('"kind":"run.created"');

			releaseExecution();
			await waitForReady(runtime, started.run.id);
			const listResponse = await fetch(`${origin}/api/runs`);
			expect(await listResponse.json()).toMatchObject({
				runs: [{
					id: 'run-http',
					issueId: 'GSHIP-12',
					state: 'ready-to-ship',
					providerWait: null,
				}],
			});
			const historyResponse = await fetch(`${origin}/api/runs/run-http/events`);
			expect(historyResponse.status).toBe(200);
			const history = await historyResponse.json() as {
				events: Array<{ kind: string; payload: Record<string, unknown> }>;
			};
			expect(history.events.map((event) => event.kind)).toEqual([
				'run.created',
				'run.started',
				'executor.output',
				'run.work-completed',
				'run.verified',
			]);
			expect(history.events[2]?.payload).toEqual({ text: 'started' });
			await reader?.cancel();
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('returns 404 for activity of an unknown run', async () => {
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-run-history-missing-'),
			runRuntime: runtime,
		});
		try {
			const response = await fetch(
				`http://${handle.hostname}:${handle.port}/api/runs/missing/events`,
			);
			expect(response.status).toBe(404);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('resumes waiting-user with a durable operator response', async () => {
		const guidance: Array<string | undefined> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-answer',
			executor: {
				execute: async (input) => {
					guidance.push(input.operatorGuidance);
					return input.resume
						? { outcome: 'completed', summary: 'answer applied' }
						: { outcome: 'waiting-user', summary: 'Which seam?' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-run-answer-'),
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;

		try {
			await fetch(`${origin}/api/runs`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ issueId: 'CAM-14' }),
			});
			while (runtime.getRun('run-answer')?.state !== 'waiting-user') await Bun.sleep(5);

			const missing = await fetch(`${origin}/api/runs/run-answer/resume`, {
				method: 'POST',
				headers: { origin },
			});
			expect(missing.status).toBe(409);

			const resumed = await fetch(`${origin}/api/runs/run-answer/resume`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Use the smaller seam.' }),
			});
			expect(resumed.status).toBe(202);
			await waitForReady(runtime, 'run-answer');
			expect(guidance).toEqual([undefined, 'Use the smaller seam.']);
			expect(runtime.listRunEvents('run-answer')[3]).toMatchObject({
				kind: 'run.operator-guidance',
				payload: { text: 'Use the smaller seam.' },
			});
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	// GSHIP-611: the same-origin surface exposes the abandon action, and only for
	// the one state it is eligible in.
	test('abandons an interrupted run and refuses every other state', async () => {
		let markStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-abandon',
			executor: {
				execute: (input) => {
					markStarted();
					return new Promise((_resolve, reject) => {
						input.signal.addEventListener(
							'abort',
							() => reject(new DOMException('cancelled', 'AbortError')),
							{ once: true },
						);
					});
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-run-abandon-'),
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const abandon = (runId: string) => fetch(`${origin}/api/runs/${runId}/abandon`, {
			method: 'POST',
			headers: { origin },
		});

		try {
			await fetch(`${origin}/api/runs`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ issueId: 'GSHIP-611' }),
			});
			await started;

			// A working run is cancelled, never abandoned: it stays resumable.
			const working = await abandon('run-abandon');
			expect(working.status).toBe(409);
			expect(await working.json()).toMatchObject({ code: 'run-not-abandonable' });

			await fetch(`${origin}/api/runs/run-abandon/cancel`, { method: 'POST', headers: { origin } });
			expect(runtime.getRun('run-abandon')?.state).toBe('interrupted');

			const abandoned = await abandon('run-abandon');
			expect(abandoned.status).toBe(200);
			expect(await abandoned.json()).toMatchObject({ ok: true, run: { state: 'cancelled' } });

			// Terminal states refuse it, and an unknown run is still a 404.
			expect((await abandon('run-abandon')).status).toBe(409);
			expect((await abandon('missing')).status).toBe(404);
			// A cross-origin write never reaches the runtime.
			const foreign = await fetch(`${origin}/api/runs/run-abandon/abandon`, {
				method: 'POST',
				headers: { origin: 'http://evil.example' },
			});
			expect(foreign.status).toBe(403);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('returns an honest 503 until a real executor is connected', async () => {
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-run-unavailable-'),
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const response = await fetch(`${origin}/api/runs`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ issueId: 'CAM-13' }),
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({ code: 'runtime-unavailable' });
			expect(runtime.listRuns()).toEqual([]);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});
});
