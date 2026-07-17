// test/sidecar-resolver-git.test.ts
//
// Real-git coverage for checkoutMainFn / proceedBranchFn (US-001, CAM-324).
//
// Both resolver bodies were migrated from node:child_process's spawnSync
// (`.status ?? 1` + `encoding: 'utf8'`) to Bun.spawnSync (`.exitCode` /
// `.success` + `new TextDecoder().decode(...)`) in this story. Before this
// file, neither body was exercised by a real-git test: only end-to-end tests
// that route through buildGatePhaseDeps + a written gate file existed
// (test/sidecar-gate-phase.test.ts), and none of them named
// makeInProgressConflictResolverDeps / makePlanApprovalResolverDeps or the
// two resolver functions directly. This file constructs the production deps
// factories directly and calls checkoutMainFn / proceedBranchFn against a
// real tmpdir git repo (no injected spawn fake for the git calls themselves),
// so a `.status`->`.exitCode` or Buffer-stdout return-shape regression
// (e.g. always reading exitCode as undefined, or never decoding stdout)
// cannot slip through silently.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { makeInProgressConflictResolverDeps, makePlanApprovalResolverDeps } from '../src/commands/sidecar.ts';
import { makeInMemoryEventLogger, type WorkerEvent } from '../src/supervisor/events.ts';
import type { SpawnFn } from '../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fixtures: real tmpdir git repos + a no-session fake tmux SpawnFn (list-panes
// exits nonzero -> getOrchPaneId returns null -> makeNotifyOrchestrator is a
// silent best-effort no-op; never used for the git calls under test, which
// hit the real `git` binary via Bun.spawnSync inside sidecar.ts).
// ---------------------------------------------------------------------------

const noSessionSpawnFn: SpawnFn = (): SpawnSyncReturns<Buffer> => ({
	pid: 1,
	output: [null, Buffer.from(''), Buffer.from('')],
	stdout: Buffer.from(''),
	stderr: Buffer.from(''),
	status: 1,
	signal: null,
});

const run = (cwd: string, args: string[]) => spawnSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

/** A clean repo with `main` plus a checked-out cam/* branch (clean worktree). */
function setupCleanCamBranchRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-resolver-git-'));
	mkdirSync(join(cwd, 'scripts/cam'), { recursive: true });
	run(cwd, ['init']);
	run(cwd, ['config', 'user.email', 'test@test.com']);
	run(cwd, ['config', 'user.name', 'Test']);
	writeFileSync(join(cwd, 'README.md'), '# test\n', 'utf8');
	run(cwd, ['add', '.']);
	run(cwd, ['commit', '-m', 'init']);
	run(cwd, ['branch', '-M', 'main']);
	run(cwd, ['checkout', '-b', 'cam/issue-777']);
	return cwd;
}

/** A cam/* branch with an uncommitted, tracked-file change that `git checkout
 * main` would clobber -- git refuses the checkout with a non-zero exit,
 * leaving HEAD stuck on the cam/* branch. */
function setupDirtyCamBranchRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-resolver-git-dirty-'));
	mkdirSync(join(cwd, 'scripts/cam'), { recursive: true });
	run(cwd, ['init']);
	run(cwd, ['config', 'user.email', 'test@test.com']);
	run(cwd, ['config', 'user.name', 'Test']);
	writeFileSync(join(cwd, 'conflict.txt'), 'main content\n', 'utf8');
	run(cwd, ['add', '.']);
	run(cwd, ['commit', '-m', 'init']);
	run(cwd, ['branch', '-M', 'main']);
	run(cwd, ['checkout', '-b', 'cam/issue-778']);
	writeFileSync(join(cwd, 'conflict.txt'), 'branch content\n', 'utf8');
	run(cwd, ['add', '.']);
	run(cwd, ['commit', '-m', 'branch change']);
	writeFileSync(join(cwd, 'conflict.txt'), 'dirty uncommitted content\n', 'utf8');
	return cwd;
}

/** A plain repo with an initial commit on `main` (no branch checkout yet). */
function setupInitializedRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-resolver-git-plan-'));
	mkdirSync(join(cwd, 'scripts/cam'), { recursive: true });
	run(cwd, ['init']);
	run(cwd, ['config', 'user.email', 'test@test.com']);
	run(cwd, ['config', 'user.name', 'Test']);
	writeFileSync(join(cwd, 'README.md'), '# test\n', 'utf8');
	run(cwd, ['add', '.']);
	run(cwd, ['commit', '-m', 'init']);
	run(cwd, ['branch', '-M', 'main']);
	return cwd;
}

// ---------------------------------------------------------------------------
// checkoutMainFn (makeInProgressConflictResolverDeps)
// ---------------------------------------------------------------------------

describe('checkoutMainFn (real git, US-001 CAM-324)', () => {
	test('success: HEAD lands on main, checkout exit 0 read via .exitCode, no failure event logged', () => {
		const cwd = setupCleanCamBranchRepo();
		try {
			const { logger: logEvent, events } = makeInMemoryEventLogger();
			const deps = makeInProgressConflictResolverDeps(cwd, 'test-session', noSessionSpawnFn, logEvent);

			deps.checkoutMainFn();

			const branchResult = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
			expect(branchResult.stdout.trim()).toBe('main');

			const failEvents = events.filter((e: WorkerEvent) => e.kind === 'abandon-checkout-main-failed');
			expect(failEvents.length).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('failure: dirty worktree leaves HEAD stuck on the cam/* branch, event names it (decoded via TextDecoder)', () => {
		const cwd = setupDirtyCamBranchRepo();
		try {
			const { logger: logEvent, events } = makeInMemoryEventLogger();
			const deps = makeInProgressConflictResolverDeps(cwd, 'test-session', noSessionSpawnFn, logEvent);

			deps.checkoutMainFn();

			const branchResult = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
			expect(branchResult.stdout.trim()).toBe('cam/issue-778');
			expect(readFileSync(join(cwd, 'conflict.txt'), 'utf8')).toBe('dirty uncommitted content\n');

			const failEvents = events.filter((e: WorkerEvent) => e.kind === 'abandon-checkout-main-failed');
			expect(failEvents.length).toBe(1);
			expect(JSON.stringify(failEvents[0]?.detail ?? {})).toContain('cam/issue-778');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// proceedBranchFn (makePlanApprovalResolverDeps)
// ---------------------------------------------------------------------------

describe('proceedBranchFn (real git, US-001 CAM-324)', () => {
	test('success: returns true, cam/* branch created, prd committed, HEAD readback matches (decoded via TextDecoder)', () => {
		const cwd = setupInitializedRepo();
		try {
			writeFileSync(join(cwd, 'scripts/cam/prd.json'), JSON.stringify({ issueNumber: 555, description: 'Test' }), 'utf8');
			const { logger: logEvent } = makeInMemoryEventLogger();
			const deps = makePlanApprovalResolverDeps(cwd, 'test-session', noSessionSpawnFn, logEvent);

			const ok = deps.proceedBranchFn();

			expect(ok).toBe(true);
			const branchResult = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
			expect(branchResult.stdout.trim()).toBe('cam/issue-555');

			const logResult = spawnSync('git', ['-C', cwd, 'log', '--oneline', '-1'], { encoding: 'utf8' });
			expect(logResult.stdout).toContain('commit audited prd.json');

			const prdRaw = JSON.parse(readFileSync(join(cwd, 'scripts/cam/prd.json'), 'utf8')) as { branchName?: string };
			expect(prdRaw.branchName).toBe('cam/issue-555');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('failure: missing issueNumber returns false, no cam/* branch created, event logged', () => {
		const cwd = setupInitializedRepo();
		try {
			writeFileSync(join(cwd, 'scripts/cam/prd.json'), JSON.stringify({ description: 'Test' }), 'utf8');
			const { logger: logEvent, events } = makeInMemoryEventLogger();
			const deps = makePlanApprovalResolverDeps(cwd, 'test-session', noSessionSpawnFn, logEvent);

			const ok = deps.proceedBranchFn();

			expect(ok).toBe(false);
			const branchResult = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
			expect(branchResult.stdout.trim()).not.toMatch(/^cam\//);

			const failEvents = events.filter((e: WorkerEvent) => e.kind === 'plan-approval-branch-failed');
			expect(failEvents.length).toBe(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

});
