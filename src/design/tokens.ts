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

/**
 * CAM Runtime brand greens. This is the product/marketing identity (splash,
 * README, external site) and is a SEPARATE concern from `palette` above,
 * which carries the chrome's semantic status roles (success/warning/
 * destructive/muted). Importing a brand token must never force-restyle a
 * status surface, so the two exports are kept independent: nothing here is
 * aliased to or from `palette`.
 *
 * Subagent-marking colors (used only to color-code agents in figures) are
 * deliberately NOT included in this module: they are figure-only, not chrome,
 * and their canonical definition lives in the CONTEXT.md brand terms.
 */
export const brandGreens = {
	/** Primary accent: subscribe button, links, nav, highlights, splash accent. */
	firGreen: '#10C66F',
	/** Deep green: text placed over green surfaces (e.g. calendar days). */
	forestGreen: '#003333',
	/** Light green: welcome-page background, light highlights. */
	aeroGreen: '#CAFFE3',
	/** Base white. */
	white: '#FFFFFF',
} as const;

/** CAM Runtime brand neutrals, paired with `brandGreens` for the same identity. */
export const brandNeutrals = {
	/** Ink: dark text/backgrounds, tiles, dark cards, banner. */
	ink: '#1F1F1F',
	/** Secondary text. */
	secondaryText: '#6F6F6F',
	/** Secondary text over dark surfaces. */
	secondaryTextOnDark: '#9C9C9C',
	/** Surface: light cards/surfaces. */
	surface: '#EDECF0',
	/** Line: borders/dividers. */
	line: '#E3E3E5',
} as const;
