import type { IssueEntry } from "./types.ts";
import { isBlocked } from "./graph.ts";
import { readBacklogFromMain, type BacklogSpawnFn } from "./backlog.ts";

/**
 * Parses the numeric suffix from an issue id (e.g. "CAM-12" -> 12).
 * Returns Infinity when the suffix is absent or non-numeric, so un-parseable
 * ids sort to the end rather than crashing.
 */
function numericIdSuffix(id: string): number {
	const suffix = id.split("-").at(-1);
	if (suffix === undefined) return Infinity;
	const n = Number(suffix);
	return Number.isNaN(n) ? Infinity : n;
}

/**
 * Returns the single highest-priority plannable issue from a backlog,
 * or null when no issue qualifies.
 *
 * Qualification filter:
 *   stage === 'specified' AND status === 'open' AND not blocked
 *
 * Sort order (ascending):
 *   1. rank present < rank absent (unranked entries sort after all ranked ones)
 *   2. rank value ascending (lower rank = higher priority)
 *   3. numeric id suffix ascending (CAM-9 before CAM-12) as tie-breaker
 */
export function selectPlannableIssue(
	backlog: IssueEntry[],
): IssueEntry | null {
	const candidates = backlog.filter(
		(issue) =>
			issue.stage === "specified" &&
			issue.status === "open" &&
			!isBlocked(issue, backlog),
	);

	if (candidates.length === 0) return null;

	candidates.sort((a, b) => {
		const aHasRank = a.rank !== undefined;
		const bHasRank = b.rank !== undefined;

		// Ranked entries always sort before unranked ones.
		if (aHasRank && !bHasRank) return -1;
		if (!aHasRank && bHasRank) return 1;

		// Both ranked: compare rank values.
		if (aHasRank && bHasRank) {
			// rank is defined here; non-null assertion is safe after the guards above.
			const rankDiff = (a.rank as number) - (b.rank as number);
			if (rankDiff !== 0) return rankDiff;
		}

		// Same rank (or both unranked): break ties by numeric id suffix.
		return numericIdSuffix(a.id) - numericIdSuffix(b.id);
	});

	const top = candidates[0];
	return top !== undefined ? top : null;
}

/**
 * I/O seam: reads the per-issue dir from main via readBacklogFromMain and
 * delegates to selectPlannableIssue. Returns null on any read/parse error.
 *
 * This is the ONLY place that couples the pure selection logic to the
 * filesystem. Keep it thin so the untested surface stays minimal.
 *
 * @param spawn  Injectable spawnSync (for tests; defaults to the system default).
 */
export function selectPlannableFromFile(
	cwd: string,
	spawn?: BacklogSpawnFn,
): IssueEntry | null {
	try {
		return selectPlannableIssue(readBacklogFromMain(cwd, spawn));
	} catch {
		return null;
	}
}
