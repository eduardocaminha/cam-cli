import { randomUUID } from 'node:crypto';

import { type AgentProviderId, ProviderCallError, type ProviderErrorKind } from './agent-session.ts';
import { collectChange } from './claude-cli-reviewer.ts';
import { defaultRunGit, type GitCommandRunner } from './git-runtime.ts';
import type { ModelSlot } from './model-settings.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
} from './run-runtime.ts';
import type { RunEvent } from './run-store.ts';

/**
 * The durable record of one executor handoff (GSHIP-722): where it came from,
 * where it went, why it was tried and what the attempt produced. One event per
 * run -- a run spends at most one handoff -- written once the attempt has
 * settled, so the log never claims a handoff that has no outcome.
 */
export const EXECUTOR_HANDOFF_EVENT = 'run.executor-handoff';

/**
 * Only a subscription limit reached before any turn completed buys the
 * alternative executor. Every other failure -- auth, refused model, transport,
 * protocol, cancellation, or a kind Gateship could not classify -- keeps the
 * run on its own provider, because retrying elsewhere would answer a question
 * the operator never asked.
 */
const EXECUTOR_HANDOFF_REASONS: readonly ProviderErrorKind[] = ['usage-limit', 'rate-limited'];

/** The single alternative each origin may hand the executor role to. */
const EXECUTOR_HANDOFF_TARGET: Readonly<Record<AgentProviderId, AgentProviderId>> = {
	claude: 'codex',
	codex: 'claude',
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isProvider(value: unknown): value is AgentProviderId {
	return value === 'claude' || value === 'codex';
}

/**
 * One run's executor handoff, replayed from its durable event -- present once
 * a transfer was tried, absent while the run never spent it (GSHIP-722).
 * `outcome` is `'refused'` only when the alternative itself failed to settle;
 * any other value is the result the alternative's own execution reported.
 */
export interface ExecutorHandoffRecord {
	from: AgentProviderId;
	to: AgentProviderId;
	reason: ProviderErrorKind;
	message: string;
	sessionId: string;
	outcome: string;
	createdAt: string;
	model?: string;
	effort?: string;
}

/**
 * The run's own executor handoff, or `null` if it never tried one. Reads the
 * latest matching event rather than assuming there is exactly one: a run
 * spends at most one handoff by construction (the router never offers a
 * second attempt once one is recorded), so "latest" and "only" agree in
 * practice, and reading defensively costs nothing.
 */
export function selectExecutorHandoff(events: readonly RunEvent[]): ExecutorHandoffRecord | null {
	const event = events.findLast((candidate) => candidate.kind === EXECUTOR_HANDOFF_EVENT);
	if (event === undefined) return null;
	const { from, to, reason, message, sessionId, outcome, model, effort } = event.payload;
	if (!isProvider(from) || !isProvider(to)) return null;
	if (typeof reason !== 'string' || typeof sessionId !== 'string' || sessionId.length === 0) return null;
	if (typeof outcome !== 'string') return null;
	return {
		from,
		to,
		reason: reason as ProviderErrorKind,
		message: typeof message === 'string' ? message : '',
		sessionId,
		outcome,
		createdAt: event.createdAt,
		...(typeof model === 'string' ? { model } : {}),
		...(typeof effort === 'string' ? { effort } : {}),
	};
}

export interface AgentExecutorRouterOptions {
	executors: Readonly<Record<AgentProviderId, RuntimeExecutor>>;
	/** Collects the working-tree state the alternative's new session opens with. */
	runGit?: GitCommandRunner;
	/** The alternative's brand new native session id; never the origin's. */
	newSessionId?: () => string;
	/** Read only to record what the alternative was configured with (GSHIP-722), never to choose it. */
	resolveModel?: (providerId: AgentProviderId) => ModelSlot;
}

/**
 * Routes an execution to the run's own provider and, only when the run's
 * durable state admits it (`RuntimeExecutionInput.executorHandoffAllowed`,
 * decided by `RunRuntime` from the operator's opt-in and this run's own
 * history), answers a subscription limit with exactly one attempt on the
 * other provider, in either direction.
 *
 * Unlike the read-only reviewer fallback this pairs with (GSHIP-709,
 * GSHIP-721), an execution mutates the worktree and is normally resumed
 * turn after turn on the same native session -- so the alternative can never
 * just replay the same input. It opens its own brand new session (never the
 * origin's sessionId) and receives a handoff built from the run's current
 * diff and working-tree status instead of the origin's initial prompt.
 * `RunRuntime` alone decides whether a later round continues on that
 * alternative, through `input.executorRoute` -- never through `providerId`,
 * which keeps naming the run's own origin for every other reader, the
 * reviewer included, because only the executor role ever transfers.
 */
export class AgentExecutorRouter implements RuntimeExecutor {
	readonly #executors: Readonly<Record<AgentProviderId, RuntimeExecutor>>;
	readonly #runGit: GitCommandRunner;
	readonly #newSessionId: () => string;
	readonly #resolveModel: ((providerId: AgentProviderId) => ModelSlot) | undefined;

	constructor(options: AgentExecutorRouterOptions) {
		this.#executors = options.executors;
		this.#runGit = options.runGit ?? defaultRunGit;
		this.#newSessionId = options.newSessionId ?? randomUUID;
		this.#resolveModel = options.resolveModel;
	}

	async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
		const route = input.executorRoute;
		if (route !== undefined) {
			// This run already spent its one handoff successfully: keep resuming
			// the alternate's own native session directly, with no new attempt on
			// the origin and no second transfer. `providerId`/`sessionId` on
			// `input` still name the run's own origin -- for the reviewer, not for
			// this call -- so only the routed copy below is overridden.
			return await this.#executors[route.providerId].execute({
				...input,
				providerId: route.providerId,
				sessionId: route.sessionId,
				resume: true,
				// The origin's own session column must never be overwritten by an
				// alternate provider's own assigned id.
				setSessionId: undefined,
			});
		}
		const providerId = input.providerId ?? 'claude';
		try {
			return await this.#executors[providerId].execute(input);
		} catch (error) {
			const fallback = this.#fallbackProvider(providerId, error, input);
			if (fallback === null) throw error;
			return await this.#executeWithHandoff(input, providerId, fallback, error as ProviderCallError);
		}
	}

	/**
	 * The alternative this failure admits, or `null` to let the original error
	 * stand. `executorHandoffAllowed` is the run's own durable gate: absent or
	 * false refuses every attempt, whether the opt-in is off or this run
	 * already spent its one handoff. The limit must be the origin's own: a
	 * failure carrying another provider's name is not evidence that this one
	 * is held.
	 */
	#fallbackProvider(
		providerId: AgentProviderId,
		error: unknown,
		input: RuntimeExecutionInput,
	): AgentProviderId | null {
		if (input.executorHandoffAllowed !== true) return null;
		if (!(error instanceof ProviderCallError)) return null;
		if (error.provider !== providerId) return null;
		if (!EXECUTOR_HANDOFF_REASONS.includes(error.kind)) return null;
		if (input.signal.aborted) return null;
		return EXECUTOR_HANDOFF_TARGET[providerId];
	}

	/**
	 * The one alternative attempt: a fresh native session opened with a handoff
	 * derived from the run's durable state and its current diff, never the
	 * origin's sessionId and never a blind replay of the initial prompt.
	 * Whatever it fails with -- its own limit included -- settles as this
	 * handoff's outcome and restores the origin's error, so the run can never
	 * ping back to the provider it started on.
	 */
	async #executeWithHandoff(
		input: RuntimeExecutionInput,
		origin: AgentProviderId,
		fallback: AgentProviderId,
		held: ProviderCallError,
	): Promise<RuntimeExecutionResult> {
		const change = collectChange(this.#runGit, input.cwd);
		let sessionId = this.#newSessionId();
		const handoffInput: RuntimeExecutionInput = {
			...input,
			providerId: fallback,
			sessionId,
			resume: false,
			executorHandoffAllowed: false,
			executorHandoff: {
				fromProvider: origin,
				reason: held.kind,
				status: change.status,
				diff: change.diff,
			},
			// Captured here, never through the run's own `setSessionId`: that
			// channel writes to the origin's historical session column, and this
			// is a different provider's own native id.
			setSessionId: (reported) => { sessionId = reported; },
		};
		try {
			const result = await this.#executors[fallback].execute(handoffInput);
			this.#emitHandoff(input, origin, fallback, held, sessionId, { outcome: result.outcome });
			return result;
		} catch (error) {
			this.#emitHandoff(input, origin, fallback, held, sessionId, {
				outcome: 'refused',
				error: errorMessage(error),
				...(error instanceof ProviderCallError ? { errorKind: error.kind } : {}),
			});
			throw held;
		}
	}

	#emitHandoff(
		input: RuntimeExecutionInput,
		origin: AgentProviderId,
		fallback: AgentProviderId,
		held: ProviderCallError,
		sessionId: string,
		result: Record<string, unknown>,
	): void {
		const slot = this.#resolveModel?.(fallback) ?? {};
		input.emit(EXECUTOR_HANDOFF_EVENT, {
			from: origin,
			to: fallback,
			role: 'executor',
			reason: held.kind,
			message: held.message,
			...(slot.model === undefined ? {} : { model: slot.model }),
			...(slot.effort === undefined ? {} : { effort: slot.effort }),
			// A run spends at most one handoff (GSHIP-722): there is no second to count.
			attempt: 1,
			sessionId,
			...result,
		});
	}
}
