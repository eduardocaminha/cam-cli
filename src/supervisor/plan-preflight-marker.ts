// src/supervisor/plan-preflight-marker.ts
//
// Durable plan-preflight-failed marker (US-002, CAM-215).
//
// Written when runPlanPreflight (plan-preflight.ts) returns { ok: false }: the
// planner never even got to spawn because a deterministic environment check
// (clean tree, typecheck, bun test, etc.) failed first. Mirrors the plan-
// escalated marker precedent (plan-escalation.ts) verbatim in structure, so
// the orchestrator can derive "the last plan attempt died in preflight" on
// wake even when the live send-keys narration to the orchestrator pane is
// dropped.
//
// Unlike PlanEscalatedMarker, this marker has no issueId: a preflight failure
// (dirty tree, failing typecheck, failing tests) is an environment problem,
// not tied to the issue the planner was about to target. This also drives the
// removal policy (Option B, US-004): the marker is removed on ANY non-
// preflight-failed plan result, not gated on issueId match.
//
// This module does NOT wire the marker into the plan loop itself (US-003
// implements the runPostAuditAction arm that calls writePlanPreflightFailedMarker
// on a preflight-failed result); it only provides the filename constant, the
// I/O helpers, and the pure detail-truncation helper shared by the US-003
// notify line and the US-005 boot-blocker prose.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/**
 * Filename of the durable plan-preflight-failed marker (relative to the
 * .claude/ dir, US-002, CAM-215). Written when runPlanPreflight returns
 * { ok: false }; removed on any subsequent plan result that is not itself a
 * preflight failure (caller's responsibility, US-004).
 */
export const PLAN_PREFLIGHT_FAILED_FILENAME = '.cam-plan-preflight-failed.json';

/**
 * Durable plan-preflight-failed marker payload.
 *   - step: the first failing preflight step (e.g. 'clean-tree', 'typecheck',
 *     'bun-test'; see plan-preflight.ts RunPlanPreflightResult).
 *   - detail: the raw, untruncated diagnostic detail for the failing step.
 *   - writtenAt: ISO 8601 timestamp the marker was written.
 *
 * No issueId: preflight failures are environment problems, issue-agnostic.
 */
export interface PlanPreflightFailedMarker {
	step: string;
	detail: string;
	writtenAt: string;
}

/**
 * Fields the preflight-failed marker writer seam is invoked with (US-003).
 * Mirrors PlanPreflightFailedMarker minus `writtenAt`: the production wiring
 * (US-003) stamps the timestamp itself when persisting the durable marker
 * file, keeping the pure loop clock-free (mirrors PlanEscalationWriterParams,
 * plan-runner.ts:788).
 */
export type PlanPreflightFailedWriterParams = Omit<PlanPreflightFailedMarker, 'writtenAt'>;

/**
 * Read the plan-preflight-failed marker from a persistent file.
 *
 * Returns null when:
 * - The file does not exist (no preflight failure pending).
 * - The file contains malformed JSON or a non-object / array value.
 * - Any required field is absent or the wrong type (step: string, detail:
 *   string, writtenAt: string) -- JSON reader shape guard pattern
 *   (patterns.md 'JSON reader shape guards': validate discriminator fields,
 *   not just typeof).
 *
 * Never throws (mirrors readPlanEscalatedMarker).
 */
export function readPlanPreflightFailedMarker(filePath: string): PlanPreflightFailedMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj['step'] !== 'string' ||
			typeof obj['detail'] !== 'string' ||
			typeof obj['writtenAt'] !== 'string'
		) {
			return null;
		}
		return {
			step: obj['step'] as string,
			detail: obj['detail'] as string,
			writtenAt: obj['writtenAt'] as string,
		};
	} catch {
		return null;
	}
}

/**
 * Write the plan-preflight-failed marker to a persistent file (durable, not
 * consume-on-read; mirrors writePlanEscalatedMarker). Overwrites any previous
 * marker (a fresh preflight failure always reflects the latest state). Never
 * throws.
 */
export function writePlanPreflightFailedMarker(filePath: string, marker: PlanPreflightFailedMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the marker is not durable this tick */
	}
}

/**
 * Remove the plan-preflight-failed marker file.
 *
 * Called on any plan result that is not itself a preflight failure (Option B,
 * US-004: caller is not required to check issueId, since preflight failures
 * are issue-agnostic). Silent no-op when the file is already absent. Never
 * throws (mirrors removePlanEscalatedMarker).
 */
export function removePlanPreflightFailedMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}

/**
 * Truncate a preflight-failure detail string for single-line narration
 * (US-002; consumed by the US-003 notify line and the US-005 boot-blocker
 * prose).
 *
 * Returns `detail` unchanged when it is a single line. When `detail` spans
 * multiple lines, returns the first line plus a ` (+N more)` suffix, where N
 * is the number of additional lines.
 */
export function truncatePreflightDetail(detail: string): string {
	const lines = detail.split('\n');
	const [firstLine, ...rest] = lines;
	if (rest.length === 0) return detail;
	return `${firstLine} (+${rest.length} more)`;
}
