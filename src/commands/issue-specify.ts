// src/commands/issue-specify.ts
//
// specifyIssueOnMain() -- promote an issue from stage:'idea' to stage:'specified'
// by writing spec, wsjf, and blockedBy directly on main, from any branch.
//
// Design goals (mirrors src/commands/issue-file.ts):
//   - Backlog is read from main via `git show main:scripts/cam/issues.local.json`.
//     Never runs `git checkout` (the working-tree and work branch are untouched).
//   - On-main path: write working-tree file, git add, git commit.
//   - Off-main path: git plumbing (temp GIT_INDEX_FILE, read-tree, hash-object,
//     update-index, write-tree, commit-tree, update-ref).
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
// CAM-107 (US-003 grill spec layer).

import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReferentialIntegrity } from '../issues/graph.ts';
import { validateSpec, validateWsjf } from '../issues/spec.ts';
import type { Spec } from '../issues/spec.ts';
import type { IssueEntry, IssuesLocalJson, WsjfScore } from '../issues/types.ts';
import { printError } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types
// ---------------------------------------------------------------------------

/**
 * Widened SpawnFn -- matches issue-file.ts SpawnFn exactly.
 * The optional `env` and `input` fields are required by the off-main
 * commit-tree path (GIT_INDEX_FILE and hash-object --stdin respectively).
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
) => SpawnSyncReturns<string>;

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

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
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/**
	 * Injectable file writer (on-main path only).
	 * Defaults to writeFileSync(path, text, 'utf8').
	 */
	writeFile?: (path: string, text: string) => void;
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
	| { ok: false; reason: 'integrity-error'; errors: string[] };

export type SpecifyIssueOnMainOutcome =
	| SpecifyIssueOnMainResult
	| SpecifyIssueOnMainError;

// ---------------------------------------------------------------------------
// Private helpers (mirrors issue-file.ts)
// ---------------------------------------------------------------------------

function buildIndexEnv(tempIndex: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) {
			env[k] = v;
		}
	}
	env['GIT_INDEX_FILE'] = tempIndex;
	return env;
}

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

function commitOnMain(
	cwd: string,
	serialized: string,
	commitMsg: string,
	spawnFn: SpawnFn,
	writeFile: (path: string, text: string) => void,
): string {
	const filePath = join(cwd, 'scripts/cam/issues.local.json');
	writeFile(filePath, serialized);
	spawnFn('git', ['-C', cwd, 'add', 'scripts/cam/issues.local.json'], { encoding: 'utf8' });
	spawnFn('git', ['-C', cwd, 'commit', '-m', commitMsg], { encoding: 'utf8' });
	const shaResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--short', 'HEAD'],
		{ encoding: 'utf8' },
	);
	return (shaResult.stdout ?? '').trim();
}

function commitTreeToMain(
	cwd: string,
	serialized: string,
	commitMsg: string,
	localMainSha: string,
	spawnFn: SpawnFn,
): string {
	const tmpDir = mkdtempSync(join(tmpdir(), 'cam-specify-'));
	const tempIndex = join(tmpDir, 'index');

	try {
		spawnFn('git', ['-C', cwd, 'read-tree', 'main'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
		});

		const hashResult = spawnFn('git', ['-C', cwd, 'hash-object', '-w', '--stdin'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
			input: serialized,
		});
		const blobSha = (hashResult.stdout ?? '').trim();

		spawnFn(
			'git',
			[
				'-C',
				cwd,
				'update-index',
				'--add',
				'--cacheinfo',
				`100644,${blobSha},scripts/cam/issues.local.json`,
			],
			{
				encoding: 'utf8',
				env: buildIndexEnv(tempIndex),
			},
		);

		const treeResult = spawnFn('git', ['-C', cwd, 'write-tree'], {
			encoding: 'utf8',
			env: buildIndexEnv(tempIndex),
		});
		const treeSha = (treeResult.stdout ?? '').trim();

		const commitResult = spawnFn(
			'git',
			['-C', cwd, 'commit-tree', treeSha, '-p', localMainSha, '-m', commitMsg],
			{ encoding: 'utf8' },
		);
		const newCommitSha = (commitResult.stdout ?? '').trim();

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
	/** Injectable file writer (on-main path only). */
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
	/** Injectable file writer (on-main path only). */
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
// Private helpers for abandon/merge
// ---------------------------------------------------------------------------

function buildMergeDescription(existing: string | undefined, intoId: string): string {
	const note = `Merged into ${intoId}.`;
	return existing ? `${existing}\n\n${note}` : note;
}

function applyFoldBlockedBy(
	source: IssueEntry,
	target: IssueEntry,
	targetIndex: number,
	backlog: IssuesLocalJson,
): void {
	if (source.blockedBy.length === 0) return;
	const seen = new Set(target.blockedBy);
	const merged = [...target.blockedBy];
	for (const depId of source.blockedBy) {
		if (depId !== target.id && !seen.has(depId)) {
			merged.push(depId);
			seen.add(depId);
		}
	}
	backlog.issues[targetIndex] = { ...target, blockedBy: merged };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Promote an issue from stage:'idea' to stage:'specified' by writing spec,
 * wsjf, and blockedBy directly on main.
 *
 * Guards (in order, before any mutation):
 *   0. Up-to-date guard (detached-head, missing-main, diverged).
 *   1. validateSpec -- invalid-spec error on failure.
 *   2. validateWsjf -- invalid-wsjf error on failure.
 *   3. Target id must exist in the backlog -- not-found on failure.
 *   4. Target issue must be stage:'idea' -- wrong-stage on failure.
 *   5. Target issue must be status:'open' -- not-open on failure.
 *
 * Mutation (in-memory, then committed):
 *   Set entry.spec = spec, entry.wsjf = wsjf,
 *       entry.blockedBy = blockedBy ?? [], entry.stage = 'specified'.
 *
 *   6. checkReferentialIntegrity on the mutated backlog -- integrity-error on failure.
 *
 * Commit path (mirrors createLocalIssueOnMain):
 *   On-main: write working-tree file, git add, git commit.
 *   Off-main: git plumbing (commit-tree-to-main) so the work branch is untouched.
 *
 * Commit message: `chore(cam): specify <id>`.
 */
export function specifyIssueOnMain(
	options: SpecifyIssueOnMainOptions,
): SpecifyIssueOnMainOutcome {
	const { cwd, id, spec, wsjf, spawnFn, clock: _clock } = options;
	const blockedBy = options.blockedBy ?? [];
	const writeFile =
		options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));

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

	// Read backlog from main (never from the working tree).
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/issues.local.json'],
		{ encoding: 'utf8' },
	);
	const backlog = JSON.parse(showResult.stdout) as IssuesLocalJson;

	// Guard 3: target id exists.
	const entryIndex = backlog.issues.findIndex((e: IssueEntry) => e.id === id);
	if (entryIndex === -1) {
		return { ok: false, reason: 'not-found' };
	}

	const entry = backlog.issues[entryIndex];
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

	// Mutate in-memory.
	const mutated: IssueEntry = {
		...entry,
		spec,
		wsjf,
		blockedBy,
		stage: 'specified',
	};
	backlog.issues[entryIndex] = mutated;

	// Guard 6: referential integrity of the post-write backlog.
	const integrity = checkReferentialIntegrity(backlog.issues);
	if (!integrity.ok) {
		return { ok: false, reason: 'integrity-error', errors: integrity.errors };
	}

	// Serialize.
	const serialized = JSON.stringify(backlog, null, 2) + '\n';

	// Commit to main.
	const commitMsg = `chore(cam): specify ${id}`;
	const sha = branchWasMain
		? commitOnMain(cwd, serialized, commitMsg, spawnFn, writeFile)
		: commitTreeToMain(cwd, serialized, commitMsg, localMainSha, spawnFn);

	// Best-effort push.
	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, id, committedTo: 'main', sha, branchWasMain };
}

/**
 * Abandon an issue: set status:'abandoned' and commit on main.
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
	const writeFile =
		options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));

	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { branchWasMain, localMainSha } = guard;

	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/issues.local.json'],
		{ encoding: 'utf8' },
	);
	const backlog = JSON.parse(showResult.stdout) as IssuesLocalJson;

	const entryIndex = backlog.issues.findIndex((e: IssueEntry) => e.id === id);
	if (entryIndex === -1) return { ok: false, reason: 'not-found' };
	const entry = backlog.issues[entryIndex];
	if (entry === undefined) return { ok: false, reason: 'not-found' };
	if (entry.status !== 'open') return { ok: false, reason: 'already-abandoned' };

	backlog.issues[entryIndex] = { ...entry, status: 'abandoned' };

	const serialized = JSON.stringify(backlog, null, 2) + '\n';
	const commitMsg = `chore(cam): abandon ${id}`;
	const sha = branchWasMain
		? commitOnMain(cwd, serialized, commitMsg, spawnFn, writeFile)
		: commitTreeToMain(cwd, serialized, commitMsg, localMainSha, spawnFn);

	pushMainBestEffort(cwd, spawnFn);
	return { ok: true, id, committedTo: 'main', sha, branchWasMain };
}

/**
 * Merge a source issue into a target: set source status:'abandoned', record
 * the merge target in source.description, and optionally fold source.blockedBy
 * into target.blockedBy. Committed on main.
 *
 * Guards (in order):
 *   0. Up-to-date (detached-head, missing-main, diverged).
 *   1. id !== intoId -- self-merge on failure.
 *   2. Source id exists -- source-not-found on failure.
 *   3. Target id exists (checkReferentialIntegrity) -- target-not-found on failure.
 *   4. Source status is 'open' -- already-abandoned on failure.
 *
 * Commit message: `chore(cam): merge <id> into <intoId>`.
 */
export function mergeIssueOnMain(
	options: MergeIssueOnMainOptions,
): MergeIssueOnMainOutcome {
	const { cwd, id, intoId, spawnFn } = options;
	const foldBlockedBy = options.foldBlockedBy ?? false;
	const writeFile =
		options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));

	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) return guard;
	const { branchWasMain, localMainSha } = guard;

	if (id === intoId) return { ok: false, reason: 'self-merge' };

	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/issues.local.json'],
		{ encoding: 'utf8' },
	);
	const backlog = JSON.parse(showResult.stdout) as IssuesLocalJson;

	const sourceIndex = backlog.issues.findIndex((e: IssueEntry) => e.id === id);
	if (sourceIndex === -1) return { ok: false, reason: 'source-not-found' };
	const source = backlog.issues[sourceIndex];
	if (source === undefined) return { ok: false, reason: 'source-not-found' };

	const targetIndex = backlog.issues.findIndex((e: IssueEntry) => e.id === intoId);
	if (targetIndex === -1) return { ok: false, reason: 'target-not-found' };
	const target = backlog.issues[targetIndex];
	if (target === undefined) return { ok: false, reason: 'target-not-found' };

	if (source.status !== 'open') return { ok: false, reason: 'already-abandoned' };

	backlog.issues[sourceIndex] = {
		...source,
		status: 'abandoned',
		description: buildMergeDescription(source.description, intoId),
	};

	if (foldBlockedBy) applyFoldBlockedBy(source, target, targetIndex, backlog);

	const serialized = JSON.stringify(backlog, null, 2) + '\n';
	const commitMsg = `chore(cam): merge ${id} into ${intoId}`;
	const sha = branchWasMain
		? commitOnMain(cwd, serialized, commitMsg, spawnFn, writeFile)
		: commitTreeToMain(cwd, serialized, commitMsg, localMainSha, spawnFn);

	pushMainBestEffort(cwd, spawnFn);
	return { ok: true, id, intoId, committedTo: 'main', sha, branchWasMain };
}
