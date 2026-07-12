// test/integration/sync-worktree-on-main.test.ts
//
// Integration test (REAL git): regression guard for syncWorktreeIfOnMain.
//
// This suite proves that commitTreeToMain leaves a clean, HEAD-coherent
// working tree when checked out on main for add/modify/delete cases, and
// leaves a feature-branch working tree byte-identical when off main.
//
// Every on-main case MUST assert `git status --porcelain` is empty.
// This is the exact footgun US-001 (CAM-137) closes: the existing Case B in
// issue-file-on-main.test.ts asserts the entry lands on main but does NOT
// assert porcelain-clean -- this suite fills that gap.
//
// Discrimination invariant:
//   Before US-001 lands, the ADD/MODIFY/DELETE porcelain-clean assertions go
//   RED because commitTreeToMain never touched the working tree.
//   After US-001, every case in this suite is GREEN.
//
// Four test cases:
//   ADD         : new file added on main -- worktree has file + status clean.
//   MODIFY      : tracked file modified on main -- new content + status clean.
//   DELETE      : tracked file removed via removals arg -- absent + status clean.
//   REGRESSION  : off-main write -- feature-branch HEAD+worktree unchanged;
//                 write lands only on refs/heads/main.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitTreeToMain, syncWorktreeIfOnMain, type SpawnFn } from '../../src/git/on-main.ts';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];

afterEach(() => {
	for (const d of dirsToCleanup) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	dirsToCleanup.length = 0;
});

// ---------------------------------------------------------------------------
// realSpawnFn: forwards env (GIT_INDEX_FILE) and input (hash-object --stdin)
// ---------------------------------------------------------------------------

const realSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// makeTmpRepo: fresh git repo checked out on main with a seeded tracked file
// ---------------------------------------------------------------------------

interface RepoHandles {
	dir: string;
	run: (args: string[]) => ReturnType<typeof spawnSync>;
}

/**
 * Create a fresh isolated git repo checked out on main.
 *
 * Seeds one tracked file `seed.txt` with content `original\n` so the MODIFY
 * and DELETE cases have a pre-existing path to operate on.
 * Seeds a subdirectory `sub/` (empty placeholder commit) so mkdirSync is not
 * needed in individual tests.
 */
function makeTmpRepo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-sync-worktree-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	// Seed one tracked file so MODIFY and DELETE cases have a pre-existing path
	writeFileSync(join(dir, 'seed.txt'), 'original\n');
	run(['add', 'seed.txt']);
	run(['commit', '-m', 'chore: initial seed']);

	return { dir, run };
}

// ---------------------------------------------------------------------------
// ADD case
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'ADD: new file exists in worktree with HEAD content and git status --porcelain is empty after commitTreeToMain on main',
	() => {
		const { dir, run } = makeTmpRepo();

		// Confirm on main
		const branch = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branch).toBe('main');

		const localMainSha = (run(['rev-parse', 'main']).stdout as string).trim();

		commitTreeToMain(
			dir,
			[{ path: 'new-file.txt', content: 'hello from add\n' }],
			'test: add new-file.txt',
			localMainSha,
			realSpawnFn,
			'cam-sync-wt-add-',
		);

		// (a) file exists in working tree with HEAD content
		const worktreePath = join(dir, 'new-file.txt');
		expect(existsSync(worktreePath)).toBe(true);
		expect(readFileSync(worktreePath, 'utf8')).toBe('hello from add\n');

		// (b) HEAD contains the new file
		const showResult = run(['show', 'HEAD:new-file.txt']);
		expect((showResult.status as number)).toBe(0);
		expect((showResult.stdout as string)).toBe('hello from add\n');

		// (c) git status --porcelain is empty (load-bearing assertion)
		const status = (run(['status', '--porcelain']).stdout as string).trim();
		expect(status).toBe('');
	},
);

// ---------------------------------------------------------------------------
// MODIFY case
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'MODIFY: working tree shows new content and git status --porcelain is empty after commitTreeToMain on main',
	() => {
		const { dir, run } = makeTmpRepo();

		// Confirm on main
		const branch = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branch).toBe('main');

		const localMainSha = (run(['rev-parse', 'main']).stdout as string).trim();

		commitTreeToMain(
			dir,
			[{ path: 'seed.txt', content: 'modified\n' }],
			'test: modify seed.txt',
			localMainSha,
			realSpawnFn,
			'cam-sync-wt-mod-',
		);

		// (a) working tree reflects the new content
		const worktreePath = join(dir, 'seed.txt');
		expect(readFileSync(worktreePath, 'utf8')).toBe('modified\n');

		// (b) HEAD contains the modified content
		const showResult = run(['show', 'HEAD:seed.txt']);
		expect((showResult.status as number)).toBe(0);
		expect((showResult.stdout as string)).toBe('modified\n');

		// (c) git status --porcelain is empty (load-bearing assertion)
		const status = (run(['status', '--porcelain']).stdout as string).trim();
		expect(status).toBe('');
	},
);

// ---------------------------------------------------------------------------
// DELETE case
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'DELETE: file is absent from worktree and git status --porcelain is empty after commitTreeToMain on main',
	() => {
		const { dir, run } = makeTmpRepo();

		// Confirm on main and that seed.txt exists
		const branch = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branch).toBe('main');
		expect(existsSync(join(dir, 'seed.txt'))).toBe(true);

		const localMainSha = (run(['rev-parse', 'main']).stdout as string).trim();

		// Pass seed.txt in removals with no new files
		commitTreeToMain(
			dir,
			[],
			'test: delete seed.txt',
			localMainSha,
			realSpawnFn,
			'cam-sync-wt-del-',
			['seed.txt'],
		);

		// (a) file is absent from the working tree
		expect(existsSync(join(dir, 'seed.txt'))).toBe(false);

		// (b) HEAD no longer has the file
		const showResult = run(['show', 'HEAD:seed.txt']);
		expect((showResult.status as number)).not.toBe(0);

		// (c) git status --porcelain is empty (load-bearing assertion)
		const status = (run(['status', '--porcelain']).stdout as string).trim();
		expect(status).toBe('');
	},
);

// ---------------------------------------------------------------------------
// DIRECT case (US-001, CAM-140): call syncWorktreeIfOnMain itself, not via
// commitTreeToMain, against a path that is absent from the worktree (staged
// deletion) to prove the helper MATERIALIZES an absent path, not merely
// staged-restores a path already present. Also proves the off-main call is
// inert on the same kind of staged-deletion setup.
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'DIRECT: syncWorktreeIfOnMain materializes an absent-from-worktree path on main, and leaves an off-main worktree untouched',
	() => {
		// --- Phase 1: on-main direct call materializes the absent path ---
		const onMain = makeTmpRepo();

		const branch = (onMain.run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branch).toBe('main');

		// Remove seed.txt from index + worktree (staged deletion); HEAD still has it.
		onMain.run(['rm', 'seed.txt']);
		expect(existsSync(join(onMain.dir, 'seed.txt'))).toBe(false);
		const stagedBefore = (onMain.run(['status', '--porcelain']).stdout as string).trim();
		expect(stagedBefore).not.toBe('');

		// Direct call -- NOT via commitTreeToMain.
		syncWorktreeIfOnMain(onMain.dir, ['seed.txt'], realSpawnFn);

		expect(existsSync(join(onMain.dir, 'seed.txt'))).toBe(true);
		expect(readFileSync(join(onMain.dir, 'seed.txt'), 'utf8')).toBe('original\n');
		const stagedAfter = (onMain.run(['status', '--porcelain']).stdout as string).trim();
		expect(stagedAfter).toBe('');

		// --- Phase 2: off-main direct call leaves the worktree untouched ---
		const offMain = makeTmpRepo();
		offMain.run(['checkout', '-b', 'feat/direct-offmain']);
		offMain.run(['rm', 'seed.txt']);
		expect(existsSync(join(offMain.dir, 'seed.txt'))).toBe(false);
		const offMainStatusBefore = (offMain.run(['status', '--porcelain']).stdout as string).trim();

		syncWorktreeIfOnMain(offMain.dir, ['seed.txt'], realSpawnFn);

		expect(existsSync(join(offMain.dir, 'seed.txt'))).toBe(false);
		const offMainStatusAfter = (offMain.run(['status', '--porcelain']).stdout as string).trim();
		expect(offMainStatusAfter).toBe(offMainStatusBefore);
	},
);

// ---------------------------------------------------------------------------
// REGRESSION (off-main) case
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'REGRESSION (off-main): feature-branch HEAD and worktree unchanged; write lands only on refs/heads/main',
	() => {
		const { dir, run } = makeTmpRepo();

		// Checkout a feature branch before calling commitTreeToMain
		run(['checkout', '-b', 'feat/off-main-regression']);
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('feat/off-main-regression');

		const featureHeadBefore = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		commitTreeToMain(
			dir,
			[{ path: 'main-only.txt', content: 'only on main\n' }],
			'test: off-main add main-only.txt',
			mainSha0,
			realSpawnFn,
			'cam-sync-wt-offmain-',
		);

		// (a) feature-branch HEAD is unchanged
		const featureHeadAfter = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureHeadAfter).toBe(featureHeadBefore);

		// (b) main advanced by exactly one commit
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (c) the write is visible via `git show main:<path>`
		const showResult = run(['show', 'main:main-only.txt']);
		expect((showResult.status as number)).toBe(0);
		expect((showResult.stdout as string)).toBe('only on main\n');

		// (d) the new file does NOT appear in the feature-branch working tree
		expect(existsSync(join(dir, 'main-only.txt'))).toBe(false);

		// (e) working tree is clean on the feature branch
		const status = (run(['status', '--porcelain']).stdout as string).trim();
		expect(status).toBe('');
	},
);
