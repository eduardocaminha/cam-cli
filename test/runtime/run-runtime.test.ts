import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { fingerprintSpec } from '../../src/issues/spec.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import { AgentCycleQuestionResolver } from '../../src/runtime/agent-cycle-question-resolver.ts';
import { AgentExecutorRouter } from '../../src/runtime/agent-executor-router.ts';
import { AgentReviewerRouter } from '../../src/runtime/agent-reviewer-router.ts';
import { type AgentSessionInput, ProviderCallError } from '../../src/runtime/agent-session.ts';
import { GitEvidenceChecker } from '../../src/runtime/git-runtime.ts';
import { OPERATOR_DECISION_LIMITS, selectOperatorDecisions } from '../../src/runtime/operator-decision.ts';
import { selectRunRoundOrigins } from '../../src/runtime/round-origin.ts';
import { RunRuntime, type RuntimeShipInput, type RuntimeTimer } from '../../src/runtime/run-runtime.ts';
import { nextFixRounds } from '../../src/runtime/run-state.ts';
import { type RunEvent, type RunRecord, RunStore } from '../../src/runtime/run-store.ts';
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
			workflowRevision: 'revision-1',
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
		expect(reopened.listEvents()[0]?.payload).toEqual({ workflowRevision: 'revision-1' });
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
		expect(nextFixRounds({ state: 'review', fixRounds: 1 }, 'working')).toBe(2);
		expect(nextFixRounds({ state: 'full-verify', fixRounds: 2 }, 'working')).toBe(3);
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

	test('hands the shipper durable workflow, review, full-verify and prior CI evidence', async () => {
		const store = new RunStore(':memory:');
		const shippedInputs: RuntimeShipInput[] = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			workflowRevision: 'revision-delivery',
			newId: () => 'run-delivery-evidence',
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => ({ verdict: 'clean' }) },
			fullVerifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async (input) => {
				shippedInputs.push(input);
				return { outcome: 'merged', prNumber: 685 };
			} },
		});

		const run = runtime.startRun('GSHIP-685');
		await waitFor(() => runtime.getRun(run.id)?.state === 'done');

		expect(shippedInputs[0]?.evidence).toEqual({
			workflowRevision: 'revision-delivery',
			review: 'passed',
			fullVerification: 'passed',
		});
		expect(shippedInputs[0]?.initialCiStatus).toBe('not-reported');
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

	test('rests on a provider usage limit and resumes the same session without releasing work', async () => {
		const calls: Array<{ sessionId: string; resume: boolean }> = [];
		const releases: string[] = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-provider-limit',
			newSessionId: () => 'session-provider-limit',
			// Before the hold's own retryAt: the automatic retry (GSHIP-711) is
			// armed for later, so this test keeps covering the manual resume.
			now: () => '2026-08-20T12:00:00.000Z',
			workspace: {
				prepare: () => '/workspaces/run-provider-limit',
				release: ({ runId }) => {
					releases.push(runId);
					return { outcome: 'released', branch: 'gship/gship-700-run-provider-limit' };
				},
			},
			executor: {
				execute: async (input) => {
					calls.push({ sessionId: input.sessionId, resume: input.resume });
					if (!input.resume) {
						throw new ProviderCallError(
							'claude',
							'usage-limit',
							'Claude usage limit reached.',
							{ retryAt: '2026-08-20T12:10:00.000Z' },
						);
					}
					return { outcome: 'completed', summary: 'continued safely' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('GSHIP-700');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(runtime.getRun(run.id)).toMatchObject({
			state: 'waiting-provider',
			error: null,
		});
		expect(releases).toEqual([]);
		expect(runtime.listRunEvents(run.id).at(-1)).toMatchObject({
			kind: 'run.provider-waiting',
			payload: {
				provider: 'claude',
				kind: 'usage-limit',
				message: 'Claude usage limit reached.',
				phase: 'working',
				retryAt: '2026-08-20T12:10:00.000Z',
			},
		});
		expect(runtime.getRunProviderWait(run.id)).toEqual({
			provider: 'claude',
			kind: 'usage-limit',
			message: 'Claude usage limit reached.',
			phase: 'working',
			retryAt: '2026-08-20T12:10:00.000Z',
		});
		expect(() => runtime.startRun('GSHIP-701')).toThrow('still waiting-provider');

		runtime.resumeRun(run.id);
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(runtime.getRunProviderWait(run.id)).toBeNull();
		expect(calls).toEqual([
			{ sessionId: 'session-provider-limit', resume: false },
			{ sessionId: 'session-provider-limit', resume: true },
		]);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toContain(
			'run.provider-retry-started',
		);
		await runtime.stop();
		runtime.close();
	});

	test('retries a fresh reviewer after provider recovery without rerunning the executor', async () => {
		let executions = 0;
		let reviews = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-review-provider-limit',
			executor: {
				execute: async () => {
					executions += 1;
					return { outcome: 'completed', summary: 'implemented' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: {
				review: async () => {
					reviews += 1;
					if (reviews === 1) {
						throw new ProviderCallError('codex', 'overloaded', 'Codex is overloaded.');
					}
					return { verdict: 'clean' };
				},
			},
		});

		const run = runtime.startRun('GSHIP-702');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(runtime.listRunEvents(run.id).at(-1)?.payload['phase']).toBe('review');

		runtime.resumeRun(run.id);
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(executions).toBe(1);
		expect(reviews).toBe(2);
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-709: the review fallback is wired through the real router, so the
	// run keeps its Claude provider, session and worktree while the verdict
	// comes from Codex.
	test('returns a Codex fallback finding to the original Claude executor', async () => {
		const executions: Array<{ providerId?: string; reviewFeedback?: string }> = [];
		let claudeReviews = 0;
		let codexReviews = 0;
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-review-fallback',
			newSessionId: () => 'session-review-fallback',
			executor: {
				execute: async (input) => {
					executions.push({
						...(input.providerId === undefined ? {} : { providerId: input.providerId }),
						...(input.reviewFeedback === undefined ? {} : { reviewFeedback: input.reviewFeedback }),
					});
					return { outcome: 'completed', summary: 'implemented' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: new AgentReviewerRouter({
				claude: {
					review: async () => {
						claudeReviews += 1;
						throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.');
					},
				},
				codex: {
					review: async () => {
						codexReviews += 1;
						return codexReviews === 1
							? { verdict: 'findings', detail: 'the fix misses a test' }
							: { verdict: 'clean' };
					},
				},
			}),
		});

		const run = runtime.startRun('GSHIP-709');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(claudeReviews).toBe(2);
		expect(codexReviews).toBe(2);
		expect(executions).toEqual([
			{ providerId: 'claude' },
			{ providerId: 'claude', reviewFeedback: 'the fix misses a test' },
		]);
		expect(runtime.getRun(run.id)).toMatchObject({
			providerId: 'claude',
			sessionId: 'session-review-fallback',
		});
		expect(runtime.getSelectedProvider()).toBe('claude');
		expect(runtime.listRunDecisionEvents(run.id)
			.filter((event) => event.kind === 'run.review-fallback')
			.map((event) => event.payload))
			.toEqual([
				{
					from: 'claude',
					to: 'codex',
					phase: 'review',
					reason: 'usage-limit',
					message: 'Claude usage limit reached.',
					outcome: 'findings',
				},
				{
					from: 'claude',
					to: 'codex',
					phase: 'review',
					reason: 'usage-limit',
					message: 'Claude usage limit reached.',
					outcome: 'clean',
				},
			]);
		expect(runtime.getRunEvaluation(run.id)?.roles)
			.toEqual([{ role: 'reviewer', models: [], efforts: [], providers: ['claude', 'codex'] }]);
		await runtime.stop();
		runtime.close();
	});

	test('keeps the Claude review hold when the Codex fallback is refused', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-review-fallback-refused',
			now: () => '2026-08-23T12:00:00.000Z',
			executor: { execute: async () => ({ outcome: 'completed', summary: 'implemented' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: new AgentReviewerRouter({
				claude: {
					review: async () => {
						throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
							retryAt: '2026-08-23T12:10:00.000Z',
						});
					},
				},
				codex: {
					review: async () => {
						throw new ProviderCallError('codex', 'auth-required', 'Codex is not authenticated.');
					},
				},
			}),
		});

		const run = runtime.startRun('GSHIP-709');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(runtime.getRunProviderWait(run.id)).toEqual({
			provider: 'claude',
			kind: 'usage-limit',
			message: 'Claude usage limit reached.',
			phase: 'review',
			retryAt: '2026-08-23T12:10:00.000Z',
		});
		expect(runtime.getProviderWait('codex')).toBeNull();
		expect(runtime.listRunDecisionEvents(run.id)
			.filter((event) => event.kind === 'run.review-fallback')
			.map((event) => event.payload['outcome']))
			.toEqual(['refused']);
		expect(runtime.getRun(run.id)?.providerId).toBe('claude');
		await runtime.stop();
		runtime.close();
	});

	test('persists operator guidance before resuming a waiting session', async () => {
		const inputs: Array<{ resume: boolean; operatorGuidance?: string }> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-guidance',
			executor: {
				execute: async (input) => {
					inputs.push({
						resume: input.resume,
						...(input.operatorGuidance === undefined
							? {}
							: { operatorGuidance: input.operatorGuidance }),
					});
					return input.resume
						? { outcome: 'completed', summary: 'decision applied' }
						: { outcome: 'waiting-user', summary: 'Choose the migration seam.' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = runtime.startRun('CAM-15');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(() => runtime.resumeRun(run.id)).toThrow('operator guidance is required');
		runtime.resumeRun(run.id, ' Use the smaller seam. ');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(inputs).toEqual([
			{ resume: false },
			{ resume: true, operatorGuidance: 'Use the smaller seam.' },
		]);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.waiting-user',
			'run.operator-guidance',
			'run.started',
			'run.work-completed',
			'run.verified',
		]);
		expect(runtime.listRunEvents(run.id)[3]?.payload).toEqual({ text: 'Use the smaller seam.' });
		await runtime.stop();
		runtime.close();
	});
});

const NO_CHANGE = () => ({ exitCode: 0, stdout: '', stderr: '' });

// GSHIP-722: transferring only the executor role between Claude and Codex on
// a subscription limit, opt-in, at most once per run, never ping-ponging back
// to the provider the run started on.
describe('executor handoff between providers (GSHIP-722)', () => {
	test('the opt-in is off by default and survives a service restart', () => {
		const dbPath = join(createTestTmpdir('gship-run-runtime-handoff-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		const runtime = new RunRuntime({ cwd: '/project', store });
		expect(runtime.getExecutorHandoffEnabled()).toBe(false);
		runtime.setExecutorHandoffEnabled(true);
		expect(runtime.getExecutorHandoffEnabled()).toBe(true);
		runtime.close();

		const reopened = new RunRuntime({ cwd: '/project', store: new RunStore(dbPath) });
		expect(reopened.getExecutorHandoffEnabled()).toBe(true);
		reopened.close();
	});

	test('never transfers the executor role while the operator has not opted in', async () => {
		let codexCalls = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-handoff-disabled',
			executor: new AgentExecutorRouter({
				executors: {
					claude: {
						execute: async () => {
							throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.');
						},
					},
					codex: { execute: async () => { codexCalls += 1; return { outcome: 'completed' }; } },
				},
				runGit: NO_CHANGE,
			}),
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('GSHIP-722');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(codexCalls).toBe(0);
		expect(runtime.getRunExecutorHandoff(run.id)).toBeNull();
		expect(runtime.getRunProviderWait(run.id)?.provider).toBe('claude');
		await runtime.stop();
		runtime.close();
	});

	test('transfers to Codex on a Claude usage limit, once, and keeps continuing there', async () => {
		const executions: Array<{ providerId?: string; sessionId: string; resume: boolean }> = [];
		let claudeCalls = 0;
		let codexCalls = 0;
		let claudeReviews = 0;
		let codexReviews = 0;
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-handoff',
			newSessionId: () => 'session-origin',
			executor: new AgentExecutorRouter({
				executors: {
					claude: {
						execute: async (input) => {
							claudeCalls += 1;
							executions.push({ providerId: input.providerId, sessionId: input.sessionId, resume: input.resume });
							throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.');
						},
					},
					codex: {
						execute: async (input) => {
							codexCalls += 1;
							executions.push({ providerId: input.providerId, sessionId: input.sessionId, resume: input.resume });
							return { outcome: 'completed', summary: `codex round ${codexCalls}` };
						},
					},
				},
				newSessionId: () => 'session-alt',
				runGit: NO_CHANGE,
			}),
			verifier: { verify: async () => ({ ok: true }) },
			// The review fallback router, not a bare mock: only the executor role
			// may transfer (GSHIP-722), so the review after the executor's own
			// handoff must still route by the run's own origin provider, never by
			// wherever the executor now sits.
			reviewer: new AgentReviewerRouter({
				claude: {
					review: async () => {
						claudeReviews += 1;
						return claudeReviews === 1 ? { verdict: 'findings', detail: 'missing a test' } : { verdict: 'clean' };
					},
				},
				codex: { review: async () => { codexReviews += 1; return { verdict: 'clean' }; } },
			}),
		});

		runtime.setExecutorHandoffEnabled(true);
		const run = runtime.startRun('GSHIP-722');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(claudeCalls).toBe(1);
		expect(codexCalls).toBe(2);
		// Every review ran on Claude, the run's own origin -- the executor
		// handoff to Codex never routed the reviewer role along with it.
		expect(claudeReviews).toBe(2);
		expect(codexReviews).toBe(0);
		expect(executions).toEqual([
			{ providerId: 'claude', sessionId: 'session-origin', resume: false },
			{ providerId: 'codex', sessionId: 'session-alt', resume: false },
			{ providerId: 'codex', sessionId: 'session-alt', resume: true },
		]);
		// The origin's own historical provider and session stay exactly as
		// the run started with: the handoff never overwrites them.
		expect(runtime.getRun(run.id)).toMatchObject({ providerId: 'claude', sessionId: 'session-origin' });
		expect(runtime.getRunExecutorHandoff(run.id)).toMatchObject({
			from: 'claude',
			to: 'codex',
			reason: 'usage-limit',
			sessionId: 'session-alt',
			outcome: 'completed',
		});
		expect(runtime.listRunDecisionEvents(run.id).filter((event) => event.kind === 'run.executor-handoff'))
			.toHaveLength(1);
		expect(runtime.getRunEvaluation(run.id)?.roles).toContainEqual({
			role: 'executor',
			models: [],
			efforts: [],
			providers: ['claude', 'codex'],
		});
		// No review fallback ever fired -- Codex never reviewed, so the
		// reviewer role carries no configuration to report at all, rather than
		// a Codex entry the executor handoff would have caused wrongly.
		expect(runtime.getRunEvaluation(run.id)?.roles.map((role) => role.role)).not.toContain('reviewer');
		await runtime.stop();
		runtime.close();
	});

	test('keeps the Claude executor hold when the Codex handoff is refused, and never retries the handoff', async () => {
		let claudeCalls = 0;
		let codexCalls = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-handoff-refused',
			now: () => '2026-08-23T12:00:00.000Z',
			executor: new AgentExecutorRouter({
				executors: {
					claude: {
						execute: async () => {
							claudeCalls += 1;
							if (claudeCalls === 1) {
								throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
									retryAt: '2026-08-23T12:10:00.000Z',
								});
							}
							return { outcome: 'completed', summary: 'recovered on Claude' };
						},
					},
					codex: {
						execute: async () => {
							codexCalls += 1;
							throw new ProviderCallError('codex', 'auth-required', 'Codex is not authenticated.');
						},
					},
				},
				runGit: NO_CHANGE,
			}),
			verifier: { verify: async () => ({ ok: true }) },
		});

		runtime.setExecutorHandoffEnabled(true);
		const run = runtime.startRun('GSHIP-722');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(runtime.getRunProviderWait(run.id)).toEqual({
			provider: 'claude',
			kind: 'usage-limit',
			message: 'Claude usage limit reached.',
			phase: 'working',
			retryAt: '2026-08-23T12:10:00.000Z',
		});
		expect(runtime.getRunExecutorHandoff(run.id)).toMatchObject({ from: 'claude', to: 'codex', outcome: 'refused' });
		expect(runtime.getRun(run.id)?.providerId).toBe('claude');

		// No ping-pong: once the one handoff was spent -- refused or not -- a
		// later Claude failure never offers Codex a second time; the run only
		// ever waits on the provider it started with.
		runtime.resumeRun(run.id);
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(claudeCalls).toBe(2);
		expect(codexCalls).toBe(1);
		expect(runtime.listRunDecisionEvents(run.id).filter((event) => event.kind === 'run.executor-handoff'))
			.toHaveLength(1);
		await runtime.stop();
		runtime.close();
	});
});

// GSHIP-711: the run's own retomada automatica after a provider hold whose
// retryAt has arrived, owned by this runtime and by nothing else. Every test
// below drives an injected clock and an injected one-shot timer, so the
// schedule is exercised without any wall-clock waiting.
describe('automatic resume after the provider retry instant', () => {
	function createFakeTimer() {
		let armed: { handle: number; delayMs: number; callback: () => void } | null = null;
		let nextHandle = 1;
		let clears = 0;
		const timer: RuntimeTimer = {
			set: (callback, delayMs) => {
				const handle = nextHandle;
				nextHandle += 1;
				armed = { handle, delayMs, callback };
				return handle;
			},
			clear: (handle) => {
				clears += 1;
				if (armed?.handle === handle) armed = null;
			},
		};
		return {
			timer,
			delay: () => armed?.delayMs ?? null,
			clears: () => clears,
			/** The armed callback itself, kept to replay a retry the runtime cancelled. */
			callback: () => {
				const current = armed;
				if (current === null) throw new Error('no automatic retry is armed');
				return current.callback;
			},
			fire: () => {
				const current = armed;
				if (current === null) throw new Error('no automatic retry is armed');
				armed = null;
				current.callback();
			},
		};
	}

	test('waits for the hold instant, then resumes the same work exactly once', async () => {
		const calls: Array<{
			resume: boolean;
			sessionId: string;
			cwd: string;
			providerId?: string;
			operatorGuidance?: string;
		}> = [];
		const fake = createFakeTimer();
		let clock = '2026-08-23T00:40:00.000Z';
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-auto-retry',
			newSessionId: () => 'session-auto-retry',
			now: () => clock,
			timer: fake.timer,
			workspace: { prepare: () => '/workspaces/run-auto-retry' },
			executor: {
				execute: async (input) => {
					calls.push({
						resume: input.resume,
						sessionId: input.sessionId,
						cwd: input.cwd,
						...(input.providerId === undefined ? {} : { providerId: input.providerId }),
						...(input.operatorGuidance === undefined
							? {}
							: { operatorGuidance: input.operatorGuidance }),
					});
					if (!input.resume) {
						throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
							retryAt: '2026-08-23T00:50:00.000Z',
						});
					}
					return { outcome: 'completed', summary: 'retomado' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('GSHIP-708');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		// Ten minutes out, and nothing fires before it: the run is still resting.
		expect(fake.delay()).toBe(600_000);
		expect(calls).toHaveLength(1);
		expect(runtime.getRun(run.id)?.state).toBe('waiting-provider');

		clock = '2026-08-23T00:50:00.000Z';
		fake.fire();
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(calls).toEqual([
			{
				resume: false,
				sessionId: 'session-auto-retry',
				cwd: '/workspaces/run-auto-retry',
				providerId: 'claude',
			},
			{
				resume: true,
				sessionId: 'session-auto-retry',
				cwd: '/workspaces/run-auto-retry',
				providerId: 'claude',
			},
		]);
		expect(fake.delay()).toBeNull();

		const waitEvent = runtime.listRunDecisionEvents(run.id)
			.find((event) => event.kind === 'run.provider-waiting');
		const automatic = runtime.listRunDecisionEvents(run.id)
			.find((event) => event.kind === 'run.provider-retry-automatic');
		expect(automatic?.payload).toEqual({
			source: 'automatic',
			waitSeq: waitEvent?.seq,
			retryAt: '2026-08-23T00:50:00.000Z',
		});
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toContain(
			'run.provider-retry-started',
		);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).not.toContain(
			'run.operator-guidance',
		);
		// The whole point of the automatic path: the run's evaluation still
		// reports no human in the loop.
		expect(runtime.getRunEvaluation(run.id)).toMatchObject({
			attentionRequests: 0,
			operatorInterventions: 0,
			providerHolds: 1,
		});

		await runtime.stop();
		runtime.close();
	});

	test('takes a retry that came due while the process was down, at the first tick', async () => {
		const store = new RunStore(':memory:');
		const resumes: boolean[] = [];
		const executor = {
			execute: async (input: { resume: boolean }) => {
				resumes.push(input.resume);
				if (!input.resume) {
					throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
						retryAt: '2026-08-23T00:50:00.000Z',
					});
				}
				return { outcome: 'completed' as const, summary: 'retomado apos reinicio' };
			},
		};
		const verifier = { verify: async () => ({ ok: true }) };
		const before = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-auto-retry-restart',
			now: () => '2026-08-23T00:40:00.000Z',
			timer: createFakeTimer().timer,
			executor,
			verifier,
		});
		const run = before.startRun('GSHIP-708');
		await waitFor(() => before.getRun(run.id)?.state === 'waiting-provider');
		await before.stop();

		const fake = createFakeTimer();
		const after = new RunRuntime({
			cwd: '/project',
			store,
			now: () => '2026-08-23T01:06:55.000Z',
			timer: fake.timer,
			executor,
			verifier,
		});
		// Already overdue at startup: armed for the very next tick, not skipped.
		expect(fake.delay()).toBe(0);
		expect(after.getRun(run.id)?.state).toBe('waiting-provider');

		fake.fire();
		await waitFor(() => after.getRun(run.id)?.state === 'ready-to-ship');
		expect(resumes).toEqual([false, true]);

		await after.stop();
		after.close();
	});

	test('resumes a hold taken during review at review, without re-running the executor', async () => {
		let executions = 0;
		let reviews = 0;
		const fake = createFakeTimer();
		let clock = '2026-08-23T00:40:00.000Z';
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-auto-retry-review',
			now: () => clock,
			timer: fake.timer,
			executor: {
				execute: async () => {
					executions += 1;
					return { outcome: 'completed', summary: 'implementado' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: {
				review: async () => {
					reviews += 1;
					if (reviews === 1) {
						throw new ProviderCallError('codex', 'overloaded', 'Codex is overloaded.', {
							retryAt: '2026-08-23T00:50:00.000Z',
						});
					}
					return { verdict: 'clean' };
				},
			},
		});

		const run = runtime.startRun('GSHIP-709');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(runtime.getRunProviderWait(run.id)).toMatchObject({ phase: 'review' });

		clock = '2026-08-23T00:50:00.000Z';
		fake.fire();
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(executions).toBe(1);
		expect(reviews).toBe(2);

		await runtime.stop();
		runtime.close();
	});

	test('lets a manual resume win the run, leaving the armed retry with nothing to do', async () => {
		let executions = 0;
		const fake = createFakeTimer();
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-auto-retry-race',
			now: () => '2026-08-23T00:40:00.000Z',
			timer: fake.timer,
			executor: {
				execute: async (input) => {
					executions += 1;
					if (!input.resume) {
						throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
							retryAt: '2026-08-23T00:50:00.000Z',
						});
					}
					await Bun.sleep(20);
					return { outcome: 'completed', summary: 'retomado pelo operador' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('GSHIP-710');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		const stale = fake.callback();

		runtime.resumeRun(run.id, undefined, 'operator');
		// The manual resume owns the run, so the armed retry is dropped -- and
		// replaying it anyway resumes nothing a second time.
		expect(fake.delay()).toBeNull();
		stale();
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(executions).toBe(2);
		expect(runtime.listRunDecisionEvents(run.id).map((event) => event.kind)).not.toContain(
			'run.provider-retry-automatic',
		);

		await runtime.stop();
		runtime.close();
	});

	test('reschedules the retry when a new refusal carries a later instant', async () => {
		const fake = createFakeTimer();
		let clock = '2026-08-23T00:40:00.000Z';
		let attempts = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-auto-retry-again',
			now: () => clock,
			timer: fake.timer,
			executor: {
				execute: async () => {
					attempts += 1;
					if (attempts <= 2) {
						throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
							retryAt: attempts === 1 ? '2026-08-23T00:50:00.000Z' : '2026-08-23T01:10:00.000Z',
						});
					}
					return { outcome: 'completed', summary: 'retomado no segundo hold' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('GSHIP-711');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(fake.delay()).toBe(600_000);

		clock = '2026-08-23T00:50:00.000Z';
		fake.fire();
		// The second refusal is its own hold, with its own instant twenty
		// minutes out -- armed again, never taken early.
		await waitFor(() => fake.delay() === 1_200_000);
		expect(attempts).toBe(2);
		expect(runtime.getRun(run.id)?.state).toBe('waiting-provider');

		clock = '2026-08-23T01:10:00.000Z';
		fake.fire();
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(attempts).toBe(3);
		expect(
			runtime.listRunDecisionEvents(run.id)
				.filter((event) => event.kind === 'run.provider-retry-automatic'),
		).toHaveLength(2);

		await runtime.stop();
		runtime.close();
	});

	test('spends at most one automatic retry per hold instant', async () => {
		const fake = createFakeTimer();
		let clock = '2026-08-23T00:40:00.000Z';
		let attempts = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-auto-retry-once',
			now: () => clock,
			timer: fake.timer,
			executor: {
				execute: async () => {
					attempts += 1;
					// The same instant on every refusal: an already spent retry.
					throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
						retryAt: '2026-08-23T00:50:00.000Z',
					});
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('GSHIP-711');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		clock = '2026-08-23T00:50:00.000Z';
		fake.fire();
		await waitFor(() => attempts === 2);
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');

		expect(fake.delay()).toBeNull();
		expect(attempts).toBe(2);
		expect(runtime.getRun(run.id)?.state).toBe('waiting-provider');

		await runtime.stop();
		runtime.close();
	});

	test('keeps waiting when the hold carries no usable retryAt', async () => {
		const holds: Array<{ retryAt?: string }> = [{}, { retryAt: 'em breve' }];
		for (const [index, hold] of holds.entries()) {
			const fake = createFakeTimer();
			const runtime = new RunRuntime({
				cwd: '/project',
				store: new RunStore(':memory:'),
				newId: () => `run-auto-retry-unusable-${index}`,
				now: () => '2026-08-23T00:40:00.000Z',
				timer: fake.timer,
				executor: {
					execute: async () => {
						throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', hold);
					},
				},
				verifier: { verify: async () => ({ ok: true }) },
			});
			const run = runtime.startRun('GSHIP-712');
			await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
			expect(fake.delay()).toBeNull();
			expect(runtime.getRun(run.id)?.state).toBe('waiting-provider');
			await runtime.stop();
			runtime.close();
		}
	});

	test('stops the scheduler with the runtime', async () => {
		const fake = createFakeTimer();
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-auto-retry-stop',
			now: () => '2026-08-23T00:40:00.000Z',
			timer: fake.timer,
			executor: {
				execute: async () => {
					throw new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
						retryAt: '2026-08-23T00:50:00.000Z',
					});
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('GSHIP-713');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(fake.delay()).toBe(600_000);

		await runtime.stop();
		expect(fake.delay()).toBeNull();
		expect(fake.clears()).toBeGreaterThan(0);
		expect(runtime.getRun(run.id)?.state).toBe('waiting-provider');
		runtime.close();
	});
});

// GSHIP-629: the spec's executable premise, checked against the run's own
// workspace and before the executor is ever invoked. Skipped once a durable
// `run.evidence-checked` decision event already exists for the run -- never
// decided by whether the current pass is a resume, so an interruption while
// the check itself was running is re-checked on resume instead of releasing
// the run on a premise nothing ever verified.
describe('evidence check gates the executor', () => {
	test('matching evidence lets the run proceed to the executor and records a durable decision event', async () => {
		const store = new RunStore(':memory:');
		let executorCalled = false;
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-evidence-ok',
			workspace: { prepare: ({ runId }) => `/workspaces/${runId}` },
			evidenceCheck: { check: async () => ({ ok: true }) },
			executor: {
				execute: async () => {
					executorCalled = true;
					return { outcome: 'completed' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('CAM-40');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(executorCalled).toBe(true);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.evidence-checked',
			'run.work-completed',
			'run.verified',
		]);
		await runtime.stop();
		runtime.close();
	});

	test('diverging evidence ends the run before the executor is ever invoked', async () => {
		const store = new RunStore(':memory:');
		let executorCalled = false;
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-evidence-diverged',
			workspace: { prepare: ({ runId }) => `/workspaces/${runId}` },
			evidenceCheck: {
				check: async () => ({
					ok: false,
					detail: 'evidence diverged for `wc -l file`: recorded `3 file` but observed `5 file`',
				}),
			},
			executor: {
				execute: async () => {
					executorCalled = true;
					return { outcome: 'completed' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('CAM-41');
		await waitFor(() => runtime.getRun(run.id)?.state === 'failed');

		expect(executorCalled).toBe(false);
		expect(runtime.getRun(run.id)).toMatchObject({
			state: 'failed',
			error: 'evidence diverged for `wc -l file`: recorded `3 file` but observed `5 file`',
		});
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.evidence-diverged',
			'run.chain-paused',
		]);
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-621: a run that fails releases its own workspace and branch once
	// the branch carries no commit missing from the base ref. Divergence fails
	// the run before the executor ever touches the workspace, so the branch is
	// exactly what `workspace.prepare` cut it as -- clean, with no commit of
	// its own -- and the same release rule that already applies to every other
	// failed run must apply here too, so a repeated divergent attempt never
	// accumulates a leftover worktree or branch.
	test('a run failed by evidence divergence releases its clean workspace and branch (GSHIP-621)', async () => {
		const releaseCalls: Array<{ runId: string; requireUpstream?: boolean }> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-evidence-diverged-clean',
			workspace: {
				prepare: ({ runId }) => `/workspaces/${runId}`,
				release: ({ runId, requireUpstream }) => {
					releaseCalls.push({ runId, requireUpstream });
					return { outcome: 'released', branch: 'gship/cam-44-run-evidence-diverged-clean' };
				},
			},
			evidenceCheck: {
				check: async () => ({
					ok: false,
					detail: "the run ended because the spec's evidence diverged from the repository:"
						+ ' command `wc -l file` recorded `3 file` but the current repository observed `5 file`',
				}),
			},
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('CAM-44');
		await waitFor(() => runtime.getRun(run.id)?.state === 'failed');

		expect(releaseCalls).toEqual([{ runId: 'run-evidence-diverged-clean', requireUpstream: true }]);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.evidence-diverged',
			'run.chain-paused',
			'workspace.released',
		]);
		await runtime.stop();
		runtime.close();
	});

	// The reason is what the operator reads: with no separate label
	// distinguishing an evidence mismatch from an implementation bug, the text
	// itself has to say, in full words, that the run ended because the spec's
	// evidence diverged -- and still carry the command, the recorded output
	// and the current output, exactly like the ephemeral-worktree design did
	// before it moved into the run's own workspace.
	test('the reported reason names the spec evidence divergence explicitly, with command and both outputs', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-evidence-reason',
			workspace: { prepare: ({ runId }) => `/workspaces/${runId}` },
			evidenceCheck: new GitEvidenceChecker({
				loadIssueFromWorkspace: () => JSON.stringify({
					spec: {
						scope: 'Outcome backed by evidence.',
						verify: ['bun test'],
						evidence: [{ command: 'wc -l file.txt', output: '3 file.txt' }],
					},
				}),
				runCommand: async () => ({ exitCode: 0, stdout: '5 file.txt\n', stderr: '' }),
			}),
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('CAM-45');
		await waitFor(() => runtime.getRun(run.id)?.state === 'failed');

		const reason = runtime.getRun(run.id)?.error ?? '';
		expect(reason).toContain("the run ended because the spec's evidence diverged");
		expect(reason).toContain('wc -l file.txt');
		expect(reason).toContain('3 file.txt');
		expect(reason).toContain('5 file.txt');
		await runtime.stop();
		runtime.close();
	});

	// The check already succeeded once (`run.evidence-checked` is on the
	// event log by the time the run reaches waiting-user), so resuming must
	// not repeat it.
	test('a resumed run does not re-check evidence once the durable event exists', async () => {
		const store = new RunStore(':memory:');
		let checkCalls = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-evidence-resume',
			workspace: { prepare: ({ runId }) => `/workspaces/${runId}` },
			evidenceCheck: {
				check: async () => {
					checkCalls += 1;
					return { ok: true };
				},
			},
			executor: {
				execute: async (input) => input.resume
					? { outcome: 'completed', summary: 'decision applied' }
					: { outcome: 'waiting-user', summary: 'Pick a seam.' },
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('CAM-42');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');
		expect(checkCalls).toBe(1);
		expect(runtime.listRunEvents(run.id).filter((event) => event.kind === 'run.evidence-checked'))
			.toHaveLength(1);

		runtime.resumeRun(run.id, 'Use the smaller seam.');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(checkCalls).toBe(1);

		await runtime.stop();
		runtime.close();
	});

	// An interruption while the check itself is running never reaches the
	// point where it would emit `run.evidence-checked`, so the event the skip
	// is gated on does not exist -- resuming must check again rather than
	// trust a premise nothing ever actually verified.
	test('an interruption during the check itself is re-checked on resume', async () => {
		const store = new RunStore(':memory:');
		let checkCalls = 0;
		let markCheckStarted = (): void => {};
		const checkStarted = new Promise<void>((resolve) => {
			markCheckStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-evidence-interrupted',
			workspace: { prepare: ({ runId }) => `/workspaces/${runId}` },
			evidenceCheck: {
				check: (input) => {
					checkCalls += 1;
					if (checkCalls === 1) {
						return new Promise((_resolve, reject) => {
							markCheckStarted();
							input.signal.addEventListener(
								'abort',
								() => reject(new DOMException('cancelled', 'AbortError')),
								{ once: true },
							);
						});
					}
					return Promise.resolve({ ok: true });
				},
			},
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('CAM-43');
		await checkStarted;
		const cancelled = await runtime.cancelRun(run.id);
		expect(cancelled?.state).toBe('interrupted');
		expect(checkCalls).toBe(1);
		expect(runtime.listRunEvents(run.id).some((event) => event.kind === 'run.evidence-checked'))
			.toBe(false);

		runtime.resumeRun(run.id);
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(checkCalls).toBe(2);

		await runtime.stop();
		runtime.close();
	});
});

// GSHIP-612: work discovered outside the issue is kept as evidence, and keeps
// the run it came from exactly as it would have been without it.
describe('capturing proposals derived from a run', () => {
	test('persists an accepted completed result without touching the run', async () => {
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-proposals',
			newSessionId: () => 'session-proposals',
			now: () => '2026-08-16T23:00:00.000Z',
			executor: {
				execute: async () => ({
					outcome: 'completed',
					summary: 'Fechou o escopo do issue.',
					proposals: [
						{ title: 'Extrair o parser de eventos', evidence: 'Duplicado em dois adaptadores.' },
						{ title: 'Cobrir o retry do shipper', evidence: 'Sem teste para a segunda tentativa.' },
					],
				}),
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = runtime.startRun('CAM-40');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(store.listProposals()).toEqual([
			{
				id: 'run-proposals-proposal-1',
				relationship: 'derived-from',
				status: 'pending',
				promotedIssueId: null,
				sourceRunId: 'run-proposals',
				sourceIssueId: 'CAM-40',
				title: 'Extrair o parser de eventos',
				evidence: 'Duplicado em dois adaptadores.',
				createdAt: '2026-08-16T23:00:00.000Z',
				updatedAt: '2026-08-16T23:00:00.000Z',
			},
			{
				id: 'run-proposals-proposal-2',
				relationship: 'derived-from',
				status: 'pending',
				promotedIssueId: null,
				sourceRunId: 'run-proposals',
				sourceIssueId: 'CAM-40',
				title: 'Cobrir o retry do shipper',
				evidence: 'Sem teste para a segunda tentativa.',
				createdAt: '2026-08-16T23:00:00.000Z',
				updatedAt: '2026-08-16T23:00:00.000Z',
			},
		]);
		// The capture is recorded next to the work, and moves nothing.
		expect(runtime.getRun(run.id)).toMatchObject({
			state: 'ready-to-ship',
			fixRounds: 0,
			summary: 'Fechou o escopo do issue.',
		});
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.proposals-captured',
			'run.verified',
		]);
		expect(runtime.listRunEvents(run.id)[3]?.payload).toEqual({
			proposalIds: ['run-proposals-proposal-1', 'run-proposals-proposal-2'],
		});
		await runtime.stop();
		runtime.close();
	});

	test('records a failed capture and still ships the verified work', async () => {
		const store = new RunStore(':memory:');
		store.recordProposals = () => {
			throw new Error('proposal store unavailable');
		};
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-capture-failed',
			executor: {
				execute: async () => ({
					outcome: 'completed',
					proposals: [{ title: 'Ideia perdida', evidence: 'Evidência.' }],
				}),
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = runtime.startRun('CAM-41');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(runtime.listRunEvents(run.id).at(-2)).toMatchObject({
			kind: 'run.proposals-failed',
			payload: { error: 'proposal store unavailable' },
		});
		await runtime.stop();
		runtime.close();
	});

	test('a run that reports no idea writes nothing and emits no capture', async () => {
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-no-proposals',
			executor: { execute: async () => ({ outcome: 'completed', proposals: [] }) },
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = runtime.startRun('CAM-42');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(store.listProposals()).toEqual([]);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).not.toContain(
			'run.proposals-captured',
		);
		await runtime.stop();
		runtime.close();
	});
});

// GSHIP-611: an interrupted run the operator does not want to resume is ended
// here instead of being carried by the provider session forever.
describe('abandoning an interrupted run', () => {
	test('settles as cancelled, releases its own workspace and unblocks the next issue', async () => {
		const executions: string[] = [];
		const released: string[] = [];
		let ids = 0;
		let markStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => `run-${(ids += 1)}`,
			workspace: {
				prepare: ({ runId }) => `/workspaces/${runId}`,
				release: ({ runId }) => {
					released.push(runId);
					return { outcome: 'released', branch: `gship/cam-20-${runId}` };
				},
			},
			executor: {
				execute: (input) => {
					executions.push(input.runId);
					if (input.runId !== 'run-1') return Promise.resolve({ outcome: 'completed' });
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
		const run = runtime.startRun('CAM-20');
		await started;
		await runtime.cancelRun(run.id);
		expect(runtime.getRun(run.id)?.state).toBe('interrupted');
		// While it is only interrupted it still owns the runtime.
		expect(() => runtime.startRun('CAM-21')).toThrow('is still interrupted');

		const abandoned = runtime.abandonRun(run.id);

		expect(abandoned.state).toBe('cancelled');
		expect(runtime.getRun(run.id)?.state).toBe('cancelled');
		// The provider session is never reopened: abandoning is not resuming.
		expect(executions).toEqual(['run-1']);
		expect(released).toEqual(['run-1']);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.interrupted',
			'run.abandoned',
			'run.chain-paused',
			'workspace.released',
		]);

		const next = runtime.startRun('CAM-21');
		await waitFor(() => runtime.getRun(next.id)?.state === 'ready-to-ship');
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-658: the missing-from-base gate previously only guarded the failed
	// path; an abandoned run now requires it too, so a branch that already
	// carries a commit no other copy has is never force-deleted along with its
	// only remote copy.
	test('abandons a run whose branch has no commit missing from the base ref, requiring the same upstream check as a failed run', async () => {
		const releaseCalls: Array<{ runId: string; requireUpstream?: boolean }> = [];
		let markStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-abandon-clean',
			workspace: {
				prepare: ({ runId }) => `/workspaces/${runId}`,
				release: ({ runId, requireUpstream }) => {
					releaseCalls.push({ runId, requireUpstream });
					return { outcome: 'released', branch: 'gship/cam-33-run-abandon-clean' };
				},
			},
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
		const run = runtime.startRun('CAM-33');
		await started;
		await runtime.cancelRun(run.id);

		runtime.abandonRun(run.id);

		expect(releaseCalls).toEqual([{ runId: 'run-abandon-clean', requireUpstream: true }]);
		await runtime.stop();
		runtime.close();
	});

	test('preserves and signals an abandoned run workspace whose branch is ahead of the base ref', async () => {
		let markStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-abandon-ahead',
			workspace: {
				prepare: ({ runId }) => `/workspaces/${runId}`,
				release: () => ({
					outcome: 'preserved',
					branch: 'gship/cam-34-run-abandon-ahead',
					detail: 'branch has a commit missing from origin/main',
				}),
				inspect: (runs) => runs.map((reference) => ({
					kind: 'cleanup-failed',
					runId: reference.runId,
					workspacePath: reference.workspacePath,
					branch: null,
					detail: `state ${reference.state}`,
				})),
			},
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
		const run = runtime.startRun('CAM-34');
		await started;
		await runtime.cancelRun(run.id);

		runtime.abandonRun(run.id);

		expect(runtime.listRunEvents(run.id).at(-1)).toMatchObject({
			kind: 'workspace.cleanup-warning',
			payload: { detail: 'branch has a commit missing from origin/main' },
		});
		expect(runtime.listWorkspaceNotices()).toEqual([{
			kind: 'cleanup-failed',
			runId: 'run-abandon-ahead',
			workspacePath: '/workspaces/run-abandon-ahead',
			branch: null,
			detail: 'state cancelled',
		}]);
		// The preserved leftover never reopens the run: cancelled stays terminal.
		expect(runtime.getRun(run.id)?.state).toBe('cancelled');
		await runtime.stop();
		runtime.close();
	});

	test('preserves and signals a dirty workspace instead of forcing it away', async () => {
		let markStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-dirty',
			workspace: {
				prepare: () => '/workspaces/run-dirty',
				release: () => ({
					outcome: 'preserved',
					branch: 'gship/cam-22-run-dirt',
					detail: 'workspace has local changes',
				}),
				inspect: (runs) => runs.map((reference) => ({
					kind: 'dirty',
					runId: reference.runId,
					workspacePath: reference.workspacePath,
					branch: null,
					detail: `state ${reference.state}`,
				})),
			},
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
		const run = runtime.startRun('CAM-22');
		await started;
		await runtime.cancelRun(run.id);

		runtime.abandonRun(run.id);

		expect(runtime.getRun(run.id)?.state).toBe('cancelled');
		expect(runtime.listRunEvents(run.id).at(-1)).toMatchObject({
			kind: 'workspace.cleanup-warning',
			payload: { detail: 'workspace has local changes' },
		});
		// The preserved leftover is reported as belonging to a settled run.
		expect(runtime.listWorkspaceNotices()).toEqual([{
			kind: 'dirty',
			runId: 'run-dirty',
			workspacePath: '/workspaces/run-dirty',
			branch: null,
			detail: 'state cancelled',
		}]);
		await runtime.stop();
		runtime.close();
	});

	test('refuses every state that is not interrupted', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-waiting',
			executor: {
				execute: async () => ({ outcome: 'waiting-user', summary: 'Which seam?' }),
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = runtime.startRun('CAM-23');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(() => runtime.abandonRun(run.id)).toThrow('cannot be abandoned from state waiting-user');
		expect(() => runtime.abandonRun('missing')).toThrow('run not found: missing');

		await runtime.cancelRun(run.id);
		runtime.abandonRun(run.id);
		// Terminal means terminal: the action does not admit a second call.
		expect(() => runtime.abandonRun(run.id)).toThrow('cannot be abandoned from state cancelled');
		await runtime.stop();
		runtime.close();
	});
});

// GSHIP-621: a run that ends in failed releases its own clean workspace and
// branch too, with one more gate the merged path does not need -- the branch
// must also carry no commit missing from the base ref, so a commit made just
// before the failure stays available for the operator to inspect. failed
// itself stays terminal: release never reopens it.
describe('releasing a failed run workspace', () => {
	test('releases a clean workspace whose branch has no commit missing from the base ref', async () => {
		const releaseCalls: Array<{ runId: string; requireUpstream?: boolean }> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-failed-clean',
			workspace: {
				prepare: ({ runId }) => `/workspaces/${runId}`,
				release: ({ runId, requireUpstream }) => {
					releaseCalls.push({ runId, requireUpstream });
					return { outcome: 'released', branch: 'gship/cam-30-run-failed-clean' };
				},
			},
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: false, detail: 'lint failed' }) },
		});
		const run = runtime.startRun('CAM-30');
		await waitFor(() => runtime.getRun(run.id)?.state === 'failed');

		expect(releaseCalls).toEqual([{ runId: 'run-failed-clean', requireUpstream: true }]);
		expect(runtime.listRunEvents(run.id).map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.verification-failed',
			'run.chain-paused',
			'workspace.released',
		]);
		await runtime.stop();
		runtime.close();
	});

	test('preserves and signals a failed run workspace whose branch is ahead of the base ref', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-failed-ahead',
			workspace: {
				prepare: ({ runId }) => `/workspaces/${runId}`,
				release: () => ({
					outcome: 'preserved',
					branch: 'gship/cam-31-run-failed-ahead',
					detail: 'branch has a commit missing from origin/main',
				}),
				inspect: (runs) => runs.map((reference) => ({
					kind: 'failed-run',
					runId: reference.runId,
					workspacePath: reference.workspacePath,
					branch: null,
					detail: `state ${reference.state}`,
				})),
			},
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: false, detail: 'tests failed' }) },
		});
		const run = runtime.startRun('CAM-31');
		await waitFor(() => runtime.getRun(run.id)?.state === 'failed');

		expect(runtime.listRunEvents(run.id).at(-1)).toMatchObject({
			kind: 'workspace.cleanup-warning',
			payload: { detail: 'branch has a commit missing from origin/main' },
		});
		expect(runtime.listWorkspaceNotices()).toEqual([{
			kind: 'failed-run',
			runId: 'run-failed-ahead',
			workspacePath: '/workspaces/run-failed-ahead',
			branch: null,
			detail: 'state failed',
		}]);
		// The preserved leftover never reopens the run: failed stays terminal.
		expect(runtime.getRun(run.id)?.state).toBe('failed');
		await runtime.stop();
		runtime.close();
	});

	test('retries releasing a failed run left behind by a previous session', () => {
		const store = new RunStore(':memory:');
		store.createRun({
			id: 'run-failed-reconcile',
			issueId: 'CAM-32',
			sessionId: 'session-reconcile',
			workspacePath: '/workspaces/run-failed-reconcile',
			createdAt: '2026-08-17T10:00:00Z',
		});
		store.transition({
			runId: 'run-failed-reconcile',
			toState: 'working',
			kind: 'run.started',
			createdAt: '2026-08-17T10:00:01Z',
		});
		store.transition({
			runId: 'run-failed-reconcile',
			toState: 'failed',
			kind: 'run.failed',
			createdAt: '2026-08-17T10:00:02Z',
		});

		const releaseCalls: Array<{ runId: string; requireUpstream?: boolean }> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			now: () => '2026-08-17T10:01:00Z',
			workspace: {
				prepare: () => '/unused',
				release: ({ runId, requireUpstream }) => {
					releaseCalls.push({ runId, requireUpstream });
					return { outcome: 'released', branch: 'gship/cam-32-run-failed-reconcile' };
				},
			},
		});

		expect(releaseCalls).toEqual([{ runId: 'run-failed-reconcile', requireUpstream: true }]);
		expect(runtime.listRunEvents('run-failed-reconcile').at(-1)).toMatchObject({
			kind: 'workspace.released',
			payload: { reconciled: true },
		});
		// No lifecycle change: reconciliation only retries release, failed does
		// not admit any action.
		expect(runtime.getRun('run-failed-reconcile')?.state).toBe('failed');
		runtime.close();
	});

	// GSHIP-623: the run's total is every `.usage` event summed, including the
	// executor's fix round and the reviewer's own second pass over it.
	test('sums cost across the fix round and the reviewer, exposed by getRunCost', async () => {
		const store = new RunStore(':memory:');
		let attempt = 0;
		let reviewCall = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-cost',
			newSessionId: () => 'session-cost',
			executor: {
				execute: async ({ emit }) => {
					attempt += 1;
					emit('provider.usage', {
						model: 'opus',
						totalCostUsd: attempt === 1 ? 0.1 : 0.02,
						modelUsage: [{
							model: 'claude-opus-4-6',
							costUsd: attempt === 1 ? 0.1 : 0.02,
						}],
					});
					return { outcome: 'completed', summary: `pass ${attempt}` };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: {
				review: async ({ emit }) => {
					reviewCall += 1;
					emit('review.usage', {
						model: 'sonnet',
						totalCostUsd: 0.01,
						modelUsage: [{ model: 'claude-sonnet-4-6', costUsd: 0.01 }],
					});
					return reviewCall === 1
						? { verdict: 'findings', detail: '1. src/a.ts: fix this' }
						: { verdict: 'clean' };
				},
			},
		});

		const run = runtime.startRun('CAM-70');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(runtime.getRun(run.id)).toMatchObject({ fixRounds: 1 });
		expect(runtime.getRunCost(run.id)).toEqual({
			totalCostUsd: expect.closeTo(0.14, 6),
			breakdown: [
				{ role: 'executor', model: 'claude-opus-4-6', costUsd: expect.closeTo(0.12, 6) },
				{ role: 'reviewer', model: 'claude-sonnet-4-6', costUsd: expect.closeTo(0.02, 6) },
			],
			roles: [],
		});
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-659: the automatic review fix round the runtime drove above is the
	// executor's own, not a decision the operator made -- exposed by
	// getRunRoundOrigins from the same durable event log getRunCost reads.
	test('attributes the automatic review fix round to the executor, exposed by getRunRoundOrigins', async () => {
		const store = new RunStore(':memory:');
		let reviewCall = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-round-origins',
			newSessionId: () => 'session-round-origins',
			executor: {
				execute: async () => ({ outcome: 'completed' }),
			},
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: {
				review: async () => {
					reviewCall += 1;
					return reviewCall === 1
						? { verdict: 'findings', detail: '1. src/a.ts: fix this' }
						: { verdict: 'clean' };
				},
			},
		});

		const run = runtime.startRun('CAM-71');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(runtime.getRunRoundOrigins(run.id)).toEqual({ executor: 1, ci: 0, decision: 0, orchestrator: 0, indeterminate: 0 });
		await runtime.stop();
		runtime.close();
	});
});

// GSHIP-658: a remote branch delete that fails must not go silently unretried
// forever once the local worktree and branch are already gone -- reconcile
// only rediscovers a run through its own local state, and a fully-released
// run has none left to find. The failure is instead recorded durably and
// retried on every later call for the same run, e.g. the next service start.
describe('retrying a failed remote branch delete', () => {
	function seedDoneRun(store: RunStore, runId: string): void {
		store.createRun({
			id: runId,
			issueId: 'CAM-35',
			sessionId: `session-${runId}`,
			workspacePath: `/workspaces/${runId}`,
			createdAt: '2026-08-18T10:00:00Z',
		});
		for (const toState of ['working', 'verify', 'ready-to-ship', 'shipping', 'done'] as const) {
			store.transition({
				runId,
				toState,
				kind: `run.${toState}`,
				createdAt: '2026-08-18T10:00:01Z',
			});
		}
	}

	test('records a failed remote branch delete durably and retries it on the next reconciliation', () => {
		const store = new RunStore(':memory:');
		seedDoneRun(store, 'run-remote-pending');
		// Stands in for a previous session that released the run locally but
		// whose remote branch delete failed and got recorded durably.
		store.appendEvent({
			runId: 'run-remote-pending',
			kind: 'workspace.released',
			createdAt: '2026-08-18T10:00:02Z',
			payload: { branch: 'gship/cam-35-run-remote-pending', outcome: 'released', reconciled: false },
		});
		store.appendEvent({
			runId: 'run-remote-pending',
			kind: 'workspace.remote-delete-pending',
			createdAt: '2026-08-18T10:00:02Z',
			payload: { detail: 'cannot delete remote branch: exit 1' },
		});

		const releaseCalls: Array<{ runId: string; retryRemoteDelete?: boolean }> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			workspace: {
				prepare: () => '/unused',
				release: ({ runId, retryRemoteDelete }) => {
					releaseCalls.push({ runId, retryRemoteDelete });
					return { outcome: 'already-released', branch: 'gship/cam-35-run-remote-pending' };
				},
			},
		});

		expect(releaseCalls).toEqual([{ runId: 'run-remote-pending', retryRemoteDelete: true }]);
		expect(runtime.listRunEvents('run-remote-pending').at(-1)?.kind)
			.toBe('workspace.remote-delete-resolved');
		// Reconciliation never touches the run's own lifecycle state.
		expect(runtime.getRun('run-remote-pending')?.state).toBe('done');
		runtime.close();
	});

	test('never asks for a retry when a released run has no remote delete pending', () => {
		const store = new RunStore(':memory:');
		seedDoneRun(store, 'run-remote-clean');
		store.appendEvent({
			runId: 'run-remote-clean',
			kind: 'workspace.released',
			createdAt: '2026-08-18T10:00:02Z',
			payload: { branch: 'gship/cam-36-run-remote-clean', outcome: 'released', reconciled: false },
		});

		const releaseCalls: Array<{ runId: string; retryRemoteDelete?: boolean }> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			workspace: {
				prepare: () => '/unused',
				release: ({ runId, retryRemoteDelete }) => {
					releaseCalls.push({ runId, retryRemoteDelete });
					return { outcome: 'already-released', branch: 'gship/cam-36-run-remote-clean' };
				},
			},
		});

		expect(releaseCalls).toEqual([{ runId: 'run-remote-clean', retryRemoteDelete: undefined }]);
		runtime.close();
	});
});

// GSHIP-627: the executor declares activity at the emit call site; the
// runtime's own wrapper must thread that declaration through to the store
// instead of dropping it, and everything undeclared stays a decision.
describe('run event class', () => {
	test('threads the caller-declared class through to the store, defaulting the rest to decision', async () => {
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-event-class',
			newSessionId: () => 'session-event-class',
			executor: {
				execute: async ({ emit }) => {
					emit('provider.activity', { text: 'noise' }, 'activity');
					emit('run.operator-note', { text: 'kept' });
					return { outcome: 'completed', summary: 'Changed one seam.' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const started = runtime.startRun('CAM-80');
		await waitFor(() => runtime.getRun(started.id)?.state === 'ready-to-ship');

		const live = runtime.listRunEvents(started.id)
			.map((event) => ({ kind: event.kind, eventClass: event.eventClass }));
		expect(live).toContainEqual({ kind: 'provider.activity', eventClass: 'activity' });
		expect(live).toContainEqual({ kind: 'run.operator-note', eventClass: 'decision' });

		const decisionKinds = runtime.listRunDecisionEvents(started.id).map((event) => event.kind);
		expect(decisionKinds).not.toContain('provider.activity');
		expect(decisionKinds).toContain('run.operator-note');
		expect(decisionKinds).toContain('run.created');
		await runtime.stop();
		runtime.close();
	});
});

// GSHIP-630: the operator's already-made decisions carried into the review
// prompt, so a ratification is not re-litigated every round.
describe('selectOperatorDecisions', () => {
	function guidanceEvent(seq: number, text: string): RunEvent {
		return {
			seq,
			runId: 'run-1',
			kind: 'run.operator-guidance',
			fromState: 'waiting-user',
			toState: 'waiting-user',
			payload: { text },
			createdAt: `2026-08-18T10:${String(seq).padStart(2, '0')}:00Z`,
			eventClass: 'decision',
		};
	}

	test('keeps only run.operator-guidance events, in the order given', () => {
		const events: RunEvent[] = [
			guidanceEvent(1, 'First decision.'),
			{ ...guidanceEvent(2, 'noise'), kind: 'run.created' },
			guidanceEvent(3, 'Second decision.'),
		];
		expect(selectOperatorDecisions(events)).toEqual(['First decision.', 'Second decision.']);
	});

	test('drops the oldest decisions past the item limit, keeping the newest in order', () => {
		const total = OPERATOR_DECISION_LIMITS.maxItems + 2;
		const events = Array.from({ length: total }, (_, index) => guidanceEvent(index + 1, `decision ${index + 1}`));
		const selected = selectOperatorDecisions(events);
		expect(selected.length).toBe(OPERATOR_DECISION_LIMITS.maxItems);
		expect(selected[0]).toBe('decision 3');
		expect(selected.at(-1)).toBe(`decision ${total}`);
	});

	test('caps an individual decision at the text limit', () => {
		const long = 'x'.repeat(OPERATOR_DECISION_LIMITS.text + 50);
		expect(selectOperatorDecisions([guidanceEvent(1, long)])).toEqual([
			long.slice(0, OPERATOR_DECISION_LIMITS.text),
		]);
	});
});

// GSHIP-659: attributes each correction round to the executor's own automatic
// fix or to the consequence of an operator decision, straight from the run's
// own decision log -- never a guess when neither pattern matches.
describe('selectRunRoundOrigins', () => {
	function roundEvent(
		seq: number,
		kind: string,
		fromState: RunEvent['fromState'] = 'working',
	): RunEvent {
		return {
			seq,
			runId: 'run-1',
			kind,
			fromState,
			toState: 'working',
			payload: {},
			createdAt: `2026-08-19T10:${String(seq).padStart(2, '0')}:00Z`,
			eventClass: 'decision',
		};
	}

	test('a history with no round past the run\'s own launch reports zero of both', () => {
		const events = [
			roundEvent(1, 'run.created', null),
			roundEvent(2, 'run.started', 'queued'),
		];
		expect(selectRunRoundOrigins(events)).toEqual({ executor: 0, ci: 0, decision: 0, orchestrator: 0, indeterminate: 0 });
	});

	test('a round with no guidance -- born of a review or full-verify fix request -- counts as executor', () => {
		const events = [
			roundEvent(1, 'run.created', null),
			roundEvent(2, 'run.started', 'queued'),
			roundEvent(3, 'run.review-fix-requested', 'review'),
			roundEvent(4, 'run.full-verify-fix-requested', 'full-verify'),
		];
		expect(selectRunRoundOrigins(events)).toEqual({ executor: 2, ci: 0, decision: 0, orchestrator: 0, indeterminate: 0 });
	});

	test('a round that starts right after operator guidance counts as decision', () => {
		const events = [
			roundEvent(1, 'run.created', null),
			roundEvent(2, 'run.started', 'queued'),
			roundEvent(3, 'run.waiting-user', 'working'),
			roundEvent(4, 'run.operator-guidance', 'waiting-user'),
			roundEvent(5, 'run.started', 'waiting-user'),
		];
		expect(selectRunRoundOrigins(events)).toEqual({ executor: 0, ci: 0, decision: 1, orchestrator: 0, indeterminate: 0 });
	});

	test('a resume with no guidance before it -- e.g. recovering an interrupted run -- is reported indeterminate, never attributed by guess', () => {
		const events = [
			roundEvent(1, 'run.created', null),
			roundEvent(2, 'run.started', 'queued'),
			roundEvent(3, 'run.cancelled', 'working'),
			roundEvent(4, 'run.started', 'interrupted'),
		];
		expect(selectRunRoundOrigins(events)).toEqual({ executor: 0, ci: 0, decision: 0, orchestrator: 0, indeterminate: 1 });
	});
});

const CYCLE_AUDIT_USAGE = { model: 'configured-model', effort: 'high' } as const;

describe('orchestrator cycle questions (GSHIP-675)', () => {
	test('the production adapter always returns auditable model and effort values', async () => {
		let access: string | undefined;
		let resume: boolean | undefined;
		const session = {
			provider: 'claude' as const,
			run: async (input: AgentSessionInput) => {
				access = input.access;
				resume = input.resume;
				return {
					summary: 'continue',
					structuredOutput: { outcome: 'continue', guidance: 'Keep the bounded implementation.', reason: null },
				};
			},
		};
		const resolver = new AgentCycleQuestionResolver({ claude: session, codex: { ...session, provider: 'codex' } });
		const result = await resolver.resolve({
			runId: 'run-adapter', issueId: 'GSHIP-675', workspace: '/project',
			finding: 'finding', origin: 'review', priorResponses: [], providerId: 'claude',
			signal: new AbortController().signal, emit: () => {},
		});

		expect({ access, resume }).toEqual({ access: 'read-only', resume: false });
		expect(result.usage).toMatchObject({ model: 'provider-default', effort: 'provider-default' });
	});

	test('a no-change answer is linked, attributed and followed by fresh verification and review', async () => {
		const store = new RunStore(':memory:');
		let executions = 0;
		let verifications = 0;
		let reviews = 0;
		const ids = ['run-cycle', 'question-1'];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => ids.shift() ?? 'unexpected-id',
			newSessionId: () => 'session-cycle',
			executor: { execute: async ({ reviewFeedback }) => {
				executions += 1;
				if (executions === 3) expect(reviewFeedback).toContain('No change: the cited path is generated.');
				return { outcome: 'completed', summary: 'ready' };
			} },
			verifier: { verify: async () => {
				verifications += 1;
				return { ok: true };
			} },
			reviewer: { review: async () => {
				reviews += 1;
				return reviews < 3 ? { verdict: 'findings', detail: 'generated file mismatch' } : { verdict: 'clean' };
			} },
			cycleQuestionResolver: { resolve: async (input) => {
				expect(input).toMatchObject({ runId: 'run-cycle', issueId: 'GSHIP-675', providerId: 'claude' });
				return {
					outcome: 'continue',
					guidance: 'No change: the cited path is generated.',
					usage: { model: 'opus', effort: 'high', totalCostUsd: 0.04, inputTokens: 10, outputTokens: 4 },
				};
			} },
		});

		const run = runtime.startRun('GSHIP-675');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect({ executions, verifications, reviews }).toEqual({ executions: 3, verifications: 3, reviews: 3 });
		const events = runtime.listRunDecisionEvents(run.id);
		const question = events.find((event) => event.kind === 'run.cycle-question');
		const response = events.find((event) => event.kind === 'run.cycle-response');
		expect(question?.payload['questionId']).toBe('question-1');
		expect(response?.payload).toMatchObject({
			questionId: 'question-1', responder: 'orchestrator', source: 'internal', outcome: 'continue',
			guidance: 'No change: the cited path is generated.', provider: 'claude', model: 'opus', effort: 'high',
		});
		expect(response).toMatchObject({ fromState: 'review', toState: 'working' });
		expect(runtime.getRunCost(run.id)).toMatchObject({ totalCostUsd: 0.04 });
		expect(runtime.getRunRoundOrigins(run.id).orchestrator).toBe(1);
		expect(runtime.getRunEvaluation(run.id)).toMatchObject({
			attentionRequests: 0, operatorInterventions: 0, resolvedCycleQuestions: 1,
		});
	});

	test('an explicit semantic ambiguity reaches waiting-user with its linked public reason', async () => {
		let reviews = 0;
		const ids = ['run-ambiguity', 'question-ambiguity'];
		const runtime = new RunRuntime({
			cwd: '/project', store: new RunStore(':memory:'), newId: () => ids.shift() ?? 'id',
			newSessionId: () => 'session',
			executor: { execute: async () => ({ outcome: 'completed', summary: 'ready' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => (++reviews < 3
				? { verdict: 'findings', detail: 'product meaning is unresolved' }
				: { verdict: 'clean' }) },
			cycleQuestionResolver: { resolve: async () => ({
				outcome: 'operator', reason: 'Choose whether archived runs remain visible.',
				usage: CYCLE_AUDIT_USAGE,
			}) },
		});
		const run = runtime.startRun('GSHIP-675');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');
		expect(runtime.getRun(run.id)?.summary).toBe('Choose whether archived runs remain visible.');
		expect(runtime.listRunDecisionEvents(run.id).findLast((event) => event.kind === 'run.cycle-response')?.payload)
			.toMatchObject({
				questionId: 'question-ambiguity', outcome: 'operator',
				model: 'configured-model', effort: 'high',
			});
		expect(runtime.listRunDecisionEvents(run.id).findLast((event) => event.kind === 'run.cycle-response'))
			.toMatchObject({ fromState: 'review', toState: 'waiting-user' });
	});

	test('provider retry reuses one unanswered durable question and records one linked response', async () => {
		let reviews = 0;
		let resolutions = 0;
		const ids = ['run-retry-question', 'question-retry'];
		const runtime = new RunRuntime({
			cwd: '/project', store: new RunStore(':memory:'), newId: () => ids.shift() ?? 'id',
			newSessionId: () => 'session',
			executor: { execute: async () => ({ outcome: 'completed', summary: 'ready' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => {
				reviews += 1;
				return reviews < 3 ? { verdict: 'findings', detail: 'retry this finding' } : { verdict: 'clean' };
			} },
			cycleQuestionResolver: { resolve: async () => {
				resolutions += 1;
				if (resolutions === 1) {
					throw new ProviderCallError('claude', 'usage-limit', 'Subscription window exhausted.');
				}
				return { outcome: 'continue', guidance: 'Apply the bounded correction.', usage: CYCLE_AUDIT_USAGE };
			} },
		});
		const run = runtime.startRun('GSHIP-675');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(runtime.getRunProviderWait(run.id)).toMatchObject({ phase: 'review', kind: 'usage-limit' });
		runtime.resumeRun(run.id);
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		const events = runtime.listRunDecisionEvents(run.id);
		expect(events.filter((event) => event.kind === 'run.cycle-question')).toHaveLength(1);
		expect(events.filter((event) => event.kind === 'run.cycle-response')).toHaveLength(1);
		expect(reviews).toBe(3);
		expect(resolutions).toBe(2);
	});

	test('a full-verify cycle question provider hold resumes the same durable question', async () => {
		let fullVerifications = 0;
		let resolutions = 0;
		const ids = ['run-full-verify-hold', 'question-full-verify'];
		const runtime = new RunRuntime({
			cwd: '/project', store: new RunStore(':memory:'), newId: () => ids.shift() ?? 'id',
			newSessionId: () => 'session-full-verify-hold',
			executor: { execute: async () => ({ outcome: 'completed', summary: 'ready' }) },
			verifier: { verify: async () => ({ ok: true }) },
			fullVerifier: { verify: async () => {
				fullVerifications += 1;
				if (fullVerifications < 3) return { ok: false, detail: 'full verify finding' };
				return { ok: true };
			} },
			cycleQuestionResolver: { resolve: async () => {
				resolutions += 1;
				if (resolutions === 1) {
					throw new ProviderCallError('claude', 'usage-limit', 'Subscription window exhausted.');
				}
				return { outcome: 'continue', guidance: 'Apply the full verify correction.', usage: CYCLE_AUDIT_USAGE };
			} },
		});
		const run = runtime.startRun('GSHIP-732');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-provider');
		expect(runtime.getRunProviderWait(run.id)).toMatchObject({ phase: 'full-verify', kind: 'usage-limit' });
		runtime.resumeRun(run.id);
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(resolutions).toBe(2);
		expect(runtime.listRunDecisionEvents(run.id).filter((event) => event.kind === 'run.cycle-question'))
			.toHaveLength(1);
		expect(runtime.listRunDecisionEvents(run.id).filter((event) => event.kind === 'run.cycle-response'))
			.toHaveLength(1);
		await runtime.stop();
		runtime.close();
	});

	test('restart replays durable continue guidance before another review or response', async () => {
		const dbPath = join(createTestTmpdir('gship-cycle-restart-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.createRun({
			id: 'run-cycle-restart', issueId: 'GSHIP-675', sessionId: 'session-restart',
			workspacePath: '/project', createdAt: '2026-08-21T12:00:00.000Z',
		});
		const transition = (toState: RunRecord['state'], kind: string, payload?: Record<string, unknown>) =>
			store.transition({
				runId: 'run-cycle-restart', toState, kind,
				createdAt: '2026-08-21T12:00:01.000Z',
				...(payload === undefined ? {} : { payload }),
			});
		transition('working', 'run.started');
		transition('verify', 'run.work-completed');
		transition('review', 'run.review-started');
		transition('working', 'run.review-fix-requested');
		transition('verify', 'run.work-completed');
		transition('review', 'run.review-started');
		store.appendEvent({
			runId: 'run-cycle-restart', kind: 'run.cycle-question',
			createdAt: '2026-08-21T12:00:02.000Z',
			payload: { questionId: 'question-restart', finding: 'durable finding', origin: 'review' },
		});
		transition('working', 'run.cycle-response', {
			questionId: 'question-restart', responder: 'orchestrator', source: 'internal',
			outcome: 'continue', guidance: 'durable guidance', findings: 'durable finding',
			provider: 'claude', model: 'opus', effort: 'high', latencyMs: 5,
		});
		store.close();

		let reviewFeedback: string | undefined;
		let reviews = 0;
		const runtime = new RunRuntime({
			cwd: '/project', store: new RunStore(dbPath),
			executor: { execute: async (input) => {
				reviewFeedback = input.reviewFeedback;
				return { outcome: 'completed', summary: 'recovered' };
			} },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => {
				reviews += 1;
				return { verdict: 'clean' };
			} },
			cycleQuestionResolver: { resolve: async () => ({
				outcome: 'continue', guidance: 'must not be called', usage: CYCLE_AUDIT_USAGE,
			}) },
		});
		expect(runtime.getRun('run-cycle-restart')?.state).toBe('interrupted');
		runtime.resumeRun('run-cycle-restart', 'Proceed with the already resolved correction.');
		await waitFor(() => runtime.getRun('run-cycle-restart')?.state === 'ready-to-ship');
		expect(reviewFeedback).toContain('durable finding');
		expect(reviewFeedback).toContain('durable guidance');
		expect(reviews).toBe(1);
		expect(runtime.listRunDecisionEvents('run-cycle-restart')
			.filter((event) => event.kind === 'run.cycle-response')).toHaveLength(1);
		expect(runtime.getRunRoundOrigins('run-cycle-restart')).toEqual({
			executor: 1,
			ci: 0,
			orchestrator: 1,
			decision: 0,
			indeterminate: 0,
		});
	});

	test('a legacy unanswered question resumes as review without duplicating it', async () => {
		const dbPath = join(createTestTmpdir('gship-cycle-legacy-question-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.createRun({
			id: 'run-legacy-question', issueId: 'GSHIP-732', sessionId: 'session-legacy-question',
			workspacePath: '/project', createdAt: '2026-08-21T12:00:00.000Z',
		});
		const transition = (toState: RunRecord['state'], kind: string, payload?: Record<string, unknown>) =>
			store.transition({
				runId: 'run-legacy-question', toState, kind,
				createdAt: '2026-08-21T12:00:01.000Z',
				...(payload === undefined ? {} : { payload }),
			});
		transition('working', 'run.started');
		transition('verify', 'run.work-completed');
		transition('review', 'run.review-started');
		store.appendEvent({
			runId: 'run-legacy-question', kind: 'run.cycle-question',
			createdAt: '2026-08-21T12:00:02.000Z',
			payload: { questionId: 'question-legacy', finding: 'legacy finding' },
		});
		store.close();

		let resolutions = 0;
		const runtime = new RunRuntime({
			cwd: '/project', store: new RunStore(dbPath),
			executor: { execute: async () => ({ outcome: 'completed', summary: 'recovered' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => ({ verdict: 'clean' }) },
			cycleQuestionResolver: { resolve: async (input) => {
				resolutions += 1;
				expect(input.origin).toBe('review');
				return { outcome: 'continue', guidance: 'Apply the legacy guidance.', usage: CYCLE_AUDIT_USAGE };
			} },
		});
		runtime.resumeRun('run-legacy-question');
		await waitFor(() => runtime.getRun('run-legacy-question')?.state === 'ready-to-ship');
		expect(resolutions).toBe(1);
		expect(runtime.listRunDecisionEvents('run-legacy-question').filter((event) => event.kind === 'run.cycle-question'))
			.toHaveLength(1);
		await runtime.stop();
		runtime.close();
	});

	test('restart restores full-verify guidance in its own executor field', async () => {
		const dbPath = join(createTestTmpdir('gship-cycle-full-verify-restart-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.createRun({
			id: 'run-full-verify-restart', issueId: 'GSHIP-732', sessionId: 'session-full-verify-restart',
			workspacePath: '/project', createdAt: '2026-08-21T12:00:00.000Z',
		});
		const transition = (toState: RunRecord['state'], kind: string, payload?: Record<string, unknown>) =>
			store.transition({
				runId: 'run-full-verify-restart', toState, kind,
				createdAt: '2026-08-21T12:00:01.000Z',
				...(payload === undefined ? {} : { payload }),
			});
		transition('working', 'run.started');
		transition('verify', 'run.work-completed');
		transition('review', 'run.review-started');
		transition('full-verify', 'run.review-clean');
		store.appendEvent({
			runId: 'run-full-verify-restart', kind: 'run.cycle-question',
			createdAt: '2026-08-21T12:00:02.000Z',
			payload: { questionId: 'question-full-verify-restart', finding: 'full verify finding', origin: 'full-verify' },
		});
		transition('working', 'run.cycle-response', {
			questionId: 'question-full-verify-restart', responder: 'orchestrator', source: 'internal',
			outcome: 'continue', guidance: 'full verify guidance', findings: 'full verify finding',
			origin: 'full-verify', provider: 'claude', model: 'opus', effort: 'high', latencyMs: 5,
		});
		store.close();

		let fullVerifyFeedback: string | undefined;
		let reviewFeedback: string | undefined;
		let resolutions = 0;
		const runtime = new RunRuntime({
			cwd: '/project', store: new RunStore(dbPath),
			executor: { execute: async (input) => {
				fullVerifyFeedback = input.fullVerifyFeedback;
				reviewFeedback = input.reviewFeedback;
				return { outcome: 'completed', summary: 'recovered' };
			} },
			verifier: { verify: async () => ({ ok: true }) },
			cycleQuestionResolver: { resolve: async () => {
				resolutions += 1;
				return { outcome: 'continue', guidance: 'must not be called', usage: CYCLE_AUDIT_USAGE };
			} },
		});
		runtime.resumeRun('run-full-verify-restart');
		await waitFor(() => runtime.getRun('run-full-verify-restart')?.state === 'ready-to-ship');
		expect(fullVerifyFeedback).toContain('full verify finding');
		expect(fullVerifyFeedback).toContain('full verify guidance');
		expect(reviewFeedback).toBeUndefined();
		expect(resolutions).toBe(0);
		expect(runtime.listRunDecisionEvents('run-full-verify-restart')
			.filter((event) => event.kind === 'run.cycle-response')).toHaveLength(1);
		await runtime.stop();
		runtime.close();
	});

	test('distinct findings continue, then a recurring finding stalls safely', async () => {
		let reviews = 0;
		let resolutions = 0;
		const ids = ['run-stall', 'question-1', 'question-2', 'question-3'];
		const runtime = new RunRuntime({
			cwd: '/project', store: new RunStore(':memory:'), newId: () => ids.shift() ?? 'unexpected',
			newSessionId: () => 'session',
			executor: { execute: async () => ({ outcome: 'completed', summary: 'ready' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => {
				reviews += 1;
				return { verdict: 'findings', detail: reviews < 4 ? `finding ${reviews}` : 'finding 3' };
			} },
			cycleQuestionResolver: { resolve: async (input) => {
				resolutions += 1;
				if (input.finding === 'finding 3' && input.priorResponses.some((response) =>
					response.finding === input.finding && response.origin === input.origin)) {
					return {
						outcome: 'operator',
						reason: 'The same finding returned without new executable guidance.',
						usage: CYCLE_AUDIT_USAGE,
					};
				}
				return { outcome: 'continue', guidance: `bounded fix ${resolutions}`, usage: CYCLE_AUDIT_USAGE };
			} },
		});
		const run = runtime.startRun('GSHIP-675');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');
		expect(resolutions).toBe(3);
		const responses = runtime.listRunDecisionEvents(run.id).filter((event) =>
			event.kind === 'run.cycle-response');
		expect(responses.filter((event) => event.payload['outcome'] === 'continue')).toHaveLength(2);
		expect(responses.at(-1)?.payload).toMatchObject({
			questionId: 'question-3',
			outcome: 'operator',
			reason: 'The same finding returned without new executable guidance.',
		});
		expect(runtime.getRunEvaluation(run.id)).toMatchObject({
			attentionRequests: 1,
			operatorInterventions: 0,
			resolvedCycleQuestions: 3,
		});

		let invalidReviews = 0;
		const invalidIds = ['run-invalid', 'question-invalid'];
		const invalid = new RunRuntime({
			cwd: '/project', store: new RunStore(':memory:'), newId: () => invalidIds.shift() ?? 'id',
			newSessionId: () => 'session',
			executor: { execute: async () => ({ outcome: 'completed', summary: 'ready' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => (++invalidReviews < 3
				? { verdict: 'findings', detail: 'finding' }
				: { verdict: 'clean' }) },
			cycleQuestionResolver: { resolve: async () => ({
				outcome: 'continue', guidance: '   ', usage: CYCLE_AUDIT_USAGE,
			}) },
		});
		const invalidRun = invalid.startRun('GSHIP-675');
		await waitFor(() => invalid.getRun(invalidRun.id)?.state === 'waiting-user');
		expect(invalid.listRunDecisionEvents(invalidRun.id)
			.filter((event) => event.kind === 'run.cycle-response')).toHaveLength(0);
		expect(invalid.listRunDecisionEvents(invalidRun.id).findLast((event) =>
			event.kind === 'run.cycle-response-invalid')?.payload).toMatchObject({
			questionId: 'question-invalid',
			reason: 'Cycle question resolver returned an invalid response.',
		});
		expect(invalid.getRunEvaluation(invalidRun.id)).toMatchObject({ resolvedCycleQuestions: 0 });
	});
});

describe('operator decisions reach the reviewer (GSHIP-630)', () => {
	// Mirrors the GSHIP-629 evidence this issue cites: the operator ratifies a
	// deviation, the next review reports it again as a pending defect, and the
	// operator has to ratify it a second time. With decisions threaded into the
	// prompt, both ratifications must actually reach the reviewer, in order.
	test('each review sees every operator decision made so far, accumulating in chronological order', async () => {
		const store = new RunStore(':memory:');
		let executorCalls = 0;
		let reviewCalls = 0;
		const reviewDecisions: Array<readonly string[] | undefined> = [];
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-decisions',
			newSessionId: () => 'session-decisions',
			executor: {
				execute: async ({ resume }) => {
					executorCalls += 1;
					if (!resume) return { outcome: 'waiting-user', summary: 'Choose the seam.' };
					return { outcome: 'completed', summary: `pass ${executorCalls}` };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: {
				review: async (input) => {
					reviewCalls += 1;
					reviewDecisions.push(input.operatorDecisions);
					// Findings on the first two reviews reproduce the "reported again"
					// step; findings on review 2 forces the fix-limit wait for a
					// second ratification, and review 3 is clean so the run settles.
					return reviewCalls < 3
						? { verdict: 'findings', detail: '1. src/a.ts: same point again' }
						: { verdict: 'clean' };
				},
			},
		});

		const run = runtime.startRun('CAM-90');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');

		runtime.resumeRun(run.id, 'Ratify the smaller seam.');
		await waitFor(() => reviewCalls >= 2);
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');

		runtime.resumeRun(run.id, 'Ratify it again.');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(reviewDecisions).toEqual([
			['Ratify the smaller seam.'],
			['Ratify the smaller seam.'],
			['Ratify the smaller seam.', 'Ratify it again.'],
		]);
		expect(runtime.listRunDecisionEvents(run.id)
			.filter((event) => event.kind === 'run.operator-guidance')
			.map((event) => event.payload['text'])).toEqual([
			'Ratify the smaller seam.',
			'Ratify it again.',
		]);

		await runtime.stop();
		runtime.close();
	});
});

// GSHIP-638: encadear runs aprovadas em serie. The switch creates no new
// authority -- it only starts what isPlannable (src/issues/plannable.ts)
// already admits -- and only a run that settles as `done` advances the queue.
describe('chaining approved runs in series (GSHIP-638)', () => {
	const SPEC = { scope: 'Scope.', verify: ['bun test'] };

	function admissibleIssue(id: string, overrides: Partial<IssueEntry> = {}): IssueEntry {
		return {
			id,
			title: id,
			stage: 'specified',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-08-18T00:00:00.000Z',
			updatedAt: '2026-08-18T00:00:00.000Z',
			spec: SPEC,
			approval: { fingerprint: fingerprintSpec(SPEC), approvedAt: '2026-08-18T00:00:00.000Z' },
			...overrides,
		};
	}

	function createChainableRuntime(listBacklog: () => IssueEntry[]): RunRuntime {
		return new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			executor: { execute: async () => ({ outcome: 'completed', summary: 'change written' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 1 }) },
			listBacklog,
		});
	}

	/**
	 * A store double whose `getRun` can be made to miss one run, simulating the
	 * run_events foreign key's own guarantee (run_id REFERENCES runs(id)) not
	 * holding -- structurally not expected, but `getChainPause` must not assume
	 * it and invent a link the data does not have.
	 */
	class RunLookupGapStore extends RunStore {
		#hiddenRunId: string | null = null;

		hideRun(runId: string): void {
			this.#hiddenRunId = runId;
		}

		override getRun(runId: string): RunRecord | null {
			return runId === this.#hiddenRunId ? null : super.getRun(runId);
		}
	}

	test('the switch is off by default and survives a service restart', () => {
		const dbPath = join(createTestTmpdir('gship-run-runtime-chain-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		const runtime = new RunRuntime({ cwd: '/project', store });
		expect(runtime.getChainRuns()).toBe(false);
		runtime.setChainRuns(true);
		expect(runtime.getChainRuns()).toBe(true);
		runtime.close();

		const reopened = new RunRuntime({ cwd: '/project', store: new RunStore(dbPath) });
		expect(reopened.getChainRuns()).toBe(true);
		reopened.close();
	});

	test('a done run does not chain while the switch stays off', async () => {
		const runtime = createChainableRuntime(() => [admissibleIssue('GSHIP-2')]);
		const run = runtime.startRun('GSHIP-1');
		await waitFor(() => runtime.getRun(run.id)?.state === 'done');

		expect(runtime.listRuns().map((r) => r.issueId)).toEqual(['GSHIP-1']);
		expect(runtime.getChainPause()).toMatchObject({ reason: 'chain-disabled' });
		expect(runtime.listRunEvents(run.id).find((event) => event.kind === 'run.chain-paused')?.payload)
			.toEqual({ reason: 'chain-disabled' });
		await runtime.stop();
		runtime.close();
	});

	test('a failed run stops the queue with its own durable reason instead of chaining', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: false, detail: 'verification failed' }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 1 }) },
			listBacklog: () => [admissibleIssue('GSHIP-2')],
		});
		runtime.setChainRuns(true);

		const run = runtime.startRun('GSHIP-1');
		await waitFor(() => runtime.getRun(run.id)?.state === 'failed');

		expect(runtime.listRuns().map((r) => r.issueId)).toEqual(['GSHIP-1']);
		expect(runtime.getChainPause()).toMatchObject({ reason: 'previous-run-not-done' });
		expect(runtime.listRunEvents(run.id).find((event) => event.kind === 'run.chain-paused')?.payload)
			.toEqual({ reason: 'previous-run-not-done' });
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-650: the pause used to name only its reason, even though the
	// run.chain-paused event fires on the very run that stopped the queue.
	test('a pause loads the issue and run that stopped the queue', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: false, detail: 'verification failed' }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 1 }) },
			listBacklog: () => [admissibleIssue('GSHIP-1', { title: 'Corrigir o parser' })],
		});
		runtime.setChainRuns(true);

		const run = runtime.startRun('GSHIP-1');
		await waitFor(() => runtime.getRun(run.id)?.state === 'failed');

		const pause = runtime.getChainPause();
		expect(pause?.reason).toBe('previous-run-not-done');
		expect(pause?.run).toEqual({ id: run.id, issueId: 'GSHIP-1' });
		expect(pause?.issue).toEqual({ id: 'GSHIP-1', title: 'Corrigir o parser' });

		await runtime.stop();
		runtime.close();
	});

	// GSHIP-650 review: listBacklog (e.g. readBacklogFromMain) is fail-closed by
	// contract -- getChainPause must wrap it itself, like #maybeChain already
	// does for chaining, so a bad read degrades the pause instead of taking
	// down the whole /api/chain-runs response the browser's single Promise.all
	// depends on.
	test('a pause whose issue lookup fails degrades to the pause without the issue, never propagating', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 1 }) },
			listBacklog: () => {
				throw new Error('git cat-file --batch failed');
			},
		});
		// The switch stays off, so #attemptChain never itself reaches the
		// backlog read; only the later getChainPause() call below does.

		const run = runtime.startRun('GSHIP-1');
		await waitFor(() => runtime.getRun(run.id)?.state === 'done');

		const pause = runtime.getChainPause();
		expect(pause?.reason).toBe('chain-disabled');
		expect(pause?.run).toEqual({ id: run.id, issueId: 'GSHIP-1' });
		expect(pause?.issue).toBeUndefined();

		await runtime.stop();
		runtime.close();
	});

	test('a pause whose event carries no resolvable run loads only the reason', async () => {
		const store = new RunLookupGapStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 1 }) },
			listBacklog: () => [admissibleIssue('GSHIP-2')],
		});

		const run = runtime.startRun('GSHIP-1');
		await waitFor(() => store.getRun(run.id)?.state === 'done');
		store.hideRun(run.id);

		const pause = runtime.getChainPause();
		expect(pause?.reason).toBe('chain-disabled');
		expect(pause?.run).toBeUndefined();
		expect(pause?.issue).toBeUndefined();

		await runtime.stop();
		runtime.close();
	});

	test('a done run chains to the next admissible issue in id order, and pauses once none remain', async () => {
		// A strictly increasing fake clock: chained runs happen back to back, and a
		// real clock could tie two of them to the same millisecond, which would
		// make the `created_at` ordering this test checks flaky.
		let clock = Date.parse('2026-08-18T00:00:00.000Z');
		const now = () => new Date(clock++).toISOString();

		const notApproved = admissibleIssue('GSHIP-2', { approval: undefined });
		const nextInOrder = admissibleIssue('GSHIP-3');
		const laterInOrder = admissibleIssue('GSHIP-9');
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			now,
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
			shipper: { ship: async () => ({ outcome: 'merged', prNumber: 1 }) },
			// GSHIP-2 never becomes admissible; the fixture reads as gone once a run
			// for it has already gone `done`, mirroring how the real backlog (read
			// from the source ref) stops offering a just-shipped issue.
			listBacklog: () => {
				const done = new Set(
					store.listRuns().filter((r) => r.state === 'done').map((r) => r.issueId),
				);
				return [notApproved, nextInOrder, laterInOrder].filter((entry) => !done.has(entry.id));
			},
		});
		runtime.setChainRuns(true);

		const first = runtime.startRun('GSHIP-1');
		await waitFor(() => runtime.getRun(first.id)?.state === 'done');
		await waitFor(() => runtime.getChainPause() !== null);

		const runs = runtime.listRuns();
		expect(runs.map((run) => run.issueId)).toEqual(['GSHIP-9', 'GSHIP-3', 'GSHIP-1']);
		expect(runs.every((run) => run.state === 'done')).toBe(true);
		expect(runtime.getChainPause()).toMatchObject({ reason: 'no-admissible-issue' });

		await runtime.stop();
		runtime.close();
	});
});
