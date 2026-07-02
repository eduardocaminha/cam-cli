// src/commands/ship-finalize.ts
//
// finalizeCycleClose() -- deterministic cycle-close primitive.
//
// Resolves the target issue id, stashes it into .cam-merge-watch.json so
// the post-merge close path can close the issue without re-reading prd.json,
// then removes per-branch harness state files (prd.json, handoff.json,
// progress.txt) via `git rm -f --ignore-unmatch` and commits the cleanup.
//
// Issue-close (setting stage:'shipped' in the local issues/ file) is NO LONGER
// done here. The close is deferred to closeIssueOnMain (issue-specify.ts),
// which runs on main after the branch merges. This prevents squash-merge from
// clobbering the backlog write.
//
// All external dependencies are injectable so the function is fully
// unit-testable without a real git binary or filesystem.
//
// CAM-72 (deterministic cycle-close), CAM-27 (harness state hygiene),
// CAM-30 (issue-close backend-aware), CAM-90 US-004 (file-per-issue cutover),
// CAM-121 PRD US-004 (defer close to post-merge, stash issueId in merge-watch).

import type { SpawnSyncReturns } from 'node:child_process';
import { parseToml } from '../config/toml.ts';
import { resolveIssueId } from '../issues/resolve-id.ts';
import { printError } from '../logging/color.ts';
import { emitOk } from '../logging/screen.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types
// ---------------------------------------------------------------------------

/**
 * Subset of node:child_process spawnSync we need.
 * Injectable so unit tests never shell out to a real git binary.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8' },
) => SpawnSyncReturns<string>;

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface PrdShape {
	/** Numeric issue number OR full string id (e.g. 'CAM-154'). CAM-113 root: /cam-next may write the full string id. */
	issueNumber?: number | string;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FinalizeCycleCloseOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Read scripts/cam/project.toml as raw text. */
	readProjectToml: () => string;
	/** Read scripts/cam/prd.json as raw text. */
	readPrd: () => string;
	/**
	 * Stash the resolved issue id into .cam-merge-watch.json BEFORE prd.json
	 * is removed, so the post-merge close path can close the issue without
	 * re-reading prd.json.
	 *
	 * Called only when a valid issueId is resolved AND issueSystem === 'none'.
	 * github/linear backends close their own issues via the external system;
	 * stashing for them would cause a spurious closeIssueOnMain 'not-found' error.
	 * Production: stashIssueIdInMergeWatch(join(cwd, '.claude', MERGE_WATCH_FILENAME), issueId).
	 */
	stashFn: (issueId: string) => void;
}

export interface FinalizeCycleCloseResult {
	/** Resolved issue id (e.g. 'CAM-72'), or null when prd.issueNumber was absent. */
	issueId: string | null;
	issueBackend: string;
	commitMessage: string;
	/** true when the function exited cleanly without committing (prd absent, nothing staged). */
	noOp?: boolean;
}

/**
 * Deterministic cycle-close primitive.
 *
 * Steps (in order):
 *   1. Read issue_system + issue_prefix from project.toml.
 *   2. Read issueNumber from prd.json BEFORE removing prd.json.
 *   2a. Resolve issueId via resolveIssueId. Fail loud if issueNumber is
 *       non-null/undefined but unresolvable (never stashes a phantom '<prefix>-0').
 *   3. Call stashFn(issueId) when a valid issueId is available AND
 *       issueSystem === 'none', BEFORE the prd.json git rm, so the
 *       post-merge close path can find it. github/linear skip this step.
 *   4. Remove scripts/cam/prd.json, scripts/cam/handoff.json, and
 *       scripts/cam/progress.txt via `git rm -f --ignore-unmatch`.
 *   5. Commit with: `chore(cam): close <issue-id> + drop per-branch harness
 *       state (CAM-27 hygiene)`.
 *
 * Note: the issue file (scripts/cam/issues/<id>.json) is NEVER read or
 * written here. Issue-close is deferred to closeIssueOnMain (issue-specify.ts)
 * which runs on main after the squash-merge lands.
 */
export function finalizeCycleClose(
	options: FinalizeCycleCloseOptions,
): FinalizeCycleCloseResult {
	const { cwd, spawnFn, readProjectToml, readPrd, stashFn } = options;

	// 1. Read issue_system and issue_prefix from project.toml
	const tomlText = readProjectToml();
	const config = parseToml(tomlText);
	const issueSystem =
		typeof config['issue_system'] === 'string' ? config['issue_system'] : 'none';
	const issuePrefix =
		typeof config['issue_prefix'] === 'string' ? config['issue_prefix'] : 'CAM';

	// 2. Read issueNumber from prd.json BEFORE removing prd.json.
	//    If prd.json is absent (already removed by a prior run), treat as a
	//    clean idempotent no-op rather than crashing.
	let prdText: string;
	try {
		prdText = readPrd();
	} catch (_err) {
		emitOk('cycle already closed: prd.json absent, finalize skipped');
		return {
			issueId: null,
			issueBackend: issueSystem,
			commitMessage: '',
			noOp: true,
		};
	}
	const prd = JSON.parse(prdText) as PrdShape;

	// 2a. Resolve issueId via resolveIssueId (string OR numeric issueNumber).
	//     Fail loud when issueNumber is present but unresolvable -- prevents
	//     stashing a phantom '<prefix>-0' into the merge-watch file.
	const rawIssueNumber = prd.issueNumber;
	const issueId = resolveIssueId(rawIssueNumber, issuePrefix);
	if (rawIssueNumber !== null && rawIssueNumber !== undefined && issueId === null) {
		printError(
			`cannot resolve issueId for issueNumber=${String(rawIssueNumber)}`,
			'check issueNumber in prd.json: must be a positive integer or a well-formed id (e.g. CAM-72)',
		);
		throw new Error(`cannot resolve issueId for issueNumber=${String(rawIssueNumber)}`);
	}

	// 3. Stash the resolved issueId into .cam-merge-watch.json BEFORE git rm,
	//    so the post-merge close path can close the issue without re-reading
	//    prd.json (which will be gone after the rm).
	//    ONLY for the 'none' backend: github and linear close their own issues
	//    via the external system, NOT via closeIssueOnMain on the local store.
	//    Stashing for non-none backends would cause runPostMerge to call
	//    closeIssueOnMain against the none-backend store, producing a spurious
	//    'not-found' error (US-R1-001 fix).
	if (issueId !== null && issueSystem === 'none') {
		stashFn(issueId);
	}

	// 4. Remove per-branch harness state files via git rm -f --ignore-unmatch
	const harnessPaths = [
		'scripts/cam/prd.json',
		'scripts/cam/handoff.json',
		'scripts/cam/progress.txt',
	];
	for (const path of harnessPaths) {
		spawnFn('git', ['-C', cwd, 'rm', '-f', '--ignore-unmatch', path], { encoding: 'utf8' });
	}

	// 4a. Guard: skip commit when nothing is staged.
	//     `git diff --cached --quiet` exits 0 when no staged changes, 1 when staged.
	const diffResult = spawnFn(
		'git',
		['-C', cwd, 'diff', '--cached', '--quiet'],
		{ encoding: 'utf8' },
	);
	if (diffResult.status === 0) {
		emitOk('nothing staged after git rm: commit skipped (already clean)');
		return {
			issueId,
			issueBackend: issueSystem,
			commitMessage: '',
			noOp: true,
		};
	}

	// 5. Commit
	const labelId = issueId ?? `${issuePrefix}-unknown`;
	const commitMessage = `chore(cam): close ${labelId} + drop per-branch harness state (CAM-27 hygiene)`;
	spawnFn('git', ['-C', cwd, 'commit', '-m', commitMessage], { encoding: 'utf8' });

	// 5a. Emit structured result line.
	const shaResult = spawnFn('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
	const commitSha = (shaResult.stdout ?? '').trim() || 'unknown';
	const removedNames = harnessPaths.map((p) => p.split('/').pop() ?? p);
	const backendNote = issueSystem !== 'none' ? ` (issue-close: ${issueSystem})` : '';
	emitOk(`closed ${labelId}${backendNote}: removed ${removedNames.join(', ')}`, `sha ${commitSha}`);

	return {
		issueId,
		issueBackend: issueSystem,
		commitMessage,
	};
}
