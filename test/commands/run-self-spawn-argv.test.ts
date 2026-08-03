// test/commands/run-self-spawn-argv.test.ts
//
// US-002 (CAM-482): the loop's five background self-respawn sites must
// launch the EXACT binary that is running the loop, not a literal `cam` name
// resolved off PATH (a long-lived session must never respawn a stale PATH
// binary whose code disagrees with the branch that spawned it).
//
// Each site is now a PURE, injectable argv builder (execPath, argv1) => argv,
// reusing resolveSelfInvokeArgv exactly as forkMonitor already does
// (src/retry/launcher.ts:242): spread it, then append the subcommand. This
// test asserts REAL argv shape (never "the mock was called") for all five
// sites:
//   1. buildDashboardRespawnArgv  - dashboard tmux respawn-pane argv (run.ts)
//   2. buildSidecarSpawnArgv      - sidecar Bun.spawn argv (run.ts)
//   3. buildRecycleWatchSpawnArgv - orch-recycle-watch Bun.spawn argv (run.ts)
//   4. buildSidecarLivenessWatchSpawnArgv - sidecar-liveness-watch Bun.spawn
//      argv (run.ts)
//   5. buildSidecarRespawnArgv    - sidecar-liveness-watch.ts's own sidecar
//      respawn Bun.spawn argv
//
// Each case injects an execPath whose basename ("injected-exec") differs from
// the real running binary's basename, proving the argv is actually built from
// the injected pair rather than falling back to process.execPath internally.

import { describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import process from 'node:process';

import {
	buildDashboardRespawnArgv,
	buildSidecarSpawnArgv,
	buildRecycleWatchSpawnArgv,
	buildSidecarLivenessWatchSpawnArgv,
} from '../../src/commands/run.ts';
import { buildSidecarRespawnArgv } from '../../src/commands/sidecar-liveness-watch.ts';

const INJECTED_EXEC_PATH = '/opt/injected-exec/injected-exec';
const INJECTED_ARGV1 = '/repo/injected-script.ts';

// Sanity: the injected execPath's basename must genuinely differ from the
// real binary running this test, so a builder that silently fell back to
// process.execPath would be caught red-handed.
const realBasename = basename(process.execPath);
if (basename(INJECTED_EXEC_PATH) === realBasename) {
	throw new Error('test fixture collision: pick an injected execPath basename that differs from the real one');
}

/** No product-name literal ("cam") anywhere in the argv words. */
function assertNoProductNameLiteral(argv: string[]): void {
	for (const word of argv) {
		expect(word.toLowerCase()).not.toBe('cam');
	}
}

describe('self-respawn argv builders (US-002, CAM-482)', () => {
	test('buildDashboardRespawnArgv: compiled mode (argv1 absent) starts with the injected execPath, carries the subcommand + pane id, no literal binary name', () => {
		const argv = buildDashboardRespawnArgv(INJECTED_EXEC_PATH, undefined, '%3');
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv).toEqual([INJECTED_EXEC_PATH, 'dashboard', '%3']);
		assertNoProductNameLiteral(argv);
	});

	test('buildDashboardRespawnArgv: interpreted mode (execPath + argv1) starts with the injected execPath, both tokens precede the subcommand', () => {
		const argv = buildDashboardRespawnArgv(INJECTED_EXEC_PATH, INJECTED_ARGV1, '%3');
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv).toEqual([INJECTED_EXEC_PATH, INJECTED_ARGV1, 'dashboard', '%3']);
		assertNoProductNameLiteral(argv);
	});

	test('buildSidecarSpawnArgv: starts with the injected execPath and appends only "sidecar"', () => {
		const argv = buildSidecarSpawnArgv(INJECTED_EXEC_PATH, INJECTED_ARGV1);
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv).toEqual([INJECTED_EXEC_PATH, INJECTED_ARGV1, 'sidecar']);
		assertNoProductNameLiteral(argv);
	});

	test('buildRecycleWatchSpawnArgv: starts with the injected execPath and appends only "orch-recycle-watch"', () => {
		const argv = buildRecycleWatchSpawnArgv(INJECTED_EXEC_PATH, INJECTED_ARGV1);
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv).toEqual([INJECTED_EXEC_PATH, INJECTED_ARGV1, 'orch-recycle-watch']);
		assertNoProductNameLiteral(argv);
	});

	test('buildSidecarLivenessWatchSpawnArgv: starts with the injected execPath and appends only "sidecar-liveness-watch"', () => {
		const argv = buildSidecarLivenessWatchSpawnArgv(INJECTED_EXEC_PATH, INJECTED_ARGV1);
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv).toEqual([INJECTED_EXEC_PATH, INJECTED_ARGV1, 'sidecar-liveness-watch']);
		assertNoProductNameLiteral(argv);
	});

	test('buildSidecarRespawnArgv (sidecar-liveness-watch.ts): starts with the injected execPath and appends only "sidecar"', () => {
		const argv = buildSidecarRespawnArgv(INJECTED_EXEC_PATH, INJECTED_ARGV1);
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv).toEqual([INJECTED_EXEC_PATH, INJECTED_ARGV1, 'sidecar']);
		assertNoProductNameLiteral(argv);
	});

	test('degenerate interpreted mode (argv1 undefined) collapses every builder to [execPath, subcommand] alone', () => {
		expect(buildSidecarSpawnArgv(INJECTED_EXEC_PATH, undefined)).toEqual([INJECTED_EXEC_PATH, 'sidecar']);
		expect(buildRecycleWatchSpawnArgv(INJECTED_EXEC_PATH, undefined)).toEqual([
			INJECTED_EXEC_PATH,
			'orch-recycle-watch',
		]);
		expect(buildSidecarLivenessWatchSpawnArgv(INJECTED_EXEC_PATH, undefined)).toEqual([
			INJECTED_EXEC_PATH,
			'sidecar-liveness-watch',
		]);
		expect(buildSidecarRespawnArgv(INJECTED_EXEC_PATH, undefined)).toEqual([INJECTED_EXEC_PATH, 'sidecar']);
	});
});
