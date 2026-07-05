// test/integration/commit-exists-real-git.test.ts
//
// Integration test (REAL git): closes the gap flagged by review round 1
// finding US-R1-003 (CAM-187).
//
// Prior to this test, the loop.test.ts / result.test.ts suites only exercised
// commitExistsForStory via an INJECTED FAKE, so no test ever ran the real
// host.ts adapter (buildSupervisorOptions(cwd).opts.commitExistsForStory)
// against an actual git log. That gap meant two upstream defects could have
// silently regressed without any test going red:
//
//   (a) US-R1-001: commitSubjectMatchesStory rejecting the real bracketed
//       'feat: [US-001] - Title' commit convention (only the bracketless
//       'feat: US-001 - Title' form was covered).
//   (b) US-R1-002: commitExistsForStory scoping `git log` to this branch's
//       own commits (`origin/main..HEAD` / `main..HEAD`) instead of walking
//       the entire ancestry back to the root commit, which would let an
//       unrelated ancient commit from a past PRD (story ids are reused every
//       PRD) falsely satisfy the gate.
//
// This test proves both fixes together, end to end, through the real adapter:
// a repo with an ancient bracketless commit for US-001 on `main` (pre-fork),
// and a bracketed commit for US-002 made only on the feature branch after the
// fork. commitExistsForStory('US-002') must find the bracketed commit;
// commitExistsForStory('US-001') must NOT match the ancient pre-fork commit,
// because it is excluded by the `main..HEAD` branch-scoping.
//
// Skips cleanly when git is absent, mirroring the pattern established in
// test/integration/tmux-introspect.test.ts / ship-finalize-dirty-prd.test.ts.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSupervisorOptions } from '../../src/supervisor/host.ts';

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
// Helper: build a repo with an ancient pre-fork commit on main, then a
// feature branch forked from main carrying a bracketed story commit.
//
// NOTE: `git symbolic-ref HEAD refs/heads/main` (same pattern as
// write-issue-file-worktree-sync.test.ts) pins the default branch name to
// `main` regardless of the local git config's init.defaultBranch, since
// commitExistsForStory's fallback range is literally `main..HEAD`.
// ---------------------------------------------------------------------------

function makeTmpRepoWithForkedBranch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-commit-exists-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	// Ancient commit on main, BEFORE the branch fork, using the bracketless
	// convention. Its story id (US-001) is deliberately reused by a later PRD
	// to prove the branch-scoping fix (US-R1-002) excludes it.
	run(['commit', '--allow-empty', '-m', 'feat: US-001 - Ancient unrelated story from a prior PRD']);

	// Fork the feature branch from main.
	run(['checkout', '-b', 'cam/pr-187-test-branch']);

	// The ONLY commit unique to the feature branch: bracketed convention,
	// different story id.
	run(['commit', '--allow-empty', '-m', 'feat: [US-002] - Add new feature']);

	return dir;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'real host.ts commitExistsForStory: matches a bracketed branch-local commit, ignores an ancient pre-fork commit',
	() => {
		const dir = makeTmpRepoWithForkedBranch();

		const { opts } = buildSupervisorOptions(dir);
		expect(opts.commitExistsForStory).toBeDefined();
		const commitExistsForStory = opts.commitExistsForStory as (storyId: string) => boolean;

		// (a) US-R1-001 + US-R1-002 combined: the bracketed commit made ONLY on
		// this branch is found.
		expect(commitExistsForStory('US-002')).toBe(true);

		// (b) US-R1-002: the ancient pre-fork commit (on main, before the branch
		// existed) must NOT satisfy the gate for its story id, even though its
		// subject textually matches the bracketless convention.
		expect(commitExistsForStory('US-001')).toBe(false);
	},
);
