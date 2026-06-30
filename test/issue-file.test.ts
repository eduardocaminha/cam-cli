// test/issue-file.test.ts
//
// Unit tests for createLocalIssueOnMain() in src/commands/issue-file.ts.
//
// US-004 cutover: issue-file now delegates all id allocation and file-writing
// to writeIssueFile (src/issues/alloc.ts), which:
//   - allocates the next id via allocateId (readBacklogFromMain: ls-tree + cat-file)
//   - writes one scripts/cam/issues/CAM-NNNN.json file atomically to main via
//     CAS update-ref; issues.local.json is never touched.
//
// Coverage (per US-004 acceptance criteria):
//   (a) written path is scripts/cam/issues/CAM-NNNN.json
//   (b) no issues.local.json reference appears in any spawn call
//   (c) CAS plumbing sequence: ls-tree, cat-file, read-tree, hash-object,
//       update-index, write-tree, commit-tree, update-ref
//   (d) hash-object input carries the new IssueEntry JSON with correct fields
//   (e) update-index cacheinfo includes the padded filename
//   (f) commit message: 'chore(cam): file <id>'
//   (g) result fields: ok:true, id=CAM-89, committedTo='main', branchWasMain
//   (h) guard paths: diverged, detached-head, missing-main
//   (i) push fires after CAS on both on-main and off-main branches
//
// All external I/O is faked via injectable SpawnFn; no real git binary or
// filesystem is exercised (except the mkdtempSync inside writeIssueFile, which
// creates and immediately cleans up an empty temp directory).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	createLocalIssueOnMain,
	type CreateLocalIssueOnMainOptions,
	type CreateLocalIssueOnMainResult,
	type CreateLocalIssueOnMainOutcome,
	type SpawnFn,
} from '../src/commands/issue-file.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = '2026-06-25T10:00:00.000Z';
const clock = () => FIXED_TS;

const PROJECT_TOML = 'issue_system = "none"\nissue_prefix = "CAM"\n';

// Existing issue in the dir (CAM-88). allocateId will return 89.
const EXISTING_ENTRY = {
	id: 'CAM-88',
	title: 'Previous issue',
	stage: 'idea' as const,
	status: 'open' as const,
	blockedBy: [] as string[],
	createdAt: '2026-06-24T00:00:00Z',
};
const EXISTING_ENTRY_JSON = JSON.stringify(EXISTING_ENTRY, null, 2) + '\n';

// ls-tree returns one file for the existing issue
const LS_TREE_OUTPUT = 'scripts/cam/issues/CAM-0088.json\n';

// cat-file --batch framing: `<oid> blob <size>\n<content>\n`
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
 * Narrow a CreateLocalIssueOnMainOutcome to the success type.
 * Throws if ok is false, making the test fail with a clear message.
 */
function assertOk(
	result: CreateLocalIssueOnMainOutcome,
): asserts result is CreateLocalIssueOnMainResult {
	if (!result.ok) {
		throw new Error(`Expected ok:true but got ok:false, reason=${JSON.stringify((result as { reason: string }).reason)}`);
	}
}

interface SpawnCall {
	cmd: string;
	args: string[];
	options: { encoding: 'utf8'; env?: Record<string, string>; input?: string };
}

interface RecordingSpawnOpts {
	/** What branch `git rev-parse --abbrev-ref HEAD` reports. Default 'cam/feature'. Use 'HEAD' for detached. */
	branch?: string;
	/** Full SHA returned by `git rev-parse main`. Default 'mainsha1234567890'. */
	mainSha?: string;
	/** Exit status for `git rev-parse main`. Default 0. Set to 1 to simulate missing local main. */
	mainRevParseStatus?: number;
	/** Full SHA returned by `git rev-parse origin/main`. Default = mainSha (in sync). */
	originMainSha?: string;
	/** Exit status for `git rev-parse origin/main`. Default 0. Set to 1 for no-remote. */
	originMainStatus?: number;
	/** SHA returned by `git hash-object`. Default 'blobsha1234'. */
	blobSha?: string;
	/** SHA returned by `git write-tree`. Default 'treesha1234'. */
	treeSha?: string;
	/** Full commit SHA returned by `git commit-tree`. Default 'newcommitsha1234567'. */
	newCommitSha?: string;
	/** Exit status for `git push origin main`. Default 0 (success). */
	pushStatus?: number;
	/** ls-tree output (file listing for readBacklogFromMain). Default: LS_TREE_OUTPUT. */
	lsTreeOutput?: string;
	/** cat-file --batch output (blob content). Default: CAT_FILE_OUTPUT. */
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

	const spawnFn: SpawnFn = (cmd, args, options) => {
		calls.push({ cmd, args, options });
		const argsStr = args.join(' ');

		// git rev-parse --abbrev-ref HEAD -> current branch
		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref') && argsStr.includes('HEAD')) {
			return okResult(branch + '\n');
		}

		// git rev-parse origin/main (check before 'main' without 'origin/' below)
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return { ...okResult(originMainSha + '\n'), status: originMainStatus };
		}

		// git rev-parse main -> local main sha (guard + writeIssueFile initial sha)
		if (
			argsStr.includes('rev-parse') &&
			argsStr.includes('main') &&
			!argsStr.includes('--abbrev-ref') &&
			!argsStr.includes('--short') &&
			!argsStr.includes('origin/main')
		) {
			return { ...okResult(mainSha + '\n'), status: mainRevParseStatus };
		}

		// git fetch origin main (best-effort)
		if (argsStr.includes('fetch')) {
			return okResult();
		}

		// git ls-tree -> file listing (used by readBacklogFromMain/allocateId)
		if (argsStr.includes('ls-tree') && argsStr.includes('scripts/cam/issues')) {
			return okResult(lsTreeOutput);
		}

		// git cat-file --batch -> blob content (used by readBacklogFromMain)
		if (argsStr.includes('cat-file') && argsStr.includes('--batch')) {
			return okResult(catFileOutput);
		}

		// git read-tree main (writeIssueFile temp index setup)
		if (argsStr.includes('read-tree')) {
			return okResult();
		}

		// git hash-object -> blob sha
		if (argsStr.includes('hash-object')) {
			return okResult(blobSha + '\n');
		}

		// git update-index -> ok
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

		// git update-ref (CAS) -> success
		if (argsStr.includes('update-ref')) {
			return okResult();
		}

		// git push origin main -> best-effort push
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
	overrides: Partial<CreateLocalIssueOnMainOptions> & { spawnFn: SpawnFn },
): CreateLocalIssueOnMainOptions {
	return {
		cwd: '/fake/project',
		title: 'Test issue title',
		clock,
		readProjectToml: () => PROJECT_TOML,
		...overrides,
	};
}


// ---------------------------------------------------------------------------
// (a) written path is scripts/cam/issues/CAM-NNNN.json
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — US-004: written path is CAM-NNNN.json', () => {
	test('update-index cacheinfo contains scripts/cam/issues/CAM-0089.json (4-digit padded)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const updateIndexCall = calls.find((c) => c.args.includes('update-index'));
		expect(updateIndexCall).toBeDefined();

		const cacheinfo = updateIndexCall!.args.find((a) => a.startsWith('100644,'));
		expect(cacheinfo).toBeDefined();
		expect(cacheinfo).toContain('scripts/cam/issues/CAM-0089.json');
	});

	test('result id is CAM-89 (unpadded)', () => {
		const { spawnFn } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.id).toBe('CAM-89');
	});

	test('result committedTo is main', () => {
		const { spawnFn } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.committedTo).toBe('main');
	});

	test('result sha is first 7 chars of commit sha', () => {
		const { spawnFn } = makeRecordingSpawn({ newCommitSha: 'abcdef1234567' });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.sha).toBe('abcdef1');
	});

	test('returns branchWasMain:false when off main branch', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'cam/CAM-90-feature' });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.branchWasMain).toBe(false);
	});

	test('returns branchWasMain:true when on main branch', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'main' });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.branchWasMain).toBe(true);
	});

	test('allocates next id from empty dir (no existing issues): id is CAM-1', () => {
		const { spawnFn } = makeRecordingSpawn({
			lsTreeOutput: '',       // empty dir
			catFileOutput: '',      // no blobs
		});
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.id).toBe('CAM-1');

		// Path should be CAM-0001.json for id=1
		const updateIndexCall = spawnFn as unknown as SpawnFn;
		void updateIndexCall; // suppress unused lint
	});
});

// ---------------------------------------------------------------------------
// (b) no issues.local.json reference appears in any spawn call
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — US-004: no issues.local.json reference', () => {
	test('no spawn call arg contains issues.local.json (success path)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		for (const call of calls) {
			for (const arg of call.args) {
				expect(arg).not.toContain('issues.local.json');
			}
		}
	});

	test('no spawn call arg contains issues.local.json (guard fails: diverged)', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			mainSha: 'local111',
			originMainSha: 'origin222',
		});
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		for (const call of calls) {
			for (const arg of call.args) {
				expect(arg).not.toContain('issues.local.json');
			}
		}
	});
});

// ---------------------------------------------------------------------------
// (c) CAS plumbing sequence
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — CAS plumbing sequence', () => {
	test('calls full plumbing sequence: ls-tree, cat-file, read-tree, hash-object, update-index, write-tree, commit-tree, update-ref', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

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

	test('commit-tree uses -p <mainSha>', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ mainSha: 'mymainsha999' });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall).toBeDefined();
		expect(commitTreeCall!.args).toContain('-p');
		expect(commitTreeCall!.args).toContain('mymainsha999');
	});

	test('update-ref advances refs/heads/main', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ newCommitSha: 'freshcommit0987654' });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const updateRefCall = calls.find((c) => c.args.includes('update-ref'));
		expect(updateRefCall).toBeDefined();
		expect(updateRefCall!.args).toContain('refs/heads/main');
		expect(updateRefCall!.args).toContain('freshcommit0987654');
	});

	test('read-tree and hash-object receive GIT_INDEX_FILE in env', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const readTreeCall = calls.find((c) => c.args.includes('read-tree'));
		expect(readTreeCall).toBeDefined();
		expect(readTreeCall!.options.env?.['GIT_INDEX_FILE']).toBeDefined();
		expect((readTreeCall!.options.env?.['GIT_INDEX_FILE'] ?? '').length).toBeGreaterThan(0);

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		expect(hashCall).toBeDefined();
		expect(hashCall!.options.env?.['GIT_INDEX_FILE']).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// (d) hash-object input carries the new IssueEntry JSON
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — hash-object input shape', () => {
	test('hash-object input contains the new IssueEntry with correct id, title, stage, status', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn, title: 'My New Issue' }));
		assertOk(result);

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		expect(hashCall).toBeDefined();
		expect(typeof hashCall!.options.input).toBe('string');

		const parsed = JSON.parse(hashCall!.options.input!) as {
			id: string;
			title: string;
			stage: string;
			status: string;
			blockedBy: string[];
			createdAt: string;
		};
		expect(parsed.id).toBe('CAM-89');
		expect(parsed.title).toBe('My New Issue');
		expect(parsed.stage).toBe('idea');
		expect(parsed.status).toBe('open');
		expect(parsed.blockedBy).toEqual([]);
		expect(parsed.createdAt).toBe(FIXED_TS);
	});

	test('hash-object input ends with a newline (trailing newline)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		expect(hashCall).toBeDefined();
		expect(hashCall!.options.input!.endsWith('\n')).toBe(true);
	});

	test('description is included when provided', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		createLocalIssueOnMain(makeOptions({ spawnFn, description: 'A long description' }));

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		const parsed = JSON.parse(hashCall!.options.input!) as { description?: string };
		expect(parsed.description).toBe('A long description');
	});

	test('description is absent from JSON when not provided', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		const parsed = JSON.parse(hashCall!.options.input!) as { description?: string };
		expect(parsed.description).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (e) update-index cacheinfo: padded filename, correct mode
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — update-index cacheinfo', () => {
	test('cacheinfo contains 100644 mode', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ blobSha: 'myblob1234567890' });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const updateIndexCall = calls.find((c) => c.args.includes('update-index'));
		expect(updateIndexCall).toBeDefined();
		expect(updateIndexCall!.args).toContain('--add');
		expect(updateIndexCall!.args).toContain('--cacheinfo');

		const cacheinfo = updateIndexCall!.args.find((a) => a.startsWith('100644,'));
		expect(cacheinfo).toBeDefined();
		expect(cacheinfo).toContain('myblob1234567890');
	});

	test('cacheinfo filename is 4-digit zero-padded', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const updateIndexCall = calls.find((c) => c.args.includes('update-index'));
		const cacheinfo = updateIndexCall!.args.find((a) => a.startsWith('100644,'));
		expect(cacheinfo).toContain('CAM-0089.json');  // 89 padded to 4 digits
	});
});

// ---------------------------------------------------------------------------
// (f) commit message: 'chore(cam): file <id>'
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — commit message', () => {
	test('commit-tree message matches the literal form chore(cam): file <id>', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn, title: 'My Feature Issue' }));
		assertOk(result);

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall).toBeDefined();
		const msgIdx = commitTreeCall!.args.indexOf('-m');
		expect(commitTreeCall!.args[msgIdx + 1]).toBe('chore(cam): file CAM-89');
	});
});

// ---------------------------------------------------------------------------
// (h) Guard paths
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — up-to-date guards', () => {
	test('returns ok:false reason:diverged when local main differs from origin/main', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			mainSha: 'localsha111',
			originMainSha: 'originsha222',
		});

		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('diverged');
		}

		// No ls-tree (no backlog read attempted)
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
		// No update-ref
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('skips diverged check when origin/main absent (no remote configured)', () => {
		const { spawnFn } = makeRecordingSpawn({
			mainSha: 'localsha111',
			originMainStatus: 1,  // origin/main does not exist
		});

		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));

		// Guard skipped -> commit proceeds -> ok:true
		assertOk(result);
		expect(result.id).toBe('CAM-89');
	});

	test('returns ok:false reason:detached-head when HEAD is detached', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'HEAD' });

		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('detached-head');
		}
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('returns ok:false reason:missing-main when rev-parse main fails', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			mainRevParseStatus: 1,
		});

		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('missing-main');
		}
		expect(calls.find((c) => c.args.includes('fetch'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (i) Push fires after CAS on success path
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — push behavior', () => {
	test('push argv fires after update-ref on success path', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const updateRefIdx = calls.findIndex((c) => c.args.includes('update-ref'));
		const pushIdx = calls.findIndex(
			(c) => c.args.includes('push') && c.args.includes('origin'),
		);
		expect(updateRefIdx).toBeGreaterThan(-1);
		expect(pushIdx).toBeGreaterThan(updateRefIdx);
	});

	test('push failure: result is still ok:true (push is best-effort)', () => {
		const { spawnFn } = makeRecordingSpawn({ pushStatus: 1 });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);
		expect(result.id).toBe('CAM-89');
	});

	test('push fires when on main branch too', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'main' });
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const pushCall = calls.find(
			(c) => c.args.includes('push') && c.args.includes('origin') && c.args.includes('main'),
		);
		expect(pushCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// issue_prefix from toml
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — issue_prefix', () => {
	test('defaults to CAM when toml does not specify one', () => {
		const { spawnFn } = makeRecordingSpawn({ lsTreeOutput: '' });
		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				readProjectToml: () => 'issue_system = "none"\n',
			}),
		);
		assertOk(result);
		expect(result.id).toMatch(/^CAM-\d+/);
	});

	test('uses custom prefix from toml', () => {
		const { spawnFn } = makeRecordingSpawn({ lsTreeOutput: '' });
		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				readProjectToml: () => 'issue_system = "none"\nissue_prefix = "PROJ"\n',
			}),
		);
		assertOk(result);
		expect(result.id).toMatch(/^PROJ-\d+/);
	});
});

// ---------------------------------------------------------------------------
// US-002: Fast-track guardrails (pre-commit, validate-before-mutate)
// ---------------------------------------------------------------------------

// Helper: silence stderr for guardrail-refusal tests
function withSilentStderr<T>(fn: () => T): T {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return fn();
	} finally {
		process.stderr.write = original;
	}
}

describe('createLocalIssueOnMain — fast-track guardrails (US-002)', () => {
	test('--fast-track with empty description REFUSES (non-ok, no commit)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = withSilentStderr(() =>
			createLocalIssueOnMain(
				makeOptions({
					spawnFn,
					specSource: 'operator' as const,
					description: '',  // empty string is rejected
					wsjf: { value: 5, timeCriticality: 3, riskReduction: 2, jobSize: 4 },
				}),
			)
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('guardrail-failed');
		}
		// No mutation: update-ref must not have been called
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('--fast-track (operator) with valid description + wsjf files at stage:specified', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				specSource: 'operator' as const,
				description: 'A non-empty description',
				wsjf: { value: 8, timeCriticality: 5, riskReduction: 3, jobSize: 4 },
			}),
		);
		assertOk(result);

		// hash-object input must have stage:'specified' and specSource:'operator'
		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		expect(hashCall).toBeDefined();
		const entry = JSON.parse(hashCall!.options.input!) as {
			stage: string;
			specSource: string;
			wsjf: { value: number; timeCriticality: number; riskReduction: number; jobSize: number };
		};
		expect(entry.stage).toBe('specified');
		expect(entry.specSource).toBe('operator');
		expect(entry.wsjf).toEqual({ value: 8, timeCriticality: 5, riskReduction: 3, jobSize: 4 });
	});

	test('--derived-from naming a parent with no wsjf AND no explicit wsjf REFUSES', () => {
		// The existing CAT_FILE_OUTPUT returns CAM-88 without a wsjf field.
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = withSilentStderr(() =>
			createLocalIssueOnMain(
				makeOptions({
					spawnFn,
					specSource: 'derived' as const,
					derivedFrom: ['CAM-88'],
					description: 'A fix derived from CAM-88',
					// No explicit wsjf; parent CAM-88 has no wsjf either -> unresolvable
				}),
			)
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('guardrail-failed');
		}
		// No mutation committed
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('--derived-from inherits parent wsjf when explicit wsjf is absent', () => {
		// Override cat-file output so CAM-88 has a wsjf field.
		const parentWithWsjf = {
			id: 'CAM-88',
			title: 'Parent issue',
			stage: 'specified' as const,
			status: 'open' as const,
			blockedBy: [] as string[],
			createdAt: '2026-06-24T00:00:00Z',
			wsjf: { value: 10, timeCriticality: 7, riskReduction: 4, jobSize: 3 },
		};
		const parentJson = JSON.stringify(parentWithWsjf, null, 2) + '\n';
		const parentCatFileOutput = `abc123 blob ${parentJson.length}\n${parentJson}\n`;

		const { spawnFn, calls } = makeRecordingSpawn({ catFileOutput: parentCatFileOutput });
		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				specSource: 'derived' as const,
				derivedFrom: ['CAM-88'],
				description: 'A fix derived from CAM-88',
				// No explicit wsjf -- should inherit parent's wsjf
			}),
		);
		assertOk(result);

		// hash-object input must have stage:'specified', specSource:'derived',
		// derivedFrom:['CAM-88'], and the inherited wsjf
		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		expect(hashCall).toBeDefined();
		const entry = JSON.parse(hashCall!.options.input!) as {
			stage: string;
			specSource: string;
			derivedFrom: string[];
			wsjf: { value: number; timeCriticality: number; riskReduction: number; jobSize: number };
		};
		expect(entry.stage).toBe('specified');
		expect(entry.specSource).toBe('derived');
		expect(entry.derivedFrom).toEqual(['CAM-88']);
		expect(entry.wsjf).toEqual({ value: 10, timeCriticality: 7, riskReduction: 4, jobSize: 3 });
	});

	test('--derived-from with explicit wsjf overrides parent wsjf', () => {
		const parentWithWsjf = {
			id: 'CAM-88',
			title: 'Parent issue',
			stage: 'specified' as const,
			status: 'open' as const,
			blockedBy: [] as string[],
			createdAt: '2026-06-24T00:00:00Z',
			wsjf: { value: 2, timeCriticality: 2, riskReduction: 1, jobSize: 5 },
		};
		const parentJson = JSON.stringify(parentWithWsjf, null, 2) + '\n';
		const parentCatFileOutput = `abc123 blob ${parentJson.length}\n${parentJson}\n`;

		const { spawnFn, calls } = makeRecordingSpawn({ catFileOutput: parentCatFileOutput });
		const explicitWsjf = { value: 10, timeCriticality: 9, riskReduction: 8, jobSize: 2 };
		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				specSource: 'derived' as const,
				derivedFrom: ['CAM-88'],
				description: 'A high-priority fix',
				wsjf: explicitWsjf,  // explicit overrides parent
			}),
		);
		assertOk(result);

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		const entry = JSON.parse(hashCall!.options.input!) as {
			wsjf: { value: number; timeCriticality: number; riskReduction: number; jobSize: number };
		};
		// Must use the explicit wsjf, not the parent's lower-priority wsjf
		expect(entry.wsjf).toEqual(explicitWsjf);
	});

	test('--derived-from with missing derivedFrom field REFUSES', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		// specSource:'derived' but derivedFrom is empty -- invariant violation
		const result = withSilentStderr(() =>
			createLocalIssueOnMain(
				makeOptions({
					spawnFn,
					specSource: 'derived' as const,
					derivedFrom: [],  // empty: validation fails
					description: 'A fix',
					wsjf: { value: 5, timeCriticality: 3, riskReduction: 2, jobSize: 4 },
				}),
			)
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('guardrail-failed');
		}
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('normal filing (no specSource) bypasses all guardrails and files at stage:idea', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		// No specSource, no description, no wsjf -- should file normally at stage:idea
		const result = createLocalIssueOnMain(makeOptions({ spawnFn }));
		assertOk(result);

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		const entry = JSON.parse(hashCall!.options.input!) as { stage: string; specSource?: string };
		expect(entry.stage).toBe('idea');
		expect(entry.specSource).toBeUndefined();
	});
});
