// test/integration/stop-defaultlistprocesses-real.test.ts
//
// US-R1-003 (CAM-482): US-004's only new coverage
// (test/commands/stop-name-agnostic.test.ts) feeds hand-built ProcessRecord
// objects straight into matchesSidecarForProject; nothing in that diff (or
// any diff since) exercises `defaultListProcesses` (src/commands/stop.ts),
// the code that actually parses real `ps -eo pid,args` output and calls
// `lsof` to resolve cwd -- the exact surface US-R1-002 changed (the quick
// filter swapped to `isSidecarArgv`, `argv[0]` basename normalization
// deleted). A fixture-only test encodes exactly the token shape the code
// expects and is blind to a real parsing regression in that boundary (the
// "fakes lie" class, patterns.md CAM-55 / the project's own test-quality
// rule: "hit real I/O at wire boundaries").
//
// This test spawns a REAL process shaped exactly like the interpreted
// self-spawn argv (`[runtime, script, 'sidecar']`, see isSidecarArgv's
// docstring and case 2 of stop-name-agnostic.test.ts) in a private temp cwd,
// and drives it through the REAL production path: `performStop` with no
// `listProcessesFn` override, so the default `defaultListProcesses` (real
// `ps` + `lsof`) performs the discovery. A second, adjacent process in the
// SAME cwd whose argv does not end in the literal 'sidecar' token must NOT
// be matched (or killed) -- isSidecarArgv's quick filter excludes it before
// `lsof` is ever consulted.
//
// Skips cleanly when `ps` or `lsof` is absent (both legitimate-environmental
// in the oven/bun worker-container image, see test/helpers/test-deps.ts).

import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { performStop } from '../../src/commands/stop.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';
import { psAvailable, lsofAvailable } from '../helpers/test-deps.ts';

// A script body that just idles long enough for `ps`+`lsof` to observe the
// process; both spawned scripts share this body -- only their trailing argv
// token differs (the thing isSidecarArgv actually discriminates on). This is
// SOURCE TEXT written to a spawned child script, not a fixed sleep in this
// test's own async control flow -- check:test-sleeps pattern-matches string
// literals too, so it is cited inline below (CAM-482) to suppress the gate.
const IDLE_SCRIPT_BODY = 'await new Promise((resolve) => setTimeout(resolve, 20000));\n'; // CAM-482: child-script source text, not a fixed sleep

test.skipIf(!psAvailable || !lsofAvailable)(
	'defaultListProcesses: discovers a real interpreted sidecar process via ps+lsof, and does NOT match an adjacent non-sidecar process in the same cwd',
	async () => {
		const tempDirRaw = mkdtempSync(join(tmpdir(), 'cam-stop-real-listprocesses-'));
		// lsof reports the process's REAL (symlink-resolved) cwd -- macOS's
		// /tmp is itself a symlink to /private/tmp, so this test must compare
		// against the realpath, not the raw mkdtemp path, or the cwd-equality
		// check in matchesSidecarForProject spuriously fails.
		const projectCwd = realpathSync(tempDirRaw);

		const sidecarScript = join(projectCwd, 'sidecar-marker.ts');
		const otherScript = join(projectCwd, 'other-marker.ts');
		writeFileSync(sidecarScript, IDLE_SCRIPT_BODY, 'utf8');
		writeFileSync(otherScript, IDLE_SCRIPT_BODY, 'utf8');

		// Interpreted self-spawn shape: [runtime, script, 'sidecar'].
		const sidecarProc = Bun.spawn([process.execPath, sidecarScript, 'sidecar'], {
			cwd: projectCwd,
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		// Adjacent, same-cwd process whose LAST argv token is NOT 'sidecar':
		// isSidecarArgv's quick filter must exclude it before lsof is ever
		// consulted, regardless of cwd.
		const otherProc = Bun.spawn([process.execPath, otherScript, 'run'], {
			cwd: projectCwd,
			stdio: ['ignore', 'ignore', 'ignore'],
		});

		try {
			expect(sidecarProc.pid).toBeGreaterThan(0);
			expect(otherProc.pid).toBeGreaterThan(0);

			// Poll performStop (idempotent, no side effect until a real match is
			// found) until the real ps+lsof scan discovers and SIGTERMs the
			// sidecar-shaped process. Bounded poll instead of a fixed sleep: the
			// process needs a moment to register in the OS process table.
			let sawFallbackKill = false;
			await waitForCondition(
				() => {
					const report = performStop({ cwd: projectCwd });
					sawFallbackKill = report.fallbackSidecarKilled;
					return sawFallbackKill;
				},
				{ timeoutMs: 10_000, intervalMs: 200 },
			);
			expect(sawFallbackKill).toBe(true);

			// The real SIGTERM was actually delivered and the process actually died.
			await sidecarProc.exited;
			expect(() => process.kill(sidecarProc.pid, 0)).toThrow();

			// The adjacent non-sidecar process in the SAME cwd was never matched:
			// it is still alive.
			expect(() => process.kill(otherProc.pid, 0)).not.toThrow();
		} finally {
			try {
				otherProc.kill();
			} catch {
				// best-effort cleanup
			}
			try {
				sidecarProc.kill();
			} catch {
				// already dead -- expected on the success path
			}
			rmSync(tempDirRaw, { recursive: true, force: true });
		}
	},
	15_000,
);
