// test/supervisor/task-prompt-root-bounded.test.ts
//
// Real-I/O regression test for resolveTaskPromptClaudeDirFallback (US-005,
// CAM-510, site 5 of 5).
//
// Redirects process.env.TMPDIR at a repo-local scratch root (createTestTmpdir,
// restored in finally) and exercises the REAL production function, mirroring
// the three production call sites (plan-runner.ts, worker-dispatch.ts,
// backend-adapter.ts) that all resolve their claudeDir fallback through this
// one shared helper. This file must never import `tmpdir` from `node:os`
// itself (GOTCHA 14, CAM-510/CAM-508): doing so would require a new entry in
// scripts/check-test-tmpdir.ts's allowlist.

import { mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import {
	TASK_PROMPT_ROOT_DIR_NAME,
	resolveTaskPromptClaudeDirFallback,
} from '../../src/supervisor/task-prompt-file.ts';

describe('resolveTaskPromptClaudeDirFallback', () => {
	test('AC10: the redirected root gains exactly one top-level entry, the fixed parent, with the pid nested inside it, across two calls', () => {
		const scratchRoot = createTestTmpdir('cam-task-prompt-root-bounded-');
		const originalTmpdir = process.env.TMPDIR;
		try {
			process.env.TMPDIR = scratchRoot;

			const first = resolveTaskPromptClaudeDirFallback();
			const second = resolveTaskPromptClaudeDirFallback();

			const topLevel = readdirSync(scratchRoot);
			expect(topLevel).toEqual([TASK_PROMPT_ROOT_DIR_NAME]);

			const parent = join(scratchRoot, TASK_PROMPT_ROOT_DIR_NAME);
			const ownPidDirName = String(process.pid);
			expect(readdirSync(parent)).toContain(ownPidDirName);

			// Same process, both calls resolve to the same pid-nested claudeDir.
			expect(first).toBe(join(parent, ownPidDirName, '.claude'));
			expect(second).toBe(first);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	test('AC10: an old pid directory planted inside the fixed parent is pruned', () => {
		const scratchRoot = createTestTmpdir('cam-task-prompt-root-bounded-');
		const originalTmpdir = process.env.TMPDIR;
		try {
			process.env.TMPDIR = scratchRoot;

			// Prime the fixed parent (creates our own pid subdirectory).
			resolveTaskPromptClaudeDirFallback();

			const parent = join(scratchRoot, TASK_PROMPT_ROOT_DIR_NAME);
			const staleSiblingDir = join(parent, 'stale-abandoned-pid');
			mkdirSync(staleSiblingDir, { recursive: true });
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(staleSiblingDir, twoHoursAgo, twoHoursAgo);

			resolveTaskPromptClaudeDirFallback();

			const remaining = readdirSync(parent);
			expect(remaining).not.toContain('stale-abandoned-pid');
			expect(remaining).toContain(String(process.pid));
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});
});
