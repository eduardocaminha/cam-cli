// test/integration/sidecar-liveness-watch-fd-leak.test.ts
//
// US-R8-002 (CAM-482): the US-R6-002 fd-leak fix (`closeSync(logFd)` right
// after `Bun.spawn` inside `makeSpawnSidecarFn`,
// src/commands/sidecar-liveness-watch.ts:149) shipped with no falsifying
// test. Every existing test that constructs this production closure
// (test/integration/stop-defaultlistprocesses-real.test.ts) only asserts
// CHILD discoverability + SIGTERM delivery, which hold identically whether
// or not the PARENT's copy of the log fd is closed -- so removing the
// `closeSync(logFd)` line would leave the whole suite green.
//
// This test calls the real, exported `makeSpawnSidecarFn` closure multiple
// times and asserts via `lsof -p <own pid>` that the CALLING (parent)
// process's own descriptor table never accumulates an open fd on
// `.claude/cam-supervisor.log`: each respawn's child holds its own
// duplicated descriptor (see the closure's own doc comment), so once the
// child has started, the parent's copy is redundant and must be closed.
//
// Skips cleanly when `lsof` is absent (legitimate-environmental in the
// oven/bun worker-container image, see test/helpers/test-deps.ts).

import { test, expect } from 'bun:test';
import { mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import process from 'node:process';

import {
	buildSidecarRespawnArgv,
	makeSpawnSidecarFn,
	type SidecarLivenessWatchProcessHandle,
} from '../../src/commands/sidecar-liveness-watch.ts';
import { lsofAvailable } from '../helpers/test-deps.ts';

// Idles long enough to stay alive across the whole test body; killed in the
// `finally` block below. Source text for a spawned child script, not a fixed
// sleep in this test's own async control flow (CAM-482: test-sleeps gate
// pattern-matches string literals too).
const IDLE_SCRIPT_BODY = 'await new Promise((resolve) => setTimeout(resolve, 20000));\n'; // CAM-482: child-script source text, not a fixed sleep

/** Count how many of the CALLING process's own open fds point at `path`, via `lsof -p <pid>`. */
function countOwnOpenFdsOn(path: string): number {
	const result = Bun.spawnSync(['lsof', '-p', String(process.pid)], { stdout: 'pipe', stderr: 'ignore' });
	const stdout = result.stdout instanceof Buffer ? result.stdout.toString('utf8') : '';
	return stdout.split('\n').filter((line) => line.includes(path)).length;
}

test.skipIf(!lsofAvailable)(
	'makeSpawnSidecarFn closes the PARENT-side log fd after every respawn (US-R6-002 regression, made falsifiable in US-R8-002)',
	async () => {
		const tempDirRaw = createTestTmpdir('cam-sidecar-liveness-fdleak-');
		// lsof reports the process's REAL (symlink-resolved) cwd, mirroring the
		// realpath handling in stop-defaultlistprocesses-real.test.ts.
		const projectCwd = realpathSync(tempDirRaw);
		const claudeDir = join(projectCwd, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		const logPath = join(claudeDir, 'cam-supervisor.log');

		const markerScript = join(projectCwd, 'fd-leak-marker.ts');
		writeFileSync(markerScript, IDLE_SCRIPT_BODY, 'utf8');
		// Same argv-override seam stop-defaultlistprocesses-real.test.ts uses:
		// under `bun test`, `process.argv[1]` is this test file's own path, so
		// the real self-invoke default would re-spawn the whole suite.
		const respawnArgv = buildSidecarRespawnArgv(process.execPath, markerScript);
		const spawnSidecarFn = makeSpawnSidecarFn(projectCwd, respawnArgv);

		const handles: SidecarLivenessWatchProcessHandle[] = [];
		try {
			const before = countOwnOpenFdsOn(logPath);

			// Mirrors handleOneTick's real-world repeated-respawn scenario: a
			// flapping sidecar re-invokes this same closure every time
			// `state.attempts` resets to 0 on recovery, without bound over a
			// session's lifetime.
			const RESPAWN_COUNT = 3;
			for (let i = 0; i < RESPAWN_COUNT; i++) {
				handles.push(spawnSidecarFn());
			}

			const after = countOwnOpenFdsOn(logPath);

			// Before the US-R6-002 fix (i.e. if `closeSync(logFd)` were removed
			// from makeSpawnSidecarFn), each respawn leaves the PARENT holding one
			// more open fd on the log path, so `after` would be `before +
			// RESPAWN_COUNT`. With the fix, the parent's copy is closed
			// immediately after `Bun.spawn` hands the child its own duplicate, so
			// the parent's own count never grows.
			expect(after).toBe(before);
		} finally {
			for (const handle of handles) {
				try {
					handle.kill();
				} catch {
					// best-effort cleanup
				}
			}
			rmSync(tempDirRaw, { recursive: true, force: true });
		}
	},
	15_000,
);
