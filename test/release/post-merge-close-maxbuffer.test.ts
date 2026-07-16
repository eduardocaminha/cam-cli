// test/release/post-merge-close-maxbuffer.test.ts
//
// Behavioral regression test (US-003, CAM-311) for the post-merge close/
// abandon/demote path: src/release/post-merge.ts's makeRealIssueSpawnFn used
// to rebuild its spawnSync options object field-by-field
// (`{ encoding: opts.encoding, ...(opts.env ? ... : {}), ...(opts.input ? ... : {}) }`),
// silently dropping `maxBuffer`. readBacklogFromMain (src/issues/backlog.ts)
// always requests a 256 MiB maxBuffer for its `git cat-file --batch` call so a
// growing backlog is never truncated at Node's 1 MiB spawnSync default; the
// field-by-field wrapper dropped that request, so once the combined backlog
// blob exceeds 1 MiB, `cam issue close/abandon` and the ship auto-close step
// ENOBUFS.
//
// This test builds a REAL git repo in a tmpdir with a backlog whose combined
// `git cat-file --batch` output genuinely exceeds 1 MiB (asserted directly,
// mirrors test/issues/backlog-maxbuffer-regression.test.ts's repo-factory
// pattern -- a small ASCII fixture would mask this bug class), then:
//
//   - proves the pre-fix field-by-field shape ENOBUFS-throws against it when
//     driven through closeIssueOnMain directly (closeIssueOnMain is the same
//     function makeRealIssueSpawnFn's production wiring calls);
//   - proves defaultCloseIssueFn (src/release/post-merge.ts, the exact
//     production default performCloseStep/runPostMerge falls back to for the
//     ship auto-close path) succeeds cleanly against the same fixture, since
//     it is now wired through the shared realOnMainSpawnFn helper.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultCloseIssueFn } from '../../src/release/post-merge.ts';
import { closeIssueOnMain, type SpawnFn } from '../../src/commands/issue-specify.ts';
import type { IssueEntry } from '../../src/issues/types.ts';

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
// The pre-fix wrapper shape (removed from post-merge.ts's makeRealIssueSpawnFn
// by this story): rebuilds the spawnSync options field-by-field, silently
// dropping maxBuffer.
// ---------------------------------------------------------------------------

const buggyFieldByFieldSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
	}) as SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Repo factory: a real git repo on `main` with a backlog whose combined
// `git cat-file --batch` blob genuinely exceeds 1 MiB.
// ---------------------------------------------------------------------------

function makeLargeBacklogRepo(fileCount: number, descriptionBytes: number): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-postmerge-maxbuf-'));
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

	const padding = 'x'.repeat(descriptionBytes);
	for (let i = 1; i <= fileCount; i++) {
		const entry: IssueEntry = {
			id: `CAM-${i}`,
			title: `Issue ${i}`,
			stage: i === fileCount ? 'specified' : 'idea',
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
// AC2: post-merge close path (ship auto-close), driven through the exact
// production default performCloseStep/runPostMerge falls back to.
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'closeIssueOnMain: buggy field-by-field spawnFn ENOBUFS-throws past a >1.1 MiB backlog',
	() => {
		const fileCount = 25;
		const dir = makeLargeBacklogRepo(fileCount, 50_000);
		assertBacklogExceeds1MiB(dir);

		// Pre-fix shape: maxBuffer silently dropped -> cat-file --batch truncates
		// at Node's 1 MiB default -> ENOBUFS -> readBacklogFromMain throws.
		expect(() =>
			closeIssueOnMain({
				cwd: dir,
				id: `CAM-${fileCount}`,
				spawnFn: buggyFieldByFieldSpawnFn,
				clock: () => FIXED_CLOCK,
			}),
		).toThrow(/cat-file --batch failed/);
	},
);

test.skipIf(!gitAvailable)(
	'defaultCloseIssueFn (ship auto-close path): closes cleanly against a >1.1 MiB backlog with no ENOBUFS',
	() => {
		const fileCount = 25;
		const dir = makeLargeBacklogRepo(fileCount, 50_000);
		assertBacklogExceeds1MiB(dir);

		// Post-fix: defaultCloseIssueFn's makeRealIssueSpawnFn() now delegates to
		// realOnMainSpawnFn, which spreads the full opts object (incl. maxBuffer)
		// through to spawnSync, so the close succeeds instead of ENOBUFS-ing.
		const closeId = `CAM-${fileCount}`;
		const result = defaultCloseIssueFn(dir, closeId);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.id).toBe(closeId);
			expect(result.committedTo).toBe('main');
		}
	},
);
