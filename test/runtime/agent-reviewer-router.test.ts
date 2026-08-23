import { describe, expect, test } from 'bun:test';

import { AgentReviewerRouter } from '../../src/runtime/agent-reviewer-router.ts';
import { ProviderCallError } from '../../src/runtime/agent-session.ts';
import type {
	RuntimeExecutionInput,
	RuntimeReviewer,
	RuntimeReviewResult,
} from '../../src/runtime/run-runtime.ts';

interface EmittedEvent {
	kind: string;
	payload?: Record<string, unknown>;
}

function input(
	events: EmittedEvent[] = [],
	overrides: Partial<RuntimeExecutionInput> = {},
): RuntimeExecutionInput {
	return {
		runId: 'run-1',
		issueId: 'CAM-1',
		sessionId: 'session-1',
		providerId: 'claude',
		resume: false,
		cwd: '/worktree',
		signal: new AbortController().signal,
		emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		...overrides,
	};
}

function reviewer(
	calls: string[],
	name: string,
	result: RuntimeReviewResult | Error,
): RuntimeReviewer {
	return {
		review: async () => {
			calls.push(name);
			if (result instanceof Error) throw result;
			return result;
		},
	};
}

const CLAUDE_LIMIT = new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.', {
	retryAt: '2026-08-23T12:00:00.000Z',
});

test('reviewer router follows the provider persisted on the run', async () => {
	const calls: string[] = [];
	const router = new AgentReviewerRouter({
		claude: reviewer(calls, 'claude', { verdict: 'clean' }),
		codex: reviewer(calls, 'codex', { verdict: 'clean' }),
	});

	await router.review(input([], { providerId: 'codex' }));
	expect(calls).toEqual(['codex']);
});

// GSHIP-709: the fallback lives only at this read-only boundary, tries exactly
// one alternative and never mutates the run's own provider.
describe('review fallback on a Claude limit', () => {
	test('tries Codex once and records origin, target, reason and outcome', async () => {
		const calls: string[] = [];
		const events: EmittedEvent[] = [];
		const router = new AgentReviewerRouter({
			claude: reviewer(calls, 'claude', CLAUDE_LIMIT),
			codex: reviewer(calls, 'codex', { verdict: 'findings', detail: 'missing test' }),
		});

		const executionInput = input(events);
		expect(await router.review(executionInput)).toEqual({
			verdict: 'findings',
			detail: 'missing test',
		});
		expect(calls).toEqual(['claude', 'codex']);
		expect(executionInput.providerId).toBe('claude');
		expect(events).toEqual([{
			kind: 'run.review-fallback',
			payload: {
				from: 'claude',
				to: 'codex',
				phase: 'review',
				reason: 'usage-limit',
				message: 'Claude usage limit reached.',
				retryAt: '2026-08-23T12:00:00.000Z',
				outcome: 'findings',
			},
		}]);
	});

	test('preserves the executor session and worktree for the fallback review', async () => {
		const seen: RuntimeExecutionInput[] = [];
		const router = new AgentReviewerRouter({
			claude: { review: async () => { throw CLAUDE_LIMIT; } },
			codex: {
				review: async (received) => {
					seen.push(received);
					return { verdict: 'clean' };
				},
			},
		});

		await router.review(input());
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			sessionId: 'session-1',
			cwd: '/worktree',
			providerId: 'claude',
		});
	});

	test('records a refused attempt and keeps the original Claude hold', async () => {
		const calls: string[] = [];
		const events: EmittedEvent[] = [];
		const router = new AgentReviewerRouter({
			claude: reviewer(calls, 'claude', CLAUDE_LIMIT),
			codex: reviewer(
				calls,
				'codex',
				new ProviderCallError('codex', 'auth-required', 'Codex is not authenticated.'),
			),
		});

		await expect(router.review(input(events))).rejects.toThrow(CLAUDE_LIMIT);
		expect(calls).toEqual(['claude', 'codex']);
		expect(events).toEqual([{
			kind: 'run.review-fallback',
			payload: {
				from: 'claude',
				to: 'codex',
				phase: 'review',
				reason: 'usage-limit',
				message: 'Claude usage limit reached.',
				retryAt: '2026-08-23T12:00:00.000Z',
				outcome: 'refused',
				error: 'Codex is not authenticated.',
				errorKind: 'auth-required',
			},
		}]);
	});

	test('never answers a failure that is not a Claude limit, and never falls back from Codex', async () => {
		const calls: string[] = [];
		const events: EmittedEvent[] = [];
		const overloaded = new ProviderCallError('claude', 'overloaded', 'Claude is overloaded.');
		const claudeOverloaded = new AgentReviewerRouter({
			claude: reviewer(calls, 'claude', overloaded),
			codex: reviewer(calls, 'codex', { verdict: 'clean' }),
		});
		await expect(claudeOverloaded.review(input(events))).rejects.toThrow(overloaded);

		const codexLimit = new ProviderCallError('codex', 'usage-limit', 'Codex usage limit reached.');
		const codexPrimary = new AgentReviewerRouter({
			claude: reviewer(calls, 'claude', { verdict: 'clean' }),
			codex: reviewer(calls, 'codex', codexLimit),
		});
		await expect(codexPrimary.review(input(events, { providerId: 'codex' })))
			.rejects.toThrow(codexLimit);

		expect(calls).toEqual(['claude', 'codex']);
		expect(events).toEqual([]);
	});

	test('leaves an aborted review to its own interruption instead of spawning the alternative', async () => {
		const calls: string[] = [];
		const events: EmittedEvent[] = [];
		const controller = new AbortController();
		const router = new AgentReviewerRouter({
			claude: {
				review: async () => {
					calls.push('claude');
					controller.abort();
					throw CLAUDE_LIMIT;
				},
			},
			codex: reviewer(calls, 'codex', { verdict: 'clean' }),
		});

		await expect(router.review(input(events, { signal: controller.signal })))
			.rejects.toThrow(CLAUDE_LIMIT);
		expect(calls).toEqual(['claude']);
		expect(events).toEqual([]);
	});
});
