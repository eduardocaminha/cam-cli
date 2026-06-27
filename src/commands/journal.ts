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
//   - On-main path: write working-tree file, git add, git commit.
//   - Push to origin main is best-effort: a non-zero exit is logged but the
//     function returns { ok: true } (the local commit already landed).
//   - All external dependencies are injectable for unit-testing.
//
// CAM-122 (cam journal append deterministico + fim do jq>budget ad-hoc).

import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printError } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types (same shape as issue-file.ts)
// ---------------------------------------------------------------------------

/**
 * Widened SpawnFn -- same as issue-file.ts.
 * `env`: carries GIT_INDEX_FILE for the off-main commit-tree path.
 * `input`: feeds the updated markdown to `git hash-object -w --stdin`.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
) => SpawnSyncReturns<string>;

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
	 * Injectable file writer (on-main path only).
	 * Defaults to writeFileSync(path, text, 'utf8').
	 */
	writeFile?: (path: string, text: string) => void;
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
	reason: 'diverged' | 'detached-head' | 'missing-main';
}

export type AppendJournalEntryOnMainResult =
	| AppendJournalEntryOnMainSuccess
	| AppendJournalEntryOnMainError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a process-env copy augmented with GIT_INDEX_FILE.
 * Filters out undefined values to satisfy `Record<string, string>`.
 */
function buildIndexEnv(tempIndex: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) {
			env[k] = v;
		}
	}
	env['GIT_INDEX_FILE'] = tempIndex;
	return env;
}

type MainGuardResult =
	| AppendJournalEntryOnMainError
	| { ok: true; branchWasMain: boolean; localMainSha: string };

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
 * The em-dash (U+2014) in the header line is intentional and structural:
 * all existing journal entries use this separator.
 */
export function renderJournalBlock(entry: JournalCycleEntry): string {
	return [
		`## ${entry.cycleId} — ${entry.title}`,
		'',
		`- **Started**: ${entry.started}`,
		`- **Closed**: ${entry.closed}`,
		`- **Branch**: ${entry.branch}`,
		`- **Issue**: ${entry.issue}`,
		`- **Outcome**: ${entry.outcome}`,
		`- **Summary**: ${entry.summary}`,
	].join('\n');
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
 * On-main path: write the working-tree file, git add, git commit.
 * Returns the short sha from `git rev-parse --short HEAD`.
 */
function commitOnMain(
	cwd: string,
	content: string,
	commitMsg: string,
	spawnFn: SpawnFn,
	writeFile: (path: string, text: string) => void,
): string {
	const filePath = join(cwd, 'scripts/cam/journal.md');
	writeFile(filePath, content);
	spawnFn('git', ['-C', cwd, 'add', 'scripts/cam/journal.md'], { encoding: 'utf8' });
	spawnFn('git', ['-C', cwd, 'commit', '-m', commitMsg], { encoding: 'utf8' });
	const shaResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--short', 'HEAD'],
		{ encoding: 'utf8' },
	);
	return (shaResult.stdout ?? '').trim();
}

/**
 * Off-main path: git plumbing so the working tree and feature-branch HEAD are
 * left completely untouched. Returns the 7-char short sha of the new commit.
 */
function commitTreeToMain(
	cwd: string,
	content: string,
	commitMsg: string,
	localMainSha: string,
	spawnFn: SpawnFn,
): string {
	const tmpDir = mkdtempSync(join(tmpdir(), 'cam-journal-'));
	const tempIndex = join(tmpDir, 'index');

	try {
		// read-tree: populate the temp index with the tree at main.
		spawnFn('git', ['-C', cwd, 'read-tree', 'main'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
		});

		// hash-object: write the updated markdown blob to the object store.
		const hashResult = spawnFn('git', ['-C', cwd, 'hash-object', '-w', '--stdin'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
			input: content,
		});
		const blobSha = (hashResult.stdout ?? '').trim();

		// update-index: replace the old blob with the new one in the temp index.
		spawnFn(
			'git',
			[
				'-C',
				cwd,
				'update-index',
				'--add',
				'--cacheinfo',
				`100644,${blobSha},scripts/cam/journal.md`,
			],
			{
				encoding: 'utf8',
				env: buildIndexEnv(tempIndex),
			},
		);

		// write-tree: persist the temp index as a tree object.
		const treeResult = spawnFn('git', ['-C', cwd, 'write-tree'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
		});
		const treeSha = (treeResult.stdout ?? '').trim();

		// commit-tree: create a new commit on top of main.
		const commitResult = spawnFn(
			'git',
			['-C', cwd, 'commit-tree', treeSha, '-p', localMainSha, '-m', commitMsg],
			{ encoding: 'utf8' },
		);
		const newCommitSha = (commitResult.stdout ?? '').trim();

		// update-ref: advance refs/heads/main to the new commit.
		spawnFn(
			'git',
			['-C', cwd, 'update-ref', 'refs/heads/main', newCommitSha],
			{ encoding: 'utf8' },
		);

		return newCommitSha.substring(0, 7);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
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
 * On-main path (rare): write working-tree file, git add, git commit.
 */
export function appendJournalEntryOnMain(
	options: AppendJournalEntryOnMainOptions,
): AppendJournalEntryOnMainResult {
	const { cwd, entry, spawnFn } = options;
	const writeFile =
		options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));

	// Guards 0a-0c.
	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) {
		return guard;
	}
	const { branchWasMain, localMainSha } = guard;

	// Read journal.md from main (NOT the working tree, CAM-86 / US-006 pattern).
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/journal.md'],
		{ encoding: 'utf8' },
	);
	const existingContent = showResult.stdout ?? '';

	// Render and append.
	const block = renderJournalBlock(entry);
	const updatedContent = appendBlock(existingContent, block);

	const commitMsg = `chore(cam): journal append ${entry.cycleId}`;

	const sha = branchWasMain
		? commitOnMain(cwd, updatedContent, commitMsg, spawnFn, writeFile)
		: commitTreeToMain(cwd, updatedContent, commitMsg, localMainSha, spawnFn);

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, cycleId: entry.cycleId, sha };
}
