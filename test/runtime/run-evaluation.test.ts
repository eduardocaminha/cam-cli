import { describe, expect, test } from 'bun:test';

import { evaluateRun } from '../../src/runtime/run-evaluation.ts';
import type { RunEvent, RunRecord } from '../../src/runtime/run-store.ts';

const RUN: RunRecord = {
	id: 'run-eval',
	issueId: 'GSHIP-700',
	sessionId: 'session-eval',
	providerId: 'claude',
	workspacePath: '/workspaces/run-eval',
	state: 'done',
	fixRounds: 1,
	createdAt: '2026-08-20T10:00:00.000Z',
	updatedAt: '2026-08-20T10:12:00.000Z',
	summary: null,
	error: null,
};

function event(
	kind: string,
	fromState: RunEvent['fromState'],
	toState: RunEvent['toState'],
	payload: Record<string, unknown> = {},
): RunEvent {
	return {
		seq: 1,
		runId: RUN.id,
		kind,
		fromState,
		toState,
		payload,
		createdAt: RUN.createdAt,
		eventClass: 'decision',
	};
}

describe('replayable run evaluation', () => {
	test('derives revision, attention, holds and provider configuration from the durable log', () => {
		const evaluation = evaluateRun(RUN, [
			event('run.created', null, 'queued', { workflowRevision: ' revision-b ' }),
			event('provider.model', 'working', 'working', { model: 'sonnet', effort: 'xhigh' }),
			event('provider.model', 'working', 'working', { model: 'sonnet', effort: 'xhigh' }),
			event('provider.model', 'working', 'working', { model: 'opus', effort: 'high' }),
			event('run.waiting-user', 'working', 'waiting-user'),
			event('run.operator-guidance', 'waiting-user', 'waiting-user'),
			event('run.operator-guidance', 'waiting-user', 'waiting-user'),
			event('run.provider-waiting', 'review', 'waiting-provider'),
			event('review.model', 'review', 'review', { model: 'opus', effort: 'medium' }),
		]);

		expect(evaluation).toEqual({
			workflowRevision: 'revision-b',
			provider: 'claude',
			outcome: 'shipped',
			wallTimeMs: 12 * 60_000,
			attentionRequests: 1,
			operatorInterventions: 2,
			providerHolds: 1,
			resolvedCycleQuestions: 0,
			roles: [
				{ role: 'executor', models: ['opus', 'sonnet'], efforts: ['high', 'xhigh'], providers: ['claude'] },
				{ role: 'reviewer', models: ['opus'], efforts: ['medium'], providers: ['claude'] },
			],
		});
	});

	// GSHIP-709: a review answered by the fallback is attributed to the
	// provider that produced it without erasing the origin it started from.
	test('adds the review fallback provider to the reviewer role, keeping its origin', () => {
		const evaluation = evaluateRun(RUN, [
			event('review.model', 'review', 'review', { effort: 'medium' }),
			event('run.review-fallback', 'review', 'review', {
				from: 'claude',
				to: 'codex',
				phase: 'review',
				reason: 'usage-limit',
				outcome: 'findings',
			}),
		]);

		expect(evaluation.provider).toBe('claude');
		expect(evaluation.roles).toEqual([
			{ role: 'reviewer', models: [], efforts: ['medium'], providers: ['claude', 'codex'] },
		]);
	});

	// A refused attempt still spawned the alternative, which reported its own
	// model before failing: the provider stays listed beside that model, and
	// the fallback event's outcome is what says the attempt produced nothing.
	test('lists the refused fallback provider beside the model its own spawn reported', () => {
		const evaluation = evaluateRun(RUN, [
			event('review.model', 'review', 'review', { model: 'opus' }),
			event('review.model', 'review', 'review', { model: 'gpt-5-codex', effort: 'medium' }),
			event('run.review-fallback', 'review', 'review', {
				from: 'claude',
				to: 'codex',
				phase: 'review',
				reason: 'rate-limited',
				outcome: 'refused',
				error: 'codex is not authenticated',
			}),
		]);

		expect(evaluation.roles).toEqual([{
			role: 'reviewer',
			models: ['gpt-5-codex', 'opus'],
			efforts: ['medium'],
			providers: ['claude', 'codex'],
		}]);
	});

	test('keeps legacy revision and non-terminal wall time explicitly unknown', () => {
		expect(evaluateRun({ ...RUN, state: 'working' }, [event('run.created', null, 'queued')]))
			.toMatchObject({ workflowRevision: null, outcome: 'incomplete', wallTimeMs: null });
		expect(evaluateRun({ ...RUN, createdAt: 'invalid' }, []))
			.toMatchObject({ outcome: 'shipped', wallTimeMs: null });
	});
});
