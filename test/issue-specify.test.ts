// test/issue-specify.test.ts
//
// Unit tests for closeIssueOnMain() in src/commands/issue-specify.ts.
//
// Coverage (per US-003 acceptance criteria):
//   (a) sets stage:'shipped' on the target issue; commits only
//       scripts/cam/issues/<id>.json to main via commitTreeToMain (tree derived
//       from the main ref); then pushes main best-effort.
//   (b) fails loud when the id is absent on main: returns
//       { ok: false, reason: 'not-found' } (never a silent ok).
//   (c) reuses up-to-date guard: returns
//       { ok: false, reason: 'detached-head' | 'missing-main' | 'diverged' }
//       without mutating anything on those failures.
//   (d) closeIssueOnMain is exported from src/commands/issue-specify.ts.
//
// All external I/O is faked via injectable SpawnFn; no real git binary or
// filesystem is exercised (except the mkdtempSync inside commitTreeToMain).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	closeIssueOnMain,
	type CloseIssueOnMainOptions,
	type CloseIssueOnMainOutcome,
	type CloseIssueOnMainResult,
	type SpawnFn,
} from '../src/commands/issue-specify.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = '2026-07-02T10:00:00.000Z';
const clock = () => FIXED_TS;

// Existing open issue in the backlog.
const EXISTING_ENTRY = {
	id: 'CAM-10',
	title: 'Existing open issue',
	stage: 'specified' as const,
	status: 'open' as const,
	blockedBy: [] as string[],
	createdAt: '2026-07-01T00:00:00Z',
};
const EXISTING_ENTRY_JSON = JSON.stringify(EXISTING_ENTRY, null, 2) + '\n';

// ls-tree output: one file for the existing issue.
const LS_TREE_OUTPUT = 'scripts/cam/issues/CAM-0010.json\n';

// cat-file --batch blob framing: `<oid> blob <size>\n<content>\n`
function frameBlobOutput(content: string): string {
	return `abc123 blob ${content.length}\n${content}\n`;
}
const CAT_FILE_OUTPUT = frameBlobOutput(EXISTING_ENTRY_JSON);

/** Minimal SpawnSyncReturns<string> for a successful git call. */
function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

/** Minimal SpawnSyncReturns<string> for a failing git call. */
function failResult(stderr = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', stderr], stdout: '', stderr, status: 1, signal: null };
}

/**
 * Narrow a CloseIssueOnMainOutcome to the success type.
 * Throws if ok is false, making the test fail with a clear message.
 */
function assertOk(result: CloseIssueOnMainOutcome): asserts result is CloseIssueOnMainResult {
	if (!result.ok) {
		throw new Error(
			`Expected ok:true but got ok:false, reason=${JSON.stringify((result as { reason: string }).reason)}`,
		);
	}
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

interface RecordingSpawnOpts {
	/** What branch `git rev-parse --abbrev-ref HEAD` reports. Default 'cam/feature'. */
	branch?: string;
	/** SHA returned by `git rev-parse main`. Default 'mainsha1234567890'. */
	mainSha?: string;
	/** Exit status for `git rev-parse main`. Default 0. Set to 1 for missing local main. */
	mainRevParseStatus?: number;
	/** SHA returned by `git rev-parse origin/main`. Default = mainSha. */
	originMainSha?: string;
	/** Exit status for `git rev-parse origin/main`. Default 0. Set to 1 for no-remote. */
	originMainStatus?: number;
	/** SHA returned by `git hash-object`. Default 'blobsha1234'. */
	blobSha?: string;
	/** SHA returned by `git write-tree`. Default 'treesha1234'. */
	treeSha?: string;
	/** Full commit SHA returned by `git commit-tree`. Default 'newcommitsha1234567'. */
	newCommitSha?: string;
	/** Exit status for `git push origin main`. Default 0. */
	pushStatus?: number;
	/** ls-tree output. Default: LS_TREE_OUTPUT. */
	lsTreeOutput?: string;
	/** cat-file --batch output. Default: CAT_FILE_OUTPUT. */
	catFileOutput?: string;
}

function makeRecordingSpawn(opts: RecordingSpawnOpts = {}): {
	spawnFn: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const branch = opts.branch ?? 'cam/feature';
	const mainSha = opts.mainSha ?? 'mainsha1234567890';
	const mainRevParseStatus = opts.mainRevParseStatus ?? 0;
	const originMainSha = opts.originMainSha ?? mainSha;
	const originMainStatus = opts.originMainStatus ?? 0;
	const blobSha = opts.blobSha ?? 'blobsha1234';
	const treeSha = opts.treeSha ?? 'treesha1234';
	const newCommitSha = opts.newCommitSha ?? 'newcommitsha1234567';
	const pushStatus = opts.pushStatus ?? 0;
	const lsTreeOutput = opts.lsTreeOutput ?? LS_TREE_OUTPUT;
	const catFileOutput = opts.catFileOutput ?? CAT_FILE_OUTPUT;

	const spawnFn: SpawnFn = (cmd, args, _options) => {
		calls.push({ cmd, args });
		const argsStr = args.join(' ');

		// git rev-parse --abbrev-ref HEAD
		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref') && argsStr.includes('HEAD')) {
			return okResult(branch + '\n');
		}

		// git rev-parse origin/main (check before 'main' without 'origin/')
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return { ...okResult(originMainSha + '\n'), status: originMainStatus };
		}

		// git rev-parse main -> local main sha
		if (
			argsStr.includes('rev-parse') &&
			argsStr.includes('main') &&
			!argsStr.includes('--abbrev-ref') &&
			!argsStr.includes('origin/main')
		) {
			return { ...okResult(mainSha + '\n'), status: mainRevParseStatus };
		}

		// git fetch origin main (best-effort)
		if (argsStr.includes('fetch')) {
			return okResult();
		}

		// git ls-tree -> file listing
		if (argsStr.includes('ls-tree') && argsStr.includes('scripts/cam/issues')) {
			return okResult(lsTreeOutput);
		}

		// git cat-file --batch -> blob content
		if (argsStr.includes('cat-file') && argsStr.includes('--batch')) {
			return okResult(catFileOutput);
		}

		// git read-tree main
		if (argsStr.includes('read-tree')) {
			return okResult();
		}

		// git hash-object -> blob sha
		if (argsStr.includes('hash-object')) {
			return okResult(blobSha + '\n');
		}

		// git update-index
		if (argsStr.includes('update-index')) {
			return okResult();
		}

		// git write-tree -> tree sha
		if (argsStr.includes('write-tree')) {
			return okResult(treeSha + '\n');
		}

		// git commit-tree -> new commit sha
		if (argsStr.includes('commit-tree')) {
			return okResult(newCommitSha + '\n');
		}

		// git update-ref (CAS)
		if (argsStr.includes('update-ref')) {
			return okResult();
		}

		// git push origin main
		if (argsStr.includes('push') && argsStr.includes('origin') && argsStr.includes('main')) {
			return pushStatus === 0
				? okResult()
				: { ...failResult('rejected: remote rejected'), status: pushStatus };
		}

		return okResult();
	};

	return { spawnFn, calls };
}

function makeOptions(
	overrides: Partial<CloseIssueOnMainOptions> & { spawnFn: SpawnFn },
): CloseIssueOnMainOptions {
	return {
		cwd: '/fake/project',
		id: 'CAM-10',
		clock,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// (a) AC1: sets stage:'shipped', commits only the target file, pushes
// ---------------------------------------------------------------------------

describe('closeIssueOnMain — AC1: sets stage:shipped and commits to main', () => {
	test('returns ok:true with correct fields', () => {
		const { spawnFn } = makeRecordingSpawn();
		const result = closeIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.id).toBe('CAM-10');
		expect(result.committedTo).toBe('main');
		expect(typeof result.sha).toBe('string');
		expect(result.sha.length).toBeGreaterThan(0);
	});

	test('hash-object stdin carries stage:shipped (capturing spawnFn)', () => {
		let capturedInput: string | undefined;
		const { spawnFn: baseSpawn, calls } = makeRecordingSpawn();
		const capturingSpawn: SpawnFn = (cmd, args, options) => {
			if (args.includes('hash-object')) {
				capturedInput = options.input;
			}
			return baseSpawn(cmd, args, options);
		};
		const result = closeIssueOnMain(makeOptions({ spawnFn: capturingSpawn }));
		assertOk(result);

		expect(capturedInput).toBeDefined();
		const entry = JSON.parse(capturedInput!) as { stage: string; id: string };
		expect(entry.stage).toBe('shipped');
		expect(entry.id).toBe('CAM-10');
		void calls;
	});

	test('commit message is chore(cam): close <id> (shipped)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		closeIssueOnMain(makeOptions({ spawnFn }));

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall).toBeDefined();
		const msgIdx = commitTreeCall!.args.indexOf('-m');
		expect(commitTreeCall!.args[msgIdx + 1]).toBe('chore(cam): close CAM-10 (shipped)');
	});

	test('update-index cacheinfo targets the correct file path', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		closeIssueOnMain(makeOptions({ spawnFn }));

		const updateIndexCall = calls.find((c) => c.args.includes('update-index'));
		expect(updateIndexCall).toBeDefined();
		const cacheinfo = updateIndexCall!.args.find((a) => a.startsWith('100644,'));
		expect(cacheinfo).toBeDefined();
		expect(cacheinfo).toContain('scripts/cam/issues/CAM-0010.json');
	});

	test('push fires after update-ref (best-effort push)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = closeIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const updateRefIdx = calls.findIndex((c) => c.args.includes('update-ref'));
		const pushIdx = calls.findIndex(
			(c) => c.args.includes('push') && c.args.includes('origin'),
		);
		expect(updateRefIdx).toBeGreaterThan(-1);
		expect(pushIdx).toBeGreaterThan(updateRefIdx);
	});

	test('push failure still returns ok:true (push is best-effort)', () => {
		const { spawnFn } = makeRecordingSpawn({ pushStatus: 1 });
		const result = closeIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
	});

	test('returns branchWasMain:false when on feature branch', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'cam/feature' });
		const result = closeIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.branchWasMain).toBe(false);
	});

	test('returns branchWasMain:true when on main branch', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'main' });
		const result = closeIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.branchWasMain).toBe(true);
	});

	test('sha is the commit-tree output (first 7 chars)', () => {
		const { spawnFn } = makeRecordingSpawn({ newCommitSha: 'abcdef1234567' });
		const result = closeIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.sha).toBe('abcdef1');
	});

	test('full plumbing sequence: read-tree, hash-object, update-index, write-tree, commit-tree, update-ref', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		closeIssueOnMain(makeOptions({ spawnFn }));

		const subcommands = calls.map((c) => {
			const a = c.args;
			if (a.includes('ls-tree')) return 'ls-tree';
			if (a.includes('cat-file')) return 'cat-file';
			if (a.includes('read-tree')) return 'read-tree';
			if (a.includes('hash-object')) return 'hash-object';
			if (a.includes('update-index')) return 'update-index';
			if (a.includes('write-tree')) return 'write-tree';
			if (a.includes('commit-tree')) return 'commit-tree';
			if (a.includes('update-ref')) return 'update-ref';
			return null;
		}).filter(Boolean);

		expect(subcommands).toContain('ls-tree');
		expect(subcommands).toContain('cat-file');
		expect(subcommands).toContain('read-tree');
		expect(subcommands).toContain('hash-object');
		expect(subcommands).toContain('update-index');
		expect(subcommands).toContain('write-tree');
		expect(subcommands).toContain('commit-tree');
		expect(subcommands).toContain('update-ref');
	});
});

// ---------------------------------------------------------------------------
// (b) AC2: not-found when id absent on main
// ---------------------------------------------------------------------------

describe('closeIssueOnMain — AC2: not-found when id absent', () => {
	test('returns ok:false reason:not-found when id does not exist in backlog', () => {
		// Empty backlog: no issues.
		const { spawnFn, calls } = makeRecordingSpawn({
			lsTreeOutput: '',
			catFileOutput: '',
		});
		const result = closeIssueOnMain(makeOptions({ spawnFn, id: 'CAM-999' }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('not-found');
		}
		// No mutation: update-ref must not have been called
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('returns ok:false reason:not-found when id does not match any entry', () => {
		// Backlog has CAM-10 but we request CAM-99.
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = closeIssueOnMain(makeOptions({ spawnFn, id: 'CAM-99' }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('not-found');
		}
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('not-found never commits silently (update-ref absent)', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			lsTreeOutput: '',
			catFileOutput: '',
		});
		closeIssueOnMain(makeOptions({ spawnFn, id: 'CAM-42' }));

		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (c) AC3: up-to-date guard (detached-head, missing-main, diverged)
// ---------------------------------------------------------------------------

describe('closeIssueOnMain — AC3: up-to-date guard returns without mutating', () => {
	test('returns ok:false reason:diverged when local main differs from origin/main', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			mainSha: 'localsha111',
			originMainSha: 'originsha222',
		});
		const result = closeIssueOnMain(makeOptions({ spawnFn }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('diverged');
		}
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('skips diverged check when origin/main absent (no remote)', () => {
		const { spawnFn } = makeRecordingSpawn({ originMainStatus: 1 });
		const result = closeIssueOnMain(makeOptions({ spawnFn }));
		// Guard skipped -> commit proceeds -> ok:true
		assertOk(result);
	});

	test('returns ok:false reason:detached-head when HEAD is detached', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'HEAD' });
		const result = closeIssueOnMain(makeOptions({ spawnFn }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('detached-head');
		}
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('returns ok:false reason:missing-main when rev-parse main fails', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ mainRevParseStatus: 1 });
		const result = closeIssueOnMain(makeOptions({ spawnFn }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('missing-main');
		}
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (d) AC4: export check (type-level; confirmed by the import at top of file)
// ---------------------------------------------------------------------------

describe('closeIssueOnMain — AC4: exported from issue-specify.ts', () => {
	test('closeIssueOnMain is a function (export confirmed by import)', () => {
		expect(typeof closeIssueOnMain).toBe('function');
	});
});
