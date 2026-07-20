// src/tmux/display-message.ts
//
// Synchronous, socket-aware `tmux display-message` cursor-geometry sampler
// (US-001, CAM-359).
//
// The submission oracle (US-002) needs a signal a dispatched payload cannot
// forge: the pane's live cursor position, tracked server-side by tmux itself.
// A worker (or a malformed/malicious payload) can print arbitrary text into a
// pane's scrollback, but it cannot fabricate what tmux's own #{cursor_x} /
// #{cursor_y} format variables report, so keying the oracle on sampled
// geometry instead of captured pane text closes that forgery gap.
//
// This module deliberately does NOT import the vendored tmux.ts helper under
// src/retry/ (MIT licensed, must stay untouched): that module's buildDisplayArgs omits the
// `-L cam` socket flag applied by every other dispatch-path tmux call, and
// its capture/spawn helpers use an async Bun.spawn convention, whereas every
// caller here spawns synchronously (TmuxSpawnFn mirrors src/tmux/session.ts
// SpawnFn, the shape defaultCapturePaneFn in src/tmux/dispatch.ts already
// uses).

import { tmuxArgs, type SpawnFn as TmuxSpawnFn } from './session.ts';

// ---------------------------------------------------------------------------
// Format string
// ---------------------------------------------------------------------------

/**
 * Field separator for the multi-field display-message format string.
 *
 * NEVER a literal TAB: tmux converts a TAB embedded in a `-F`/format string to
 * `_` in its output (verified against real tmux, the same lesson already
 * documented for `-F` parses in src/tmux/session.ts isSessionStale /
 * getOrchPaneId). Pane coordinates never contain a semicolon, so it is an
 * unambiguous separator.
 */
const FIELD_SEP = ';';

/**
 * display-message format string sampling cursor position and pane bounds.
 *
 * Order: cursor_x, cursor_y, pane_width, pane_height.
 */
export const CURSOR_GEOMETRY_FORMAT = `#{cursor_x};#{cursor_y};#{pane_width};#{pane_height}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sampled cursor geometry for a single pane. */
export interface CursorGeometry {
	cursorX: number;
	cursorY: number;
	paneWidth: number;
	paneHeight: number;
}

// ---------------------------------------------------------------------------
// Argv builder
// ---------------------------------------------------------------------------

/**
 * Build argv for `tmux -L cam display-message -p -t <paneId> <format>`.
 *
 * Routes through `tmuxArgs()` from src/tmux/session.ts so the `-L cam` socket
 * flag is applied, matching every other dispatch-path tmux call.
 */
export function displayMessageArgv(paneId: string, format: string): string[] {
	return tmuxArgs(['display-message', '-p', '-t', paneId, format]);
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

/**
 * Parse one field as a base-10 integer.
 *
 * Returns null for `undefined` (missing field, e.g. from `noUncheckedIndexedAccess`
 * indexing past the split array), or any string that is not a clean base-10
 * integer literal (empty string, non-digit content, etc). `Number.parseInt`
 * alone is too lenient here (`parseInt('12abc')` returns 12), so the field is
 * validated against a strict digits-only pattern first.
 */
function parseIntField(field: string | undefined): number | null {
	if (field === undefined) return null;
	if (!/^-?\d+$/.test(field)) return null;
	const n = Number.parseInt(field, 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * Sample a pane's cursor geometry via a synchronous `display-message` call.
 *
 * Fails CLOSED (returns `null`) on any unusable reading:
 *   - a non-zero exit status
 *   - empty/blank stdout
 *   - any field that does not parse as a base-10 integer
 *
 * tmux replaces an unknown or missing format variable with an EMPTY string
 * rather than erroring, so a lenient parser that defaulted a blank field to 0
 * would silently fabricate a plausible-looking `(0, 0)` coordinate for a pane
 * that produced no real reading. That is exactly the failure mode this
 * helper exists to prevent: the caller (the submission oracle) must be able
 * to tell "no reading" apart from "reading at (0, 0)".
 */
export function sampleCursorGeometry(
	paneId: string,
	spawnFn: TmuxSpawnFn,
): CursorGeometry | null {
	const r = spawnFn('tmux', displayMessageArgv(paneId, CURSOR_GEOMETRY_FORMAT), {
		stdio: 'pipe',
	});
	if ((r.status ?? 1) !== 0) return null;
	const out = typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString() ?? '');
	const trimmed = out.trim();
	if (trimmed.length === 0) return null;

	const fields = trimmed.split(FIELD_SEP);
	const cursorX = parseIntField(fields[0]);
	const cursorY = parseIntField(fields[1]);
	const paneWidth = parseIntField(fields[2]);
	const paneHeight = parseIntField(fields[3]);
	if (cursorX === null || cursorY === null || paneWidth === null || paneHeight === null) {
		return null;
	}
	return { cursorX, cursorY, paneWidth, paneHeight };
}
