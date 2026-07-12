// src/commands/suggestions.ts
//
// SuggestionEntry data model + on-main append-only JSONL writer/reader for
// scripts/cam/suggestions.jsonl -- the shared "suggestions pen" that the
// terminal-verdict hook (CAM-189) and the `cam suggestions` CLI (later
// stories in this PRD) both read from and write to, instead of each
// reviewer SUGGESTION being auto-filed as its own idea-stage issue.
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
// CAM-285 US-001.

import {
	checkMainUpToDate,
	commitTreeToMain,
	pushMainBestEffort,
	type SpawnFn,
} from '../git/on-main.ts';
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
		return { ok: false, reason: 'suggestions-missing' };
	}
	const existingContent = showResult.stdout ?? '';
	const existingEntries = parseSuggestionsJsonl(existingContent);

	// Step 4: dedup by fingerprint.
	const alreadyPresent = existingEntries.some((e) => e.fingerprint === entry.fingerprint);
	if (alreadyPresent) {
		return { ok: true, fingerprint: entry.fingerprint, skipped: true };
	}

	// Step 5: append the new entry as exactly one JSON line, commit, push.
	const newLine = JSON.stringify(entry);
	const updatedContent = existingContent.endsWith('\n') || existingContent === ''
		? `${existingContent}${newLine}\n`
		: `${existingContent}\n${newLine}\n`;

	const commitMsg = `chore(cam): suggestions append ${entry.fingerprint}`;
	const sha = commitTreeToMain(
		cwd,
		[{ path: SUGGESTIONS_JSONL_PATH, content: updatedContent }],
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
