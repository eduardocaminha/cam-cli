// test/issue-file.test.ts
//
// Unit tests for createLocalIssueOnMain() in src/commands/issue-file.ts.
//
// Coverage (per US-001 acceptance criteria):
//   (a) on-main path: writes working-tree file, git-adds, git-commits
//   (b) off-main path: uses git plumbing (read-tree, hash-object, update-index,
//       write-tree, commit-tree, update-ref); working tree NOT touched
//   (c) off-main path: spawnFn receives GIT_INDEX_FILE via options.env AND the
//       serialized JSON via options.input for hash-object (widened SpawnFn type)
//   (d) id allocation: reads from main, not working tree; next_id is bumped;
//       entry has state='open', createdAt from clock(), optional priority
//   (e) commit message has the exact form 'chore(cam): file <id> (<title>)'
//   (f) serialization: JSON.stringify(data, null, 2) + '\n'
//
// All external I/O is faked via injectable deps; no real git binary or
// filesystem is exercised (except for the mkdtempSync call inside createLocal-
// IssueOnMain on the off-main path, which is a non-git operation and creates
// an empty temp dir that is cleaned up by the finally block).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	createLocalIssueOnMain,
	type CreateLocalIssueOnMainOptions,
	type SpawnFn,
} from '../src/commands/issue-file.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = '2026-06-25T10:00:00.000Z';
const clock = () => FIXED_TS;

const PROJECT_TOML = 'issue_system = "none"\nissue_prefix = "CAM"\n';

const BASE_BACKLOG = {
	next_id: 89,
	issues: [
		{ id: 'CAM-88', title: 'Previous issue', state: 'open', createdAt: '2026-06-24T00:00:00Z' },
	],
};

const BACKLOG_JSON = JSON.stringify(BASE_BACKLOG, null, 2) + '\n';

/** Minimal SpawnSyncReturns<string> for a successful git call. */
function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

interface SpawnCall {
	cmd: string;
	args: string[];
	options: { encoding: 'utf8'; env?: Record<string, string>; input?: string };
}

interface RecordingSpawnOpts {
	/** What branch `git rev-parse --abbrev-ref HEAD` reports. Default 'main'. */
	branch?: string;
	/** Full SHA returned by `git rev-parse main`. Default 'mainsha1234567890'. */
	mainSha?: string;
	/** SHA returned by `git hash-object`. Default 'blobsha1234'. */
	blobSha?: string;
	/** SHA returned by `git write-tree`. Default 'treesha1234'. */
	treeSha?: string;
	/** Full commit SHA returned by `git commit-tree`. Default 'newcommitsha1234567'. */
	newCommitSha?: string;
	/** Short SHA returned by `git rev-parse --short HEAD` (on-main path). Default 'abc1234'. */
	shortSha?: string;
}

function makeRecordingSpawn(opts: RecordingSpawnOpts = {}): {
	spawnFn: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const branch = opts.branch ?? 'main';
	const mainSha = opts.mainSha ?? 'mainsha1234567890';
	const blobSha = opts.blobSha ?? 'blobsha1234';
	const treeSha = opts.treeSha ?? 'treesha1234';
	const newCommitSha = opts.newCommitSha ?? 'newcommitsha1234567';
	const shortSha = opts.shortSha ?? 'abc1234';

	const spawnFn: SpawnFn = (cmd, args, options) => {
		calls.push({ cmd, args, options });

		// git rev-parse --abbrev-ref HEAD -> current branch
		if (args.includes('rev-parse') && args.includes('--abbrev-ref') && args.includes('HEAD')) {
			return okResult(branch + '\n');
		}

		// git show main:scripts/cam/issues.local.json -> backlog JSON
		if (args.includes('show') && args.some((a) => a.includes('issues.local.json'))) {
			return okResult(BACKLOG_JSON);
		}

		// git hash-object -> blob sha
		if (args.includes('hash-object')) {
			return okResult(blobSha + '\n');
		}

		// git write-tree -> tree sha
		if (args.includes('write-tree')) {
			return okResult(treeSha + '\n');
		}

		// git rev-parse main -> main commit sha
		if (args.includes('rev-parse') && args.includes('main') && !args.includes('--abbrev-ref') && !args.includes('--short')) {
			return okResult(mainSha + '\n');
		}

		// git commit-tree -> new commit sha
		if (args.includes('commit-tree')) {
			return okResult(newCommitSha + '\n');
		}

		// git rev-parse --short HEAD -> short sha (on-main path)
		if (args.includes('rev-parse') && args.includes('--short') && args.includes('HEAD')) {
			return okResult(shortSha + '\n');
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
// (a) On-main path: writes working-tree file, git-adds, git-commits
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — on-main path', () => {
	test('calls writeFile, git add, and git commit when branch is main', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'main', shortSha: 'def5678' });
		let writtenPath: string | null = null;
		let writtenText: string | null = null;

		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				writeFile: (p, t) => {
					writtenPath = p;
					writtenText = t;
				},
			}),
		);

		// Return value
		expect(result.id).toBe('CAM-89');
		expect(result.committedTo).toBe('main');
		expect(result.sha).toBe('def5678');
		expect(result.branchWasMain).toBe(true);

		// writeFile was called with the correct path
		expect(writtenPath).not.toBeNull();
		expect(writtenPath!).toContain('scripts/cam/issues.local.json');

		// writeFile received properly serialized JSON with trailing newline
		expect(writtenText).not.toBeNull();
		const parsed = JSON.parse(writtenText!);
		expect(parsed.next_id).toBe(90);
		expect(parsed.issues).toHaveLength(2);
		const newEntry = parsed.issues.find((i: { id: string }) => i.id === 'CAM-89');
		expect(newEntry).toBeDefined();
		expect(newEntry?.state).toBe('open');
		expect(newEntry?.createdAt).toBe(FIXED_TS);
		expect(newEntry?.title).toBe('Test issue title');
		// Serialization: JSON.stringify(data, null, 2) + '\n'
		expect(writtenText!.endsWith('\n')).toBe(true);
		expect(writtenText!).toBe(JSON.stringify(parsed, null, 2) + '\n');

		// git add scripts/cam/issues.local.json
		const addCall = calls.find(
			(c) => c.args.includes('add') && c.args.includes('scripts/cam/issues.local.json'),
		);
		expect(addCall).toBeDefined();

		// git commit with exact message
		const commitCall = calls.find((c) => c.args.includes('commit') && c.args.includes('-m'));
		expect(commitCall).toBeDefined();
		const msgIdx = commitCall!.args.indexOf('-m');
		expect(commitCall!.args[msgIdx + 1]).toBe('chore(cam): file CAM-89 (Test issue title)');

		// git rev-parse --short HEAD (to get sha)
		const shaCall = calls.find(
			(c) => c.args.includes('rev-parse') && c.args.includes('--short') && c.args.includes('HEAD'),
		);
		expect(shaCall).toBeDefined();
	});

	test('on-main path does NOT call commit-tree or update-ref', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'main' });
		createLocalIssueOnMain(makeOptions({ spawnFn, writeFile: () => {} }));

		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	});

	test('includes optional priority field when provided', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'main' });
		let writtenText: string | null = null;

		createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				title: 'Priority issue',
				priority: 'P0',
				writeFile: (_, t) => { writtenText = t; },
			}),
		);

		expect(writtenText).not.toBeNull();
		const parsed = JSON.parse(writtenText!);
		const entry = parsed.issues.find((i: { id: string }) => i.id === 'CAM-89');
		expect(entry?.priority).toBe('P0');
	});

	test('omits priority field when not provided', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'main' });
		let writtenText: string | null = null;

		createLocalIssueOnMain(makeOptions({ spawnFn, writeFile: (_, t) => { writtenText = t; } }));

		const parsed = JSON.parse(writtenText!);
		const entry = parsed.issues.find((i: { id: string }) => i.id === 'CAM-89');
		expect(entry?.priority).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (b) Off-main path: git plumbing; working tree untouched
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — off-main path', () => {
	test('returns branchWasMain=false and uses plumbing commands', () => {
		const { spawnFn } = makeRecordingSpawn({
			branch: 'cam/CAM-86-feature',
			newCommitSha: 'abcdef1234567',
		});

		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				writeFile: () => {
					throw new Error('writeFile must NOT be called in the off-main path');
				},
			}),
		);

		expect(result.id).toBe('CAM-89');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(false);
		// sha is the first 7 chars of the new commit sha
		expect(result.sha).toBe('abcdef1');
	});

	test('does NOT call writeFile in the off-main path', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'cam/feature' });
		let writeFileCalled = false;

		createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				writeFile: () => { writeFileCalled = true; },
			}),
		);

		expect(writeFileCalled).toBe(false);
	});

	test('calls the full plumbing sequence in order', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		// Extract the plumbing subcommands in order
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

	test('read-tree uses "main" as the target', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const readTreeCall = calls.find((c) => c.args.includes('read-tree'));
		expect(readTreeCall).toBeDefined();
		expect(readTreeCall!.args).toContain('main');
	});

	test('update-index uses --add --cacheinfo with correct mode and path', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			branch: 'cam/feature',
			blobSha: 'myblob1234567890',
		});
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const updateIndexCall = calls.find((c) => c.args.includes('update-index'));
		expect(updateIndexCall).toBeDefined();
		expect(updateIndexCall!.args).toContain('--add');
		expect(updateIndexCall!.args).toContain('--cacheinfo');

		const cacheinfo = updateIndexCall!.args.find((a) => a.startsWith('100644,'));
		expect(cacheinfo).toBeDefined();
		expect(cacheinfo).toContain('myblob1234567890');
		expect(cacheinfo).toContain('scripts/cam/issues.local.json');
	});

	test('commit-tree uses -p <mainSha> and the exact commit message', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			branch: 'cam/feature',
			mainSha: 'maincommitsha999',
			treeSha: 'treesha999',
		});
		createLocalIssueOnMain(makeOptions({ spawnFn, title: 'My new issue' }));

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall).toBeDefined();
		expect(commitTreeCall!.args).toContain('treesha999');
		expect(commitTreeCall!.args).toContain('-p');
		expect(commitTreeCall!.args).toContain('maincommitsha999');
		expect(commitTreeCall!.args).toContain('-m');
		const msgIdx = commitTreeCall!.args.indexOf('-m');
		expect(commitTreeCall!.args[msgIdx + 1]).toBe('chore(cam): file CAM-89 (My new issue)');
	});

	test('update-ref advances refs/heads/main to the new commit sha', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			branch: 'cam/feature',
			newCommitSha: 'freshcommit0987654',
		});
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const updateRefCall = calls.find((c) => c.args.includes('update-ref'));
		expect(updateRefCall).toBeDefined();
		expect(updateRefCall!.args).toContain('refs/heads/main');
		expect(updateRefCall!.args).toContain('freshcommit0987654');
	});
});

// ---------------------------------------------------------------------------
// (c) Off-main: GIT_INDEX_FILE via options.env AND JSON via options.input
//     (pins the widened SpawnFn type; hash-object stdin cannot be bypassed)
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — widened SpawnFn: env + input injection', () => {
	test('read-tree receives GIT_INDEX_FILE in options.env', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const readTreeCall = calls.find((c) => c.args.includes('read-tree'));
		expect(readTreeCall).toBeDefined();
		expect(readTreeCall!.options.env).toBeDefined();
		expect(typeof readTreeCall!.options.env?.['GIT_INDEX_FILE']).toBe('string');
		expect((readTreeCall!.options.env?.['GIT_INDEX_FILE'] ?? '').length).toBeGreaterThan(0);
	});

	test('hash-object receives GIT_INDEX_FILE in options.env AND serialized JSON in options.input', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(makeOptions({ spawnFn, title: 'Injection test' }));

		const hashCall = calls.find((c) => c.args.includes('hash-object'));
		expect(hashCall).toBeDefined();

		// GIT_INDEX_FILE must be present in env
		expect(hashCall!.options.env).toBeDefined();
		expect(typeof hashCall!.options.env?.['GIT_INDEX_FILE']).toBe('string');
		expect((hashCall!.options.env?.['GIT_INDEX_FILE'] ?? '').length).toBeGreaterThan(0);

		// options.input must carry the serialized JSON with the new entry
		expect(typeof hashCall!.options.input).toBe('string');
		const parsed = JSON.parse(hashCall!.options.input ?? '{}');
		expect(parsed.next_id).toBe(90);
		const newEntry = parsed.issues.find((i: { id: string }) => i.id === 'CAM-89');
		expect(newEntry).toBeDefined();
		expect(newEntry?.title).toBe('Injection test');
		expect(newEntry?.state).toBe('open');
		// Trailing newline
		expect(hashCall!.options.input!.endsWith('\n')).toBe(true);
	});

	test('update-index receives GIT_INDEX_FILE in options.env', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const updateIndexCall = calls.find((c) => c.args.includes('update-index'));
		expect(updateIndexCall).toBeDefined();
		expect(updateIndexCall!.options.env?.['GIT_INDEX_FILE']).toBeDefined();
	});

	test('write-tree receives GIT_INDEX_FILE in options.env', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const writeTreeCall = calls.find((c) => c.args.includes('write-tree'));
		expect(writeTreeCall).toBeDefined();
		expect(writeTreeCall!.options.env?.['GIT_INDEX_FILE']).toBeDefined();
	});

	test('all GIT_INDEX_FILE paths within one call are identical (same temp index)', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(makeOptions({ spawnFn }));

		const indexCalls = calls.filter(
			(c) => c.options.env?.['GIT_INDEX_FILE'] !== undefined,
		);
		// read-tree, hash-object, update-index, write-tree all use the same index
		expect(indexCalls.length).toBeGreaterThanOrEqual(4);
		const paths = indexCalls.map((c) => c.options.env?.['GIT_INDEX_FILE']);
		const unique = new Set(paths);
		expect(unique.size).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// (d) Id allocation: reads from main, not working tree; next_id bumped
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — id allocation from main backlog', () => {
	test('reads backlog via git show main:scripts/cam/issues.local.json', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'main' });
		createLocalIssueOnMain(makeOptions({ spawnFn, writeFile: () => {} }));

		const showCall = calls.find(
			(c) => c.args.includes('show') && c.args.some((a) => a === 'main:scripts/cam/issues.local.json'),
		);
		expect(showCall).toBeDefined();
	});

	test('id is issue_prefix + next_id from the main backlog', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'main' });
		const result = createLocalIssueOnMain(
			makeOptions({ spawnFn, writeFile: () => {} }),
		);
		// BASE_BACKLOG has next_id: 89, issue_prefix is "CAM"
		expect(result.id).toBe('CAM-89');
	});

	test('defaults to issue_prefix=CAM when toml does not specify one', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'main' });
		const result = createLocalIssueOnMain(
			makeOptions({
				spawnFn,
				writeFile: () => {},
				readProjectToml: () => 'issue_system = "none"\n',
			}),
		);
		expect(result.id).toMatch(/^CAM-\d+/);
	});

	test('new entry has state=open and createdAt from clock()', () => {
		const { spawnFn } = makeRecordingSpawn({ branch: 'cam/feature' });
		let input: string | undefined;

		const customSpawn: SpawnFn = (cmd, args, opts) => {
			if (args.includes('hash-object')) {
				input = opts.input;
			}
			return spawnFn(cmd, args, opts);
		};
		createLocalIssueOnMain(makeOptions({ spawnFn: customSpawn }));

		expect(input).toBeDefined();
		const parsed = JSON.parse(input!);
		const entry = parsed.issues.find((i: { id: string }) => i.id === 'CAM-89');
		expect(entry?.state).toBe('open');
		expect(entry?.createdAt).toBe(FIXED_TS);
	});
});

// ---------------------------------------------------------------------------
// (e) Commit message: 'chore(cam): file <id> (<title>)'
// ---------------------------------------------------------------------------

describe('createLocalIssueOnMain — commit message', () => {
	test('on-main commit message matches the literal form', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'main' });
		createLocalIssueOnMain(
			makeOptions({ spawnFn, title: 'My Feature Issue', writeFile: () => {} }),
		);

		const commitCall = calls.find((c) => c.args.includes('commit') && c.args.includes('-m'));
		expect(commitCall).toBeDefined();
		const msgIdx = commitCall!.args.indexOf('-m');
		expect(commitCall!.args[msgIdx + 1]).toBe('chore(cam): file CAM-89 (My Feature Issue)');
	});

	test('off-main commit-tree message matches the literal form', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/feature' });
		createLocalIssueOnMain(
			makeOptions({ spawnFn, title: 'Another Issue' }),
		);

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall).toBeDefined();
		const msgIdx = commitTreeCall!.args.indexOf('-m');
		expect(commitTreeCall!.args[msgIdx + 1]).toBe('chore(cam): file CAM-89 (Another Issue)');
	});
});
