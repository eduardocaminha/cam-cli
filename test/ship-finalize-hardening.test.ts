// test/ship-finalize-hardening.test.ts
//
// Failure-mode hardening + idempotency tests for finalizeCycleClose().
// Oracle: bun test test/ship-finalize-hardening.test.ts
//
// Coverage (updated for US-004 acceptance criteria):
//   AC1: issue-writer seam removed from options; git add for issues/ never occurs.
//   AC2: prd.json absent (readPrd throws)
//        => clean no-op (noOp: true), no commit, exit 0.
//   AC3: nothing staged after git rm
//        => commit step is skipped (noOp: true, no commit call), exit 0.
//   AC4: second invocation after a successful first run
//        => clean no-op (same as AC2: prd.json removed by first run).
//   NEW: unresolvable-but-present issueNumber throws and never stashes.

import { describe, expect, test } from 'bun:test';
import {
	finalizeCycleClose,
	type FinalizeCycleCloseOptions,
	type SpawnFn,
} from '../src/commands/ship-finalize.ts';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_TOML_NONE = 'issue_system = "local"\nissue_prefix = "CAM"\n';
const PROJECT_TOML_GITHUB = 'issue_system = "github"\nissue_prefix = "CAM"\n';

/** prd.json referencing issue CAM-72 (numeric). */
const PRD_JSON = JSON.stringify({ issueNumber: 72, branchName: 'cam/CAM-72-test' });

/** Minimal passing SpawnSyncReturns<string>. */
function okResult(status = 0): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', ''], stdout: '', stderr: '', status, signal: null };
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

/**
 * Recording SpawnFn.
 *
 * diffCachedStatus controls the `git diff --cached --quiet` return value:
 *   1 (default) = staged changes present => commit proceeds
 *   0            = no staged changes      => commit is skipped (noOp guard)
 */
function makeRecordingSpawn(opts: { diffCachedStatus?: number } = {}): {
	spawnFn: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const diffStatus = opts.diffCachedStatus ?? 1;
	const spawnFn: SpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (args.includes('diff') && args.includes('--cached') && args.includes('--quiet')) {
			return okResult(diffStatus);
		}
		return okResult(0);
	};
	return { spawnFn, calls };
}

/** Base options -- override per test. */
function makeOptions(
	overrides: Partial<FinalizeCycleCloseOptions> & { spawnFn: SpawnFn },
): FinalizeCycleCloseOptions {
	return {
		cwd: '/fake/project',
		readProjectToml: () => PROJECT_TOML_NONE,
		readPrd: () => PRD_JSON,
		stashFn: () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC1 (US-004): issue-writer seam absent -- no git add for issues/ ever
// ---------------------------------------------------------------------------

describe('AC1 (US-004): no git add for any issues/ path in any backend', () => {
	test('local backend: no git add for scripts/cam/issues/ path', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(makeOptions({ spawnFn }));

		const addIssuesCall = calls.find(
			(c) => c.args.includes('add') && c.args.some((a) => a.includes('scripts/cam/issues/')),
		);
		expect(addIssuesCall).toBeUndefined();
	});

	test('github backend: no git add for scripts/cam/issues/ path', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(makeOptions({ spawnFn, readProjectToml: () => PROJECT_TOML_GITHUB }));

		const addIssuesCall = calls.find(
			(c) => c.args.includes('add') && c.args.some((a) => a.includes('scripts/cam/issues/')),
		);
		expect(addIssuesCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC2: prd.json absent => idempotent no-op, exit 0, no commit
// ---------------------------------------------------------------------------

describe('AC2: prd.json absent (cycle already closed)', () => {
	test('returns noOp: true when readPrd throws', () => {
		const { spawnFn } = makeRecordingSpawn();

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => {
					throw new Error("ENOENT: no such file or directory, open 'scripts/cam/prd.json'");
				},
			}),
		);

		expect(result.noOp).toBe(true);
	});

	test('no git commit call when prd.json is absent', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => {
					throw new Error('ENOENT');
				},
			}),
		);

		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeUndefined();
	});

	test('no git rm call when prd.json is absent', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => {
					throw new Error('ENOENT');
				},
			}),
		);

		const rmCall = calls.find((c) => c.args.includes('rm'));
		expect(rmCall).toBeUndefined();
	});

	test('stashFn not called when prd.json is absent', () => {
		const { spawnFn } = makeRecordingSpawn();
		const stashedIds: string[] = [];

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => { throw new Error('ENOENT'); },
				stashFn: (id) => stashedIds.push(id),
			}),
		);

		expect(stashedIds).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC3: nothing staged after git rm => commit step skipped, exit 0
// ---------------------------------------------------------------------------

describe('AC3: nothing staged after git rm (files not tracked)', () => {
	test('returns noOp: true when git diff --cached --quiet exits 0', () => {
		const { spawnFn } = makeRecordingSpawn({ diffCachedStatus: 0 });

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB,
			}),
		);

		expect(result.noOp).toBe(true);
	});

	test('no git commit call when nothing is staged', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ diffCachedStatus: 0 });

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB,
			}),
		);

		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeUndefined();
	});

	test('git diff --cached --quiet IS called before the commit guard', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ diffCachedStatus: 0 });

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB,
			}),
		);

		const diffCall = calls.find(
			(c) => c.args.includes('diff') && c.args.includes('--cached') && c.args.includes('--quiet'),
		);
		expect(diffCall).toBeDefined();
	});

	test('commit DOES proceed when git diff --cached --quiet exits 1 (staged changes)', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ diffCachedStatus: 1 });

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB,
			}),
		);

		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// AC4: second invocation after a successful first run => clean no-op
// ---------------------------------------------------------------------------

describe('AC4: second invocation after successful first run (prd.json already removed)', () => {
	test('second call returns noOp: true (prd.json removed by first run)', () => {
		const { spawnFn } = makeRecordingSpawn();

		const secondResult = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => {
					throw new Error('ENOENT: file already removed by first run');
				},
			}),
		);

		expect(secondResult.noOp).toBe(true);
	});

	test('second call produces no duplicate commit', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => {
					throw new Error('ENOENT');
				},
			}),
		);

		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// NEW: unresolvable issueNumber throws and never stashes
// ---------------------------------------------------------------------------

describe('NEW (US-004): unresolvable but present issueNumber fails loud', () => {
	test('issueNumber=0 throws (never produces prefix-0)', () => {
		const { spawnFn } = makeRecordingSpawn();
		const stashedIds: string[] = [];

		expect(() =>
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readPrd: () => JSON.stringify({ issueNumber: 0 }),
					stashFn: (id) => stashedIds.push(id),
				}),
			),
		).toThrow();

		// stashFn must never be called with a phantom id
		expect(stashedIds).toHaveLength(0);
	});

	test('issueNumber=-1 throws', () => {
		const { spawnFn } = makeRecordingSpawn();

		expect(() =>
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readPrd: () => JSON.stringify({ issueNumber: -1 }),
				}),
			),
		).toThrow();
	});

	test('rm and commit do NOT proceed when issueNumber is invalid', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		try {
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readPrd: () => JSON.stringify({ issueNumber: 0 }),
				}),
			);
		} catch {
			// expected throw
		}

		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeUndefined();

		const rmCall = calls.find((c) => c.args.includes('rm'));
		expect(rmCall).toBeUndefined();
	});
});
