// src/supervisor/dispatch-failed-marker.ts
//
// Durable dispatch-failed marker (US-002, CAM-433).
//
// Records the diagnostic context of a failed worker dispatch so the failure
// remains observable after live pane output disappears. This module only owns
// the marker payload and best-effort I/O helpers; later stories wire writers
// and convergence-only removal into the dispatch lifecycle.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** Filename of the durable dispatch-failed marker, relative to `.claude/`. */
export const DISPATCH_FAILED_FILENAME = '.cam-dispatch-failed.json';

/** Durable diagnostic payload for a failed worker dispatch. */
export interface DispatchFailedMarker {
	phase: string;
	paneId: string;
	uuid: string;
	exitCode: number;
	stderr: string;
	reason: string;
	timestamp: string;
	/**
	 * Extracted cause text (e.g. a transcript-derived early-death reason,
	 * US-001 CAM-479), optional so a marker written before this field existed
	 * still parses (additive field, never a rejection criterion).
	 */
	cause?: string;
}

/**
 * Read and validate a dispatch-failed marker. Returns null when the file is
 * absent, unreadable, malformed, or missing any required field. Never throws.
 */
export function readDispatchFailedMarker(filePath: string): DispatchFailedMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj['phase'] !== 'string' ||
			typeof obj['paneId'] !== 'string' ||
			typeof obj['uuid'] !== 'string' ||
			typeof obj['exitCode'] !== 'number' ||
			typeof obj['stderr'] !== 'string' ||
			typeof obj['reason'] !== 'string' ||
			typeof obj['timestamp'] !== 'string' ||
			(obj['cause'] !== undefined && typeof obj['cause'] !== 'string')
		) {
			return null;
		}
		const marker: DispatchFailedMarker = {
			phase: obj['phase'] as string,
			paneId: obj['paneId'] as string,
			uuid: obj['uuid'] as string,
			exitCode: obj['exitCode'] as number,
			stderr: obj['stderr'] as string,
			reason: obj['reason'] as string,
			timestamp: obj['timestamp'] as string,
		};
		if (typeof obj['cause'] === 'string') marker.cause = obj['cause'];
		return marker;
	} catch {
		return null;
	}
}

/** Persist the latest dispatch failure. Best-effort and never throws. */
export function writeDispatchFailedMarker(filePath: string, marker: DispatchFailedMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: failure remains available through the live error path */
	}
}

/**
 * Remove the durable dispatch failure after a later dispatch converges.
 * Silent no-op when the file is already absent; best-effort and never throws.
 */
export function removeDispatchFailedMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}
