// src/commands/journal.ts
//
// appendJournalEntryOnMain() -- append a structured cycle entry to
// scripts/cam/journal.md directly on main, from any branch.
//
// Design goals (mirrors src/commands/issue-file.ts):
//   - journal.md is read from main via `git show main:scripts/cam/journal.md`
//     (never from the working tree, CAM-86 / US-006 pattern).
//   - Off-main path: git plumbing (temp GIT_INDEX_FILE, read-tree, hash-object,
//     update-index, write-tree, commit-tree, update-ref) so the feature-branch
//     HEAD and working tree are left completely untouched.
//   - On-main path: same ref-only commitTreeToMain path as off-main (CAM-133).
//   - Push to origin main is best-effort: a non-zero exit is logged but the
//     function returns { ok: true } (the local commit already landed).
//   - All external dependencies are injectable for unit-testing.
//
// CAM-122 (cam journal append deterministico + fim do jq>budget ad-hoc).

import { writeFileSync } from 'node:fs';
import { commitTreeToMain } from '../git/on-main.ts';
import type { SpawnFn } from '../git/on-main.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn from the shared module so existing callers do not need
// to update their import paths.
export type { SpawnFn };

// ---------------------------------------------------------------------------
// Journal cycle entry schema
// ---------------------------------------------------------------------------

export interface JournalCycleEntry {
	/** Machine identifier for the cycle (e.g. "cam/CAM-122-journal-append"). */
	cycleId: string;
	/** Short human-readable title (shown after em-dash in the header). */
	title: string;
	/** ISO 8601 date the cycle started. */
	started: string;
	/** ISO 8601 date the cycle closed (or "abandoned"). */
	closed: string;
	/** Git branch name for the cycle. */
	branch: string;
	/** Issue reference (e.g. "CAM-122"). */
	issue: string;
	/** Outcome string (e.g. "shipped", "abandoned", "blocked"). */
	outcome: string;
	/** 1-2 sentence summary of what was accomplished. */
	summary: string;
	/** Optional: key decisions made during this cycle. */
	decisions?: string;
	/** Optional: blockers encountered. */
	blockers?: string;
	/** Optional: follow-up items for the next cycle. */
	followups?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AppendJournalEntryOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** The cycle entry to append. */
	entry: JournalCycleEntry;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/**
	 * Injectable file writer (retained for interface compat; unused after commitTreeToMain cutover).
	 * Defaults to writeFileSync(path, text, 'utf8').
	 */
	writeFile?: (path: string, text: string) => void;
	/**
	 * When true and a duplicate cycleId is detected, replace the existing
	 * entry in place instead of rejecting with an error.
	 */
	force?: boolean;
}

export interface AppendJournalEntryOnMainSuccess {
	ok: true;
	/** The cycleId of the appended entry. */
	cycleId: string;
	/** Short sha (7 chars) of the new commit on main. */
	sha: string;
}

export interface AppendJournalEntryOnMainError {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main' | 'duplicate-cycleId' | 'journal-missing';
}

/**
 * Validation error shape: carries `errors` per the discriminated-union pattern.
 * (patterns.md line 130: members without `errors` must NOT carry it; callers
 * narrow with `'errors' in result` before accessing it.)
 */
export interface AppendJournalEntryOnMainValidationError {
	ok: false;
	reason: 'validation';
	errors: string[];
}

export type AppendJournalEntryOnMainResult =
	| AppendJournalEntryOnMainSuccess
	| AppendJournalEntryOnMainError
	| AppendJournalEntryOnMainValidationError;

type MainGuardResult =
	| AppendJournalEntryOnMainError
	| { ok: true; branchWasMain: boolean; localMainSha: string };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: ReadonlyArray<keyof JournalCycleEntry> = [
	'cycleId',
	'title',
	'started',
	'closed',
	'branch',
	'issue',
	'outcome',
	'summary',
];

/**
 * Validate that all required fields are present and non-empty.
 * Returns an array of missing field names (empty = valid).
 */
function validateEntry(entry: JournalCycleEntry): string[] {
	return REQUIRED_FIELDS.filter(
		(field) => !entry[field] || String(entry[field]).trim() === '',
	);
}

/**
 * Normalize U+2014 (em-dash) in a body field value.
 * Per the project no-em-dash rule, em-dashes in persisted .md are replaced
 * with a colon. The title header line is explicitly excluded (all 33 existing
 * journal entries use `## cycleId — title` and that format is canonical).
 */
function normalizeEmDash(text: string): string {
	return text.replace(/—/g, ':');
}

// ---------------------------------------------------------------------------
// Duplicate-detection and in-place replacement helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a `## <cycleId> ` header already exists in journal content.
 */
function hasDuplicateCycleId(content: string, cycleId: string): boolean {
	const header = `## ${cycleId} `;
	return content.startsWith(header) || content.includes(`\n${header}`);
}

/**
 * Replace the existing `## <cycleId>` block in `content` with `newBlock`.
 *
 * Algorithm (line-based):
 *   1. Find the line index S where the header starts.
 *   2. Find the line index N of the NEXT `## ` header (or lines.length).
 *   3. Replace lines[S..N-2] with the new block lines.
 *   4. Keep lines[N-1..] (the blank separator before the next entry, or the
 *      trailing '' that represents the file's final newline).
 * This preserves the blank-line separators between all entries.
 */
function replaceCycleBlock(content: string, cycleId: string, newBlock: string): string {
	const headerPrefix = `## ${cycleId} `;
	const lines = content.split('\n');

	const startLine = lines.findIndex((l) => l.startsWith(headerPrefix));
	if (startLine === -1) return content;

	let endLine = lines.length;
	for (let i = startLine + 1; i < lines.length; i++) {
		if ((lines[i] ?? '').startsWith('## ')) {
			endLine = i;
			break;
		}
	}

	// Replace lines[startLine..endLine-2]; keep lines[N-1..] (blank separator or trailing '').
	const keepFromIdx = Math.max(endLine - 1, startLine + 1);
	const result = [
		...lines.slice(0, startLine),
		...newBlock.split('\n'),
		...lines.slice(keepFromIdx),
	];
	return result.join('\n');
}

/**
 * Up-to-date guard. Runs before any mutation. Same logic as issue-file.ts.
 *   0a. Detached HEAD -> { ok: false, reason: 'detached-head' }.
 *   0b. Missing local main branch -> { ok: false, reason: 'missing-main' }.
 *   0c. Best-effort fetch + divergence check against origin/main.
 */
function checkMainUpToDate(cwd: string, spawnFn: SpawnFn): MainGuardResult {
	const branchResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const currentBranch = (branchResult.stdout ?? '').trim();
	const branchWasMain = currentBranch === 'main';

	if (currentBranch === 'HEAD') {
		printError('detached HEAD', 'cannot append journal entry from a detached HEAD state');
		return { ok: false, reason: 'detached-head' };
	}

	const localMainResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'main'],
		{ encoding: 'utf8' },
	);
	if ((localMainResult.status ?? 1) !== 0) {
		printError('missing local main branch', 'run: git fetch origin main:main');
		return { ok: false, reason: 'missing-main' };
	}
	const localMainSha = (localMainResult.stdout ?? '').trim();

	// Best-effort fetch; ignore non-zero exit (no network, no remote).
	spawnFn('git', ['-C', cwd, 'fetch', 'origin', 'main'], { encoding: 'utf8' });

	const originMainResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'origin/main'],
		{ encoding: 'utf8' },
	);
	if ((originMainResult.status ?? 1) === 0) {
		const originSha = (originMainResult.stdout ?? '').trim();
		if (localMainSha !== originSha) {
			printError('local main is diverged from origin/main', 'run: git pull origin main');
			return { ok: false, reason: 'diverged' };
		}
	}

	return { ok: true, branchWasMain, localMainSha };
}

/**
 * Render the canonical journal markdown block for one cycle entry.
 *
 * Em-dash (U+2014) handling:
 *   - HEADER LINE: em-dash is INTENTIONAL and structural (all 33 existing entries
 *     use `## cycleId — title`). It is NOT normalized.
 *   - BODY FIELDS (Outcome, Summary, Decisions, Blockers, Followups): em-dashes
 *     are replaced with `:` per the project no-em-dash rule for persisted .md.
 *
 * Optional fields (decisions, blockers, followups) are rendered only when present;
 * an absent optional produces no bullet in the output.
 */
export function renderJournalBlock(entry: JournalCycleEntry): string {
	const lines = [
		`## ${entry.cycleId} — ${entry.title}`,
		'',
		`- **Started**: ${entry.started}`,
		`- **Closed**: ${entry.closed}`,
		`- **Branch**: ${entry.branch}`,
		`- **Issue**: ${entry.issue}`,
		`- **Outcome**: ${normalizeEmDash(entry.outcome)}`,
		`- **Summary**: ${normalizeEmDash(entry.summary)}`,
	];

	if (entry.decisions !== undefined) {
		lines.push(`- **Decisions**: ${normalizeEmDash(entry.decisions)}`);
	}
	if (entry.blockers !== undefined) {
		lines.push(`- **Blockers encountered**: ${normalizeEmDash(entry.blockers)}`);
	}
	if (entry.followups !== undefined) {
		lines.push(`- **Follow-ups**: ${normalizeEmDash(entry.followups)}`);
	}

	return lines.join('\n');
}

/**
 * Append the rendered block to existing journal content.
 * Always inserts a blank line before the new entry so entries are separated
 * by exactly one blank line (the same pattern as the existing journal).
 */
function appendBlock(existing: string, block: string): string {
	// Ensure a single blank line before the new entry.
	const base = existing.endsWith('\n') ? existing : existing + '\n';
	return base + '\n' + block + '\n';
}

/**
 * Best-effort push of main to origin.
 * A non-zero exit is logged via printError; the caller does not abort.
 */
function pushMainBestEffort(cwd: string, spawnFn: SpawnFn): void {
	const pushResult = spawnFn(
		'git',
		['-C', cwd, 'push', 'origin', 'main'],
		{ encoding: 'utf8' },
	);
	if ((pushResult.status ?? 1) !== 0) {
		printError(
			'push rejected',
			`git push origin main: ${(pushResult.stderr ?? '').trim() || 'unknown error'}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Append a new cycle entry to scripts/cam/journal.md on main.
 *
 * Guard steps (run before any mutation):
 *   0a. Detached HEAD -> return { ok: false, reason: 'detached-head' }.
 *   0b. Missing local main branch -> return { ok: false, reason: 'missing-main' }.
 *   0c. Best-effort git fetch origin main; if origin/main exists and sha differs
 *       from local main -> return { ok: false, reason: 'diverged' }.
 *
 * Steps (off-main path, the common case):
 *   1. Read journal.md from main via `git show main:scripts/cam/journal.md`.
 *   2. Render the canonical journal block via renderJournalBlock().
 *   3. Append after the existing content (preserving the ENTRIES_BELOW marker).
 *   4. Off-main plumbing: temp GIT_INDEX_FILE, read-tree main, hash-object
 *      -w --stdin, update-index --add --cacheinfo, write-tree, commit-tree
 *      -p main, update-ref refs/heads/main.
 *   5. Best-effort git push origin main.
 *   6. Print `CAM_JOURNAL_APPENDED=<cycleId> sha=<sha>` (done by the caller).
 *   7. Return { ok: true, cycleId, sha }.
 *
 * On-main path: same ref-only commitTreeToMain path as off-main (CAM-133).
 */
export function appendJournalEntryOnMain(
	options: AppendJournalEntryOnMainOptions,
): AppendJournalEntryOnMainResult {
	const { cwd, entry, spawnFn } = options;
	const writeFile =
		options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));
	const force = options.force ?? false;

	// Step 1: validate pure inputs BEFORE any git calls (fail-fast pattern,
	// patterns.md line 130: validate inputs before the git show read).
	const missingFields = validateEntry(entry);
	if (missingFields.length > 0) {
		printError(
			'missing required fields',
			`journal entry is missing: ${missingFields.join(', ')}`,
		);
		return { ok: false, reason: 'validation', errors: missingFields };
	}

	// Step 2: Guards 0a-0c (up-to-date check).
	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) {
		return guard;
	}
	const { branchWasMain, localMainSha } = guard;

	// Step 3: Read journal.md from main (NOT the working tree, CAM-86 / US-006 pattern).
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/journal.md'],
		{ encoding: 'utf8' },
	);
	// US-R2-002: check status explicitly. A non-zero exit means the file is absent
	// from main. We do NOT bootstrap it here -- journal.md is created by `cam init`.
	if ((showResult.status ?? 1) !== 0) {
		printError(
			'journal.md missing on main',
			'scripts/cam/journal.md must pre-exist on main (created by cam init); ' +
				'run: git show main:scripts/cam/journal.md to confirm',
		);
		return { ok: false, reason: 'journal-missing' };
	}
	const existingContent = showResult.stdout ?? '';

	// Step 4: Duplicate-cycleId check (state check against the journal read from main).
	if (hasDuplicateCycleId(existingContent, entry.cycleId)) {
		if (!force) {
			printError(
				'duplicate cycleId',
				`journal already contains an entry for "${entry.cycleId}"; use --force to replace it`,
			);
			return { ok: false, reason: 'duplicate-cycleId' };
		}
		// --force: replace the existing entry in place.
		const block = renderJournalBlock(entry);
		const updatedContent = replaceCycleBlock(existingContent, entry.cycleId, block);
		const commitMsg = `chore(cam): journal replace ${entry.cycleId}`;
		const sha = commitTreeToMain(cwd, [{ path: 'scripts/cam/journal.md', content: updatedContent }], commitMsg, localMainSha, spawnFn, 'cam-journal-');
		pushMainBestEffort(cwd, spawnFn);
		return { ok: true, cycleId: entry.cycleId, sha };
	}

	// Step 5: Render and append.
	const block = renderJournalBlock(entry);
	const updatedContent = appendBlock(existingContent, block);

	const commitMsg = `chore(cam): journal append ${entry.cycleId}`;

	const sha = commitTreeToMain(cwd, [{ path: 'scripts/cam/journal.md', content: updatedContent }], commitMsg, localMainSha, spawnFn, 'cam-journal-');

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, cycleId: entry.cycleId, sha };
}
