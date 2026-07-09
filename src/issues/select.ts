import type { IssueEntry } from "./types.ts";
import { computeWsjf } from "./rank.ts";
import { readBacklogFromMain, type BacklogSpawnFn } from "./backlog.ts";
import { isPlannable, isSpecifiedOpen } from "./plannable.ts";

export { isPlannable, isSpecifiedOpen };

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
 * Picks the best ranked candidate: min rank value, numeric-id ascending
 * tie-break. Returns undefined when the group is empty.
 */
function pickRankedChampion(ranked: IssueEntry[]): IssueEntry | undefined {
	if (ranked.length === 0) return undefined;
	const sorted = [...ranked].sort((a, b) => {
		// Both entries in this group have rank !== undefined by construction.
		const rankDiff = (a.rank as number) - (b.rank as number);
		if (rankDiff !== 0) return rankDiff;
		return numericIdSuffix(a.id) - numericIdSuffix(b.id);
	});
	return sorted[0];
}

/**
 * Picks the best unranked candidate: max computeWsjf score, numeric-id
 * ascending tie-break. Returns undefined when the group is empty.
 */
function pickUnrankedChampion(unranked: IssueEntry[]): IssueEntry | undefined {
	if (unranked.length === 0) return undefined;
	const sorted = [...unranked].sort((a, b) => {
		const wsjfDiff = computeWsjf(b).wsjf - computeWsjf(a).wsjf;
		if (wsjfDiff !== 0) return wsjfDiff;
		return numericIdSuffix(a.id) - numericIdSuffix(b.id);
	});
	return sorted[0];
}

/**
 * Returns the single highest-priority plannable issue from a backlog,
 * or null when no issue qualifies.
 *
 * Qualification filter: isPlannable (specified+open, not blocked; see
 * plannable.ts).
 *
 * Selection is champion-vs-champion (US-001, CAM-203): a pairwise comparator
 * mixing both-ranked-by-rank with mixed-by-WSJF is NOT a total order, so we
 * pick the best ranked candidate (min rank, numeric-id tie-break) and the
 * best unranked candidate (max WSJF via computeWsjf, numeric-id tie-break)
 * separately, then let the unranked champion win only when its WSJF is
 * STRICTLY higher than the ranked champion's WSJF (a tie goes to the ranked
 * champion). This lets a freshly-specified high-WSJF unranked issue compete
 * for selection instead of being silently unplannable behind every ranked
 * entry (CAM-201-class bug).
 */
export function selectPlannableIssue(
	backlog: IssueEntry[],
): IssueEntry | null {
	const candidates = backlog.filter((issue) => isPlannable(issue, backlog));

	if (candidates.length === 0) return null;

	const ranked = candidates.filter((c) => c.rank !== undefined);
	const unranked = candidates.filter((c) => c.rank === undefined);

	const rankedChampion = pickRankedChampion(ranked);
	const unrankedChampion = pickUnrankedChampion(unranked);

	if (rankedChampion === undefined) return unrankedChampion ?? null;
	if (unrankedChampion === undefined) return rankedChampion;

	const rankedWsjf = computeWsjf(rankedChampion).wsjf;
	const unrankedWsjf = computeWsjf(unrankedChampion).wsjf;

	return unrankedWsjf > rankedWsjf ? unrankedChampion : rankedChampion;
}

/**
 * I/O seam: reads the per-issue dir from main via readBacklogFromMain and
 * delegates to selectPlannableIssue. Returns null ONLY when the backlog is
 * legitimately empty or no candidate qualifies (selectPlannableIssue's own
 * null case).
 *
 * A real read/parse error thrown by readBacklogFromMain propagates to the
 * caller (US-001, CAM-115): a corrupted backlog must never be silently
 * conflated with a drained one. Callers that invoke this from a long-lived
 * async tick (e.g. the sidecar meta-loop observer) are responsible for
 * guarding their own boundary and logging the real error rather than letting
 * it crash the process.
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
	return selectPlannableIssue(readBacklogFromMain(cwd, spawn));
}

/**
 * Target-aware plannable selector (US-001, CAM-154).
 *
 * Given a target issue id, returns that exact IssueEntry when it is present in
 * the backlog AND qualifies as plannable (isPlannable: specified+open, not
 * blocked by an unshipped dependency).
 *
 * Returns null (NEVER falls back to top-of-queue) when:
 *   - the id is absent from the backlog, or
 *   - the id is present but the issue is not plannable.
 *
 * Match is by exact id string equality, NOT by numeric suffix.
 */
export function selectPlannableById(
	backlog: IssueEntry[],
	targetId: string,
): IssueEntry | null {
	const entry = backlog.find((issue) => issue.id === targetId);
	if (entry === undefined) return null;
	return isPlannable(entry, backlog) ? entry : null;
}

/**
 * File-backed target-aware selector (US-001, CAM-154).
 *
 * When targetId is a non-empty string, delegates to selectPlannableById (never
 * falls back to top-of-queue on non-plannable/absent target).
 * When targetId is undefined or null, delegates to selectPlannableIssue
 * (preserving existing bare `cam plan` behavior: top-of-queue).
 *
 * Returns null ONLY when the target is absent/not-plannable or the backlog is
 * legitimately empty. A real read/parse error thrown by readBacklogFromMain
 * propagates to the caller (US-001, CAM-115): see selectPlannableFromFile's
 * docstring for the corrupted-vs-drained rationale and the caller-boundary
 * contract.
 *
 * @param spawn  Injectable spawnSync (for tests; defaults to the system default).
 */
export function selectPlanTargetFromFile(
	cwd: string,
	targetId: string | undefined | null,
	spawn?: BacklogSpawnFn,
): IssueEntry | null {
	const backlog = readBacklogFromMain(cwd, spawn);
	if (targetId != null && targetId.length > 0) {
		return selectPlannableById(backlog, targetId);
	}
	return selectPlannableIssue(backlog);
}
