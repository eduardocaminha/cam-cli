import { isBlocked } from "./graph.ts";
import { fingerprintSpec, hasVerification } from "./spec.ts";
import type { IssueEntry } from "./types.ts";

/**
 * True iff the entry is specified and still open.
 */
export function isSpecifiedOpen(entry: IssueEntry): boolean {
	return entry.stage === "specified" && entry.status === "open";
}

/**
 * True iff the entry is specified+open, carries executable verification whose
 * current fingerprint was approved, and is not blocked by an unshipped
 * dependency.
 */
export function isPlannable(entry: IssueEntry, backlog: IssueEntry[]): boolean {
	return (
		isSpecifiedOpen(entry) &&
		hasVerification(entry.spec) &&
		entry.spec !== undefined &&
		entry.approval?.fingerprint === fingerprintSpec(entry.spec) &&
		!isBlocked(entry, backlog)
	);
}
