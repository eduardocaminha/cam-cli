// src/commands/triage.ts
//
// runTriage() -- deterministic `cam triage` CLI primitive.
//
// Reads {specified,open} issues from main via readBacklogFromMain (ls-tree +
// cat-file), runs the graph gate (US-003), computes dense ranks via WSJF
// topo-sort (US-002), diffs vs prior ranks, and (when ranks changed) writes
// the updated rank onto each affected CAM-NNNN.json as a MULTI-FILE atomic
// on-main commit.
//
// Design mirrors src/commands/issue-file.ts:
//   - Injectable SpawnFn + ClockFn + writeFile.
//   - checkMainUpToDate guard family (detached-head / missing-main / diverged).
//   - commitTreeToMain (both on-main and off-main; ref-only CAS commit).
//   - Exported result interface for type-safe test assertions.
//   - The old array backlog file is never read or written (CAM-90 US-004 cutover).
//
// Flow:
//   1. checkMainUpToDate guard (abort before any mutation on failure).
//   2. readBacklogFromMain (ls-tree + cat-file, never working-tree).
//   3. runGraphGate (US-003) -- pure check, no I/O.  Gate MUST run before any write.
//   4. rankIssues (US-002) -- compute dense 1-based ranks.
//   5. Build the unified warnings list: gateResult.warnings (cross-stage blockers)
//      followed by rankIssues warnings (WSJF-computation problems).  Both paths
//      below print this same list -- neither source is ever silently dropped.
//   6. Diff each ranked issue vs its prior rank (up / down / new / unchanged).
//   7. If no rank changed: print informational output + sentinel (changed=0 sha=none),
//      no commit (idempotent no-op).
//   8. Write rank onto each CHANGED {specified,open} entry as a MULTI-FILE
//      atomic commit (one commit, N files).
//   9. Best-effort push origin main.
//   10. Print ranked order, diff, unified warnings, sentinel.
//
// All external I/O is injectable for unit testing without a real git binary.
//
// CAM-108 US-004, CAM-90 US-004 (file-per-issue cutover).

import { commitTreeToMain } from '../git/on-main.ts';
import type { SpawnFn, FileWrite } from '../git/on-main.ts';
import type { IssueEntry } from '../issues/types.ts';
import { readBacklogFromMain, issueFilePath } from '../issues/backlog.ts';
import type { BacklogSpawnFn } from '../issues/backlog.ts';
import { runGraphGate } from '../issues/gate.ts';
import { rankIssues } from '../issues/rank.ts';
import type { RankedEntry } from '../issues/rank.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn so callers do not need to chase the import chain.
export type { SpawnFn };

/** Returns the current ISO 8601 timestamp string.  Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// SpawnFn -> BacklogSpawnFn adapter
// ---------------------------------------------------------------------------

function toBacklogSpawn(spawnFn: SpawnFn): BacklogSpawnFn {
	return (cmd, args, o) => spawnFn(cmd, args, o);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunTriageOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp (unused today; reserved for
	 *  future timestamped commit messages).  Pass `() => new Date().toISOString()`
	 *  in production; tests inject a fixed value.
	 */
	clock: ClockFn;
	/** Injectable file writer (retained for interface compat; unused after commitTreeToMain cutover). */
	writeFile?: (path: string, text: string) => void;
	/** Injectable stdout writer.  Defaults to process.stdout.write. */
	writeStdout?: (line: string) => void;
}

/** Successful outcome: gate passed, ranks computed, optionally committed. */
export interface TriageSuccessResult {
	ok: true;
	/** Number of issues in the {specified,open} set. */
	ranked: number;
	/** Number of issues whose rank changed vs prior.  0 = no-op (no commit). */
	changed: number;
	/** Short commit sha, or 'none' when changed === 0 (no-op, no commit). */
	sha: string;
}

/** Hard gate failure: cycle or referential-integrity error in blockedBy graph. */
export interface TriageGateFailResult {
	ok: false;
	kind: 'cycle' | 'integrity';
	/** Raw error strings from runGraphGate (e.g. cycle path). */
	errors: string[];
}

/** Infrastructure guard failure: detached HEAD, missing main, or diverged. */
export interface TriageGuardFailResult {
	ok: false;
	kind: 'guard';
	reason: 'detached-head' | 'missing-main' | 'diverged';
}

export type TriageResult = TriageSuccessResult | TriageGateFailResult | TriageGuardFailResult;

// ---------------------------------------------------------------------------
// Up-to-date guard (mirrors issue-file.ts checkMainUpToDate exactly)
// ---------------------------------------------------------------------------

type MainGuardResult =
	| TriageGuardFailResult
	| { ok: true; branchWasMain: boolean; localMainSha: string };

function checkMainUpToDate(cwd: string, spawnFn: SpawnFn): MainGuardResult {
	// 0a. Detect detached HEAD.
	const branchResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const currentBranch = (branchResult.stdout ?? '').trim();
	const branchWasMain = currentBranch === 'main';

	if (currentBranch === 'HEAD') {
		printError('detached HEAD', 'cannot run cam triage from a detached HEAD state');
		return { ok: false, kind: 'guard', reason: 'detached-head' };
	}

	// 0b. Verify local main exists; capture sha for reuse in commit-tree.
	const localMainResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'main'],
		{ encoding: 'utf8' },
	);
	if ((localMainResult.status ?? 1) !== 0) {
		printError('missing local main branch', 'run: git fetch origin main:main');
		return { ok: false, kind: 'guard', reason: 'missing-main' };
	}
	const localMainSha = (localMainResult.stdout ?? '').trim();

	// 0c. Best-effort fetch + up-to-date check.
	spawnFn('git', ['-C', cwd, 'fetch', 'origin', 'main'], { encoding: 'utf8' });

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
			return { ok: false, kind: 'guard', reason: 'diverged' };
		}
	}

	return { ok: true, branchWasMain, localMainSha };
}

// ---------------------------------------------------------------------------
// Best-effort push (mirrors issue-file.ts pushMainBestEffort)
// ---------------------------------------------------------------------------

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
// Diff helpers
// ---------------------------------------------------------------------------

type DiffTag = 'up' | 'down' | 'new' | 'unchanged';

function computeDiffTag(priorRank: number | undefined, newRank: number): DiffTag {
	if (priorRank === undefined) return 'new';
	if (newRank < priorRank) return 'up';
	if (newRank > priorRank) return 'down';
	return 'unchanged';
}

/**
 * Computes rank diff vs prior ranks.
 * Returns changed count, formatted diff lines, and the list of FileWrite
 * entries for issues whose rank changed (used for the multi-file commit).
 */
function computeRankDiff(
	ranked: RankedEntry[],
	issueByIdMap: Map<string, IssueEntry>,
): { changed: number; diffLines: string[]; changedFiles: FileWrite[] } {
	let changed = 0;
	const diffLines: string[] = [];
	const changedFiles: FileWrite[] = [];
	for (const entry of ranked) {
		const issue = issueByIdMap.get(entry.id);
		const priorRank = issue?.rank;
		const tag = computeDiffTag(priorRank, entry.rank);
		if (tag !== 'unchanged') {
			changed++;
			if (issue !== undefined) {
				const updated: IssueEntry = { ...issue, rank: entry.rank };
				changedFiles.push({
					path: issueFilePath(entry.id),
					content: JSON.stringify(updated, null, 2) + '\n',
				});
			}
		}
		const priorStr = priorRank !== undefined ? String(priorRank) : '-';
		diffLines.push(
			`  ${entry.id}: ${tag} (prev=${priorStr} now=${entry.rank} wsjf=${entry.wsjf.toFixed(2)} stage=${entry.stage})`,
		);
	}
	return { changed, diffLines, changedFiles };
}

/** Prints ranked list, diff lines, warnings, and the sentinel. */
function printTriageOutput(
	writeStdout: (line: string) => void,
	ranked: RankedEntry[],
	diffLines: string[],
	warnings: string[],
	changed: number,
	sha: string,
): void {
	for (const entry of ranked) {
		writeStdout(`  rank=${entry.rank} id=${entry.id} wsjf=${entry.wsjf.toFixed(2)} stage=${entry.stage}\n`);
	}
	for (const line of diffLines) writeStdout(`${line}\n`);
	for (const w of warnings) writeStdout(`warning: ${w}\n`);
	writeStdout(`CAM_TRIAGE_RANKED=${ranked.length} changed=${changed} sha=${sha}\n`);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Deterministic triage primitive.
 *
 * See module header for the full flow.  All external I/O is injectable via
 * RunTriageOptions so unit tests never shell out to a real git binary.
 */
export function runTriage(options: RunTriageOptions): TriageResult {
	const { cwd, spawnFn } = options;
	const writeStdout = options.writeStdout ?? ((line: string) => { process.stdout.write(line); });

	// Guard 0a-0c: abort before any mutation.
	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { localMainSha } = guard;

	// 1. Read backlog from main via per-file primitives (never the working tree).
	const allIssues = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));

	// 2. Run graph gate BEFORE any write (AC#1 ordering invariant).
	const gateResult = runGraphGate(allIssues);
	if (!gateResult.ok) {
		writeStdout(`CAM_TRIAGE_REJECTED=${gateResult.kind}:${gateResult.errors[0] ?? 'unknown'}\n`);
		return { ok: false, kind: gateResult.kind, errors: gateResult.errors };
	}

	// 3. Compute dense ranks and diff vs prior ranks.
	const { ranked, warnings: rankWarnings } = rankIssues(allIssues);
	const issueByIdMap = new Map<string, IssueEntry>(allIssues.map((e) => [e.id, e]));
	const { changed, diffLines, changedFiles } = computeRankDiff(ranked, issueByIdMap);

	// Unified warnings list (gate warnings first, then rank warnings): both the
	// no-op path and the commit path below print this SAME list, so neither
	// source is ever silently dropped by one of the two code paths.
	const warnings = [...gateResult.warnings, ...rankWarnings];

	// 4. Idempotent no-op: if nothing changed, skip commit (AC#2).
	if (changed === 0) {
		printTriageOutput(writeStdout, ranked, diffLines, warnings, 0, 'none');
		return { ok: true, ranked: ranked.length, changed: 0, sha: 'none' };
	}

	// 5. Commit the changed files as one atomic multi-file commit.
	const commitMsg = `chore(cam): triage ${ranked.length} issues ranked (${changed} changed)`;

	const sha = commitTreeToMain(cwd, changedFiles, commitMsg, localMainSha, spawnFn, 'cam-triage-');

	// 6. Best-effort push.
	pushMainBestEffort(cwd, spawnFn);

	// 7. Print ranked order, diff, warnings, sentinel (AC#3).
	printTriageOutput(writeStdout, ranked, diffLines, warnings, changed, sha);

	return { ok: true, ranked: ranked.length, changed, sha };
}
