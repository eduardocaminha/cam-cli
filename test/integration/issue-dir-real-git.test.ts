// test/integration/issue-dir-real-git.test.ts
//
// Integration tests (REAL git): proves behavioral correctness of the
// file-per-issue system against an actual git repo in a tmpdir.
//
// Four behavioral proofs required by US-010 (CAM-90 cutover):
//
//   AC#1: Migration idempotency
//         migrateIssuesToDir converts a multi-issue issues.local.json to the
//         per-file dir in ONE atomic commit; a second run is a no-op
//         (issues.local.json absent -> no new commit).
//
//   AC#2: CAS concurrent-commit guard
//         When another writer advances main between our read and our update-ref,
//         the CAS fails, writeIssueFile re-reads + re-allocates, and succeeds
//         on the retry. No commit is lost.
//
//   AC#3: allocateId race -- distinct sequential ids
//         Two back-to-back writeIssueFile calls against a moving main produce
//         two distinct, sequential ids (the second sees the first's commit).
//
//   AC#4: Cross-branch read
//         A just-filed issue committed to main via writeIssueFile is
//         immediately visible from another branch via readBacklogFromMain
//         (read-from-main cross-branch invariant).
//
// Pattern mirrors test/integration/issue-file-on-main.test.ts:
//   - skip when git absent
//   - mkdtempSync tmpdir, afterEach cleanup
//   - realSpawnFn wrapping spawnSync
//   - assert with real git show / git log / git rev-parse / git ls-files

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	migrateIssuesToDir,
} from '../../scripts/cam/migrate-issues-schema.ts';
import {
	writeIssueFile,
	type WriteIssueFileOptions,
} from '../../src/issues/alloc.ts';
import {
	readBacklogFromMain,
} from '../../src/issues/backlog.ts';
import type { SpawnFn } from '../../src/git/on-main.ts';
import type { IssueEntry } from '../../src/issues/types.ts';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];

afterEach(() => {
	for (const d of dirsToCleanup) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	dirsToCleanup.length = 0;
});

// ---------------------------------------------------------------------------
// realSpawnFn: forwards env + input to real git
// ---------------------------------------------------------------------------

const realSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Repo factory helpers
// ---------------------------------------------------------------------------

const PROJECT_TOML = 'issue_prefix = "CAM"\nissue_system = "local"\n';
const FIXED_CLOCK = '2026-06-28T12:00:00.000Z';

interface RepoHandles {
	dir: string;
	run: (args: string[]) => SpawnSyncReturns<string>;
	camDir: string;
	issuesDir: string;
}

function git(dir: string, args: string[]): SpawnSyncReturns<string> {
	return spawnSync('git', ['-C', dir, ...args], {
		stdio: 'pipe',
		encoding: 'utf8',
	}) as SpawnSyncReturns<string>;
}

function stdout(r: SpawnSyncReturns<string>): string {
	return (r.stdout as string ?? '').trim();
}

/**
 * Create a fresh git repo in an OS temp dir.
 *
 * Commits project.toml and a seed issues dir on main. When seedIssues is
 * non-empty, each entry is written as a CAM-NNNN.json per-file entry. When
 * seedIssuesLocalJson is provided, it is written as scripts/cam/issues.local.json
 * instead (for migration tests).
 */
function makeTmpRepo(opts: {
	seedIssues?: IssueEntry[];
	seedIssuesLocalJson?: string;
} = {}): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-dir-git-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => git(dir, args);

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	const issuesDir = join(camDir, 'issues');
	mkdirSync(issuesDir, { recursive: true });
	writeFileSync(join(camDir, 'project.toml'), PROJECT_TOML);

	if (opts.seedIssuesLocalJson !== undefined) {
		// For migration tests: seed the monolithic array file.
		writeFileSync(join(camDir, 'issues.local.json'), opts.seedIssuesLocalJson);
	} else if (opts.seedIssues !== undefined) {
		// For CAS / cross-branch tests: seed per-file entries.
		for (const entry of opts.seedIssues) {
			const n = parseInt(entry.id.split('-').at(-1) ?? '0', 10);
			const filename = `CAM-${String(n).padStart(4, '0')}.json`;
			writeFileSync(
				join(issuesDir, filename),
				JSON.stringify(entry, null, 2) + '\n',
			);
		}
	}

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run, camDir, issuesDir };
}

function makeIssueEntry(id: string): IssueEntry {
	return {
		id,
		title: `Issue ${id}`,
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: FIXED_CLOCK,
		updatedAt: FIXED_CLOCK,
	};
}

/** Build issues.local.json content for an array of IssueEntry. */
function makeIssuesLocalJson(entries: IssueEntry[]): string {
	return JSON.stringify({ next_id: entries.length + 1, issues: entries }, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// AC#1: Migration idempotency
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'AC#1-a: migrateIssuesToDir converts multi-issue array to per-file dir in one atomic commit',
	() => {
		const entries = [
			makeIssueEntry('CAM-1'),
			makeIssueEntry('CAM-2'),
			makeIssueEntry('CAM-90'),
		];
		const { dir, run } = makeTmpRepo({
			seedIssuesLocalJson: makeIssuesLocalJson(entries),
		});

		const mainSha0 = stdout(run(['rev-parse', 'main']));

		const result = migrateIssuesToDir(dir, realSpawnFn);

		// (a) Not a no-op
		expect(result.noOp).toBe(false);
		expect(result.issueCount).toBe(3);
		expect(typeof result.sha).toBe('string');
		expect((result.sha ?? '').length).toBeGreaterThan(0);

		// (b) main advanced by exactly one commit
		const mainSha1 = stdout(run(['rev-parse', 'main']));
		expect(mainSha1).not.toBe(mainSha0);
		const commitCount = stdout(run(['rev-list', '--count', mainSha0 + '..main']));
		expect(commitCount).toBe('1');

		// (c) issues.local.json is ABSENT from main
		const showOld = run(['show', 'main:scripts/cam/issues.local.json']);
		expect(showOld.status).not.toBe(0);

		// (d) every issue is present as CAM-NNNN.json on main
		const show1 = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		expect(show1.status).toBe(0);
		const entry1 = JSON.parse(show1.stdout as string) as IssueEntry;
		expect(entry1.id).toBe('CAM-1');
		expect(entry1.stage).toBe('idea');

		const show2 = run(['show', 'main:scripts/cam/issues/CAM-0002.json']);
		expect(show2.status).toBe(0);
		const entry2 = JSON.parse(show2.stdout as string) as IssueEntry;
		expect(entry2.id).toBe('CAM-2');

		// 4-digit zero-padding: CAM-90 -> CAM-0090.json
		const show90 = run(['show', 'main:scripts/cam/issues/CAM-0090.json']);
		expect(show90.status).toBe(0);
		const entry90 = JSON.parse(show90.stdout as string) as IssueEntry;
		expect(entry90.id).toBe('CAM-90'); // id field is unpadded
	},
);

test.skipIf(!gitAvailable)(
	'AC#1-b: migrateIssuesToDir re-run is a no-op (no new commit) when issues.local.json is already absent',
	() => {
		const entries = [makeIssueEntry('CAM-1'), makeIssueEntry('CAM-2')];
		const { dir, run } = makeTmpRepo({
			seedIssuesLocalJson: makeIssuesLocalJson(entries),
		});

		// First run: migrate.
		const result1 = migrateIssuesToDir(dir, realSpawnFn);
		expect(result1.noOp).toBe(false);

		const mainShaAfterFirst = stdout(run(['rev-parse', 'main']));

		// Second run: issues.local.json is absent -> no-op.
		const result2 = migrateIssuesToDir(dir, realSpawnFn);
		expect(result2.noOp).toBe(true);
		expect(result2.issueCount).toBe(0);
		expect(result2.sha).toBeUndefined();

		// main HEAD unchanged: no new commit was created.
		const mainShaAfterSecond = stdout(run(['rev-parse', 'main']));
		expect(mainShaAfterSecond).toBe(mainShaAfterFirst);
	},
);

// ---------------------------------------------------------------------------
// AC#2: CAS concurrent-commit guard
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'AC#2: CAS failure causes writeIssueFile to re-read+rebuild; no commit is lost',
	() => {
		// Seed: CAM-5 already committed.
		const { dir, run } = makeTmpRepo({
			seedIssues: [makeIssueEntry('CAM-5')],
		});

		const mainSha0 = stdout(run(['rev-parse', 'main']));

		let updateRefCallCount = 0;

		// Intercepting SpawnFn: first update-ref call simulates CAS contention.
		// Before returning failure, it advances main with an empty commit to
		// ensure the CAS comparison (old sha) is now stale.
		const interceptingSpawnFn: SpawnFn = (cmd, args, opts) => {
			const isUpdateRef =
				args.includes('update-ref') &&
				args.some((a) => a === 'refs/heads/main');

			if (isUpdateRef && updateRefCallCount === 0) {
				updateRefCallCount++;
				// Advance main before returning failure (simulates concurrent writer).
				git(dir, ['commit', '--allow-empty', '-m', 'chore: concurrent interlooper']);
				// Return failure to trigger the CAS retry path.
				return {
					pid: 0,
					output: [],
					stdout: '',
					stderr: 'update-ref: CAS contention (simulated)',
					status: 1,
					signal: null,
				} as SpawnSyncReturns<string>;
			}

			return realSpawnFn(cmd, args, opts);
		};

		const writeOpts: WriteIssueFileOptions = {
			cwd: dir,
			title: 'Issue written after CAS recovery',
			spawnFn: interceptingSpawnFn,
			createdAt: FIXED_CLOCK,
		};
		const result = writeIssueFile(writeOpts);

		// (a) Exactly one intercepted update-ref call (first attempt) + one real one (retry).
		expect(updateRefCallCount).toBe(1);

		// (b) writeIssueFile succeeded with CAM-6 (seed was CAM-5, no new issues from interlooper).
		expect(result.id).toBe('CAM-6');
		expect(result.filename).toBe('scripts/cam/issues/CAM-0006.json');
		expect(result.sha.length).toBeGreaterThan(0);

		// (c) main advanced by exactly TWO commits: interlooper + the successful write.
		const commitCount = stdout(run(['rev-list', '--count', mainSha0 + '..main']));
		expect(commitCount).toBe('2');

		// (d) CAM-0006.json is present on main.
		const show6 = run(['show', 'main:scripts/cam/issues/CAM-0006.json']);
		expect(show6.status).toBe(0);
		const entry6 = JSON.parse(show6.stdout as string) as IssueEntry;
		expect(entry6.id).toBe('CAM-6');
		expect(entry6.title).toBe('Issue written after CAS recovery');

		// (e) Original CAM-0005.json is still on main (no lost commits).
		const show5 = run(['show', 'main:scripts/cam/issues/CAM-0005.json']);
		expect(show5.status).toBe(0);
		const entry5 = JSON.parse(show5.stdout as string) as IssueEntry;
		expect(entry5.id).toBe('CAM-5');
	},
);

// ---------------------------------------------------------------------------
// AC#3: allocateId race -- distinct sequential ids
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'AC#3: two back-to-back writeIssueFile calls against a moving main yield distinct sequential ids',
	() => {
		// Seed: empty issues dir (no issues yet).
		const { dir, run } = makeTmpRepo({ seedIssues: [] });

		const mainSha0 = stdout(run(['rev-parse', 'main']));

		// Writer A: first allocation. Reads max=0, allocates CAM-1.
		const resultA = writeIssueFile({
			cwd: dir,
			title: 'Writer A issue',
			spawnFn: realSpawnFn,
			createdAt: FIXED_CLOCK,
		});

		// main has advanced by one commit (Writer A's commit).
		const mainSha1 = stdout(run(['rev-parse', 'main']));
		expect(mainSha1).not.toBe(mainSha0);

		// Writer B: second allocation. Must read updated main (max=1) and allocate CAM-2.
		const resultB = writeIssueFile({
			cwd: dir,
			title: 'Writer B issue',
			spawnFn: realSpawnFn,
			createdAt: FIXED_CLOCK,
		});

		// (a) Distinct sequential ids.
		expect(resultA.id).not.toBe(resultB.id);
		const nA = parseInt(resultA.id.split('-').at(-1) ?? '0', 10);
		const nB = parseInt(resultB.id.split('-').at(-1) ?? '0', 10);
		// One is 1 and the other is 2 (sequential).
		expect(Math.abs(nA - nB)).toBe(1);
		// Both are positive (real allocations).
		expect(nA).toBeGreaterThan(0);
		expect(nB).toBeGreaterThan(0);

		// (b) Both files exist on main.
		const showA = run([
			'show',
			`main:${resultA.filename}`,
		]);
		expect(showA.status).toBe(0);
		const entryA = JSON.parse(showA.stdout as string) as IssueEntry;
		expect(entryA.id).toBe(resultA.id);

		const showB = run([
			'show',
			`main:${resultB.filename}`,
		]);
		expect(showB.status).toBe(0);
		const entryB = JSON.parse(showB.stdout as string) as IssueEntry;
		expect(entryB.id).toBe(resultB.id);

		// (c) main advanced by exactly two commits from baseline.
		const commitCount = stdout(run(['rev-list', '--count', mainSha0 + '..main']));
		expect(commitCount).toBe('2');
	},
);

// AC#3 additional: CAS loser re-allocates a fresh id (not the stale one it
// attempted on the first try).
test.skipIf(!gitAvailable)(
	'AC#3-b: CAS retry re-allocates a new id when another writer committed a file between attempts',
	() => {
		// Seed: empty issues dir.
		const { dir, run } = makeTmpRepo({ seedIssues: [] });

		let casAttempts = 0;

		// Intercepting SpawnFn: on the first update-ref call, simulate a
		// concurrent writer that filed CAM-1 (advancing main with a real file).
		const interceptingSpawnFn: SpawnFn = (cmd, args, opts) => {
			const isUpdateRef =
				args.includes('update-ref') &&
				args.some((a) => a === 'refs/heads/main');

			if (isUpdateRef && casAttempts === 0) {
				casAttempts++;

				// Concurrent writer: file CAM-1 using real git plumbing via realSpawnFn.
				// This is a simplified direct write to advance main.
				const cam1Entry: IssueEntry = {
					id: 'CAM-1',
					title: 'Concurrent writer filed this',
					stage: 'idea',
					status: 'open',
					blockedBy: [],
					createdAt: FIXED_CLOCK,
					updatedAt: FIXED_CLOCK,
				};
				writeIssueFile({
					cwd: dir,
					title: 'Concurrent writer filed this',
					spawnFn: realSpawnFn,
					createdAt: FIXED_CLOCK,
					// Provide the entry content inline via a one-shot wrapper.
				});
				// Discard result; the important thing is main now has CAM-1.
				void cam1Entry;

				// Return CAS failure so the caller retries.
				return {
					pid: 0,
					output: [],
					stdout: '',
					stderr: 'update-ref: CAS contention (simulated)',
					status: 1,
					signal: null,
				} as SpawnSyncReturns<string>;
			}

			return realSpawnFn(cmd, args, opts);
		};

		// Writer A: first attempt fails, re-reads max (1 from concurrent), re-allocates CAM-2.
		const resultA = writeIssueFile({
			cwd: dir,
			title: 'Writer A that loses CAS first',
			spawnFn: interceptingSpawnFn,
			createdAt: FIXED_CLOCK,
		});

		// Writer A must have been allocated CAM-2 (not CAM-1, which was taken).
		expect(resultA.id).toBe('CAM-2');

		// Both CAM-1 (concurrent) and CAM-2 (Writer A retry) exist on main.
		const show1 = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		expect(show1.status).toBe(0);
		const entry1 = JSON.parse(show1.stdout as string) as IssueEntry;
		expect(entry1.id).toBe('CAM-1');

		const show2 = run(['show', 'main:scripts/cam/issues/CAM-0002.json']);
		expect(show2.status).toBe(0);
		const entry2 = JSON.parse(show2.stdout as string) as IssueEntry;
		expect(entry2.id).toBe('CAM-2');
		expect(entry2.title).toBe('Writer A that loses CAS first');
	},
);

// ---------------------------------------------------------------------------
// Accented UTF-8 content (byte-vs-char regression, US-R1-001)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'AC#5: readBacklogFromMain returns all entries when issue titles contain multi-byte UTF-8 (accented Portuguese)',
	() => {
		// Regression: git cat-file --batch reports <size> in BYTES, but the old
		// parseBatchOutput sliced by CHARACTERS.  For blobs containing multi-byte
		// code points (e.g. "ç"=2 bytes, "ã"=2 bytes), the slice over-read and
		// JSON.parse failed; subsequent entries were desynchronised and silently
		// dropped.  Over the real 129-issue repo backlog, 38 entries were lost.

		// Seed: one ASCII issue already committed.
		const { dir, run } = makeTmpRepo({ seedIssues: [makeIssueEntry('CAM-1')] });

		const mainSha0 = stdout(run(['rev-parse', 'main']));

		// File two issues with accented titles via writeIssueFile (commit to main).
		const resultA = writeIssueFile({
			cwd: dir,
			title: 'migração de configuração',
			spawnFn: realSpawnFn,
			createdAt: FIXED_CLOCK,
		});
		const resultB = writeIssueFile({
			cwd: dir,
			title: 'cancelação e integração contínua',
			spawnFn: realSpawnFn,
			createdAt: FIXED_CLOCK,
		});

		// Verify allocations are sequential after CAM-1.
		expect(resultA.id).toBe('CAM-2');
		expect(resultB.id).toBe('CAM-3');

		// main advanced by two commits.
		const commitCount = stdout(run(['rev-list', '--count', mainSha0 + '..main']));
		expect(commitCount).toBe('2');

		// readBacklogFromMain must return ALL THREE entries (CAM-1, CAM-2, CAM-3).
		const backlogSpawnFn = (
			c: string,
			a: string[],
			o: { encoding: 'utf8'; input?: string },
		) => realSpawnFn(c, a, o);

		const backlog = readBacklogFromMain(dir, backlogSpawnFn);

		expect(backlog).toHaveLength(3);

		// Verify each entry is present with the correct accented title.
		const byId = Object.fromEntries(backlog.map((e) => [e.id, e]));

		expect(byId['CAM-1']?.title).toBe('Issue CAM-1');
		expect(byId['CAM-2']?.title).toBe('migração de configuração');
		expect(byId['CAM-3']?.title).toBe('cancelação e integração contínua');

		// Verify entries are sorted numerically ascending.
		expect(backlog[0]?.id).toBe('CAM-1');
		expect(backlog[1]?.id).toBe('CAM-2');
		expect(backlog[2]?.id).toBe('CAM-3');
	},
);

// ---------------------------------------------------------------------------
// AC#4: Cross-branch read
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'AC#4: a just-filed issue committed to main is immediately visible from another branch via readBacklogFromMain',
	() => {
		// Seed: one existing issue (CAM-5).
		const { dir, run } = makeTmpRepo({
			seedIssues: [makeIssueEntry('CAM-5')],
		});

		// Checkout a feature branch (simulating a developer on a non-main branch).
		run(['checkout', '-b', 'feat/my-feature']);
		const branchName = stdout(run(['rev-parse', '--abbrev-ref', 'HEAD']));
		expect(branchName).toBe('feat/my-feature');

		// Capture feature branch HEAD before filing the issue.
		const featureSha0 = stdout(run(['rev-parse', 'HEAD']));

		// File CAM-6 on main from this feature branch.
		const fileResult = writeIssueFile({
			cwd: dir,
			title: 'Filed from feature branch',
			spawnFn: realSpawnFn,
			createdAt: FIXED_CLOCK,
		});
		expect(fileResult.id).toBe('CAM-6');

		// Feature branch HEAD is unchanged (we filed on main, not on the branch).
		const featureSha1 = stdout(run(['rev-parse', 'HEAD']));
		expect(featureSha1).toBe(featureSha0);

		// Working tree is clean (no working-tree side effects).
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');

		// The just-filed issue is immediately visible from the feature branch
		// via readBacklogFromMain (reads from the main ref, not the current branch).
		const backlogSpawnFn = (
			c: string,
			a: string[],
			o: { encoding: 'utf8'; input?: string },
		) => realSpawnFn(c, a, o);

		const backlog = readBacklogFromMain(dir, backlogSpawnFn);

		// Both CAM-5 (seed) and CAM-6 (just filed) must be present.
		expect(backlog.length).toBe(2);

		const ids = backlog.map((e) => e.id);
		expect(ids).toContain('CAM-5');
		expect(ids).toContain('CAM-6');

		// Entries are sorted numerically ascending.
		expect(backlog[0]!.id).toBe('CAM-5');
		expect(backlog[1]!.id).toBe('CAM-6');
		expect(backlog[1]!.title).toBe('Filed from feature branch');
	},
);
