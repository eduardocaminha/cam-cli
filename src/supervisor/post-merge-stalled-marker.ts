// src/supervisor/post-merge-stalled-marker.ts
//
// Durable post-merge-stalled marker (US-001, CAM-174).
//
// Written when a PR has merged but the post-merge sequence (tag, branch
// prune, issue close, etc.) did not fully complete, so a recycled
// orchestrator can learn the post-merge was left incomplete even when the
// live send-keys narration to the orchestrator pane is dropped. Mirrors the
// durable implement-blocked marker precedent verbatim (
// src/supervisor/implement-blocked-marker.ts: IMPLEMENT_BLOCKED_FILENAME /
// read+write+remove) and the ship-stalled marker (src/release/merge-watch.ts):
// a plain JSON marker file under .claude/, read/write/remove helpers that
// never throw.
//
// This module is I/O-only -- it does NOT wire the marker into the sidecar's
// post-merge sequence or into any recycle-recovery seam. Wiring is left to a
// later story.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/**
 * Filename of the durable post-merge-stalled marker (relative to the
 * .claude/ dir, US-001, CAM-174).
 */
export const POST_MERGE_STALLED_FILENAME = '.cam-post-merge-stalled.json';

/**
 * Durable post-merge-stalled marker payload.
 *   - prNumber: the pull request number whose post-merge sequence stalled.
 *   - issueId: the backlog issue id (state.issueId, per the merge-watch
 *     state) the PR closes, or null when the merge-watch state carried none.
 *   - completedSteps: names of the post-merge steps that finished before the
 *     stall (e.g. "tag", "branch-prune").
 *   - remainingSteps: names of the post-merge steps that had not yet run.
 *   - reason: a short human-readable reason string describing the stall.
 *   - writtenAt: ISO 8601 timestamp the marker was written.
 */
export interface PostMergeStalledMarker {
	prNumber: number;
	issueId: string | null;
	completedSteps: string[];
	remainingSteps: string[];
	reason: string;
	writtenAt: string;
}

/**
 * Read the post-merge-stalled marker from a persistent file.
 *
 * Returns null when the file is absent, contains malformed JSON, a non-object
 * / array value, or is missing / mistyping any required field (prNumber:
 * number, issueId: string|null, completedSteps: string[], remainingSteps:
 * string[], reason: string, writtenAt: string). Never throws (mirrors
 * readImplementBlockedMarker / readShipStalledMarker).
 */
export function readPostMergeStalledMarker(filePath: string): PostMergeStalledMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const issueId = obj['issueId'];
		if (
			typeof obj['prNumber'] !== 'number' ||
			(issueId !== null && typeof issueId !== 'string') ||
			!isStringArray(obj['completedSteps']) ||
			!isStringArray(obj['remainingSteps']) ||
			typeof obj['reason'] !== 'string' ||
			typeof obj['writtenAt'] !== 'string'
		) {
			return null;
		}

		return {
			prNumber: obj['prNumber'] as number,
			issueId: issueId as string | null,
			completedSteps: obj['completedSteps'] as string[],
			remainingSteps: obj['remainingSteps'] as string[],
			reason: obj['reason'] as string,
			writtenAt: obj['writtenAt'] as string,
		};
	} catch {
		return null;
	}
}

/** Type guard for a `string[]` value read out of parsed JSON. */
function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Write the post-merge-stalled marker to a persistent file (durable, not
 * consume-on-read; mirrors writeImplementBlockedMarker / writeShipStalledMarker).
 * Overwrites any previous marker (a fresh stall always reflects the latest
 * state). Never throws.
 */
export function writePostMergeStalledMarker(filePath: string, marker: PostMergeStalledMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the marker is not durable this tick */
	}
}

/**
 * Remove the post-merge-stalled marker file.
 *
 * Called once the post-merge sequence for the same PR completes. Silent
 * no-op when the file is already absent. Never throws (mirrors
 * removeImplementBlockedMarker / removeShipStalledMarker).
 */
export function removePostMergeStalledMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}
