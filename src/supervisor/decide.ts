// src/supervisor/decide.ts
//
// Branch-decision matrix for the cam supervisor.
//
// Mirrors the cam-next.md matrix (Branch-decision section) as a pure function
// over a prd.json snapshot. No I/O: all inputs come from the caller.
//
// Decision order:
//   1. Any non-operator story with passes=false -> implement (highest priority, tie-break by id asc)
//   2. All non-operator stories pass AND review not terminal -> review
//   3. Review terminal AND an operator-required story is still pending -> await-operator
//   4. All stories pass (incl. operator) AND review terminal -> complete
//
// The review cycle runs BEFORE gating on operator ceremonies: an operator-
// required story (e.g. a manual E2E pass) must not block the automated review
// of code that is already implemented. Review first; the operator ceremony is
// the final seal over reviewed, stable code.

/** Minimal prd.json shape consumed by decideNextAction. */
export interface PrdSnapshot {
	userStories?: Array<{
		id?: string;
		title?: string;
		priority?: number;
		passes?: boolean;
		requires?: string | null;
		acceptanceCriteria?: string[];
		notes?: string;
	}>;
	review?: {
		roundsCompleted?: number;
		maxRounds?: number;
		lastVerdict?: string | null;
	};
}

/** The actions the supervisor can take. */
export type SupervisorAction =
	| { kind: 'implement'; storyId: string }
	| { kind: 'review' }
	| { kind: 'complete' }
	/** All implementable work is done and reviewed clean; one or more
	 *  operator-required ceremonies remain. The autonomous loop stops and hands
	 *  off to the operator. Carries the ids of the pending operator stories. */
	| { kind: 'await-operator'; pendingStoryIds: string[] }
	/** Degenerate guard: an implementable story exists but has no id. */
	| { kind: 'blocked-no-implementable' };

/** Default max review rounds, mirrors cam-review.md. */
const DEFAULT_MAX_ROUNDS = 3;

/** Terminal verdict strings from cam-review.md. */
export const TERMINAL_VERDICTS = new Set(['CLEAN', 'MAX_ROUNDS_DEBT']);

/**
 * Decide what the supervisor should do next given a prd.json snapshot.
 *
 * Pure function: no I/O, no side effects.
 *
 * @param prd - The parsed prd.json snapshot (or a compatible subset).
 * @returns The next action the supervisor should dispatch.
 */
export function decideNextAction(prd: PrdSnapshot): SupervisorAction {
	const stories = prd.userStories ?? [];

	// Partition stories into operator-required and implementable.
	const implementableIncomplete = stories.filter(
		(s) => s.passes !== true && s.requires !== 'operator',
	);
	const operatorIncomplete = stories.filter(
		(s) => s.passes !== true && s.requires === 'operator',
	);

	// --- 1. Dispatch implementer if any implementable story remains ---
	if (implementableIncomplete.length > 0) {
		// Tie-break: priority asc, then id asc.
		const sorted = [...implementableIncomplete].sort((a, b) => {
			const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
			const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
			if (pa !== pb) return pa - pb;
			// id asc: lexicographic is fine for US-NNN format
			const ia = a.id ?? '';
			const ib = b.id ?? '';
			return ia < ib ? -1 : ia > ib ? 1 : 0;
		});
		const first = sorted[0];
		// noUncheckedIndexedAccess: sorted[0] is `T | undefined`; guard covers it.
		if (first === undefined || !first.id) {
			// Degenerate: story has no id; fall through to blocked.
			return { kind: 'blocked-no-implementable' };
		}
		return { kind: 'implement', storyId: first.id };
	}

	// At this point: all NON-operator stories pass. Operator-required stories
	// may still be incomplete, but they do NOT block the review cycle. Resolve
	// review state first; the operator ceremony is gated only AFTER review is
	// terminal (see header comment).

	// --- Resolve review state ---
	const review = prd.review;
	const roundsCompleted = review?.roundsCompleted ?? 0;
	const maxRounds = review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
	const lastVerdict = review?.lastVerdict ?? null;

	// Review is terminal when the round cap is reached OR the last verdict is a
	// terminal one (CLEAN / MAX_ROUNDS_DEBT).
	const reviewTerminal =
		roundsCompleted >= maxRounds ||
		(lastVerdict !== null && TERMINAL_VERDICTS.has(lastVerdict));

	// --- 2. Review not yet terminal (null / FIXES_PENDING / under cap) -> review ---
	if (!reviewTerminal) {
		return { kind: 'review' };
	}

	// --- 3. Review terminal but operator ceremonies remain -> await operator ---
	if (operatorIncomplete.length > 0) {
		const pendingStoryIds = operatorIncomplete
			.map((s) => s.id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0);
		return { kind: 'await-operator', pendingStoryIds };
	}

	// --- 4. All stories pass (incl. operator) AND review terminal -> complete ---
	return { kind: 'complete' };
}
