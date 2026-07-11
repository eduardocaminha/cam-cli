// src/supervisor/implement-blocked-marker.ts
//
// Durable implement-blocked marker (US-005, CAM-195, Defect 2).
//
// Written on every 'blocked' terminal of runSupervisor so a recycled
// orchestrator can learn the implement loop was blocked even when the live
// send-keys narration to the orchestrator pane is dropped. Mirrors the
// durable ship-stalled marker precedent verbatim (src/release/merge-watch.ts
// SHIP_STALLED_FILENAME / read+write+remove) and the plan-escalation marker
// (src/supervisor/plan-escalation.ts): a plain JSON marker file under
// .claude/, read/write/remove helpers that never throw.
//
// This module does NOT wire the marker into runSupervisor's blocked-terminal
// seam or into the sidecar's rearm path itself -- it only provides the
// filename constant and the I/O helpers. Wiring lives in loop.ts (write) and
// sidecar.ts (read/remove on the next implement dispatch for the same issue).

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/**
 * Filename of the durable implement-blocked marker (relative to the .claude/
 * dir, US-005, CAM-195). Written on every 'blocked' terminal of runSupervisor;
 * removed when the same issue's implement loop is next re-armed (caller's
 * responsibility to check issueId match first, mirroring
 * removeShipStalledMarker / removePlanEscalatedMarker).
 */
export const IMPLEMENT_BLOCKED_FILENAME = '.cam-implement-blocked.json';

/**
 * Durable implement-blocked marker payload.
 *   - issueId: the issue (prd.issueNumber, stringified) the blocked implement
 *     loop was targeting.
 *   - story: the advisory story id in flight when the loop blocked, or null
 *     when the block happened before any story was selected (e.g.
 *     blocked-no-implementable, an unreadable prd.json).
 *   - reason: a short human-readable reason string (mirrors the outcome.detail
 *     text already used for the live BLOCKED narration line).
 *   - writtenAt: ISO 8601 timestamp the marker was written.
 */
export interface ImplementBlockedMarker {
	issueId: string;
	story: string | null;
	reason: string;
	writtenAt: string;
}

/**
 * Read the implement-blocked marker from a persistent file.
 *
 * Returns null when the file is absent, contains malformed JSON, a non-object
 * / array value, or is missing / mistyping any required field (issueId:
 * string, story: string|null, reason: string, writtenAt: string). Never
 * throws (mirrors readShipStalledMarker / readPlanEscalatedMarker).
 */
export function readImplementBlockedMarker(filePath: string): ImplementBlockedMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const story = obj['story'];
		if (
			typeof obj['issueId'] !== 'string' ||
			(story !== null && typeof story !== 'string') ||
			typeof obj['reason'] !== 'string' ||
			typeof obj['writtenAt'] !== 'string'
		) {
			return null;
		}
		return {
			issueId: obj['issueId'] as string,
			story: story as string | null,
			reason: obj['reason'] as string,
			writtenAt: obj['writtenAt'] as string,
		};
	} catch {
		return null;
	}
}

/**
 * Write the implement-blocked marker to a persistent file (durable, not
 * consume-on-read; mirrors writeShipStalledMarker / writePlanEscalatedMarker).
 * Overwrites any previous marker (a fresh blocked terminal always reflects
 * the latest state). Never throws.
 */
export function writeImplementBlockedMarker(filePath: string, marker: ImplementBlockedMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the marker is not durable this tick */
	}
}

/**
 * Remove the implement-blocked marker file.
 *
 * Called when the same issue's implement loop is next re-armed (caller's
 * responsibility to check issueId match first). Silent no-op when the file
 * is already absent. Never throws (mirrors removeShipStalledMarker /
 * removePlanEscalatedMarker).
 */
export function removeImplementBlockedMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}
