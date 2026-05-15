/**
 * Central color and output control using Chalk.
 *
 * Chalk natively handles NO_COLOR, FORCE_COLOR, and TERM=dumb.
 * See https://github.com/chalk/chalk#supportscolor for detection logic.
 */

import chalk from "chalk";

// --- Brand palette ---
//
// Aligned with `src/ui/theme.ts` so Ink screens and linear CLI output share
// the same 4-token palette: accent (success ✓), warning (!), destructive (✗),
// muted (secondary text, divisors, hints).

/** Green — success indicator, brand wordmark, accents. */
export const accent = chalk.hex("#4EBE7D");

/** Yellow — soft warnings. */
export const warning = chalk.hex("#FFCB1F");

/** Red — hard errors. */
export const destructive = chalk.hex("#F25F5C");

/** Gray — secondary text, hints, structural lines. */
export const muted = chalk.hex("#808080");

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

/** Warning: warning ! + default-color message. Optional muted hint. */
export function printWarning(msg: string, hint?: string): void {
	if (isQuiet()) return;
	const hintPart = hint ? ` ${muted(`— ${hint}`)}` : "";
	process.stdout.write(`${warning("!")} ${msg}${hintPart}\n`);
}

/** Error: destructive ✗ + default-color message. Optional muted hint. Always to stderr. */
export function printError(msg: string, hint?: string): void {
	const hintPart = hint ? ` ${muted(`— ${hint}`)}` : "";
	process.stderr.write(`${destructive("✗")} ${msg}${hintPart}\n`);
}

/** Hint/info: muted indented text. */
export function printHint(msg: string): void {
	if (isQuiet()) return;
	process.stdout.write(`${muted(`  ${msg}`)}\n`);
}
