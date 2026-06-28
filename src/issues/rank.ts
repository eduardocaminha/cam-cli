import type { IssueEntry } from "./types.ts";

/**
 * Result entry for a single ranked issue.
 */
export interface RankedEntry {
	id: string;
	rank: number;
	wsjf: number;
	stage: string;
}

/**
 * Return shape of rankIssues.
 *
 * ranked:   dense 1-based ranked entries emitted in topological + WSJF order.
 * warnings: one string per issue that had a WSJF-computation problem
 *           (missing wsjf or jobSize <= 0).  Never empty-crashes; warnings
 *           cause WSJF 0 treatment so the issue sorts last in its layer.
 * residualIds: ids with in-degree > 0 after Kahn exhausts -- these are part
 *           of a cycle.  Empty array when the graph is acyclic.  Exposed so
 *           US-003 can name the cycle members without re-implementing Kahn.
 */
export interface RankResult {
	ranked: RankedEntry[];
	warnings: string[];
	residualIds: string[];
}

/**
 * Parses the numeric suffix from an issue id (e.g. "CAM-12" -> 12).
 * Returns Infinity when the suffix is absent or non-numeric, so un-parseable
 * ids sort to the end rather than crashing.
 * Mirrors select.ts numericIdSuffix semantics exactly.
 */
function numericIdSuffix(id: string): number {
	const suffix = id.split("-").at(-1);
	if (suffix === undefined) return Infinity;
	const n = Number(suffix);
	return Number.isNaN(n) ? Infinity : n;
}

/**
 * Computes the effective WSJF score for an issue.
 * Returns { wsjf, warning } where warning is non-null when the score
 * could not be computed (missing wsjf field or jobSize <= 0).
 * In both failure cases, wsjf is 0 so the issue sorts last in its layer.
 */
function computeWsjf(issue: IssueEntry): { wsjf: number; warning: string | null } {
	if (issue.wsjf === undefined) {
		return {
			wsjf: 0,
			warning: `${issue.id}: wsjf field absent; treating as WSJF 0 (sorts last in layer)`,
		};
	}
	const { value, timeCriticality, riskReduction, jobSize } = issue.wsjf;
	if (jobSize <= 0) {
		return {
			wsjf: 0,
			warning: `${issue.id}: jobSize=${jobSize} (must be > 0); treating as WSJF 0 (sorts last in layer)`,
		};
	}
	return { wsjf: (value + timeCriticality + riskReduction) / jobSize, warning: null };
}

/**
 * Pure ranking function that computes a dense 1-based rank over the
 * {stage:'specified', status:'open'} set using Kahn's topological sort
 * ordered by WSJF descending within each layer.
 *
 * Algorithm:
 *   1. Build the universe: {stage:'specified', status:'open'} issues only.
 *   2. Build the in-degree map for edges INTERNAL to the universe.
 *      - blockedBy ids that point to 'shipped' issues or to ids outside the
 *        universe are treated as satisfied (ignored, no in-degree contribution).
 *   3. Kahn's BFS: repeat until no zero-in-degree nodes remain:
 *      a. Collect all zero-in-degree nodes.
 *      b. Sort them by WSJF desc, then numeric id asc.
 *      c. Assign dense ranks in that order.
 *      d. Decrement in-degree for their successors.
 *   4. Any ids with remaining in-degree > 0 are part of a cycle (residualIds).
 *
 * @param backlog  Full list of IssueEntry objects (may contain any stage/status).
 * @returns        RankResult with ranked entries, warnings, and residual cycle ids.
 */
export function rankIssues(backlog: IssueEntry[]): RankResult {
	// Step 1: build the universe (specified + open only).
	const universe = backlog.filter(
		(issue) => issue.stage === "specified" && issue.status === "open",
	);

	if (universe.length === 0) {
		return { ranked: [], warnings: [], residualIds: [] };
	}

	const universeIds = new Set(universe.map((e) => e.id));
	const allById = new Map(backlog.map((e) => [e.id, e]));

	// Step 2: build in-degree and successor map for edges internal to the universe.
	const inDegree = new Map<string, number>();
	const successors = new Map<string, string[]>(); // id -> list of ids that depend on it

	for (const issue of universe) {
		if (!inDegree.has(issue.id)) inDegree.set(issue.id, 0);
		if (!successors.has(issue.id)) successors.set(issue.id, []);
	}

	for (const issue of universe) {
		for (const depId of issue.blockedBy) {
			// Check if this edge is satisfied (blocker is shipped or outside universe).
			const dep = allById.get(depId);
			const isSatisfied =
				dep === undefined || // unknown id: treat as satisfied (dangling ref)
				dep.stage === "shipped" || // shipped: done
				!universeIds.has(depId); // not in our universe: satisfied

			if (isSatisfied) continue;

			// Internal unsatisfied edge: contributes in-degree to issue.
			inDegree.set(issue.id, (inDegree.get(issue.id) ?? 0) + 1);

			// Register issue as a successor of depId (so we can decrement later).
			const sucList = successors.get(depId);
			if (sucList !== undefined) {
				sucList.push(issue.id);
			} else {
				successors.set(depId, [issue.id]);
			}
		}
	}

	// Pre-compute WSJF for all universe members (needed for sorting layers).
	const wsjfMap = new Map<string, number>();
	const warnings: string[] = [];

	for (const issue of universe) {
		const { wsjf, warning } = computeWsjf(issue);
		wsjfMap.set(issue.id, wsjf);
		if (warning !== null) warnings.push(warning);
	}

	// Step 3: Kahn BFS.
	const ranked: RankedEntry[] = [];
	let nextRank = 1;

	// Work list: mutable copy of in-degree (we decrement as we emit).
	const mutableInDegree = new Map(inDegree);

	while (true) {
		// Collect zero-in-degree nodes.
		const layer: string[] = [];
		for (const [id, deg] of mutableInDegree) {
			if (deg === 0) layer.push(id);
		}

		if (layer.length === 0) break;

		// Sort: WSJF descending, then numeric id ascending.
		layer.sort((a, b) => {
			const wsjfDiff = (wsjfMap.get(b) ?? 0) - (wsjfMap.get(a) ?? 0);
			if (wsjfDiff !== 0) return wsjfDiff;
			return numericIdSuffix(a) - numericIdSuffix(b);
		});

		// Emit layer: assign ranks and remove from in-degree map.
		for (const id of layer) {
			const issue = allById.get(id);
			ranked.push({
				id,
				rank: nextRank++,
				wsjf: wsjfMap.get(id) ?? 0,
				stage: issue?.stage ?? "specified",
			});
			mutableInDegree.delete(id);

			// Decrement successors' in-degree.
			const sucList = successors.get(id) ?? [];
			for (const sucId of sucList) {
				const current = mutableInDegree.get(sucId);
				if (current !== undefined) {
					mutableInDegree.set(sucId, current - 1);
				}
			}
		}
	}

	// Step 4: residual ids (cycle members).
	const residualIds = Array.from(mutableInDegree.keys());

	return { ranked, warnings, residualIds };
}
