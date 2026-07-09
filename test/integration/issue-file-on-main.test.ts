// test/integration/issue-file-on-main.test.ts
//
// Integration test (REAL git): regression guard for createLocalIssueOnMain.
//
// US-004 cutover: createLocalIssueOnMain now uses writeIssueFile which:
//   - allocates the next id as max(ids on main) + 1 (from ls-tree)
//   - writes one scripts/cam/issues/CAM-NNNN.json atomically via CAS update-ref
//   - issues.local.json is never touched
//
// Two test cases:
//   Case A (off-main): checkout a feature branch, call createLocalIssueOnMain,
//     assert git show main shows the new per-file entry, feature-branch HEAD
//     unchanged, working tree clean.
//   Case B (on-main): call createLocalIssueOnMain while checked out on main,
//     assert a direct CAS commit lands and the per-file entry is visible.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createLocalIssueOnMain,
	type SpawnFn,
} from '../../src/commands/issue-file.ts';
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
// realSpawnFn: forwards env (GIT_INDEX_FILE) and input (hash-object --stdin)
// ---------------------------------------------------------------------------

const realSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_TOML = 'issue_prefix = "CAM"\nissue_system = "local"\n';
const FIXED_CLOCK = '2026-06-25T12:00:00.000Z';

function toJson(entry: IssueEntry): string {
	return JSON.stringify(entry, null, 2) + '\n';
}

interface RepoHandles {
	dir: string;
	run: (args: string[]) => ReturnType<typeof spawnSync>;
	camDir: string;
	issuesDir: string;
}

/**
 * Create a fresh, isolated git repo in an OS temp dir.
 *
 * Seeds scripts/cam/issues/ with a seed file CAM-NNNN.json (so that
 * allocateId returns seedId + 1) and project.toml on main.
 *
 * @param seedId  The max id already in the issues dir (next allocated = seedId + 1).
 *                Pass 0 for an empty issues dir (allocates CAM-1).
 */
function makeTmpRepo(seedId: number): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-issue-file-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	const issuesDir = join(camDir, 'issues');
	mkdirSync(issuesDir, { recursive: true });
	writeFileSync(join(camDir, 'project.toml'), PROJECT_TOML);

	if (seedId > 0) {
		// Create one seed file so allocateId returns seedId + 1
		const seedEntry: IssueEntry = {
			id: `CAM-${seedId}`,
			title: `Seed issue ${seedId}`,
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00.000Z',
		};
		const paddedName = `CAM-${String(seedId).padStart(4, '0')}.json`;
		writeFileSync(join(issuesDir, paddedName), toJson(seedEntry));
	}

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run, camDir, issuesDir };
}

// ---------------------------------------------------------------------------
// Case A (off-main)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'Case A (off-main): new entry lands on main; feature-branch HEAD and working tree untouched',
	() => {
		// Seed with CAM-0009 so next id is CAM-10
		const { dir, run } = makeTmpRepo(9);

		// Capture baseline main SHA
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		// Checkout a feature branch
		run(['checkout', '-b', 'feat/test-issue']);
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('feat/test-issue');

		// Capture feature-branch HEAD before calling the function
		const featureSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = createLocalIssueOnMain({
			cwd: dir,
			title: 'Test integration issue A',
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			readProjectToml: () => PROJECT_TOML,
		});

		// Guard: no remote configured in tmpdir, so up-to-date check is skipped
		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		// (a) result shape
		expect(result.id).toBe('CAM-10');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(false);

		// (b) new per-file entry exists on main
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0010.json']);
		expect((showResult.status as number)).toBe(0);
		const entry = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(entry.id).toBe('CAM-10');
		expect(entry.title).toBe('Test integration issue A');
		expect(entry.stage).toBe('idea');
		expect(entry.createdAt).toBe(FIXED_CLOCK);

		// (c) commit message on main
		const logMsg = run(['log', 'main', '-1', '--format=%s']);
		expect((logMsg.stdout as string).trim()).toBe('chore(cam): file CAM-10');

		// (d) main advanced by one commit
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (e) feature-branch HEAD is unchanged
		const featureSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureSha1).toBe(featureSha0);

		// (f) working tree is clean
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');

		// US-004: issues.local.json does NOT exist on main
		const oldFileResult = run(['show', 'main:scripts/cam/issues.local.json']);
		expect((oldFileResult.status as number)).not.toBe(0);
	},
	{ timeout: 20_000 },
);

// ---------------------------------------------------------------------------
// Case B (on-main)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'Case B (on-main): direct commit on main; working-tree file contains the new entry',
	() => {
		// Seed with CAM-0019 so next id is CAM-20
		const { dir, run } = makeTmpRepo(19);

		// Confirm we ARE on main
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('main');

		const mainSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = createLocalIssueOnMain({
			cwd: dir,
			title: 'Test integration issue B',
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			readProjectToml: () => PROJECT_TOML,
		});

		// Guard: no remote configured in tmpdir, so up-to-date check is skipped
		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		// (a) result shape
		expect(result.id).toBe('CAM-20');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(true);

		// (b) main advanced by one commit
		const mainSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (c) HEAD commit message (no title suffix in per-file format)
		const logMsg = run(['log', '-1', '--format=%s']);
		expect((logMsg.stdout as string).trim()).toBe('chore(cam): file CAM-20');

		// (d) per-file entry is on main
		// Note: writeIssueFile always uses CAS (update-ref), which never writes to
		// the working tree. So on-main path also commits via CAS (same as off-main).
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0020.json']);
		expect((showResult.status as number)).toBe(0);
		const entry = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(entry.id).toBe('CAM-20');
		expect(entry.title).toBe('Test integration issue B');
		expect(entry.stage).toBe('idea');

		// US-004: issues.local.json does NOT exist on main
		const oldFileResult = run(['show', 'main:scripts/cam/issues.local.json']);
		expect((oldFileResult.status as number)).not.toBe(0);
	},
	{ timeout: 20_000 },
);
