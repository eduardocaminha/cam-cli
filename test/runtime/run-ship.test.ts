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
	type RuntimeCycleQuestionResolver,
	type RuntimeShipInput,
	type RuntimeShipper,
	type RuntimeShipResult,
	type RuntimeTimer,
	type RuntimeVerifier,
} from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { ProviderCallError } from '../../src/runtime/agent-session.ts';
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

/** The one-shot provider-retry timer, driven by hand instead of the clock. */
function createFakeTimer() {
	let armed: { handle: number; delayMs: number; callback: () => void } | null = null;
	let nextHandle = 1;
	const timer: RuntimeTimer = {
		set: (callback, delayMs) => {
			const handle = nextHandle;
			nextHandle += 1;
			armed = { handle, delayMs, callback };
			return handle;
		},
		clear: (handle) => {
			if (armed?.handle === handle) armed = null;
		},
	};
	return {
		timer,
		delay: (): number | null => armed?.delayMs ?? null,
		fire: (): void => {
			const current = armed;
			if (current === null) throw new Error('no automatic retry is armed');
			armed = null;
			current.callback();
		},
	};
}

/**
 * A run stopped by a crash while reviewing the single CI correction round: the
 * store recovers it as interrupted out of `review`, with the correction's
 * durable evidence still unconsumed.
 */
function crashedCiRun(runId: string, sessionId: string): RunStore {
	const store = new RunStore(':memory:');
	store.createRun({
		id: runId,
		issueId: 'GSHIP-720',
		sessionId,
		workspacePath: `/workspaces/${runId}`,
		createdAt: '2026-08-23T10:00:00Z',
	});
	for (const toState of ['working', 'verify', 'review', 'full-verify', 'ready-to-ship', 'shipping'] as const) {
		store.transition({ runId, toState, kind: `run.${toState}`, createdAt: '2026-08-23T10:00:01Z' });
	}
	store.transition({
		runId,
		toState: 'working',
		kind: 'run.ci-fix-requested',
		createdAt: '2026-08-23T10:00:02Z',
		payload: {
			origin: 'ci',
			evidence: { prNumber: 385, headSha: 'aaaa', check: { name: 'ci/build' } },
		},
	});
	for (const toState of ['verify', 'review'] as const) {
		store.transition({ runId, toState, kind: `run.${toState}`, createdAt: '2026-08-23T10:00:03Z' });
	}
	return store;
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

	test('a required CI check failure reuses the run for one verified, reviewed correction and the same PR', async () => {
		const executions: RuntimeExecutionInput[] = [];
		let ships = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-ci-fix',
			newSessionId: () => 'session-ci-fix',
			executor: { execute: async (input) => {
				executions.push(input);
				return { outcome: 'completed', summary: 'change written' };
			} },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => ({ verdict: 'clean' }) },
			fullVerifier: { verify: async () => ({ ok: true }) },
			hasWorkspaceChanges: () => true,
			shipper: { ship: async () => ++ships === 1 ? {
				outcome: 'ci-failed',
				evidence: {
					prNumber: 385,
					headSha: 'aaaa',
					check: { name: 'ci/build', url: 'https://github.com/acme/repo/actions/runs/7' },
				},
			} : { outcome: 'merged', prNumber: 385 } },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');

		expect(ships).toBe(2);
		expect(executions).toHaveLength(2);
		const correctionFeedback = executions[1]?.ciFeedback;
		expect(correctionFeedback).toContain('Required check: ci/build');
		expect(correctionFeedback).toContain('Check URL: https://github.com/acme/repo/actions/runs/7');
		// GSHIP-720: the shared evidence is durable facts only. The ephemeral
		// diagnosis command belongs to the executors' own prompt section,
		// because the reviewer reads this same text and cannot run commands.
		expect(correctionFeedback).not.toContain('--log-failed');
		expect(executions[1]).toMatchObject({
			resume: true,
		});
		expect(eventKinds(runtime)).toContain('run.ci-fix-requested');
		expect(runtime.getRunRoundOrigins(run.id)).toMatchObject({ ci: 1 });
		await runtime.stop();
		runtime.close();
	});

	test('a repeated CI failure on the corrected head stops at waiting-user with both durable evidences', async () => {
		let ships = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-ci-repeat',
			newSessionId: () => 'session-ci-repeat',
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			hasWorkspaceChanges: () => true,
			shipper: { ship: async () => ({
				outcome: 'ci-failed',
				evidence: {
					prNumber: 385,
					headSha: ++ships === 1 ? 'aaaa' : 'bbbb',
					check: { name: 'ci/build', url: `https://github.com/acme/repo/actions/runs/${ships}` },
				},
			}) },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-user');
		const limit = runtime.listEvents().find((event) => event.kind === 'run.ci-fix-limit');
		expect(limit?.payload).toMatchObject({
			evidence: { headSha: 'bbbb' },
			previousEvidence: { headSha: 'aaaa' },
		});
		expect(ships).toBe(2);
		await runtime.stop();
		runtime.close();
	});

	test('a CI correction that produces no change stops before verification', async () => {
		let verifications = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-ci-no-change',
			newSessionId: () => 'session-ci-no-change',
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => { verifications += 1; return { ok: true }; } },
			hasWorkspaceChanges: () => false,
			shipper: { ship: async () => ({
				outcome: 'ci-failed',
				evidence: { prNumber: 385, headSha: 'aaaa', check: { name: 'ci/build' } },
			}) },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-user');
		expect(verifications).toBe(1);
		expect(eventKinds(runtime).at(-1)).toBe('run.ci-fix-no-change');
		await runtime.stop();
		runtime.close();
	});

	test('a provider hold during CI correction uses waiting-provider and resumes with the durable CI evidence', async () => {
		let executions = 0;
		let ships = 0;
		let resumedEvidence = '';
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-ci-provider',
			newSessionId: () => 'session-ci-provider',
			executor: { execute: async (input) => {
				executions += 1;
				if (executions === 2) throw new ProviderCallError('claude', 'usage-limit', 'limit reached');
				if (executions === 3) resumedEvidence = input.ciFeedback ?? '';
				return { outcome: 'completed' };
			} },
			verifier: { verify: async () => ({ ok: true }) },
			hasWorkspaceChanges: () => true,
			shipper: { ship: async () => ++ships === 1 ? {
				outcome: 'ci-failed',
				evidence: { prNumber: 385, headSha: 'aaaa', check: { name: 'ci/build' } },
			} : { outcome: 'merged', prNumber: 385 } },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		runtime.resumeRun(run.id);
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');
		expect(resumedEvidence).toContain('Required check: ci/build');
		await runtime.stop();
		runtime.close();
	});

	test('a review hold resumes the reviewer with CI evidence and keeps it on a later fix attempt', async () => {
		const executions: RuntimeExecutionInput[] = [];
		const reviewerEvidence: Array<string | undefined> = [];
		let reviews = 0;
		let verifications = 0;
		let changeChecks = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-ci-review-provider',
			newSessionId: () => 'session-ci-review-provider',
			executor: { execute: async (input) => {
				executions.push(input);
				return { outcome: 'completed' };
			} },
			verifier: { verify: async () => { verifications += 1; return { ok: true }; } },
			reviewer: { review: async (input) => {
				reviews += 1;
				reviewerEvidence.push(input.ciFeedback);
				if (reviews === 1) return { verdict: 'clean' };
				if (reviews === 2) {
					throw new ProviderCallError('claude', 'usage-limit', 'review limit reached');
				}
				return { verdict: 'findings', detail: 'fix the CI-specific defect' };
			} },
			hasWorkspaceChanges: () => changeChecks++ === 0,
			shipper: { ship: async () => ({
				outcome: 'ci-failed',
				evidence: { prNumber: 385, headSha: 'aaaa', check: { name: 'ci/build' } },
			}) },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(executions).toHaveLength(2);
		expect(verifications).toBe(2);

		runtime.resumeRun(run.id);
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(executions).toHaveLength(3);
		expect(reviewerEvidence[2]).toContain('Required check: ci/build');
		expect(executions[2]?.ciFeedback).toContain('Required check: ci/build');
		expect(verifications).toBe(2);
		expect(eventKinds(runtime).at(-1)).toBe('run.ci-fix-no-change');
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-720: the CI correction can also start from the operator's shipRun,
	// and a provider hold taken there rests on waiting-provider like any other.
	// The automatic resume has to be armed on this path too, or the run waits
	// for a human that the hold never needed.
	test('a provider hold in a shipRun-started CI correction arms the automatic resume', async () => {
		let executions = 0;
		let ships = 0;
		const fake = createFakeTimer();
		let clock = '2026-08-23T10:00:00.000Z';
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-ci-ship-retry',
			newSessionId: () => 'session-ci-ship-retry',
			now: () => clock,
			timer: fake.timer,
			executor: { execute: async () => {
				executions += 1;
				if (executions === 2) {
					throw new ProviderCallError('claude', 'usage-limit', 'limit reached', {
						retryAt: '2026-08-23T10:10:00.000Z',
					});
				}
				return { outcome: 'completed' };
			} },
			verifier: { verify: async () => ({ ok: true }) },
			hasWorkspaceChanges: () => true,
			shipper: { ship: async (): Promise<RuntimeShipResult> => {
				ships += 1;
				if (ships === 1) return { outcome: 'failed', detail: 'github unavailable' };
				if (ships === 2) {
					return {
						outcome: 'ci-failed',
						evidence: { prNumber: 385, headSha: 'aaaa', check: { name: 'ci/build' } },
					};
				}
				return { outcome: 'merged', prNumber: 385 };
			} },
		});

		const run = runtime.startRun('CAM-583');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		// The correction round belongs to the operator's explicit retry, not to
		// the automatic ship the run made for itself.
		await retryShip(runtime, run.id);
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(fake.delay()).toBe(600_000);

		clock = '2026-08-23T10:10:00.000Z';
		fake.fire();
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');

		// No operator answered the hold: the resume is the automatic one.
		const kinds = eventKinds(runtime);
		expect(kinds).toContain('run.provider-retry-automatic');
		expect(kinds).not.toContain('run.operator-guidance');
		expect(runtime.getRunEvaluation(run.id)).toMatchObject({ operatorInterventions: 0 });
		await runtime.stop();
		runtime.close();
	});

	test('a crash taken in review during a CI correction resumes the reviewer with the same evidence', async () => {
		const store = crashedCiRun('run-ci-crash', 'session-ci-crash');
		const executions: RuntimeExecutionInput[] = [];
		const reviews: RuntimeExecutionInput[] = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			executor: { execute: async (input) => {
				executions.push(input);
				return { outcome: 'completed' };
			} },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async (input) => {
				reviews.push(input);
				return { verdict: 'clean' };
			} },
			hasWorkspaceChanges: () => true,
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 385 }) },
		});

		expect(runtime.getRun('run-ci-crash')?.state).toBe('interrupted');
		// The operator answers the crash with guidance. That guidance is an
		// event of its own, emitted while the run is already interrupted, and
		// it must not be read as the interruption that names the resumed phase.
		runtime.resumeRun('run-ci-crash', 'Mantenha a correcao de CI e revise o diff atual.');
		await waitForCondition(() => runtime.getRun('run-ci-crash')?.state === 'done');

		// The verified diff is reviewed again, not re-executed, and the open CI
		// round is still the reviewer's context.
		expect(executions).toHaveLength(0);
		expect(reviews).toHaveLength(1);
		expect(reviews[0]?.ciFeedback).toContain('Required check: ci/build');
		// The decision reached the handoff and stayed in the history.
		expect(reviews[0]?.operatorDecisions)
			.toContain('Mantenha a correcao de CI e revise o diff atual.');
		expect(eventKinds(runtime)).toContain('run.operator-guidance');
		const events = runtime.listEvents();
		const recovered = events.findLastIndex((event) => event.kind === 'run.recovered-interrupted');
		expect(events.slice(recovered + 1).map((event) => event.toState)).not.toContain('working');
		await runtime.stop();
		runtime.close();
	});

	test('a later interruption taken from working resumes working, not the earlier review recovery', async () => {
		const store = crashedCiRun('run-ci-crash-again', 'session-ci-crash-again');
		// The crash out of review is really recovered, resumed into the reviewer
		// and answered with a fix round; the run is then stopped again from
		// working. The current interruption, not the older recovery still in the
		// history, names the phase the resume re-enters.
		store.recoverUnownedRuns('2026-08-23T10:00:10Z');
		store.transition({
			runId: 'run-ci-crash-again',
			toState: 'review',
			kind: 'run.started',
			createdAt: '2026-08-23T10:00:11Z',
		});
		store.transition({
			runId: 'run-ci-crash-again',
			toState: 'working',
			kind: 'run.review-fix-requested',
			createdAt: '2026-08-23T10:00:12Z',
		});
		store.transition({
			runId: 'run-ci-crash-again',
			toState: 'interrupted',
			kind: 'run.interrupted',
			createdAt: '2026-08-23T10:00:13Z',
		});
		const executions: RuntimeExecutionInput[] = [];
		let reviews = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			executor: { execute: async (input) => {
				executions.push(input);
				return { outcome: 'completed' };
			} },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => { reviews += 1; return { verdict: 'clean' }; } },
			hasWorkspaceChanges: () => true,
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 385 }) },
		});

		runtime.resumeRun('run-ci-crash-again');
		await waitForCondition(() => runtime.getRun('run-ci-crash-again')?.state === 'done');

		expect(executions).toHaveLength(1);
		expect(executions[0]?.ciFeedback).toContain('Required check: ci/build');
		expect(reviews).toBe(1);
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
		cycleQuestionResolver?: RuntimeCycleQuestionResolver,
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
			...(cycleQuestionResolver === undefined ? {} : { cycleQuestionResolver }),
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
			'run.cycle-question',
			'run.review-fix-limit',
		]);
		expect(runtime.listEvents().at(-1)?.payload).toEqual({
			questionId: 'run-full-verify',
			findings: 'bun run verify: lint failed in test/',
			origin: 'full-verify',
			reason: 'Cycle question resolver is unavailable.',
		});
		expect(executions).toHaveLength(2);
		expect(shipCalls).toBe(0);
		await runtime.stop();
		runtime.close();
	});

	test('routes a later full verification failure through the internal resolver', async () => {
		let calls = 0;
		const { runtime } = createFullVerifyRuntime(
			{ verify: async () => {
				calls += 1;
				return calls < 3 ? { ok: false, detail: `full verify failure ${calls}` } : { ok: true };
			} },
			{ ship: async () => ({ outcome: 'merged', prNumber: 732 }) },
			{ resolve: async (input) => {
				expect(input.origin).toBe('full-verify');
				return { outcome: 'continue', guidance: 'Apply the verification correction.', usage: { model: 'model', effort: 'high' } };
			} },
		);
		const run = runtime.startRun('GSHIP-732');
		await waitForCondition(() => runtime.getRun(run.id)?.state === 'done');
		expect(runtime.getRun(run.id)?.fixRounds).toBe(2);
		expect(runtime.listRunDecisionEvents(run.id).find((event) => event.kind === 'run.cycle-question')?.payload)
			.toMatchObject({ origin: 'full-verify' });
		expect(runtime.getRunEvaluation(run.id)).toMatchObject({ attentionRequests: 0, operatorInterventions: 0 });
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
