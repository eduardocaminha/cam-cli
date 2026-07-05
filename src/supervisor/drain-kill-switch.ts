// src/supervisor/drain-kill-switch.ts
//
// Helpers for the inter-cycle drain kill-switch marker.
//
// `cam drain --stop` writes the marker; the autonomous drain loop reads it at
// each safe cycle boundary and stops if present. `cam drain --clear` removes it.
// `cam stop` removes it as part of its full per-session marker cleanup.
//
// Pattern: mirrors sidecar-pid.ts (named constant + injectable fs seams;
// never throws to callers). The marker is an empty file; presence is the
// signal, content is never read.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Filename within `.claude/` for the inter-cycle drain kill-switch. */
export const DRAIN_STOP_MARKER = '.cam-drain-stop';

// ---------------------------------------------------------------------------
// Injectable seam types
// ---------------------------------------------------------------------------

/** Injectable write function used by `setDrainStop`. Default: `writeFileSync`. */
export type DrainWriteFn = (path: string, data: string, encoding: 'utf8') => void;

/** Injectable remove function used by `clearDrainStop`. Default: `unlinkSync`. */
export type DrainRemoveFn = (path: string) => void;

/** Injectable existence-check function used by `isDrainStopSet`. Default: `existsSync`. */
export type DrainExistsFn = (path: string) => boolean;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write (set) the drain kill-switch marker under `claudeDir`.
 * Idempotent: writing when the file already exists is a no-op.
 * Injectable `writeFn` for tests so no real files are touched.
 * Never throws.
 */
export function setDrainStop(claudeDir: string, writeFn?: DrainWriteFn): void {
	try {
		const p = join(claudeDir, DRAIN_STOP_MARKER);
		if (writeFn) {
			writeFn(p, '', 'utf8');
		} else {
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(p, '', 'utf8');
		}
	} catch {
		// best-effort: permission error or race
	}
}

/**
 * Remove (clear) the drain kill-switch marker. Idempotent: absent file is a
 * no-op. Injectable `removeFn` for tests. Never throws.
 */
export function clearDrainStop(claudeDir: string, removeFn?: DrainRemoveFn): void {
	try {
		const p = join(claudeDir, DRAIN_STOP_MARKER);
		if (removeFn) {
			removeFn(p);
		} else {
			unlinkSync(p);
		}
	} catch {
		// already gone or never written
	}
}

/**
 * Check whether the drain kill-switch marker is present. Pure boolean, never
 * throws. Injectable `existsFn` for tests (default: `existsSync`).
 */
export function isDrainStopSet(claudeDir: string, existsFn?: DrainExistsFn): boolean {
	try {
		const checkFn = existsFn ?? existsSync;
		return checkFn(join(claudeDir, DRAIN_STOP_MARKER));
	} catch {
		return false;
	}
}
