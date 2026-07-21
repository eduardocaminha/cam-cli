// src/supervisor/pause-marker.ts
//
// Helpers for the operator pause brake marker.
//
// `cam pause` writes the marker; `cam resume` removes it as part of its
// recovery flow so a paused loop can be re-entered. `cam stop` also removes
// it as part of its full per-session marker cleanup.
//
// This marker is DISTINCT from the loop-state `active`/`phase` field in
// `.claude/cam-loop.local.md`: the sidecar re-stamps `active:true` on every
// iteration (see `makeOnProgress` in host.ts), which would silently clobber
// a pause signal stored there. A dedicated marker file sidesteps that.
//
// Pattern: mirrors drain-kill-switch.ts (named constant + injectable fs
// seams; never throws to callers). The marker is an empty file; presence is
// the signal, content is never read.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Filename within `.claude/` for the operator pause brake. */
export const PAUSE_MARKER = '.cam-pause';

// ---------------------------------------------------------------------------
// Injectable seam types
// ---------------------------------------------------------------------------

/** Injectable write function used by `setPause`. Default: `writeFileSync`. */
export type PauseWriteFn = (path: string, data: string, encoding: 'utf8') => void;

/** Injectable remove function used by `clearPause`. Default: `unlinkSync`. */
export type PauseRemoveFn = (path: string) => void;

/** Injectable existence-check function used by `isPauseSet`. Default: `existsSync`. */
export type PauseExistsFn = (path: string) => boolean;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write (set) the pause marker under `claudeDir`.
 * Idempotent: writing when the file already exists is a no-op in effect.
 * Injectable `writeFn` for tests so no real files are touched.
 * Never throws.
 */
export function setPause(claudeDir: string, writeFn?: PauseWriteFn): void {
	try {
		const p = join(claudeDir, PAUSE_MARKER);
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
 * Remove (clear) the pause marker. Idempotent: absent file is a no-op.
 * Injectable `removeFn` for tests. Never throws.
 */
export function clearPause(claudeDir: string, removeFn?: PauseRemoveFn): void {
	try {
		const p = join(claudeDir, PAUSE_MARKER);
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
 * Check whether the pause marker is present. Pure boolean, never throws.
 * Injectable `existsFn` for tests (default: `existsSync`).
 */
export function isPauseSet(claudeDir: string, existsFn?: PauseExistsFn): boolean {
	try {
		const checkFn = existsFn ?? existsSync;
		return checkFn(join(claudeDir, PAUSE_MARKER));
	} catch {
		return false;
	}
}
