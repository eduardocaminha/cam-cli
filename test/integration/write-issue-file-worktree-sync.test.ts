// test/integration/write-issue-file-worktree-sync.test.ts
//
// Integration test (REAL git): regression guard for the writeIssueFile
// worktree-sync fix (US-001, CAM-142).
//
// The fix adds syncWorktreeIfOnMain(cwd, [filename], spawnFn) inside the
// if (result.success) block in writeIssueFile (src/issues/alloc.ts).
//
// Without the fix, writing an issue file via CAS update-ref while checked out
// on main advances refs/heads/main but leaves the real index stale: the new
// file is in HEAD but absent from the index, so git reports it as a staged
// deletion ("D  scripts/cam/issues/CAM-NNNN.json").
//
// With the fix, syncWorktreeIfOnMain runs git restore --staged --worktree
// --source=HEAD on the new file, making the index and working tree match HEAD
// so git status --porcelain is empty.
//
// Discrimination invariant:
//   Remove the syncWorktreeIfOnMain call from alloc.ts and this test goes RED
//   (git status --porcelain reports the staged deletion).

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeIssueFile, type WriteIssueFileOptions } from '../../src/issues/alloc.ts';
import type { SpawnFn } from '../../src/git/on-main.ts';
import type { IssueEntry } from '../../src/issues/types.ts';

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
// Helpers
// ---------------------------------------------------------------------------

const FIXED_CLOCK = '2026-06-30T12:00:00.000Z';

function toJson(entry: IssueEntry): string {
	return JSON.stringify(entry, null, 2) + '\n';
}

interface RepoHandles {
	dir: string;
	run: (args: string[]) => ReturnType<typeof spawnSync>;
}

/**
 * Create a fresh, isolated git repo in an OS temp dir, checked out on main.
 *
 * Seeds scripts/cam/issues/ with a seed file CAM-NNNN.json (so that
 * allocateId returns seedId + 1) on main.
 *
 * NOTE: git symbolic-ref HEAD refs/heads/main is required so that
 * syncWorktreeIfOnMain (which checks `git rev-parse --abbrev-ref HEAD`)
 * detects `main` and performs the restore.
 */
function makeTmpRepo(seedId: number): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-wif-sync-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const issuesDir = join(dir, 'scripts', 'cam', 'issues');
	mkdirSync(issuesDir, { recursive: true });

	if (seedId > 0) {
		const seedEntry: IssueEntry = {
			id: `CAM-${seedId}`,
			title: `Seed issue ${seedId}`,
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		};
		const paddedName = `CAM-${String(seedId).padStart(4, '0')}.json`;
		writeFileSync(join(issuesDir, paddedName), toJson(seedEntry));
	}

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run };
}

// ---------------------------------------------------------------------------
// Test: on-main writeIssueFile leaves git status --porcelain empty
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'on-main: writeIssueFile leaves git status --porcelain empty (new file NOT staged-deleted)',
	() => {
		// Seed with CAM-0005 so next id is CAM-6
		const { dir, run } = makeTmpRepo(5);

		// Confirm we are checked out on main
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('main');

		const mainSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const opts: WriteIssueFileOptions = {
			cwd: dir,
			title: 'Sync test issue',
			stage: 'idea',
			status: 'open',
			createdAt: FIXED_CLOCK,
			spawnFn: realSpawnFn,
		};

		const result = writeIssueFile(opts);

		// (a) result shape
		expect(result.id).toBe('CAM-6');
		expect(result.filename).toBe('scripts/cam/issues/CAM-0006.json');

		// (b) main advanced by one commit
		const mainSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (c) per-file entry is visible via git show
		const showResult = run(['show', 'HEAD:scripts/cam/issues/CAM-0006.json']);
		expect((showResult.status as number)).toBe(0);
		const entry = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(entry.id).toBe('CAM-6');
		expect(entry.title).toBe('Sync test issue');

		// (d) LOAD-BEARING: git status --porcelain is empty.
		// Without syncWorktreeIfOnMain, the new file would appear as
		// "D  scripts/cam/issues/CAM-0006.json" (staged deletion) because
		// the CAS update-ref advances HEAD without touching the real index.
		const status = (run(['status', '--porcelain']).stdout as string).trim();
		expect(status).toBe('');
	},
);
