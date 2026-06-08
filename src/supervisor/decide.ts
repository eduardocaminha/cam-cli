// src/supervisor/decide.ts
//
// Branch-decision matrix for the cam supervisor.
//
// Mirrors the cam-next.md matrix (Branch-decision section) as a pure function
// over a prd.json snapshot. No I/O: all inputs come from the caller.
//
// Decision order:
//   1. Any non-operator story with passes=false -> implement (highest priority, tie-break by id asc)
//   2. Any story with passes=false but ALL are operator-required -> blocked-no-implementable
//   3. All non-operator stories pass AND review is terminal -> complete
//   4. All non-operator stories pass AND review not terminal -> review

/** Minimal prd.json shape consumed by decideNextAction. */
export interface PrdSnapshot {
	userStories?: Array<{
		id?: string;
		priority?: number;
		passes?: boolean;
		requires?: string | null;
	}>;
	review?: {
		roundsCompleted?: number;
		maxRounds?: number;
		lastVerdict?: string | null;
	};
}

/** The four actions the supervisor can take. */
export type SupervisorAction =
	| { kind: 'implement'; storyId: string }
	| { kind: 'review' }
	| { kind: 'complete' }
	| { kind: 'blocked-no-implementable' };

/** Default max review rounds, mirrors cam-review.md. */
const DEFAULT_MAX_ROUNDS = 3;

/** Terminal verdict strings from cam-review.md. */
const TERMINAL_VERDICTS = new Set(['CLEAN', 'MAX_ROUNDS_DEBT']);

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

	// --- 2. All passes=false stories are operator-required ---
	// Non-operator stories are all passing. If any operator stories are still
	// incomplete, the autonomous loop cannot proceed (operator must do their
	// ceremony first). Return blocked-no-implementable so the loop exits cleanly.
	if (operatorIncomplete.length > 0) {
		return { kind: 'blocked-no-implementable' };
	}

	// At this point: all stories (including operator ones) have passes=true.

	// --- 3. Resolve review state ---
	const review = prd.review;
	const roundsCompleted = review?.roundsCompleted ?? 0;
	const maxRounds = review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
	const lastVerdict = review?.lastVerdict ?? null;

	// Cap row: roundsCompleted >= maxRounds -> complete regardless of lastVerdict.
	if (roundsCompleted >= maxRounds) {
		return { kind: 'complete' };
	}

	// Terminal verdict row.
	if (lastVerdict !== null && TERMINAL_VERDICTS.has(lastVerdict)) {
		return { kind: 'complete' };
	}

	// Not yet reviewed (null), or FIXES_PENDING (fixes have landed since last round)
	// -> dispatch review.
	return { kind: 'review' };
}
