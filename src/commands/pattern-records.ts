// src/commands/pattern-records.ts
//
// On-main ref-only append/read for scripts/cam/pattern-records.jsonl -- the
// typed pattern-record store (US-001, PatternRecord/isPatternRecord/
// parsePatternRecordsJsonl in src/patterns/record.ts).
//
// Design mirrors appendSuggestionOnMain / readSuggestionsFromMain
// (src/commands/suggestions.ts):
//   - Validate the record (isPatternRecord, fail-closed) before any git calls.
//   - Read pattern-records.jsonl from main via `git show main:<path>`, NEVER
//     the working tree.
//   - Unlike suggestions.jsonl (seeded by `cam init`, so a missing pen is a
//     structured error), pattern-records.jsonl has no seeding story: a
//     missing file on main is treated as an empty store and the first
//     successful append bootstraps it.
//   - Append as ONE JSON line, dedup by a derived fingerprint (name +
//     description + dir_anchors) against existing lines -- PatternRecord
//     itself carries no fingerprint field, so the fingerprint is recomputed
//     per record rather than stored.
//   - Commit via the SHARED commitTreeToMain/checkMainUpToDate/
//     pushMainBestEffort helpers in src/git/on-main.ts (no new private copy
//     of that plumbing -- jscpd gate, patterns.md line 272).
//   - Every CAS retry attempt re-reads pattern-records.jsonl from the
//     advanced main and re-runs the dedup+append logic against that fresh
//     content (FileWritesFn per-attempt recompute, US-001 CAM-300), so a
//     record concurrently appended by another writer between the
//     pre-mutation read and the winning commit survives instead of being
//     clobbered by a stale whole-file overwrite.
//
// US-002, CAM-64 "mulch model" port.

import {
	checkMainUpToDate,
	commitTreeToMain,
	pushMainBestEffort,
	type SpawnFn,
} from '../git/on-main.ts';
import { isPatternRecord, parsePatternRecordsJsonl, type PatternRecord } from '../patterns/record.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn so callers do not need to reach into src/git/on-main.ts directly.
export type { SpawnFn };

/** Git-relative path of the pattern-record store, read/written on main only. */
export const PATTERN_RECORDS_JSONL_PATH = 'scripts/cam/pattern-records.jsonl';

// ---------------------------------------------------------------------------
// Fingerprint (dedup key)
// ---------------------------------------------------------------------------

/** Length (hex chars) of the truncated sha256 fingerprint. */
const FINGERPRINT_LENGTH = 12;

/**
 * Stable short fingerprint of a pattern record's normalized name,
 * description, and dir_anchors. Mirrors fingerprintFinding
 * (src/supervisor/suggestion-followups.ts): normalized fields joined with
 * "::" separators so distinct records can never collide via a shared
 * normalized field.
 */
export function fingerprintPatternRecord(
	record: Pick<PatternRecord, 'name' | 'description' | 'dir_anchors'>,
): string {
	const normalizedName = record.name.trim();
	const normalizedDescription = record.description.trim();
	const normalizedDirAnchors = record.dir_anchors.map((a) => a.trim()).join(',');
	const input = [normalizedName, normalizedDescription, normalizedDirAnchors].join('::');
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(input);
	return hasher.digest('hex').slice(0, FINGERPRINT_LENGTH);
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Read raw pattern-records.jsonl content from main via `git show`. A missing
 * file on main (non-zero exit -- no seeding story exists for this store) is
 * treated as an empty store rather than a structured error, so the first
 * successful append bootstraps the file.
 */
function readPatternRecordsContentFromMain(cwd: string, spawnFn: SpawnFn): string {
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', `main:${PATTERN_RECORDS_JSONL_PATH}`],
		{ encoding: 'utf8' },
	);
	if ((showResult.status ?? 1) !== 0) {
		return '';
	}
	return showResult.stdout ?? '';
}

/**
 * Read scripts/cam/pattern-records.jsonl from main and parse it into
 * PatternRecord[]. Skips unparseable/malformed lines fail-closed
 * (parsePatternRecordsJsonl, src/patterns/record.ts). A missing file on main
 * is treated as an empty store, same as an empty file.
 */
export function readPatternRecordsFromMain(cwd: string, spawnFn: SpawnFn): PatternRecord[] {
	return parsePatternRecordsJsonl(readPatternRecordsContentFromMain(cwd, spawnFn));
}

// ---------------------------------------------------------------------------
// Append content builder (shared by the up-front dedup check and the
// per-attempt CAS recompute callback)
// ---------------------------------------------------------------------------

/**
 * Append `record` as one new JSON line to `content`, unless a record with the
 * same fingerprint is already present (returned unchanged in that case -- a
 * concurrent writer may have already appended the same record).
 */
function buildAppendedContent(content: string, record: PatternRecord, fingerprint: string): string {
	const existing = parsePatternRecordsJsonl(content);
	const alreadyPresent = existing.some((r) => fingerprintPatternRecord(r) === fingerprint);
	if (alreadyPresent) {
		return content;
	}
	const newLine = JSON.stringify(record);
	return content.endsWith('\n') || content === ''
		? `${content}${newLine}\n`
		: `${content}\n${newLine}\n`;
}

// ---------------------------------------------------------------------------
// appendPatternRecordOnMain
// ---------------------------------------------------------------------------

export interface AppendPatternRecordOnMainAppended {
	ok: true;
	fingerprint: string;
	/** false: a new line was appended and committed. */
	skipped: false;
	/** Short sha (7 chars) of the new commit on main. */
	sha: string;
}

export interface AppendPatternRecordOnMainSkipped {
	ok: true;
	fingerprint: string;
	/** true: fingerprint already present in the store; no commit fired. */
	skipped: true;
}

export interface AppendPatternRecordOnMainError {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main';
}

/**
 * Validation error shape: carries `errors` per the discriminated-union
 * pattern (patterns.md line 130: members without `errors` must NOT carry
 * it; callers narrow with `'errors' in result` before accessing it).
 */
export interface AppendPatternRecordOnMainValidationError {
	ok: false;
	reason: 'validation';
	errors: string[];
}

export type AppendPatternRecordOnMainResult =
	| AppendPatternRecordOnMainAppended
	| AppendPatternRecordOnMainSkipped
	| AppendPatternRecordOnMainError
	| AppendPatternRecordOnMainValidationError;

export interface AppendPatternRecordOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** The pattern record to append. */
	record: PatternRecord;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
}

/**
 * Append one PatternRecord to scripts/cam/pattern-records.jsonl on main.
 *
 * Never touches the working tree off-main: writes go through commitTreeToMain
 * (src/git/on-main.ts), the shared commit-tree + compare-and-swap update-ref
 * plumbing. A missing store on main bootstraps to an empty file rather than
 * erroring (no seeding story precedes this one).
 *
 * Dedup: a record whose derived fingerprint (name + description + dir_anchors)
 * already appears in the store is skipped (`{ ok: true, skipped: true }`, no
 * commit fires) instead of being appended a second time.
 */
export function appendPatternRecordOnMain(
	options: AppendPatternRecordOnMainOptions,
): AppendPatternRecordOnMainResult {
	const { cwd, record, spawnFn } = options;

	// Step 1: validate the record BEFORE any git calls (fail-fast, fail-closed
	// -- isPatternRecord, src/patterns/record.ts, US-001).
	if (!isPatternRecord(record)) {
		const errors = ['record failed isPatternRecord validation'];
		printError('invalid pattern record', errors[0] ?? '');
		return { ok: false, reason: 'validation', errors };
	}

	// Step 2: up-to-date guard (shared helper, src/git/on-main.ts).
	const guard = checkMainUpToDate(cwd, spawnFn, 'append pattern record');
	if (!guard.ok) {
		return guard;
	}
	const { localMainSha } = guard;

	const fingerprint = fingerprintPatternRecord(record);

	// Step 3: read pattern-records.jsonl from main (NOT the working tree;
	// missing file bootstraps to empty content).
	const existingContent = readPatternRecordsContentFromMain(cwd, spawnFn);

	// Step 4: dedup by fingerprint.
	const alreadyPresent = parsePatternRecordsJsonl(existingContent).some(
		(r) => fingerprintPatternRecord(r) === fingerprint,
	);
	if (alreadyPresent) {
		return { ok: true, fingerprint, skipped: true };
	}

	// Step 5: append the new record as exactly one JSON line, commit, push.
	// The per-attempt recompute callback re-reads pattern-records.jsonl from
	// the advanced main on EVERY CAS attempt (not just the pre-mutation read
	// above) and re-runs the dedup+append logic against that fresh content, so
	// a line concurrently appended between this read and the winning commit
	// survives instead of being clobbered by a stale whole-file overwrite.
	const commitMsg = `chore(cam): pattern-records append ${fingerprint}`;
	const sha = commitTreeToMain(
		cwd,
		(_mainSha) => {
			const freshContent = readPatternRecordsContentFromMain(cwd, spawnFn);
			return [
				{
					path: PATTERN_RECORDS_JSONL_PATH,
					content: buildAppendedContent(freshContent, record, fingerprint),
				},
			];
		},
		commitMsg,
		localMainSha,
		spawnFn,
		'cam-pattern-records-',
	);

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, fingerprint, skipped: false, sha };
}
