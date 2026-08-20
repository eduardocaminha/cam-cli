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
	type RuntimeExecutionInput,
	type RuntimeShipInput,
	type RuntimeShipper,
	type RuntimeShipResult,
	type RuntimeVerifier,
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
		// The chain switch is off by default, so the terminal `done` still pauses
		// the queue with its own durable reason (GSHIP-638).
		expect(eventKinds(runtime)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verified',
			'run.ship-started',
			'ship.pushed',
			'run.shipped',
			'run.chain-paused',
		]);
		const events = runtime.listEvents();
		expect(events.find((event) => event.kind === 'run.shipped')?.payload).toEqual({ prNumber: 385 });
		// The ship is a phase of the run, persisted like every other one.
		expect(events.find((event) => event.kind === 'run.ship-started')).toMatchObject({
			fromState: 'ready-to-ship',
			toState: 'shipping',
		});
		expect(events.find((event) => event.kind === 'run.shipped')).toMatchObject({
			fromState: 'shipping',
			toState: 'done',
		});
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
		// The chain switch is off by default, so `done` still pauses the queue
		// with its own durable reason (GSHIP-638) before the workspace releases.
		expect(eventKinds(runtime).slice(-3)).toEqual(['run.shipped', 'run.chain-paused', 'workspace.released']);
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			branch: 'gship/cam-583-run-rel',
			outcome: 'released',
			reconciled: false,
		});
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-658: `ship` merges with `--squash` (github-shipper.ts), which lands
	// a brand-new commit on the base ref -- a merged branch's own commits are
	// never reachable from it even though the work landed there. Requiring
	// upstream reachability on this path, like the abandon and failed paths
	// do, would misreport every merge as carrying a missing commit and block
	// exactly the remote delete this issue adds.
	test('never requires upstream reachability on the merge path', async () => {
		const releaseCalls: Array<{ requireUpstream?: boolean }> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-release-upstream',
			workspace: {
				prepare: () => '/project/.gship/worktrees/run-release-upstream',
				release: ({ requireUpstream }) => {
					releaseCalls.push({ requireUpstream });
					return { outcome: 'released', branch: 'gship/cam-584-run-rel' };
				},
			},
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 386 }) },
		});

		runtime.startRun('CAM-584');
		await waitForCondition(() => eventKinds(runtime).includes('workspace.released'));

		expect(releaseCalls).toEqual([{ requireUpstream: false }]);
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

	test('a refused head keeps the arming take-down in the run history too', async () => {
		// GSHIP-616: the shipper takes the armed auto-merge down before it reports
		// the divergence, and a take-down GitHub refused is recorded just as
		// plainly — the operator reading the history has to know whether the
		// arming may still be sitting on the pull request.
		const runtime = createRuntime({
			ship: async (input) => {
				input.emit('ship.pushed', { branch: 'gship/cam-583' });
				input.emit('ship.automerge-disarmed', {
					prNumber: 385,
					disarmed: false,
					detail: 'failed to disable auto-merge: not enabled',
				});
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
		// The take-down is recorded before the divergence it protects against.
		expect(eventKinds(runtime).slice(-3)).toEqual([
			'ship.automerge-disarmed',
			'ship.head-diverged',
			'run.ship-failed',
		]);
		expect(runtime.listEvents().find((event) => event.kind === 'ship.automerge-disarmed')?.payload)
			.toEqual({
				prNumber: 385,
				disarmed: false,
				detail: 'failed to disable auto-merge: not enabled',
			});
		// A refused take-down never becomes the reported reason.
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			error: 'pull request #385 now carries bbbb',
		});
		await runtime.stop();
		runtime.close();
	});

	test('an unconfirmed merge after GitHub stayed unavailable is kept distinct from a merge failure in the run history', async () => {
		// GSHIP-625: the operator confusion this fixes was seeing "failed" when
		// GitHub had actually merged the pull request a second later. The
		// shipper's own wording has to survive into both the run history and
		// the payload the operator-facing message is built from, unchanged.
		const runtime = createRuntime({
			ship: async (input) => {
				input.emit('ship.pushed', { branch: 'gship/cam-583' });
				input.emit('ship.merge-unconfirmed', {
					prNumber: 385,
					headSha: 'aaaa',
					detail: 'gh pr view still failing after 4 attempts: GitHub appears unavailable: HTTP 503',
				});
				return {
					outcome: 'failed',
					detail: 'pull request #385 merge could not be confirmed: GitHub appears unavailable ' +
						'— this is not a merge failure, GitHub may already have merged it; check the ' +
						'pull request directly before shipping again',
				};
			},
		});
		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => eventKinds(runtime).includes('run.ship-failed'));

		expect(runtime.getRun(run.id)).toMatchObject({ state: 'ready-to-ship' });
		expect(eventKinds(runtime)).not.toContain('run.shipped');
		const unconfirmed = runtime.listEvents().find((event) => event.kind === 'ship.merge-unconfirmed');
		expect(unconfirmed?.payload).toMatchObject({ prNumber: 385, headSha: 'aaaa' });
		const failurePayload = runtime.listEvents().at(-1)?.payload as { error: string };
		expect(failurePayload.error).toContain('could not be confirmed');
		expect(failurePayload.error).toContain('not a merge failure');
		expect(failurePayload.error).not.toContain('closed without merging');
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

// GSHIP-649: the project's own full verification manifest (package.json's
// `verify` script, e.g. `bun run check:all`) runs once the issue's own verify
// and the independent review are both clean, and before the run is ever
// reported ready to ship -- so a rejection reaches the executor as a fix
// round instead of surfacing only in CI once the run has already ended.
describe('the full-project verification gate (GSHIP-649)', () => {
	interface FullVerifyExecution {
		resume: boolean;
		fullVerifyFeedback: string | undefined;
	}

	function createFullVerifyRuntime(
		fullVerifier: RuntimeVerifier,
		shipper: RuntimeShipper,
	): { runtime: RunRuntime; executions: FullVerifyExecution[] } {
		const executions: FullVerifyExecution[] = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-full-verify',
			newSessionId: () => 'session-full-verify',
			executor: {
				execute: async (input: RuntimeExecutionInput) => {
					executions.push({ resume: input.resume, fullVerifyFeedback: input.fullVerifyFeedback });
					return { outcome: 'completed', summary: 'change written' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
			fullVerifier,
			shipper,
		});
		return { runtime, executions };
	}

	test('a clean full verification lets an otherwise-verified run ship', async () => {
		const calls: string[] = [];
		const { runtime } = createFullVerifyRuntime(
			{
				verify: async () => {
					calls.push('full-verify');
					return { ok: true };
				},
			},
			{ ship: async () => ({ outcome: 'merged', prNumber: 649 }) },
		);
		const run = runtime.startRun('GSHIP-649');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');

		expect(calls).toEqual(['full-verify']);
		expect(eventKinds(runtime)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verified',
			'run.full-verify-clean',
			'run.ship-started',
			'run.shipped',
			'run.chain-paused',
		]);
		await runtime.stop();
		runtime.close();
	});

	test('a rejection sends the run back to the executor for one fix round, then ships', async () => {
		let calls = 0;
		const { runtime, executions } = createFullVerifyRuntime(
			{
				verify: async () => {
					calls += 1;
					return calls === 1
						? { ok: false, detail: 'bun run verify: dist/ is stale' }
						: { ok: true };
				},
			},
			{ ship: async () => ({ outcome: 'merged', prNumber: 649 }) },
		);
		const run = runtime.startRun('GSHIP-649');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');

		expect(calls).toBe(2);
		expect(eventKinds(runtime)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verified',
			'run.full-verify-fix-requested',
			'run.work-completed',
			'run.verified',
			'run.full-verify-clean',
			'run.ship-started',
			'run.shipped',
			'run.chain-paused',
		]);
		// The fix round is the only execution that carries the full
		// verification's failure output, and it continues the same session.
		expect(executions).toEqual([
			{ resume: false, fullVerifyFeedback: undefined },
			{ resume: true, fullVerifyFeedback: 'bun run verify: dist/ is stale' },
		]);
		await runtime.stop();
		runtime.close();
	});

	test('a second rejection ends the run at waiting-user instead of looping or shipping', async () => {
		let shipCalls = 0;
		const { runtime, executions } = createFullVerifyRuntime(
			{ verify: async () => ({ ok: false, detail: 'bun run verify: lint failed in test/' }) },
			{
				ship: async () => {
					shipCalls += 1;
					return { outcome: 'merged', prNumber: 649 };
				},
			},
		);
		const run = runtime.startRun('GSHIP-649');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(runtime.getRun(run.id)).toMatchObject({
			state: 'waiting-user',
			summary: 'bun run verify: lint failed in test/',
		});
		expect(eventKinds(runtime)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verified',
			'run.full-verify-fix-requested',
			'run.work-completed',
			'run.verified',
			'run.full-verify-fix-limit',
		]);
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			findings: 'bun run verify: lint failed in test/',
		});
		expect(executions).toHaveLength(2);
		expect(shipCalls).toBe(0);
		await runtime.stop();
		runtime.close();
	});

	test('a project with no declared verify script skips the gate without failing the run', async () => {
		const { runtime } = createFullVerifyRuntime(
			{ verify: async () => ({ ok: true, skipped: true }) },
			{ ship: async () => ({ outcome: 'merged', prNumber: 649 }) },
		);
		const run = runtime.startRun('GSHIP-649');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');

		expect(eventKinds(runtime)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verified',
			'run.full-verify-skipped',
			'run.ship-started',
			'run.shipped',
			'run.chain-paused',
		]);
		await runtime.stop();
		runtime.close();
	});

	test('sits in its own full-verify phase while the check runs, not resting at ready-to-ship', async () => {
		let release = (): void => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { runtime } = createFullVerifyRuntime(
			{
				verify: async () => {
					await released;
					return { ok: true };
				},
			},
			{ ship: async () => ({ outcome: 'merged', prNumber: 649 }) },
		);
		const run = runtime.startRun('GSHIP-649');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'full-verify');

		// ready-to-ship is a resting state again (GSHIP-649): the operator's
		// screen must not read "needs you" with the Ship command enabled while
		// the gate itself is still running.
		expect(runtime.getRun(run.id)?.state).toBe('full-verify');
		expect(eventKinds(runtime)).not.toContain('run.ship-started');

		release();
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');
		await runtime.stop();
		runtime.close();
	});

	test('a crash mid-full-verify recovers as interrupted, the same as any other mid-flight state', () => {
		const store = new RunStore(':memory:');
		store.createRun({
			id: 'run-crashed-full-verify',
			issueId: 'GSHIP-649',
			sessionId: 'session-crashed-full-verify',
			workspacePath: '/workspaces/run-crashed-full-verify',
			createdAt: '2026-08-19T10:00:00Z',
		});
		for (const toState of ['working', 'verify', 'full-verify'] as const) {
			store.transition({
				runId: 'run-crashed-full-verify',
				toState,
				kind: `run.${toState}`,
				createdAt: '2026-08-19T10:00:01Z',
			});
		}

		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			now: () => '2026-08-19T10:01:00Z',
		});

		expect(runtime.getRun('run-crashed-full-verify')?.state).toBe('interrupted');
		expect(runtime.listEvents().at(-1)?.kind).toBe('run.recovered-interrupted');
		runtime.close();
	});
});
