// test/stop-sidecar-fallback.test.ts
//
// Unit tests for the scoped fallback sidecar-kill in `cam stop` (US-006).
//
// Three cases (per acceptance criteria):
//   (a) argv ['/usr/local/bin/cam','sidecar'] + cwd match -> SIGTERM sent, fallbackSidecarKilled:true
//   (b) argv ['/usr/local/bin/cam','sidecar'] + DIFFERENT cwd -> NOT matched, no SIGTERM
//   (c) argv ['cam','other'] + cwd match -> NOT matched, no SIGTERM
//
// The fallback is triggered only when the pid-file path did NOT find a live
// sidecar (sidecarPidReader returns null -> file absent).
//
// US-R2-002 (CAM-482): the US-R1-001 absolute-argv[0] anchor on
// `isSidecarArgv` was a SYMMETRIC under-match, not a fix -- it excluded a
// legitimate sidecar advertised under a bare, PATH-relative argv[0] (the
// shape every pre-US-002 binary spawns) exactly as readily as it excluded an
// impostor. `isSidecarArgv` is back to a pure argv-SHAPE quick filter
// (`argv.length >= 2 && last === 'sidecar'`, no path-absoluteness check);
// this file therefore only exercises that shape+cwd layer, which by design
// can no longer discriminate a real sidecar from an impostor sharing argv
// shape + cwd (see `isSidecarArgv`'s docstring). The real discriminator
// (process identity: does the candidate hold this project's sidecar log file
// open?) lives one layer up in `defaultListProcesses`, and is covered against
// real `ps`+`lsof`, not fixture `ProcessRecord`s, in
// test/integration/stop-defaultlistprocesses-real.test.ts.
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
// Symmetric fix (US-R2-002, CAM-482): a bare, PATH-relative argv[0] sidecar
// (the shape every pre-US-002 binary spawns, and the shape a live sidecar
// advertises when re-exec'd via a bare `cam` on PATH) is matched again at
// this argv+cwd layer. Round 1 (US-R1-001) had made this shape invisible by
// requiring an absolute argv[0], which excluded legitimate bare-name sidecars
// exactly as readily as it excluded impostors -- without ever closing the
// false-positive hole (an impostor with an ABSOLUTE argv[0], e.g.
// `/usr/bin/tail -F sidecar`, still matched throughout). The real
// false-positive defense is process identity in `defaultListProcesses` (see
// test/integration/stop-defaultlistprocesses-real.test.ts), not argv shape.
// ---------------------------------------------------------------------------

describe('sidecar fallback — bare argv[0] sidecar shape (CAM-482)', () => {
	test('a legitimate sidecar advertised under a bare, PATH-relative argv[0] IS matched', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const listProcessesFn: ListProcessesFn = () => [
			{ pid: 42003, argv: ['cam', 'sidecar'], cwd: PROJECT_CWD },
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

		expect(killCalls).toEqual([{ pid: 42003, signal: 'SIGTERM' }]);
		expect(report.fallbackSidecarKilled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Regression (US-R1-002, CAM-482): space-bearing install path -> still matched
// ---------------------------------------------------------------------------

describe('sidecar fallback — space-bearing absolute install path (CAM-482)', () => {
	test('a real sidecar whose execPath contains a space is still matched and SIGTERMd', () => {
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => { killCalls.push({ pid, signal }); };

		const listProcessesFn: ListProcessesFn = () => [
			// Mirrors what `defaultListProcesses` produces from the raw `ps`
			// args column for an install under `/Users/x/My Tools/cam sidecar`:
			// splitting on whitespace fragments the execPath into 3 elements
			// instead of the "clean" 2-element compiled shape.
			{ pid: 42005, argv: ['/Users/x/My', 'Tools/cam', 'sidecar'], cwd: PROJECT_CWD },
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

		expect(killCalls).toEqual([{ pid: 42005, signal: 'SIGTERM' }]);
		expect(report.fallbackSidecarKilled).toBe(true);
	});
});
