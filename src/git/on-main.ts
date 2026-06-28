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
//     (b) the file path argument ('scripts/cam/issues.local.json' vs
//         'scripts/cam/journal.md')
//   - Both parameters are now explicit arguments so callers stay
//     byte-behaviorally identical to the pre-extraction code.
//   - SpawnFn is re-exported here so callers (including triage.ts, US-004)
//     can import the type from one place.
//
// DO NOT import this module from anywhere outside src/commands/ that
// performs on-main mutations. Read-only callers do not need it.
//
// CAM-108 US-001 (closes CAM-124).

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
 * On-main path: write the working-tree file, git add, git commit.
 * Working tree and HEAD both advance (the normal commit path).
 * Returns the short sha from `git rev-parse --short HEAD`.
 *
 * @param cwd            Absolute path to the project root (git repo).
 * @param serialized     File content to write and commit.
 * @param commitMsg      Git commit message.
 * @param spawnFn        Injectable spawnSync for all git subprocess calls.
 * @param writeFile      Injectable file writer.
 * @param fileGitRelPath Git-relative path of the file to write and add
 *                       (e.g. 'scripts/cam/issues.local.json').
 */
export function commitOnMain(
	cwd: string,
	serialized: string,
	commitMsg: string,
	spawnFn: SpawnFn,
	writeFile: (path: string, text: string) => void,
	fileGitRelPath: string,
): string {
	const filePath = join(cwd, fileGitRelPath);
	writeFile(filePath, serialized);
	spawnFn('git', ['-C', cwd, 'add', fileGitRelPath], { encoding: 'utf8' });
	spawnFn('git', ['-C', cwd, 'commit', '-m', commitMsg], { encoding: 'utf8' });
	const shaResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--short', 'HEAD'],
		{ encoding: 'utf8' },
	);
	return (shaResult.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// commitTreeToMain
// ---------------------------------------------------------------------------

/**
 * Off-main path: git plumbing so the working tree and feature-branch HEAD are
 * left completely untouched.
 *
 * Sequence:
 *   1. mkdtemp with `tmpPrefix` -- creates an isolated GIT_INDEX_FILE.
 *   2. git read-tree main         -- populate the temp index with main's tree.
 *   3. git hash-object -w --stdin -- write the new blob; content via `input`.
 *   4. git update-index --add --cacheinfo 100644,<blob>,<fileGitRelPath>
 *   5. git write-tree             -- persist the index as a new tree object.
 *   6. git commit-tree <tree> -p <localMainSha> -m <commitMsg>
 *   7. git update-ref refs/heads/main <newCommit>
 *
 * Returns the 7-char short sha of the new commit.
 *
 * @param cwd            Absolute path to the project root (git repo).
 * @param serialized     File content to write into the git object store.
 * @param commitMsg      Git commit message.
 * @param localMainSha   Current sha of refs/heads/main (from checkMainUpToDate).
 * @param spawnFn        Injectable spawnSync for all git subprocess calls.
 * @param fileGitRelPath Git-relative path of the mutated file
 *                       (e.g. 'scripts/cam/issues.local.json').
 * @param tmpPrefix      Prefix for mkdtemp (e.g. 'cam-issue-').
 */
export function commitTreeToMain(
	cwd: string,
	serialized: string,
	commitMsg: string,
	localMainSha: string,
	spawnFn: SpawnFn,
	fileGitRelPath: string,
	tmpPrefix: string,
): string {
	const tmpDir = mkdtempSync(join(tmpdir(), tmpPrefix));
	const tempIndex = join(tmpDir, 'index');

	try {
		// read-tree: populate the temp index with the tree at main.
		spawnFn('git', ['-C', cwd, 'read-tree', 'main'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
		});

		// hash-object: write the updated content blob to the object store.
		// The content is fed via options.input (the widened SpawnFn field).
		const hashResult = spawnFn('git', ['-C', cwd, 'hash-object', '-w', '--stdin'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
			input: serialized,
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
				`100644,${blobSha},${fileGitRelPath}`,
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
		// Reuse localMainSha captured in the guard step (avoids a second rev-parse).
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
