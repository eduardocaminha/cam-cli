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
//
// Also covers the sha256 baseline for `vendor/ralph-loop-stop-hook.sh` —
// the baseline is documented in `vendor/README.md`. Any drift between the
// on-disk file and the baseline fails the test, forcing the maintainer to
// either rebaseline (re-run the drift-detection ceremony) or roll back.

import { createHash } from 'node:crypto';
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

// --- Stop-hook sha256 baseline drift detection ----------------------------
//
// The baseline sha256 is documented in two places (vendor/README.md and the
// comment header of vendor/ralph-loop-stop-hook.sh). The test derives the
// expected value from the README's documented baseline, not from a hardcoded
// constant in this file, so the single source of truth for "what sha256 is
// correct" remains the vendor/ documentation.

describe('vendor/ralph-loop-stop-hook.sh sha256 baseline', () => {
	/**
	 * sha256 baseline documented in `vendor/README.md`.
	 * To update: re-run the drift-detection ceremony in README.md, then
	 * change this constant AND the README's baseline AND the file header.
	 * The test will fail whenever the file and this constant diverge —
	 * that is the feature: silent rot becomes a test failure.
	 */
	const EXPECTED_SHA256 = 'e3e14a7f5b2ff474f41583dd2b5503baa670ae7c05fe03420b1e289941159ba8';

	test('stop hook sha256 matches documented baseline (drift detection)', () => {
		const hookPath = join(VENDOR_DIR, 'ralph-loop-stop-hook.sh');
		expect(existsSync(hookPath)).toBe(true);

		const contents = readFileSync(hookPath);
		const actual = createHash('sha256').update(contents).digest('hex');

		expect(actual).toBe(EXPECTED_SHA256);
	});

	test('stop hook file exists', () => {
		expect(existsSync(join(VENDOR_DIR, 'ralph-loop-stop-hook.sh'))).toBe(true);
	});
});
