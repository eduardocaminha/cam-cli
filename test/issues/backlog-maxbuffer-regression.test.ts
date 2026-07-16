// test/issues/backlog-maxbuffer-regression.test.ts
//
// Behavioral regression test (US-002, CAM-311) for the CAM-307/CAM-311 bug
// class: a real-spawnSync wrapper that rebuilds its options object
// field-by-field (`{ encoding: opts.encoding, ...(opts.env ? ... : {}), ... }`)
// silently drops any field it didn't enumerate -- including `maxBuffer`.
// readBacklogFromMain (src/issues/backlog.ts) always requests a 256 MiB
// maxBuffer for its `git cat-file --batch` call so a growing backlog is never
// truncated at Node's 1 MiB spawnSync default; a field-by-field wrapper drops
// that request, so once the combined backlog blob exceeds 1 MiB, the
// underlying spawnSync hits Node's default and fails with ENOBUFS.
//
// This test builds a REAL git repo in a tmpdir with a backlog whose combined
// `git cat-file --batch` output genuinely exceeds 1 MiB (asserted directly,
// not assumed -- CAM-90 gotcha: a small ASCII fixture masks this class of
// bug), then exercises the two now-fixed production entry points against it:
//
//   - createLocalIssueOnMain (src/commands/issue-file.ts), the function
//     index.ts's _buildCreateIssueOpts feeds via `cam issue --file-local`.
//   - makeProductionFileSuggestionsFn (src/commands/sidecar.ts), the function
//     sidecar.ts's issueFileSpawnFn feeds for the post-review suggestion
//     backlog-union/dedup pass (readBacklogFromMain call at ~sidecar.ts:2714).
//
// Each is run once with a locally-defined `buggyFieldByFieldSpawnFn` (mirrors
// the exact field-by-field shape removed from index.ts/sidecar.ts by this
// story) -- proving the pre-fix shape throws ENOBUFS against this backlog --
// and once with `realOnMainSpawnFn` (src/git/on-main.ts, the shared helper
// both fixed call sites now delegate to) -- proving the fix works.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalIssueOnMain, type SpawnFn } from '../../src/commands/issue-file.ts';
import { realOnMainSpawnFn } from '../../src/git/on-main.ts';
import { makeProductionFileSuggestionsFn } from '../../src/commands/sidecar.ts';
import { fingerprintFinding, type FollowUpProvenance } from '../../src/supervisor/suggestion-followups.ts';
import type { ReviewFinding, ReviewReport } from '../../src/supervisor/review-report.ts';
import type { IssueEntry } from '../../src/issues/types.ts';

// ---------------------------------------------------------------------------
// Skip guard + tmp-dir lifecycle (mirrors test/integration/issue-dir-real-git.test.ts)
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

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

const FIXED_CLOCK = '2026-07-15T00:00:00.000Z';
const ONE_MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// The pre-fix wrapper shape (removed from index.ts's _buildCreateIssueOpts /
// dispatchTriage, and src/commands/sidecar.ts's issueFileSpawnFn, by this
// story): rebuilds the spawnSync options field-by-field, silently dropping
// maxBuffer.
// ---------------------------------------------------------------------------

const buggyFieldByFieldSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Repo factory: a real git repo on `main` with a backlog whose combined
// `git cat-file --batch` blob genuinely exceeds 1 MiB.
// ---------------------------------------------------------------------------

function makeLargeBacklogRepo(fileCount: number, descriptionBytes: number): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-maxbuf-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	const issuesDir = join(camDir, 'issues');
	mkdirSync(issuesDir, { recursive: true });
	writeFileSync(join(camDir, 'project.toml'), 'issue_prefix = "CAM"\n');
	// Pre-existing empty pen: appendSuggestionOnMain requires it on main.
	writeFileSync(join(camDir, 'suggestions.jsonl'), '');

	const padding = 'x'.repeat(descriptionBytes);
	for (let i = 1; i <= fileCount; i++) {
		const entry: IssueEntry = {
			id: `CAM-${i}`,
			title: `Issue ${i}`,
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: FIXED_CLOCK,
			updatedAt: FIXED_CLOCK,
			description: padding,
		};
		writeFileSync(join(issuesDir, `CAM-${String(i).padStart(4, '0')}.json`), JSON.stringify(entry));
	}

	run(['add', '-A']);
	run(['commit', '-m', 'chore: seed large backlog']);

	return dir;
}

/** Sanity check: proves the backlog's real `git cat-file --batch` output genuinely exceeds 1 MiB. */
function assertBacklogExceeds1MiB(dir: string): void {
	const ls = spawnSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/'], {
		encoding: 'utf8',
	});
	const paths = (ls.stdout ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
	const refs = paths.map((p) => `main:${p}`).join('\n');
	const cat = spawnSync('git', ['-C', dir, 'cat-file', '--batch'], {
		encoding: 'utf8',
		input: refs,
		maxBuffer: 256 * 1024 * 1024,
	});
	expect((cat.stdout ?? '').length).toBeGreaterThan(1.1 * ONE_MIB);
}

// ---------------------------------------------------------------------------
// AC3a: file-local filing path (createLocalIssueOnMain)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'createLocalIssueOnMain: buggy field-by-field spawnFn ENOBUFS-throws past a >1.1 MiB backlog; realOnMainSpawnFn files cleanly with the correct next id',
	() => {
		const fileCount = 25;
		const dir = makeLargeBacklogRepo(fileCount, 50_000);
		assertBacklogExceeds1MiB(dir);

		const readProjectToml = () => readFileSync(join(dir, 'scripts/cam/project.toml'), 'utf8');
		const clock = () => FIXED_CLOCK;

		// Pre-fix shape: maxBuffer silently dropped -> cat-file --batch truncates
		// at Node's 1 MiB default -> ENOBUFS -> readBacklogFromMain throws.
		expect(() =>
			createLocalIssueOnMain({
				cwd: dir,
				title: 'pre-fix would ENOBUFS here',
				spawnFn: buggyFieldByFieldSpawnFn,
				clock,
				readProjectToml,
			}),
		).toThrow(/cat-file --batch failed/);

		// Post-fix: realOnMainSpawnFn spreads the full opts object (incl.
		// maxBuffer) through to spawnSync, so allocateId succeeds.
		const result = createLocalIssueOnMain({
			cwd: dir,
			title: 'post-fix files cleanly',
			spawnFn: realOnMainSpawnFn,
			clock,
			readProjectToml,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.id).toBe(`CAM-${fileCount + 1}`);
		}
	},
);

// ---------------------------------------------------------------------------
// AC3b: suggestions backlog-union path (makeProductionFileSuggestionsFn)
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'makeProductionFileSuggestionsFn: buggy field-by-field spawnFn ENOBUFS-throws past a >1.1 MiB backlog; realOnMainSpawnFn pens the suggestion cleanly',
	() => {
		const fileCount = 25;
		const dir = makeLargeBacklogRepo(fileCount, 50_000);
		assertBacklogExceeds1MiB(dir);

		const finding: ReviewFinding = {
			severity: 'SUGGESTION',
			file: 'src/example.ts',
			line: 42,
			text: 'consider extracting this into a helper',
		};
		const report: ReviewReport = { verdict: 'CLEAN', findings: [finding] };
		const provenance: FollowUpProvenance = { source: 'test-branch' };

		// Pre-fix shape: maxBuffer dropped on the readBacklogFromMain call inside
		// the returned closure -> ENOBUFS -> throws.
		const buggyFn = makeProductionFileSuggestionsFn(dir, buggyFieldByFieldSpawnFn, () => {});
		expect(() => buggyFn(report, provenance)).toThrow(/cat-file --batch failed/);

		// Post-fix: realOnMainSpawnFn forwards maxBuffer -> succeeds.
		const fixedFn = makeProductionFileSuggestionsFn(dir, realOnMainSpawnFn, () => {});
		const { penned, dupSkipped } = fixedFn(report, provenance);

		expect(penned).toBe(1);
		expect(dupSkipped).toBe(0);

		const penShow = spawnSync('git', ['-C', dir, 'show', 'main:scripts/cam/suggestions.jsonl'], {
			encoding: 'utf8',
		});
		expect(penShow.status).toBe(0);
		expect(penShow.stdout ?? '').toContain(fingerprintFinding(finding));
	},
);
