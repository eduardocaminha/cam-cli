// src/commands/issue-file.ts
//
// createLocalIssueOnMain() -- append a local issue to
// scripts/cam/issues.local.json directly on main, from any branch.
//
// Design goals:
//   - Id allocation is collision-free: the backlog is read from main via
//     `git show main:scripts/cam/issues.local.json`, never from the working
//     tree (which may be behind or ahead of main on a feature branch).
//   - On-main path: write working-tree file, git add, git commit. Simple.
//   - Off-main path: git plumbing (temp GIT_INDEX_FILE, read-tree, hash-object,
//     update-index, write-tree, commit-tree, update-ref) so the feature-branch
//     HEAD and working tree are left completely untouched.
//   - All external dependencies are injectable for unit-testing without a real
//     git binary or filesystem.
//
// US-005 additions:
//   - Up-to-date guard: best-effort fetch + local vs origin/main sha comparison;
//     skip when origin/main is absent (no remote configured).
//   - Detached HEAD and missing local main branch: clear errors returned as
//     { ok: false, reason } before any mutation.
//   - Best-effort push after commit: non-zero exit is logged via printError,
//     never silently swallowed.
//
// Mirrors src/commands/ship-finalize.ts: same ClockFn type, same injectable-
// reader style, same exported result interface.
//
// CAM-86 (file local issues to main, not the work branch).

import { writeFileSync } from 'node:fs';
import { parseToml } from '../config/toml.ts';
import { commitOnMain, commitTreeToMain } from '../git/on-main.ts';
import type { SpawnFn } from '../git/on-main.ts';
import type { IssueEntry } from '../issues/types.ts';

// Local shape of issues.local.json (the old flat-file format consumed by this command).
// The public IssueEntry/IssueStage/IssueStatus/WsjfScore types live in types.ts;
// IssuesLocalJson is no longer exported from there (US-002 removal).
interface IssuesLocalJson {
	next_id: number;
	issues: IssueEntry[];
}
import { printError } from '../logging/color.ts';

// Re-export SpawnFn from the shared module so existing callers do not need
// to update their import paths.
export type { SpawnFn };

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateLocalIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Issue title. */
	title: string;
	/** Optional long description. */
	description?: string;
	/** Optional priority (e.g. "P0", "P1"). */
	priority?: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Read scripts/cam/project.toml as raw text. */
	readProjectToml: () => string;
	/**
	 * Injectable file writer (on-main path only).
	 * Defaults to writeFileSync(path, text, 'utf8').
	 */
	writeFile?: (path: string, text: string) => void;
}

/** Successful outcome: issue was allocated, committed to main, and pushed. */
export interface CreateLocalIssueOnMainResult {
	ok: true;
	id: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

/** Guard or error outcome: no commit was made. */
export interface CreateLocalIssueOnMainError {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main';
}

export type CreateLocalIssueOnMainOutcome =
	| CreateLocalIssueOnMainResult
	| CreateLocalIssueOnMainError;

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

/**
 * Successful guard result: the captured branchWasMain flag and the local main
 * sha (reused by the off-main commit-tree path to avoid a second rev-parse).
 */
type MainGuardResult =
	| CreateLocalIssueOnMainError
	| { ok: true; branchWasMain: boolean; localMainSha: string };

/**
 * Up-to-date guard. Runs before any mutation.
 *
 *   0a. Detached HEAD -> { ok: false, reason: 'detached-head' }.
 *   0b. Missing local main branch -> { ok: false, reason: 'missing-main' }.
 *   0c. Best-effort git fetch origin main; if origin/main exists and its sha
 *       differs from local main -> { ok: false, reason: 'diverged' }. When
 *       origin/main is absent (no remote), the check is skipped entirely.
 */
function checkMainUpToDate(cwd: string, spawnFn: SpawnFn): MainGuardResult {
	// Guard 0a: Determine current branch; detect detached HEAD.
	const branchResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const currentBranch = (branchResult.stdout ?? '').trim();
	const branchWasMain = currentBranch === 'main';

	if (currentBranch === 'HEAD') {
		printError('detached HEAD', 'cannot file issue from a detached HEAD state');
		return { ok: false, reason: 'detached-head' };
	}

	// Guard 0b: Verify local main exists; capture sha for reuse in commit-tree.
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

	// Guard 0c: Best-effort fetch + up-to-date check.
	// fetch is best-effort: we ignore non-zero exit (e.g. no network, no remote).
	spawnFn('git', ['-C', cwd, 'fetch', 'origin', 'main'], { encoding: 'utf8' });

	// If origin/main exists, compare it against the local sha.
	// When the ref is absent (no remote configured), skip the check entirely.
	const originMainResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'origin/main'],
		{ encoding: 'utf8' },
	);
	if ((originMainResult.status ?? 1) === 0) {
		const originSha = (originMainResult.stdout ?? '').trim();
		if (localMainSha !== originSha) {
			printError(
				'local main is diverged from origin/main',
				'run: git pull origin main',
			);
			return { ok: false, reason: 'diverged' };
		}
	}

	return { ok: true, branchWasMain, localMainSha };
}

/**
 * Allocate the entry, bump next_id, and serialize the backlog.
 * Returns the JSON text (JSON.stringify(data, null, 2) + '\n').
 *
 * New entries are created with stage:'idea', status:'open', blockedBy:[].
 * The optional priority field (still accepted for backward compat) is never
 * written into the serialized entry (rank supersedes it; Epico C populates rank).
 */
function appendEntryAndSerialize(
	backlog: IssuesLocalJson,
	entry: { id: string; title: string; createdAt: string; description?: string; priority?: string },
): string {
	const newEntry: IssueEntry = {
		id: entry.id,
		title: entry.title,
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: entry.createdAt,
		...(entry.description !== undefined ? { description: entry.description } : {}),
	};
	backlog.next_id = backlog.next_id + 1;
	backlog.issues.push(newEntry);
	return JSON.stringify(backlog, null, 2) + '\n';
}

/**
 * Best-effort push of main to origin. A non-zero exit is logged via printError,
 * never silently swallowed; the caller does not abort (the commit already landed).
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
 * Append a new issue to scripts/cam/issues.local.json on main.
 *
 * Guard steps (run before any mutation):
 *   0a. Detached HEAD -> return { ok: false, reason: 'detached-head' }.
 *   0b. Missing local main branch -> return { ok: false, reason: 'missing-main' }.
 *   0c. Best-effort git fetch origin main; if origin/main exists and sha differs
 *       from local main -> return { ok: false, reason: 'diverged' }.
 *       If origin/main is absent (no remote), the check is skipped entirely.
 *
 * Steps (off-main path, the common case):
 *   1. Read issue_prefix from project.toml.
 *   2. Determine current branch via `git rev-parse --abbrev-ref HEAD`.
 *   3. Read the backlog from main via `git show main:scripts/cam/issues.local.json`.
 *   4. Allocate next_id, build the entry, bump next_id.
 *   5. Serialize with JSON.stringify(data, null, 2) + '\n'.
 *   6. Off-main plumbing: temp GIT_INDEX_FILE, read-tree main, hash-object
 *      -w --stdin (fed the JSON via options.input), update-index --add
 *      --cacheinfo, write-tree, commit-tree -p main, update-ref refs/heads/main.
 *   7. Best-effort git push origin main; log on rejection.
 *   8. Return { ok: true, id, committedTo: 'main', sha, branchWasMain: false }.
 *
 * On-main path (rare):
 *   - Write working-tree file, git add, git commit.
 *   - Working tree and HEAD both advance (the normal commit path).
 */
export function createLocalIssueOnMain(
	options: CreateLocalIssueOnMainOptions,
): CreateLocalIssueOnMainOutcome {
	const { cwd, title, description, priority, spawnFn, clock, readProjectToml } = options;
	const writeFile =
		options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));

	// Guards 0a-0c: run before any mutation.
	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) {
		return guard;
	}
	const { branchWasMain, localMainSha } = guard;

	// 1. Read issue_prefix from project.toml.
	const tomlText = readProjectToml();
	const config = parseToml(tomlText);
	const issuePrefix =
		typeof config['issue_prefix'] === 'string' ? config['issue_prefix'] : 'CAM';

	// 3. Read the backlog from main (NOT the working tree).
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/issues.local.json'],
		{ encoding: 'utf8' },
	);
	const backlog = JSON.parse(showResult.stdout) as IssuesLocalJson;

	// 4-5. Allocate id, build the entry, bump next_id, serialize.
	const id = `${issuePrefix}-${backlog.next_id}`;
	const serialized = appendEntryAndSerialize(backlog, {
		id,
		title,
		createdAt: clock(),
		description,
		priority,
	});

	// 6. Commit to main (on-main direct commit or off-main plumbing).
	const commitMsg = `chore(cam): file ${id} (${title})`;
	const sha = branchWasMain
		? commitOnMain(cwd, [{ path: 'scripts/cam/issues.local.json', content: serialized }], commitMsg, spawnFn, writeFile)
		: commitTreeToMain(cwd, [{ path: 'scripts/cam/issues.local.json', content: serialized }], commitMsg, localMainSha, spawnFn, 'cam-issue-');

	// 7. Best-effort push. Rejection is logged explicitly, never swallowed.
	pushMainBestEffort(cwd, spawnFn);

	// 8. Return.
	return { ok: true, id, committedTo: 'main', sha, branchWasMain };
}
