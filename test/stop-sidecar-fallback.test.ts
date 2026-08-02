// test/stop-sidecar-fallback.test.ts
//
// Unit tests for the scoped fallback sidecar-kill in `cam stop` (US-006).
//
// Three cases (per acceptance criteria):
//   (a) argv ['/usr/local/bin/cam','sidecar'] + cwd match -> SIGTERM sent, fallbackSidecarKilled:true
//   (b) argv ['/usr/local/bin/cam','sidecar'] + DIFFERENT cwd -> NOT matched, no SIGTERM
//   (c) argv ['cam','other'] + cwd match -> NOT matched, no SIGTERM
//
// Plus a false-positive-class regression case (US-R1-001, CAM-482): an
// unrelated command whose argv happens to end in the literal word 'sidecar'
// but whose argv[0] is a bare PATH-relative name (not an absolute path, so
// not a real self-spawn) must NOT be matched, even with a matching cwd.
//
// The fallback is triggered only when the pid-file path did NOT find a live
// sidecar (sidecarPidReader returns null -> file absent).
//
// No blanket `pkill cam sidecar` is used; scoping is strict cwd equality.

import { describe, expect, test } from 'bun:test';
import type { KillFn, ListProcessesFn, SpawnSyncFn } from '../src/commands/stop.ts';
import { performStop } from '../src/commands/stop.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake SpawnSyncFn that reports tmux unavailable (exit 1 for everything). */
const noTmuxSpawn: SpawnSyncFn = () => ({
	pid: 1,
	output: ['', '', ''] as (string | null)[],
	stdout: '',
	stderr: '',
	status: 1,
	signal: null,
});

const PROJECT_CWD = '/fake/project-alpha';
const FOREIGN_CWD = '/fake/project-beta';

// ---------------------------------------------------------------------------
// Case (a): matching argv + matching cwd -> SIGTERM sent
// ---------------------------------------------------------------------------

describe('sidecar fallback — matching cwd', () => {
	test('cam sidecar process with matching cwd is SIGTERMd, fallbackSidecarKilled:true', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const listProcessesFn: ListProcessesFn = () => [
			{ pid: 42000, argv: ['/usr/local/bin/cam', 'sidecar'], cwd: PROJECT_CWD },
		];

		const report = performStop({
			cwd: PROJECT_CWD,
			spawnSyncFn: noTmuxSpawn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			// Pid file absent -> triggers fallback scan
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn,
			listProcessesFn,
		});

		expect(killCalls).toEqual([{ pid: 42000, signal: 'SIGTERM' }]);
		expect(report.fallbackSidecarKilled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Case (b): matching argv + DIFFERENT cwd -> foreign-project sidecar is safe
// ---------------------------------------------------------------------------

describe('sidecar fallback — foreign cwd', () => {
	test('cam sidecar with a DIFFERENT cwd is NOT matched, no SIGTERM', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const listProcessesFn: ListProcessesFn = () => [
			{ pid: 42001, argv: ['/usr/local/bin/cam', 'sidecar'], cwd: FOREIGN_CWD },
		];

		const report = performStop({
			cwd: PROJECT_CWD,
			spawnSyncFn: noTmuxSpawn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn,
			listProcessesFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.fallbackSidecarKilled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Case (c): non-sidecar argv + matching cwd -> not matched
// ---------------------------------------------------------------------------

describe('sidecar fallback — non-sidecar argv', () => {
	test('non-sidecar process with matching cwd is NOT matched, no SIGTERM', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const listProcessesFn: ListProcessesFn = () => [
			{ pid: 42002, argv: ['cam', 'run'], cwd: PROJECT_CWD },
		];

		const report = performStop({
			cwd: PROJECT_CWD,
			spawnSyncFn: noTmuxSpawn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn,
			listProcessesFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.fallbackSidecarKilled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Regression (US-R1-001, CAM-482): argv[0] not an absolute path -> NOT matched
// ---------------------------------------------------------------------------

describe('sidecar fallback — false-positive argv class (CAM-482)', () => {
	test('an ad-hoc command ending in the literal word "sidecar" with a bare argv[0] is NOT matched', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const listProcessesFn: ListProcessesFn = () => [
			{ pid: 42003, argv: ['tail', '-F', 'sidecar'], cwd: PROJECT_CWD },
			{ pid: 42004, argv: ['rg', 'sidecar'], cwd: PROJECT_CWD },
		];

		const report = performStop({
			cwd: PROJECT_CWD,
			spawnSyncFn: noTmuxSpawn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn,
			listProcessesFn,
		});

		expect(killCalls.length).toBe(0);
		expect(report.fallbackSidecarKilled).toBe(false);
	});
});
