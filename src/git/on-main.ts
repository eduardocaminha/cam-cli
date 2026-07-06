// src/git/on-main.ts
//
// Shared on-main commit-tree plumbing extracted from the three callers that
// previously each carried a verbatim copy:
//   - src/commands/issue-file.ts   (commitTreeToMain + buildIndexEnv)
//   - src/commands/issue-specify.ts (same)
//   - src/commands/journal.ts       (same)
//
// DESIGN:
//   - All three copies were byte-identical except for:
//     (a) the mkdtemp prefix ('cam-issue-' / 'cam-specify-' / 'cam-journal-')
//     (b) the file path argument ('scripts/cam/issues/CAM-NNNN.json' vs
//         'scripts/cam/journal.md')
//   - Both parameters are now explicit arguments so callers stay
//     byte-behaviorally identical to the pre-extraction code.
//   - SpawnFn is re-exported here so callers (including triage.ts, US-004)
//     can import the type from one place.
//   - US-001 (CAM-90): commitTreeToMain accepts a FileWrite[] (list of
//     {path,content} pairs) for atomic multi-file commits.  The 1-element
//     list is the single-file case and produces the same git sequence.
//     commitTreeToMain uses compare-and-swap (CAS) on update-ref and retries
//     up to CAS_MAX_ATTEMPTS times on contention.
//
// DO NOT import this module from anywhere outside src/commands/ that
// performs on-main mutations. Read-only callers do not need it.
//
// CAM-108 US-001 (closes CAM-124); CAM-90 US-001 (multi-file + CAS).

import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printError, printWarning } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Shared SpawnFn type
// ---------------------------------------------------------------------------

/**
 * Widened SpawnFn -- strict superset of ship-finalize's SpawnFn.
 *
 * The extra optional fields (`env`, `input`) are required by the off-main
 * commit-tree path:
 *   - `env`: carries GIT_INDEX_FILE pointing at the temp index used by
 *     read-tree, hash-object, update-index, and write-tree.
 *   - `input`: feeds the updated content to `git hash-object -w --stdin`.
 *
 * Injectable so unit tests can verify both fields without shelling out.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
) => SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// FileWrite: a single file to write in an atomic multi-file commit
// ---------------------------------------------------------------------------

/**
 * Represents one file to include in an atomic on-main commit.
 *
 * @property path     Git-relative path (e.g. 'scripts/cam/issues/CAM-0001.json').
 * @property content  File content to hash and index.
 */
export interface FileWrite {
	path: string;
	content: string;
}

// ---------------------------------------------------------------------------
// CAS_MAX_ATTEMPTS: bounded retry limit for compare-and-swap update-ref
// ---------------------------------------------------------------------------

/**
 * Maximum number of attempts for the compare-and-swap update-ref loop in
 * commitTreeToMain.  On each CAS failure the helper re-reads refs/heads/main,
 * rebuilds the tree on the new base, and retries.  After this many attempts
 * it throws rather than silently overwriting.
 */
export const CAS_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// buildIndexEnv
// ---------------------------------------------------------------------------

/**
 * Build a process-env copy augmented with GIT_INDEX_FILE.
 * Filters out undefined values to satisfy `Record<string, string>`.
 *
 * Used internally by commitTreeToMain and exported so callers can construct
 * the same env for additional plumbing calls if needed.
 */
export function buildIndexEnv(tempIndex: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) {
			env[k] = v;
		}
	}
	env['GIT_INDEX_FILE'] = tempIndex;
	return env;
}

// ---------------------------------------------------------------------------
// commitTreeToMain helpers (extracted for complexity reduction)
// ---------------------------------------------------------------------------

/**
 * Remove repo-relative paths from a temp index via `git update-index --force-remove`.
 * No-op when `paths` is empty.
 *
 * Must use `--force-remove` (not `--remove`): `--remove` only drops paths that
 * are ABSENT from the working tree; `--force-remove` drops them unconditionally
 * regardless of working-tree state (required for off-main commit-tree plumbing
 * where the working tree is irrelevant).
 */
export function removePathsFromIndex(
	cwd: string,
	paths: string[],
	spawnFn: SpawnFn,
	indexEnv: Record<string, string>,
): void {
	for (const p of paths) {
		spawnFn('git', ['-C', cwd, 'update-index', '--force-remove', p], {
			encoding: 'utf8',
			env: indexEnv,
		});
	}
}

/**
 * Hash and index all files into a temp index.
 * Throws on the first hash-object or update-index failure so write-tree is
 * never reached with a partial set (atomicity guarantee).
 */
export function hashAndIndexFiles(
	cwd: string,
	files: FileWrite[],
	spawnFn: SpawnFn,
	indexEnv: Record<string, string>,
): void {
	for (const file of files) {
		const hashResult = spawnFn(
			'git',
			['-C', cwd, 'hash-object', '-w', '--stdin'],
			{ encoding: 'utf8', env: indexEnv, input: file.content },
		);
		if ((hashResult.status ?? 1) !== 0) {
			throw new Error(
				`git hash-object failed for ${file.path}: ${hashResult.stderr ?? ''}`,
			);
		}
		const blobSha = (hashResult.stdout ?? '').trim();
		const updateResult = spawnFn(
			'git',
			['-C', cwd, 'update-index', '--add', '--cacheinfo', `100644,${blobSha},${file.path}`],
			{ encoding: 'utf8', env: indexEnv },
		);
		if ((updateResult.status ?? 1) !== 0) {
			throw new Error(
				`git update-index failed for ${file.path}: ${updateResult.stderr ?? ''}`,
			);
		}
	}
}

/** Result of a single CAS attempt. */
type CasAttemptResult =
	| { success: true; shortSha: string }
	| { success: false; newMainSha: string };

/**
 * Write the temp index as a tree, create a commit, and attempt a CAS update-ref.
 *
 * On success (update-ref exits 0) returns `{ success: true, shortSha }`.
 * On CAS failure, re-reads the current main sha and returns
 * `{ success: false, newMainSha }` so the caller can retry.
 */
export function commitAndCasAttempt(
	cwd: string,
	currentMainSha: string,
	commitMsg: string,
	spawnFn: SpawnFn,
	indexEnv: Record<string, string>,
): CasAttemptResult {
	const treeResult = spawnFn('git', ['-C', cwd, 'write-tree'], {
		encoding: 'utf8',
		env: indexEnv,
	});
	const treeSha = (treeResult.stdout ?? '').trim();

	const commitResult = spawnFn(
		'git',
		['-C', cwd, 'commit-tree', treeSha, '-p', currentMainSha, '-m', commitMsg],
		{ encoding: 'utf8' },
	);
	const newCommitSha = (commitResult.stdout ?? '').trim();

	const updateRefResult = spawnFn(
		'git',
		['-C', cwd, 'update-ref', 'refs/heads/main', newCommitSha, currentMainSha],
		{ encoding: 'utf8' },
	);

	if ((updateRefResult.status ?? 1) === 0) {
		return { success: true, shortSha: newCommitSha.substring(0, 7) };
	}

	const revParseResult = spawnFn('git', ['-C', cwd, 'rev-parse', 'main'], {
		encoding: 'utf8',
	});
	return { success: false, newMainSha: (revParseResult.stdout ?? '').trim() };
}

// ---------------------------------------------------------------------------
// syncWorktreeIfOnMain
// ---------------------------------------------------------------------------

/**
 * Sync the working tree for the supplied paths when checked out on main.
 *
 * Coherence invariant (mirrors commitTreeToMain's contract):
 *   - Off-main working tree: left completely untouched (all uncommitted edits
 *     on the feature branch are preserved).
 *   - On-main working tree: synced to HEAD after the call via
 *     `git restore --staged --worktree --source=HEAD -- <paths>`.
 *
 * `git restore --staged --worktree --source=HEAD` handles add/mod/del
 * uniformly (unlike `git checkout HEAD -- <path>` which does NOT remove
 * files absent from HEAD, so deletions would leak into the worktree).
 *
 * Best-effort: a non-zero exit from git restore emits a warning and never
 * throws, so callers are never blocked by a failed sync.
 *
 * Branch is self-detected via `git rev-parse --abbrev-ref HEAD`; callers
 * do NOT pass branchWasMain.
 *
 * @param cwd     Absolute path to the project root (git repo).
 * @param paths   List of repo-relative paths to sync (files + removals).
 * @param spawnFn Injectable spawnSync for git subprocess calls.
 */
export function syncWorktreeIfOnMain(
	cwd: string,
	paths: string[],
	spawnFn: SpawnFn,
): void {
	const branchResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const branch = (branchResult.stdout ?? '').trim();
	if (branch !== 'main') return;

	if (paths.length === 0) return;

	const restoreResult = spawnFn(
		'git',
		['-C', cwd, 'restore', '--staged', '--worktree', '--source=HEAD', '--', ...paths],
		{ encoding: 'utf8' },
	);
	if ((restoreResult.status ?? 1) !== 0) {
		printWarning(
			'syncWorktreeIfOnMain: git restore failed',
			(restoreResult.stderr ?? '').trim(),
		);
	}
}

// ---------------------------------------------------------------------------
// checkMainUpToDate / pushMainBestEffort (shared guard + push helpers)
// ---------------------------------------------------------------------------
//
// GOTCHA (jscpd, CAM-118 US-002): four existing on-main callers
// (issue-specify.ts, issue-file.ts, journal.ts, triage.ts) each carry a
// byte-identical private copy of this guard+push pair. A 5th verbatim copy
// risks tripping the jscpd duplication gate (bun run check:all). NEW callers
// (starting with src/commands/domain-docs.ts) should import these shared
// exports instead of adding another private copy. The four existing copies
// are intentionally left untouched here (that dedup is CAM-124's scope, not
// this story's).

/** Guard outcome shared by all on-main writers. */
export type MainGuardResult =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: true; branchWasMain: boolean; localMainSha: string };

/**
 * Up-to-date guard. Runs before any mutation.
 *   0a. Detached HEAD -> { ok: false, reason: 'detached-head' }.
 *   0b. Missing local main branch -> { ok: false, reason: 'missing-main' }.
 *   0c. Best-effort fetch + divergence check against origin/main ->
 *       { ok: false, reason: 'diverged' } on mismatch.
 *
 * @param actionLabel human-readable verb phrase for the detached-head error
 *   message (e.g. 'write domain docs'), mirroring the per-caller wording used
 *   by the four existing private copies.
 */
export function checkMainUpToDate(
	cwd: string,
	spawnFn: SpawnFn,
	actionLabel: string,
): MainGuardResult {
	const branchResult = spawnFn('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
		encoding: 'utf8',
	});
	const currentBranch = (branchResult.stdout ?? '').trim();
	const branchWasMain = currentBranch === 'main';

	if (currentBranch === 'HEAD') {
		printError('detached HEAD', `cannot ${actionLabel} from a detached HEAD state`);
		return { ok: false, reason: 'detached-head' };
	}

	const localMainResult = spawnFn('git', ['-C', cwd, 'rev-parse', 'main'], {
		encoding: 'utf8',
	});
	if ((localMainResult.status ?? 1) !== 0) {
		printError('missing local main branch', 'run: git fetch origin main:main');
		return { ok: false, reason: 'missing-main' };
	}
	const localMainSha = (localMainResult.stdout ?? '').trim();

	spawnFn('git', ['-C', cwd, 'fetch', 'origin', 'main'], { encoding: 'utf8' });

	const originMainResult = spawnFn('git', ['-C', cwd, 'rev-parse', 'origin/main'], {
		encoding: 'utf8',
	});
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
 * Best-effort push of main to origin. A non-zero exit is logged via
 * printError; the caller does not abort (the local commit already landed).
 */
export function pushMainBestEffort(cwd: string, spawnFn: SpawnFn): void {
	const pushResult = spawnFn('git', ['-C', cwd, 'push', 'origin', 'main'], {
		encoding: 'utf8',
	});
	if ((pushResult.status ?? 1) !== 0) {
		printError(
			'push rejected',
			`git push origin main: ${(pushResult.stderr ?? '').trim() || 'unknown error'}`,
		);
	}
}

// ---------------------------------------------------------------------------
// commitTreeToMain
// ---------------------------------------------------------------------------

/**
 * Off-main path: git plumbing so the working tree and feature-branch HEAD are
 * left completely untouched.  All files in `files` land in ONE atomic commit;
 * if any hash-object or update-index call fails for a file, the function
 * throws before write-tree so none of the changes are committed.
 *
 * The update-ref step uses compare-and-swap (CAS): it passes the expected
 * old sha so git rejects the write when another writer has advanced main in
 * the meantime.  On CAS failure the helper re-reads refs/heads/main, rebuilds
 * the tree on the new base, and retries up to CAS_MAX_ATTEMPTS times.
 *
 * Coherence invariant:
 *   - Off-main working tree: left completely untouched (feature-branch edits
 *     are never clobbered).
 *   - On-main working tree: synced to HEAD after a successful commit via
 *     syncWorktreeIfOnMain, so the worktree stays coherent with the commit
 *     just written to refs/heads/main.
 *
 * Sequence per attempt:
 *   1. git read-tree main          -- populate the temp index with main's tree.
 *   1b. removePathsFromIndex       -- apply optional deletions.
 *   2. hashAndIndexFiles           -- hash + index all files (throws on error).
 *   3. commitAndCasAttempt         -- write-tree + commit-tree + CAS update-ref.
 *      if CAS ok: sync worktree (on-main only), then return short sha.
 *      if CAS fail: update currentMainSha, retry.
 *
 * For the 1-element list this produces the same sequence as the old
 * single-file implementation (parity guarantee).
 *
 * Returns the 7-char short sha of the new commit.
 *
 * @param cwd           Absolute path to the project root (git repo).
 * @param files         List of {path, content} pairs to commit atomically.
 * @param commitMsg     Git commit message.
 * @param localMainSha  Current sha of refs/heads/main (from checkMainUpToDate).
 * @param spawnFn       Injectable spawnSync for all git subprocess calls.
 * @param tmpPrefix     Prefix for mkdtemp (e.g. 'cam-issue-').
 * @param removals      Optional list of repo-relative paths to remove from the
 *                      tree in the same atomic commit (via update-index --force-remove).
 *                      Processed after read-tree and before file writes, so any
 *                      file in this list will be absent from the resulting tree
 *                      even if the same path also appears in `files`.
 */
export function commitTreeToMain(
	cwd: string,
	files: FileWrite[],
	commitMsg: string,
	localMainSha: string,
	spawnFn: SpawnFn,
	tmpPrefix: string,
	removals?: string[],
): string {
	const tmpDir = mkdtempSync(join(tmpdir(), tmpPrefix));
	const tempIndex = join(tmpDir, 'index');

	try {
		let currentMainSha = localMainSha;

		for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
			const indexEnv = buildIndexEnv(tempIndex);

			spawnFn('git', ['-C', cwd, 'read-tree', 'main'], {
				encoding: 'utf8',
				env: indexEnv,
			});

			removePathsFromIndex(cwd, removals ?? [], spawnFn, indexEnv);
			hashAndIndexFiles(cwd, files, spawnFn, indexEnv);
			const result = commitAndCasAttempt(cwd, currentMainSha, commitMsg, spawnFn, indexEnv);

			if (result.success) {
				const allPaths = [...files.map((f) => f.path), ...(removals ?? [])];
				syncWorktreeIfOnMain(cwd, allPaths, spawnFn);
				return result.shortSha;
			}
			currentMainSha = result.newMainSha;
		}

		throw new Error(
			`commitTreeToMain: CAS failed after ${CAS_MAX_ATTEMPTS} attempts`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}
