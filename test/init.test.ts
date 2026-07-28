// test/init.test.ts
//
// End-to-end test for `cam init` — exercises `runInit()` against a tmp
// config path.
//
// `cam init` no longer writes `~/.config/cam/config.toml` (US-001, CAM-458):
// its one seeded key was never read by any spawn path. These tests prove
// init leaves the `CAM_CONFIG_PATH` target absent rather than asserting on
// any config content. They do NOT
// assert on the runInit() exit code because the exit code couples to whether
// `claude` is on PATH (the claude-presence check fails on CI runners that
// have no claude binary, returning exit code 1 regardless of the config
// write). The oracle for these tests is:
//   env PATH="/usr/bin:/bin:$(dirname "$(command -v bun)")" bun test test/init.test.ts
// which must pass without claude on PATH.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

let workDir: string;
let configPath: string;
let prevConfigPath: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'cam-cli-init-'));
	configPath = join(workDir, '.config', 'cam', 'config.toml');
	prevConfigPath = process.env.CAM_CONFIG_PATH;
	process.env.CAM_CONFIG_PATH = configPath;
});

afterEach(() => {
	if (prevConfigPath === undefined) {
		delete process.env.CAM_CONFIG_PATH;
	} else {
		process.env.CAM_CONFIG_PATH = prevConfigPath;
	}
	if (workDir && existsSync(workDir)) {
		rmSync(workDir, { recursive: true, force: true });
	}
});

describe('runInit', () => {
	test('leaves the CAM_CONFIG_PATH target absent on a fresh machine', async () => {
		// Exit code is NOT asserted: it depends on whether `claude` is on PATH
		// (a CI environment concern, unrelated to whether a config file gets written).
		await runInit({ spawnFn: stubSpawnFn });
		expect(existsSync(configPath)).toBe(false);
	});

	test('still leaves the target absent across repeated runs', async () => {
		// Run twice; exit codes are NOT asserted (PATH-coupling concern, see file header).
		await runInit({ spawnFn: stubSpawnFn });
		await runInit({ spawnFn: stubSpawnFn });
		expect(existsSync(configPath)).toBe(false);
	});

	test('CAM_CONFIG_PATH target sits under the tmp workDir, never the real home', async () => {
		await runInit({ spawnFn: stubSpawnFn });
		expect(existsSync(configPath)).toBe(false);
		// Sanity: the path we asserted against is under our tmp dir, not the real home.
		expect(configPath.startsWith(workDir)).toBe(true);
	});
});
