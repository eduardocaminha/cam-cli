import { describe, expect, test } from 'bun:test';

import { AgentReviewerRouter } from '../../src/runtime/agent-reviewer-router.ts';
import {
	PROVIDER_ERROR_KINDS,
	ProviderCallError,
	type AgentProviderId,
} from '../../src/runtime/agent-session.ts';
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

const CODEX_LIMIT = new ProviderCallError('codex', 'rate-limited', 'Codex is rate limited.', {
	retryAt: '2026-08-23T13:00:00.000Z',
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

interface Direction {
	from: AgentProviderId;
	to: AgentProviderId;
	held: ProviderCallError;
}

// GSHIP-709 opened the fallback from Claude; GSHIP-721 completes the return
// direction. Both are the same contract, so both are read from one table.
const DIRECTIONS: readonly Direction[] = [
	{ from: 'claude', to: 'codex', held: CLAUDE_LIMIT },
	{ from: 'codex', to: 'claude', held: CODEX_LIMIT },
];

function routerFor(
	calls: string[],
	direction: Direction,
	origin: RuntimeReviewResult | Error,
	alternative: RuntimeReviewResult | Error,
): AgentReviewerRouter {
	const results: Record<AgentProviderId, RuntimeReviewResult | Error> = direction.from === 'claude'
		? { claude: origin, codex: alternative }
		: { claude: alternative, codex: origin };
	return new AgentReviewerRouter({
		claude: reviewer(calls, 'claude', results.claude),
		codex: reviewer(calls, 'codex', results.codex),
	});
}

const INADMISSIBLE_KINDS = PROVIDER_ERROR_KINDS
	.filter((kind) => kind !== 'usage-limit' && kind !== 'rate-limited');

for (const direction of DIRECTIONS) {
	// The fallback lives only at this read-only boundary, tries exactly one
	// alternative and never mutates the run's own provider.
	describe(`review fallback from a ${direction.from} limit to ${direction.to}`, () => {
		test(`tries ${direction.to} once and records origin, target, reason and outcome`, async () => {
			const calls: string[] = [];
			const events: EmittedEvent[] = [];
			const router = routerFor(calls, direction, direction.held, {
				verdict: 'findings',
				detail: 'missing test',
			});

			const executionInput = input(events, { providerId: direction.from });
			expect(await router.review(executionInput)).toEqual({
				verdict: 'findings',
				detail: 'missing test',
			});
			expect(calls).toEqual([direction.from, direction.to]);
			expect(executionInput.providerId).toBe(direction.from);
			expect(events).toEqual([{
				kind: 'run.review-fallback',
				payload: {
					from: direction.from,
					to: direction.to,
					phase: 'review',
					reason: direction.held.kind,
					message: direction.held.message,
					retryAt: direction.held.retryAt,
					outcome: 'findings',
				},
			}]);
		});

		test('preserves the executor session and worktree for the fallback review', async () => {
			const seen: RuntimeExecutionInput[] = [];
			const capture: RuntimeReviewer = {
				review: async (received) => {
					seen.push(received);
					return { verdict: 'clean' };
				},
			};
			const held: RuntimeReviewer = { review: async () => { throw direction.held; } };
			const router = new AgentReviewerRouter(direction.from === 'claude'
				? { claude: held, codex: capture }
				: { claude: capture, codex: held });

			await router.review(input([], { providerId: direction.from }));
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({
				sessionId: 'session-1',
				cwd: '/worktree',
				providerId: direction.from,
			});
		});

		test(`records a refused attempt and keeps the original ${direction.from} hold`, async () => {
			const calls: string[] = [];
			const events: EmittedEvent[] = [];
			const refusal = new ProviderCallError(direction.to, 'auth-required', 'Not authenticated.');
			const router = routerFor(calls, direction, direction.held, refusal);

			await expect(router.review(input(events, { providerId: direction.from })))
				.rejects.toThrow(direction.held);
			expect(calls).toEqual([direction.from, direction.to]);
			expect(events).toEqual([{
				kind: 'run.review-fallback',
				payload: {
					from: direction.from,
					to: direction.to,
					phase: 'review',
					reason: direction.held.kind,
					message: direction.held.message,
					retryAt: direction.held.retryAt,
					outcome: 'refused',
					error: 'Not authenticated.',
					errorKind: 'auth-required',
				},
			}]);
		});

		// A limit on the alternative settles as this fallback's outcome and
		// restores the origin's hold: the review is never handed back.
		test(`stops at ${direction.to} when the alternative is held too`, async () => {
			const calls: string[] = [];
			const events: EmittedEvent[] = [];
			const alternativeLimit = new ProviderCallError(
				direction.to,
				'usage-limit',
				'Alternative usage limit reached.',
			);
			const router = routerFor(calls, direction, direction.held, alternativeLimit);

			await expect(router.review(input(events, { providerId: direction.from })))
				.rejects.toThrow(direction.held);
			expect(calls).toEqual([direction.from, direction.to]);
			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toMatchObject({
				from: direction.from,
				to: direction.to,
				outcome: 'refused',
				errorKind: 'usage-limit',
			});
		});

		test('leaves an aborted review to its own interruption instead of spawning the alternative', async () => {
			const calls: string[] = [];
			const events: EmittedEvent[] = [];
			const controller = new AbortController();
			const aborting: RuntimeReviewer = {
				review: async () => {
					calls.push(direction.from);
					controller.abort();
					throw direction.held;
				},
			};
			const alternative = reviewer(calls, direction.to, { verdict: 'clean' });
			const router = new AgentReviewerRouter(direction.from === 'claude'
				? { claude: aborting, codex: alternative }
				: { claude: alternative, codex: aborting });

			await expect(router.review(input(events, {
				providerId: direction.from,
				signal: controller.signal,
			}))).rejects.toThrow(direction.held);
			expect(calls).toEqual([direction.from]);
			expect(events).toEqual([]);
		});

		test('never answers a failure that is not a subscription limit', async () => {
			for (const kind of INADMISSIBLE_KINDS) {
				const calls: string[] = [];
				const events: EmittedEvent[] = [];
				const failure = new ProviderCallError(direction.from, kind, `${kind} on ${direction.from}.`);
				const router = routerFor(calls, direction, failure, { verdict: 'clean' });

				await expect(router.review(input(events, { providerId: direction.from })))
					.rejects.toThrow(failure);
				expect(calls).toEqual([direction.from]);
				expect(events).toEqual([]);
			}
		});

		test('never answers a plain failure or a limit reported for another provider', async () => {
			const calls: string[] = [];
			const events: EmittedEvent[] = [];
			const plain = new Error('the reviewer crashed');
			await expect(routerFor(calls, direction, plain, { verdict: 'clean' })
				.review(input(events, { providerId: direction.from }))).rejects.toThrow(plain);

			const foreign = new ProviderCallError(direction.to, 'usage-limit', 'Limit on the other side.');
			await expect(routerFor(calls, direction, foreign, { verdict: 'clean' })
				.review(input(events, { providerId: direction.from }))).rejects.toThrow(foreign);

			expect(calls).toEqual([direction.from, direction.from]);
			expect(events).toEqual([]);
		});
	});
}
