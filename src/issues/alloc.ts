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
	hashAndIndexFiles,
	commitAndCasAttempt,
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

			// (c) Populate the temp index, hash + index the blob, then CAS commit.
			const indexEnv = buildIndexEnv(tempIndex);
			spawnFn('git', ['-C', cwd, 'read-tree', 'main'], {
				encoding: 'utf8',
				env: indexEnv,
			});
			hashAndIndexFiles(cwd, [{ path: filename, content }], spawnFn, indexEnv);

			// (d) CAS: write-tree + commit-tree + update-ref.
			const commitMsg = `chore(cam): file ${idUnpadded}`;
			const result = commitAndCasAttempt(cwd, currentMainSha, commitMsg, spawnFn, indexEnv);
			if (result.success) {
				return { id: idUnpadded, filename, sha: result.shortSha };
			}

			// (e) CAS failed: update sha for next attempt.
			currentMainSha = result.newMainSha;
		}

		throw new Error(
			`writeIssueFile: CAS failed after ${CAS_MAX_ATTEMPTS} attempts`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}
