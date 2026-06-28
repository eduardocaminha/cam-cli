// src/issues/alloc.ts
//
// writeIssueFile() -- write one CAM-NNNN.json file to main via the CAS
// retry loop, re-deriving the id on every retry so concurrent allocations
// never collide.
//
// Filename convention (per-file backlog, CAM-90):
//   - Filename: scripts/cam/issues/CAM-NNNN.json  (4-digit zero-padded)
//   - id field:  CAM-N                              (unpadded, e.g. CAM-90)
//
// CAS retry design:
//   1. Read current main sha via git rev-parse.
//   2. Retry loop (up to CAS_MAX_ATTEMPTS):
//      a. allocateId()   -- reads fresh from main each time.
//      b. Build content.
//      c. git read-tree + hash-object + update-index + write-tree + commit-tree.
//      d. git update-ref (CAS).
//      e. On CAS failure: re-read main sha, loop.
//   3. Throw after CAS_MAX_ATTEMPTS consecutive failures.
//
// CAM-90 US-003.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allocateId, type BacklogSpawnFn } from './backlog.ts';
import type { IssueEntry, IssueStage, IssueStatus } from './types.ts';
import {
	buildIndexEnv,
	CAS_MAX_ATTEMPTS,
	type SpawnFn,
} from '../git/on-main.ts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WriteIssueFileOptions {
	/** Absolute path to the git repo root. */
	cwd: string;
	/** Issue title. */
	title: string;
	/** Issue stage. Defaults to 'idea'. */
	stage?: IssueStage;
	/** Issue status. Defaults to 'open'. */
	status?: IssueStatus;
	/** Optional description. */
	description?: string;
	/** Ids of blocking issues. Defaults to []. */
	blockedBy?: string[];
	/**
	 * ISO 8601 timestamp for createdAt.
	 * Defaults to new Date().toISOString() when not provided.
	 */
	createdAt?: string;
	/** Id prefix (e.g. 'CAM'). Defaults to 'CAM'. */
	prefix?: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
}

export interface WriteIssueFileResult {
	/** Unpadded id, e.g. 'CAM-90'. */
	id: string;
	/** Repo-relative path to the file, e.g. 'scripts/cam/issues/CAM-0090.json'. */
	filename: string;
	/** 7-char short sha of the new commit on main. */
	sha: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Allocate the next issue id (max-on-main + 1) and write a single
 * scripts/cam/issues/CAM-NNNN.json file atomically to main via a CAS
 * compare-and-swap update-ref loop.
 *
 * On CAS failure (another writer advanced main between our read and our
 * update-ref), the function re-reads the max id from main and re-allocates
 * before retrying, ensuring two concurrent writers always produce distinct
 * sequential ids rather than colliding.
 *
 * Returns the unpadded id, the filename, and the short sha of the new commit.
 */
export function writeIssueFile(opts: WriteIssueFileOptions): WriteIssueFileResult {
	const {
		cwd,
		title,
		stage = 'idea',
		status = 'open',
		blockedBy = [],
		description,
		createdAt,
		prefix = 'CAM',
		spawnFn,
	} = opts;

	// Adapter: allows passing SpawnFn to allocateId (which expects BacklogSpawnFn).
	// SpawnFn's options { encoding, env?, input? } is a strict superset of
	// BacklogSpawnFn's options { encoding, input? } so this adapter is safe.
	const readSpawn: BacklogSpawnFn = (cmd, args, o) => spawnFn(cmd, args, o);

	// Read initial main sha for the CAS baseline.
	const initRevParse = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'main'],
		{ encoding: 'utf8' },
	);
	let currentMainSha = (initRevParse.stdout ?? '').trim();

	const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-file-'));
	const tempIndex = join(tmpDir, 'index');

	try {
		for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
			// (a) Re-derive id from main on every attempt so a CAS loser
			//     re-allocates from the now-advanced backlog.
			const n = allocateId(cwd, readSpawn);
			const idUnpadded = `${prefix}-${n}`;
			const filename = `scripts/cam/issues/${prefix}-${String(n).padStart(4, '0')}.json`;

			// (b) Build the IssueEntry.  id field is UNPADDED.
			const now = createdAt ?? new Date().toISOString();
			const entry: IssueEntry = {
				id: idUnpadded,
				title,
				stage,
				status,
				blockedBy,
				createdAt: now,
				...(description !== undefined ? { description } : {}),
			};
			const content = JSON.stringify(entry, null, 2) + '\n';

			// (c) Populate the temp index from main's current tree.
			spawnFn('git', ['-C', cwd, 'read-tree', 'main'], {
				encoding: 'utf8',
				env: buildIndexEnv(tempIndex),
			});

			// Hash the new blob into the object store.
			const hashResult = spawnFn(
				'git',
				['-C', cwd, 'hash-object', '-w', '--stdin'],
				{ encoding: 'utf8', env: buildIndexEnv(tempIndex), input: content },
			);
			if ((hashResult.status ?? 1) !== 0) {
				throw new Error(
					`writeIssueFile: git hash-object failed for ${filename}: ${hashResult.stderr ?? ''}`,
				);
			}
			const blobSha = (hashResult.stdout ?? '').trim();

			// Add the blob to the temp index at the target path.
			const updateIndexResult = spawnFn(
				'git',
				[
					'-C', cwd,
					'update-index', '--add', '--cacheinfo',
					`100644,${blobSha},${filename}`,
				],
				{ encoding: 'utf8', env: buildIndexEnv(tempIndex) },
			);
			if ((updateIndexResult.status ?? 1) !== 0) {
				throw new Error(
					`writeIssueFile: git update-index failed for ${filename}: ${updateIndexResult.stderr ?? ''}`,
				);
			}

			// Write the temp index as a tree object.
			const treeResult = spawnFn(
				'git',
				['-C', cwd, 'write-tree'],
				{ encoding: 'utf8', env: buildIndexEnv(tempIndex) },
			);
			const treeSha = (treeResult.stdout ?? '').trim();

			// Commit the tree parented on the current main sha.
			const commitMsg = `chore(cam): file ${idUnpadded}`;
			const commitResult = spawnFn(
				'git',
				['-C', cwd, 'commit-tree', treeSha, '-p', currentMainSha, '-m', commitMsg],
				{ encoding: 'utf8' },
			);
			const newCommitSha = (commitResult.stdout ?? '').trim();

			// (d) CAS update-ref: only advances main when it still equals currentMainSha.
			const updateRefResult = spawnFn(
				'git',
				['-C', cwd, 'update-ref', 'refs/heads/main', newCommitSha, currentMainSha],
				{ encoding: 'utf8' },
			);

			if ((updateRefResult.status ?? 1) === 0) {
				// CAS succeeded.
				return {
					id: idUnpadded,
					filename,
					sha: newCommitSha.substring(0, 7),
				};
			}

			// (e) CAS failed: another writer advanced main.  Re-read sha and retry.
			if (attempt < CAS_MAX_ATTEMPTS - 1) {
				const revParseResult = spawnFn(
					'git',
					['-C', cwd, 'rev-parse', 'main'],
					{ encoding: 'utf8' },
				);
				currentMainSha = (revParseResult.stdout ?? '').trim();
			}
		}

		throw new Error(
			`writeIssueFile: CAS failed after ${CAS_MAX_ATTEMPTS} attempts`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}
