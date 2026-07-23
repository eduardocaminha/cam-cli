// test/commands/next-preflight.test.ts
//
// Unit tests for the deterministic `cam next` preflight (US-003, CAM-400).
//
// Coverage:
//   1.  runNextPreflight happy path: all steps pass, argv shapes in order,
//       branch existing on origin => pull (not push).
//   2.  runNextPreflight: branch absent on origin => push -u (not pull).
//   3.  runNextPreflight: each required-step failure produces the correct
//       discriminated-union `step`, and first-fail-only (no later calls).
//   4.  runNextPreflight: no injected `branch` resolves it via
//       `git rev-parse --abbrev-ref HEAD`.
//   5.  runNext (AC1): a failing preflight returns nonzero AND does NOT
//       write active:true — all via injected deps (no real git/bun spawn).
//   6.  runNext (AC1): a passing preflight proceeds to write active:true.
//   7.  runNext (AC2): `skipPreflight: true` bypasses the preflight entirely
//       (the injected preflightFn is never called) and proceeds straight to
//       the existing write path — the resume escape.
//   8.  parseNextArgs: `--skip-preflight` sets skipPreflight: true; absent by
//       default.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	runNextPreflight,
	type NextPreflightSpawnFn,
} from '../../src/commands/next-preflight.ts';
import { runNext } from '../../src/commands/next.ts';
import { type SpawnFn as TmuxSpawnFn } from '../../src/tmux/session.ts';
import { parseNextArgs } from '../../index.ts';

// ---------------------------------------------------------------------------
// runNextPreflight — fake spawn helper (mirrors
// test/supervisor/plan/plan-preflight.test.ts's makeFakeSpawn)
// ---------------------------------------------------------------------------

type SpawnCall = { bin: string; args: string[] };

function makeFakeSpawn(responses: Array<{ exitCode: number; stdout: string; stderr: string }>) {
	const calls: SpawnCall[] = [];
	let idx = 0;
	const fn: NextPreflightSpawnFn = (bin, args) => {
		calls.push({ bin, args });
		const resp = responses[idx++] ?? { exitCode: 0, stdout: '', stderr: '' };
		return resp;
	};
	return { fn, calls };
}

const SAMPLE_CWD = '/tmp/test-repo';

/** All-pass sequence for a branch that already exists on origin (pull path). */
function allPassPullResponses(): Array<{ exitCode: number; stdout: string; stderr: string }> {
	return [
		{ exitCode: 0, stdout: '', stderr: '' }, // git fetch origin
		{ exitCode: 0, stdout: '', stderr: '' }, // git rev-parse --verify origin/<branch>
		{ exitCode: 0, stdout: '', stderr: '' }, // git pull origin <branch>
		{ exitCode: 0, stdout: '', stderr: '' }, // git status --porcelain (clean)
		{ exitCode: 0, stdout: '', stderr: '' }, // bun run typecheck
		{ exitCode: 0, stdout: '', stderr: '' }, // bun test
	];
}

describe('runNextPreflight — happy path (branch already tracked, pull)', () => {
	test('returns { ok: true } and pulls when origin/<branch> exists', () => {
		const { fn } = makeFakeSpawn(allPassPullResponses());
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result).toEqual({ ok: true });
	});

	test('calls fetch, verify, pull, clean-tree, typecheck, test in order', () => {
		const { fn, calls } = makeFakeSpawn(allPassPullResponses());
		runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });

		expect(calls.length).toBe(6);
		expect(calls[0]).toEqual({ bin: 'git', args: ['fetch', 'origin'] });
		expect(calls[1]).toEqual({ bin: 'git', args: ['rev-parse', '--verify', 'origin/cam/issue-400'] });
		expect(calls[2]).toEqual({ bin: 'git', args: ['pull', 'origin', 'cam/issue-400'] });
		expect(calls[3]).toEqual({ bin: 'git', args: ['status', '--porcelain'] });
		expect(calls[4]).toEqual({ bin: 'bun', args: ['run', 'typecheck'] });
		expect(calls[5]).toEqual({ bin: 'bun', args: ['test'] });
	});

	test('resolves branch via git rev-parse --abbrev-ref HEAD when not injected', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // fetch
			{ exitCode: 0, stdout: 'cam/issue-400\n', stderr: '' }, // rev-parse --abbrev-ref HEAD
			{ exitCode: 0, stdout: '', stderr: '' }, // verify origin/<branch>
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // clean-tree
			{ exitCode: 0, stdout: '', stderr: '' }, // typecheck
			{ exitCode: 0, stdout: '', stderr: '' }, // test
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn });
		expect(result).toEqual({ ok: true });
		expect(calls[1]).toEqual({ bin: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'] });
		expect(calls[2]).toEqual({ bin: 'git', args: ['rev-parse', '--verify', 'origin/cam/issue-400'] });
	});
});

describe('runNextPreflight — branch not yet tracked (push -u path)', () => {
	test('pushes -u instead of pulling when origin/<branch> does not exist', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // fetch
			{ exitCode: 1, stdout: '', stderr: 'fatal: ambiguous argument' }, // verify fails (no remote branch yet)
			{ exitCode: 0, stdout: '', stderr: '' }, // push -u
			{ exitCode: 0, stdout: '', stderr: '' }, // clean-tree
			{ exitCode: 0, stdout: '', stderr: '' }, // typecheck
			{ exitCode: 0, stdout: '', stderr: '' }, // test
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result).toEqual({ ok: true });
		expect(calls[2]).toEqual({ bin: 'git', args: ['push', '-u', 'origin', 'cam/issue-400'] });
		// no pull call anywhere
		expect(calls.some((c) => c.args[0] === 'pull')).toBe(false);
	});

	test('git-push failure halts with step "git-push"', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // fetch
			{ exitCode: 1, stdout: '', stderr: '' }, // verify fails
			{ exitCode: 1, stdout: '', stderr: 'fatal: could not push' }, // push fails
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.step).toBe('git-push');
		expect(calls.length).toBe(3);
	});
});

describe('runNextPreflight — required-step failures (discriminated union + first-fail-only)', () => {
	test('git-fetch failure halts immediately with step "git-fetch"', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 1, stdout: '', stderr: 'fatal: unable to access remote' },
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('git-fetch');
			expect(result.detail).toContain('unable to access remote');
		}
		expect(calls.length).toBe(1);
	});

	test('git-pull failure halts with step "git-pull", no clean-tree/typecheck/test calls', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // fetch
			{ exitCode: 0, stdout: '', stderr: '' }, // verify ok
			{ exitCode: 1, stdout: '', stderr: 'fatal: could not read from remote' }, // pull fails
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.step).toBe('git-pull');
		expect(calls.length).toBe(3);
	});

	test('clean-tree: non-empty porcelain output halts with step "clean-tree" and no typecheck/test calls', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // fetch
			{ exitCode: 0, stdout: '', stderr: '' }, // verify
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: ' M src/commands/next.ts\n', stderr: '' }, // dirty tree
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('clean-tree');
			expect(result.detail).toContain('next.ts');
		}
		expect(calls.length).toBe(4);
	});

	test('typecheck failure halts with step "typecheck", no bun test call', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // fetch
			{ exitCode: 0, stdout: '', stderr: '' }, // verify
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // clean-tree
			{ exitCode: 1, stdout: '', stderr: 'error TS2322: Type mismatch' }, // typecheck fails
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('typecheck');
			expect(result.detail).toContain('TS2322');
		}
		expect(calls.length).toBe(5);
	});

	test('bun-test failure halts with step "bun-test"', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // fetch
			{ exitCode: 0, stdout: '', stderr: '' }, // verify
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // clean-tree
			{ exitCode: 0, stdout: '', stderr: '' }, // typecheck
			{ exitCode: 1, stdout: '1 fail', stderr: '' }, // test fails
		]);
		const result = runNextPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, branch: 'cam/issue-400' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.step).toBe('bun-test');
		expect(calls.length).toBe(6);
	});
});

// ---------------------------------------------------------------------------
// runNext gating (AC1, AC2) — injected fake tmux spawn (never shells out)
// ---------------------------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

/** Fake tmux spawnFn: orchestrator alive, single free pane, pane %0. Mirrors
 * test/next.test.ts's makeFakeTmuxSpawn (kept local + minimal here since this
 * file only needs the "orchestrator alive, sidecar alive" happy path). */
function makeFakeTmuxSpawn(): TmuxSpawnFn & { calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'has-session') return { ...base, status: 0 };
		if (subcommand === 'list-panes') {
			const fIdx = args.indexOf('-F');
			const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
			if (fmt === '#{@cam_label}') return { ...base, stdout: Buffer.from('orchestrator\ndashboard\n') };
			if (fmt === '#{pane_index};#{pane_id}') return { ...base, stdout: Buffer.from('0;%0\n') };
			if (fmt === '#{pane_id}') return { ...base, stdout: Buffer.from('%0\n%1\n') };
			return { ...base, stdout: Buffer.from('') };
		}
		if (subcommand === 'capture-pane') return { ...base, stdout: Buffer.from('> ') };
		return base;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

describe('runNext — deterministic preflight gate (AC1)', () => {
	test('a failing preflight returns nonzero and does NOT write active:true', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-preflight-fail-'));
		try {
			const spawnFn = makeFakeTmuxSpawn();

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: () => true,
				preflightFn: () => ({ ok: false, step: 'clean-tree', detail: 'M dirty-file.ts' }),
			});

			expect(code).toBe(1);
			expect(existsSync(join(dir, '.claude', 'cam-loop.local.md'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a passing preflight proceeds to write active:true', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-preflight-pass-'));
		try {
			const spawnFn = makeFakeTmuxSpawn();
			let preflightCalled = false;

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: () => true,
				preflightFn: () => {
					preflightCalled = true;
					return { ok: true };
				},
			});

			expect(code).toBe(0);
			expect(preflightCalled).toBe(true);
			const content = readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8');
			expect(content).toContain('active: true');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('no real git/bun spawn happens: the injected tmux spawnFn never sees git/bun argv', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-preflight-noshell-'));
		try {
			const spawnFn = makeFakeTmuxSpawn();

			await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: () => true,
				preflightFn: () => ({ ok: true }),
			});

			expect(spawnFn.calls.some((c) => c.cmd === 'git' || c.cmd === 'bun')).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('runNext --skip-preflight (AC2, resume escape)', () => {
	test('skipPreflight:true bypasses the preflight entirely and writes active:true', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-skip-preflight-'));
		try {
			const spawnFn = makeFakeTmuxSpawn();
			let preflightCalled = false;

			const code = await runNext({
				cwd: dir,
				tmuxSpawnFn: spawnFn,
				sidecarAliveFn: () => true,
				skipPreflight: true,
				preflightFn: () => {
					preflightCalled = true;
					return { ok: false, step: 'clean-tree', detail: 'should never run' };
				},
			});

			expect(code).toBe(0);
			expect(preflightCalled).toBe(false);
			const content = readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8');
			expect(content).toContain('active: true');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// parseNextArgs — --skip-preflight flag (AC2)
// ---------------------------------------------------------------------------

describe('parseNextArgs — --skip-preflight', () => {
	test('sets skipPreflight: true when passed', () => {
		const parsed = parseNextArgs(['--skip-preflight']);
		expect(parsed).not.toBeNull();
		expect(parsed?.skipPreflight).toBe(true);
	});

	test('skipPreflight is undefined by default', () => {
		const parsed = parseNextArgs([]);
		expect(parsed).not.toBeNull();
		expect(parsed?.skipPreflight).toBeUndefined();
	});

	test('composes with other flags', () => {
		const parsed = parseNextArgs(['--skip-preflight', '--max-iter', '10']);
		expect(parsed).not.toBeNull();
		expect(parsed?.skipPreflight).toBe(true);
		expect(parsed?.maxIterations).toBe(10);
	});
});
