// src/commands/journal-archive.ts
//
// archiveJournalOnMain() -- move the oldest third of scripts/cam/journal.md's
// entries to scripts/cam/journal.archive.md directly on main, once the entry
// count exceeds a threshold, so the journal stops growing without bound.
//
// Design goals (mirrors src/commands/domain-docs.ts, the CAM-118 US-002
// precedent for a brand-new on-main writer):
//   - journal.md and journal.archive.md are both read from main via
//     `git show main:<path>` (never the working tree).
//   - journal.archive.md is lazily created: absent-on-main is treated as
//     null (bootstrap with a minimal header), never an error.
//   - Both files land in ONE atomic ref-only commit via commitTreeToMain
//     (2-element FileWrite[]), same on-main-or-off-main path either way
//     (CAM-133 rule: never a working-tree commit path).
//   - Push to origin main is best-effort.
//   - No LLM summarization: the moved entries are relocated verbatim.
//   - Guard + push are the SHARED exports from src/git/on-main.ts (no
//     private copy -- see the GOTCHA comment there, CAM-118 US-002).
//
// CAM-125 US-001 (journal archive core logic).

import { checkMainUpToDate, commitTreeToMain, pushMainBestEffort } from '../git/on-main.ts';
import type { FileWrite, SpawnFn } from '../git/on-main.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn from the shared module so callers do not need to update
// their import paths.
export type { SpawnFn };

const JOURNAL_PATH = 'scripts/cam/journal.md';
const ARCHIVE_PATH = 'scripts/cam/journal.archive.md';
const ENTRIES_MARKER = '<!-- ENTRIES_BELOW -->';
/** Archive when the post-marker entry count exceeds this. Exported so the CLI
 *  arg parser (index.ts parseJournalArgs) can mirror the same default when
 *  --threshold is not passed. */
export const DEFAULT_THRESHOLD = 50;

const ARCHIVE_HEADER = [
	'# Cam Journal Archive',
	'',
	'Entries archived from scripts/cam/journal.md by `cam journal archive`,',
	'oldest-first. This file is read-only history: do not edit by hand.',
	'',
	ENTRIES_MARKER,
].join('\n');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ArchiveJournalOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Archive when the post-marker entry count exceeds this. Default 50. */
	threshold?: number;
	/** Injectable clock -- returns the current Date. Default () => new Date(). */
	clock?: () => Date;
}

/** Successful outcome: either a validated no-op or an archived commit. */
export interface ArchiveJournalOnMainSuccess {
	ok: true;
	/** Number of entries moved to the archive. 0 for the no-op path. */
	archived: number;
	/** Total post-marker entry count found in journal.md. */
	entries: number;
	/** Short sha (7 chars) of the new commit on main. Empty string on no-op. */
	sha: string;
}

export type ArchiveJournalOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'journal-missing' }
	| { ok: false; reason: 'marker-missing' };

export type ArchiveJournalOnMainResult = ArchiveJournalOnMainSuccess | ArchiveJournalOnMainError;

// ---------------------------------------------------------------------------
// Read-from-main helpers
// ---------------------------------------------------------------------------

/**
 * Read journal.md from main via `git show main:scripts/cam/journal.md`.
 * Returns null on a non-zero exit (journal.md missing from main).
 */
function readJournalFromMain(cwd: string, spawnFn: SpawnFn): string | null {
	const result = spawnFn('git', ['-C', cwd, 'show', `main:${JOURNAL_PATH}`], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) return null;
	return result.stdout ?? '';
}

/**
 * Read journal.archive.md from main via `git show main:<path>`.
 * Returns null on a non-zero exit (lazy creation: the archive file is not
 * guaranteed to pre-exist, unlike journal.md).
 */
function readArchiveFromMain(cwd: string, spawnFn: SpawnFn): string | null {
	const result = spawnFn('git', ['-C', cwd, 'show', `main:${ARCHIVE_PATH}`], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) return null;
	return result.stdout ?? '';
}

// ---------------------------------------------------------------------------
// Marker-relative entry parsing
// ---------------------------------------------------------------------------

interface ParsedJournal {
	/** journal.md lines from the start through (and including) the marker line. */
	preambleLines: string[];
	/** One entry per '## ' header found strictly AFTER the marker, oldest first. */
	blocks: string[];
}

/** Drop trailing blank lines from a line array (used to trim block boundaries). */
function trimTrailingBlankLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && (lines[end - 1] ?? '') === '') end--;
	return lines.slice(0, end);
}

/**
 * Parse journal.md content into a preamble (everything through the marker
 * line, never counted or altered) and an ordered list of entry blocks (only
 * '## ' headers strictly AFTER the marker).
 *
 * Returns null when the marker is absent (malformed journal.md).
 */
function parseJournalEntries(content: string): ParsedJournal | null {
	const allLines = content.split('\n');
	const markerIdx = allLines.findIndex((l) => l.trim() === ENTRIES_MARKER);
	if (markerIdx === -1) return null;

	const preambleLines = allLines.slice(0, markerIdx + 1);
	const entriesLines = allLines.slice(markerIdx + 1);

	const headerIdxs: number[] = [];
	for (let i = 0; i < entriesLines.length; i++) {
		if ((entriesLines[i] ?? '').startsWith('## ')) headerIdxs.push(i);
	}

	const blocks: string[] = [];
	for (let i = 0; i < headerIdxs.length; i++) {
		const start = headerIdxs[i] ?? 0;
		const nextStart = headerIdxs[i + 1];
		const end = nextStart !== undefined ? nextStart : entriesLines.length;
		const blockLines = trimTrailingBlankLines(entriesLines.slice(start, end));
		blocks.push(blockLines.join('\n'));
	}

	return { preambleLines, blocks };
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

/** Pointer line inserted into journal.md, referencing the archive file and the injected clock date. */
function buildPointerLine(archivedCount: number, dateStr: string): string {
	const noun = archivedCount === 1 ? 'entry' : 'entries';
	return `> Archived ${archivedCount} oldest ${noun} to ${ARCHIVE_PATH} on ${dateStr}. See that file for the full history.`;
}

/** Rebuild journal.md: preamble + marker (unchanged), pointer line, then the remaining (newest) entries. */
function buildJournalContent(
	preambleLines: string[],
	pointerLine: string,
	remainingBlocks: string[],
): string {
	const parts = [preambleLines.join('\n'), '', pointerLine];
	if (remainingBlocks.length > 0) {
		parts.push('', remainingBlocks.join('\n\n'));
	}
	return `${parts.join('\n')}\n`;
}

/** Rebuild journal.archive.md: existing content (or a bootstrapped header) plus the newly archived blocks, cumulative. */
function buildArchiveContent(existing: string | null, archivedBlocks: string[]): string {
	const base = existing === null ? ARCHIVE_HEADER : existing.replace(/\n+$/, '');
	return `${base}\n\n${archivedBlocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Move the oldest third of journal.md's post-marker entries to
 * journal.archive.md, atomically, directly on main.
 *
 * Guards (in order, before any mutation):
 *   0. Up-to-date guard (detached-head, missing-main, diverged).
 *   1. journal.md must be readable from main -- 'journal-missing' otherwise.
 *   2. journal.md must contain the ENTRIES_BELOW marker -- 'marker-missing' otherwise.
 *   3. entries <= threshold: no-op ({ ok: true, archived: 0, entries }), no
 *      further reads or mutations.
 *
 * Steps (entries > threshold):
 *   4. archivedCount = max(1, floor(entries / 3)).
 *   5. Split blocks into archived (oldest) and remaining (newest).
 *   6. Read journal.archive.md from main (null when absent -- lazy creation).
 *   7. Build both new file contents.
 *   8. commitTreeToMain([journal.md, journal.archive.md], 'chore(cam): journal
 *      archive <k> entries') -- one atomic commit.
 *   9. Best-effort push to origin main.
 */
export function archiveJournalOnMain(
	options: ArchiveJournalOnMainOptions,
): ArchiveJournalOnMainResult {
	const { cwd, spawnFn } = options;
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const clock = options.clock ?? (() => new Date());

	const guard = checkMainUpToDate(cwd, spawnFn, 'archive journal entries');
	if (!guard.ok) return guard;
	const { localMainSha } = guard;

	const journalContent = readJournalFromMain(cwd, spawnFn);
	if (journalContent === null) {
		printError(
			'journal.md missing on main',
			'scripts/cam/journal.md must pre-exist on main (created by cam init); ' +
				'run: git show main:scripts/cam/journal.md to confirm',
		);
		return { ok: false, reason: 'journal-missing' };
	}

	const parsed = parseJournalEntries(journalContent);
	if (parsed === null) {
		printError(
			'journal.md marker missing',
			`scripts/cam/journal.md must contain the ${ENTRIES_MARKER} marker`,
		);
		return { ok: false, reason: 'marker-missing' };
	}

	const entries = parsed.blocks.length;
	if (entries <= threshold) {
		return { ok: true, archived: 0, entries, sha: '' };
	}

	const archivedCount = Math.max(1, Math.floor(entries / 3));
	const archivedBlocks = parsed.blocks.slice(0, archivedCount);
	const remainingBlocks = parsed.blocks.slice(archivedCount);

	const dateStr = clock().toISOString().slice(0, 10);
	const pointerLine = buildPointerLine(archivedCount, dateStr);
	const newJournalContent = buildJournalContent(parsed.preambleLines, pointerLine, remainingBlocks);

	const existingArchive = readArchiveFromMain(cwd, spawnFn);
	const newArchiveContent = buildArchiveContent(existingArchive, archivedBlocks);

	const commitMsg = `chore(cam): journal archive ${archivedCount} entries`;
	const files: FileWrite[] = [
		{ path: JOURNAL_PATH, content: newJournalContent },
		{ path: ARCHIVE_PATH, content: newArchiveContent },
	];
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-journal-archive-');

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, archived: archivedCount, entries, sha };
}
