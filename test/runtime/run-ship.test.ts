// test/runtime/run-ship.test.ts
//
// CAM-583: a verified run continues into shipping under the same ownership and
// reaches done on the merge, with shipping persisted as its own phase. A failed
// or cancelled attempt returns the run to ready-to-ship, where shipRun is the
// explicit retry and still refuses a second concurrent attempt.

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

function eventKinds(runtime: RunRuntime): string[] {
	return runtime.listEvents().map((event) => event.kind);
}

/**
 * The operator's retry, issued as soon as the automatic attempt hands the run
 * back. Ownership is released just after the failure is persisted, so the
 * command is repeated until it is accepted, and any other refusal is raised.
 */
async function retryShip(runtime: RunRuntime, runId: string): Promise<void> {
	await waitForCondition(() => {
		try {
			return runtime.shipRun(runId).state === 'shipping';
		} catch (error) {
			if (!String(error).includes('already active')) throw error;
			return false;
		}
	});
}

describe('shipping a run', () => {
	test('a verified run ships itself, and every step is durable', async () => {
		const runtime = createRuntime({
			ship: async (input: RuntimeShipInput): Promise<RuntimeShipResult> => {
				input.emit('ship.pushed', { branch: 'gship/cam-583' });
				return { outcome: 'merged', prNumber: 385 };
			},
		});
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');

		// No operator command sits between run.verified and run.ship-started.
		expect(eventKinds(runtime)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verified',
			'run.ship-started',
			'ship.pushed',
			'run.shipped',
		]);
		const events = runtime.listEvents();
		expect(events.at(-1)?.payload).toEqual({ prNumber: 385 });
		// The ship is a phase of the run, persisted like every other one.
		expect(events.find((event) => event.kind === 'run.ship-started')).toMatchObject({
			fromState: 'ready-to-ship',
			toState: 'shipping',
		});
		expect(events.at(-1)).toMatchObject({ fromState: 'shipping', toState: 'done' });
		await runtime.stop();
		runtime.close();
	});

	test('releases the managed workspace only after a confirmed merge', async () => {
		const releases: string[] = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-release',
			workspace: {
				prepare: () => '/project/.gship/worktrees/run-release',
				release: (input) => {
					releases.push(input.workspacePath);
					return { outcome: 'released', branch: 'gship/cam-583-run-rel' };
				},
			},
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 385 }) },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => eventKinds(runtime).includes('workspace.released'));

		expect(runtime.getRun(run.id)?.state).toBe('done');
		expect(releases).toEqual(['/project/.gship/worktrees/run-release']);
		expect(eventKinds(runtime).slice(-2)).toEqual(['run.shipped', 'workspace.released']);
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			branch: 'gship/cam-583-run-rel',
			outcome: 'released',
			reconciled: false,
		});
		await runtime.stop();
		runtime.close();
	});

	test('keeps a merged run done when workspace cleanup needs attention', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-dirty',
			workspace: {
				prepare: () => '/project/.gship/worktrees/run-dirty',
				release: () => ({
					outcome: 'preserved',
					branch: 'gship/cam-583-run-dir',
					detail: 'workspace has local changes',
				}),
			},
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 385 }) },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => eventKinds(runtime).includes('workspace.cleanup-warning'));

		expect(runtime.getRun(run.id)?.state).toBe('done');
		expect(runtime.listEvents().at(-1)).toMatchObject({
			kind: 'workspace.cleanup-warning',
			fromState: 'done',
			toState: 'done',
			payload: { detail: 'workspace has local changes' },
		});
		await runtime.stop();
		runtime.close();
	});

	test('a failed automatic ship stays ready-to-ship and the button ships again', async () => {
		const attempts: string[] = [];
		const runtime = createRuntime({
			ship: async (input) => {
				attempts.push(input.runId);
				return attempts.length === 1
					? { outcome: 'failed', detail: 'gh pr merge failed: required checks are red' }
					: { outcome: 'merged', prNumber: 385 };
			},
		});
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => eventKinds(runtime).includes('run.ship-failed'));

		// The diff is untouched and the run is still shippable: no failed state.
		expect(runtime.getRun(run.id)).toMatchObject({ state: 'ready-to-ship' });
		expect(runtime.listEvents().at(-1)).toMatchObject({
			fromState: 'shipping',
			toState: 'ready-to-ship',
			payload: { error: 'gh pr merge failed: required checks are red' },
		});

		await retryShip(runtime, run.id);
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');
		expect(attempts).toHaveLength(2);
		await runtime.stop();
		runtime.close();
	});

	test('a ship refused over a foreign head keeps its detection in the run history', async () => {
		// GSHIP-615: the shipper stops on a head it never pushed. The run must
		// keep the detection visible and stay shippable, exactly like any other
		// failed attempt: the diff is untouched and the merge never happened.
		const runtime = createRuntime({
			ship: async (input) => {
				input.emit('ship.pushed', { branch: 'gship/cam-583' });
				input.emit('ship.head-diverged', {
					prNumber: 385,
					headSha: 'aaaa',
					observedHead: 'bbbb',
					merged: false,
				});
				return { outcome: 'failed', detail: 'pull request #385 now carries bbbb' };
			},
		});
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => eventKinds(runtime).includes('run.ship-failed'));

		expect(runtime.getRun(run.id)).toMatchObject({ state: 'ready-to-ship' });
		expect(eventKinds(runtime)).not.toContain('run.shipped');
		const diverged = runtime.listEvents().find((event) => event.kind === 'ship.head-diverged');
		expect(diverged?.payload).toEqual({
			prNumber: 385,
			headSha: 'aaaa',
			observedHead: 'bbbb',
			merged: false,
		});
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			error: 'pull request #385 now carries bbbb',
		});
		await runtime.stop();
		runtime.close();
	});

	test('a thrown ship is reported as a retryable failure, not a failed run', async () => {
		const runtime = createRuntime({
			ship: async () => {
				throw new Error('gh pr create failed: no such remote');
			},
		});
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => eventKinds(runtime).includes('run.ship-failed'));

		expect(runtime.getRun(run.id)).toMatchObject({ state: 'ready-to-ship' });
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
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'shipping');

		// The automatic ship owns the run, so the retry command is refused.
		expect(() => runtime.shipRun(run.id)).toThrow(`run is already active: ${run.id}`);

		release();
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');
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
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'shipping');
		const cancelled = await runtime.cancelRun(run.id);

		expect(observedAbort).toBe(true);
		expect(cancelled).toMatchObject({ state: 'ready-to-ship' });
		expect(runtime.listEvents().at(-1)).toMatchObject({
			kind: 'run.ship-cancelled',
			fromState: 'shipping',
			toState: 'ready-to-ship',
		});
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
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(() => runtime.shipRun(run.id)).toThrow('run cannot ship from state waiting-user');
		expect(() => runtime.shipRun('missing-run')).toThrow('run not found: missing-run');
		expect(eventKinds(runtime)).not.toContain('run.ship-started');

		await runtime.stop();
		runtime.close();
	});

	test('a runtime without a shipper stops at ready-to-ship instead of pretending', async () => {
		const runtime = createRuntime();
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(eventKinds(runtime)).not.toContain('run.ship-started');
		expect(() => runtime.shipRun(run.id)).toThrow(RuntimeUnavailableError);
		expect(runtime.getRun(run.id)).toMatchObject({ state: 'ready-to-ship' });
		await runtime.stop();
		runtime.close();
	});

	test('a ship left mid-flight by a crashed service recovers as shippable', () => {
		const store = new RunStore(':memory:');
		store.createRun({
			id: 'run-crashed-ship',
			issueId: 'CAM-583',
			sessionId: 'session-crashed-ship',
			workspacePath: '/workspaces/run-crashed-ship',
			createdAt: '2026-08-16T10:00:00Z',
		});
		for (const toState of ['working', 'verify', 'ready-to-ship', 'shipping'] as const) {
			store.transition({
				runId: 'run-crashed-ship',
				toState,
				kind: `run.${toState}`,
				createdAt: '2026-08-16T10:00:01Z',
			});
		}
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			now: () => '2026-08-16T10:01:00Z',
		});

		// The verified diff survived the crash; only the attempt was lost.
		expect(runtime.getRun('run-crashed-ship')?.state).toBe('ready-to-ship');
		expect(runtime.listEvents().at(-1)?.kind).toBe('run.recovered-shippable');
		runtime.close();
	});

	test('retries release of a done workspace when the service starts', () => {
		const store = new RunStore(':memory:');
		store.createRun({
			id: 'run-done-before-start',
			issueId: 'CAM-583',
			sessionId: 'session-done-before-start',
			workspacePath: '/project/.gship/worktrees/run-done-before-start',
			createdAt: '2026-08-16T10:00:00Z',
		});
		for (const toState of ['working', 'verify', 'ready-to-ship', 'shipping', 'done'] as const) {
			store.transition({
				runId: 'run-done-before-start',
				toState,
				kind: `run.${toState}`,
				createdAt: '2026-08-16T10:00:01Z',
			});
		}
		const releases: string[] = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			workspace: {
				prepare: () => '/unused',
				release: (input) => {
					releases.push(input.runId);
					return { outcome: 'already-released', branch: 'gship/cam-583-run-don' };
				},
			},
		});

		expect(releases).toEqual(['run-done-before-start']);
		expect(runtime.getRun('run-done-before-start')?.state).toBe('done');
		expect(runtime.listEvents().at(-1)).toMatchObject({
			kind: 'workspace.released',
			payload: { outcome: 'already-released', reconciled: true },
		});
		runtime.close();
	});
});
