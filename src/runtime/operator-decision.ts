import type { RunEvent } from './run-store.ts';

/**
 * Same shape as `PROPOSAL_LIMITS` (run-proposal.ts): a count and a per-item
 * size, both enforced at read time (GSHIP-630).
 */
export const OPERATOR_DECISION_LIMITS = {
	maxItems: 10,
	text: 600,
} as const;

/**
 * The run's own operator-guidance decisions, chronological, ready for
 * `buildReviewPrompt`. `events` must already be scoped to one run and read in
 * order -- GSHIP-627's `listRunDecisionEvents`, unbounded by the live-read
 * window `listRunEvents` caps, so a decision from early in a long run is never
 * dropped just because it scrolled out of that window.
 *
 * Past the item limit, the oldest decisions are the ones dropped, not the
 * newest: a fresh ratification is the one most likely still in force, and a
 * stale one the one likeliest already superseded.
 */
export function selectOperatorDecisions(events: readonly RunEvent[]): string[] {
	const texts = events
		.filter((event) => event.kind === 'run.operator-guidance')
		.map((event) => {
			const text = event.payload['text'];
			return typeof text === 'string' ? text.trim() : '';
		})
		.filter((text) => text.length > 0)
		.map((text) => text.slice(0, OPERATOR_DECISION_LIMITS.text));
	return texts.slice(-OPERATOR_DECISION_LIMITS.maxItems);
}
