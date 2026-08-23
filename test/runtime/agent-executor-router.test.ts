import { describe, expect, test } from 'bun:test';

import {
	AgentExecutorRouter,
	EXECUTOR_HANDOFF_EVENT,
	selectExecutorHandoff,
} from '../../src/runtime/agent-executor-router.ts';
import {
	type AgentProviderId,
	PROVIDER_ERROR_KINDS,
	ProviderCallError,
} from '../../src/runtime/agent-session.ts';
import type { GitCommandRunner } from '../../src/runtime/git-runtime.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
} from '../../src/runtime/run-runtime.ts';
import type { RunEvent } from '../../src/runtime/run-store.ts';

interface EmittedEvent {
	kind: string;
	payload?: Record<string, unknown>;
}

/** Wraps a router's own emitted events as durable `RunEvent`s for `selectExecutorHandoff`. */
function asRunEvents(events: readonly EmittedEvent[]): RunEvent[] {
	return events.map((event, index) => ({
		seq: index,
		runId: 'run-1',
		kind: event.kind,
		fromState: 'working',
		toState: 'working',
		payload: event.payload ?? {},
		createdAt: '2026-08-23T00:00:00.000Z',
		eventClass: 'decision',
	}));
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

function executor(
	calls: RuntimeExecutionInput[],
	result: RuntimeExecutionResult | Error,
): RuntimeExecutor {
	return {
		execute: async (received) => {
			calls.push(received);
			if (result instanceof Error) throw result;
			return result;
		},
	};
}

const NO_GIT: GitCommandRunner = () => ({ exitCode: 0, stdout: '', stderr: '' });

test('executor router follows the provider persisted on each run', async () => {
	const calls: string[] = [];
	const one = (name: string): RuntimeExecutor => ({
		execute: async () => {
			calls.push(name);
			return { outcome: 'completed' };
		},
	});
	const router = new AgentExecutorRouter({
		executors: { claude: one('claude'), codex: one('codex') },
		runGit: NO_GIT,
	});

	await router.execute(input([], { providerId: 'codex' }));
	await router.execute(input([], { providerId: 'claude' }));
	expect(calls).toEqual(['codex', 'claude']);
});

test('never attempts a handoff when the run has not opted in', async () => {
	const held = new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.');
	const calls: RuntimeExecutionInput[] = [];
	const events: EmittedEvent[] = [];
	const router = new AgentExecutorRouter({
		executors: {
			claude: executor(calls, held),
			codex: executor(calls, { outcome: 'completed' }),
		},
		runGit: NO_GIT,
	});

	await expect(router.execute(input(events, { providerId: 'claude' }))).rejects.toThrow(held);
	expect(calls).toHaveLength(1);
	expect(events).toEqual([]);

	// Explicitly false reads the same as absent: the gate is durable state
	// RunRuntime computes, never inferred from anything else on the input.
	const eventsFalse: EmittedEvent[] = [];
	await expect(router.execute(input(eventsFalse, {
		providerId: 'claude',
		executorHandoffAllowed: false,
	}))).rejects.toThrow(held);
	expect(eventsFalse).toEqual([]);
});

interface Direction {
	from: AgentProviderId;
	to: AgentProviderId;
	held: ProviderCallError;
}

const DIRECTIONS: readonly Direction[] = [
	{
		from: 'claude',
		to: 'codex',
		held: new ProviderCallError('claude', 'usage-limit', 'Claude usage limit reached.'),
	},
	{
		from: 'codex',
		to: 'claude',
		held: new ProviderCallError('codex', 'rate-limited', 'Codex is rate limited.'),
	},
];

function routerFor(
	calls: RuntimeExecutionInput[],
	direction: Direction,
	origin: RuntimeExecutionResult | Error,
	alternative: RuntimeExecutionResult | Error,
	options: { runGit?: GitCommandRunner; newSessionId?: () => string; resolveModel?: (p: AgentProviderId) => { model?: string; effort?: string } } = {},
): AgentExecutorRouter {
	const results: Record<AgentProviderId, RuntimeExecutionResult | Error> = direction.from === 'claude'
		? { claude: origin, codex: alternative }
		: { claude: alternative, codex: origin };
	return new AgentExecutorRouter({
		executors: {
			claude: executor(calls, results.claude),
			codex: executor(calls, results.codex),
		},
		runGit: options.runGit ?? NO_GIT,
		...(options.newSessionId === undefined ? {} : { newSessionId: options.newSessionId }),
		...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
	});
}

const INADMISSIBLE_KINDS = PROVIDER_ERROR_KINDS
	.filter((kind) => kind !== 'usage-limit' && kind !== 'rate-limited');

for (const direction of DIRECTIONS) {
	describe(`executor handoff from a ${direction.from} limit to ${direction.to}`, () => {
		test(`opens a new native ${direction.to} session and records origin, target, reason and outcome`, async () => {
			const calls: RuntimeExecutionInput[] = [];
			const events: EmittedEvent[] = [];
			const changeGit: GitCommandRunner = (_cwd, args) => {
				if (args[0] === 'status') return { exitCode: 0, stdout: ' M src/a.ts', stderr: '' };
				return { exitCode: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts', stderr: '' };
			};
			const router = routerFor(
				calls,
				direction,
				direction.held,
				{ outcome: 'completed', summary: 'handed off cleanly' },
				{ runGit: changeGit, newSessionId: () => 'guessed-session' },
			);

			const executionInput = input(events, {
				providerId: direction.from,
				sessionId: 'origin-session',
				executorHandoffAllowed: true,
			});
			expect(await router.execute(executionInput)).toEqual({
				outcome: 'completed',
				summary: 'handed off cleanly',
			});
			expect(calls).toHaveLength(2);
			// The origin's own turn is untouched.
			expect(calls[0]).toMatchObject({ providerId: direction.from, sessionId: 'origin-session' });
			// The alternative opens its own brand new session: never the origin's
			// sessionId, never a resume, and it carries the durable-state handoff.
			const alt = calls[1];
			expect(alt).toMatchObject({
				providerId: direction.to,
				sessionId: 'guessed-session',
				resume: false,
				executorHandoffAllowed: false,
			});
			expect(alt?.executorHandoff).toEqual({
				fromProvider: direction.from,
				reason: direction.held.kind,
				status: 'M src/a.ts',
				diff: 'diff --git a/src/a.ts b/src/a.ts',
			});
			// Every other field the run built for this round rides along unchanged.
			expect(alt?.issueId).toBe('CAM-1');
			expect(alt?.cwd).toBe('/worktree');

			expect(events).toEqual([{
				kind: EXECUTOR_HANDOFF_EVENT,
				payload: {
					from: direction.from,
					to: direction.to,
					role: 'executor',
					reason: direction.held.kind,
					message: direction.held.message,
					attempt: 1,
					sessionId: 'guessed-session',
					outcome: 'completed',
				},
			}]);
			expect(selectExecutorHandoff(asRunEvents(events))).toEqual({
				from: direction.from,
				to: direction.to,
				reason: direction.held.kind,
				message: direction.held.message,
				sessionId: 'guessed-session',
				outcome: 'completed',
				createdAt: '2026-08-23T00:00:00.000Z',
			});
		});

		test('captures the alternative\'s own reported session id, not the guessed one', async () => {
			const calls: RuntimeExecutionInput[] = [];
			const events: EmittedEvent[] = [];
			const reporting: RuntimeExecutor = {
				execute: async (received) => {
					calls.push(received);
					received.setSessionId?.('provider-assigned-id');
					return { outcome: 'completed' };
				},
			};
			const held: RuntimeExecutor = { execute: async () => { throw direction.held; } };
			const router = new AgentExecutorRouter({
				executors: direction.from === 'claude'
					? { claude: held, codex: reporting }
					: { claude: reporting, codex: held },
				runGit: NO_GIT,
				newSessionId: () => 'guessed-session',
			});

			await router.execute(input(events, { providerId: direction.from, executorHandoffAllowed: true }));
			expect(events[0]?.payload?.['sessionId']).toBe('provider-assigned-id');
		});

		test('includes the model and effort the alternative was configured with', async () => {
			const calls: RuntimeExecutionInput[] = [];
			const events: EmittedEvent[] = [];
			const router = routerFor(
				calls,
				direction,
				direction.held,
				{ outcome: 'completed' },
				{ resolveModel: (provider) => (provider === direction.to ? { model: 'opus', effort: 'high' } : {}) },
			);

			await router.execute(input(events, { providerId: direction.from, executorHandoffAllowed: true }));
			expect(events[0]?.payload).toMatchObject({ model: 'opus', effort: 'high' });
		});

		test(`records a refused attempt and keeps the original ${direction.from} hold`, async () => {
			const calls: RuntimeExecutionInput[] = [];
			const events: EmittedEvent[] = [];
			const refusal = new ProviderCallError(direction.to, 'auth-required', 'Not authenticated.');
			const router = routerFor(calls, direction, direction.held, refusal);

			await expect(router.execute(input(events, { providerId: direction.from, executorHandoffAllowed: true })))
				.rejects.toThrow(direction.held);
			expect(calls).toHaveLength(2);
			expect(events).toEqual([{
				kind: EXECUTOR_HANDOFF_EVENT,
				payload: {
					from: direction.from,
					to: direction.to,
					role: 'executor',
					reason: direction.held.kind,
					message: direction.held.message,
					attempt: 1,
					sessionId: expect.any(String),
					outcome: 'refused',
					error: 'Not authenticated.',
					errorKind: 'auth-required',
				},
			}]);
		});

		test(`stops at ${direction.to} when the alternative is held too`, async () => {
			const calls: RuntimeExecutionInput[] = [];
			const events: EmittedEvent[] = [];
			const alternativeLimit = new ProviderCallError(direction.to, 'usage-limit', 'Alternative usage limit reached.');
			const router = routerFor(calls, direction, direction.held, alternativeLimit);

			await expect(router.execute(input(events, { providerId: direction.from, executorHandoffAllowed: true })))
				.rejects.toThrow(direction.held);
			expect(calls).toHaveLength(2);
			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toMatchObject({ outcome: 'refused', errorKind: 'usage-limit' });
		});

		test('leaves an aborted execution to its own interruption instead of spawning the alternative', async () => {
			const calls: RuntimeExecutionInput[] = [];
			const events: EmittedEvent[] = [];
			const controller = new AbortController();
			const aborting: RuntimeExecutor = {
				execute: async (received) => {
					calls.push(received);
					controller.abort();
					throw direction.held;
				},
			};
			const alternative = executor(calls, { outcome: 'completed' });
			const router = new AgentExecutorRouter({
				executors: direction.from === 'claude'
					? { claude: aborting, codex: alternative }
					: { claude: alternative, codex: aborting },
				runGit: NO_GIT,
			});

			await expect(router.execute(input(events, {
				providerId: direction.from,
				executorHandoffAllowed: true,
				signal: controller.signal,
			}))).rejects.toThrow(direction.held);
			expect(calls).toHaveLength(1);
			expect(events).toEqual([]);
		});

		test('never answers a failure that is not a subscription limit', async () => {
			for (const kind of INADMISSIBLE_KINDS) {
				const calls: RuntimeExecutionInput[] = [];
				const events: EmittedEvent[] = [];
				const failure = new ProviderCallError(direction.from, kind, `${kind} on ${direction.from}.`);
				const router = routerFor(calls, direction, failure, { outcome: 'completed' });

				await expect(router.execute(input(events, { providerId: direction.from, executorHandoffAllowed: true })))
					.rejects.toThrow(failure);
				expect(calls).toHaveLength(1);
				expect(events).toEqual([]);
			}
		});

		test('never answers a plain failure or a limit reported for another provider', async () => {
			const calls: RuntimeExecutionInput[] = [];
			const events: EmittedEvent[] = [];
			const plain = new Error('the executor crashed');
			await expect(routerFor(calls, direction, plain, { outcome: 'completed' })
				.execute(input(events, { providerId: direction.from, executorHandoffAllowed: true })))
				.rejects.toThrow(plain);

			const foreign = new ProviderCallError(direction.to, 'usage-limit', 'Limit on the other side.');
			await expect(routerFor(calls, direction, foreign, { outcome: 'completed' })
				.execute(input(events, { providerId: direction.from, executorHandoffAllowed: true })))
				.rejects.toThrow(foreign);

			expect(calls).toHaveLength(2);
			expect(events).toEqual([]);
		});
	});
}

describe('selectExecutorHandoff', () => {
	test('reads null from a run that never recorded a handoff', () => {
		expect(selectExecutorHandoff([])).toBeNull();
	});

	test('ignores an event with a malformed payload', () => {
		const malformed = asRunEvents([{ kind: EXECUTOR_HANDOFF_EVENT, payload: { from: 'claude' } }]);
		expect(selectExecutorHandoff(malformed)).toBeNull();
	});
});
