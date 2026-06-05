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

import { DIVIDER, layout } from "../design/tokens.ts";
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

/** Heading column (col 2) and content column (col 4), from the shared tokens. */
const HEAD_INDENT = " ".repeat(layout.headingIndent);
const BODY_INDENT = " ".repeat(layout.contentIndent);

/**
 * Render a full help screen as a single ANSI-decorated string. The output is
 * wrapped in leading/trailing blank lines so it always breathes away from the
 * shell prompt, and indent levels mirror the Ink `Section` component:
 *   - title at col 0
 *   - section heading + divisor at col 2
 *   - section content (entries / body) at col 4
 *   - footer at col 2
 */
export function renderHelp(spec: HelpSpec): string {
	const parts: string[] = [];

	// Leading blank line — pushes the title down from whatever was previously
	// on the operator's terminal (shell prompt, prior command output).
	parts.push("");

	// Title + tagline ------------------------------------------------------
	parts.push(`${accent.bold(spec.title)} ${muted("—")} ${spec.tagline}`);

	// Usage block ----------------------------------------------------------
	parts.push("");
	parts.push(renderHeading("Usage"));
	parts.push(`${BODY_INDENT}${spec.usage}`);

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
				parts.push(line === "" ? "" : `${BODY_INDENT}${line}`);
			}
		}
	}

	// Footer ---------------------------------------------------------------
	if (spec.footer) {
		parts.push("");
		for (const line of spec.footer.split("\n")) {
			parts.push(line === "" ? "" : `${HEAD_INDENT}${muted(line)}`);
		}
	}

	// Trailing blank line — separates the help from the shell prompt that
	// will land on the next row.
	parts.push("");

	return `${parts.join("\n")}\n`;
}

function renderHeading(heading: string): string {
	return `${HEAD_INDENT}${chalk.bold(heading)}\n${HEAD_INDENT}${muted(DIVIDER)}`;
}

function renderEntry(entry: HelpEntry): string {
	const paddedName = entry.name.padEnd(NAME_COL_WIDTH);
	return `${BODY_INDENT}${chalk.bold(paddedName)}${muted(entry.description)}`;
}
