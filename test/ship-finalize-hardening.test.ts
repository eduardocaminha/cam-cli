// test/ship-finalize-hardening.test.ts
//
// Failure-mode hardening + idempotency tests for finalizeCycleClose().
// Oracle: bun test test/ship-finalize-hardening.test.ts
//
// Coverage (US-005 acceptance criteria):
//   AC1: issue_system == 'none' + issue NOT in issues.local.json
//        => printError + throw, rm and commit do NOT proceed.
//   AC2: prd.json absent (readPrd throws)
//        => clean no-op (noOp: true), no commit, exit 0.
//   AC3: nothing staged after git rm
//        => commit step is skipped (noOp: true, no commit call), exit 0.
//   AC4: second invocation after a successful first run
//        => clean no-op (same as AC2: prd.json removed by first run).

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

const FIXED_TS = '2026-06-23T12:00:00.000Z';
const clock = () => FIXED_TS;

const PROJECT_TOML_NONE = 'issue_system = "none"\nissue_prefix = "CAM"\n';
const PROJECT_TOML_GITHUB = 'issue_system = "github"\nissue_prefix = "CAM"\n';

/** prd.json referencing issue CAM-72. */
const PRD_JSON = JSON.stringify({ issueNumber: 72, branchName: 'cam/CAM-72-test' });

/** issues.local.json WITHOUT a CAM-72 entry (only CAM-71 is present). */
const ISSUES_WITHOUT_72 = JSON.stringify(
	{
		next_id: 73,
		issues: [
			{ id: 'CAM-71', title: 'Another', state: 'closed', createdAt: '2026-05-01T00:00:00Z' },
		],
	},
	null,
	2,
) + '\n';

/** issues.local.json WITH a CAM-72 entry. */
const ISSUES_WITH_72 = JSON.stringify(
	{
		next_id: 73,
		issues: [
			{ id: 'CAM-72', title: 'Test issue', state: 'open', createdAt: '2026-06-01T00:00:00Z' },
			{ id: 'CAM-71', title: 'Another', state: 'closed', createdAt: '2026-05-01T00:00:00Z' },
		],
	},
	null,
	2,
) + '\n';

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

/** Base options — override per test. */
function makeOptions(
	overrides: Partial<FinalizeCycleCloseOptions> & { spawnFn: SpawnFn },
): FinalizeCycleCloseOptions {
	return {
		cwd: '/fake/project',
		clock,
		readProjectToml: () => PROJECT_TOML_NONE,
		readPrd: () => PRD_JSON,
		readIssues: () => ISSUES_WITH_72,
		writeIssues: () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC1: issue_system == 'none' + issue NOT in issues.local.json => error
// ---------------------------------------------------------------------------

describe('AC1: missing issue in issues.local.json (none backend)', () => {
	test('throws with a message naming the missing id', () => {
		const { spawnFn } = makeRecordingSpawn();

		expect(() =>
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readIssues: () => ISSUES_WITHOUT_72,
				}),
			),
		).toThrow('issue not found in issues.local.json: CAM-72');
	});

	test('rm and commit do NOT proceed when issue is missing', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		try {
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readIssues: () => ISSUES_WITHOUT_72,
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
});

// ---------------------------------------------------------------------------
// AC3: nothing staged after git rm => commit step skipped, exit 0
// ---------------------------------------------------------------------------

describe('AC3: nothing staged after git rm (files not tracked)', () => {
	test('returns noOp: true when git diff --cached --quiet exits 0', () => {
		// diffCachedStatus: 0 = no staged changes = skip commit
		const { spawnFn } = makeRecordingSpawn({ diffCachedStatus: 0 });

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB, // github: no issues edit, simpler setup
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
		// diffCachedStatus: 1 = staged changes present = run commit
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
		// After the first run, git rm removes prd.json. A second run finds it absent.
		// Simulated by readPrd throwing on the "second call".
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
