// test/integration/post-merge-on-main.test.ts
//
// Integration test (REAL git): regression guard for the "must be on main" bug.
//
// Bug (US-R1-002): runPostMerge called `git pull origin main` without first
// checking out main. When called from the feature branch (as the sidecar does
// post-merge), `git pull origin main` merges origin/main INTO the feature
// branch, `git rev-parse HEAD` returns the feature-branch SHA (wrong tagging
// target), the vX.Y.Z tag lands on the feature-branch HEAD instead of main, and
// `git branch -d <feature>` fails because you cannot delete the
// currently-checked-out branch.
//
// Unit fakes cannot catch this class of bug: the fake spawnFn records calls
// and returns success regardless of real git behavior. Only a round-trip
// against a real git repo in a tmpdir proves the checkout + pull sequence is
// correct.
//
// Assertions:
//   1. runPostMerge returns ok:true.
//   2. result.tag is the expected vX.Y.Z string.
//   3. The tag SHA equals the main HEAD SHA (NOT the feature-branch SHA).
//   4. We are on main after the function runs.
//   5. Feature branch was pruned locally (branchPrunedLocal: true).
//
// Mirrors the skip-when-tool-absent pattern from
// test/integration/ship-finalize-dirty-prd.test.ts.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { runPostMerge, type SpawnFn } from '../../src/release/post-merge.ts';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const gitAvailable =
	spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

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
// Real spawnFn
// ---------------------------------------------------------------------------

const realSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_VERSION = '0.1.0';
const VERSION_TS_CONTENT = `export const CAM_VERSION = '${FAKE_VERSION}';\n`;
const FEATURE_BRANCH = 'cam/test-feature';

// ---------------------------------------------------------------------------
// Helper: run a git command in a dir, return stdout
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): SpawnSyncReturns<string> {
	return spawnSync('git', ['-C', dir, ...args], {
		stdio: 'pipe',
		encoding: 'utf8',
	}) as SpawnSyncReturns<string>;
}

// ---------------------------------------------------------------------------
// Test: tag lands on main HEAD, branch pruned (regression guard)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'tag is created on main HEAD (not feature branch HEAD) and feature branch is pruned',
	() => {
		// --- set up origin (bare repo) ---
		const originDir = mkdtempSync(join(tmpdir(), 'cam-pm-origin-'));
		dirsToCleanup.push(originDir);
		git(originDir, ['init', '--bare']);

		// --- set up work repo ---
		const workDir = mkdtempSync(join(tmpdir(), 'cam-pm-work-'));
		dirsToCleanup.push(workDir);
		git(workDir, ['init']);
		git(workDir, ['config', 'user.email', 'test@example.com']);
		git(workDir, ['config', 'user.name', 'Test User']);

		// Commit src/version.ts on the initial branch
		mkdirSync(join(workDir, 'src'), { recursive: true });
		writeFileSync(join(workDir, 'src', 'version.ts'), VERSION_TS_CONTENT);
		git(workDir, ['add', 'src/version.ts']);
		git(workDir, ['commit', '-m', 'chore: add version.ts']);

		// Rename the current branch to main (handles both 'master' and 'main' defaults)
		git(workDir, ['branch', '-m', 'main']);

		// Wire origin and push main
		git(workDir, ['remote', 'add', 'origin', originDir]);
		git(workDir, ['push', '-u', 'origin', 'main']);

		// Capture main HEAD SHA
		const mainSha = git(workDir, ['rev-parse', 'main']).stdout.trim();
		expect(mainSha.length).toBeGreaterThan(0);

		// Create feature branch, add a commit, push to origin
		git(workDir, ['checkout', '-b', FEATURE_BRANCH]);
		writeFileSync(join(workDir, 'src', 'feature.ts'), '// feature work\n');
		git(workDir, ['add', 'src/feature.ts']);
		git(workDir, ['commit', '-m', 'feat: feature work']);
		git(workDir, ['push', '-u', 'origin', FEATURE_BRANCH]);

		// Capture feature HEAD SHA (must differ from main)
		const featureSha = git(workDir, ['rev-parse', 'HEAD']).stdout.trim();
		expect(featureSha).not.toBe(mainSha);

		// Confirm workDir is on the feature branch before the call
		const branchBefore = git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
		expect(branchBefore).toBe(FEATURE_BRANCH);

		// --- run runPostMerge from the feature branch (the real bug scenario) ---
		const result = runPostMerge({
			cwd: workDir,
			mergedBranch: FEATURE_BRANCH,
			spawnFn: realSpawnFn,
		});

		// (1) function must succeed
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// (2) tag value
		expect(result.tag).toBe(`v${FAKE_VERSION}`);
		expect(result.tagCreated).toBe(true);

		// (3) TAG SHA MUST EQUAL main HEAD SHA, not feature SHA
		const tagSha = git(workDir, ['rev-parse', `v${FAKE_VERSION}`]).stdout.trim();
		expect(tagSha).toBe(mainSha);
		expect(tagSha).not.toBe(featureSha);

		// (4) repo must be on main after the function runs
		const branchAfter = git(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
		expect(branchAfter).toBe('main');

		// (5) feature branch must be pruned locally (requires being on main)
		expect(result.branchPrunedLocal).toBe(true);
		const featureList = git(workDir, ['branch', '--list', FEATURE_BRANCH]).stdout.trim();
		expect(featureList).toBe('');
	},
);
