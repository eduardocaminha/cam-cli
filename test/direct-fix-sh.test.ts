// test/direct-fix-sh.test.ts — direct-lane configurable base ref (2026-08-14)
//
// Origin: in the CAM-566 cycle a CRITICAL review finding could not be fixed
// before ship because its oracle depended on a file that existed only on the
// feature branch, and direct-fix.sh hardcoded origin/main as the only worktree
// base. These tests execute scripts/direct-fix.sh for real (a scratch git repo
// with a local `origin` remote, a fake `claude` on PATH so the final exec is a
// no-op) and assert BEHAVIOR, never script text: a grep for `--base` in the
// script body would not distinguish a correct parse from a present-but-broken
// one, and that distinction has already cost a round in this project.
//
// The scratch layout per test:
//   container/seed        — the "remote": main carries package.json only;
//                           branch `feature` adds base-ref-marker.txt
//   container/repo        — clone of seed (so origin/main and origin/feature
//                           exist), with direct-fix.sh copied into scripts/
//   container/bin/claude  — stub, exits 0, so the script's final exec is inert
//   container/repo-direct-<slug> — where the script materializes its worktree
//
// GATESHIP_TEST_DIRECT_FIX_SH lets a reviewer independently re-run the
// red-against-main sweep: point it at main's direct-fix.sh and the --base and
// loop-guard legs below must fail (the flag does not exist there).

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestTmpdir } from './helpers/test-tmpdir';

const DIRECT_FIX_SCRIPT =
	process.env.GATESHIP_TEST_DIRECT_FIX_SH || join(import.meta.dir, '..', 'scripts', 'direct-fix.sh');

const MARKER = 'base-ref-marker.txt';

let container: string;
let repo: string;
let stubBinDir: string;

function git(cwd: string, ...args: string[]): void {
	const res = Bun.spawnSync(
		['git', '-c', 'user.email=test@test.invalid', '-c', 'user.name=direct-fix-test', ...args],
		{ cwd, stdout: 'pipe', stderr: 'pipe', env: process.env },
	);
	if (res.exitCode !== 0) {
		throw new Error(`test setup: git ${args.join(' ')} failed: ${res.stderr.toString('utf8')}`);
	}
}

/** Number of worktrees git has registered for the scratch repo (1 = primary only). */
function worktreeCount(): number {
	const res = Bun.spawnSync(['git', '-C', repo, 'worktree', 'list', '--porcelain'], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: process.env,
	});
	if (res.exitCode !== 0) {
		throw new Error(`git worktree list failed: ${res.stderr.toString('utf8')}`);
	}
	return res.stdout
		.toString('utf8')
		.split('\n')
		.filter((line) => line.startsWith('worktree ')).length;
}

function worktreePath(slug: string): string {
	// Mirrors the script's own layout: sibling of the primary checkout.
	return join(container, `repo-direct-${slug}`);
}

function removeWorktree(slug: string): void {
	// --force: the script ran bun install, so the worktree has untracked files.
	const res = Bun.spawnSync(['git', '-C', repo, 'worktree', 'remove', '--force', worktreePath(slug)], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: process.env,
	});
	if (res.exitCode !== 0) {
		throw new Error(`worktree remove failed: ${res.stderr.toString('utf8')}`);
	}
}

async function runDirectFix(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['/bin/bash', join(repo, 'scripts', 'direct-fix.sh'), ...args], {
		cwd: container,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, PATH: `${stubBinDir}:${process.env.PATH}` },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

beforeEach(() => {
	container = createTestTmpdir('cam-test-direct-fix-');

	// The "remote": main has only a minimal package.json (so the script's
	// `bun install` is an instant no-dependency install); `feature` adds the
	// marker file that main does not have.
	const seed = join(container, 'seed');
	mkdirSync(seed);
	git(seed, 'init', '-b', 'main');
	writeFileSync(join(seed, 'package.json'), '{"name":"direct-fix-scratch","private":true}\n');
	git(seed, 'add', '.');
	git(seed, 'commit', '-m', 'main: package.json');
	git(seed, 'checkout', '-b', 'feature');
	writeFileSync(join(seed, MARKER), 'only on feature\n');
	git(seed, 'add', '.');
	git(seed, 'commit', '-m', 'feature: marker');
	git(seed, 'checkout', 'main');

	// The primary checkout the operator would run the script from.
	repo = join(container, 'repo');
	git(container, 'clone', '--quiet', seed, repo);
	mkdirSync(join(repo, 'scripts'));
	copyFileSync(DIRECT_FIX_SCRIPT, join(repo, 'scripts', 'direct-fix.sh'));
	chmodSync(join(repo, 'scripts', 'direct-fix.sh'), 0o755);

	// Stub claude: the script ends with `exec claude ...`; this makes it a no-op.
	stubBinDir = join(container, 'bin');
	mkdirSync(stubBinDir);
	writeFileSync(join(stubBinDir, 'claude'), '#!/usr/bin/env bash\nexit 0\n');
	chmodSync(join(stubBinDir, 'claude'), 0o755);
});

afterEach(() => {
	// Leftover-worktree tripwire: every test must remove the worktree it
	// created; a count above 1 (the primary checkout) fails the test here.
	expect(worktreeCount()).toBe(1);
	rmSync(container, { recursive: true, force: true });
});

test(
	'--base origin/feature: the created worktree contains the marker absent on main (base respected)',
	async () => {
		const { exitCode, stderr } = await runDirectFix(['base-case', 'task text', '--base', 'origin/feature']);
		expect(exitCode).toBe(0);
		if (exitCode !== 0) throw new Error(`direct-fix.sh failed: ${stderr}`);
		expect(existsSync(join(worktreePath('base-case'), MARKER))).toBe(true);
		removeWorktree('base-case');
	},
	{ timeout: 60_000 },
);

test(
	'no flag: the worktree is created from origin/main and does not contain the marker (default unchanged)',
	async () => {
		const { exitCode } = await runDirectFix(['default-case', 'task text']);
		expect(exitCode).toBe(0);
		// Prove the worktree really materialized (marker absence alone would be
		// trivially true for a missing worktree), then prove the base was main.
		expect(existsSync(join(worktreePath('default-case'), 'package.json'))).toBe(true);
		expect(existsSync(join(worktreePath('default-case'), MARKER))).toBe(false);
		removeWorktree('default-case');
	},
	{ timeout: 60_000 },
);

test(
	'loop active + --base other than origin/main: refuses with non-zero exit and creates no worktree',
	async () => {
		// active: true in the PRIMARY checkout's state file, the frontmatter
		// shape renderStateFile actually writes (vendor/cam-loop.local.md.tmpl).
		mkdirSync(join(repo, '.claude'));
		writeFileSync(
			join(repo, '.claude', 'cam-loop.local.md'),
			'---\nactive: true\nphase: implementing\n---\n\nloop prompt body\n',
		);

		const { exitCode, stderr } = await runDirectFix(['guarded-case', 'task text', '--base', 'origin/feature']);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain('active');
		expect(existsSync(worktreePath('guarded-case'))).toBe(false);
		expect(worktreeCount()).toBe(1);
	},
	{ timeout: 60_000 },
);
