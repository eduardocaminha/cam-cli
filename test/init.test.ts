// test/init.test.ts
//
// End-to-end test for `cam init` — exercises `runInit()` against an isolated
// `~/.config/cam` directory, redirected via a genuinely separate child
// process spawned with `HOME` set at spawn time.
//
// `cam init` no longer writes `~/.config/cam/config.toml` (US-001, CAM-458):
// its one seeded key was never read by any spawn path, and no code path in
// src/commands/init.ts reads `CAM_CONFIG_PATH` any more (that env var is
// dead — nothing in src/ reads it), so a test that redirects `CAM_CONFIG_PATH`
// and asserts on that redirected path is bound to a seam nothing in
// production touches and can never go red.
//
// The obvious in-process replacement seam, mutating `process.env.HOME` for
// the test process and asserting against `join(homedir(), '.config', 'cam',
// ...)`, does not work on this runtime: verified empirically (not from docs)
// that Bun's `node:os` `homedir()` does NOT re-read `process.env.HOME` after
// process start, unlike the documented Node.js behavior — mutating
// `process.env.HOME` mid-test has no effect on subsequent `homedir()` calls.
// A first cut of this test (US-001, CAM-458) worked around that by
// snapshotting the REAL, unredirected `~/.config/cam` before/after and
// asserting no change — the reviewer (round 2) correctly flagged that as
// environment-dependent: on any machine that already has
// `~/.config/cam/config.toml` (this repo's own dev machine included, from
// pre-US-001 `cam init` runs), a name-only directory listing is identical
// before and after even if a future regression *overwrites* that exact file,
// so the guard could go green on a real regression. See
// `scripts/cam/patterns.md` for the empirical write-up of both findings.
//
// This test now takes the genuinely deterministic seam instead: `HOME` set
// in the env of a freshly spawned `bun` child process (`process.env.HOME`
// mutated *before* the Bun binary starts DOES redirect `homedir()`,
// confirmed empirically) running `test/fixtures/init-home-redirect-probe.ts`
// against a fresh, empty temp dir. That temp dir is guaranteed to have no
// `.config/cam` before the probe runs, on every machine (dev box or CI
// runner) — so the assertion is a fixed `null` before AND after, not a
// same-as-before diff, and it goes red the moment any future code path
// writes anything under the (isolated) config dir, including at the exact
// default path `join(homedir(), '.config', 'cam', 'config.toml')`.
//
// This test does NOT assert on the runInit() exit code because the exit
// code couples to whether `claude` is on PATH (the claude-presence check
// fails on CI runners that have no claude binary, returning exit code 1
// regardless of config writes). The oracle for this test is:
//   env PATH="/usr/bin:/bin:$(dirname "$(command -v bun)")" bun test test/init.test.ts
// which must pass without claude on PATH.

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createTestTmpdir } from './helpers/test-tmpdir';
import { join } from 'node:path';

const probePath = join(import.meta.dir, 'fixtures', 'init-home-redirect-probe.ts');

describe('runInit', () => {
	let fakeHome: string | undefined;

	afterEach(() => {
		if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
		fakeHome = undefined;
	});

	test('never creates or removes anything under an isolated ~/.config/cam, across repeated runs', () => {
		fakeHome = createTestTmpdir('cam-init-home-');

		const result = Bun.spawnSync(['bun', probePath], {
			env: { ...process.env, HOME: fakeHome },
			stdout: 'pipe',
			stderr: 'pipe',
		});

		expect(result.exitCode).toBe(0);
		// `runInit()`'s linear path prints its own check-summary lines to
		// stdout ahead of the probe's JSON; the probe always writes its JSON
		// as the last line (see test/fixtures/init-home-redirect-probe.ts).
		const lines = result.stdout.toString('utf8').trim().split('\n');
		const jsonLine = lines[lines.length - 1] ?? '';
		const parsed = JSON.parse(jsonLine) as { before: string[] | null; after: string[] | null };

		// The temp HOME starts empty, so `~/.config/cam` must be absent both
		// before and after — a fixed, environment-independent expectation that
		// goes red the instant runInit() writes anything under it.
		expect(parsed.before).toBeNull();
		expect(parsed.after).toBeNull();
	});
});
