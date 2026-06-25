// src/commands/issue-file.ts
//
// createLocalIssueOnMain() -- append a local issue to
// scripts/cam/issues.local.json directly on main, from any branch.
//
// Design goals:
//   - Id allocation is collision-free: the backlog is read from main via
//     `git show main:scripts/cam/issues.local.json`, never from the working
//     tree (which may be behind or ahead of main on a feature branch).
//   - On-main path: write working-tree file, git add, git commit. Simple.
//   - Off-main path: git plumbing (temp GIT_INDEX_FILE, read-tree, hash-object,
//     update-index, write-tree, commit-tree, update-ref) so the feature-branch
//     HEAD and working tree are left completely untouched.
//   - All external dependencies are injectable for unit-testing without a real
//     git binary or filesystem.
//
// Mirrors src/commands/ship-finalize.ts: same ClockFn type, same injectable-
// reader style, same exported result interface.
//
// CAM-86 (file local issues to main, not the work branch).

import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseToml } from '../config/toml.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types
// ---------------------------------------------------------------------------

/**
 * Widened SpawnFn -- strict superset of ship-finalize's SpawnFn.
 *
 * The extra optional fields (`env`, `input`) are required by the off-main
 * commit-tree path:
 *   - `env`: carries GIT_INDEX_FILE pointing at the temp index used by
 *     read-tree, hash-object, update-index, and write-tree.
 *   - `input`: feeds the updated JSON to `git hash-object -w --stdin`.
 *
 * Injectable so the unit test can verify both fields without shelling out.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
) => SpawnSyncReturns<string>;

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface IssueEntry {
	id: string;
	title: string;
	description?: string;
	state: string;
	createdAt: string;
	priority?: string;
	[key: string]: unknown;
}

interface IssuesLocalJson {
	next_id: number;
	issues: IssueEntry[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateLocalIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Issue title. */
	title: string;
	/** Optional long description. */
	description?: string;
	/** Optional priority (e.g. "P0", "P1"). */
	priority?: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Read scripts/cam/project.toml as raw text. */
	readProjectToml: () => string;
	/**
	 * Injectable file writer (on-main path only).
	 * Defaults to writeFileSync(path, text, 'utf8').
	 */
	writeFile?: (path: string, text: string) => void;
}

export interface CreateLocalIssueOnMainResult {
	id: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a process-env copy augmented with GIT_INDEX_FILE.
 * Filters out undefined values to satisfy `Record<string, string>`.
 */
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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Append a new issue to scripts/cam/issues.local.json on main.
 *
 * Steps (off-main path, the common case):
 *   1. Read issue_prefix from project.toml.
 *   2. Determine current branch via `git rev-parse --abbrev-ref HEAD`.
 *   3. Read the backlog from main via `git show main:scripts/cam/issues.local.json`.
 *   4. Allocate next_id, build the entry, bump next_id.
 *   5. Serialize with JSON.stringify(data, null, 2) + '\n'.
 *   6. Off-main plumbing: temp GIT_INDEX_FILE, read-tree main, hash-object
 *      -w --stdin (fed the JSON via options.input), update-index --add
 *      --cacheinfo, write-tree, commit-tree -p main, update-ref refs/heads/main.
 *   7. Return { id, committedTo: 'main', sha, branchWasMain: false }.
 *
 * On-main path (rare):
 *   - Write working-tree file, git add, git commit.
 *   - Working tree and HEAD both advance (the normal commit path).
 */
export function createLocalIssueOnMain(
	options: CreateLocalIssueOnMainOptions,
): CreateLocalIssueOnMainResult {
	const { cwd, title, description, priority, spawnFn, clock, readProjectToml } = options;
	const writeFile =
		options.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));

	// 1. Read issue_prefix from project.toml.
	const tomlText = readProjectToml();
	const config = parseToml(tomlText);
	const issuePrefix =
		typeof config['issue_prefix'] === 'string' ? config['issue_prefix'] : 'CAM';

	// 2. Determine current branch.
	const branchResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const currentBranch = (branchResult.stdout ?? '').trim();
	const branchWasMain = currentBranch === 'main';

	// 3. Read the backlog from main (NOT the working tree).
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', 'main:scripts/cam/issues.local.json'],
		{ encoding: 'utf8' },
	);
	const backlog = JSON.parse(showResult.stdout) as IssuesLocalJson;

	// 4. Allocate id and build the new entry.
	const nextId = backlog.next_id;
	const id = `${issuePrefix}-${nextId}`;
	const newEntry: IssueEntry = {
		id,
		title,
		state: 'open',
		createdAt: clock(),
		...(description !== undefined ? { description } : {}),
		...(priority !== undefined ? { priority } : {}),
	};
	backlog.next_id = nextId + 1;
	backlog.issues.push(newEntry);

	// 5. Serialize.
	const serialized = JSON.stringify(backlog, null, 2) + '\n';

	const commitMsg = `chore(cam): file ${id} (${title})`;
	let sha: string;

	if (branchWasMain) {
		// On-main path: write working-tree file, git add, git commit.
		const filePath = join(cwd, 'scripts/cam/issues.local.json');
		writeFile(filePath, serialized);
		spawnFn('git', ['-C', cwd, 'add', 'scripts/cam/issues.local.json'], { encoding: 'utf8' });
		spawnFn('git', ['-C', cwd, 'commit', '-m', commitMsg], { encoding: 'utf8' });
		const shaResult = spawnFn(
			'git',
			['-C', cwd, 'rev-parse', '--short', 'HEAD'],
			{ encoding: 'utf8' },
		);
		sha = (shaResult.stdout ?? '').trim();
	} else {
		// Off-main path: git plumbing so the working tree and feature-branch
		// HEAD are left completely untouched.
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-'));
		const tempIndex = join(tmpDir, 'index');

		try {
			// read-tree: populate the temp index with the tree at main.
			spawnFn('git', ['-C', cwd, 'read-tree', 'main'], {
				encoding: 'utf8',
				env: buildIndexEnv(tempIndex),
			});

			// hash-object: write the updated JSON blob to the object store.
			// The JSON is fed via options.input (the widened SpawnFn field).
			const hashResult = spawnFn('git', ['-C', cwd, 'hash-object', '-w', '--stdin'], {
				encoding: 'utf8',
				env: buildIndexEnv(tempIndex),
				input: serialized,
			});
			const blobSha = (hashResult.stdout ?? '').trim();

			// update-index: replace the old blob with the new one in the temp index.
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

			// write-tree: persist the temp index as a tree object.
			const treeResult = spawnFn('git', ['-C', cwd, 'write-tree'], {
				encoding: 'utf8',
				env: buildIndexEnv(tempIndex),
			});
			const treeSha = (treeResult.stdout ?? '').trim();

			// Resolve main's current commit sha.
			const mainShaResult = spawnFn(
				'git',
				['-C', cwd, 'rev-parse', 'main'],
				{ encoding: 'utf8' },
			);
			const mainSha = (mainShaResult.stdout ?? '').trim();

			// commit-tree: create a new commit on top of main.
			const commitResult = spawnFn(
				'git',
				['-C', cwd, 'commit-tree', treeSha, '-p', mainSha, '-m', commitMsg],
				{ encoding: 'utf8' },
			);
			const newCommitSha = (commitResult.stdout ?? '').trim();

			// update-ref: advance refs/heads/main to the new commit.
			spawnFn(
				'git',
				['-C', cwd, 'update-ref', 'refs/heads/main', newCommitSha],
				{ encoding: 'utf8' },
			);

			sha = newCommitSha.substring(0, 7);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	return { id, committedTo: 'main', sha, branchWasMain };
}
