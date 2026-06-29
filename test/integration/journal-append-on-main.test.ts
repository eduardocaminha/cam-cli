// test/integration/journal-append-on-main.test.ts
//
// Real-git integration test: regression guard for appendJournalEntryOnMain.
//
// Pattern: test/integration/issue-file-on-main.test.ts (US-004, CAM-72).
// Skip guard: git --version check; mkdtempSync repo; git init + symbolic-ref
// HEAD refs/heads/main + user config; seed+commit baseline journal.md on main;
// realSpawnFn forwarding env+input over spawnSync; afterEach rmSync cleanup.
//
// Two cases:
//   Case A (off-main): checkout a feature branch, call appendJournalEntryOnMain,
//     assert git rev-parse main advanced by one commit and git rev-parse HEAD
//     (feature branch) + git status --porcelain are unchanged.
//   Case B (on-main): call while on main, assert a direct commit lands and
//     the working-tree journal.md contains the new entry.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendJournalEntryOnMain,
	type SpawnFn,
	type JournalCycleEntry,
} from '../../src/commands/journal.ts';

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

const FIXED_ENTRY: JournalCycleEntry = {
	cycleId: 'cam/CAM-122-journal-append',
	title: 'cam journal append deterministico',
	started: '2026-06-27',
	closed: '2026-06-27',
	branch: 'cam/CAM-122-journal-append',
	issue: 'CAM-122',
	outcome: 'shipped',
	summary: 'Deterministic cam journal append via commit-tree to main.',
};

const BASELINE_JOURNAL = `# Cam Journal

<!-- ENTRIES_BELOW -->

## old/cycle — old entry

- **Started**: 2026-01-01
- **Closed**: 2026-01-02
- **Branch**: old/cycle
- **Issue**: CAM-1
- **Outcome**: shipped
- **Summary**: Old cycle summary.
`;

// ---------------------------------------------------------------------------
// Helper: make a fresh isolated git repo
// ---------------------------------------------------------------------------

interface RepoHandles {
	dir: string;
	run: (args: string[]) => ReturnType<typeof spawnSync>;
	camDir: string;
}

function makeTmpRepo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-journal-append-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });

	writeFileSync(join(camDir, 'journal.md'), BASELINE_JOURNAL);
	run(['add', '-A']);
	run(['commit', '-m', 'chore: seed baseline journal']);

	return { dir, run, camDir };
}

// ---------------------------------------------------------------------------
// Case A (off-main)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'Case A (off-main): new entry lands on main; feature-branch HEAD and working tree untouched',
	() => {
		const { dir, run, camDir } = makeTmpRepo();

		// Capture baseline main SHA
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		// Checkout a feature branch
		run(['checkout', '-b', 'cam/CAM-122-journal-append']);
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('cam/CAM-122-journal-append');

		// Capture feature-branch HEAD before calling the function
		const featureSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		// Also capture working-tree journal content before
		const wtBefore = readFileSync(join(camDir, 'journal.md'), 'utf8');

		const result = appendJournalEntryOnMain({
			cwd: dir,
			entry: FIXED_ENTRY,
			spawnFn: realSpawnFn,
		});

		// Guard: no remote in tmpdir, so origin/main is absent (up-to-date check skipped)
		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		// (a) git rev-parse main advanced by exactly one commit
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (b) the new entry is on main (read via git show)
		const showResult = run(['show', 'main:scripts/cam/journal.md']);
		const mainContent = showResult.stdout as string;
		expect(mainContent).toContain('## cam/CAM-122-journal-append — cam journal append deterministico');
		expect(mainContent).toContain('- **Issue**: CAM-122');
		expect(mainContent).toContain('- **Outcome**: shipped');
		// Old entry must be preserved
		expect(mainContent).toContain('## old/cycle — old entry');

		// (c) git rev-parse HEAD (feature branch) is unchanged
		const featureSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureSha1).toBe(featureSha0);

		// (d) git status --porcelain is empty (working tree clean)
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');

		// (e) working-tree journal.md was NOT modified (off-main path)
		const wtAfter = readFileSync(join(camDir, 'journal.md'), 'utf8');
		expect(wtAfter).toBe(wtBefore);

		// (f) result shape
		expect(result.cycleId).toBe('cam/CAM-122-journal-append');
		expect(typeof result.sha).toBe('string');
		expect(result.sha.length).toBeGreaterThan(0);
	},
);

// ---------------------------------------------------------------------------
// Case B (on-main)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'Case B (on-main): commit-tree path advances main; entry visible via git show; working tree synced to HEAD',
	() => {
		const { dir, run, camDir } = makeTmpRepo();

		// Confirm we ARE on main
		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('main');

		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		const result = appendJournalEntryOnMain({
			cwd: dir,
			entry: FIXED_ENTRY,
			spawnFn: realSpawnFn,
		});

		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		// (a) main advanced by one commit
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// (b) commit message
		const logMsg = run(['log', '-1', '--format=%s']);
		expect((logMsg.stdout as string).trim()).toBe(
			'chore(cam): journal append cam/CAM-122-journal-append',
		);

		// (c) new entry is visible on main via git show (ref-only path)
		const showResult = run(['show', 'main:scripts/cam/journal.md']);
		const mainContent = showResult.stdout as string;
		expect(mainContent).toContain('## cam/CAM-122-journal-append — cam journal append deterministico');
		expect(mainContent).toContain('- **Issue**: CAM-122');
		expect(mainContent).toContain('- **Outcome**: shipped');
		// Old entry preserved
		expect(mainContent).toContain('## old/cycle — old entry');

		// (d) working-tree journal.md is synced to HEAD (syncWorktreeIfOnMain coherence invariant)
		const wtAfter = readFileSync(join(camDir, 'journal.md'), 'utf8');
		expect(wtAfter).toContain('## cam/CAM-122-journal-append — cam journal append deterministico');
		expect(wtAfter).toContain('- **Issue**: CAM-122');
		// Old entry preserved
		expect(wtAfter).toContain('## old/cycle — old entry');

		// (e) result shape
		expect(result.cycleId).toBe('cam/CAM-122-journal-append');
		expect(typeof result.sha).toBe('string');
		expect(result.sha.length).toBeGreaterThan(0);
	},
);
