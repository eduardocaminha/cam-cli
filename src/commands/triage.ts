// src/commands/triage.ts
//
// runTriage() -- deterministic `cam triage` CLI primitive.
//
// Reads {specified,open} issues from main, runs the graph gate (US-003), computes
// dense ranks via WSJF topo-sort (US-002), diffs vs prior ranks, and (when ranks
// changed) writes the updated issues.local.json back to main via the US-001
// shared on-main commit-tree helper.
//
// Design mirrors src/commands/issue-file.ts:
//   - Injectable SpawnFn + ClockFn + writeFile.
//   - checkMainUpToDate guard family (detached-head / missing-main / diverged).
//   - commitOnMain (on-main path) / commitTreeToMain (off-main path).
//   - Exported result interface for type-safe test assertions.
//
// Flow:
//   1. checkMainUpToDate guard (abort before any mutation on failure).
//   2. git show main:scripts/cam/issues.local.json (read, never working-tree).
//   3. runGraphGate (US-003) -- pure check, no I/O.  Gate MUST run before any write.
//   4. rankIssues (US-002) -- compute dense 1-based ranks.
//   5. Diff each ranked issue vs its prior rank (up / down / new / unchanged).
//   6. If no rank changed: print informational output + sentinel (changed=0 sha=none),
//      no commit (idempotent no-op).
//   7. Write rank onto every {specified,open} entry, serialize, commit to main.
//   8. Best-effort push origin main.
//   9. Print ranked order, diff, warnings, sentinel.
//
// All external I/O is injectable for unit testing without a real git binary.
//
// CAM-108 US-004.

import { writeFileSync } from 'node:fs';
import { commitOnMain, commitTreeToMain } from '../git/on-main.ts';
import type { SpawnFn } from '../git/on-main.ts';
import type { IssueEntry, IssuesLocalJson } from '../issues/types.ts';
import { runGraphGate } from '../issues/gate.ts';
import { rankIssues } from '../issues/rank.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn so callers do not need to chase the import chain.
export type { SpawnFn };

/** Returns the current ISO 8601 timestamp string.  Injectable for tests. */
export type ClockFn = () => string;

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
	/** Injectable file writer (on-main path only).  Defaults to writeFileSync. */
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
	// fetch is best-effort: ignore non-zero exit (no network / no remote).
	spawnFn('git', ['-C', cwd, 'fetch', 'origin', 'main'], { encoding: 'utf8' });

	// If origin/main exists, compare its sha against the local sha.
	// When origin/main is absent (no remote configured), skip entirely.
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
	const writeFile = options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));
	const writeStdout = options.writeStdout ?? ((line: string) => { process.stdout.write(line); });

	// Guard 0a-0c: abort before any mutation.
	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { branchWasMain, localMainSha } = guard;

	// 1. Read backlog from main (never the working tree).
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/issues.local.json'],
		{ encoding: 'utf8' },
	);
	const backlog = JSON.parse(showResult.stdout) as IssuesLocalJson;

	// 2. Run graph gate BEFORE any write (AC#1 ordering invariant).
	//    If the gate fails, we emit the sentinel and return without touching any file.
	const gateResult = runGraphGate(backlog.issues);
	if (!gateResult.ok) {
		const detail = gateResult.errors[0] ?? 'unknown';
		writeStdout(`CAM_TRIAGE_REJECTED=${gateResult.kind}:${detail}\n`);
		return { ok: false, kind: gateResult.kind, errors: gateResult.errors };
	}

	// 3. Compute dense ranks via US-002 WSJF topo-sort.
	const { ranked, warnings } = rankIssues(backlog.issues);

	// 4. Build diff vs prior ranks and count changes.
	const issueByIdMap = new Map<string, IssueEntry>(backlog.issues.map((e) => [e.id, e]));
	let changed = 0;
	const diffLines: string[] = [];
	for (const entry of ranked) {
		const issue = issueByIdMap.get(entry.id);
		const priorRank = issue?.rank;
		const tag = computeDiffTag(priorRank, entry.rank);
		if (tag !== 'unchanged') changed++;
		const priorStr = priorRank !== undefined ? String(priorRank) : '-';
		diffLines.push(
			`  ${entry.id}: ${tag} (prev=${priorStr} now=${entry.rank} wsjf=${entry.wsjf.toFixed(2)} stage=${entry.stage})`,
		);
	}

	// 5. Idempotent no-op: if nothing changed, skip commit (AC#2).
	if (changed === 0) {
		for (const entry of ranked) {
			writeStdout(`  rank=${entry.rank} id=${entry.id} wsjf=${entry.wsjf.toFixed(2)} stage=${entry.stage}\n`);
		}
		for (const line of diffLines) writeStdout(`${line}\n`);
		for (const w of gateResult.warnings) writeStdout(`warning: ${w}\n`);
		writeStdout(`CAM_TRIAGE_RANKED=${ranked.length} changed=0 sha=none\n`);
		return { ok: true, ranked: ranked.length, changed: 0, sha: 'none' };
	}

	// 6. Write rank onto every {specified,open} entry (all-ranks-or-none: gate passed above).
	const newRankMap = new Map(ranked.map((e) => [e.id, e.rank]));
	for (const issue of backlog.issues) {
		if (issue.stage === 'specified' && issue.status === 'open') {
			const newRank = newRankMap.get(issue.id);
			if (newRank !== undefined) {
				issue.rank = newRank;
			}
		}
	}
	const serialized = JSON.stringify(backlog, null, 2) + '\n';
	const commitMsg = `chore(cam): triage ${ranked.length} issues ranked (${changed} changed)`;

	// 7. Commit to main via US-001 shared helper.
	//    off-main: commit-tree plumbing (feature branch HEAD + working tree untouched).
	//    on-main: direct commit (working tree and HEAD advance normally).
	const sha = branchWasMain
		? commitOnMain(
			cwd, serialized, commitMsg, spawnFn, writeFile,
			'scripts/cam/issues.local.json',
		)
		: commitTreeToMain(
			cwd, serialized, commitMsg, localMainSha, spawnFn,
			'scripts/cam/issues.local.json', 'cam-triage-',
		);

	// 8. Best-effort push.
	pushMainBestEffort(cwd, spawnFn);

	// 9. Print ranked order, diff, warnings, sentinel (AC#3).
	for (const entry of ranked) {
		writeStdout(`  rank=${entry.rank} id=${entry.id} wsjf=${entry.wsjf.toFixed(2)} stage=${entry.stage}\n`);
	}
	for (const line of diffLines) writeStdout(`${line}\n`);
	for (const w of gateResult.warnings) writeStdout(`warning: ${w}\n`);
	writeStdout(`CAM_TRIAGE_RANKED=${ranked.length} changed=${changed} sha=${sha}\n`);

	return { ok: true, ranked: ranked.length, changed, sha };
}
