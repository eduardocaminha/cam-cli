// test/commands/prune.test.ts
//
// Unit tests for `cam prune` (US-001, CAM-400) — deterministic branch-cleanup
// CLI subcommand. All git/gh calls are injected fakes; no real subprocess is
// ever spawned.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { parsePruneArgs, runPrune, type SpawnFn } from '../../src/commands/prune.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

function failResult(stderr = 'boom'): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', stderr], stdout: '', stderr, status: 1, signal: null };
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

/**
 * Build a recording SpawnFn for git calls. Configurable dirty tree, branch
 * name, and per-verb failure injection. Every call is recorded so tests can
 * assert exact argv shapes and ordering.
 */
function makeGitSpawn(opts: {
	dirty?: boolean;
	branch?: string;
	failOn?: string; // one of: status|branch-show|checkout|pull|branch-delete|fetch
} = {}): { spawnFn: SpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const dirty = opts.dirty ?? false;
	const branch = opts.branch ?? 'cam/issue-400';
	const failOn = opts.failOn;

	const spawnFn: SpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (args.includes('status') && args.includes('--porcelain')) {
			if (failOn === 'status') return failResult();
			return okResult(dirty ? ' M some/file.ts\n' : '');
		}
		if (args.includes('branch') && args.includes('--show-current')) {
			if (failOn === 'branch-show') return failResult();
			return okResult(`${branch}\n`);
		}
		if (args.includes('checkout')) {
			if (failOn === 'checkout') return failResult();
			return okResult();
		}
		if (args.includes('pull')) {
			if (failOn === 'pull') return failResult();
			return okResult();
		}
		if (args.includes('branch') && args.includes('-D')) {
			if (failOn === 'branch-delete') return failResult();
			return okResult();
		}
		if (args.includes('fetch') && args.includes('--prune')) {
			if (failOn === 'fetch') return failResult();
			return okResult();
		}
		return okResult();
	};
	return { spawnFn, calls };
}

/** Build a gh spawnFn that returns a fixed `gh pr view` payload. */
function makeGhSpawn(payload: { state?: string; mergedAt?: string | null; url?: string } | 'not-found' | 'malformed'): {
	ghSpawnFn: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const ghSpawnFn: SpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (payload === 'not-found') return failResult('no pull requests found');
		if (payload === 'malformed') return okResult('not json{{{');
		return okResult(JSON.stringify(payload));
	};
	return { ghSpawnFn, calls };
}

// ---------------------------------------------------------------------------
// parsePruneArgs
// ---------------------------------------------------------------------------

describe('parsePruneArgs', () => {
	test('no args: force false, help false', () => {
		expect(parsePruneArgs([])).toEqual({ force: false, help: false });
	});

	test('--force sets force true', () => {
		expect(parsePruneArgs(['--force'])).toEqual({ force: true, help: false });
	});

	test('--help short-circuits (even with other args present)', () => {
		expect(parsePruneArgs(['--help'])).toEqual({ force: false, help: true });
		expect(parsePruneArgs(['--force', '--help'])).toEqual({ force: false, help: true });
	});

	test('-h short-circuits', () => {
		expect(parsePruneArgs(['-h'])).toEqual({ force: false, help: true });
	});

	test('unrecognized argument returns null', () => {
		expect(parsePruneArgs(['--bogus'])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC1: dirty-tree STOP, main-branch STOP, cam/* happy path (no real shell-out)
// ---------------------------------------------------------------------------

describe('AC1 (US-001): dirty tree / main branch / happy-path git dance', () => {
	test('dirty working tree: nonzero exit, no further git calls beyond status', () => {
		const { spawnFn, calls } = makeGitSpawn({ dirty: true });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn });
		expect(exitCode).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(['-C', '/fake/project', 'status', '--porcelain']);
	});

	test('git status itself failing (non-zero exit): nonzero exit', () => {
		const { spawnFn } = makeGitSpawn({ failOn: 'status' });
		expect(runPrune({ cwd: '/fake/project', spawnFn })).toBe(1);
	});

	test('already on main: nonzero exit, never deletes main', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'main' });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn });
		expect(exitCode).toBe(1);
		expect(calls.some((c) => c.args.includes('-D'))).toBe(false);
	});

	test('already on master: nonzero exit, never deletes master', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'master' });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn });
		expect(exitCode).toBe(1);
		expect(calls.some((c) => c.args.includes('-D'))).toBe(false);
	});

	test('detached HEAD (empty branch name): nonzero exit', () => {
		const { spawnFn } = makeGitSpawn({ branch: '' });
		expect(runPrune({ cwd: '/fake/project', spawnFn })).toBe(1);
	});

	test('cam/* branch, no open PR: full happy-path dance, zero exit', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'cam/issue-400' });
		const { ghSpawnFn } = makeGhSpawn('not-found');
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn });
		expect(exitCode).toBe(0);

		const argvs = calls.map((c) => c.args);
		expect(argvs).toContainEqual(['-C', '/fake/project', 'status', '--porcelain']);
		expect(argvs).toContainEqual(['-C', '/fake/project', 'branch', '--show-current']);
		expect(argvs).toContainEqual(['-C', '/fake/project', 'checkout', 'main']);
		expect(argvs).toContainEqual(['-C', '/fake/project', 'pull', 'origin', 'main']);
		expect(argvs).toContainEqual(['-C', '/fake/project', 'branch', '-D', 'cam/issue-400']);
		expect(argvs).toContainEqual(['-C', '/fake/project', 'fetch', '--prune']);
	});

	test('every git call is driven through the injected spawnFn (no real shell-out surface)', () => {
		// Structural proof: passing a spawnFn that always returns success and
		// recording every invocation demonstrates runPrune never reaches for
		// node:child_process directly -- if it did, the recorded call count
		// below would undercount relative to the happy-path dance (6 calls:
		// status, branch --show-current, checkout, pull, branch -D, fetch).
		const { spawnFn, calls } = makeGitSpawn({ branch: 'cam/issue-400' });
		const { ghSpawnFn } = makeGhSpawn('not-found');
		runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn });
		expect(calls).toHaveLength(6);
	});

	test('checkout failure halts before pull/delete/fetch', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'cam/issue-400', failOn: 'checkout' });
		const { ghSpawnFn } = makeGhSpawn('not-found');
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn });
		expect(exitCode).toBe(1);
		expect(calls.some((c) => c.args.includes('pull'))).toBe(false);
		expect(calls.some((c) => c.args.includes('-D'))).toBe(false);
	});

	test('pull failure halts before delete/fetch', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'cam/issue-400', failOn: 'pull' });
		const { ghSpawnFn } = makeGhSpawn('not-found');
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn });
		expect(exitCode).toBe(1);
		expect(calls.some((c) => c.args.includes('-D'))).toBe(false);
	});

	test('branch -D failure halts before fetch --prune', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'cam/issue-400', failOn: 'branch-delete' });
		const { ghSpawnFn } = makeGhSpawn('not-found');
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn });
		expect(exitCode).toBe(1);
		expect(calls.some((c) => c.args.includes('fetch'))).toBe(false);
	});

	test('fetch --prune failure surfaces as nonzero exit', () => {
		const { spawnFn } = makeGitSpawn({ branch: 'cam/issue-400', failOn: 'fetch' });
		const { ghSpawnFn } = makeGhSpawn('not-found');
		expect(runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn })).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC2: confirmation cases (non-cam/*, open unmerged PR) gated behind --force
// ---------------------------------------------------------------------------

describe('AC2 (US-001): confirmation STOPs and --force bypass', () => {
	test('non-cam/* branch without --force: nonzero exit, no gh call, no mutation', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'feature/not-cam' });
		const { ghSpawnFn, calls: ghCalls } = makeGhSpawn('not-found');
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn });
		expect(exitCode).toBe(1);
		expect(ghCalls).toHaveLength(0);
		expect(calls.some((c) => c.args.includes('checkout'))).toBe(false);
	});

	test('non-cam/* branch WITH --force: proceeds through full dance, zero exit', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'feature/not-cam' });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, force: true });
		expect(exitCode).toBe(0);
		expect(calls.some((c) => c.args.includes('-D'))).toBe(true);
	});

	test('open unmerged PR without --force: nonzero exit, no mutation', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'cam/issue-400' });
		const { ghSpawnFn } = makeGhSpawn({ state: 'OPEN', mergedAt: null, url: 'https://github.com/x/y/pull/1' });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn });
		expect(exitCode).toBe(1);
		expect(calls.some((c) => c.args.includes('checkout'))).toBe(false);
	});

	test('open unmerged PR WITH --force: proceeds through full dance, zero exit, gh never called', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'cam/issue-400' });
		const { ghSpawnFn, calls: ghCalls } = makeGhSpawn({ state: 'OPEN', mergedAt: null, url: 'https://github.com/x/y/pull/1' });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn, force: true });
		expect(exitCode).toBe(0);
		expect(ghCalls).toHaveLength(0);
		expect(calls.some((c) => c.args.includes('-D'))).toBe(true);
	});

	test('merged PR: no confirmation needed, proceeds without --force', () => {
		const { spawnFn } = makeGitSpawn({ branch: 'cam/issue-400' });
		const { ghSpawnFn } = makeGhSpawn({ state: 'MERGED', mergedAt: '2026-07-01T00:00:00Z', url: 'https://github.com/x/y/pull/1' });
		expect(runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn })).toBe(0);
	});

	test('no PR exists (gh exits nonzero): no confirmation needed, proceeds without --force', () => {
		const { spawnFn } = makeGitSpawn({ branch: 'cam/issue-400' });
		const { ghSpawnFn } = makeGhSpawn('not-found');
		expect(runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn })).toBe(0);
	});

	test('malformed gh JSON: treated as no PR-info signal, proceeds without --force', () => {
		const { spawnFn } = makeGitSpawn({ branch: 'cam/issue-400' });
		const { ghSpawnFn } = makeGhSpawn('malformed');
		expect(runPrune({ cwd: '/fake/project', spawnFn, ghSpawnFn })).toBe(0);
	});

	test('--force NEVER bypasses the dirty-tree STOP', () => {
		const { spawnFn, calls } = makeGitSpawn({ dirty: true, branch: 'cam/issue-400' });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, force: true });
		expect(exitCode).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls.some((c) => c.args.includes('checkout'))).toBe(false);
	});

	test('--force NEVER bypasses the main-branch STOP', () => {
		const { spawnFn, calls } = makeGitSpawn({ branch: 'main' });
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn, force: true });
		expect(exitCode).toBe(1);
		expect(calls.some((c) => c.args.includes('-D'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ghSpawnFn defaults to spawnFn when not separately injected
// ---------------------------------------------------------------------------

describe('ghSpawnFn defaulting', () => {
	test('when ghSpawnFn is omitted, the gh call routes through spawnFn', () => {
		const calls: SpawnCall[] = [];
		const spawnFn: SpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args });
			if (args.includes('status') && args.includes('--porcelain')) return okResult('');
			if (args.includes('branch') && args.includes('--show-current')) return okResult('cam/issue-400\n');
			if (cmd === 'gh') return failResult('no pull requests found');
			return okResult();
		};
		const exitCode = runPrune({ cwd: '/fake/project', spawnFn });
		expect(exitCode).toBe(0);
		expect(calls.some((c) => c.cmd === 'gh')).toBe(true);
	});
});
