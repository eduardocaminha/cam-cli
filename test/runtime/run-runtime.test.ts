import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { nextFixRounds } from '../../src/runtime/run-state.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for runtime state');
		await Bun.sleep(5);
	}
}

describe('durable run runtime', () => {
	test('persists transitions and events across a database reopen', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-'), '.gship', 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.createRun({
			id: 'run-1',
			issueId: 'CAM-1',
			sessionId: 'session-1',
			workspacePath: '/workspaces/run-1',
			createdAt: '2026-08-15T10:00:00Z',
		});
		store.transition({
			runId: 'run-1',
			toState: 'working',
			kind: 'run.started',
			createdAt: '2026-08-15T10:00:01Z',
		});
		store.appendEvent({
			runId: 'run-1',
			kind: 'executor.output',
			payload: { text: 'working' },
			createdAt: '2026-08-15T10:00:02Z',
		});
		store.close();

		const reopened = new RunStore(dbPath);
			expect(reopened.getRun('run-1')).toMatchObject({
			issueId: 'CAM-1',
			sessionId: 'session-1',
			workspacePath: '/workspaces/run-1',
			state: 'working',
			fixRounds: 0,
		});
		expect(reopened.listEvents().map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'executor.output',
		]);
		expect(reopened.listEvents()[2]?.payload).toEqual({ text: 'working' });
		reopened.close();
	});

	test('turns a run left active by a crashed service into an interrupted run', () => {
		const store = new RunStore(':memory:');
		store.createRun({
			id: 'run-crashed',
			issueId: 'CAM-2',
			sessionId: 'session-crashed',
			workspacePath: '/workspaces/run-crashed',
			createdAt: '2026-08-15T10:00:00Z',
		});
		store.transition({
			runId: 'run-crashed',
			toState: 'working',
			kind: 'run.started',
			createdAt: '2026-08-15T10:00:01Z',
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			now: () => '2026-08-15T10:01:00Z',
		});
		expect(runtime.getRun('run-crashed')?.state).toBe('interrupted');
		expect(runtime.listEvents().at(-1)?.kind).toBe('run.recovered-interrupted');
		runtime.close();
	});

	test('allows exactly one automatic review fix round', () => {
		expect(nextFixRounds({ state: 'review', fixRounds: 0 }, 'working')).toBe(1);
		expect(() => nextFixRounds({ state: 'review', fixRounds: 1 }, 'working')).toThrow(
			'limited to one round',
		);
		expect(() => nextFixRounds({ state: 'queued', fixRounds: 0 }, 'review')).toThrow(
			'queued -> review',
		);
	});

	test('moves a fake execution through work and verification', async () => {
		const store = new RunStore(':memory:');
		const observedCwds: string[] = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-complete',
			newSessionId: () => 'session-complete',
			now: () => '2026-08-15T11:00:00Z',
			workspace: { prepare: () => '/workspaces/run-complete' },
			executor: {
				execute: async ({ cwd, emit }) => {
					observedCwds.push(cwd);
					emit('executor.output', { text: 'done' });
					return { outcome: 'completed', summary: 'Changed one seam.' };
				},
			},
			verifier: { verify: async ({ cwd }) => {
				observedCwds.push(cwd);
				return { ok: true };
			} },
		});

		const started = runtime.startRun(' CAM-10 ');
		expect(started).toMatchObject({
			id: 'run-complete',
			issueId: 'CAM-10',
			workspacePath: '/workspaces/run-complete',
			state: 'queued',
		});
		await waitFor(() => runtime.getRun(started.id)?.state === 'ready-to-ship');
		expect(runtime.getRun(started.id)).toMatchObject({
			state: 'ready-to-ship',
			summary: 'Changed one seam.',
		});
		expect(runtime.listEvents().map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'executor.output',
			'run.work-completed',
			'run.verified',
		]);
		expect(observedCwds).toEqual(['/workspaces/run-complete', '/workspaces/run-complete']);
		await runtime.stop();
		runtime.close();
	});

	test('propagates cancellation and waits for the executor to settle', async () => {
		const store = new RunStore(':memory:');
		let executorSettled = false;
		let markStarted = (): void => {};
		const executorStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-cancel',
			executor: {
				execute: ({ signal }) => new Promise((_resolve, reject) => {
					markStarted();
					signal.addEventListener('abort', () => {
						executorSettled = true;
						reject(new DOMException('cancelled', 'AbortError'));
					}, { once: true });
				}),
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = runtime.startRun('CAM-11');
		await executorStarted;

		const cancelled = await runtime.cancelRun(run.id);
		expect(executorSettled).toBe(true);
		expect(cancelled?.state).toBe('interrupted');
		expect(runtime.listEvents().at(-1)?.kind).toBe('run.interrupted');
		await runtime.stop();
		runtime.close();
	});

	test('does not persist a run when workspace preparation fails', () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			workspace: { prepare: () => {
				throw new Error('cannot prepare workspace');
			} },
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
		});

		expect(() => runtime.startRun('CAM-13')).toThrow('cannot prepare workspace');
		expect(runtime.listRuns()).toEqual([]);
		runtime.close();
	});

	test('resumes an interrupted run with the same provider session', async () => {
		const calls: Array<{ sessionId: string; resume: boolean; cwd: string }> = [];
		let firstStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-resume',
			newSessionId: () => 'session-stable',
			workspace: { prepare: () => '/workspaces/run-resume' },
			executor: {
				execute: (input) => {
					calls.push({ sessionId: input.sessionId, resume: input.resume, cwd: input.cwd });
					if (input.resume) return Promise.resolve({ outcome: 'completed' });
					firstStarted();
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
		const run = runtime.startRun('CAM-14');
		await started;
		await runtime.cancelRun(run.id);
		expect(runtime.getRun(run.id)?.state).toBe('interrupted');

		runtime.resumeRun(run.id);
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(calls).toEqual([
			{ sessionId: 'session-stable', resume: false, cwd: '/workspaces/run-resume' },
			{ sessionId: 'session-stable', resume: true, cwd: '/workspaces/run-resume' },
		]);
		await runtime.stop();
		runtime.close();
	});
});
