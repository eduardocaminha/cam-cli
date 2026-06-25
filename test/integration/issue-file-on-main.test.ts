// test/integration/issue-file-on-main.test.ts
//
// Integration test (REAL git): regression guard for createLocalIssueOnMain.
//
// Unit fakes for SpawnFn record calls and return success regardless of what
// real git would do; only a round-trip against a real git repo in a tmpdir
// proves the commit-tree-to-main plumbing actually lands the entry on main
// while leaving the feature branch and working tree untouched.
//
// Mirrors test/integration/ship-finalize-dirty-prd.test.ts: skip-when-git-absent,
// mkdtempSync in tmpdir, git init + user config, seed+commit baseline on main,
// run with realSpawnFn wrapping spawnSync, assert with real git show /
// git status --porcelain / git rev-parse.
//
// Two test cases:
//   Case A (off-main): checkout a feature branch, call createLocalIssueOnMain,
//     assert git show main shows the new entry, feature-branch HEAD unchanged,
//     working tree clean.
//   Case B (on-main): call createLocalIssueOnMain while checked out on main,
//     assert a direct commit lands and the working-tree file contains the new entry.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createLocalIssueOnMain,
	type SpawnFn,
} from '../../src/commands/issue-file.ts';

// ---------------------------------------------------------------------------
// Skip guard: mirrors ship-finalize-dirty-prd.test.ts pattern
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

const PROJECT_TOML = 'issue_prefix = "CAM"\nissue_system = "none"\n';
const FIXED_CLOCK = '2026-06-25T12:00:00.000Z';

interface RepoHandles {
	dir: string;
	run: (args: string[]) => ReturnType<typeof spawnSync>;
	camDir: string;
}

/**
 * Create a fresh, isolated git repo in a OS temp dir.
 * Seeds scripts/cam/issues.local.json (with a given next_id) and project.toml
 * on main, then commits them.
 * Registers the dir for cleanup in afterEach.
 */
function makeTmpRepo(initialNextId: number): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-issue-file-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	// Rename the initial branch to 'main' (works before first commit)
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });

	const issuesJson = JSON.stringify({ next_id: initialNextId, issues: [] }, null, 2) + '\n';
	writeFileSync(join(camDir, 'issues.local.json'), issuesJson);
	writeFileSync(join(camDir, 'project.toml'), PROJECT_TOML);

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run, camDir };
}

// ---------------------------------------------------------------------------
// Case A (off-main)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'Case A (off-main): new entry lands on main; feature-branch HEAD and working tree untouched',
	() => {
		const { dir, run, camDir } = makeTmpRepo(10);

		// Capture baseline main SHA
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		// Checkout a feature branch
		run(['checkout', '-b', 'feat/test-issue']);
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('feat/test-issue');

		// Capture feature-branch HEAD before calling the function
		const featureSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = createLocalIssueOnMain({
			cwd: dir,
			title: 'Test integration issue A',
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			readProjectToml: () => PROJECT_TOML,
		});

		// (a) new entry exists on main
		const showResult = run(['show', 'main:scripts/cam/issues.local.json']);
		const mainData = JSON.parse(showResult.stdout as string) as {
			next_id: number;
			issues: Array<{ id: string; title: string }>;
		};
		expect(mainData.next_id).toBe(11);
		expect(mainData.issues).toHaveLength(1);
		const entry = mainData.issues[0];
		expect(entry?.id).toBe('CAM-10');
		expect(entry?.title).toBe('Test integration issue A');

		// (b) result shape
		expect(result.id).toBe('CAM-10');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(false);

		// (c) main advanced by one commit
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (d) feature-branch HEAD is unchanged
		const featureSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureSha1).toBe(featureSha0);

		// (e) working tree is clean
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');

		// (f) working-tree issues.local.json was NOT modified by the off-main path
		const wtContent = readFileSync(join(camDir, 'issues.local.json'), 'utf8');
		const wtData = JSON.parse(wtContent) as { next_id: number; issues: unknown[] };
		expect(wtData.next_id).toBe(10);
		expect(wtData.issues).toHaveLength(0);
	},
);

// ---------------------------------------------------------------------------
// Case B (on-main)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'Case B (on-main): direct commit on main; working-tree file contains the new entry',
	() => {
		const { dir, run, camDir } = makeTmpRepo(20);

		// Confirm we ARE on main
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('main');

		const mainSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = createLocalIssueOnMain({
			cwd: dir,
			title: 'Test integration issue B',
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			readProjectToml: () => PROJECT_TOML,
		});

		// (a) result shape
		expect(result.id).toBe('CAM-20');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(true);

		// (b) main advanced by one commit
		const mainSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (c) HEAD commit message
		const logMsg = run(['log', '-1', '--format=%s']);
		expect((logMsg.stdout as string).trim()).toBe(
			'chore(cam): file CAM-20 (Test integration issue B)',
		);

		// (d) working-tree file contains the new entry
		const wtContent = readFileSync(join(camDir, 'issues.local.json'), 'utf8');
		const wtData = JSON.parse(wtContent) as {
			next_id: number;
			issues: Array<{ id: string; title: string }>;
		};
		expect(wtData.next_id).toBe(21);
		expect(wtData.issues).toHaveLength(1);
		expect(wtData.issues[0]?.id).toBe('CAM-20');
		expect(wtData.issues[0]?.title).toBe('Test integration issue B');

		// (e) working tree is clean after the commit
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');
	},
);
