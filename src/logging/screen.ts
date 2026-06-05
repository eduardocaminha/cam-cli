// src/logging/screen.ts
//
// Shared helpers for the "title + Section + indented content" hierarchy used
// across cam's non-Ink screens (`cam run`, `cam status`, `cam next`, `cam plan`,
// `cam resume`, `cam claude`). The layout mirrors the Ink `Section` component
// in `src/ui/Section.tsx` and the help renderer in `src/logging/help.ts`:
//
//   cam <command>                                   ← title at col 0
//
//     Section heading                               ← bold at col 2
//     ──────────────────────────────────────        ← muted divisor at col 2
//       ✓ content line                              ← content at col 4
//       muted hint                                  ← content at col 4
//
// Callers compose these primitives directly inside their `run*` functions;
// the helpers manage their own leading/trailing blanks so the operator's eye
// always lands on the same column boundaries regardless of which command
// produced the output.
//
// Keep this file dependency-free except for `color.ts` so any command file
// can import the helpers without dragging in extra modules.

import { DIVIDER, glyphs, layout } from "../design/tokens.ts";
import { accent, chalk, muted, warning } from "./color.ts";
import { isInsideProjectSession, type Env } from "../tmux/session.ts";

/** Heading column (col 2) and content column (col 4), from the shared tokens. */
const HEAD_INDENT = " ".repeat(layout.headingIndent);
const BODY_INDENT = " ".repeat(layout.contentIndent);

/** Width of a command/name column in a "Next" entry — mirrors the Ink
 *  `NextCommand` (width 12) in InitScreen.tsx. */
const ENTRY_NAME_WIDTH = 12;

/**
 * Title row preceded by a leading blank line. No trailing blank — the next
 * emitter (typically `emitSectionHeading`) supplies its own leading blank,
 * and doubling would over-space the title from its first section.
 */
export function emitTitle(text: string): void {
	process.stdout.write(`\n${accent.bold(text)}\n`);
}

/**
 * Section heading + muted divisor at the heading column, preceded by a blank
 * line so it separates from whatever came before (title or prior Section).
 *
 * The divisor is always muted — matching every Ink screen, where success and
 * failure are signaled by the colored glyph on the content line (✓ accent,
 * ✗ destructive), never by the divisor color.
 */
export function emitSectionHeading(heading: string): void {
	process.stdout.write(`\n${HEAD_INDENT}${chalk.bold(heading)}\n${HEAD_INDENT}${muted(DIVIDER)}\n`);
}

/**
 * `<name>  <description>` row at the content column — a command/option entry
 * inside a "Next" section. Mirrors the Ink `NextCommand`: name bold in the
 * terminal's default color, description muted.
 */
export function emitEntry(name: string, description: string): void {
	process.stdout.write(`${BODY_INDENT}${chalk.bold(name.padEnd(ENTRY_NAME_WIDTH))}${muted(description)}\n`);
}

/** `✓ <msg>` row at the content column. */
export function emitOk(msg: string, suffix?: string): void {
	const suffixPart = suffix ? ` ${muted(suffix)}` : "";
	process.stdout.write(`${BODY_INDENT}${accent(glyphs.success)} ${msg}${suffixPart}\n`);
}

/**
 * `! <msg>` warning row at the content column — for non-fatal warnings that
 * belong INSIDE a screen's Section (e.g. a paused loop). Fatal/aborting
 * warnings keep using `printWarning` from color.ts (col 0, stderr-style).
 */
export function emitWarn(msg: string, suffix?: string): void {
	const suffixPart = suffix ? ` ${muted(suffix)}` : "";
	process.stdout.write(`${BODY_INDENT}${warning(glyphs.warning)} ${msg}${suffixPart}\n`);
}

/** Muted hint row at the content column — pairs with `emitOk` under the same Section. */
export function emitMutedHint(msg: string): void {
	process.stdout.write(`${BODY_INDENT}${muted(msg)}\n`);
}

/** Plain content row at the content column (default-color body text inside a Section). */
export function emitContent(msg: string): void {
	process.stdout.write(`${BODY_INDENT}${msg}\n`);
}

/** Trailing blank line — every screen should end with one before returning. */
export function emitTrailingBlank(): void {
	process.stdout.write("\n");
}

/**
 * Emit a short hint suggesting `cam run` only when the caller is NOT already
 * inside the project tmux session.
 *
 * Detection: delegates to `isInsideProjectSession(sessionName, env)` from
 * `src/tmux/session.ts`. When the caller is already attached (CAM_SESSION env
 * var matches the session name), the hint is suppressed so it doesn't clutter
 * the in-session output.
 *
 * Injectable `env` lets tests control detection without touching process.env.
 *
 * Call this at the end of a successful command path, before `emitTrailingBlank`.
 */
export function emitAttachHint(sessionName: string, env: Env = process.env): void {
	if (isInsideProjectSession(sessionName, env)) {
		return;
	}
	emitMutedHint("Run `cam run` to open the project session, or:");
	emitMutedHint(`  tmux attach -t ${sessionName}`);
}
