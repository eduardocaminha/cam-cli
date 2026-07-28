// test/init.test.ts
//
// End-to-end test for `cam init` — exercises `runInit()` against the real
// `~/.config/cam` directory, snapshotted before/after rather than redirected.
//
// `cam init` no longer writes `~/.config/cam/config.toml` (US-001, CAM-458):
// its one seeded key was never read by any spawn path, and no code path in
// src/commands/init.ts reads `CAM_CONFIG_PATH` any more (that env var is
// dead — nothing in src/ reads it), so a test that redirects `CAM_CONFIG_PATH`
// and asserts on that redirected path is bound to a seam nothing in
// production touches and can never go red.
//
// The obvious replacement seam, redirecting `HOME` for the test process and
// asserting against `join(homedir(), '.config', 'cam', ...)`, does not work
// on this runtime: verified empirically (not from docs) that Bun's
// `node:os` `homedir()` does NOT re-read `process.env.HOME` after process
// start, unlike the documented Node.js behavior — mutating `process.env.HOME`
// mid-test has no effect on subsequent `homedir()` calls. See
// `scripts/cam/patterns.md` for the write-up.
//
// So this test binds to the one seam that IS real and unfakeable: the
// process's actual `homedir()` (whatever it resolves to, dev machine or CI
// runner) and its actual `.config/cam/` directory contents. It snapshots
// that directory's entries before calling `runInit()`, runs it (twice, to
// also cover repeated-run idempotency), and asserts the entries are
// unchanged — this goes red the moment any future code path writes a new
// file under `~/.config/cam/`, including at the exact default path
// `join(homedir(), '.config', 'cam', 'config.toml')`. It is safe to run on a
// dev machine that already has stale files there (this repo's own dev
// machine does, from `cam init` runs that predate US-001) because it only
// asserts *no change*, never a fixed empty state.
//
// This test does NOT assert on the runInit() exit code because the exit
// code couples to whether `claude` is on PATH (the claude-presence check
// fails on CI runners that have no claude binary, returning exit code 1
// regardless of config writes). The oracle for this test is:
//   env PATH="/usr/bin:/bin:$(dirname "$(command -v bun)")" bun test test/init.test.ts
// which must pass without claude on PATH.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runInit, type SpawnFn } from '../src/commands/init.ts';

// Deterministic stub for the three real subprocess spawns runInit's linear
// path makes (CAM-205): `command -v claude` via /bin/sh, `claude --version`,
// and the vendored `bun <smoke-script>` run. Exit codes are deliberately not
// asserted anywhere in this file (see header above), so any stable shape is
// fine — we simulate "claude not found" (mirrors CI runners with no claude
// binary) and a skipped vendored smoke, matching the existing PATH-coupling
// rationale without ever touching a real process.
const stubSpawnFn: SpawnFn = (cmd, args) => {
	if (cmd === '/bin/sh' && args[0] === '-c' && args[1] === 'command -v claude') {
		return { status: 1, stdout: '', stderr: '' };
	}
	if (cmd === 'claude' && args[0] === '--version') {
		return { status: 0, stdout: 'Claude Code 2.5.0 (Sonnet 4.6)\n', stderr: '' };
	}
	if (cmd === 'bun') {
		return { status: 2, stdout: '[smoke] skipping — stubbed in test\n', stderr: '' };
	}
	return { status: 1, stdout: '', stderr: `unexpected stub spawn: ${cmd} ${args.join(' ')}` };
};

/** Sorted directory listing, or `null` when the directory doesn't exist. */
function snapshotDir(dir: string): string[] | null {
	if (!existsSync(dir)) return null;
	return [...readdirSync(dir)].sort();
}

describe('runInit', () => {
	test('never creates or removes anything under ~/.config/cam, across repeated runs', async () => {
		const configDir = join(homedir(), '.config', 'cam');
		const before = snapshotDir(configDir);

		// Run twice; exit codes are NOT asserted (PATH-coupling concern, see file header).
		await runInit({ spawnFn: stubSpawnFn });
		await runInit({ spawnFn: stubSpawnFn });

		const after = snapshotDir(configDir);
		expect(after).toEqual(before);
	});
});
