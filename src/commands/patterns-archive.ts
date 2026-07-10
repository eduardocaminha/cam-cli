// src/commands/patterns-archive.ts
//
// archivePatternsOnMain() -- move only the RESOLVED-marked bullets out of
// scripts/cam/patterns.md into scripts/cam/patterns.archive.md, directly on
// main, so the hot file stays scannable without losing living invariants or
// history.
//
// Design goals (mirrors src/commands/journal-archive.ts, the CAM-125 US-001
// precedent for a marker-relative on-main writer):
//   - patterns.md and patterns.archive.md are both read from main via
//     `git show main:<path>` (never the working tree).
//   - patterns.archive.md is lazily created: absent-on-main is treated as
//     null (bootstrap with a minimal header), never an error.
//   - Both files land in ONE atomic ref-only commit via commitTreeToMain
//     (2-element FileWrite[]), same on-main-or-off-main path either way
//     (CAM-133 rule: never a working-tree commit path).
//   - Push to origin main is best-effort.
//   - No LLM summarization: the moved bullets are relocated verbatim.
//   - Guard + push are the SHARED exports from src/git/on-main.ts (no
//     private copy -- see the GOTCHA comment there, CAM-118 US-002).
//
// GOTCHA (issue CAM-231): unlike journal.md's "oldest third" age/count-based
// selection, patterns.md bullets are append-only living invariants where old
// != stale. Selection here is MARKER-based only: a bullet moves if and only
// if it carries an explicit resolved tag, `[resolved YYYY-MM]`, anywhere in
// its text. Position, age, and count never decide selection. This regex is
// the authoritative definition of the marker; US-004 retrofits existing
// entries and documents this convention to match.
//
// CAM-231 US-001 (patterns archive core logic).

import { checkMainUpToDate, commitTreeToMain, pushMainBestEffort } from '../git/on-main.ts';
import type { FileWrite, SpawnFn } from '../git/on-main.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn from the shared module so callers do not need to update
// their import paths.
export type { SpawnFn };

const PATTERNS_PATH = 'scripts/cam/patterns.md';
const ARCHIVE_PATH = 'scripts/cam/patterns.archive.md';

/** Authoritative resolved-marker regex: `[resolved YYYY-MM]` anywhere in a bullet's text. */
export const RESOLVED_MARKER_RE = /\[resolved \d{4}-\d{2}\]/;

const ARCHIVE_HEADER = [
	'# Codebase Patterns Archive',
	'',
	'Resolved patterns archived from scripts/cam/patterns.md by',
	'`cam patterns archive`. This file is read-only history: do not edit by hand.',
].join('\n');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ArchivePatternsOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
}

/** Successful outcome: either a validated no-op or an archived commit. */
export interface ArchivePatternsOnMainSuccess {
	ok: true;
	/** Number of bullets moved to the archive. 0 for the no-op path. */
	archived: number;
	/** Short sha (7 chars) of the new commit on main. Empty string on no-op. */
	sha: string;
}

export type ArchivePatternsOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'patterns-missing' };

export type ArchivePatternsOnMainResult = ArchivePatternsOnMainSuccess | ArchivePatternsOnMainError;

// ---------------------------------------------------------------------------
// Read-from-main helpers
// ---------------------------------------------------------------------------

/**
 * Read patterns.md from main via `git show main:scripts/cam/patterns.md`.
 * Returns null on a non-zero exit (patterns.md missing from main).
 */
function readPatternsFromMain(cwd: string, spawnFn: SpawnFn): string | null {
	const result = spawnFn('git', ['-C', cwd, 'show', `main:${PATTERNS_PATH}`], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) return null;
	return result.stdout ?? '';
}

/**
 * Read patterns.archive.md from main via `git show main:<path>`.
 * Returns null on a non-zero exit (lazy creation: the archive file is not
 * guaranteed to pre-exist).
 */
function readArchiveFromMain(cwd: string, spawnFn: SpawnFn): string | null {
	const result = spawnFn('git', ['-C', cwd, 'show', `main:${ARCHIVE_PATH}`], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) return null;
	return result.stdout ?? '';
}

// ---------------------------------------------------------------------------
// Bullet-relative parsing
// ---------------------------------------------------------------------------

export interface ParsedPatterns {
	/** patterns.md lines before the first top-level `- ` bullet (intro preamble, always retained). */
	preambleLines: string[];
	/** One entry per top-level `- ` bullet, in original order. */
	blocks: string[];
}

/** Drop trailing blank lines from a line array (used to trim block/preamble boundaries). */
function trimTrailingBlankLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && (lines[end - 1] ?? '') === '') end--;
	return lines.slice(0, end);
}

/**
 * Parse patterns.md content into a preamble (everything before the first
 * top-level `- ` bullet, never altered) and an ordered list of bullet blocks.
 *
 * A bullet block starts at a line beginning with `- ` and runs through
 * (but not including) the next such line, so a bullet that wraps across
 * multiple lines is captured whole.
 */
export function parsePatternsBullets(content: string): ParsedPatterns {
	const allLines = content.split('\n');

	const bulletIdxs: number[] = [];
	for (let i = 0; i < allLines.length; i++) {
		if ((allLines[i] ?? '').startsWith('- ')) bulletIdxs.push(i);
	}

	const firstBulletIdx = bulletIdxs[0];
	const preambleLines =
		firstBulletIdx !== undefined ? allLines.slice(0, firstBulletIdx) : allLines.slice();

	const blocks: string[] = [];
	for (let i = 0; i < bulletIdxs.length; i++) {
		const start = bulletIdxs[i] ?? 0;
		const nextStart = bulletIdxs[i + 1];
		const end = nextStart !== undefined ? nextStart : allLines.length;
		const blockLines = trimTrailingBlankLines(allLines.slice(start, end));
		blocks.push(blockLines.join('\n'));
	}

	return { preambleLines, blocks };
}

/** True when a bullet block carries the resolved marker anywhere in its text. */
export function isResolved(block: string): boolean {
	return RESOLVED_MARKER_RE.test(block);
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

/** Rebuild patterns.md: preamble (unchanged) plus the remaining (unmarked) bullets. */
function buildPatternsContent(preambleLines: string[], remainingBlocks: string[]): string {
	const preamble = trimTrailingBlankLines(preambleLines).join('\n');
	if (remainingBlocks.length === 0) return `${preamble}\n`;
	return `${preamble}\n\n${remainingBlocks.join('\n\n')}\n`;
}

/** Rebuild patterns.archive.md: existing content (or a bootstrapped header) plus the newly archived blocks, cumulative. */
function buildArchiveContent(existing: string | null, archivedBlocks: string[]): string {
	const base = existing === null ? ARCHIVE_HEADER : existing.replace(/\n+$/, '');
	return `${base}\n\n${archivedBlocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Move only the resolved-marked bullets of patterns.md to
 * patterns.archive.md, atomically, directly on main.
 *
 * Guards (in order, before any mutation):
 *   0. Up-to-date guard (detached-head, missing-main, diverged).
 *   1. patterns.md must be readable from main -- 'patterns-missing' otherwise.
 *   2. No resolved-marked bullets found: no-op ({ ok: true, archived: 0 }),
 *      no further reads or mutations.
 *
 * Steps (marked bullets found):
 *   3. Split blocks into archived (marked) and remaining (unmarked), each
 *      preserving original order.
 *   4. Read patterns.archive.md from main (null when absent -- lazy creation).
 *   5. Build both new file contents.
 *   6. commitTreeToMain([patterns.md, patterns.archive.md], 'chore(cam):
 *      patterns archive <k> entries') -- one atomic commit.
 *   7. Best-effort push to origin main.
 */
export function archivePatternsOnMain(
	options: ArchivePatternsOnMainOptions,
): ArchivePatternsOnMainResult {
	const { cwd, spawnFn } = options;

	const guard = checkMainUpToDate(cwd, spawnFn, 'archive patterns entries');
	if (!guard.ok) return guard;
	const { localMainSha } = guard;

	const patternsContent = readPatternsFromMain(cwd, spawnFn);
	if (patternsContent === null) {
		printError(
			'patterns.md missing on main',
			'scripts/cam/patterns.md must pre-exist on main (created by cam init); ' +
				'run: git show main:scripts/cam/patterns.md to confirm',
		);
		return { ok: false, reason: 'patterns-missing' };
	}

	const parsed = parsePatternsBullets(patternsContent);
	const archivedBlocks = parsed.blocks.filter(isResolved);
	const remainingBlocks = parsed.blocks.filter((b) => !isResolved(b));

	if (archivedBlocks.length === 0) {
		return { ok: true, archived: 0, sha: '' };
	}

	const newPatternsContent = buildPatternsContent(parsed.preambleLines, remainingBlocks);

	const existingArchive = readArchiveFromMain(cwd, spawnFn);
	const newArchiveContent = buildArchiveContent(existingArchive, archivedBlocks);

	const commitMsg = `chore(cam): patterns archive ${archivedBlocks.length} entries`;
	const files: FileWrite[] = [
		{ path: PATTERNS_PATH, content: newPatternsContent },
		{ path: ARCHIVE_PATH, content: newArchiveContent },
	];
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-patterns-archive-');

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, archived: archivedBlocks.length, sha };
}
