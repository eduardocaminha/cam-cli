// src/supervisor/rearm-preconditions.ts
//
// Pure precondition evaluator for the sidecar's implementing re-arm (US-003,
// CAM-195, Defect 1): resuming an in-flight PRD stuck at phase:implementing
// while active:false, without requiring an operator `cam next` to recover.
//
// Distinct from evaluateDrainPreconditions (drain-preconditions.ts): that
// evaluator gates the meta-loop's NEW-cycle auto-dispatch (worker_isolation=
// container + plan_approval=auto). Re-arm resumes an ALREADY-in-flight PRD and
// must work regardless of meta_loop/worker_isolation config -- it is a general
// sidecar resilience fix, not an autonomy escalation, so it is wired
// unconditionally by the caller (sidecar.ts).
//
// Design invariants:
//   - Zero I/O. All inputs are pre-resolved by the caller.
//   - Fail-closed: any doubt refuses (no rearm).
//   - phase:idle is the parked discriminator and never resumes (AC2): only an
//     EXACT phase==='implementing' match rearms. Since LoopPhase is a
//     mutually-exclusive enum, this one check also covers "no plan/ship phase
//     in progress" -- there is no separate check for that condition.

import type { LoopPhase } from '../commands/status.ts';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Discriminated result returned by `evaluateRearmPreconditions`.
 *
 *   - `{ rearm: true }` -- all preconditions satisfied; the sidecar should
 *     re-arm implementing (write phase:implementing, deriving active:true).
 *   - `{ rearm: false; reason: 'not-in-flight' }` -- prd.json has no pending
 *     non-operator stories (or is blocked at the MAX_ROUNDS_DEBT terminal;
 *     see the `prdInFlight` input doc below).
 *   - `{ rearm: false; reason: 'not-implementing-phase' }` -- the loop phase
 *     is not exactly 'implementing' (includes phase:idle, the parked
 *     discriminator, which must never auto-resume).
 *   - `{ rearm: false; reason: 'merge-watch-pending' }` -- a CI-gated
 *     merge-watch is in progress; resuming implement would race it.
 */
export type RearmDecision =
	| { rearm: true }
	| { rearm: false; reason: 'not-in-flight' | 'not-implementing-phase' | 'merge-watch-pending' };

// ---------------------------------------------------------------------------
// Inputs type
// ---------------------------------------------------------------------------

/**
 * All inputs required by `evaluateRearmPreconditions`. Injected by the
 * caller; this module performs no I/O to resolve them.
 */
export interface RearmPreconditionInputs {
	/**
	 * The current loop phase read from cam-loop.local.md. `undefined` (file
	 * absent/unparseable/phase-less) is treated the same as any non-
	 * 'implementing' value: refuse.
	 */
	phase: LoopPhase | undefined;

	/**
	 * Whether scripts/cam/prd.json is in-flight: at least one non-operator
	 * story has passes:false. Callers should pass makeHasPendingStories()'s
	 * result directly -- that seam already returns false when the review
	 * verdict is the MAX_ROUNDS_DEBT blocked terminal (CAM-109 guard), which
	 * is what makes "no blocked terminal" fall out of this one input rather
	 * than needing a separate check here.
	 */
	prdInFlight: boolean;

	/** Whether the merge-watch marker file (MERGE_WATCH_FILENAME) is present. */
	mergeWatchPresent: boolean;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Fail-closed re-arm gate (US-003, CAM-195, Defect 1).
 *
 * Checks are ordered: in-flight first, then phase, then merge-watch. The
 * first failing check determines the returned reason; subsequent checks are
 * not evaluated once a failure is found.
 *
 * This function is a pure predicate: given the same inputs it always returns
 * the same result, with no observable side-effects and no I/O.
 *
 * @param inputs  Injected precondition inputs (phase, in-flight, merge-watch).
 * @returns       `{ rearm: true }` when all preconditions pass, or
 *                `{ rearm: false; reason }` naming the first failing precondition.
 */
export function evaluateRearmPreconditions(inputs: RearmPreconditionInputs): RearmDecision {
	const { phase, prdInFlight, mergeWatchPresent } = inputs;

	if (!prdInFlight) {
		return { rearm: false, reason: 'not-in-flight' };
	}

	if (phase !== 'implementing') {
		return { rearm: false, reason: 'not-implementing-phase' };
	}

	if (mergeWatchPresent) {
		return { rearm: false, reason: 'merge-watch-pending' };
	}

	return { rearm: true };
}
