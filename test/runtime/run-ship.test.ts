// test/runtime/run-ship.test.ts
//
// CAM-579 acceptance criterion 2: RunRuntime ships only a run that reached
// ready-to-ship, keeps a single operation per run, persists every ship event,
// reaches done only on a real merge, leaves a failed attempt retryable in
// ready-to-ship, and cancels by awaiting the shipper it started.

import { describe, expect, test } from 'bun:test';

import {
	RunRuntime,
	RuntimeUnavailableError,
	type RuntimeShipInput,
	type RuntimeShipper,
	type RuntimeShipResult,
} from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

function createRuntime(shipper?: RuntimeShipper): RunRuntime {
	return new RunRuntime({
		cwd: '/project',
		store: new RunStore(':memory:'),
		newId: () => 'run-ship',
		newSessionId: () => 'session-ship',
		executor: { execute: async () => ({ outcome: 'completed', summary: 'change written' }) },
		verifier: { verify: async () => ({ ok: true }) },
		...(shipper === undefined ? {} : { shipper }),
	});
}

async function startReadyRun(runtime: RunRuntime): Promise<string> {
	const run = runtime.startRun('CAM-579');
	await waitForCondition(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
	return run.id;
}

function eventKinds(runtime: RunRuntime): string[] {
	return runtime.listEvents().map((event) => event.kind);
}

describe('shipping a run', () => {
	test('a merged pull request is the only path to done, and every step is durable', async () => {
		const runtime = createRuntime({
			ship: async (input: RuntimeShipInput): Promise<RuntimeShipResult> => {
				input.emit('ship.pushed', { branch: 'gship/cam-579' });
				return { outcome: 'merged', prNumber: 385 };
			},
		});
		const runId = await startReadyRun(runtime);

		runtime.shipRun(runId);
		await waitForCondition(() => runtime.getRun(runId)?.state === 'done');

		expect(eventKinds(runtime)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verified',
			'run.ship-started',
			'ship.pushed',
			'run.shipped',
		]);
		expect(runtime.listEvents().at(-1)?.payload).toEqual({ prNumber: 385 });
		await runtime.stop();
		runtime.close();
	});

	test('a failed ship stays ready-to-ship and the same run ships again', async () => {
		const attempts: string[] = [];
		const runtime = createRuntime({
			ship: async (input) => {
				attempts.push(input.runId);
				return attempts.length === 1
					? { outcome: 'failed', detail: 'gh pr merge failed: required checks are red' }
					: { outcome: 'merged', prNumber: 385 };
			},
		});
		const runId = await startReadyRun(runtime);

		runtime.shipRun(runId);
		await waitForCondition(() => eventKinds(runtime).includes('run.ship-failed'));

		// The diff is untouched and the run is still shippable: no failed state.
		expect(runtime.getRun(runId)).toMatchObject({ state: 'ready-to-ship' });
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			error: 'gh pr merge failed: required checks are red',
		});

		runtime.shipRun(runId);
		await waitForCondition(() => runtime.getRun(runId)?.state === 'done');
		expect(attempts).toHaveLength(2);
		await runtime.stop();
		runtime.close();
	});

	test('a thrown ship is reported as a retryable failure, not a failed run', async () => {
		const runtime = createRuntime({
			ship: async () => {
				throw new Error('gh pr create failed: no such remote');
			},
		});
		const runId = await startReadyRun(runtime);

		runtime.shipRun(runId);
		await waitForCondition(() => eventKinds(runtime).includes('run.ship-failed'));

		expect(runtime.getRun(runId)).toMatchObject({ state: 'ready-to-ship' });
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			error: 'gh pr create failed: no such remote',
		});
		await runtime.stop();
		runtime.close();
	});

	test('one run never has two ship operations at once', async () => {
		let release = (): void => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = createRuntime({
			ship: async () => {
				await released;
				return { outcome: 'merged', prNumber: 385 };
			},
		});
		const runId = await startReadyRun(runtime);

		runtime.shipRun(runId);
		expect(() => runtime.shipRun(runId)).toThrow(`run is already active: ${runId}`);

		release();
		await waitForCondition(() => runtime.getRun(runId)?.state === 'done');
		await runtime.stop();
		runtime.close();
	});

	test('cancelling a ship awaits the shipper and leaves the run shippable', async () => {
		let observedAbort = false;
		const runtime = createRuntime({
			ship: async (input) => new Promise<RuntimeShipResult>((resolve) => {
				input.signal.addEventListener('abort', () => {
					observedAbort = true;
					resolve({ outcome: 'failed', detail: 'cancelled' });
				}, { once: true });
			}),
		});
		const runId = await startReadyRun(runtime);

		runtime.shipRun(runId);
		await waitForCondition(() => eventKinds(runtime).includes('run.ship-started'));
		const cancelled = await runtime.cancelRun(runId);

		expect(observedAbort).toBe(true);
		expect(cancelled).toMatchObject({ state: 'ready-to-ship' });
		expect(eventKinds(runtime).at(-1)).toBe('run.ship-cancelled');
		runtime.close();
	});

	test('a run that has not reached ready-to-ship cannot ship', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-ship-blocked',
			executor: { execute: async () => ({ outcome: 'waiting-user', summary: 'decide first' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 385 }) },
		});
		const run = runtime.startRun('CAM-579');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(() => runtime.shipRun(run.id)).toThrow('run cannot ship from state waiting-user');
		expect(() => runtime.shipRun('missing-run')).toThrow('run not found: missing-run');
		expect(eventKinds(runtime)).not.toContain('run.ship-started');

		await runtime.stop();
		runtime.close();
	});

	test('a runtime without a shipper reports it instead of pretending to ship', async () => {
		const runtime = createRuntime();
		const runId = await startReadyRun(runtime);

		expect(() => runtime.shipRun(runId)).toThrow(RuntimeUnavailableError);
		expect(runtime.getRun(runId)).toMatchObject({ state: 'ready-to-ship' });
		await runtime.stop();
		runtime.close();
	});
});
