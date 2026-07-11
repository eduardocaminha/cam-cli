// src/supervisor/sidecar-stalled.ts
//
// Durable sidecar-stalled marker (US-001, CAM-207).
//
// Written whenever the container sidecar's boot-time ensure/reconcile guard
// (runContainerEnsureGuard, src/commands/sidecar.ts) fails to bring the
// worker container up (firewall-init failure, this story) so a recycled
// orchestrator can learn the sidecar never dispatched a worker even when the
// live send-keys narration to the orchestrator pane is dropped. Mirrors the
// durable ship-stalled marker precedent verbatim (src/release/merge-watch.ts
// SHIP_STALLED_FILENAME / read+write+remove) and the plan-escalation marker
// (src/supervisor/plan-escalation.ts): a plain JSON marker file under
// .claude/, read/write/remove helpers that never throw.
//
// A single shared marker file/shape is used for two producers, distinguished
// by the `reason` discriminator: 'firewall-init-failed' (this story) and,
// later, 'sidecar-died' (a future story covering the sidecar process itself
// dying rather than failing its firewall-init step). Do NOT create a second
// marker file for the second producer -- reuse this one.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/** Filename of the durable sidecar-stalled marker (relative to the .claude/ dir, US-001, CAM-207). */
export const SIDECAR_STALLED_FILENAME = '.cam-sidecar-stalled.json';

/**
 * Structured reason a sidecar bring-up stalled.
 *   - 'firewall-init-failed': the container firewall init step (FirewallError)
 *     failed during runContainerEnsureGuard (this story).
 *   - 'sidecar-died': reserved for a future producer (the sidecar process
 *     itself dying rather than failing a specific boot step).
 */
export type SidecarStalledReason = 'firewall-init-failed' | 'sidecar-died';

/**
 * Durable sidecar-stalled marker payload.
 *   - reason: structured discriminator (see `SidecarStalledReason`).
 *   - detail: human-readable detail (e.g. the firewall init's stderr tail).
 *   - writtenAt: ISO 8601 timestamp the marker was written.
 */
export interface SidecarStalledMarker {
	reason: SidecarStalledReason;
	detail: string;
	writtenAt: string;
}

const VALID_REASONS: readonly SidecarStalledReason[] = ['firewall-init-failed', 'sidecar-died'];

/**
 * Read the sidecar-stalled marker from a persistent file.
 *
 * Returns null when:
 * - The file does not exist (no stall pending).
 * - The file contains malformed JSON or a non-object / array value.
 * - Any required field is absent or the wrong type (reason: one of
 *   `SidecarStalledReason`, detail: string, writtenAt: string) -- JSON reader
 *   shape guard pattern (patterns.md 'JSON reader shape guards': validate
 *   discriminator fields, not just typeof).
 *
 * Never throws (mirrors readPlanEscalatedMarker / readShipStalledMarker).
 */
export function readSidecarStalledMarker(filePath: string): SidecarStalledMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const reason = obj['reason'];
		if (
			typeof reason !== 'string' ||
			!VALID_REASONS.includes(reason as SidecarStalledReason) ||
			typeof obj['detail'] !== 'string' ||
			typeof obj['writtenAt'] !== 'string'
		) {
			return null;
		}
		return {
			reason: reason as SidecarStalledReason,
			detail: obj['detail'] as string,
			writtenAt: obj['writtenAt'] as string,
		};
	} catch {
		return null;
	}
}

/**
 * Write the sidecar-stalled marker to a persistent file (durable, not
 * consume-on-read; mirrors writePlanEscalatedMarker). Overwrites any previous
 * marker (a fresh stall always reflects the latest state). Never throws.
 */
export function writeSidecarStalledMarker(filePath: string, marker: SidecarStalledMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the marker is not durable this tick */
	}
}

/**
 * Remove the sidecar-stalled marker file.
 *
 * Called on the next healthy sidecar bring-up (the container ensure guard
 * passes, or is a no-op in host mode). Silent no-op when the file is already
 * absent. Never throws (mirrors removePlanEscalatedMarker).
 */
export function removeSidecarStalledMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}
