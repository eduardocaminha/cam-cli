// test/integration/finalize-story-real-git.test.ts
//
// Integration test (REAL git): proves the US-003 (ADR 0035) generalization of
// host.ts's finalizeStory against an actual git repo, not an injected fake.
//
// ADR 0035 collapses the pass/incomplete distinction for the passes:true
// flip: finalizeStory is now invoked on BOTH paths, including a 'pass'
// outcome where the worker already wrote passes:true (and committed it)
// itself. That means finalizeStory can be called on a story that is ALREADY
// true with nothing new to stage. `git commit` fails ("nothing to commit,
// working tree clean") in that case; this test proves the real adapter
// treats it as an already-finalized no-op (ok:true), not an error, and does
// NOT create a spurious empty commit.
//
// Skips cleanly when git is absent, mirroring
// test/integration/commit-exists-real-git.test.ts.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSupervisorOptions } from '../../src/supervisor/host.ts';

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

function writePrdJson(dir: string, storyPasses: boolean): void {
	const prdDir = join(dir, 'scripts', 'cam');
	mkdirSync(prdDir, { recursive: true });
	// Serialize IDENTICALLY to host.ts's writePrd (`JSON.stringify(prd, null,
	// 2) + '\n'`): finalizeStory's own idempotent writePrd(prd) call rewrites
	// this file with the same serializer, and the no-op assertion depends on
	// that rewrite producing a byte-for-byte-identical file (zero staged
	// diff). A mismatched serialization here would introduce a spurious
	// trailing-newline diff and mask the behavior under test.
	writeFileSync(
		join(prdDir, 'prd.json'),
		JSON.stringify(
			{
				branchName: 'cam/finalize-test',
				userStories: [
					{
						id: 'US-001',
						title: 'Already flipped by worker',
						priority: 1,
						passes: storyPasses,
					},
				],
			},
			null,
			2,
		) + '\n',
		'utf8',
	);
}

function makeRepoWithWorkerAlreadyFlippedStory(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-finalize-story-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	// Simulate the worker's own commit: prd.json already carries passes:true.
	writePrdJson(dir, true);
	run(['add', '-A']);
	run(['commit', '-m', 'feat: US-001 - Already flipped by worker']);

	return dir;
}

test.skipIf(!gitAvailable)(
	'real host.ts finalizeStory: a story already flipped+committed is a no-op (ok:true, no spurious empty commit)',
	() => {
		const dir = makeRepoWithWorkerAlreadyFlippedStory();

		const headBefore = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
			stdio: 'pipe',
			encoding: 'utf8',
		}).stdout.trim();
		const logCountBefore = spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], {
			stdio: 'pipe',
			encoding: 'utf8',
		}).stdout.trim();

		const { opts } = buildSupervisorOptions(dir);
		expect(opts.finalizeStory).toBeDefined();
		const finalizeStory = opts.finalizeStory as (storyId: string) => { ok: boolean; detail: string };

		const result = finalizeStory('US-001');

		expect(result.ok).toBe(true);
		expect(result.detail).toContain('already finalized');

		const headAfter = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
			stdio: 'pipe',
			encoding: 'utf8',
		}).stdout.trim();
		const logCountAfter = spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], {
			stdio: 'pipe',
			encoding: 'utf8',
		}).stdout.trim();

		// No spurious empty "chore(cam): finalize" commit was created.
		expect(headAfter).toBe(headBefore);
		expect(logCountAfter).toBe(logCountBefore);
	},
);
