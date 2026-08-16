/**
 * Help-screen renderer for `gship <command> --help` output.
 *
 * Centralizes the visual hierarchy used by every help page so the top-level
 * `gship help` and the per-command pages share the same look: title in accent
 * bold, tagline default, section headings bold with a muted divisor, entry
 * names accent + bold, descriptions in default color, footer in muted.
 *
 * Output is plain ANSI and written via `process.stdout.write`.
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
	/** First-line title (e.g. `gship`, `gship init`). */
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

const DIVIDER = '─'.repeat(50);
const HEAD_INDENT = '  ';
const BODY_INDENT = '    ';

/**
 * Render a full help screen as a single ANSI-decorated string. The output is
 * wrapped in leading/trailing blank lines so it always breathes away from the
 * shell prompt:
 *   - title at col 0
 *   - section heading + divisor at col 2
 *   - section content (entries / body) at col 4
 *   - footer at col 2
 */
export function renderHelp(spec: HelpSpec): string {
	const parts = [
		'',
		`${accent.bold(spec.title)} ${muted('—')} ${spec.tagline}`,
		'',
		renderHeading('Usage'),
		`${BODY_INDENT}${spec.usage}`,
		...spec.sections.flatMap(renderSection),
		...renderFooter(spec.footer),
		'',
	];
	return `${parts.join("\n")}\n`;
}

function renderSection(section: HelpSection): string[] {
	return [
		'',
		renderHeading(section.heading),
		...(section.entries ?? []).map(renderEntry),
		...renderIndentedLines(section.body, BODY_INDENT),
	];
}

function renderFooter(footer: string | undefined): string[] {
	return footer === undefined ? [] : ['', ...renderIndentedLines(footer, HEAD_INDENT, muted)];
}

function renderIndentedLines(
	text: string | undefined,
	indent: string,
	decorate: (line: string) => string = (line) => line,
): string[] {
	if (text === undefined) return [];
	return text.split('\n').map((line) => (line === '' ? '' : `${indent}${decorate(line)}`));
}

function renderHeading(heading: string): string {
	return `${HEAD_INDENT}${chalk.bold(heading)}\n${HEAD_INDENT}${muted(DIVIDER)}`;
}

function renderEntry(entry: HelpEntry): string {
	const paddedName = entry.name.padEnd(NAME_COL_WIDTH);
	return `${BODY_INDENT}${chalk.bold(paddedName)}${muted(entry.description)}`;
}
