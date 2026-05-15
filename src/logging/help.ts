/**
 * Help-screen renderer for `cam <command> --help` output.
 *
 * Centralizes the visual hierarchy used by every help page so the top-level
 * `cam help` and the per-command pages share the same look: title in accent
 * bold, tagline default, section headings bold with a muted divisor, entry
 * names accent + bold, descriptions in default color, footer in muted.
 *
 * Output is plain ANSI — the help is written via `process.stdout.write`, not
 * through Ink, so it lines up with the linear print helpers in `color.ts`.
 */

import { accent, chalk, muted } from "./color.ts";

/** A single command/option/flag row inside a Section. */
export interface HelpEntry {
	/** Display label (e.g. `init [options]`, `--help, -h`). Rendered accent bold. */
	name: string;
	/** Free-text description rendered in the terminal's default color. */
	description: string;
}

/**
 * A grouped block under a bold heading and a muted divisor. A section may
 * carry either structured `entries` (bold name + muted description columns —
 * used for command/option lists) or free-form `body` prose (rendered indented
 * in default color — used for "Behaviour" / "What it does" narrative blocks).
 * Both may be set, in which case entries render first.
 */
export interface HelpSection {
	heading: string;
	entries?: HelpEntry[];
	body?: string;
}

export interface HelpSpec {
	/** First-line title (e.g. `cam`, `cam init`). */
	title: string;
	/** Tagline rendered after `—` on the same row. */
	tagline: string;
	/** One-line usage hint, rendered under a "Usage" heading. */
	usage: string;
	/** Ordered grouped blocks (Commands, Options, etc.). */
	sections: HelpSection[];
	/** Optional trailing block printed in muted (multi-line allowed). */
	footer?: string;
}

/** Column width for the entry `name`. Names longer than this push the description further right. */
const NAME_COL_WIDTH = 24;

/** Width of section divisors. Matches Ink's `Section` (50 cells). */
const DIVIDER_WIDTH = 50;

const DIVIDER = "─".repeat(DIVIDER_WIDTH);

/**
 * Render a full help screen as a single ANSI-decorated string. Trailing
 * newline included — callers can write the result straight to stdout.
 */
export function renderHelp(spec: HelpSpec): string {
	const parts: string[] = [];

	// Title + tagline ------------------------------------------------------
	parts.push(`${accent.bold(spec.title)} ${muted("—")} ${spec.tagline}`);
	parts.push("");

	// Usage block ----------------------------------------------------------
	parts.push(renderHeading("Usage"));
	parts.push(`  ${spec.usage}`);

	// Sections -------------------------------------------------------------
	for (const section of spec.sections) {
		parts.push("");
		parts.push(renderHeading(section.heading));
		if (section.entries) {
			for (const entry of section.entries) {
				parts.push(renderEntry(entry));
			}
		}
		if (section.body) {
			for (const line of section.body.split("\n")) {
				parts.push(line === "" ? "" : `  ${line}`);
			}
		}
	}

	// Footer ---------------------------------------------------------------
	if (spec.footer) {
		parts.push("");
		for (const line of spec.footer.split("\n")) {
			parts.push(muted(line));
		}
	}

	return `${parts.join("\n")}\n`;
}

function renderHeading(heading: string): string {
	return `${chalk.bold(heading)}\n${muted(DIVIDER)}`;
}

function renderEntry(entry: HelpEntry): string {
	const paddedName = entry.name.padEnd(NAME_COL_WIDTH);
	return `  ${chalk.bold(paddedName)}${muted(entry.description)}`;
}
