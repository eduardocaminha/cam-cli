// src/commands/ship-finalize.ts
//
// finalizeCycleClose() -- deterministic cycle-close primitive.
//
// Closes the tracked issue in the configured backend, removes per-branch
// harness state files (prd.json, handoff.json, progress.txt) via
// `git rm -f --ignore-unmatch`, and commits the cleanup.
//
// All external dependencies are injectable so the function is fully
// unit-testable without a real git binary or filesystem.
//
// CAM-72 (deterministic cycle-close), CAM-27 (harness state hygiene),
// CAM-30 (issue-close backend-aware).

import type { SpawnSyncReturns } from 'node:child_process';
import { parseToml } from '../config/toml.ts';
import { printError, printHint } from '../logging/color.ts';

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

interface IssueEntry {
	id: string;
	state: string;
	closedAt?: string;
	[key: string]: unknown;
}

interface IssuesLocalJson {
	next_id: number;
	issues: IssueEntry[];
}

interface PrdShape {
	issueNumber?: number;
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
	/** Read scripts/cam/issues.local.json as raw text. */
	readIssues: () => string;
	/** Write scripts/cam/issues.local.json (receives final serialized text). */
	writeIssues: (text: string) => void;
}

export interface FinalizeCycleCloseResult {
	issueId: string;
	issueBackend: string;
	issueLocalClosed: boolean;
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
 *   3. When issue_system == 'none': find the matching entry in issues.local.json
 *      (id == `${issue_prefix}-${issueNumber}`) and set state='closed' +
 *      closedAt=<ISO timestamp>. For github/linear: skip this step.
 *   4. Remove scripts/cam/prd.json, scripts/cam/handoff.json, and
 *      scripts/cam/progress.txt via `git rm -f --ignore-unmatch` (the -f flag
 *      overrides git's local-modifications guard, resolving both dirty and
 *      missing file cases atomically).
 *   5. Stage scripts/cam/issues.local.json when issue_system == 'none'.
 *   6. Commit with: `chore(cam): close <issue-id> + drop per-branch harness
 *      state (CAM-27 hygiene)`.
 */
export function finalizeCycleClose(
	options: FinalizeCycleCloseOptions,
): FinalizeCycleCloseResult {
	const { cwd, spawnFn, clock, readProjectToml, readPrd, readIssues, writeIssues } = options;

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
		printHint('scripts/cam/prd.json not found; cycle already closed, skipping finalize.');
		return {
			issueId: `${issuePrefix}-0`,
			issueBackend: issueSystem,
			issueLocalClosed: false,
			commitMessage: '',
			noOp: true,
		};
	}
	const prd = JSON.parse(prdText) as PrdShape;
	const issueNumber = typeof prd.issueNumber === 'number' ? prd.issueNumber : null;
	const issueId = issueNumber !== null ? `${issuePrefix}-${issueNumber}` : `${issuePrefix}-0`;

	// 3. Close the issue when issue_system == 'none'
	let issueLocalClosed = false;
	if (issueSystem === 'none' && issueNumber !== null) {
		const issuesText = readIssues();
		const issuesData = JSON.parse(issuesText) as IssuesLocalJson;
		const entry = issuesData.issues.find((i) => i.id === issueId);
		if (entry === undefined) {
			// Hard failure: the issue entry must exist when issue_system == 'none'.
			// A missing entry indicates a misconfigured or mismatched PRD; rm + commit
			// must NOT silently proceed, as that would corrupt the issue log.
			printError(
				`issue not found in issues.local.json: ${issueId}`,
				'add the issue entry or check issue_prefix / issueNumber in project.toml / prd.json',
			);
			throw new Error(`issue not found in issues.local.json: ${issueId}`);
		}
		entry.state = 'closed';
		entry.closedAt = clock();
		issueLocalClosed = true;
		writeIssues(JSON.stringify(issuesData, null, 2) + '\n');
	}
	// For github/linear: skips the issues.local.json edit but still proceeds
	// with git rm + commit below.

	// 4. Remove per-branch harness state files via git rm -f --ignore-unmatch
	const harnessPaths = [
		'scripts/cam/prd.json',
		'scripts/cam/handoff.json',
		'scripts/cam/progress.txt',
	];
	for (const path of harnessPaths) {
		spawnFn('git', ['-C', cwd, 'rm', '-f', '--ignore-unmatch', path], { encoding: 'utf8' });
	}

	// 5. Stage issues.local.json when applicable
	if (issueLocalClosed) {
		spawnFn('git', ['-C', cwd, 'add', 'scripts/cam/issues.local.json'], { encoding: 'utf8' });
	}

	// 5a. Guard: skip commit when nothing is staged.
	//     `git diff --cached --quiet` exits 0 when no staged changes, 1 when staged.
	//     Skipping prevents a "nothing to commit" git error when no harness files
	//     were tracked (e.g., they were never staged, or already removed earlier).
	const diffResult = spawnFn(
		'git',
		['-C', cwd, 'diff', '--cached', '--quiet'],
		{ encoding: 'utf8' },
	);
	if (diffResult.status === 0) {
		printHint('nothing staged after git rm; commit skipped (already clean).');
		return {
			issueId,
			issueBackend: issueSystem,
			issueLocalClosed,
			commitMessage: '',
			noOp: true,
		};
	}

	// 6. Commit
	const commitMessage = `chore(cam): close ${issueId} + drop per-branch harness state (CAM-27 hygiene)`;
	spawnFn('git', ['-C', cwd, 'commit', '-m', commitMessage], { encoding: 'utf8' });

	return {
		issueId,
		issueBackend: issueSystem,
		issueLocalClosed,
		commitMessage,
	};
}
