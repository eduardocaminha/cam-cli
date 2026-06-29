// src/supervisor/observe.ts
//
// Pure injectable decide-fn for the meta-loop observer (CAM-132, US-003).
//
// This module is intentionally free of all filesystem, network, and git I/O.
// The caller supplies the result of selectPlannableIssue (injected selector);
// this function applies dedup and drained-detection logic and returns either
// an event detail to emit or null (no emit this tick).
//
// Dedup state is a plain value passed in/out -- NOT persisted to disk (CAM-68).

import type { IssueEntry } from '../issues/types.ts';
import { computeWsjf } from '../issues/rank.ts';
import type { MetaLoopObserveEventDetail } from './events.ts';

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

/**
 * Opaque dedup state passed between observe ticks.
 * Initialize with { kind: 'none' } before the first tick.
 *
 * Invariant: this value is a plain in-memory object; it is never written to
 * disk. Callers must thread it explicitly across ticks.
 */
export type ObserveState =
	| { kind: 'none' }
	| { kind: 'selected'; id: string }
	| { kind: 'drained' };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Returned by observeDecide when the caller should emit an event.
 *   - detail: the MetaLoopObserveEventDetail to emit.
 *   - newState: the updated ObserveState to thread into the next tick.
 */
export interface ObserveDecideResult {
	detail: MetaLoopObserveEventDetail;
	newState: ObserveState;
}

// ---------------------------------------------------------------------------
// decide-fn
// ---------------------------------------------------------------------------

/**
 * Pure decide-fn for the meta-loop observer.
 *
 * @param selected  The result of selectPlannableIssue (injected by the caller;
 *                  not called internally -- no I/O inside this function).
 * @param lastState The dedup state from the previous tick.
 * @returns         An ObserveDecideResult to emit, or null when the selection
 *                  is unchanged (dedup: no event needed this tick).
 *
 * Dedup rules:
 *   - Same plannable id as last emit          -> null (no re-emit).
 *   - No plannable issue and already drained  -> null (no re-emit).
 *   - Any other transition                    -> emit.
 *
 * WSJF scalar: computed via computeWsjf (rank.ts). Falls back to 0 when the
 * issue carries no wsjf field or has jobSize <= 0 (mirrors rankIssues logic).
 *
 * Rank fallback: issue.rank ?? 0. The fallback is 0, a defined sentinel that
 * keeps the detail field type as `number` (never undefined).
 */
export function observeDecide(
	selected: IssueEntry | null,
	lastState: ObserveState,
): ObserveDecideResult | null {
	if (selected === null) {
		// Dedup: already emitted drained -- no re-emit.
		if (lastState.kind === 'drained') return null;

		return {
			detail: { drained: true },
			newState: { kind: 'drained' },
		};
	}

	// A plannable issue was found.
	// Dedup: same id as the last emitted selection -- no re-emit.
	if (lastState.kind === 'selected' && lastState.id === selected.id) {
		return null;
	}

	const { wsjf } = computeWsjf(selected);
	const rank = selected.rank ?? 0;

	return {
		detail: { wouldSelect: selected.id, rank, wsjf },
		newState: { kind: 'selected', id: selected.id },
	};
}
