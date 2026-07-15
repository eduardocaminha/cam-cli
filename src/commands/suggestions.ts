// src/commands/suggestions.ts
//
// SuggestionEntry data model + on-main JSONL writers/reader for
// scripts/cam/suggestions.jsonl -- the shared "suggestions pen" that the
// terminal-verdict hook (CAM-189) and the `cam suggestions` CLI both read
// from and write to, instead of each reviewer SUGGESTION being auto-filed as
// its own idea-stage issue.
//
// Design mirrors appendJournalEntryOnMain (src/commands/journal.ts:525-596):
//   - Validate pure inputs before any git calls (fail-fast).
//   - Read suggestions.jsonl from main via `git show main:<path>` (NEVER the
//     working tree).
//   - Does NOT bootstrap a missing file: a non-zero `git show` exit is a
//     structured error, mirroring the journal writer's journal-missing
//     behavior. Seeding the empty file on main is a later story (US-002).
//   - Append as ONE JSON line, dedup by `fingerprint` against existing lines.
//   - Commit via the SHARED commitTreeToMain/checkMainUpToDate/
//     pushMainBestEffort helpers in src/git/on-main.ts (no new private
//     copies -- the jscpd gate already flags verbatim duplication of this
//     plumbing, patterns.md line 272).
//
// US-005 (promoteSuggestionOnMain/dismissSuggestionOnMain) additions:
//   - promote files a real issue via writeIssueFile (src/issues/alloc.ts),
//     preserving derivedFrom from the entry's sourceIssue (resolveIssueId +
//     the issue_prefix read from project.toml, same lookup
//     createLocalIssueOnMain itself performs), embeds the entry's OWN
//     already-stored fingerprint in a `suggestion-fingerprint: <fp>`
//     description line (buildFollowUpIssue's format, src/supervisor/
//     suggestion-followups.ts), then removes that one line from the pen.
//   - dismiss just removes the one matching-fingerprint line, no issue filed.
//   - Both look up the entry BEFORE mutating anything: an unknown fingerprint
//     is a structured `not-found` error, no commit, no issue filed.
//
// US-002 (CAM-290) additions:
//   - promote no longer routes through createLocalIssueOnMain: it calls
//     writeIssueFile directly, passing the rewritten pen content as
//     `extraFiles` and a `commitMessage` override, so the filed issue JSON
//     and the pen-line removal land in ONE atomic on-main commit (never an
//     intermediate main state with the issue filed but the pen line still
//     present). The id is re-derived inside writeIssueFile's own CAS retry
//     loop; no id/path is pre-computed and threaded in.
//
// US-002 (CAM-300) additions:
//   - appendSuggestionOnMain, dismissSuggestionOnMain, and
//     promoteSuggestionOnMain each pass a FileWritesFn/extraFiles callback
//     (US-001, CAM-300) instead of a static whole-file FileWrite, so every
//     CAS retry attempt re-reads suggestions.jsonl from the advanced main
//     (readPenContentFromMain) and re-derives its content (append re-runs
//     its dedup check; dismiss/promote re-run removeSuggestionLine keyed by
//     fingerprint) against that fresh read, instead of reusing a whole-file
//     rewrite computed once from the pre-mutation read. This is what makes a
//     suggestion line concurrently appended or removed between the initial
//     read and the winning commit survive instead of being clobbered.
//
// CAM-285 US-001, US-005. CAM-290 US-002. CAM-300 US-002.

import {
	checkMainUpToDate,
	commitTreeToMain,
	pushMainBestEffort,
	type SpawnFn,
} from '../git/on-main.ts';
import { parseToml } from '../config/toml.ts';
import { resolveIssueId } from '../issues/resolve-id.ts';
import { writeIssueFile } from '../issues/alloc.ts';
import type { ClockFn } from './issue-file.ts';
import { SUGGESTION_FINGERPRINT_PREFIX } from '../supervisor/suggestion-followups.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn so callers do not need to reach into src/git/on-main.ts directly.
export type { SpawnFn };

// ---------------------------------------------------------------------------
// SuggestionEntry schema
// ---------------------------------------------------------------------------

/** Git-relative path of the suggestions pen, read/written on main only. */
export const SUGGESTIONS_JSONL_PATH = 'scripts/cam/suggestions.jsonl';

/**
 * One reviewer SUGGESTION finding held in the pen, pending triage
 * (`cam suggestions list/promote/dismiss`, later stories in this PRD).
 */
export interface SuggestionEntry {
	/** Stable short hash of the finding (fingerprintFinding, 12 hex chars). Dedup key. */
	fingerprint: string;
	/** Short human-readable title (truncated finding text). */
	title: string;
	/** Full finding text. */
	body: string;
	/** Source branch name or cycle id identifying where the review ran. */
	sourceBranch: string;
	/** Completed review round number, when available. */
	reviewRound?: number;
	/** Parent issue number backing the PRD cycle, when available. */
	sourceIssue?: number;
	/** ISO 8601 timestamp the entry was appended to the pen. */
	filedAt: string;
}

const REQUIRED_FIELDS: ReadonlyArray<keyof SuggestionEntry> = [
	'fingerprint',
	'title',
	'body',
	'sourceBranch',
	'filedAt',
];

/**
 * Validate that all required fields are present and non-empty.
 * Returns an array of missing field names (empty = valid).
 */
function validateEntry(entry: SuggestionEntry): string[] {
	return REQUIRED_FIELDS.filter(
		(field) => !entry[field] || String(entry[field]).trim() === '',
	);
}

// ---------------------------------------------------------------------------
// JSONL parsing (shared by readSuggestionsFromMain and the append-time dedup)
// ---------------------------------------------------------------------------

/**
 * Parse suggestions.jsonl content into SuggestionEntry[].
 * Tolerates a trailing newline and blank lines (both produce an empty string
 * after split, filtered out); returns [] for empty/whitespace-only content.
 */
function parseSuggestionsJsonl(content: string): SuggestionEntry[] {
	return content
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as SuggestionEntry);
}

/**
 * Read raw suggestions.jsonl content from main via `git show`. Returns
 * `{ ok: false }` (with printError already fired) when the pen is absent from
 * main; callers surface this as a structured `suggestions-missing` reason.
 * Shared by appendSuggestionOnMain, promoteSuggestionOnMain, and
 * dismissSuggestionOnMain so a third/fourth writer does not each hand-roll
 * its own `git show main:<path>` + missing-file guard (jscpd gate).
 */
function readPenContentFromMain(
	cwd: string,
	spawnFn: SpawnFn,
): { ok: true; content: string } | { ok: false } {
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', `main:${SUGGESTIONS_JSONL_PATH}`],
		{ encoding: 'utf8' },
	);
	// Non-zero exit means the file is absent from main. We do NOT bootstrap
	// it here -- suggestions.jsonl is seeded by `cam init` (US-002).
	if ((showResult.status ?? 1) !== 0) {
		printError(
			'suggestions.jsonl missing on main',
			`${SUGGESTIONS_JSONL_PATH} must pre-exist on main (seeded by cam init); ` +
				`run: git show main:${SUGGESTIONS_JSONL_PATH} to confirm`,
		);
		return { ok: false };
	}
	return { ok: true, content: showResult.stdout ?? '' };
}

/**
 * Remove the one JSONL line whose `fingerprint` matches from `content`. All
 * other lines -- including blank lines and the trailing-newline structure --
 * are pushed back byte-for-byte (never re-serialized), so only the matching
 * line is dropped. Returns `found: false` (content unchanged) when no line
 * matches, so callers can refuse to commit anything.
 */
function removeSuggestionLine(
	content: string,
	fingerprint: string,
): { updatedContent: string; found: boolean } {
	const rawLines = content.split('\n');
	let found = false;
	const kept: string[] = [];
	for (const rawLine of rawLines) {
		const trimmed = rawLine.trim();
		if (trimmed.length === 0) {
			kept.push(rawLine);
			continue;
		}
		const parsed = JSON.parse(trimmed) as SuggestionEntry;
		if (!found && parsed.fingerprint === fingerprint) {
			found = true;
			continue;
		}
		kept.push(rawLine);
	}
	return { updatedContent: kept.join('\n'), found };
}

/**
 * Append `entry` as one new JSON line to `content`, unless an entry with the
 * same fingerprint is already present in `content` (returned unchanged in
 * that case -- a concurrent writer may have already appended the same
 * entry). Shared by appendSuggestionOnMain's up-front dedup computation and
 * its per-attempt recompute callback (US-002, CAM-300) so both paths dedup
 * identically against whatever content they are given.
 */
function buildAppendedContent(content: string, entry: SuggestionEntry): string {
	const entries = parseSuggestionsJsonl(content);
	if (entries.some((e) => e.fingerprint === entry.fingerprint)) {
		return content;
	}
	const newLine = JSON.stringify(entry);
	return content.endsWith('\n') || content === ''
		? `${content}${newLine}\n`
		: `${content}\n${newLine}\n`;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface AppendSuggestionOnMainAppended {
	ok: true;
	fingerprint: string;
	/** false: a new line was appended and committed. */
	skipped: false;
	/** Short sha (7 chars) of the new commit on main. */
	sha: string;
}

export interface AppendSuggestionOnMainSkipped {
	ok: true;
	fingerprint: string;
	/** true: fingerprint already present in the pen; no commit fired. */
	skipped: true;
}

export interface AppendSuggestionOnMainError {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main' | 'suggestions-missing';
}

/**
 * Validation error shape: carries `errors` per the discriminated-union
 * pattern (patterns.md line 130: members without `errors` must NOT carry
 * it; callers narrow with `'errors' in result` before accessing it).
 */
export interface AppendSuggestionOnMainValidationError {
	ok: false;
	reason: 'validation';
	errors: string[];
}

export type AppendSuggestionOnMainResult =
	| AppendSuggestionOnMainAppended
	| AppendSuggestionOnMainSkipped
	| AppendSuggestionOnMainError
	| AppendSuggestionOnMainValidationError;

export interface AppendSuggestionOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** The suggestion entry to append. */
	entry: SuggestionEntry;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
}

// ---------------------------------------------------------------------------
// appendSuggestionOnMain
// ---------------------------------------------------------------------------

/**
 * Append one SuggestionEntry to scripts/cam/suggestions.jsonl on main.
 *
 * Does NOT bootstrap a missing file: if the pen is absent on main, `git show`
 * exits non-zero and this returns `{ ok: false, reason: 'suggestions-missing' }`
 * without committing anything (mirrors appendJournalEntryOnMain's
 * journal-missing behavior). Seeding the empty pen is US-002 of this PRD.
 *
 * Dedup: an entry whose fingerprint already appears as a JSONL line in the
 * pen is skipped (`{ ok: true, skipped: true }`, no commit fires) instead of
 * being appended a second time.
 */
export function appendSuggestionOnMain(
	options: AppendSuggestionOnMainOptions,
): AppendSuggestionOnMainResult {
	const { cwd, entry, spawnFn } = options;

	// Step 1: validate pure inputs BEFORE any git calls (fail-fast pattern,
	// patterns.md line 130: validate inputs before the git show read).
	const missingFields = validateEntry(entry);
	if (missingFields.length > 0) {
		printError(
			'missing required fields',
			`suggestion entry is missing: ${missingFields.join(', ')}`,
		);
		return { ok: false, reason: 'validation', errors: missingFields };
	}

	// Step 2: up-to-date guard (shared helper, src/git/on-main.ts).
	const guard = checkMainUpToDate(cwd, spawnFn, 'append suggestion');
	if (!guard.ok) {
		return guard;
	}
	const { localMainSha } = guard;

	// Step 3: read suggestions.jsonl from main (NOT the working tree).
	const penRead = readPenContentFromMain(cwd, spawnFn);
	if (!penRead.ok) {
		return { ok: false, reason: 'suggestions-missing' };
	}
	const existingContent = penRead.content;
	const existingEntries = parseSuggestionsJsonl(existingContent);

	// Step 4: dedup by fingerprint.
	const alreadyPresent = existingEntries.some((e) => e.fingerprint === entry.fingerprint);
	if (alreadyPresent) {
		return { ok: true, fingerprint: entry.fingerprint, skipped: true };
	}

	// Step 5: append the new entry as exactly one JSON line, commit, push.
	// The per-attempt recompute callback (US-002, CAM-300) re-reads
	// suggestions.jsonl from the advanced main on EVERY CAS attempt (not just
	// the pre-mutation read above) and re-runs the dedup+append logic against
	// that fresh content, so a line concurrently appended between this read
	// and the winning commit survives instead of being clobbered by a stale
	// whole-file overwrite.
	const commitMsg = `chore(cam): suggestions append ${entry.fingerprint}`;
	const sha = commitTreeToMain(
		cwd,
		(_mainSha) => {
			const freshRead = readPenContentFromMain(cwd, spawnFn);
			const freshContent = freshRead.ok ? freshRead.content : existingContent;
			return [{ path: SUGGESTIONS_JSONL_PATH, content: buildAppendedContent(freshContent, entry) }];
		},
		commitMsg,
		localMainSha,
		spawnFn,
		'cam-suggestions-',
	);

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, fingerprint: entry.fingerprint, skipped: false, sha };
}

// ---------------------------------------------------------------------------
// readSuggestionsFromMain
// ---------------------------------------------------------------------------

/**
 * Read scripts/cam/suggestions.jsonl from main via `git show` and parse it
 * into SuggestionEntry[]. Tolerates a trailing newline / blank lines.
 * Returns [] both when the file is empty and when it is absent from main
 * (a missing pen is treated as an empty pen for read purposes -- callers
 * like `cam suggestions list` render a friendly empty state, not an error).
 */
export function readSuggestionsFromMain(cwd: string, spawnFn: SpawnFn): SuggestionEntry[] {
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', `main:${SUGGESTIONS_JSONL_PATH}`],
		{ encoding: 'utf8' },
	);
	if ((showResult.status ?? 1) !== 0) {
		return [];
	}
	return parseSuggestionsJsonl(showResult.stdout ?? '');
}

// ---------------------------------------------------------------------------
// dismissSuggestionOnMain
// ---------------------------------------------------------------------------

export interface DismissSuggestionOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Fingerprint of the pen entry to drop. */
	fingerprint: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
}

export interface DismissSuggestionOnMainSuccess {
	ok: true;
	fingerprint: string;
	/** Short sha (7 chars) of the new commit on main. */
	sha: string;
}

export interface DismissSuggestionOnMainError {
	ok: false;
	reason: 'not-found' | 'diverged' | 'detached-head' | 'missing-main' | 'suggestions-missing';
}

export type DismissSuggestionOnMainResult =
	| DismissSuggestionOnMainSuccess
	| DismissSuggestionOnMainError;

/**
 * Remove the pen entry matching `fingerprint` from scripts/cam/suggestions.jsonl
 * on main, without filing anything. An unknown fingerprint is a structured
 * `not-found` error (printed + returned) and does NOT mutate the pen.
 */
export function dismissSuggestionOnMain(
	options: DismissSuggestionOnMainOptions,
): DismissSuggestionOnMainResult {
	const { cwd, fingerprint, spawnFn } = options;

	const guard = checkMainUpToDate(cwd, spawnFn, 'dismiss suggestion');
	if (!guard.ok) {
		return guard;
	}
	const { localMainSha } = guard;

	const penRead = readPenContentFromMain(cwd, spawnFn);
	if (!penRead.ok) {
		return { ok: false, reason: 'suggestions-missing' };
	}

	const { found } = removeSuggestionLine(penRead.content, fingerprint);
	if (!found) {
		printError(
			'unknown fingerprint',
			`no SUGGESTION in the pen matches fingerprint ${fingerprint}`,
		);
		return { ok: false, reason: 'not-found' };
	}

	// The per-attempt recompute callback (US-002, CAM-300) re-reads
	// suggestions.jsonl from the advanced main on EVERY CAS attempt and
	// re-runs removeSuggestionLine keyed by fingerprint against that fresh
	// content, so a line concurrently added by another writer between this
	// not-found guard and the winning commit survives instead of being
	// clobbered by a stale whole-file overwrite computed once, up front.
	const commitMsg = `chore(cam): suggestions dismiss ${fingerprint}`;
	const sha = commitTreeToMain(
		cwd,
		(_mainSha) => {
			const freshRead = readPenContentFromMain(cwd, spawnFn);
			const freshContent = freshRead.ok ? freshRead.content : penRead.content;
			const { updatedContent } = removeSuggestionLine(freshContent, fingerprint);
			return [{ path: SUGGESTIONS_JSONL_PATH, content: updatedContent }];
		},
		commitMsg,
		localMainSha,
		spawnFn,
		'cam-suggestions-',
	);

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, fingerprint, sha };
}

// ---------------------------------------------------------------------------
// promoteSuggestionOnMain
// ---------------------------------------------------------------------------

export interface PromoteSuggestionOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Fingerprint of the pen entry to file as a real issue. */
	fingerprint: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp (forwarded to createLocalIssueOnMain). */
	clock: ClockFn;
	/** Read scripts/cam/project.toml as raw text (forwarded to createLocalIssueOnMain). */
	readProjectToml: () => string;
}

export interface PromoteSuggestionOnMainSuccess {
	ok: true;
	fingerprint: string;
	/** Id of the newly filed issue, e.g. 'CAM-286'. */
	issueId: string;
	/**
	 * Short sha of the SINGLE atomic commit that both files the issue JSON and
	 * removes the promoted line from the pen (US-002, CAM-290).
	 */
	sha: string;
}

export interface PromoteSuggestionOnMainError {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main' | 'not-found' | 'suggestions-missing';
}

export type PromoteSuggestionOnMainResult =
	| PromoteSuggestionOnMainSuccess
	| PromoteSuggestionOnMainError;

/**
 * Build the description for a promoted pen entry's filed issue, mirroring
 * buildFollowUpIssue's format (src/supervisor/suggestion-followups.ts) but
 * reusing the entry's ALREADY-STORED fingerprint rather than recomputing one
 * from a reconstructed ReviewFinding: the pen entry does not retain the
 * original finding's file/line, so recomputing via fingerprintFinding could
 * drift from the fingerprint the pen was keyed under. Reusing
 * `entry.fingerprint` keeps the promoted issue's dedup line byte-identical to
 * the pen's own dedup key, so future terminal reviews still recognize it.
 */
function buildPromotedDescription(entry: SuggestionEntry): string {
	const provenanceLines = [`Source: ${entry.sourceBranch}`];
	if (entry.reviewRound !== undefined) {
		provenanceLines.push(`Review round: ${entry.reviewRound}`);
	}
	return [
		entry.body,
		'',
		...provenanceLines,
		'',
		`${SUGGESTION_FINGERPRINT_PREFIX} ${entry.fingerprint}`,
	].join('\n');
}

/**
 * File the pen entry matching `fingerprint` as a real issue AND remove that
 * one line from scripts/cam/suggestions.jsonl in a SINGLE atomic on-main
 * commit (US-002, CAM-290): the entry's `derivedFrom` is preserved (resolved
 * from `sourceIssue`) and its fingerprint is embedded in the filed issue's
 * description. There is no intermediate main state where the issue exists
 * but the pen line remains -- a process death or lost push can never split
 * the two.
 *
 * Bypasses createLocalIssueOnMain (which drops the co-commit ability) and
 * calls writeIssueFile directly, passing the rewritten pen content as
 * `extraFiles` and a `commitMessage` override; the id is re-derived inside
 * writeIssueFile's own CAS retry loop, never pre-computed here.
 *
 * An unknown fingerprint is a structured `not-found` error (printed +
 * returned): looked up BEFORE any mutation, so neither the issue nor the pen
 * is touched.
 */
export function promoteSuggestionOnMain(
	options: PromoteSuggestionOnMainOptions,
): PromoteSuggestionOnMainResult {
	const { cwd, fingerprint, spawnFn, clock, readProjectToml } = options;

	const guard = checkMainUpToDate(cwd, spawnFn, 'promote suggestion');
	if (!guard.ok) {
		return guard;
	}

	const penRead = readPenContentFromMain(cwd, spawnFn);
	if (!penRead.ok) {
		return { ok: false, reason: 'suggestions-missing' };
	}
	const entry = parseSuggestionsJsonl(penRead.content).find((e) => e.fingerprint === fingerprint);
	if (entry === undefined) {
		printError(
			'unknown fingerprint',
			`no SUGGESTION in the pen matches fingerprint ${fingerprint}`,
		);
		return { ok: false, reason: 'not-found' };
	}

	// Resolve derivedFrom from the entry's sourceIssue (the PRD-backing parent
	// issue), the same issue_prefix lookup createLocalIssueOnMain itself uses.
	const config = parseToml(readProjectToml());
	const prefix = typeof config['issue_prefix'] === 'string' ? config['issue_prefix'] : 'CAM';
	const parentId = resolveIssueId(entry.sourceIssue, prefix);

	// The pen rewrite is passed as a per-attempt recompute callback (US-002,
	// CAM-300): writeIssueFile's own CAS retry loop invokes it once per
	// attempt, re-reading suggestions.jsonl from the advanced main
	// (readPenContentFromMain) and re-running removeSuggestionLine keyed by
	// fingerprint against that fresh content -- rather than a whole-file
	// rewrite computed once, up front, that would clobber a line concurrently
	// added or removed by another writer between the not-found guard above
	// and the winning commit.
	const result = writeIssueFile({
		cwd,
		title: entry.title,
		description: buildPromotedDescription(entry),
		prefix,
		createdAt: clock(),
		...(parentId !== null ? { derivedFrom: [parentId] } : {}),
		extraFiles: (_mainSha) => {
			const freshRead = readPenContentFromMain(cwd, spawnFn);
			const freshContent = freshRead.ok ? freshRead.content : penRead.content;
			const { updatedContent } = removeSuggestionLine(freshContent, fingerprint);
			return [{ path: SUGGESTIONS_JSONL_PATH, content: updatedContent }];
		},
		commitMessage: (id) => `chore(cam): suggestions promote ${fingerprint} -> ${id}`,
		spawnFn,
	});

	pushMainBestEffort(cwd, spawnFn);

	return {
		ok: true,
		fingerprint,
		issueId: result.id,
		sha: result.sha,
	};
}
