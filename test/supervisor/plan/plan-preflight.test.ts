// test/supervisor/plan/plan-preflight.test.ts
//
// Unit tests for src/supervisor/plan-preflight.ts (US-004, CAM-117).
//
// Coverage:
//   1.  Happy path: all steps succeed, returns { ok: true }.
//   2.  Happy path: exactly the five required-step calls are made in order.
//   3.  git-checkout-main failure -> { ok: false, step: 'git-checkout-main' }.
//   4.  First-fail-only: no git pull call when checkout fails.
//   5.  git-pull failure -> { ok: false, step: 'git-pull' }.
//   6.  First-fail-only: no later steps when pull fails.
//   7.  clean-tree: non-empty porcelain output -> { ok: false, step: 'clean-tree' }.
//   8.  First-fail-only: no typecheck/bun-test calls when tree is dirty.
//   9.  typecheck failure -> { ok: false, step: 'typecheck' }.
//  10.  First-fail-only: no bun test call when typecheck fails.
//  11.  bun-test failure -> { ok: false, step: 'bun-test' }.
//  12.  Prune step: skipped entirely when ghAvailable=false (no gh calls).
//  13.  Prune step: lists cam/* branches and checks PR status when gh available.
//  14.  Prune step: deletes branch when gh reports a merged PR number.
//  15.  Prune step: best-effort -- for-each-ref failure does not halt pre-flight.
//  16.  Argv shape: git checkout main.
//  17.  Argv shape: git pull origin main.
//  18.  Argv shape: git status --porcelain.
//  19.  Argv shape: bun run typecheck.
//  20.  Argv shape: bun test.
//  21.  Argv shape: gh pr list --head <branch> --state merged --json number --jq .[0].number.
//  22.  US-001 (CAM-363): git-checkout-main/git-pull/typecheck/bun-test detail
//       carries stderr-only content when stdout is empty.
//  23.  US-001 (CAM-363): typecheck/bun-test detail carries content from BOTH
//       streams when both stdout and stderr are non-empty.

import { describe, expect, test } from 'bun:test';
import {
	combineStreams,
	runPlanPreflight,
	type PlanPreflightSpawnFn,
} from '../../../src/supervisor/plan-preflight.ts';
import { truncatePreflightDetail } from '../../../src/supervisor/plan-preflight-marker.ts';

// ---------------------------------------------------------------------------
// combineStreams (US-001, CAM-368) — direct unit tests at the definition point
// ---------------------------------------------------------------------------

describe('combineStreams', () => {
	test('stderr comes first when both streams are non-empty', () => {
		expect(combineStreams('ERRLINE', 'OUTLINE').split('\n')[0]).toBe('ERRLINE');
	});

	test('stdout-only: returns stdout with no leading/trailing newline', () => {
		expect(combineStreams('', 'OUT')).toBe('OUT');
	});

	test('stderr-only: returns stderr with no leading/trailing newline', () => {
		expect(combineStreams('ERR', '')).toBe('ERR');
	});

	test('both streams empty: returns empty string', () => {
		expect(combineStreams('', '')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// truncatePreflightDetail — real function, both-streams-empty contract
// (AC6c, US-003, CAM-368)
// ---------------------------------------------------------------------------

describe('truncatePreflightDetail', () => {
	test('empty detail (both streams empty) renders as empty string, not NO verdict', () => {
		expect(truncatePreflightDetail('')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpawnCall = { bin: string; args: string[] };

/** Creates a fake spawnFn that records calls and returns responses in sequence. */
function makeFakeSpawn(responses: Array<{ exitCode: number; stdout: string; stderr: string }>) {
	const calls: SpawnCall[] = [];
	let idx = 0;
	const fn: PlanPreflightSpawnFn = (bin, args) => {
		calls.push({ bin, args });
		const resp = responses[idx++] ?? { exitCode: 0, stdout: '', stderr: '' };
		return resp;
	};
	return { fn, calls };
}

/**
 * All-pass response sequence for the five required steps, with ghAvailable=false
 * (no prune calls injected).
 */
function allPassResponses(): Array<{ exitCode: number; stdout: string; stderr: string }> {
	return [
		{ exitCode: 0, stdout: '', stderr: '' }, // git checkout main
		{ exitCode: 0, stdout: '', stderr: '' }, // git pull origin main
		{ exitCode: 0, stdout: '', stderr: '' }, // git status --porcelain (empty = clean)
		{ exitCode: 0, stdout: '', stderr: '' }, // bun run typecheck
		{ exitCode: 0, stdout: '', stderr: '' }, // bun test
	];
}

const SAMPLE_CWD = '/tmp/test-repo';

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runPlanPreflight — happy path', () => {
	test('returns { ok: true } when all required steps pass', () => {
		const { fn } = makeFakeSpawn(allPassResponses());
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result).toEqual({ ok: true });
	});

	test('calls all five required steps in order with ghAvailable=false', () => {
		const { fn, calls } = makeFakeSpawn(allPassResponses());
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });

		expect(calls.length).toBe(5);
		expect(calls[0]).toEqual({ bin: 'git', args: ['checkout', 'main'] });
		expect(calls[1]).toEqual({ bin: 'git', args: ['pull', 'origin', 'main'] });
		expect(calls[2]).toEqual({ bin: 'git', args: ['status', '--porcelain'] });
		expect(calls[3]).toEqual({ bin: 'bun', args: ['run', 'typecheck'] });
		expect(calls[4]).toEqual({ bin: 'bun', args: ['test'] });
	});
});

// ---------------------------------------------------------------------------
// Required step failures (discriminated union + first-fail-only)
// ---------------------------------------------------------------------------

describe('runPlanPreflight — git-checkout-main failure', () => {
	test('returns { ok: false, step: "git-checkout-main" } on non-zero exit', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 1, stdout: 'error: pathspec main did not match any file(s)', stderr: '' },
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('git-checkout-main');
			expect(result.detail).toContain('main');
		}
	});

	test('does not call git pull when checkout fails (first-fail-only)', () => {
		const { fn, calls } = makeFakeSpawn([{ exitCode: 1, stdout: '', stderr: '' }]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(calls.length).toBe(1);
		// AC6b (US-003, CAM-368): both streams empty must not swallow the
		// failure -- ok stays false and detail is the empty string, not a
		// fallback/placeholder. This is the original CAM-363 symptom shape:
		// a failing step whose narration renders with NO verdict.
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toBe('');
		}
	});

	test('detail carries stderr-only content when stdout is empty (US-001, CAM-363)', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 1, stdout: '', stderr: "error: pathspec 'main' did not match any file(s) known to git" },
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toContain('pathspec');
		}
	});
});

describe('runPlanPreflight — git-pull failure', () => {
	test('returns { ok: false, step: "git-pull" } on non-zero exit', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout ok
			{ exitCode: 1, stdout: 'fatal: unable to access remote', stderr: '' }, // pull fails
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('git-pull');
		}
	});

	test('does not run later steps when pull fails', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 1, stdout: '', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(calls.length).toBe(2);
	});

	test('detail carries stderr-only content when stdout is empty (US-001, CAM-363)', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout ok
			{ exitCode: 1, stdout: '', stderr: 'fatal: unable to access remote: Could not resolve host' },
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toContain('Could not resolve host');
		}
	});
});

describe('runPlanPreflight — clean-tree failure', () => {
	test('returns { ok: false, step: "clean-tree" } when porcelain output is non-empty', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: ' M src/foo.ts\n?? src/bar.ts\n', stderr: '' }, // dirty tree
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('clean-tree');
			expect(result.detail).toContain('foo.ts');
		}
	});

	test('does not run typecheck or bun test when tree is dirty', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: ' M src/foo.ts\n', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		// Only: checkout, pull, status (3 total); no typecheck or bun test
		expect(calls.length).toBe(3);
		expect(calls[2]).toEqual({ bin: 'git', args: ['status', '--porcelain'] });
	});
});

describe('runPlanPreflight — typecheck failure', () => {
	test('returns { ok: false, step: "typecheck" } on non-zero exit', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // status clean
			{ exitCode: 1, stdout: 'error TS2345: Argument type is not assignable', stderr: '' },
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('typecheck');
		}
	});

	test('does not run bun test when typecheck fails', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 1, stdout: '', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		// checkout, pull, status, typecheck (4); no bun test
		expect(calls.length).toBe(4);
	});

	test('detail carries stderr-only content when stdout is empty (US-001, CAM-363)', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // status clean
			{ exitCode: 1, stdout: '', stderr: 'error TS2345: Argument type is not assignable' },
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toContain('TS2345');
		}
	});

	test('detail carries content from BOTH streams when both are non-empty (US-001, CAM-363)', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // status clean
			{
				exitCode: 1,
				stdout: 'tsc version 5.x banner chatter',
				stderr: 'error TS2345: Argument type is not assignable',
			},
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toContain('TS2345');
			expect(result.detail).toContain('banner chatter');
			// AC7: stderr must come FIRST -- truncatePreflightDetail renders only the
			// first line, so the verdict (stderr) must survive truncation, not the
			// stdout banner chatter.
			expect(result.detail.split('\n')[0]).toContain('TS2345');
			expect(truncatePreflightDetail(result.detail)).toContain('TS2345');
		}
	});
});

describe('runPlanPreflight — bun-test failure', () => {
	test('returns { ok: false, step: "bun-test" } on non-zero exit', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // status clean
			{ exitCode: 0, stdout: '', stderr: '' }, // typecheck
			{ exitCode: 1, stdout: '1 fail / 0 pass', stderr: '' }, // bun test fails
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('bun-test');
			expect(result.detail).toContain('fail');
		}
	});

	test('detail carries stderr-only content when stdout is empty (US-001, CAM-363)', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // status clean
			{ exitCode: 0, stdout: '', stderr: '' }, // typecheck
			{ exitCode: 1, stdout: '', stderr: '2 fail / 5 pass\n' }, // bun-style summary on stderr
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe('bun-test');
			expect(result.detail).toContain('2 fail / 5 pass');
		}
	});

	test('detail carries content from BOTH streams when both are non-empty (US-001, CAM-363)', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: '', stderr: '' }, // status clean
			{ exitCode: 0, stdout: '', stderr: '' }, // typecheck
			{
				exitCode: 1,
				stdout: 'running 40 tests across 12 files',
				stderr: '1 fail / 39 pass',
			},
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toContain('1 fail / 39 pass');
			expect(result.detail).toContain('running 40 tests');
			// AC7: stderr must come FIRST -- truncatePreflightDetail renders only the
			// first line, so the verdict (stderr) must survive truncation, not the
			// stdout progress banner.
			expect(result.detail.split('\n')[0]).toContain('1 fail / 39 pass');
			expect(truncatePreflightDetail(result.detail)).toContain('1 fail / 39 pass');
		}
	});
});

// ---------------------------------------------------------------------------
// Branch prune step (best-effort, step 3)
// ---------------------------------------------------------------------------

describe('runPlanPreflight — branch prune step', () => {
	test('skips all gh calls when ghAvailable=false', () => {
		const { fn, calls } = makeFakeSpawn(allPassResponses());
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		const ghCalls = calls.filter((c) => c.bin === 'gh');
		expect(ghCalls.length).toBe(0);
	});

	test('lists cam/* branches via git for-each-ref when gh is available', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			// prune step: for-each-ref returns one branch (not merged)
			{ exitCode: 0, stdout: 'cam/CAM-001-feature\n', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' }, // gh pr list -> empty (not merged)
			// required steps
			{ exitCode: 0, stdout: '', stderr: '' }, // status
			{ exitCode: 0, stdout: '', stderr: '' }, // typecheck
			{ exitCode: 0, stdout: '', stderr: '' }, // bun test
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: true });
		expect(result).toEqual({ ok: true });

		const forEachRefCall = calls.find(
			(c) => c.bin === 'git' && c.args.includes('for-each-ref'),
		);
		expect(forEachRefCall).toBeDefined();
		expect(forEachRefCall?.args).toContain('refs/heads/cam/');
	});

	test('passes --head <branch> to gh pr list', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: 'cam/CAM-001-feature\n', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' }, // gh pr list -> not merged
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: true });

		const ghCall = calls.find((c) => c.bin === 'gh');
		expect(ghCall?.args).toContain('--head');
		expect(ghCall?.args).toContain('cam/CAM-001-feature');
		expect(ghCall?.args).toContain('--state');
		expect(ghCall?.args).toContain('merged');
	});

	test('calls git branch -D when gh pr list returns a merged PR number', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 0, stdout: 'cam/CAM-001-feature\n', stderr: '' }, // for-each-ref
			{ exitCode: 0, stdout: '42\n', stderr: '' }, // gh pr list -> PR 42 merged
			{ exitCode: 0, stdout: '', stderr: '' }, // git branch -D
			// required steps
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: true });

		const deleteCalls = calls.filter(
			(c) => c.bin === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
		);
		expect(deleteCalls.length).toBe(1);
		expect(deleteCalls[0]?.args).toContain('cam/CAM-001-feature');
	});

	test('does NOT delete branch when gh pr list returns empty (not merged)', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: 'cam/CAM-001-feature\n', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' }, // empty output -> no merged PR
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: true });

		const deleteCalls = calls.filter(
			(c) => c.bin === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
		);
		expect(deleteCalls.length).toBe(0);
	});

	test('prune failure (for-each-ref fails) does NOT halt pre-flight', () => {
		const { fn } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' }, // checkout
			{ exitCode: 0, stdout: '', stderr: '' }, // pull
			{ exitCode: 1, stdout: '', stderr: '' }, // for-each-ref fails -> prune skipped silently
			// required steps
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: true });
		expect(result).toEqual({ ok: true });
	});

	test('prune with no cam/* branches (empty for-each-ref output) still passes', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' }, // for-each-ref returns empty
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
		]);
		const result = runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: true });
		expect(result).toEqual({ ok: true });
		// No gh calls should have been made (no branches to check)
		const ghCalls = calls.filter((c) => c.bin === 'gh');
		expect(ghCalls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Argv shape assertions
// ---------------------------------------------------------------------------

describe('runPlanPreflight — argv shapes', () => {
	test('git checkout main: bin=git args=["checkout","main"]', () => {
		const { fn, calls } = makeFakeSpawn([{ exitCode: 1, stdout: '', stderr: '' }]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(calls[0]).toEqual({ bin: 'git', args: ['checkout', 'main'] });
	});

	test('git pull: bin=git args=["pull","origin","main"]', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 1, stdout: '', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		expect(calls[1]).toEqual({ bin: 'git', args: ['pull', 'origin', 'main'] });
	});

	test('git status: bin=git args=["status","--porcelain"]', () => {
		const { fn, calls } = makeFakeSpawn(allPassResponses());
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		const statusCall = calls.find((c) => c.bin === 'git' && c.args[0] === 'status');
		expect(statusCall?.args).toEqual(['status', '--porcelain']);
	});

	test('typecheck: bin=bun args=["run","typecheck"]', () => {
		const { fn, calls } = makeFakeSpawn(allPassResponses());
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		const tcCall = calls.find((c) => c.bin === 'bun' && c.args.includes('typecheck'));
		expect(tcCall?.args).toEqual(['run', 'typecheck']);
	});

	test('bun test: bin=bun args=["test"]', () => {
		const { fn, calls } = makeFakeSpawn(allPassResponses());
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: false });
		const testCall = calls.find((c) => c.bin === 'bun' && c.args[0] === 'test');
		expect(testCall?.args).toEqual(['test']);
	});

	test('gh pr list: uses --json number --jq .[0].number', () => {
		const { fn, calls } = makeFakeSpawn([
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: 'cam/CAM-005-branch\n', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
			{ exitCode: 0, stdout: '', stderr: '' },
		]);
		runPlanPreflight({ cwd: SAMPLE_CWD, spawnFn: fn, ghAvailable: true });
		const ghCall = calls.find((c) => c.bin === 'gh');
		expect(ghCall?.args).toEqual([
			'pr',
			'list',
			'--head',
			'cam/CAM-005-branch',
			'--state',
			'merged',
			'--json',
			'number',
			'--jq',
			'.[0].number',
		]);
	});
});
