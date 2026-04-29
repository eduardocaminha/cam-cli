// test/init.test.ts
//
// End-to-end test for `ralph init` — exercises `runInit()` against a tmp
// config path. We don't mock the PATH lookups because (a) the dev machine
// is guaranteed to have `claude` + `claude-auto-retry` (per US-002 progress
// note + US-005 acceptance criteria), and (b) testing the validators with
// real binaries is the only way to catch a regression like "we accidentally
// match `claud` instead of `claude`".
//
// CI machines without those binaries will see a non-zero `runInit()` and
// the test will fail — that's the correct signal for a misconfigured CI.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from '../src/commands/init.ts';
import { loadConfig } from '../src/config/toml.ts';

let workDir: string;
let configPath: string;
let prevConfigPath: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'ralph-cli-init-'));
	configPath = join(workDir, '.config', 'ralph', 'config.toml');
	prevConfigPath = process.env.RALPH_CONFIG_PATH;
	process.env.RALPH_CONFIG_PATH = configPath;
});

afterEach(() => {
	if (prevConfigPath === undefined) {
		delete process.env.RALPH_CONFIG_PATH;
	} else {
		process.env.RALPH_CONFIG_PATH = prevConfigPath;
	}
	if (workDir && existsSync(workDir)) {
		rmSync(workDir, { recursive: true, force: true });
	}
});

describe('runInit', () => {
	test('writes config.toml with permission_mode=bypassPermissions on a fresh path', () => {
		const exitCode = runInit();
		// On the dev machine claude + claude-auto-retry are on PATH, so we expect 0.
		// If this fails locally, double-check `which claude` and `which claude-auto-retry`.
		expect(exitCode).toBe(0);
		expect(existsSync(configPath)).toBe(true);
		const config = loadConfig(configPath);
		expect(config.permission_mode).toBe('bypassPermissions');
	});

	test('preserves existing keys when re-running', () => {
		const exitCode1 = runInit();
		expect(exitCode1).toBe(0);
		const exitCode2 = runInit();
		expect(exitCode2).toBe(0);
		const config = loadConfig(configPath);
		expect(config.permission_mode).toBe('bypassPermissions');
	});

	test('uses RALPH_CONFIG_PATH override (not ~/.config/ralph/config.toml)', () => {
		runInit();
		// The tmp config path was written.
		expect(existsSync(configPath)).toBe(true);
		// Sanity: the path is under our tmp dir, not under the real home.
		expect(configPath.startsWith(workDir)).toBe(true);
	});

	test('produces a TOML file with a trailing newline', () => {
		runInit();
		const raw = readFileSync(configPath, 'utf8');
		expect(raw.endsWith('\n')).toBe(true);
		expect(raw).toContain('permission_mode = "bypassPermissions"');
	});
});
