import type { IssueEntry } from "./types.ts";
import { checkReferentialIntegrity } from "./graph.ts";
import { rankIssues } from "./rank.ts";
import { isSpecifiedOpen } from "./plannable.ts";

/**
 * The kind of hard failure detected by the graph gate.
 *
 * integrity  -> missing-id or self-reference in blockedBy (checkReferentialIntegrity failed).
 * cycle      -> Kahn residual set is non-empty (circular dependency among universe issues).
 */
export type GateFailKind = "cycle" | "integrity";

/**
 * Result of running the graph gate.
 *
 * ok: true  -> no hard failures; warnings (cross-stage blockers) may still be present.
 *              The caller may safely proceed to compute and write rank.
 *
 * ok: false -> hard failure; errors names the offending path/edge.
 *              The caller MUST NOT write any rank (transactional guarantee).
 */
export type GateResult =
	| { ok: true; warnings: string[] }
	| { ok: false; kind: GateFailKind; errors: string[]; warnings: string[] };

/**
 * Builds successor adjacency map within the residual (cycle-member) set.
 * successors[A] contains B when B.blockedBy includes A (A blocks B).
 */
function buildResidualSuccessors(
	residualIds: string[],
	backlog: IssueEntry[],
	universeIds: Set<string>,
): Map<string, string[]> {
	const residualSet = new Set(residualIds);
	const successors = new Map<string, string[]>();
	for (const id of residualIds) successors.set(id, []);
	for (const issue of backlog) {
		if (!residualSet.has(issue.id) || !universeIds.has(issue.id)) continue;
		for (const depId of issue.blockedBy) {
			if (residualSet.has(depId) && universeIds.has(depId)) {
				const list = successors.get(depId);
				if (list !== undefined) list.push(issue.id);
			}
		}
	}
	return successors;
}

/**
 * Walks successor edges from `start` to trace a cycle path.
 * Returns the path array (including the closing repeated node) or null when
 * the walk cannot close the cycle within maxSteps.
 */
function walkCyclePath(
	start: string,
	successors: Map<string, string[]>,
	maxSteps: number,
): string[] | null {
	const path: string[] = [start];
	const pathSet = new Set<string>([start]);
	let current = start;
	for (let step = 0; step <= maxSteps; step++) {
		const next = (successors.get(current) ?? [])[0];
		if (next === undefined) return null;
		if (next === start) { path.push(next); return path; }
		if (pathSet.has(next)) {
			const idx = path.indexOf(next);
			const part = path.slice(idx);
			part.push(next);
			return part;
		}
		pathSet.add(next);
		path.push(next);
		current = next;
	}
	return null;
}

/**
 * Reconstructs a human-readable cycle path from the Kahn residual set.
 * Yields a string like "CAM-X -> CAM-Y -> CAM-X".
 */
function reconstructCyclePath(
	residualIds: string[],
	backlog: IssueEntry[],
	universeIds: Set<string>,
): string {
	const start = residualIds[0];
	if (start === undefined) return residualIds.join(", ");
	const successors = buildResidualSuccessors(residualIds, backlog, universeIds);
	const path = walkCyclePath(start, successors, residualIds.length);
	return path !== null ? path.join(" -> ") : residualIds.join(", ");
}

/**
 * Graph gate: validates the blockedBy graph BEFORE any rank is computed or written.
 *
 * Hard failures (caller must not write rank when ok: false):
 *   - integrity: missing-id or self-reference (via checkReferentialIntegrity from graph.ts).
 *   - cycle: specified+open issues form a blockedBy cycle (Kahn residual set non-empty).
 *
 * Warnings only (gate still returns ok: true; rank proceeds normally):
 *   - Cross-stage blocker: a specified+open issue is blocked by an id that exists in the
 *     backlog but is NOT specified+open and NOT shipped (e.g. idea, planned, abandoned).
 *     The edge is treated as satisfied in the intra-set Kahn sort; rank is unaffected.
 *
 * The "missing-id" distinction:
 *   - id not in backlog at all -> hard fail (integrity).
 *   - id present but out-of-universe (non-specified or non-open) -> warn (cross-stage).
 *
 * @param backlog  Full list of IssueEntry objects (any stage/status).
 * @returns        GateResult: ok:true with warnings, or ok:false with kind, errors, warnings.
 */
/**
 * Collects cross-stage blocker warnings for universe issues.
 * A cross-stage blocker is a dep that exists in the backlog but is not in the
 * universe (specified+open) and is not shipped.  Treated as satisfied in rank.
 */
function collectCrossStageWarnings(
	backlog: IssueEntry[],
	universeIds: Set<string>,
	byId: Map<string, IssueEntry>,
): string[] {
	const warnings: string[] = [];
	for (const issue of backlog) {
		if (!universeIds.has(issue.id)) continue;
		for (const depId of issue.blockedBy) {
			const dep = byId.get(depId);
			if (dep === undefined) continue; // already caught by integrity check
			if (universeIds.has(depId)) continue; // in-universe: handled by Kahn
			if (dep.stage === "shipped") continue; // satisfied silently
			warnings.push(
				`Cross-stage blocker: ${issue.id} is blocked by ${depId} (stage: ${dep.stage}, status: ${dep.status}) -- treated as satisfied in intra-set rank`,
			);
		}
	}
	return warnings;
}

export function runGraphGate(backlog: IssueEntry[]): GateResult {
	// Step 1: Referential integrity check (hard fail on missing-id or self-reference).
	const integrity = checkReferentialIntegrity(backlog);
	if (!integrity.ok) {
		return { ok: false, kind: "integrity", errors: integrity.errors, warnings: [] };
	}

	// Step 2: Collect cross-stage blocker warnings.
	const universeIds = new Set(
		backlog.filter((e) => isSpecifiedOpen(e)).map((e) => e.id),
	);
	const byId = new Map(backlog.map((e) => [e.id, e]));
	const warnings = collectCrossStageWarnings(backlog, universeIds, byId);

	// Step 3: Cycle detection via Kahn residual (reuses rankIssues from rank.ts).
	const { residualIds } = rankIssues(backlog);
	if (residualIds.length > 0) {
		const cyclePath = reconstructCyclePath(residualIds, backlog, universeIds);
		return { ok: false, kind: "cycle", errors: [`Cycle detected: ${cyclePath}`], warnings };
	}

	return { ok: true, warnings };
}
