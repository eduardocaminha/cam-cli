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
//      b2. Resolve `extraFiles` -- if a per-attempt recompute callback was
//          given (US-001, CAM-300), invoke it now with this attempt's fresh
//          main sha so a companion file's content can be re-derived from
//          main's current state on every retry, instead of a static
//          FileWrite[] built once, up front, that would go stale under
//          concurrent writers; a static FileWrite[] is used as-is.
//      c. git read-tree + hash-object + update-index + write-tree + commit-tree.
//      d. git update-ref (CAS).
//      e. On CAS failure: re-read main sha, loop (re-invoking the extraFiles
//         callback, if one was given, on the next attempt).
//   3. Throw after CAS_MAX_ATTEMPTS consecutive failures.
//
// CAM-90 US-003; CAM-300 US-001 (per-attempt extraFiles recompute).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allocateId, type BacklogSpawnFn } from './backlog.ts';
import type { IssueEntry, IssueStage, IssueStatus, WsjfScore } from './types.ts';
import {
	buildIndexEnv,
	CAS_MAX_ATTEMPTS,
	hashAndIndexFiles,
	commitAndCasAttempt,
	syncWorktreeIfOnMain,
	type FileWrite,
	type FileWritesFn,
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
	/**
	 * Source of the spec: 'operator' (fast-track via --fast-track flag) or
	 * 'derived' (fast-track via --derived-from flag). When present and equal to
	 * 'operator' or 'derived', the filed issue is set to stage:'specified'.
	 */
	specSource?: 'interview' | 'derived' | 'operator';
	/** Parent issue ids (when specSource === 'derived'). */
	derivedFrom?: string[];
	/** WSJF scoring resolved at filing time. */
	wsjf?: WsjfScore;
	/**
	 * Additional files to co-commit in the SAME atomic CAS commit as the
	 * allocated issue JSON. Re-hashed and re-indexed on every CAS attempt
	 * (same as the issue file itself), so callers can safely derive their
	 * content from data that predates the id allocation.
	 *
	 * Either a static FileWrite[] (computed once, up front -- the original
	 * form) or a per-attempt recompute callback (US-001, CAM-300) invoked
	 * once per CAS attempt with that attempt's freshly-read main sha, so the
	 * companion file's content can be re-derived from main's current state
	 * on every retry instead of clobbering a concurrent advance with stale
	 * content computed before the CAS loop even started.
	 */
	extraFiles?: FileWrite[] | FileWritesFn;
	/**
	 * Optional commit-message override, given the freshly-allocated unpadded
	 * id (e.g. `(id) => "chore(cam): suggestions promote <fp> -> <id>"`).
	 * Defaults to `chore(cam): file <id>`.
	 */
	commitMessage?: (id: string) => string;
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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build an IssueEntry for the CAS retry loop.
 * Extracted to keep writeIssueFile below biome's cognitive-complexity ceiling.
 */
function buildIssueEntry(
	id: string,
	title: string,
	baseStage: IssueStage,
	status: IssueStatus,
	blockedBy: string[],
	createdAt: string,
	description: string | undefined,
	specSource: 'interview' | 'derived' | 'operator' | undefined,
	derivedFrom: string[] | undefined,
	wsjf: WsjfScore | undefined,
): IssueEntry {
	// Fast-track issues are born stage:'specified'; others use the caller-supplied default.
	const stage: IssueStage =
		specSource === 'derived' || specSource === 'operator' ? 'specified' : baseStage;
	return {
		id,
		title,
		stage,
		status,
		blockedBy,
		createdAt,
		updatedAt: createdAt,
		...(description !== undefined ? { description } : {}),
		...(specSource !== undefined ? { specSource } : {}),
		...(derivedFrom !== undefined && derivedFrom.length > 0 ? { derivedFrom } : {}),
		...(wsjf !== undefined ? { wsjf } : {}),
	};
}

/**
 * Resolve `extraFiles` for one CAS attempt: invoke a per-attempt recompute
 * callback (US-001, CAM-300) with the attempt's fresh main sha, or pass a
 * static FileWrite[] through unchanged.
 */
function resolveExtraFiles(
	extraFiles: FileWrite[] | FileWritesFn,
	mainSha: string,
): FileWrite[] {
	return typeof extraFiles === 'function' ? extraFiles(mainSha) : extraFiles;
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
 * `opts.extraFiles`, when present, are co-committed in the SAME atomic
 * commit as the issue JSON: they are re-hashed and re-indexed on every CAS
 * attempt (US-001, CAM-290), so a caller can land a companion file rewrite
 * derived from the freshly-allocated id in the same commit (e.g. via
 * `opts.commitMessage`, which overrides the default `chore(cam): file <id>`).
 * When `opts.extraFiles` is a per-attempt recompute callback (US-001,
 * CAM-300) rather than a static FileWrite[], it is invoked once per CAS
 * attempt with that attempt's freshly-read main sha, so a whole-file
 * overwrite can be rebased onto a concurrently-advanced main on retry
 * instead of committing content that predates the advance.
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
		specSource,
		derivedFrom,
		wsjf,
		extraFiles = [],
		commitMessage,
		spawnFn,
	} = opts;

	// Adapter: allows passing SpawnFn to allocateId (which expects BacklogSpawnFn).
	// SpawnFn's options { encoding, env?, input? } is a strict superset of
	// BacklogSpawnFn's options { encoding, input? } so this adapter is safe.
	const readSpawn: BacklogSpawnFn = (cmd, args, o) => spawnFn(cmd, args, o);

	// Read initial main sha for the CAS baseline.
	const initRevParse = spawnFn('git', ['-C', cwd, 'rev-parse', 'main'], { encoding: 'utf8' });
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
			const entry = buildIssueEntry(
				idUnpadded, title, stage, status, blockedBy, now,
				description, specSource, derivedFrom, wsjf,
			);
			const content = JSON.stringify(entry, null, 2) + '\n';

			// (c) Populate the temp index, hash + index the blob(s), then CAS
			//     commit. extraFiles is resolved per-attempt (US-001, CAM-300):
			//     see resolveExtraFiles.
			const indexEnv = buildIndexEnv(tempIndex);
			spawnFn('git', ['-C', cwd, 'read-tree', 'main'], { encoding: 'utf8', env: indexEnv });
			const resolvedExtraFiles = resolveExtraFiles(extraFiles, currentMainSha);
			const attemptFiles = [{ path: filename, content }, ...resolvedExtraFiles];
			hashAndIndexFiles(cwd, attemptFiles, spawnFn, indexEnv);

			// (d) CAS: write-tree + commit-tree + update-ref.
			const commitMsg = commitMessage
				? commitMessage(idUnpadded)
				: `chore(cam): file ${idUnpadded}`;
			const result = commitAndCasAttempt(cwd, currentMainSha, commitMsg, spawnFn, indexEnv);
			if (result.success) {
				syncWorktreeIfOnMain(cwd, attemptFiles.map((f) => f.path), spawnFn);
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
