/**
 * Central color and output control using Chalk.
 *
 * Chalk natively handles NO_COLOR, FORCE_COLOR, and TERM=dumb.
 * See https://github.com/chalk/chalk#supportscolor for detection logic.
 */

import chalk from "chalk";

import { palette } from "../design/tokens.ts";

// --- Brand palette ---
//
// Derived from the shared design tokens (`src/design/tokens.ts`) so the print
// path and the Ink screens use byte-identical hex values: accent (success ✓,
// live ●), warning (!), destructive (✗), muted (secondary text, divisors,
// hints, pending ◌).

/** Green — success indicator, brand wordmark, accents. */
export const accent = chalk.hex(palette.accent);

/** Yellow — soft warnings. */
export const warning = chalk.hex(palette.warning);

/** Red — hard errors. */
export const destructive = chalk.hex(palette.destructive);

/** Gray — secondary text, hints, structural lines. */
export const muted = chalk.hex(palette.muted);

/** Alias kept for backward compat with `renderHeader` in logging/theme.ts. */
export const brand = accent;

// --- Standard color functions ---

/**
 * Color functions that wrap text with ANSI codes.
 * Each value is a function: color.red("text") returns "\x1b[31mtext\x1b[39m".
 * Chalk auto-resets when wrapping, so color.reset is not needed.
 */
export const color = {
	bold: chalk.bold,
	dim: chalk.dim,
	red: chalk.red,
	green: chalk.green,
	yellow: chalk.yellow,
	blue: chalk.blue,
	magenta: chalk.magenta,
	cyan: chalk.cyan,
	white: chalk.white,
	gray: chalk.gray,
} as const;

// Re-export chalk for direct use (chaining, custom RGB, etc.)
export { chalk };

/** Type for color function values (for consumers that store colors in variables). */
export type ColorFn = (text: string) => string;

/** Identity function for "no color" cases (replaces old color.white as default). */
export const noColor: ColorFn = (text: string) => text;

// --- ANSI strip utilities (for visible-width calculations in dashboard) ---

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) is required to match ANSI escape sequences
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape codes from a string. */
export function stripAnsi(str: string): string {
	return str.replace(ANSI_REGEX, "");
}

/** Visible string length (excluding ANSI escape codes). */
export function visibleLength(str: string): number {
	return stripAnsi(str).length;
}

// --- Quiet mode ---

let quietMode = false;

/** Enable quiet mode (suppress non-error output). */
export function setQuiet(enabled: boolean): void {
	quietMode = enabled;
}

/** Check if quiet mode is active. */
export function isQuiet(): boolean {
	return quietMode;
}

// --- Standardized message formatters (visual-spec.md Message Formats) ---

/** Success: accent ✓ + default-color message. Optional muted ID/path suffix. */
export function printSuccess(msg: string, id?: string): void {
	if (isQuiet()) return;
	const idPart = id ? ` ${muted(id)}` : "";
	process.stdout.write(`${accent("✓")} ${msg}${idPart}\n`);
}

/**
 * Warning: blank line + destructive ✗ + bold message. Optional muted hint.
 * Visually matches printError — both are interruptive events that the user
 * needs to notice against a scroll of success lines.
 */
export function printWarning(msg: string, hint?: string): void {
	if (isQuiet()) return;
	const hintPart = hint ? ` ${muted(`— ${hint}`)}` : "";
	process.stdout.write(`\n${destructive.bold(`✗ ${msg}`)}${hintPart}\n`);
}

/**
 * Error: blank line + destructive ✗ + bold message. Optional muted hint.
 * Always to stderr.
 */
export function printError(msg: string, hint?: string): void {
	const hintPart = hint ? ` ${muted(`— ${hint}`)}` : "";
	process.stderr.write(`\n${destructive.bold(`✗ ${msg}`)}${hintPart}\n`);
}

/** Hint/info: muted indented text. */
export function printHint(msg: string): void {
	if (isQuiet()) return;
	process.stdout.write(`${muted(`  ${msg}`)}\n`);
}

/**
 * Hint that is the last line of a fatal flow (parse error, unknown command,
 * etc.). Behaves like `printHint` but appends a trailing blank line so the
 * shell prompt lands cleanly under the message — matching the leading blank
 * line that `printError` already emits above the `✗` glyph.
 */
export function printFatalHint(msg: string): void {
	if (isQuiet()) return;
	process.stdout.write(`${muted(`  ${msg}`)}\n\n`);
}
