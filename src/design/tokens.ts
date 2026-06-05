// src/design/tokens.ts
//
// Single source of truth for cam-cli's visual design tokens, shared by BOTH
// render paths:
//   - the Ink screens   (src/ui/*.tsx, via theme.ts + Section.tsx)
//   - the print screens  (src/logging/*.ts: color.ts, screen.ts, help.ts)
//
// Mirrors how Claude Code keeps one design-system that both its interactive
// (Ink) and non-interactive (print) output derive from. Centralizing the
// palette, the glyph vocabulary, and the layout metrics here means a visual
// edit on one path can no longer drift from the other: there is exactly one
// place to change a color, a status glyph, or the section indent.
//
// This module is intentionally dependency-free (no `ink`, no `chalk`) so any
// file in the project can import it without dragging in a renderer.

/**
 * Brand palette as raw hex strings. Ink consumes these directly via
 * `<Text color>`; the print path wraps each in `chalk.hex()`. The 4-token set
 * is the minimum that maps cleanly on both dark and light terminals.
 */
export const palette = {
	/** Green: success ✓, live ●, focused row, divisor on success sections. */
	accent: '#4EBE7D',
	/** Yellow: soft warnings !, paused state. */
	warning: '#FFCB1F',
	/** Red: hard errors ✗, divisor on failure sections. */
	destructive: '#F25F5C',
	/** Gray: structural lines, pending ◌, descriptions, hints, version strings. */
	muted: '#808080',
} as const;

/**
 * Glyph vocabulary. Every status indicator on either render path resolves to
 * one of these, so e.g. "idle / pending" is the same character in the Ink
 * Dashboard and in `cam status`.
 */
export const glyphs = {
	/** Success / done. Paired with `palette.accent`. */
	success: '✓',
	/** Hard error. Paired with `palette.destructive`. */
	error: '✗',
	/** Soft warning / paused. Paired with `palette.warning`. */
	warning: '!',
	/** Dotted circle: pending / idle / neutral. Paired with `palette.muted`. */
	pending: '◌',
	/** Filled circle: live / running loop. Paired with `palette.accent`. */
	active: '●',
	/** Selected option in a Select. Paired with `palette.accent`. */
	cursor: '❯',
	/** Text-input prompt caret. */
	input: '›',
} as const;

/**
 * Layout metrics. The divisor width and the indent columns were previously
 * hardcoded separately in Section.tsx, screen.ts, and help.ts; sharing them
 * here is what guarantees the Ink Section and the print Section line up on the
 * exact same columns.
 */
export const layout = {
	/** Width (cells) of the horizontal divisor under a section heading. */
	dividerWidth: 50,
	/** Indent (cells) of a section heading and its divisor. */
	headingIndent: 2,
	/** Indent (cells) of section content (rows under the divisor). */
	contentIndent: 4,
} as const;

/** Pre-built divisor string at the canonical width. */
export const DIVIDER = '─'.repeat(layout.dividerWidth);
