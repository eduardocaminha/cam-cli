import { ProviderCallError, type AgentProviderId, type ProviderErrorKind } from './agent-session.ts';
import type {
	RuntimeExecutionInput,
	RuntimeReviewer,
	RuntimeReviewResult,
} from './run-runtime.ts';

/**
 * The durable record of one review fallback (GSHIP-709): where it came from,
 * where it went, why it was tried and what the attempt produced. One event per
 * attempt, written once the attempt has settled, so the log never claims a
 * fallback that has no outcome.
 */
export const REVIEW_FALLBACK_EVENT = 'run.review-fallback';

/**
 * Only a subscription limit reached before any verdict buys the alternative
 * reviewer. Every other failure -- auth, refused model, transport, protocol,
 * cancellation, or a kind Gateship could not classify -- keeps the run on its
 * own provider, because retrying elsewhere would answer a question the operator
 * never asked.
 */
const REVIEW_FALLBACK_REASONS: readonly ProviderErrorKind[] = ['usage-limit', 'rate-limited'];

/**
 * The single alternative each origin may try. GSHIP-721 completes the pair
 * GSHIP-709 opened in one direction, so a held Codex reviewer buys the same one
 * Claude attempt a held Claude reviewer buys on Codex.
 */
const REVIEW_FALLBACK: Readonly<Record<AgentProviderId, AgentProviderId>> = {
	claude: 'codex',
	codex: 'claude',
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Routes a review to the run's own provider and, only at this read-only
 * boundary, answers a subscription limit with exactly one attempt on the other
 * provider, in either direction.
 *
 * The run keeps its provider: nothing here mutates the record, the global
 * selection or the executor's session and worktree, so the alternative's
 * finding returns to the original executor and an unavailable executor still
 * rests on the existing waiting-provider state. A refused attempt is recorded
 * and then gets out of the way, rethrowing the origin's own error so the run
 * waits for the provider that actually holds it -- never for the alternative
 * that declined.
 */
export class AgentReviewerRouter implements RuntimeReviewer {
	readonly #reviewers: Readonly<Record<AgentProviderId, RuntimeReviewer>>;

	constructor(reviewers: Readonly<Record<AgentProviderId, RuntimeReviewer>>) {
		this.#reviewers = reviewers;
	}

	async review(input: RuntimeExecutionInput): Promise<RuntimeReviewResult> {
		const providerId = input.providerId ?? 'claude';
		try {
			return await this.#reviewers[providerId].review(input);
		} catch (error) {
			const fallback = this.#fallbackProvider(providerId, error, input);
			if (fallback === null) throw error;
			return await this.#reviewWithFallback(input, providerId, fallback, error as ProviderCallError);
		}
	}

	/**
	 * The alternative this failure admits, or `null` to let the original error
	 * stand. A verdict already produced never reaches here -- the reviewer
	 * returned it instead of throwing -- so no review that concluded is ever
	 * repeated, and an aborted run is left to its own interruption instead of
	 * spawning one more child. The limit must be the origin's own: a failure
	 * carrying another provider's name is not evidence that this one is held.
	 */
	#fallbackProvider(
		providerId: AgentProviderId,
		error: unknown,
		input: RuntimeExecutionInput,
	): AgentProviderId | null {
		if (!(error instanceof ProviderCallError)) return null;
		if (error.provider !== providerId) return null;
		if (!REVIEW_FALLBACK_REASONS.includes(error.kind)) return null;
		if (input.signal.aborted) return null;
		return REVIEW_FALLBACK[providerId];
	}

	/**
	 * The one alternative attempt, invoked on its own reviewer rather than back
	 * through this router: whatever it fails with -- its own limit included --
	 * settles as this fallback's outcome and restores the origin's error, so
	 * the two directions can never hand the review back and forth.
	 */
	async #reviewWithFallback(
		input: RuntimeExecutionInput,
		origin: AgentProviderId,
		fallback: AgentProviderId,
		held: ProviderCallError,
	): Promise<RuntimeReviewResult> {
		try {
			const review = await this.#reviewers[fallback].review(input);
			this.#emitFallback(input, origin, fallback, held, { outcome: review.verdict });
			return review;
		} catch (error) {
			this.#emitFallback(input, origin, fallback, held, {
				outcome: 'refused',
				error: errorMessage(error),
				...(error instanceof ProviderCallError ? { errorKind: error.kind } : {}),
			});
			throw held;
		}
	}

	#emitFallback(
		input: RuntimeExecutionInput,
		origin: AgentProviderId,
		fallback: AgentProviderId,
		held: ProviderCallError,
		result: Record<string, unknown>,
	): void {
		input.emit(REVIEW_FALLBACK_EVENT, {
			from: origin,
			to: fallback,
			phase: 'review',
			reason: held.kind,
			message: held.message,
			...(held.retryAt === undefined ? {} : { retryAt: held.retryAt }),
			...result,
		});
	}
}
