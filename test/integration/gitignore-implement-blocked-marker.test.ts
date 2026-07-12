// test/integration/gitignore-implement-blocked-marker.test.ts
//
// Regression test (US-001, CAM-282): proves the root .gitignore entry for
// .claude/.cam-implement-blocked.json actually suppresses the marker from
// `git status --porcelain` in a REAL git repo. Prior to this story the
// marker was the only durable marker missing a .gitignore entry, so its mere
// presence on disk registered as untracked dirt and tripped the clean-tree
// step of runPlanPreflight (src/supervisor/plan-preflight.ts:91-97), wedging
// the next plan dispatch.
//
// Mirrors the real-git integration pattern established in
// test/integration/commit-exists-real-git.test.ts: mkdtempSync a fresh repo,
// git init, copy in the project's actual .gitignore content, touch the
// marker file, and assert `git status --porcelain` is empty. This is
// deliberately NOT a spawnFn-fake unit test: a fake would just echo back
// whatever exit code it's told to return and would never exercise the real
// gitignore semantics.
//
// Skips cleanly when git is absent, same guard as the sibling real-git tests.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

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

function makeTmpRepoWithProjectGitignore(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-gitignore-implement-blocked-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	// Copy in the REAL project .gitignore (the file this story edits), not a
	// hand-authored stub, so the test tracks whatever entry actually ships.
	copyFileSync(join(import.meta.dir, '..', '..', '.gitignore'), join(dir, '.gitignore'));
	run(['add', '.gitignore']);
	run(['commit', '-m', 'initial commit']);

	return dir;
}

test.skipIf(!gitAvailable)(
	'an orphaned .claude/.cam-implement-blocked.json does not surface in git status --porcelain',
	() => {
		const dir = makeTmpRepoWithProjectGitignore();

		// Sanity: the entry is actually present in the copied .gitignore.
		const gitignoreContent = readFileSync(join(dir, '.gitignore'), 'utf8');
		expect(gitignoreContent).toContain('.claude/.cam-implement-blocked.json');

		mkdirSync(join(dir, '.claude'), { recursive: true });
		writeFileSync(
			join(dir, '.claude', '.cam-implement-blocked.json'),
			JSON.stringify({ storyId: 'US-999', keyHash: 'deadbeef', consecutiveCount: 1 }),
		);

		const status = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'pipe', encoding: 'utf8' });
		expect(status.stdout.trim()).toBe('');
	},
);
