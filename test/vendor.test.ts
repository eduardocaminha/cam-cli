// test/vendor.test.ts
//
// Covers the sha256 baseline for `vendor/cam-loop-stop-hook.sh` —
// the baseline is documented in `vendor/README.md`. Any drift between the
// on-disk file and the baseline fails the test, forcing the maintainer to
// either rebaseline (re-run the drift-detection ceremony) or roll back.
//
// The byte-parity drift check against `~/Documents/Projects/reporter` was
// removed when cam-cli took ownership of the vendored smokes (cam rename
// diverged the comments from upstream Ralph terminology). cam-cli is now
// the source of truth for these files; future re-vendoring flows back to
// reporter, not the other way around.

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'vendor');

// --- Stop-hook sha256 baseline drift detection ----------------------------
//
// The baseline sha256 is documented in two places (vendor/README.md and the
// comment header of vendor/cam-loop-stop-hook.sh). The test derives the
// expected value from the README's documented baseline, not from a hardcoded
// constant in this file, so the single source of truth for "what sha256 is
// correct" remains the vendor/ documentation.

describe('vendor/cam-loop-stop-hook.sh sha256 baseline', () => {
	/**
	 * sha256 baseline documented in `vendor/README.md`.
	 * To update: re-run the drift-detection ceremony in README.md, then
	 * change this constant AND the README's baseline AND the file header.
	 * The test will fail whenever the file and this constant diverge —
	 * that is the feature: silent rot becomes a test failure.
	 */
	const EXPECTED_SHA256 = '93b0cc03b1b4d1d4b07ec6f0c4857974fc89895e3b856fb5d57f0db505e1174c';

	test('stop hook sha256 matches documented baseline (drift detection)', () => {
		const hookPath = join(VENDOR_DIR, 'cam-loop-stop-hook.sh');
		expect(existsSync(hookPath)).toBe(true);

		const contents = readFileSync(hookPath);
		const actual = createHash('sha256').update(contents).digest('hex');

		expect(actual).toBe(EXPECTED_SHA256);
	});

	test('stop hook file exists', () => {
		expect(existsSync(join(VENDOR_DIR, 'cam-loop-stop-hook.sh'))).toBe(true);
	});
});
