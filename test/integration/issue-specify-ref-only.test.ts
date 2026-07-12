// test/integration/issue-specify-ref-only.test.ts
//
// CAM-133 regression guard: specifyIssueOnMain must commit via commitTreeToMain
// even when checked out on main, so a stale working-tree/index cannot silently
// drop files that were previously added via ref-only writeIssueFile calls.
//
// The corruption scenario (pre-fix, commitOnMain path):
//   1. writeIssueFile(CAM-1) via ref-only CAS -> main has CAM-0001.json;
//      working tree/index does NOT have it (stale).
//   2. writeIssueFile(CAM-2) via ref-only CAS -> main has both CAM-0001.json
//      and CAM-0002.json; working tree/index still does NOT have either.
//   3. specifyIssueOnMain(CAM-1) while checked out on main.
//      BUG (pre-fix): commitOnMain staged only CAM-0001.json from the working
//      tree and committed from the stale index -- CAM-0002.json was absent from
//      the index, so the specify commit DROPPED it from main's tree.
//      FIX: commitTreeToMain reads from `read-tree main` (the real ref), so
//      ALL files in main's current tree survive the specify commit.
//
// Oracle: after step 3, git ls-tree count in scripts/cam/issues/ must be 2
//         (not 1). The test fails against the pre-fix code.

import { test, expect, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIssueFile } from '../../src/issues/alloc.ts';
import {
	specifyIssueOnMain,
	demoteIssueOnMain,
	type SpawnFn,
} from '../../src/commands/issue-specify.ts';
import type { Spec } from '../../src/issues/spec.ts';
import type { WsjfScore } from '../../src/issues/types.ts';

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
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SPEC: Spec = {
	acceptanceCriteria: ['It works'],
	scope: 'Limited to the foo module',
	gotchas: [],
	domainTerms: [],
};

const VALID_WSJF: WsjfScore = {
	value: 8,
	timeCriticality: 5,
	riskReduction: 3,
	jobSize: 2,
};

// ---------------------------------------------------------------------------
// Repo scaffold
// ---------------------------------------------------------------------------

function makeTmpRepo(): { dir: string; run: (args: string[]) => ReturnType<typeof spawnSync> } {
	const dir = mkdtempSync(join(tmpdir(), 'cam-specify-refonly-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	// Minimal initial commit so main exists (git tracks no empty dirs).
	writeFileSync(join(dir, 'README.md'), '# test repo\n');
	run(['add', 'README.md']);
	run(['commit', '-m', 'chore: initial']);

	return { dir, run };
}

// ---------------------------------------------------------------------------
// Regression test: chained ref-only write -> specifyIssueOnMain
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'chained ref-only writes survive specifyIssueOnMain: both prior files preserved on main',
	() => {
		// CAM-133 regression guard.
		const { dir, run } = makeTmpRepo();

		// Step 1: write CAM-1 ref-only (no working-tree mutation).
		const r1 = writeIssueFile({
			cwd: dir,
			title: 'Idea 1',
			spawnFn: realSpawnFn,
		});
		expect(r1.id).toBe('CAM-1');

		// Step 2: write CAM-2 ref-only (no working-tree mutation).
		const r2 = writeIssueFile({
			cwd: dir,
			title: 'Idea 2',
			spawnFn: realSpawnFn,
		});
		expect(r2.id).toBe('CAM-2');

		// Precondition: main has 2 issue files; working tree has neither.
		const lsBefore = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const filesBefore = (lsBefore.stdout as string).trim().split('\n').filter(Boolean);
		expect(filesBefore).toHaveLength(2);

		// Since US-001/CAM-142 (writeIssueFile worktree-sync fix), writeIssueFile calls
		// syncWorktreeIfOnMain after each CAS success, so the files ARE present in the
		// working tree. The pre-CAM-142 staleness condition no longer applies here;
		// the regression guard below (filesAfter.toHaveLength(2)) still validates that
		// specifyIssueOnMain does not drop files from main's tree.
		expect(existsSync(join(dir, 'scripts', 'cam', 'issues', 'CAM-0001.json'))).toBe(true);
		expect(existsSync(join(dir, 'scripts', 'cam', 'issues', 'CAM-0002.json'))).toBe(true);

		// Step 3: specifyIssueOnMain for CAM-1 while checked out on main.
		// PRE-FIX: commitOnMain staged only the written file from the stale working
		// tree/index, so CAM-0002.json was silently dropped from main's tree.
		// POST-FIX: commitTreeToMain does `read-tree main` in a temp index, which
		// loads the full main tree including CAM-0002.json, so it survives.
		const specResult = specifyIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spec: VALID_SPEC,
			wsjf: VALID_WSJF,
			spawnFn: realSpawnFn,
			clock: () => '2026-06-28T00:00:00.000Z',
			// Inject no-op eventSink so the default file logger does not crash
			// the tmpdir repo (pattern: patterns.md 'Writer-owned event emission
			// with default file sink').
			eventSink: () => {},
		});

		if (!specResult.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(specResult)}`);
		}

		expect(specResult.branchWasMain).toBe(true);
		expect(specResult.committedTo).toBe('main');

		// Oracle: BOTH prior issue files must survive the specify commit on main.
		const lsAfter = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const filesAfter = (lsAfter.stdout as string).trim().split('\n').filter(Boolean);
		// Count is preserved: specify mutated 1 file without dropping the prior 2.
		expect(filesAfter).toHaveLength(2);

		// Specifically: CAM-0001.json (mutated, now specified) and CAM-0002.json
		// (untouched, must not have been dropped).
		expect(filesAfter.some((f) => f.includes('CAM-0001.json'))).toBe(true);
		expect(filesAfter.some((f) => f.includes('CAM-0002.json'))).toBe(true);

		// The specified entry on main has stage:'specified'.
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		const specifiedEntry = JSON.parse(showResult.stdout as string) as { stage: string };
		expect(specifiedEntry.stage).toBe('specified');
	},
);

// ---------------------------------------------------------------------------
// Regression test: demoteIssueOnMain leaves the worktree coherent with HEAD
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'demoteIssueOnMain (on-main): ref reflects stage:idea, worktree coherent with HEAD',
	() => {
		const { dir, run } = makeTmpRepo();

		const r1 = writeIssueFile({
			cwd: dir,
			title: 'Idea to specify then demote',
			spawnFn: realSpawnFn,
		});
		expect(r1.id).toBe('CAM-1');

		const specResult = specifyIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spec: VALID_SPEC,
			wsjf: VALID_WSJF,
			spawnFn: realSpawnFn,
			clock: () => '2026-07-12T00:00:00.000Z',
			eventSink: () => {},
		});
		if (!specResult.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(specResult)}`);
		}

		// specifyIssueOnMain runs while checked out on main -> demote also runs on-main.
		const demoteResult = demoteIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spawnFn: realSpawnFn,
			clock: () => '2026-07-12T00:01:00.000Z',
		});
		if (!demoteResult.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(demoteResult)}`);
		}
		expect(demoteResult.branchWasMain).toBe(true);

		// Oracle: main ref reflects stage:idea after demote.
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		const demotedEntry = JSON.parse(showResult.stdout as string) as {
			stage: string;
			spec?: unknown;
		};
		expect(demotedEntry.stage).toBe('idea');
		// The stale spec is preserved as reference for the re-grill.
		expect(demotedEntry.spec).toBeDefined();

		// Worktree coherence: commitTreeToMain's final syncWorktreeIfOnMain step
		// must leave the working tree identical to HEAD (clean porcelain status),
		// and the on-disk file content must match the ref.
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');

		const wtContent = readFileSync(join(dir, 'scripts', 'cam', 'issues', 'CAM-0001.json'), 'utf8');
		const wtEntry = JSON.parse(wtContent) as { stage: string };
		expect(wtEntry.stage).toBe('idea');
	},
);
