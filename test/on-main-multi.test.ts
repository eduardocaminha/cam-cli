// test/on-main-multi.test.ts
//
// Unit tests for the multi-file atomic commit and CAS guarantees added to
// src/git/on-main.ts in US-001 (CAM-90).
//
// Coverage:
//   AC#1 Multi-file atomic commit (commitTreeToMain):
//     (a) all files land in ONE commit: one write-tree, one commit-tree.
//     (b) hash-object called once per file; update-index called once per file.
//     (c) mid-list failure (failing hash-object for 2nd file): throws before
//         write-tree so none of the changes are committed.
//     (d) mid-list failure (failing update-index for 2nd file): same guarantee.
//
//   AC#2 Compare-and-swap (CAS) on update-ref:
//     (e) update-ref argv includes the old-expected sha as the 4th positional
//         arg (after refs/heads/main and the new commit sha).
//     (f) CAS failure triggers a bounded re-read+rebuild loop: on first attempt
//         update-ref fails, helper re-reads main sha, rebuilds, retries; second
//         attempt succeeds.
//     (g) re-read uses `git rev-parse main` (not a cached copy).
//     (h) CAS bounded: when ALL attempts fail, the function throws after
//         CAS_MAX_ATTEMPTS attempts (never silently overwrites).
//
//   AC#3 Parity: 1-element list produces the same plumbing sequence as the old
//     single-file API (read-tree, hash-object, update-index, write-tree,
//     commit-tree, update-ref).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	commitTreeToMain,
	CAS_MAX_ATTEMPTS,
	type FileWrite,
	type SpawnFn,
} from '../src/git/on-main.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CWD = '/fake/repo';
const MAIN_SHA = 'mainsha1111111111';
const BLOB_SHA_1 = 'blobsha11111';
const BLOB_SHA_2 = 'blobsha22222';
const TREE_SHA = 'treesha3333';
const COMMIT_SHA = 'newcommitsha4444444';
const COMMIT_MSG = 'chore(cam): test multi-file';

const FILE_A: FileWrite = { path: 'scripts/cam/issues.local.json', content: '{"a":1}\n' };
const FILE_B: FileWrite = { path: 'scripts/cam/prd.json', content: '{"b":2}\n' };

/** Minimal successful SpawnSyncReturns<string>. */
function ok(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

/** Minimal failing SpawnSyncReturns<string>. */
function fail(stderr = 'simulated error'): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', stderr], stdout: '', stderr, status: 1, signal: null };
}

interface Call {
	cmd: string;
	args: string[];
	input?: string;
}

// ---------------------------------------------------------------------------
// Happy-path recording spawn for commitTreeToMain (off-main, multi-file).
// Returns blob shas in round-robin order so multi-file calls get distinct shas.
// ---------------------------------------------------------------------------

function makeHappySpawn(): { spawnFn: SpawnFn; calls: Call[] } {
	const calls: Call[] = [];
	let hashCallCount = 0;
	const blobShas = [BLOB_SHA_1, BLOB_SHA_2];

	const spawnFn: SpawnFn = (cmd, args, options) => {
		calls.push({ cmd, args: [...args], input: options.input });

		if (args.includes('hash-object')) {
			const sha = blobShas[hashCallCount % blobShas.length] ?? BLOB_SHA_1;
			hashCallCount++;
			return ok(sha + '\n');
		}
		if (args.includes('write-tree')) return ok(TREE_SHA + '\n');
		if (args.includes('commit-tree')) return ok(COMMIT_SHA + '\n');
		// update-ref: success by default (CAS passes)
		if (args.includes('update-ref')) return ok();
		// rev-parse main (for CAS re-read)
		if (args.includes('rev-parse') && args.includes('main')) return ok(MAIN_SHA + '\n');
		return ok();
	};

	return { spawnFn, calls };
}

// ---------------------------------------------------------------------------
// AC#1: Multi-file atomic commit (commitTreeToMain)
// ---------------------------------------------------------------------------

describe('commitTreeToMain — AC#1 multi-file atomic commit', () => {
	test('(a) one write-tree and one commit-tree for a 2-file list', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A, FILE_B], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const writeTreeCalls = calls.filter((c) => c.args.includes('write-tree'));
		const commitTreeCalls = calls.filter((c) => c.args.includes('commit-tree'));

		expect(writeTreeCalls.length).toBe(1);
		expect(commitTreeCalls.length).toBe(1);
	});

	test('(b) hash-object called once per file; update-index called once per file', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A, FILE_B], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const updateIndexCalls = calls.filter((c) => c.args.includes('update-index'));

		expect(hashCalls.length).toBe(2);
		expect(updateIndexCalls.length).toBe(2);
	});

	test('(b) hash-object inputs match file contents', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A, FILE_B], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const inputs = hashCalls.map((c) => c.input);

		expect(inputs).toContain(FILE_A.content);
		expect(inputs).toContain(FILE_B.content);
	});

	test('(b) update-index cacheinfo entries reference both file paths', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A, FILE_B], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const updateIndexCalls = calls.filter((c) => c.args.includes('update-index'));
		const cachedPaths = updateIndexCalls
			.map((c) => c.args.find((a) => a.startsWith('100644,')))
			.map((entry) => entry?.split(',')[2]);

		expect(cachedPaths).toContain(FILE_A.path);
		expect(cachedPaths).toContain(FILE_B.path);
	});

	test('(c) mid-list hash-object failure: throws before write-tree (none committed)', () => {
		const calls: Call[] = [];
		let hashCallCount = 0;

		const spawnFn: SpawnFn = (cmd, args, options) => {
			calls.push({ cmd, args: [...args], input: options.input });
			if (args.includes('hash-object')) {
				hashCallCount++;
				// First file succeeds; second file fails.
				if (hashCallCount >= 2) return fail('simulated hash-object error');
				return ok(BLOB_SHA_1 + '\n');
			}
			if (args.includes('write-tree')) return ok(TREE_SHA + '\n');
			if (args.includes('commit-tree')) return ok(COMMIT_SHA + '\n');
			return ok();
		};

		expect(() =>
			commitTreeToMain(CWD, [FILE_A, FILE_B], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-'),
		).toThrow();

		// write-tree must NOT have been called (atomicity: nothing lands)
		expect(calls.find((c) => c.args.includes('write-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('(d) mid-list update-index failure: throws before write-tree (none committed)', () => {
		const calls: Call[] = [];
		let updateIndexCount = 0;

		const spawnFn: SpawnFn = (cmd, args, options) => {
			calls.push({ cmd, args: [...args], input: options.input });
			if (args.includes('hash-object')) return ok(BLOB_SHA_1 + '\n');
			if (args.includes('update-index')) {
				updateIndexCount++;
				if (updateIndexCount >= 2) return fail('simulated update-index error');
				return ok();
			}
			if (args.includes('write-tree')) return ok(TREE_SHA + '\n');
			if (args.includes('commit-tree')) return ok(COMMIT_SHA + '\n');
			return ok();
		};

		expect(() =>
			commitTreeToMain(CWD, [FILE_A, FILE_B], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-'),
		).toThrow();

		expect(calls.find((c) => c.args.includes('write-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC#2: CAS on update-ref
// ---------------------------------------------------------------------------

describe('commitTreeToMain — AC#2 compare-and-swap update-ref', () => {
	test('(e) update-ref argv carries old-expected sha as 4th positional arg', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const updateRefCall = calls.find((c) => c.args.includes('update-ref'));
		expect(updateRefCall).toBeDefined();

		// argv shape: [...gitFlags, 'update-ref', 'refs/heads/main', <new-sha>, <old-expected-sha>]
		const updateRefIdx = updateRefCall!.args.indexOf('update-ref');
		const refName = updateRefCall!.args[updateRefIdx + 1];
		const newSha = updateRefCall!.args[updateRefIdx + 2];
		const oldSha = updateRefCall!.args[updateRefIdx + 3];

		expect(refName).toBe('refs/heads/main');
		expect(newSha).toBe(COMMIT_SHA); // the new commit
		expect(oldSha).toBe(MAIN_SHA);   // the expected old sha (CAS)
	});

	test('(f) CAS failure on first attempt: retries and succeeds on second', () => {
		const calls: Call[] = [];
		let hashCallCount = 0;
		let updateRefCallCount = 0;

		const spawnFn: SpawnFn = (cmd, args, options) => {
			calls.push({ cmd, args: [...args], input: options.input });

			if (args.includes('hash-object')) {
				hashCallCount++;
				return ok(BLOB_SHA_1 + '\n');
			}
			if (args.includes('write-tree')) return ok(TREE_SHA + '\n');
			if (args.includes('commit-tree')) return ok(COMMIT_SHA + '\n');
			if (args.includes('update-ref')) {
				updateRefCallCount++;
				// First attempt fails (CAS mismatch); second succeeds.
				return updateRefCallCount === 1 ? fail('CAS rejected') : ok();
			}
			// re-read main sha after CAS failure
			if (args.includes('rev-parse') && args.includes('main') && !args.includes('--abbrev-ref')) {
				return ok('newmainsha9999999\n');
			}
			return ok();
		};

		// Must not throw
		const sha = commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');
		expect(typeof sha).toBe('string');
		expect(sha.length).toBeGreaterThan(0);

		// update-ref was called twice (first CAS fail, second success)
		expect(updateRefCallCount).toBe(2);
	});

	test('(g) after CAS failure, helper re-reads main sha via rev-parse main', () => {
		const calls: Call[] = [];
		let updateRefCallCount = 0;
		const NEW_MAIN_SHA = 'advancedmainsha000';

		const spawnFn: SpawnFn = (cmd, args, options) => {
			calls.push({ cmd, args: [...args], input: options.input });

			if (args.includes('hash-object')) return ok(BLOB_SHA_1 + '\n');
			if (args.includes('write-tree')) return ok(TREE_SHA + '\n');
			if (args.includes('commit-tree')) return ok(COMMIT_SHA + '\n');
			if (args.includes('update-ref')) {
				updateRefCallCount++;
				return updateRefCallCount === 1 ? fail('CAS rejected') : ok();
			}
			if (args.includes('rev-parse') && args.includes('main') && !args.includes('--abbrev-ref')) {
				return ok(NEW_MAIN_SHA + '\n');
			}
			return ok();
		};

		commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		// rev-parse main must have been called to get the new sha
		const revParseCalls = calls.filter(
			(c) =>
				c.args.includes('rev-parse') &&
				c.args.includes('main') &&
				!c.args.includes('--abbrev-ref'),
		);
		// At least one rev-parse main call fired after the CAS failure
		expect(revParseCalls.length).toBeGreaterThanOrEqual(1);

		// The second update-ref must use the new sha (not the stale one)
		const updateRefCalls = calls.filter((c) => c.args.includes('update-ref'));
		expect(updateRefCalls.length).toBe(2);
		const secondUpdateRef = updateRefCalls[1]!;
		const updateRefIdx = secondUpdateRef.args.indexOf('update-ref');
		const oldShaInSecondAttempt = secondUpdateRef.args[updateRefIdx + 3];
		// The old-expected sha in the retry must be the freshly-read sha
		expect(oldShaInSecondAttempt).toBe(NEW_MAIN_SHA);
	});

	test('(h) CAS exhausts all attempts and throws', () => {
		const calls: Call[] = [];
		let updateRefCallCount = 0;

		const spawnFn: SpawnFn = (cmd, args, options) => {
			calls.push({ cmd, args: [...args], input: options.input });

			if (args.includes('hash-object')) return ok(BLOB_SHA_1 + '\n');
			if (args.includes('write-tree')) return ok(TREE_SHA + '\n');
			if (args.includes('commit-tree')) return ok(COMMIT_SHA + '\n');
			if (args.includes('update-ref')) {
				updateRefCallCount++;
				return fail('CAS always rejected');
			}
			if (args.includes('rev-parse') && args.includes('main') && !args.includes('--abbrev-ref')) {
				return ok(MAIN_SHA + '\n');
			}
			return ok();
		};

		expect(() =>
			commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-'),
		).toThrow(/CAS/i);

		// update-ref was called exactly CAS_MAX_ATTEMPTS times (not more)
		expect(updateRefCallCount).toBe(CAS_MAX_ATTEMPTS);
	});
});

// ---------------------------------------------------------------------------
// AC#3: Parity — 1-element list produces same plumbing sequence as old API
// ---------------------------------------------------------------------------

describe('commitTreeToMain — AC#3 parity: 1-element list = single-file sequence', () => {
	test('plumbing sequence for 1-element list is read-tree, hash-object, update-index, write-tree, commit-tree, update-ref', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const plumbing = calls
			.map((c) => {
				if (c.args.includes('read-tree')) return 'read-tree';
				if (c.args.includes('hash-object')) return 'hash-object';
				if (c.args.includes('update-index')) return 'update-index';
				if (c.args.includes('write-tree')) return 'write-tree';
				if (c.args.includes('commit-tree')) return 'commit-tree';
				if (c.args.includes('update-ref')) return 'update-ref';
				return null;
			})
			.filter(Boolean);

		expect(plumbing).toEqual([
			'read-tree',
			'hash-object',
			'update-index',
			'write-tree',
			'commit-tree',
			'update-ref',
		]);
	});

	test('commit-tree uses -p <localMainSha> as the parent', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall).toBeDefined();
		expect(commitTreeCall!.args).toContain('-p');
		expect(commitTreeCall!.args).toContain(MAIN_SHA);
	});

	test('update-index cacheinfo contains the file path from the FileWrite', () => {
		const { spawnFn, calls } = makeHappySpawn();

		commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		const updateIndexCall = calls.find((c) => c.args.includes('update-index'));
		expect(updateIndexCall).toBeDefined();
		const cacheinfo = updateIndexCall!.args.find((a) => a.startsWith('100644,'));
		expect(cacheinfo).toContain(FILE_A.path);
	});

	test('returns first 7 chars of the new commit sha', () => {
		const { spawnFn } = makeHappySpawn();

		const result = commitTreeToMain(CWD, [FILE_A], COMMIT_MSG, MAIN_SHA, spawnFn, 'cam-test-');

		expect(result).toBe(COMMIT_SHA.substring(0, 7));
	});
});
