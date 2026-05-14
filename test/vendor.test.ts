// test/vendor.test.ts
//
// Covers the sha256 baseline for `vendor/cam-loop-stop-hook.sh` —
// the baseline is documented in `vendor/README.md`. Any drift between the
// on-disk file and the baseline fails the test, forcing the maintainer to
// either rebaseline or roll back.
//
// cam-cli is the source of truth for the vendored hook + template; the
// reporter checkout is referenced only for the smoke files
// (check-agent-frontmatter.{sh,ts}, claude-auto-retry-patterns.ts).

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'vendor');

// --- Stop-hook sha256 baseline drift detection ----------------------------
//
// The baseline sha256 is documented in `vendor/README.md`. The test fails
// whenever the on-disk file diverges from the documented baseline, so any
// accidental edit to the hook produces an explicit test failure rather
// than silent rot.

describe('vendor/cam-loop-stop-hook.sh sha256 baseline', () => {
	/**
	 * sha256 baseline documented in `vendor/README.md`. To update after an
	 * intentional change to the hook: recompute the sha (`shasum -a 256
	 * vendor/cam-loop-stop-hook.sh`), then change this constant AND the
	 * README's baseline. The test fails whenever the file and this constant
	 * diverge — silent rot becomes a test failure.
	 */
	const EXPECTED_SHA256 = '32587c4699ecbf1f4e4bbf51761b518e4fabe74fa3b0cf8f71fdf3d1a214c5c6';

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
