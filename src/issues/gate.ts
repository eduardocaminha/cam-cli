import type { IssueEntry } from "./types.ts";
import { checkReferentialIntegrity } from "./graph.ts";
import { rankIssues } from "./rank.ts";

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
 * Reconstructs a human-readable cycle path from the Kahn residual set.
 *
 * Follows successor edges (blocker -> blocked) within the residual set until the
 * starting node is revisited, yielding a string like "CAM-X -> CAM-Y -> CAM-X".
 *
 * @param residualIds  Ids with in-degree > 0 after Kahn exhausts (all are cycle members).
 * @param backlog      Full backlog (for blockedBy access).
 * @param universeIds  Ids in the ranked universe (specified + open).
 */
function reconstructCyclePath(
	residualIds: string[],
	backlog: IssueEntry[],
	universeIds: Set<string>,
): string {
	const residualSet = new Set(residualIds);

	// Build successor edges within residual set:
	// successors[A] contains B when B.blockedBy includes A (A blocks B).
	// This is the "blocker -> blocked" direction used by Kahn.
	const successors = new Map<string, string[]>();
	for (const id of residualIds) {
		successors.set(id, []);
	}
	for (const issue of backlog) {
		if (!residualSet.has(issue.id) || !universeIds.has(issue.id)) continue;
		for (const depId of issue.blockedBy) {
			if (residualSet.has(depId) && universeIds.has(depId)) {
				const list = successors.get(depId);
				if (list !== undefined) {
					list.push(issue.id);
				}
			}
		}
	}

	const start = residualIds[0];
	if (start === undefined) return residualIds.join(", ");

	// Walk successor edges to trace the cycle back to the starting node.
	const path: string[] = [start];
	const pathSet = new Set<string>([start]);
	let current = start;

	// At most residualIds.length steps are needed to complete a cycle through all members.
	for (let step = 0; step <= residualIds.length; step++) {
		const nexts = successors.get(current) ?? [];
		const next = nexts[0];
		if (next === undefined) break; // no successor in residual set (shouldn't happen)

		if (next === start) {
			// Cycle closed back to start node.
			path.push(next);
			return path.join(" -> ");
		}

		if (pathSet.has(next)) {
			// Cycle closes at an intermediate node (extract the cyclic portion).
			const idx = path.indexOf(next);
			const cyclePart = path.slice(idx);
			cyclePart.push(next);
			return cyclePart.join(" -> ");
		}

		pathSet.add(next);
		path.push(next);
		current = next;
	}

	// Fallback: list all residual ids (true cycle always terminates above).
	return residualIds.join(", ");
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
export function runGraphGate(backlog: IssueEntry[]): GateResult {
	// Step 1: Referential integrity check (hard fail on missing-id or self-reference).
	const integrity = checkReferentialIntegrity(backlog);
	if (!integrity.ok) {
		return { ok: false, kind: "integrity", errors: integrity.errors, warnings: [] };
	}

	// Step 2: Collect cross-stage blocker warnings.
	// Universe = specified + open only (same filter as rankIssues).
	const universeIds = new Set(
		backlog.filter((e) => e.stage === "specified" && e.status === "open").map((e) => e.id),
	);
	const byId = new Map(backlog.map((e) => [e.id, e]));
	const warnings: string[] = [];

	for (const issue of backlog) {
		if (!universeIds.has(issue.id)) continue; // only inspect universe members
		for (const depId of issue.blockedBy) {
			const dep = byId.get(depId);
			if (dep === undefined) continue; // missing-id already caught by integrity check
			if (universeIds.has(depId)) continue; // in-universe dep: handled by Kahn
			if (dep.stage === "shipped") continue; // shipped dep: satisfied silently
			// Present, out-of-universe, not shipped: cross-stage blocker.
			warnings.push(
				`Cross-stage blocker: ${issue.id} is blocked by ${depId} (stage: ${dep.stage}, status: ${dep.status}) -- treated as satisfied in intra-set rank`,
			);
		}
	}

	// Step 3: Cycle detection via Kahn residual (reuses rankIssues from rank.ts).
	const { residualIds } = rankIssues(backlog);
	if (residualIds.length > 0) {
		const cyclePath = reconstructCyclePath(residualIds, backlog, universeIds);
		return {
			ok: false,
			kind: "cycle",
			errors: [`Cycle detected: ${cyclePath}`],
			warnings,
		};
	}

	return { ok: true, warnings };
}
