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
 * Layer 2 (selection core): true iff the entry is specified+open AND not
 * blocked by an unshipped dependency. Used by select.ts / plan.ts, which
 * exclude blocked issues from the selection queue.
 */
export function isPlannable(entry: IssueEntry, backlog: IssueEntry[]): boolean {
	return isSpecifiedOpen(entry) && !isBlocked(entry, backlog);
}
