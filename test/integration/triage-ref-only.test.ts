// test/integration/triage-ref-only.test.ts
//
// CAM-133 regression guard: runTriage must commit via commitTreeToMain even
// when checked out on main, so a stale working-tree/index cannot silently drop
// files that were previously added via ref-only writeIssueFile calls.
//
// Corruption scenario (pre-fix, commitOnMain path):
//   1. Seed backlog: CAM-0001.json + CAM-0002.json committed normally.
//   2. writeIssueFile(CAM-3) via ref-only CAS -> main has CAM-0003.json;
//      working tree/index does NOT have it (stale).
//   3. runTriage() while on main.
//      BUG (pre-fix): commitOnMain stages CAM-0001.json and CAM-0002.json from
//      the working tree and commits from the stale index -- CAM-0003.json was
//      absent from the index, so the triage commit DROPPED it from main's tree.
//      FIX: commitTreeToMain reads from `read-tree main` (the real ref), so ALL
//      files in main's current tree survive the triage commit.
//
// Oracle: after runTriage, git ls-tree count in scripts/cam/issues/ must be 3
//         (CAM-0003.json not dropped). The test fails against pre-fix code.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTriage } from '../../src/commands/triage.ts';
import type { SpawnFn } from '../../src/commands/triage.ts';
import { writeIssueFile } from '../../src/issues/alloc.ts';
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
// Fixtures: two specified issues (to guarantee changed > 0 on first triage run)
// ---------------------------------------------------------------------------

const SEED_CAM_1: IssueEntry = {
	id: 'CAM-1',
	title: 'First issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	wsjf: { value: 8, timeCriticality: 5, riskReduction: 3, jobSize: 2 },
};

const SEED_CAM_2: IssueEntry = {
	id: 'CAM-2',
	title: 'Second issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-01-02T00:00:00.000Z',
	updatedAt: '2026-01-02T00:00:00.000Z',
	wsjf: { value: 4, timeCriticality: 2, riskReduction: 1, jobSize: 2 },
};

// ---------------------------------------------------------------------------
// Repo scaffold
// ---------------------------------------------------------------------------

interface RepoHandles {
	dir: string;
	issuesDir: string;
	run: (args: string[]) => { stdout: string; stderr: string; status: number | null };
}

function makeTmpRepo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-triage-refonly-'));
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

	const issuesDir = join(dir, 'scripts', 'cam', 'issues');
	mkdirSync(issuesDir, { recursive: true });

	// Seed two specified issues (no rank yet -- ensures triage always commits on first run).
	writeFileSync(join(issuesDir, 'CAM-0001.json'), JSON.stringify(SEED_CAM_1, null, 2) + '\n');
	writeFileSync(join(issuesDir, 'CAM-0002.json'), JSON.stringify(SEED_CAM_2, null, 2) + '\n');

	run(['add', '-A']);
	run(['commit', '-m', 'chore: seed two specified issues']);

	return { dir, issuesDir, run };
}

// ---------------------------------------------------------------------------
// Regression test: ref-only write -> triage on main
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'ref-only issue file survives runTriage on main (commitTreeToMain preserves prior tree)',
	() => {
		// CAM-133 regression guard.
		const { dir, run } = makeTmpRepo();

		// Step 1: write a third issue via ref-only CAS (no working-tree mutation).
		// stage defaults to 'idea' so it is outside the triage ranking universe
		// (rankIssues filters for stage=specified, status=open) -- triage will
		// read it via ls-tree but will NOT include it in changedFiles.
		const r3 = writeIssueFile({
			cwd: dir,
			title: 'Idea seeded before triage (ref-only)',
			spawnFn: realSpawnFn,
		});
		expect(r3.id).toBe('CAM-3');

		// Precondition: main has 3 files; working tree has 2 (CAM-0003.json is stale).
		const lsBefore = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const filesBefore = lsBefore.stdout.trim().split('\n').filter(Boolean);
		expect(filesBefore).toHaveLength(3);

		// Confirm we are on main.
		const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
		expect(branch).toBe('main');

		// Step 2: runTriage while on main.
		// PRE-FIX: commitOnMain stages CAM-0001.json + CAM-0002.json from the
		//          stale working tree/index, dropping CAM-0003.json from main.
		// POST-FIX: commitTreeToMain reads from `read-tree main`, preserving
		//           all 3 files; changedFiles only overwrites CAM-0001.json and
		//           CAM-0002.json (with ranks); CAM-0003.json is untouched.
		const lines: string[] = [];
		const result = runTriage({
			cwd: dir,
			spawnFn: realSpawnFn,
			clock: () => '2026-06-28T12:00:00.000Z',
			writeStdout: (line) => { lines.push(line); },
		});

		if (!result.ok) {
			throw new Error(`runTriage failed: ${JSON.stringify(result)}`);
		}

		// Triage must have committed (changed > 0) because CAM-1 and CAM-2
		// had no prior rank -- idempotency guard: skips commit only when changed=0.
		expect(result.changed).toBeGreaterThan(0);

		// Oracle: ALL 3 files must survive the triage commit on main.
		const lsAfter = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const filesAfter = lsAfter.stdout.trim().split('\n').filter(Boolean);
		expect(filesAfter).toHaveLength(3);

		// Specifically: CAM-0001 and CAM-0002 (mutated with ranks) and CAM-0003
		// (the ref-only idea-stage file that must NOT have been dropped).
		expect(filesAfter.some((f) => f.includes('CAM-0001.json'))).toBe(true);
		expect(filesAfter.some((f) => f.includes('CAM-0002.json'))).toBe(true);
		expect(filesAfter.some((f) => f.includes('CAM-0003.json'))).toBe(true);

		// Ranks landed correctly on main.
		const cam1Raw = run(['show', 'main:scripts/cam/issues/CAM-0001.json']).stdout;
		const cam2Raw = run(['show', 'main:scripts/cam/issues/CAM-0002.json']).stdout;
		const cam1 = JSON.parse(cam1Raw) as IssueEntry;
		const cam2 = JSON.parse(cam2Raw) as IssueEntry;
		expect(cam1.rank).toBe(1);
		expect(cam2.rank).toBe(2);

		// Idempotency preserved: second runTriage is a no-op (changed=0, no commit).
		const mainAfterRun1 = run(['rev-parse', 'main']).stdout.trim();
		const result2 = runTriage({
			cwd: dir,
			spawnFn: realSpawnFn,
			clock: () => '2026-06-28T12:00:00.000Z',
			writeStdout: () => {},
		});
		if (!result2.ok) {
			throw new Error(`runTriage run2 failed: ${JSON.stringify(result2)}`);
		}
		expect(result2.changed).toBe(0);
		expect(result2.sha).toBe('none');
		const mainAfterRun2 = run(['rev-parse', 'main']).stdout.trim();
		expect(mainAfterRun2).toBe(mainAfterRun1);
	},
);
