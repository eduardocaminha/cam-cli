import type { IssueEntry } from "./types.ts";
import { isBlocked } from "./graph.ts";

/**
 * Layer 1 (universe core): true iff the entry is in the specified+open
 * universe, regardless of blocked status. Used by rank.ts and gate.ts, which
 * intentionally retain blocked issues (topological ordering, cycle
 * detection).
 */
export function isSpecifiedOpen(entry: IssueEntry): boolean {
	return entry.stage === "specified" && entry.status === "open";
}

/**
 * Layer 2 (selection core): true iff the entry is specified+open, carries a
 * non-empty set of acceptance criteria (ADR-0051), AND is not blocked by an
 * unshipped dependency. Used by select.ts / plan.ts, which exclude blocked
 * issues from the selection queue.
 */
export function isPlannable(entry: IssueEntry, backlog: IssueEntry[]): boolean {
	return (
		isSpecifiedOpen(entry) &&
		hasAcceptanceCriteria(entry) &&
		!isBlocked(entry, backlog)
	);
}

/**
 * True iff the entry carries a spec with a non-empty acceptanceCriteria
 * array (ADR-0051). `spec` is optional and may be entirely absent (derived /
 * fast-tracked issues omit the key rather than writing `{}`), so this guards
 * both the missing-spec and empty-array shapes.
 */
function hasAcceptanceCriteria(entry: IssueEntry): boolean {
	return (entry.spec?.acceptanceCriteria?.length ?? 0) > 0;
}
