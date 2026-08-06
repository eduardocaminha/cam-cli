// test/release/ship-pr-tempfile.test.ts
//
// Real-I/O regression test for writeShipPrTempFile (US-001, CAM-510).
//
// Redirects process.env.TMPDIR at a repo-local scratch root (createTestTmpdir,
// restored in finally/afterEach) and exercises the REAL production function
// twice, mirroring the two production call sites in ship-pr.ts: the PR-body
// path (line 260) and the artifact-comment path (line 221). This file must
// never import `tmpdir` from `node:os` itself (GOTCHA 13/14, CAM-510): doing
// so would require a new entry in scripts/check-test-tmpdir.ts's allowlist.

import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { SHIP_PR_TEMPDIR_NAME, writeShipPrTempFile } from '../../src/release/ship-pr-tempfile.ts';

let originalTmpdir: string | undefined;
const dirsToCleanup: string[] = [];

/** Points process.env.TMPDIR at a fresh repo-local scratch root. */
function redirectTmpdirToScratch(): string {
	originalTmpdir = process.env.TMPDIR;
	const scratchRoot = createTestTmpdir('cam-ship-pr-tempfile-');
	dirsToCleanup.push(scratchRoot);
	process.env.TMPDIR = scratchRoot;
	return scratchRoot;
}

afterEach(() => {
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
	originalTmpdir = undefined;
	for (const dir of dirsToCleanup) rmSync(dir, { recursive: true, force: true });
	dirsToCleanup.length = 0;
});

describe('writeShipPrTempFile', () => {
	test('AC2(a)+(b): no per-invocation cam-ship-pr-* directory survives and the redirected root gains at most one top-level entry, the fixed parent', () => {
		const scratchRoot = redirectTmpdirToScratch();

		writeShipPrTempFile('pr body content');
		writeShipPrTempFile('artifact comment content');

		const topLevel = readdirSync(scratchRoot);
		expect(topLevel).toEqual([SHIP_PR_TEMPDIR_NAME]);
		expect(topLevel.some((name) => /^cam-ship-pr-.+/.test(name))).toBe(false);
	});

	test('AC2(c): the body file exists and is readable at the instant it is handed to the spawn seam, for both the PR-body path and the artifact-comment path, and the reap never deletes the earlier live file', () => {
		redirectTmpdirToScratch();

		// PR-body path (ship-pr.ts:260).
		const bodyPath = writeShipPrTempFile('pr body content');
		expect(existsSync(bodyPath)).toBe(true);
		expect(readFileSync(bodyPath, 'utf8')).toBe('pr body content');

		// Artifact-comment path (ship-pr.ts:221), same process, second call.
		const commentPath = writeShipPrTempFile('artifact comment content');
		expect(existsSync(commentPath)).toBe(true);
		expect(readFileSync(commentPath, 'utf8')).toBe('artifact comment content');

		// The reap triggered by the second call must never delete the first
		// call's still-live file.
		expect(existsSync(bodyPath)).toBe(true);
		expect(readFileSync(bodyPath, 'utf8')).toBe('pr body content');
		expect(bodyPath).not.toBe(commentPath);
	});

	test('GOTCHA 8 regression: a recent sibling pid directory (a concurrent live cam ship process) survives, while a stale one is pruned', () => {
		const scratchRoot = redirectTmpdirToScratch();
		const parent = join(scratchRoot, SHIP_PR_TEMPDIR_NAME);

		// Prime the fixed parent (creates our own pid subdirectory).
		writeShipPrTempFile('priming');

		const liveSiblingDir = join(parent, 'live-concurrent-pid');
		const staleSiblingDir = join(parent, 'stale-abandoned-pid');
		mkdirSync(liveSiblingDir, { recursive: true });
		mkdirSync(staleSiblingDir, { recursive: true });
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(staleSiblingDir, twoHoursAgo, twoHoursAgo);

		writeShipPrTempFile('second write, triggers the prune pass');

		const remaining = readdirSync(parent);
		expect(remaining).toContain('live-concurrent-pid');
		expect(remaining).not.toContain('stale-abandoned-pid');
	});
});
