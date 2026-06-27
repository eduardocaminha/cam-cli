import type { IssueEntry } from "./types.ts";

/**
 * Returns true iff any id in issue.blockedBy resolves to a backlog entry
 * whose stage is not 'shipped'. Missing ids are the referential-integrity
 * checker's concern; isBlocked only considers present, non-shipped deps.
 */
export function isBlocked(issue: IssueEntry, backlog: IssueEntry[]): boolean {
	if (issue.blockedBy.length === 0) return false;
	const byId = new Map(backlog.map((e) => [e.id, e]));
	for (const depId of issue.blockedBy) {
		const dep = byId.get(depId);
		if (dep !== undefined && dep.stage !== "shipped") return true;
	}
	return false;
}

/**
 * Builds the reverse index: for each issue id in the backlog, the list of
 * issue ids that name it in their blockedBy field.
 * 'blocks' is never stored, only derived on demand.
 */
export function deriveBlocks(backlog: IssueEntry[]): Map<string, string[]> {
	const result = new Map<string, string[]>();
	// Initialise a key for every id so lookups are always present.
	for (const entry of backlog) {
		result.set(entry.id, []);
	}
	for (const entry of backlog) {
		for (const depId of entry.blockedBy) {
			const list = result.get(depId);
			if (list !== undefined) {
				list.push(entry.id);
			} else {
				// depId is not in the backlog; still track reverse edges.
				result.set(depId, [entry.id]);
			}
		}
	}
	return result;
}

/**
 * Referential-integrity check.
 * Flags: (a) any blockedBy id that has no matching entry in the backlog,
 *        (b) any self-reference (an id in its own blockedBy list).
 * Full cycle-rejection is out of scope (Epico C).
 */
export function checkReferentialIntegrity(backlog: IssueEntry[]): {
	ok: boolean;
	errors: string[];
} {
	const errors: string[] = [];
	const known = new Set(backlog.map((e) => e.id));
	for (const entry of backlog) {
		for (const depId of entry.blockedBy) {
			if (depId === entry.id) {
				errors.push(`Self-reference: ${entry.id} lists itself in blockedBy`);
			} else if (!known.has(depId)) {
				errors.push(
					`Missing dep: ${entry.id} references unknown id '${depId}' in blockedBy`,
				);
			}
		}
	}
	return { ok: errors.length === 0, errors };
}
