// test/integration/triage-real-git.test.ts
//
// Integration test (REAL git): proves cam triage end-to-end behavior on a
// throwaway git repo.
//
// Why real git: unit fakes for SpawnFn record calls and return success
// regardless of what real git would do.  Only a round-trip against a real
// git repo in a tmpdir proves that:
//   (a) Computed rank actually lands on main via the commit-tree plumbing.
//   (b) The work-branch HEAD sha is completely untouched.
//   (c) A second consecutive run is a no-op (main HEAD sha unchanged).
//
// Mirrors test/integration/issue-file-on-main.test.ts: skip-when-git-absent,
// mkdtempSync, git init + user config, seed+commit baseline on main, run with
// realSpawnFn wrapping spawnSync, assert with real git show / git log / git
// rev-parse.
//
// Maps prd.json US-005 AC#1 (ranks land on main, work-branch HEAD unchanged)
// and AC#2 (second run = no new commit).

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTriage } from '../../src/commands/triage.ts';
import type { SpawnFn } from '../../src/commands/triage.ts';
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
// realSpawnFn: wraps spawnSync for real git calls
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

const FIXED_CLOCK = '2026-06-28T10:00:00.000Z';

/** Seed backlog: two {specified, open} issues with WSJF scores (per-file format). */
const SEED_CAM_1: IssueEntry = {
	id: 'CAM-1',
	title: 'First issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-01-01T00:00:00.000Z',
	wsjf: { value: 8, timeCriticality: 5, riskReduction: 3, jobSize: 2 },
};

const SEED_CAM_2: IssueEntry = {
	id: 'CAM-2',
	title: 'Second issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-01-02T00:00:00.000Z',
	wsjf: { value: 4, timeCriticality: 2, riskReduction: 1, jobSize: 2 },
};

interface RepoHandles {
	dir: string;
	camDir: string;
	issuesDir: string;
	run: (args: string[]) => { stdout: string; stderr: string; status: number | null };
}

function makeTmpRepo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-triage-real-git-'));
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

	const camDir = join(dir, 'scripts', 'cam');
	const issuesDir = join(camDir, 'issues');
	mkdirSync(issuesDir, { recursive: true });

	// US-004: write per-file CAM-NNNN.json (never issues.local.json)
	writeFileSync(join(issuesDir, 'CAM-0001.json'), JSON.stringify(SEED_CAM_1, null, 2) + '\n');
	writeFileSync(join(issuesDir, 'CAM-0002.json'), JSON.stringify(SEED_CAM_2, null, 2) + '\n');

	run(['add', '-A']);
	run(['commit', '-m', 'chore: seed backlog']);

	return { dir, camDir, issuesDir, run };
}

// ---------------------------------------------------------------------------
// Test A: rank lands on main; work-branch HEAD unchanged
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'rank lands on main; work-branch HEAD unchanged after runTriage off-main',
	() => {
		const { dir, run } = makeTmpRepo();

		// Check out a work branch and capture its HEAD sha.
		run(['checkout', '-b', 'feat/work']);
		const branchName = run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
		expect(branchName).toBe('feat/work');
		const workHeadBefore = run(['rev-parse', 'HEAD']).stdout.trim();

		// Run runTriage in-process against real git.
		const lines: string[] = [];
		const result = runTriage({
			cwd: dir,
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			writeStdout: (line) => { lines.push(line); },
		});

		// Guard: should succeed (no remote means diverge check is skipped).
		if (!result.ok) {
			throw new Error(`runTriage failed: ${JSON.stringify(result)}`);
		}

		// (a) AC#1 sub-a: rank lands on main via per-file CAM-NNNN.json (not working tree).
		const cam1Raw = run(['show', 'main:scripts/cam/issues/CAM-0001.json']).stdout;
		const cam2Raw = run(['show', 'main:scripts/cam/issues/CAM-0002.json']).stdout;
		const cam1 = JSON.parse(cam1Raw) as IssueEntry;
		const cam2 = JSON.parse(cam2Raw) as IssueEntry;

		expect(cam1.rank).toBeDefined();
		expect(cam2.rank).toBeDefined();
		// CAM-1 has higher WSJF: (8+5+3)/2=8 vs CAM-2: (4+2+1)/2=3.5, so rank 1 < rank 2.
		expect(cam1.rank).toBe(1);
		expect(cam2.rank).toBe(2);

		// (b) AC#1 sub-b: work-branch HEAD sha is unchanged.
		const workHeadAfter = run(['rev-parse', 'HEAD']).stdout.trim();
		expect(workHeadAfter).toBe(workHeadBefore);

		// Sanity: main did advance (a commit was made).
		const mainHead = run(['rev-parse', 'main']).stdout.trim();
		expect(mainHead).not.toBe(workHeadBefore);

		// Sentinel line present.
		const sentinel = lines.find((l) => l.startsWith('CAM_TRIAGE_RANKED='));
		expect(sentinel).toBeDefined();
		expect(sentinel).toContain('changed=2');

		// Result shape.
		expect(result.ranked).toBe(2);
		expect(result.changed).toBe(2);
	},
);

// ---------------------------------------------------------------------------
// Test B: second consecutive run is a no-op (main HEAD unchanged)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'second consecutive runTriage on same backlog produces no new commit',
	() => {
		const { dir, run } = makeTmpRepo();

		// Check out a work branch.
		run(['checkout', '-b', 'feat/idempotent']);

		// Run 1: assigns ranks and commits.
		const result1 = runTriage({
			cwd: dir,
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			writeStdout: () => {},
		});
		if (!result1.ok) throw new Error(`Run 1 failed: ${JSON.stringify(result1)}`);
		expect(result1.changed).toBeGreaterThan(0);

		// Capture main HEAD after run 1.
		const mainAfterRun1 = run(['rev-parse', 'main']).stdout.trim();

		// Run 2: ranks are already correct; no mutation expected.
		const lines2: string[] = [];
		const result2 = runTriage({
			cwd: dir,
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			writeStdout: (line) => { lines2.push(line); },
		});
		if (!result2.ok) throw new Error(`Run 2 failed: ${JSON.stringify(result2)}`);

		// (c) AC#2: main HEAD sha is unchanged between run 1 and run 2.
		const mainAfterRun2 = run(['rev-parse', 'main']).stdout.trim();
		expect(mainAfterRun2).toBe(mainAfterRun1);

		// Run 2 must be a no-op.
		expect(result2.changed).toBe(0);
		expect(result2.sha).toBe('none');

		// Sentinel line reflects no-op.
		const sentinel2 = lines2.find((l) => l.startsWith('CAM_TRIAGE_RANKED='));
		expect(sentinel2).toContain('changed=0');
		expect(sentinel2).toContain('sha=none');
	},
);
