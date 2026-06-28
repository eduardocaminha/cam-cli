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
// CAM-30 (issue-close backend-aware), CAM-90 US-004 (file-per-issue cutover).

import type { SpawnSyncReturns } from 'node:child_process';
import { parseToml } from '../config/toml.ts';
import type { IssueEntry } from '../issues/types.ts';
import { issueFilePath } from '../issues/backlog.ts';
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
	/**
	 * Read the per-issue JSON file for the given issueId.
	 * Production: readFileSync(join(cwd, issueFilePath(issueId)), 'utf8').
	 * @param issueId  The canonical issue id (e.g. 'CAM-72').
	 */
	readIssues: (issueId: string) => string;
	/**
	 * Write the per-issue JSON file for the given issueId.
	 * Production: writeFileSync(join(cwd, issueFilePath(issueId)), text, 'utf8').
	 * @param issueId  The canonical issue id (e.g. 'CAM-72').
	 * @param text     Serialized IssueEntry JSON.
	 */
	writeIssues: (issueId: string, text: string) => void;
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
 *   3. When issue_system == 'none': read the matching CAM-NNNN.json via
 *      readIssues(issueId) and set stage='shipped'. For github/linear: skip.
 *   4. Remove scripts/cam/prd.json, scripts/cam/handoff.json, and
 *      scripts/cam/progress.txt via `git rm -f --ignore-unmatch`.
 *   5. Stage scripts/cam/issues/CAM-NNNN.json when issue_system == 'none'.
 *   6. Commit with: `chore(cam): close <issue-id> + drop per-branch harness
 *      state (CAM-27 hygiene)`.
 */
export function finalizeCycleClose(
	options: FinalizeCycleCloseOptions,
): FinalizeCycleCloseResult {
	const { cwd, spawnFn, readProjectToml, readPrd, readIssues, writeIssues } = options;

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
		let issueText: string;
		try {
			issueText = readIssues(issueId);
		} catch (_err) {
			// Hard failure: the issue file must exist when issue_system == 'none'.
			printError(
				`issue not found in issues dir: ${issueId}`,
				'add the issue file or check issue_prefix / issueNumber in project.toml / prd.json',
			);
			throw new Error(`issue not found in issues dir: ${issueId}`);
		}
		const entry = JSON.parse(issueText) as IssueEntry;
		entry.stage = 'shipped';
		issueLocalClosed = true;
		writeIssues(issueId, JSON.stringify(entry, null, 2) + '\n');
	}
	// For github/linear: skips the issue file edit but still proceeds
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

	// 5. Stage the per-issue file when applicable
	if (issueLocalClosed) {
		spawnFn('git', ['-C', cwd, 'add', issueFilePath(issueId)], { encoding: 'utf8' });
	}

	// 5a. Guard: skip commit when nothing is staged.
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
			issueLocalClosed,
			commitMessage: '',
			noOp: true,
		};
	}

	// 6. Commit
	const commitMessage = `chore(cam): close ${issueId} + drop per-branch harness state (CAM-27 hygiene)`;
	spawnFn('git', ['-C', cwd, 'commit', '-m', commitMessage], { encoding: 'utf8' });

	// 6a. Emit structured result line.
	const shaResult = spawnFn('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
	const commitSha = (shaResult.stdout ?? '').trim() || 'unknown';
	const removedNames = harnessPaths.map((p) => p.split('/').pop() ?? p);
	const backendNote = issueSystem !== 'none' ? ` (issue-close: ${issueSystem})` : '';
	emitOk(`closed ${issueId}${backendNote}: removed ${removedNames.join(', ')}`, `sha ${commitSha}`);

	return {
		issueId,
		issueBackend: issueSystem,
		issueLocalClosed,
		commitMessage,
	};
}
