// test/runtime/run-review.test.ts
//
// CAM-577 acceptance criterion 1: a verified run enters review, a clean
// verdict reaches ready-to-ship, findings buy exactly one automatic fix with
// a fresh verification and a fresh review, and persistent findings without a
// configured cycle resolver stop safely at waiting-user.

import { describe, expect, test } from 'bun:test';

import {
	RunRuntime,
	type RuntimeExecutionInput,
	type RuntimeReviewResult,
	type RuntimeShipper,
} from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';

interface ExecutionCall {
	resume: boolean;
	reviewFeedback: string | undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for runtime state');
		await Bun.sleep(5);
	}
}

function createRuntime(verdicts: RuntimeReviewResult[], shipper?: RuntimeShipper): {
	runtime: RunRuntime;
	executions: ExecutionCall[];
	verifications: number[];
	reviews: number[];
} {
	const executions: ExecutionCall[] = [];
	const verifications: number[] = [];
	const reviews: number[] = [];
	let verdictIndex = 0;
	const runtime = new RunRuntime({
		cwd: '/project',
		store: new RunStore(':memory:'),
		newId: () => 'run-review',
		newSessionId: () => 'session-review',
		executor: {
			execute: async (input: RuntimeExecutionInput) => {
				executions.push({ resume: input.resume, reviewFeedback: input.reviewFeedback });
				return { outcome: 'completed', summary: 'change written' };
			},
		},
		verifier: {
			verify: async () => {
				verifications.push(verifications.length + 1);
				return { ok: true };
			},
		},
		reviewer: {
			review: async () => {
				reviews.push(reviews.length + 1);
				const verdict = verdicts[verdictIndex] ?? verdicts.at(-1);
				verdictIndex += 1;
				if (verdict === undefined) throw new Error('no verdict configured');
				return verdict;
			},
		},
		...(shipper === undefined ? {} : { shipper }),
	});
	return { runtime, executions, verifications, reviews };
}

describe('independent review stage', () => {
	test('a clean verdict takes a verified run from review to ready-to-ship', async () => {
		const { runtime, executions, reviews } = createRuntime([{ verdict: 'clean' }]);
		const run = await runtime.startRun('CAM-577');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(runtime.getRun(run.id)).toMatchObject({ state: 'ready-to-ship', fixRounds: 0 });
		expect(runtime.listEvents().map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.review-started',
			'run.review-clean',
		]);
		expect(executions).toHaveLength(1);
		expect(reviews).toHaveLength(1);
		await runtime.stop();
		runtime.close();
	});

	test('findings buy exactly one automatic fix, then a new verification and review', async () => {
		const { runtime, executions, verifications, reviews } = createRuntime([
			{ verdict: 'findings', detail: '1. src/a.ts: off-by-one in the cursor' },
			{ verdict: 'clean' },
		]);
		const run = await runtime.startRun('CAM-577');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');

		expect(runtime.getRun(run.id)).toMatchObject({ state: 'ready-to-ship', fixRounds: 1 });
		expect(runtime.listEvents().map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.review-started',
			'run.review-fix-requested',
			'run.work-completed',
			'run.review-started',
			'run.review-clean',
		]);
		// The fix round is the only execution that carries the reviewer's findings,
		// and it continues the implementer session instead of starting a new one.
		expect(executions).toEqual([
			{ resume: false, reviewFeedback: undefined },
			{ resume: true, reviewFeedback: '1. src/a.ts: off-by-one in the cursor' },
		]);
		expect(verifications).toHaveLength(2);
		expect(reviews).toHaveLength(2);
		await runtime.stop();
		runtime.close();
	});

	test('persistent findings without a cycle resolver stop safely at waiting-user', async () => {
		const { runtime, executions, reviews } = createRuntime([
			{ verdict: 'findings', detail: 'first pass finding' },
			{ verdict: 'findings', detail: 'still broken in src/a.ts' },
		]);
		const run = await runtime.startRun('CAM-577');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(runtime.getRun(run.id)).toMatchObject({
			state: 'waiting-user',
			fixRounds: 1,
			summary: 'still broken in src/a.ts',
		});
		const events = runtime.listEvents();
			expect(events.map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.review-started',
			'run.review-fix-requested',
			'run.work-completed',
			'run.review-started',
			'run.cycle-question',
			'run.review-fix-limit',
		]);
		expect(events.at(-2)?.payload).toEqual({
			questionId: 'run-review',
			issueId: 'CAM-577',
			finding: 'still broken in src/a.ts',
			origin: 'review',
		});
		expect(events.at(-1)?.payload).toEqual({
			questionId: 'run-review',
			findings: 'still broken in src/a.ts',
			origin: 'review',
			reason: 'Cycle question resolver is unavailable.',
		});
		expect(executions).toHaveLength(2);
		expect(reviews).toHaveLength(2);
		await runtime.stop();
		runtime.close();
	});

	// CAM-583: the clean verdict is what releases the ship, so the two stages
	// are exercised together rather than across an operator command.
	test('a clean verdict ships the run without stopping at the button', async () => {
		const shipped: string[] = [];
		const { runtime } = createRuntime([{ verdict: 'clean' }], {
			ship: async (input) => {
				shipped.push(input.runId);
				return { outcome: 'merged', prNumber: 407 };
			},
		});
		const run = await runtime.startRun('CAM-583');
		await waitFor(() => runtime.getRun(run.id)?.state === 'done');

		expect(runtime.listEvents().map((event) => event.kind)).toEqual([
			'run.created',
			'run.started',
			'run.work-completed',
			'run.review-started',
			'run.review-clean',
			'run.ship-started',
			'run.shipped',
			'run.chain-paused',
		]);
		expect(shipped).toEqual([run.id]);
		await runtime.stop();
		runtime.close();
	});

	test('findings that survive the fix round hold the run instead of shipping it', async () => {
		let shipCalls = 0;
		const { runtime } = createRuntime(
			[{ verdict: 'findings', detail: 'first pass finding' }, { verdict: 'findings', detail: 'still broken' }],
			{
				ship: async () => {
					shipCalls += 1;
					return { outcome: 'merged', prNumber: 407 };
				},
			},
		);
		const run = await runtime.startRun('CAM-583');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');

		expect(shipCalls).toBe(0);
		expect(runtime.listEvents().map((event) => event.kind)).not.toContain('run.ship-started');
		await runtime.stop();
		runtime.close();
	});

	test('routes more findings than the former ceiling through internal cycle responses', async () => {
		let reviews = 0;
		let nextId = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => `cycle-${++nextId}`,
			executor: { execute: async () => ({ outcome: 'completed', summary: 'ready' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: { review: async () => {
				reviews += 1;
				return reviews < 5
					? { verdict: 'findings', detail: `technical finding ${reviews}` }
					: { verdict: 'clean' };
			} },
			cycleQuestionResolver: { resolve: async (input) => {
				expect(input.origin).toBe('review');
				return {
					outcome: 'continue', guidance: `Apply ${input.finding}.`,
					usage: { model: 'model', effort: 'high' },
				};
			} },
		});

		const run = await runtime.startRun('GSHIP-732');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(runtime.getRun(run.id)?.fixRounds).toBe(4);
		expect(runtime.listRunDecisionEvents(run.id).filter((event) => event.kind === 'run.cycle-response'))
			.toHaveLength(3);
		expect(runtime.getRunEvaluation(run.id)).toMatchObject({
			attentionRequests: 0, operatorInterventions: 0, resolvedCycleQuestions: 3,
		});
		await runtime.stop();
		runtime.close();
	});

	test('a run without a configured reviewer still verifies straight to ready-to-ship', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-no-reviewer',
			executor: { execute: async () => ({ outcome: 'completed' }) },
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = await runtime.startRun('CAM-577');
		await waitFor(() => runtime.getRun(run.id)?.state === 'ready-to-ship');
		expect(runtime.listEvents().map((event) => event.kind)).not.toContain('run.review-started');
		await runtime.stop();
		runtime.close();
	});
});
