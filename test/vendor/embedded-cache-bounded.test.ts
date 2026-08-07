// test/vendor/embedded-cache-bounded.test.ts
//
// Real-I/O regression test for the bounded vendor-extraction cache
// (US-002, CAM-510). Redirects process.env.TMPDIR at a repo-local scratch
// root (createTestTmpdir, restored in finally) and exercises the REAL
// production materializeEmbedded seam. This file must never import
// `tmpdir` from `node:os` itself (GOTCHA 14, CAM-510): doing so would
// require a new entry in scripts/check-test-tmpdir.ts's allowlist.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { materializeEmbedded, readEmbedded } from '../../src/vendor/embedded.ts';
import { CAM_VERSION } from '../../src/version.ts';

/** Mirrors the fixed parent name in src/vendor/embedded.ts. */
const VENDOR_CACHE_PARENT_NAME = 'cam-cli-vendor';

describe('materializeEmbedded — bounded vendor cache (US-002, CAM-510)', () => {
	test('AC4(a): no flat cam-cli-vendor-<version> entry survives at the root; only the fixed parent', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-embedded-bounded-');
		try {
			process.env.TMPDIR = scratchRoot;

			materializeEmbedded('check-agent-frontmatter.ts');

			const topLevel = readdirSync(scratchRoot);
			expect(topLevel).toEqual([VENDOR_CACHE_PARENT_NAME]);
			expect(
				topLevel.some((name) => new RegExp(`^${VENDOR_CACHE_PARENT_NAME}-.+`).test(name)),
			).toBe(false);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	test('AC4(b): a stale version directory planted inside the fixed parent does not survive', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-embedded-bounded-');
		try {
			process.env.TMPDIR = scratchRoot;
			const parent = join(scratchRoot, VENDOR_CACHE_PARENT_NAME);
			const staleVersionDir = join(parent, '0.0.1-stale');
			mkdirSync(staleVersionDir, { recursive: true });
			writeFileSync(
				join(staleVersionDir, 'check-agent-frontmatter.ts'),
				'stale contents',
				'utf8',
			);
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(staleVersionDir, twoHoursAgo, twoHoursAgo);

			materializeEmbedded('check-agent-frontmatter.ts');

			expect(existsSync(staleVersionDir)).toBe(false);
			expect(readdirSync(parent)).toEqual([CAM_VERSION]);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	test('AC4(c): the materialized file for the current version is still byte-correct', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-embedded-bounded-');
		try {
			process.env.TMPDIR = scratchRoot;

			const path = materializeEmbedded('check-agent-frontmatter.ts');

			expect(existsSync(path)).toBe(true);
			expect(path).toBe(
				join(scratchRoot, VENDOR_CACHE_PARENT_NAME, CAM_VERSION, 'check-agent-frontmatter.ts'),
			);
			expect(readFileSync(path, 'utf8')).toBe(readEmbedded('check-agent-frontmatter.ts'));
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	test('AC4(d): CAM_VENDOR_CACHE_DIR override still beats the default fixed parent', () => {
		const originalTmpdir = process.env.TMPDIR;
		const originalOverride = process.env['CAM_VENDOR_CACHE_DIR'];
		const scratchRoot = createTestTmpdir('cam-embedded-bounded-');
		const overrideDir = createTestTmpdir('cam-embedded-override-');
		try {
			process.env.TMPDIR = scratchRoot;
			process.env['CAM_VENDOR_CACHE_DIR'] = overrideDir;

			const path = materializeEmbedded('check-agent-frontmatter.ts');

			expect(path).toBe(join(overrideDir, 'check-agent-frontmatter.ts'));
			expect(existsSync(path)).toBe(true);
			// The default fixed parent under the redirected TMPDIR must never
			// have been touched: the override bypasses it entirely.
			expect(existsSync(join(scratchRoot, VENDOR_CACHE_PARENT_NAME))).toBe(false);
		} finally {
			if (originalOverride === undefined) delete process.env['CAM_VENDOR_CACHE_DIR'];
			else process.env['CAM_VENDOR_CACHE_DIR'] = originalOverride;
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
			rmSync(overrideDir, { recursive: true, force: true });
		}
	});

	test('pruning reads only the fixed parent, never the temp root: an unrelated top-level sibling survives untouched', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-embedded-bounded-');
		try {
			process.env.TMPDIR = scratchRoot;
			const unrelatedSibling = join(scratchRoot, 'totally-unrelated-dir');
			mkdirSync(unrelatedSibling, { recursive: true });
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(unrelatedSibling, twoHoursAgo, twoHoursAgo);

			materializeEmbedded('check-agent-frontmatter.ts');

			expect(existsSync(unrelatedSibling)).toBe(true);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});
});
