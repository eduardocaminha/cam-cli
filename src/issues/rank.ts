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
 * Builds the in-degree map and successor adjacency list for edges
 * internal to the universe (specified+open issues only).
 * Edges to shipped or out-of-universe blockers are treated as satisfied.
 */
function buildGraph(
	universe: IssueEntry[],
	allById: Map<string, IssueEntry>,
): { inDegree: Map<string, number>; successors: Map<string, string[]> } {
	const universeIds = new Set(universe.map((e) => e.id));
	const inDegree = new Map<string, number>();
	const successors = new Map<string, string[]>();

	for (const issue of universe) {
		if (!inDegree.has(issue.id)) inDegree.set(issue.id, 0);
		if (!successors.has(issue.id)) successors.set(issue.id, []);
	}

	for (const issue of universe) {
		for (const depId of issue.blockedBy) {
			const dep = allById.get(depId);
			const isSatisfied =
				dep === undefined || dep.stage === "shipped" || !universeIds.has(depId);
			if (isSatisfied) continue;
			inDegree.set(issue.id, (inDegree.get(issue.id) ?? 0) + 1);
			const sucList = successors.get(depId);
			if (sucList !== undefined) {
				sucList.push(issue.id);
			} else {
				successors.set(depId, [issue.id]);
			}
		}
	}

	return { inDegree, successors };
}

/**
 * Runs Kahn's BFS algorithm over a mutable in-degree map.
 * Returns ranked entries in topological+WSJF order.
 * Remaining entries in mutableInDegree after return are cycle members.
 */
function runKahn(
	mutableInDegree: Map<string, number>,
	wsjfMap: Map<string, number>,
	successors: Map<string, string[]>,
	allById: Map<string, IssueEntry>,
): RankedEntry[] {
	const ranked: RankedEntry[] = [];
	let nextRank = 1;

	while (true) {
		const layer: string[] = [];
		for (const [id, deg] of mutableInDegree) {
			if (deg === 0) layer.push(id);
		}
		if (layer.length === 0) break;

		layer.sort((a, b) => {
			const wsjfDiff = (wsjfMap.get(b) ?? 0) - (wsjfMap.get(a) ?? 0);
			if (wsjfDiff !== 0) return wsjfDiff;
			return numericIdSuffix(a) - numericIdSuffix(b);
		});

		for (const id of layer) {
			const issue = allById.get(id);
			ranked.push({ id, rank: nextRank++, wsjf: wsjfMap.get(id) ?? 0, stage: issue?.stage ?? "specified" });
			mutableInDegree.delete(id);
			for (const sucId of successors.get(id) ?? []) {
				const cur = mutableInDegree.get(sucId);
				if (cur !== undefined) mutableInDegree.set(sucId, cur - 1);
			}
		}
	}

	return ranked;
}

/**
 * Pure ranking function that computes a dense 1-based rank over the
 * {stage:'specified', status:'open'} set using Kahn's topological sort
 * ordered by WSJF descending within each layer.
 *
 * @param backlog  Full list of IssueEntry objects (may contain any stage/status).
 * @returns        RankResult with ranked entries, warnings, and residual cycle ids.
 */
export function rankIssues(backlog: IssueEntry[]): RankResult {
	const universe = backlog.filter(
		(issue) => issue.stage === "specified" && issue.status === "open",
	);

	if (universe.length === 0) {
		return { ranked: [], warnings: [], residualIds: [] };
	}

	const allById = new Map(backlog.map((e) => [e.id, e]));
	const { inDegree, successors } = buildGraph(universe, allById);

	const wsjfMap = new Map<string, number>();
	const warnings: string[] = [];
	for (const issue of universe) {
		const { wsjf, warning } = computeWsjf(issue);
		wsjfMap.set(issue.id, wsjf);
		if (warning !== null) warnings.push(warning);
	}

	const mutableInDegree = new Map(inDegree);
	const ranked = runKahn(mutableInDegree, wsjfMap, successors, allById);
	const residualIds = Array.from(mutableInDegree.keys());

	return { ranked, warnings, residualIds };
}
