// test/vendor.test.ts
//
// Drift detection for the vendored smokes in `vendor/`. Compares the bytes
// of each vendored file against the corresponding file in the
// eduardocaminha/reporter checkout at `~/Documents/Projects/reporter`.
//
// Skip-when-missing: most contributors won't have the reporter monorepo
// checked out at that exact path. The test silently skips in that case so
// CI on non-Eduardo machines doesn't fail spuriously. The real signal is the
// dev-machine run before each vendor bump.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'vendor');
const REPORTER_SMOKE_DIR =
	process.env.RALPH_REPORTER_SMOKE_DIR ?? join(homedir(), 'Documents', 'Projects', 'reporter', 'scripts', 'smoke');

const VENDORED_FILES = [
	'check-agent-frontmatter.sh',
	'check-agent-frontmatter.ts',
	'claude-auto-retry-patterns.ts',
] as const;

const reporterPresent = existsSync(REPORTER_SMOKE_DIR);

describe('vendored smoke drift', () => {
	if (!reporterPresent) {
		test.skip('reporter checkout not at ~/Documents/Projects/reporter — skipping drift check', () => {
			expect(true).toBe(true);
		});
		return;
	}

	for (const filename of VENDORED_FILES) {
		test(`${filename} matches reporter HEAD byte-for-byte`, () => {
			const vendorPath = join(VENDOR_DIR, filename);
			const reporterPath = join(REPORTER_SMOKE_DIR, filename);
			expect(existsSync(vendorPath)).toBe(true);
			expect(existsSync(reporterPath)).toBe(true);
			const vendored = readFileSync(vendorPath, 'utf8');
			const upstream = readFileSync(reporterPath, 'utf8');
			expect(vendored).toBe(upstream);
		});
	}
});
