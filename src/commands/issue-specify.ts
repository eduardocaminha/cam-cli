// src/commands/issue-specify.ts
//
// specifyIssueOnMain() -- promote an issue from stage:'idea' to stage:'specified'
// by writing spec, wsjf, and blockedBy directly on main, from any branch.
//
// Design goals (mirrors src/commands/issue-file.ts):
//   - Backlog is read from main via readBacklogFromMain (ls-tree + cat-file).
//     Never runs `git checkout` (the working-tree and work branch are untouched).
//   - Off-main path: git plumbing (temp GIT_INDEX_FILE, read-tree, hash-object,
//     update-index, write-tree, commit-tree, update-ref) so the feature-branch
//     HEAD and working tree are left completely untouched.
//   - On-main path: same ref-only commitTreeToMain path as off-main (CAM-133).
//   - Writes only the target issue's CAM-NNNN.json file; the old array backlog
//     file is never read or written (CAM-90 US-004 per-file cutover).
//   - All external dependencies are injectable for unit-testing without a real
//     git binary or filesystem.
//
// Guards (in order, before any mutation):
//   0. Up-to-date guard: detached-head, missing-main, diverged.
//   1. Validate spec via validateSpec from src/issues/spec.ts.
//   2. Validate wsjf via validateWsjf from src/issues/spec.ts.
//   3. Target id exists in backlog.
//   4. Target issue is stage:'idea'.
//   5. Target issue is status:'open'.
//   6. Referential integrity of post-write backlog (checkReferentialIntegrity).
//
// Commit msg style: `chore(cam): specify <id>`.
//
// CAM-107 (US-003 grill spec layer), CAM-90 US-004 (file-per-issue cutover).

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { checkReferentialIntegrity } from '../issues/graph.ts';
import { validateSpec, validateWsjf, validateIssueType } from '../issues/spec.ts';
import type { Spec } from '../issues/spec.ts';
import type { IssueEntry, WsjfScore } from '../issues/types.ts';
import { readBacklogFromMain, issueFilePath } from '../issues/backlog.ts';
import type { BacklogSpawnFn } from '../issues/backlog.ts';
import { printError } from '../logging/color.ts';
import { commitTreeToMain } from '../git/on-main.ts';
import type { SpawnFn } from '../git/on-main.ts';
import type { FileWrite } from '../git/on-main.ts';
import { makeFileEventLogger } from '../supervisor/events.ts';
import type { WorkerEventLogger } from '../supervisor/events.ts';

// Re-export SpawnFn from the shared module so existing callers do not need
// to update their import paths.
export type { SpawnFn };

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// SpawnFn -> BacklogSpawnFn adapter
// ---------------------------------------------------------------------------

/**
 * Adapt a SpawnFn (which has the wider {encoding,env?,input?} options) to the
 * BacklogSpawnFn signature (which only has {encoding,input?}).  The adapter is
 * safe because SpawnFn is a strict superset.
 */
function toBacklogSpawn(spawnFn: SpawnFn): BacklogSpawnFn {
	return (cmd, args, o) => spawnFn(cmd, args, o);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpecifyIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Id of the issue to specify (must exist with stage:'idea', status:'open'). */
	id: string;
	/** Structured spec produced by the grill. */
	spec: Spec;
	/** WSJF scoring fields. */
	wsjf: WsjfScore;
	/** Ids of issues this one is blocked by (default: []). */
	blockedBy?: string[];
	/**
	 * Optional issue type, captured during the grill. When present, must be
	 * one of "feat" | "fix" | "chore" | "docs". When absent, no type key is
	 * written to the issue entry (no default is applied here -- defaulting
	 * to "feat" is a consumer-side concern for the planner/composer).
	 */
	type?: IssueEntry['type'];
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Injectable file writer (retained for interface compat; unused after commitTreeToMain cutover). */
	writeFile?: (path: string, text: string) => void;
	/**
	 * Injectable event sink for the 'stage-promoted' observability event.
	 * Defaults to makeFileEventLogger(<cwd>/.claude/cam-worker-events.jsonl),
	 * the canonical production sink. Inject a fake in tests.
	 */
	eventSink?: WorkerEventLogger;
}

/** Successful outcome: issue was promoted, committed to main, and pushed. */
export interface SpecifyIssueOnMainResult {
	ok: true;
	id: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

/** Guard or error outcome: no commit was made. */
export type SpecifyIssueOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'wrong-stage' }
	| { ok: false; reason: 'not-open' }
	| { ok: false; reason: 'invalid-spec'; errors: string[] }
	| { ok: false; reason: 'invalid-wsjf'; errors: string[] }
	| { ok: false; reason: 'invalid-type'; errors: string[] }
	| { ok: false; reason: 'integrity-error'; errors: string[] };

export type SpecifyIssueOnMainOutcome =
	| SpecifyIssueOnMainResult
	| SpecifyIssueOnMainError;

type MainGuardResult =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: true; branchWasMain: boolean; localMainSha: string };

function checkMainUpToDate(cwd: string, spawnFn: SpawnFn): MainGuardResult {
	const branchResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const currentBranch = (branchResult.stdout ?? '').trim();
	const branchWasMain = currentBranch === 'main';

	if (currentBranch === 'HEAD') {
		printError('detached HEAD', 'cannot specify issue from a detached HEAD state');
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
// Abandon mode types
// ---------------------------------------------------------------------------

export interface AbandonIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Id of the issue to abandon (must be status:'open'). */
	id: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Injectable file writer (retained for interface compat; unused after commitTreeToMain cutover). */
	writeFile?: (path: string, text: string) => void;
}

export interface AbandonIssueOnMainResult {
	ok: true;
	id: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

export type AbandonIssueOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'already-abandoned' };

export type AbandonIssueOnMainOutcome =
	| AbandonIssueOnMainResult
	| AbandonIssueOnMainError;

// ---------------------------------------------------------------------------
// Merge-into mode types
// ---------------------------------------------------------------------------

export interface MergeIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Id of the source issue to abandon. */
	id: string;
	/** Id of the target issue to merge into (must exist; must not equal id). */
	intoId: string;
	/**
	 * If true, fold source.blockedBy into target.blockedBy (de-duplicated).
	 * Default: false.
	 */
	foldBlockedBy?: boolean;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Injectable file writer (retained for interface compat; unused after commitTreeToMain cutover). */
	writeFile?: (path: string, text: string) => void;
}

export interface MergeIssueOnMainResult {
	ok: true;
	id: string;
	intoId: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

export type MergeIssueOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'source-not-found' }
	| { ok: false; reason: 'target-not-found' }
	| { ok: false; reason: 'self-merge' }
	| { ok: false; reason: 'already-abandoned' };

export type MergeIssueOnMainOutcome =
	| MergeIssueOnMainResult
	| MergeIssueOnMainError;

// ---------------------------------------------------------------------------
// Event emission helper
// ---------------------------------------------------------------------------

/**
 * Emit a 'stage-promoted' observability event.
 * Uses the injected sink when provided; falls back to the canonical production
 * file sink (makeFileEventLogger writing to <cwd>/.claude/cam-worker-events.jsonl).
 */
function emitStagePromoted(
	cwd: string,
	id: string,
	clock: ClockFn,
	eventSink: WorkerEventLogger | undefined,
): void {
	const sink =
		eventSink ??
		makeFileEventLogger(join(cwd, '.claude', 'cam-worker-events.jsonl'));
	sink({
		ts: clock(),
		storyId: id,
		uuid: randomUUID(),
		kind: 'stage-promoted',
		detail: { id, fromStage: 'idea', toStage: 'specified' },
	});
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Promote an issue from stage:'idea' to stage:'specified' by writing spec,
 * wsjf, and blockedBy to the issue's CAM-NNNN.json file on main.
 *
 * Guards (in order, before any mutation):
 *   0. Up-to-date guard (detached-head, missing-main, diverged).
 *   1. validateSpec -- invalid-spec error on failure.
 *   2. validateWsjf -- invalid-wsjf error on failure.
 *   2.5. validateIssueType -- invalid-type error on failure (type is optional;
 *        absence never errors).
 *   3. Target id must exist in the backlog -- not-found on failure.
 *   4. Target issue must be stage:'idea' -- wrong-stage on failure.
 *   5. Target issue must be status:'open' -- not-open on failure.
 *
 * Mutation (in-memory, then committed):
 *   Set entry.spec = spec, entry.wsjf = wsjf,
 *       entry.blockedBy = blockedBy ?? [], entry.stage = 'specified'.
 *   entry.type is set only when options.type is present; a payload without
 *   type leaves the entry without a type key (no default is written).
 *
 *   6. checkReferentialIntegrity on the mutated backlog -- integrity-error on failure.
 *
 * Commit path: writes only scripts/cam/issues/CAM-NNNN.json (one file).
 *   Off-main plumbing: commitTreeToMain (temp GIT_INDEX_FILE, read-tree, hash-object,
 *   update-index, write-tree, commit-tree, update-ref) so the work branch is untouched.
 *   On-main path: same ref-only commitTreeToMain path as off-main (CAM-133).
 *
 * Commit message: `chore(cam): specify <id>`.
 */
export function specifyIssueOnMain(
	options: SpecifyIssueOnMainOptions,
): SpecifyIssueOnMainOutcome {
	const { cwd, id, spec, wsjf, spawnFn, clock } = options;
	const blockedBy = options.blockedBy ?? [];
	const type = options.type;

	// Guard 0: up-to-date check.
	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) {
		return guard;
	}
	const { branchWasMain, localMainSha } = guard;

	// Guard 1: validate spec.
	const specResult = validateSpec(spec);
	if (!specResult.ok) {
		return { ok: false, reason: 'invalid-spec', errors: specResult.errors };
	}

	// Guard 2: validate wsjf.
	const wsjfResult = validateWsjf(wsjf);
	if (!wsjfResult.ok) {
		return { ok: false, reason: 'invalid-wsjf', errors: wsjfResult.errors };
	}

	// Guard 2.5: validate type (optional; absence is not an error).
	const typeResult = validateIssueType(type);
	if (!typeResult.ok) {
		return { ok: false, reason: 'invalid-type', errors: typeResult.errors };
	}

	// Read backlog from main via the per-file primitives (never from the working tree).
	const allIssues = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));

	// Guard 3: target id exists.
	const entryIndex = allIssues.findIndex((e: IssueEntry) => e.id === id);
	if (entryIndex === -1) {
		return { ok: false, reason: 'not-found' };
	}

	const entry = allIssues[entryIndex];
	if (entry === undefined) {
		return { ok: false, reason: 'not-found' };
	}

	// Guard 4: stage must be 'idea'.
	if (entry.stage !== 'idea') {
		return { ok: false, reason: 'wrong-stage' };
	}

	// Guard 5: status must be 'open'.
	if (entry.status !== 'open') {
		return { ok: false, reason: 'not-open' };
	}

	// Mutate in-memory. type is spread in only when present: a payload
	// without type leaves the entry without a type key (no default written).
	const mutated: IssueEntry = {
		...entry,
		spec,
		wsjf,
		blockedBy,
		stage: 'specified',
		...(type !== undefined ? { type } : {}),
	};
	allIssues[entryIndex] = mutated;

	// Guard 6: referential integrity of the post-write backlog.
	const integrity = checkReferentialIntegrity(allIssues);
	if (!integrity.ok) {
		return { ok: false, reason: 'integrity-error', errors: integrity.errors };
	}

	// Serialize only the mutated entry (not the whole backlog).
	const serialized = JSON.stringify(mutated, null, 2) + '\n';
	const filePath = issueFilePath(id);
	const files: FileWrite[] = [{ path: filePath, content: serialized }];

	// Commit to main via the ref-only commit-tree path (always, on-main or off-main).
	// commitTreeToMain derives the tree from `read-tree main` (the real ref), so the
	// working tree is never touched and stale local-index files cannot silently drop
	// prior ref-only writes (see CAM-133 regression test).
	const commitMsg = `chore(cam): specify ${id}`;
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-specify-');

	// Best-effort push.
	pushMainBestEffort(cwd, spawnFn);

	// Emit observability event (side effect of successful commit only).
	emitStagePromoted(cwd, id, clock, options.eventSink);

	return { ok: true, id, committedTo: 'main', sha, branchWasMain };
}

/**
 * Abandon an issue: set status:'abandoned' and commit the CAM-NNNN.json on main.
 *
 * Guards (in order):
 *   0. Up-to-date (detached-head, missing-main, diverged).
 *   1. Target id exists -- not-found on failure.
 *   2. Target status is 'open' -- already-abandoned on failure.
 *
 * Commit message: `chore(cam): abandon <id>`.
 */
export function abandonIssueOnMain(
	options: AbandonIssueOnMainOptions,
): AbandonIssueOnMainOutcome {
	const { cwd, id, spawnFn } = options;

	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { branchWasMain, localMainSha } = guard;

	const allIssues = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));

	const entryIndex = allIssues.findIndex((e: IssueEntry) => e.id === id);
	if (entryIndex === -1) return { ok: false, reason: 'not-found' };
	const entry = allIssues[entryIndex];
	if (entry === undefined) return { ok: false, reason: 'not-found' };
	if (entry.status !== 'open') return { ok: false, reason: 'already-abandoned' };

	const mutated: IssueEntry = { ...entry, status: 'abandoned' };
	const serialized = JSON.stringify(mutated, null, 2) + '\n';
	const filePath = issueFilePath(id);
	const files: FileWrite[] = [{ path: filePath, content: serialized }];

	const commitMsg = `chore(cam): abandon ${id}`;
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-specify-');

	pushMainBestEffort(cwd, spawnFn);
	return { ok: true, id, committedTo: 'main', sha, branchWasMain };
}

/**
 * Merge source.blockedBy into target.blockedBy, excluding self-refs to target.
 * Returns the mutated target IssueEntry (or the original when no deps to fold).
 */
function withMergedBlockedBy(source: IssueEntry, target: IssueEntry): IssueEntry {
	const seen = new Set(target.blockedBy);
	const merged = [...target.blockedBy];
	for (const depId of source.blockedBy) {
		if (depId !== target.id && !seen.has(depId)) {
			merged.push(depId);
			seen.add(depId);
		}
	}
	return { ...target, blockedBy: merged };
}

/**
 * Build the files list for a merge commit.
 * Always includes the mutated source; appends a mutated target when foldBlockedBy
 * is true and the source has deps to contribute.
 */
function buildMergeFiles(
	source: IssueEntry,
	target: IssueEntry,
	note: string,
	foldBlockedBy: boolean,
): FileWrite[] {
	const mutatedSource: IssueEntry = {
		...source,
		status: 'abandoned',
		description: source.description ? `${source.description}\n\n${note}` : note,
	};
	const files: FileWrite[] = [
		{ path: issueFilePath(source.id), content: JSON.stringify(mutatedSource, null, 2) + '\n' },
	];
	if (foldBlockedBy && source.blockedBy.length > 0) {
		const mutatedTarget = withMergedBlockedBy(source, target);
		files.push({
			path: issueFilePath(target.id),
			content: JSON.stringify(mutatedTarget, null, 2) + '\n',
		});
	}
	return files;
}

// ---------------------------------------------------------------------------
// Close mode types (shipped)
// ---------------------------------------------------------------------------

export interface CloseIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Id of the issue to close (set stage:'shipped'). */
	id: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Injectable file writer (retained for interface compat; unused after commitTreeToMain cutover). */
	writeFile?: (path: string, text: string) => void;
}

export interface CloseIssueOnMainResult {
	ok: true;
	id: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

export type CloseIssueOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'already-closed' };

export type CloseIssueOnMainOutcome = CloseIssueOnMainResult | CloseIssueOnMainError;

/**
 * Close an issue by setting stage:'shipped' and committing the CAM-NNNN.json on main.
 *
 * Guards (in order):
 *   0. Up-to-date (detached-head, missing-main, diverged).
 *   1. Target id exists -- not-found on failure (never a silent ok).
 *   2. Target stage is not already 'shipped' -- already-closed on failure.
 *
 * Commit message: `chore(cam): close <id> (shipped)`.
 */
export function closeIssueOnMain(options: CloseIssueOnMainOptions): CloseIssueOnMainOutcome {
	const { cwd, id, spawnFn } = options;

	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { branchWasMain, localMainSha } = guard;

	const allIssues = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));

	const entryIndex = allIssues.findIndex((e: IssueEntry) => e.id === id);
	if (entryIndex === -1) return { ok: false, reason: 'not-found' };
	const entry = allIssues[entryIndex];
	if (entry === undefined) return { ok: false, reason: 'not-found' };
	if (entry.stage === 'shipped') return { ok: false, reason: 'already-closed' };

	const mutated: IssueEntry = { ...entry, stage: 'shipped' };
	const serialized = JSON.stringify(mutated, null, 2) + '\n';
	const filePath = issueFilePath(id);
	const files: FileWrite[] = [{ path: filePath, content: serialized }];

	const commitMsg = `chore(cam): close ${id} (shipped)`;
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-specify-');

	pushMainBestEffort(cwd, spawnFn);
	return { ok: true, id, committedTo: 'main', sha, branchWasMain };
}

// ---------------------------------------------------------------------------
// Demote mode types (specified -> idea)
// ---------------------------------------------------------------------------

export interface DemoteIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Id of the issue to demote (must be stage:'specified'). */
	id: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Injectable file writer (retained for interface compat; unused after commitTreeToMain cutover). */
	writeFile?: (path: string, text: string) => void;
}

export interface DemoteIssueOnMainResult {
	ok: true;
	id: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

export type DemoteIssueOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'already-idea' }
	| { ok: false; reason: 'is-planned' }
	| { ok: false; reason: 'is-shipped' };

export type DemoteIssueOnMainOutcome = DemoteIssueOnMainResult | DemoteIssueOnMainError;

/**
 * Demote an issue from stage:'specified' back to stage:'idea' so a defective
 * spec can be re-grilled through specifyIssueOnMain instead of hand-editing
 * JSON or abandon+refile.
 *
 * Guards (in order):
 *   0. Up-to-date (detached-head, missing-main, diverged).
 *   1. Target id exists -- not-found on failure (never a silent ok).
 *   2. Stage transition guard: only stage:'specified' -> stage:'idea' is allowed.
 *      - stage:'idea'    -> already-idea (nothing to do)
 *      - stage:'planned' -> is-planned (a PRD is in flight; demoting would strand it)
 *      - stage:'shipped' -> is-shipped
 *
 * Mutation flips only entry.stage to 'idea'; the existing (stale) spec, wsjf,
 * blockedBy, and all other fields are preserved unchanged so they remain
 * available as reference for the re-grill.
 *
 * Commit message: `chore(cam): demote <id>`.
 */
export function demoteIssueOnMain(options: DemoteIssueOnMainOptions): DemoteIssueOnMainOutcome {
	const { cwd, id, spawnFn } = options;

	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { branchWasMain, localMainSha } = guard;

	const allIssues = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));

	const entryIndex = allIssues.findIndex((e: IssueEntry) => e.id === id);
	if (entryIndex === -1) return { ok: false, reason: 'not-found' };
	const entry = allIssues[entryIndex];
	if (entry === undefined) return { ok: false, reason: 'not-found' };

	if (entry.stage === 'idea') return { ok: false, reason: 'already-idea' };
	if (entry.stage === 'planned') return { ok: false, reason: 'is-planned' };
	if (entry.stage === 'shipped') return { ok: false, reason: 'is-shipped' };

	const mutated: IssueEntry = { ...entry, stage: 'idea' };
	const serialized = JSON.stringify(mutated, null, 2) + '\n';
	const filePath = issueFilePath(id);
	const files: FileWrite[] = [{ path: filePath, content: serialized }];

	const commitMsg = `chore(cam): demote ${id}`;
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-specify-');

	pushMainBestEffort(cwd, spawnFn);
	return { ok: true, id, committedTo: 'main', sha, branchWasMain };
}

/**
 * Merge a source issue into a target: set source status:'abandoned', record
 * the merge target in source.description, and optionally fold source.blockedBy
 * into target.blockedBy. Committed on main (one atomic commit for all changed files).
 *
 * Guards (in order):
 *   0. Up-to-date (detached-head, missing-main, diverged).
 *   1. id !== intoId -- self-merge on failure.
 *   2. Source id exists -- source-not-found on failure.
 *   3. Target id exists -- target-not-found on failure.
 *   4. Source status is 'open' -- already-abandoned on failure.
 *
 * Commit message: `chore(cam): merge <id> into <intoId>`.
 */
export function mergeIssueOnMain(
	options: MergeIssueOnMainOptions,
): MergeIssueOnMainOutcome {
	const { cwd, id, intoId, spawnFn } = options;
	const foldBlockedBy = options.foldBlockedBy ?? false;

	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { branchWasMain, localMainSha } = guard;

	if (id === intoId) return { ok: false, reason: 'self-merge' };

	const allIssues = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));

	const sourceIndex = allIssues.findIndex((e: IssueEntry) => e.id === id);
	if (sourceIndex === -1) return { ok: false, reason: 'source-not-found' };
	const source = allIssues[sourceIndex];
	if (source === undefined) return { ok: false, reason: 'source-not-found' };

	const targetIndex = allIssues.findIndex((e: IssueEntry) => e.id === intoId);
	if (targetIndex === -1) return { ok: false, reason: 'target-not-found' };
	const target = allIssues[targetIndex];
	if (target === undefined) return { ok: false, reason: 'target-not-found' };

	if (source.status !== 'open') return { ok: false, reason: 'already-abandoned' };

	const note = `Merged into ${intoId}.`;
	const files = buildMergeFiles(source, target, note, foldBlockedBy);

	const commitMsg = `chore(cam): merge ${id} into ${intoId}`;
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-specify-');

	pushMainBestEffort(cwd, spawnFn);
	return { ok: true, id, intoId, committedTo: 'main', sha, branchWasMain };
}
