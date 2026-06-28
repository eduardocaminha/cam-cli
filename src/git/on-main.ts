// src/git/on-main.ts
//
// Shared on-main commit-tree plumbing extracted from the three callers that
// previously each carried a verbatim copy:
//   - src/commands/issue-file.ts   (commitTreeToMain + commitOnMain + buildIndexEnv)
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
//   - US-001 (CAM-90): both helpers now accept a FileWrite[] (list of
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
// commitOnMain
// ---------------------------------------------------------------------------

/**
 * On-main path: write all files to the working tree, git add each one, then
 * git commit with a single commit.  Working tree and HEAD both advance
 * (the normal commit path).
 * Returns the short sha from `git rev-parse --short HEAD`.
 *
 * For the 1-element case this is byte-behaviorally identical to the old
 * single-file signature.
 *
 * @param cwd        Absolute path to the project root (git repo).
 * @param files      List of {path, content} pairs to write and commit.
 *                   All files land in one commit.
 * @param commitMsg  Git commit message.
 * @param spawnFn    Injectable spawnSync for all git subprocess calls.
 * @param writeFile  Injectable file writer (called with the absolute path).
 */
export function commitOnMain(
	cwd: string,
	files: FileWrite[],
	commitMsg: string,
	spawnFn: SpawnFn,
	writeFile: (path: string, text: string) => void,
): string {
	for (const file of files) {
		const filePath = join(cwd, file.path);
		writeFile(filePath, file.content);
		spawnFn('git', ['-C', cwd, 'add', file.path], { encoding: 'utf8' });
	}
	spawnFn('git', ['-C', cwd, 'commit', '-m', commitMsg], { encoding: 'utf8' });
	const shaResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--short', 'HEAD'],
		{ encoding: 'utf8' },
	);
	return (shaResult.stdout ?? '').trim();
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
 * Sequence per attempt:
 *   1. git read-tree main          -- populate the temp index with main's tree.
 *   1b. removePathsFromIndex       -- apply optional deletions.
 *   2. hashAndIndexFiles           -- hash + index all files (throws on error).
 *   3. commitAndCasAttempt         -- write-tree + commit-tree + CAS update-ref.
 *      if CAS ok: return short sha.
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

			if (result.success) return result.shortSha;
			currentMainSha = result.newMainSha;
		}

		throw new Error(
			`commitTreeToMain: CAS failed after ${CAS_MAX_ATTEMPTS} attempts`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}
