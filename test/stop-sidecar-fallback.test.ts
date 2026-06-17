// test/stop-sidecar-fallback.test.ts
//
// Unit tests for the scoped fallback sidecar-kill in `cam stop` (US-006).
//
// Three cases (per acceptance criteria):
//   (a) argv ['cam','sidecar'] + cwd match -> SIGTERM sent, fallbackSidecarKilled:true
//   (b) argv ['cam','sidecar'] + DIFFERENT cwd -> NOT matched, no SIGTERM
//   (c) argv ['cam','other'] + cwd match -> NOT matched, no SIGTERM
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
			{ pid: 42000, argv: ['cam', 'sidecar'], cwd: PROJECT_CWD },
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
			{ pid: 42001, argv: ['cam', 'sidecar'], cwd: FOREIGN_CWD },
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
