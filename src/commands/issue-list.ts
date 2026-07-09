// src/commands/issue-list.ts
//
// runIssueList() -- `cam issue list`: print the actionable backlog.
//
// Deterministic, in-process command: no tmux, no claude spawn. Reads
// issue_system from scripts/cam/project.toml via readIssueSystem (missing
// file or key defaults to 'local'):
//
//   - 'local' (default): reads the backlog via readBacklogFromMain (git
//     ls-tree + cat-file --batch from the `main` ref -- never a raw fs read
//     of the working dir) and renders the US-001 deriveBacklogView through
//     the shared src/logging linear print helpers. With --json, renders
//     deriveBacklogJson as pure JSON on stdout instead (no emitTitle/heading
//     decoration; US-002, this PRD).
//   - 'linear' / 'github': these backends own their own listing UX. Prints a
//     short hint pointing at the native UI and returns 0 -- never hard-fails,
//     even when --json is passed (the JSON contract only applies to 'local').
//
// The injected BacklogSpawnFn is the ONLY subprocess seam this command uses:
// there is no tmux import here at all, so a recording fake proves by
// construction that no send-keys / list-panes / pane-spawn / claude-spawn
// ever fires (US-002 AC5).
//
// CAM-190 US-002.

import { join } from 'node:path';

import { readIssueSystem } from '../config/issue-system.ts';
import { loadConfig } from '../config/toml.ts';
import { readBacklogFromMain, type BacklogSpawnFn } from '../issues/backlog.ts';
import {
	deriveBacklogJson,
	deriveBacklogView,
	type BacklogViewEntry,
	type BacklogViewGroup,
} from '../issues/list.ts';
import type { IssueStage } from '../issues/types.ts';
import { printHint, visibleLength } from '../logging/color.ts';
import {
	emitContent,
	emitMutedHint,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Human-readable heading per lifecycle stage, rendered in DEFAULT_STAGES order. */
const STAGE_HEADINGS: Record<IssueStage, string> = {
	idea: 'Idea',
	specified: 'Specified',
	planned: 'Planned',
	shipped: 'Shipped',
};

/** Row layout: `<priority>  <id>  <title>[ [blocked: ...]]`. */
const PRIORITY_WIDTH = 4;
const ID_WIDTH = 10;
const TITLE_BUDGET = 52;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunIssueListOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Override scripts/cam/project.toml path (default: join(cwd, 'scripts/cam/project.toml')). */
	configPath?: string;
	/** Injectable spawn for the readBacklogFromMain git ls-tree/cat-file pair. Default: node:child_process.spawnSync. */
	spawnFn?: BacklogSpawnFn;
	/** Injectable writer capturing every printed line. Default: process.stdout.write. */
	writer?: (s: string) => void;
	/** --all: include the shipped group. Default view excludes shipped and abandoned. */
	all?: boolean;
	/**
	 * --json: emit the machine snapshot ({ counts, plannable, byStage }) as
	 * pure JSON on stdout instead of the human-readable rendered table
	 * (US-002). Combinable with --all. Only affects the 'local' issue_system
	 * backend; 'linear'/'github' keep printing their hint regardless.
	 */
	json?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Truncate `title` to `maxLen` visible characters, appending an ellipsis when cut. */
function truncateTitle(title: string, maxLen: number): string {
	if (visibleLength(title) <= maxLen) return title;
	return `${title.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Format one backlog row: priority (blank when unranked), id, truncated title, blocked marker. */
function renderRow(entry: BacklogViewEntry): string {
	const priority = entry.issue.rank !== undefined ? String(entry.issue.rank) : '';
	const title = truncateTitle(entry.issue.title, TITLE_BUDGET);
	const blockedSuffix =
		entry.unmetBlockers.length > 0 ? ` [blocked: ${entry.unmetBlockers.join(', ')}]` : '';
	return `${priority.padStart(PRIORITY_WIDTH)}  ${entry.issue.id.padEnd(ID_WIDTH)}  ${title}${blockedSuffix}`;
}

/** Render every non-empty stage group as a heading + rows. Returns whether anything was printed. */
function renderGroups(groups: BacklogViewGroup[]): boolean {
	let printedAny = false;
	for (const group of groups) {
		if (group.entries.length === 0) continue;
		printedAny = true;
		emitSectionHeading(STAGE_HEADINGS[group.stage]);
		for (const entry of group.entries) {
			emitContent(renderRow(entry));
		}
	}
	return printedAny;
}

/** Short hint pointing at the native UI for a non-'local' issue_system backend. */
function backendHint(issueSystem: string): string {
	if (issueSystem === 'linear') {
		return 'Backlog is tracked in Linear -- open the Linear app to view it.';
	}
	return 'Backlog is tracked in GitHub Issues -- run `gh issue list` to view it.';
}

/**
 * Run `fn` with process.stdout.write temporarily redirected through `writer`
 * (when provided), so the shared src/logging emit* helpers -- which always
 * write to process.stdout directly, matching every other linear-print command
 * -- can still be driven through an injectable seam for deterministic tests
 * (mirrors printConfigShow's writer parameter). Restores the original write
 * in a finally block so a thrown error never leaves stdout patched.
 */
function withWriter<T>(writer: ((s: string) => void) | undefined, fn: () => T): T {
	if (writer === undefined) return fn();
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		writer(typeof chunk === 'string' ? chunk : chunk.toString());
		return true;
	}) as typeof process.stdout.write;
	try {
		return fn();
	} finally {
		process.stdout.write = original;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Print the actionable backlog (`cam issue list`). Always returns 0: the
 * 'linear'/'github' branch is a hint, not an error, and the 'local' branch
 * has no failure path of its own (readBacklogFromMain returns [] on any read
 * error, rendering an empty backlog rather than throwing).
 */
export function runIssueList(options: RunIssueListOptions): number {
	const { cwd } = options;
	const configPath = options.configPath ?? join(cwd, 'scripts', 'cam', 'project.toml');

	return withWriter(options.writer, () => {
		const config = loadConfig(configPath);
		const issueSystem = readIssueSystem(config);

		if (issueSystem === 'local') {
			const backlog = readBacklogFromMain(cwd, options.spawnFn);

			if (options.json) {
				// Pure JSON on stdout: no emitTitle/heading decoration (US-002 AC1).
				const json = deriveBacklogJson(backlog, { includeShipped: options.all ?? false });
				process.stdout.write(`${JSON.stringify(json)}\n`);
				return 0;
			}

			emitTitle('cam issue list');
			const groups = deriveBacklogView(backlog, { includeShipped: options.all ?? false });
			const printedAny = renderGroups(groups);
			if (!printedAny) {
				printHint('No actionable backlog items.');
			}
			emitTrailingBlank();
			return 0;
		}

		emitTitle('cam issue list');
		emitSectionHeading(issueSystem === 'linear' ? 'Linear' : 'GitHub Issues');
		emitMutedHint(backendHint(issueSystem));
		emitTrailingBlank();
		return 0;
	});
}
