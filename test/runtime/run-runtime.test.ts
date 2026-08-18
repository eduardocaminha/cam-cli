import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { GitEvidenceChecker } from '../../src/runtime/git-runtime.ts';
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
			'workspace.released',
		]);

		const next = runtime.startRun('CAM-21');
		await waitFor(() => runtime.getRun(next.id)?.state === 'ready-to-ship');
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
