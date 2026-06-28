// test/integration/journal-ref-only.test.ts
//
// CAM-133 regression guard: appendJournalEntryOnMain must commit via
// commitTreeToMain even when checked out on main, so a stale working-tree /
// index cannot silently drop files that were previously added via ref-only
// writeIssueFile calls.
//
// Corruption scenario (pre-fix, commitOnMain path):
//   1. writeIssueFile(CAM-1) via ref-only CAS -> main has CAM-0001.json;
//      working tree/index does NOT have it (stale).
//   2. appendJournalEntryOnMain() while on main.
//      BUG (pre-fix): commitOnMain writes journal.md to the working tree, stages
//      only that file, commits from the stale index -- CAM-0001.json was absent
//      from the index so the journal commit DROPPED it from main's tree.
//      FIX: commitTreeToMain reads from `read-tree main` (the real ref), so ALL
//      files in main's current tree survive the journal commit.
//
// Oracle: after the journal append, git ls-tree count in scripts/cam/issues/
//         must still be 1 (CAM-0001.json not dropped).

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournalEntryOnMain, type SpawnFn, type JournalCycleEntry } from '../../src/commands/journal.ts';
import { writeIssueFile } from '../../src/issues/alloc.ts';

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

const BASELINE_JOURNAL = `# Cam Journal\n\n<!-- ENTRIES_BELOW -->\n\n## old/cycle -- old entry\n\n- **Started**: 2026-01-01\n- **Closed**: 2026-01-02\n- **Branch**: old/cycle\n- **Issue**: CAM-0\n- **Outcome**: shipped\n- **Summary**: Old cycle summary.\n`;

const FIXED_ENTRY: JournalCycleEntry = {
	cycleId: 'cam/CAM-133-journal-ref-only',
	title: 'journal ref-only regression',
	started: '2026-06-28',
	closed: '2026-06-28',
	branch: 'cam/CAM-133-journal-ref-only',
	issue: 'CAM-133',
	outcome: 'shipped',
	summary: 'Proves commitTreeToMain preserves ref-only files from prior writes.',
};

// ---------------------------------------------------------------------------
// Repo scaffold
// ---------------------------------------------------------------------------

interface RepoHandles {
	dir: string;
	run: (args: string[]) => { stdout: string; stderr: string; status: number | null };
}

function makeTmpRepo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-journal-refonly-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => {
		const r = spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
		return {
			stdout: (r.stdout as string) ?? '',
			stderr: (r.stderr as string) ?? '',
			status: r.status,
		};
	};

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	// Seed baseline journal.md on main.
	const camDir = join(dir, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });
	writeFileSync(join(camDir, 'journal.md'), BASELINE_JOURNAL);
	run(['add', '-A']);
	run(['commit', '-m', 'chore: seed baseline journal']);

	return { dir, run };
}

// ---------------------------------------------------------------------------
// Regression test: ref-only write -> journal append on main
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'ref-only issue file survives appendJournalEntryOnMain on main (commitTreeToMain preserves prior tree)',
	() => {
		// CAM-133 regression guard.
		const { dir, run } = makeTmpRepo();

		// Step 1: write an issue file via ref-only CAS (no working-tree mutation).
		const r1 = writeIssueFile({
			cwd: dir,
			title: 'Idea seeded before journal append',
			spawnFn: realSpawnFn,
		});
		expect(r1.id).toBe('CAM-1');

		// Precondition: main has the issue file; working tree does NOT.
		const lsBefore = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const filesBefore = lsBefore.stdout.trim().split('\n').filter(Boolean);
		expect(filesBefore).toHaveLength(1);
		expect(filesBefore[0]).toContain('CAM-0001.json');

		// Confirm we are on main.
		const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
		expect(branch).toBe('main');

		// Step 2: appendJournalEntryOnMain while on main.
		// PRE-FIX: commitOnMain stages only journal.md from the stale working tree/index,
		//          causing the commit to drop CAM-0001.json from main's tree.
		// POST-FIX: commitTreeToMain reads from `read-tree main`, which includes
		//           CAM-0001.json, so it survives the journal commit.
		const result = appendJournalEntryOnMain({
			cwd: dir,
			entry: FIXED_ENTRY,
			spawnFn: realSpawnFn,
		});

		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		// Oracle: CAM-0001.json must still exist on main after the journal commit.
		const lsAfter = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const filesAfter = lsAfter.stdout.trim().split('\n').filter(Boolean);
		expect(filesAfter).toHaveLength(1);
		expect(filesAfter[0]).toContain('CAM-0001.json');

		// Also verify the journal entry landed on main.
		const showJournal = run(['show', 'main:scripts/cam/journal.md']);
		expect(showJournal.stdout).toContain('## cam/CAM-133-journal-ref-only');
		expect(showJournal.stdout).toContain('## old/cycle');

		// Note: after a ref-only commit on main, the index may be stale relative
		// to the advanced HEAD -- that is expected behavior for commitTreeToMain.
		// The key oracle is the ls-tree count above (CAM-0001.json not dropped).
	},
);
