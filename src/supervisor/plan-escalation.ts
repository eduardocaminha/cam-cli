// src/supervisor/plan-escalation.ts
//
// Durable plan-escalation marker (US-002, CAM-204).
//
// Written on plan non-convergence (a BLOCK verdict that persists after
// MAX_REPLAN_ROUNDS re-plan rounds, ADR-0012: non-convergence is a hard stop,
// never proceed-with-debt) so the orchestrator can derive a BLOCK terminal on
// wake even when the live send-keys narration to the orchestrator pane is
// dropped. CAM-200-independent, CAM-195-style: a plain JSON marker file under
// .claude/, mirroring the durable ship-stalled marker precedent verbatim
// (src/release/merge-watch.ts SHIP_STALLED_FILENAME / read+write+remove).
//
// This module does NOT wire the marker into the re-plan loop itself (US-003
// implements the BLOCK->re-plan loop that calls writePlanEscalatedMarker on
// exhaustion); it only provides the filename constant and the I/O helpers.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import type { PlanVerdictFinding } from './plan-verdict-report.ts';

/**
 * Filename of the durable plan-escalation marker (relative to the .claude/
 * dir, US-002, CAM-204). Written when the BLOCK->re-plan loop exhausts
 * MAX_REPLAN_ROUNDS without an APPROVE verdict; removed when the same issue
 * later plans clean (caller's responsibility to check issueId match first,
 * mirroring removeShipStalledMarker).
 */
export const PLAN_ESCALATED_FILENAME = '.cam-plan-escalated.json';

/**
 * Durable plan-escalation marker payload.
 *   - issueId: the issue the re-plan loop was targeting.
 *   - summary: the auditor's final one-sentence BLOCK summary.
 *   - findings: the final round's structured findings (empty array allowed).
 *   - roundsCompleted: how many re-plan rounds actually ran before giving up.
 *   - writtenAt: ISO 8601 timestamp the marker was written.
 */
export interface PlanEscalatedMarker {
	issueId: string;
	summary: string;
	findings: PlanVerdictFinding[];
	roundsCompleted: number;
	writtenAt: string;
}

/**
 * Read the plan-escalation marker from a persistent file.
 *
 * Returns null when:
 * - The file does not exist (no escalation pending).
 * - The file contains malformed JSON or a non-object / array value.
 * - Any required field is absent or the wrong type (issueId: string,
 *   summary: string, findings: array, roundsCompleted: number,
 *   writtenAt: string) -- JSON reader shape guard pattern (patterns.md
 *   'JSON reader shape guards': validate discriminator fields, not just
 *   typeof).
 *
 * Never throws (mirrors readShipStalledMarker).
 */
export function readPlanEscalatedMarker(filePath: string): PlanEscalatedMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj['issueId'] !== 'string' ||
			typeof obj['summary'] !== 'string' ||
			!Array.isArray(obj['findings']) ||
			typeof obj['roundsCompleted'] !== 'number' ||
			typeof obj['writtenAt'] !== 'string'
		) {
			return null;
		}
		return {
			issueId: obj['issueId'] as string,
			summary: obj['summary'] as string,
			findings: obj['findings'] as PlanVerdictFinding[],
			roundsCompleted: obj['roundsCompleted'] as number,
			writtenAt: obj['writtenAt'] as string,
		};
	} catch {
		return null;
	}
}

/**
 * Write the plan-escalation marker to a persistent file (durable, not
 * consume-on-read; mirrors writeShipStalledMarker). Overwrites any previous
 * marker (a fresh escalation always reflects the latest state). Never
 * throws.
 */
export function writePlanEscalatedMarker(filePath: string, marker: PlanEscalatedMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the marker is not durable this tick */
	}
}

/**
 * Remove the plan-escalation marker file.
 *
 * Called when the same issue later plans clean (caller's responsibility to
 * check issueId match first). Silent no-op when the file is already absent.
 * Never throws (mirrors removeShipStalledMarker).
 */
export function removePlanEscalatedMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}
