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

import { accent, chalk, muted } from "./color.ts";

/** Width of the Section divisor — matches `Section.tsx` (50 cells). */
export const SCREEN_DIVIDER_WIDTH = 50;
const DIVIDER = "─".repeat(SCREEN_DIVIDER_WIDTH);

/**
 * Title row preceded by a leading blank line. No trailing blank — the next
 * emitter (typically `emitSectionHeading`) supplies its own leading blank,
 * and doubling would over-space the title from its first section.
 */
export function emitTitle(text: string): void {
	process.stdout.write(`\n${accent.bold(text)}\n`);
}

/**
 * Section heading + muted divisor at col 2, preceded by a blank line so it
 * separates from whatever came before (title or prior Section).
 */
export function emitSectionHeading(heading: string): void {
	process.stdout.write(`\n  ${chalk.bold(heading)}\n  ${muted(DIVIDER)}\n`);
}

/** `✓ <msg>` row indented at col 4 (Section content column). */
export function emitOk(msg: string, suffix?: string): void {
	const suffixPart = suffix ? ` ${muted(suffix)}` : "";
	process.stdout.write(`    ${accent("✓")} ${msg}${suffixPart}\n`);
}

/** Muted hint row at col 4 — pairs with `emitOk` under the same Section. */
export function emitMutedHint(msg: string): void {
	process.stdout.write(`    ${muted(msg)}\n`);
}

/** Plain content row at col 4 (default-color body text inside a Section). */
export function emitContent(msg: string): void {
	process.stdout.write(`    ${msg}\n`);
}

/** Trailing blank line — every screen should end with one before returning. */
export function emitTrailingBlank(): void {
	process.stdout.write("\n");
}
