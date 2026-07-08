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
	/**
	 * Working branch name for this PRD cycle. Not consumed by decideNextAction
	 * itself; read by the outer runSidecarLoop (US-003, CAM-189) as the
	 * `source` provenance field when filing SUGGESTION follow-up issues.
	 */
	branchName?: string;
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
		findings?: Array<{ severity: string; file?: string; line?: number; text: string }>;
		/** Fire-once marker written by the sidecar (runSidecarLoop, post-clearActive;
		 *  see ADR 0013) before dispatching auto-ship on a 'complete' + CLEAN result.
		 *  When present, the auto-ship dispatch is skipped, preventing re-dispatch
		 *  across sidecar restarts / in-place binary swaps. */
		autoShipDispatchedAt?: string;
	};
}

/** The actions the supervisor can take. */
export type SupervisorAction =
	| { kind: 'implement'; storyId: string }
	| { kind: 'review' }
	/** Terminal: all non-operator stories pass and review is terminal.
	 *  When the cap was reached with a non-terminal pending verdict (e.g.
	 *  'FIXES_PENDING:1'), promoteVerdictTo signals the caller must persist
	 *  'MAX_ROUNDS_DEBT' as the stored lastVerdict (the function itself is pure
	 *  and cannot write prd.review). Absent when lastVerdict is already terminal
	 *  ('CLEAN' or 'MAX_ROUNDS_DEBT') or null. */
	| { kind: 'complete'; promoteVerdictTo?: 'MAX_ROUNDS_DEBT' }
	/** All implementable work is done and reviewed clean; one or more
	 *  operator-required ceremonies remain. The autonomous loop stops and hands
	 *  off to the operator. Carries the ids of the pending operator stories.
	 *  promoteVerdictTo follows the same contract as the 'complete' variant. */
	| { kind: 'await-operator'; pendingStoryIds: string[]; promoteVerdictTo?: 'MAX_ROUNDS_DEBT' }
	/** Degenerate guard: an implementable story exists but has no id. */
	| { kind: 'blocked-no-implementable' };

/** Default max review rounds, mirrors cam-review.md. */
export const DEFAULT_MAX_ROUNDS = 3;

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

	// --- Resolve review state (needed by Case 1 US-008 guard and terminal check) ---
	const review = prd.review;
	const roundsCompleted = review?.roundsCompleted ?? 0;
	const maxRounds = review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
	const lastVerdict = review?.lastVerdict ?? null;

	// US-008 guard: MAX_ROUNDS_DEBT is the non-convergence terminal. At this
	// state, skip implement dispatch even if passes:false stories exist. Orphan
	// fix stories left before the terminal was detected must not re-trigger the
	// implement loop. CLEAN is NOT guarded: CLEAN + pending stories is a valid
	// scenario (review passed, but more work was added by the operator) and
	// should still route to implement (Case 1 preserves its priority).
	const verdictIsMaxDebt = lastVerdict === 'MAX_ROUNDS_DEBT';

	// --- 1. Dispatch implementer if any implementable story remains ---
	if (implementableIncomplete.length > 0 && !verdictIsMaxDebt) {
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

	// At this point: all NON-operator stories pass (or review is already terminal).
	// Operator-required stories may still be incomplete, but they do NOT block the
	// review cycle. The operator ceremony is gated only AFTER review is terminal.

	// Review is terminal when the round cap is reached OR the last verdict is a
	// terminal one (CLEAN / MAX_ROUNDS_DEBT).
	const reviewTerminal =
		roundsCompleted >= maxRounds ||
		(lastVerdict !== null && TERMINAL_VERDICTS.has(lastVerdict));

	// --- 2. Review not yet terminal (null / FIXES_PENDING / under cap) -> review ---
	if (!reviewTerminal) {
		return { kind: 'review' };
	}

	// Promotion signal: when the cap is the trigger for review-terminal AND
	// lastVerdict is a non-null, non-terminal value (e.g. 'FIXES_PENDING:1'),
	// the caller (loop.ts, US-002) must persist 'MAX_ROUNDS_DEBT' as the stored
	// lastVerdict. decideNextAction is pure (no I/O), so it signals via the
	// return value rather than writing prd.review directly.
	// Not set when lastVerdict is already terminal ('CLEAN' / 'MAX_ROUNDS_DEBT')
	// or null (nothing to promote).
	const promoteVerdictTo: 'MAX_ROUNDS_DEBT' | undefined =
		roundsCompleted >= maxRounds && lastVerdict !== null && !TERMINAL_VERDICTS.has(lastVerdict)
			? 'MAX_ROUNDS_DEBT'
			: undefined;

	// --- 3. Review terminal but operator ceremonies remain -> await operator ---
	if (operatorIncomplete.length > 0) {
		const pendingStoryIds = operatorIncomplete
			.map((s) => s.id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0);
		return { kind: 'await-operator', pendingStoryIds, promoteVerdictTo };
	}

	// --- 4. All stories pass (incl. operator) AND review terminal -> complete ---
	return { kind: 'complete', promoteVerdictTo };
}
