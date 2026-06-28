// test/integration/ship-finalize-dirty-prd.test.ts
//
// Integration test (REAL git): regression guard for the dirty-prd.json bug
// (CAM-72 / CAM-68).
//
// The bug: when a reviewer appends to prd.json before finalizeCycleClose runs,
// git marks it as locally-modified. A plain `git rm` would fail with "local
// modifications"; `git rm -f --ignore-unmatch` must be used.
//
// Unit fakes cannot catch this class of bug because the fake spawnFn just
// records calls and returns success regardless of whether git would actually
// refuse the rm. Only a round-trip against a real git repo in a tmpdir proves
// the -f flag actually overrides git's modification guard.
//
// This test mirrors the skip-when-tool-absent pattern from
// test/integration/tmux-introspect.test.ts: it skips cleanly when the git
// binary is absent.
//
// Two test cases:
//   (1) dirty-prd scenario: prd.json committed then locally modified; must
//       still be removed from the index and disk, and the tree must be clean.
//   (2) missing-files variant: prd.json/handoff.json never committed; git rm
//       --ignore-unmatch must be a silent no-op, and the commit must still
//       succeed via the staged CAM-0027.json change (US-004 per-file cutover).

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	finalizeCycleClose,
	type SpawnFn,
} from '../../src/commands/ship-finalize.ts';
import { issueFilePath } from '../../src/issues/backlog.ts';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Skip guard: mirrors tmux-introspect.test.ts pattern
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh, isolated git repo in a OS temp dir.
 * Registers the dir for cleanup in afterEach.
 */
function makeTmpRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-ship-finalize-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	mkdirSync(join(dir, 'scripts', 'cam', 'issues'), { recursive: true });

	return dir;
}

/**
 * A real spawnFn that forwards every call to the actual git binary.
 * finalizeCycleClose always passes `-C <cwd>` in the argv, so git operates
 * on the correct repo without needing to chdir.
 */
const realSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, { encoding: opts.encoding, stdio: 'pipe' }) as SpawnSyncReturns<string>;

const FIXED_CLOCK = '2026-06-23T12:00:00.000Z';

// project.toml: 'none' backend so CAM-0027.json is closed (gives the
// commit something to stage even in the missing-files variant).
const PROJECT_TOML = 'issue_system = "none"\nissue_prefix = "CAM"\n';

// Baseline prd.json committed to the repo
const PRD_JSON = JSON.stringify({ issueNumber: 27, branchName: 'cam/CAM-27-test' });

// Modified prd.json (simulates the reviewer appending a review block)
const PRD_JSON_MODIFIED = JSON.stringify({
	issueNumber: 27,
	branchName: 'cam/CAM-27-test',
	review: { lastVerdict: 'CLEAN', appendedByReviewer: true },
});

// Minimal handoff.json
const HANDOFF_JSON = JSON.stringify({ lastCompletedStory: { id: 'US-001', title: 'Test' } });

// US-004: per-file format -- CAM-0027.json contains a single IssueEntry
const CAM_27_ENTRY_JSON =
	JSON.stringify(
		{
			id: 'CAM-27',
			title: 'Test issue',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00Z',
		},
		null,
		2,
	) + '\n';

// Expected commit message produced by finalizeCycleClose for issueNumber=27
const EXPECTED_COMMIT_MSG =
	'chore(cam): close CAM-27 + drop per-branch harness state (CAM-27 hygiene)';

// ---------------------------------------------------------------------------
// Test 1: dirty-prd scenario
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'dirty-prd: prd.json removed from index and disk even when locally modified',
	() => {
		const dir = makeTmpRepo();
		const camDir = join(dir, 'scripts', 'cam');

		const run = (args: string[]) =>
			spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

		// Commit all required files (US-004: CAM-0027.json, not issues.local.json)
		writeFileSync(join(camDir, 'prd.json'), PRD_JSON);
		writeFileSync(join(camDir, 'handoff.json'), HANDOFF_JSON);
		writeFileSync(join(camDir, 'project.toml'), PROJECT_TOML);
		writeFileSync(join(camDir, 'issues', 'CAM-0027.json'), CAM_27_ENTRY_JSON);
		run(['add', '-A']);
		run(['commit', '-m', 'chore: initial harness state']);

		// OVERWRITE prd.json with modified content (the CAM-68/CAM-72 scenario:
		// reviewer appends a review block to prd.json after committing it)
		writeFileSync(join(camDir, 'prd.json'), PRD_JSON_MODIFIED);

		// Confirm git sees prd.json as locally modified before we run finalize
		const statusBefore = run(['status', '--porcelain']);
		expect(statusBefore.stdout).toContain('scripts/cam/prd.json');

		// Run finalizeCycleClose with the real git binary
		// US-004: readIssues/writeIssues use issueFilePath (per-file, not issues.local.json)
		finalizeCycleClose({
			cwd: dir,
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			readProjectToml: () => readFileSync(join(camDir, 'project.toml'), 'utf8'),
			// Read the dirty (modified) prd.json from disk, as production would
			readPrd: () => PRD_JSON_MODIFIED,
			readIssues: (issueId) => readFileSync(join(dir, issueFilePath(issueId)), 'utf8'),
			writeIssues: (issueId, text) => writeFileSync(join(dir, issueFilePath(issueId)), text),
		});

		// (a) git ls-files must be empty: prd.json removed from the index
		const lsFiles = run(['ls-files', 'scripts/cam/prd.json']);
		expect(lsFiles.stdout.trim()).toBe('');

		// (b) working tree must not contain prd.json or handoff.json
		expect(existsSync(join(camDir, 'prd.json'))).toBe(false);
		expect(existsSync(join(camDir, 'handoff.json'))).toBe(false);

		// (c) git status --porcelain must be empty (clean tree)
		const statusAfter = run(['status', '--porcelain']);
		expect(statusAfter.stdout.trim()).toBe('');

		// (d) HEAD commit message has the expected chore(cam): close ... CAM-27 hygiene form
		const logMsg = run(['log', '-1', '--format=%s']);
		expect(logMsg.stdout.trim()).toBe(EXPECTED_COMMIT_MSG);
	},
);

// ---------------------------------------------------------------------------
// Test 2: missing-files variant
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'missing-files variant: prd.json/handoff.json absent; finalizeCycleClose runs cleanly',
	() => {
		const dir = makeTmpRepo();
		const camDir = join(dir, 'scripts', 'cam');

		const run = (args: string[]) =>
			spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

		// Commit only project.toml and CAM-0027.json; prd.json and handoff.json
		// are intentionally absent (never added to the index)
		writeFileSync(join(camDir, 'project.toml'), PROJECT_TOML);
		writeFileSync(join(camDir, 'issues', 'CAM-0027.json'), CAM_27_ENTRY_JSON);
		run(['add', '-A']);
		run(['commit', '-m', 'chore: initial commit without harness state']);

		// Confirm prd.json and handoff.json are absent from the working tree
		expect(existsSync(join(camDir, 'prd.json'))).toBe(false);
		expect(existsSync(join(camDir, 'handoff.json'))).toBe(false);

		// finalizeCycleClose must not throw: git rm --ignore-unmatch is a silent
		// no-op for absent files; CAM-0027.json still gets staged+committed
		// US-004: readIssues/writeIssues use issueFilePath (per-file, not issues.local.json)
		finalizeCycleClose({
			cwd: dir,
			spawnFn: realSpawnFn,
			clock: () => FIXED_CLOCK,
			readProjectToml: () => readFileSync(join(camDir, 'project.toml'), 'utf8'),
			// prd.json does not exist on disk; inject the content directly
			readPrd: () => PRD_JSON,
			readIssues: (issueId) => readFileSync(join(dir, issueFilePath(issueId)), 'utf8'),
			writeIssues: (issueId, text) => writeFileSync(join(dir, issueFilePath(issueId)), text),
		});

		// (a) prd.json was never in the index; ls-files must still be empty
		const lsFiles = run(['ls-files', 'scripts/cam/prd.json']);
		expect(lsFiles.stdout.trim()).toBe('');

		// (b) prd.json and handoff.json still absent from the working tree
		expect(existsSync(join(camDir, 'prd.json'))).toBe(false);
		expect(existsSync(join(camDir, 'handoff.json'))).toBe(false);

		// (c) git status --porcelain must be empty (CAM-0027.json was staged
		// and committed via the issue-close path)
		const statusAfter = run(['status', '--porcelain']);
		expect(statusAfter.stdout.trim()).toBe('');

		// (d) HEAD commit message has the expected form
		const logMsg = run(['log', '-1', '--format=%s']);
		expect(logMsg.stdout.trim()).toBe(EXPECTED_COMMIT_MSG);
	},
);
