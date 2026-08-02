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
// Updated in US-R2-001 (CAM-482): round 2 review proved live, against this
// exact real production path, that argv shape + cwd alone (US-R1-001's
// absolute-argv[0] anchor) still misclassifies an unrelated process as this
// project's sidecar -- `Bun.spawn(['/usr/bin/tail','-F','sidecar'], {cwd})`
// still yielded `fallbackSidecarKilled: true`. `defaultListProcesses` now
// additionally requires the candidate to hold this project's
// `.claude/cam-supervisor.log` open (the real sidecar always does, via
// `spawnSidecarDefault`'s stdio redirection in src/commands/run.ts) before
// trusting an argv+cwd match. This file now spawns THREE real, concurrent
// processes in the same private temp cwd:
//   1. a genuine-shaped sidecar that ALSO holds the log file open -> MATCHED
//      and SIGTERM'd.
//   2. a sidecar-shaped decoy (same argv shape, same cwd) that does NOT hold
//      the log file open -- the exact false-positive class the round-1
//      CRITICAL reproduced -- must NOT be matched or killed.
//   3. an adjacent process whose argv does not end in the literal 'sidecar'
//      token -- excluded by the cheap quick filter before lsof is ever
//      consulted, regardless of cwd or open files.
//
// Skips cleanly when `ps` or `lsof` is absent (both legitimate-environmental
// in the oven/bun worker-container image, see test/helpers/test-deps.ts).

import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, openSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { performStop } from '../../src/commands/stop.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';
import { psAvailable, lsofAvailable } from '../helpers/test-deps.ts';

// A script body that just idles long enough for `ps`+`lsof` to observe the
// process; all three spawned scripts share this body -- only their trailing
// argv token (and, for the genuine sidecar, their stdio) differ. This is
// SOURCE TEXT written to a spawned child script, not a fixed sleep in this
// test's own async control flow -- check:test-sleeps pattern-matches string
// literals too, so it is cited inline below (CAM-482) to suppress the gate.
const IDLE_SCRIPT_BODY = 'await new Promise((resolve) => setTimeout(resolve, 20000));\n'; // CAM-482: child-script source text, not a fixed sleep

test.skipIf(!psAvailable || !lsofAvailable)(
	'defaultListProcesses: matches a real sidecar process that holds the log open, ' +
		'rejects a sidecar-shaped decoy that does not (US-R2-001 regression), ' +
		'and never matches an adjacent non-sidecar process',
	async () => {
		const tempDirRaw = mkdtempSync(join(tmpdir(), 'cam-stop-real-listprocesses-'));
		// lsof reports the process's REAL (symlink-resolved) cwd -- macOS's
		// /tmp is itself a symlink to /private/tmp, so this test must compare
		// against the realpath, not the raw mkdtemp path, or the cwd-equality
		// check in matchesSidecarForProject spuriously fails.
		const projectCwd = realpathSync(tempDirRaw);

		const claudeDir = join(projectCwd, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		// Mirrors spawnSidecarDefault (src/commands/run.ts): open the log file
		// for append and hand its fd to the child's stdout+stderr.
		const logFd = openSync(join(claudeDir, 'cam-supervisor.log'), 'a');

		const sidecarScript = join(projectCwd, 'sidecar-marker.ts');
		const decoyScript = join(projectCwd, 'decoy-marker.ts');
		const otherScript = join(projectCwd, 'other-marker.ts');
		writeFileSync(sidecarScript, IDLE_SCRIPT_BODY, 'utf8');
		writeFileSync(decoyScript, IDLE_SCRIPT_BODY, 'utf8');
		writeFileSync(otherScript, IDLE_SCRIPT_BODY, 'utf8');

		// Genuine sidecar: interpreted self-spawn shape [runtime, script,
		// 'sidecar'], AND holds .claude/cam-supervisor.log open on fd 1/2.
		const sidecarProc = Bun.spawn([process.execPath, sidecarScript, 'sidecar'], {
			cwd: projectCwd,
			stdio: ['ignore', logFd, logFd],
		});
		// Decoy: identical argv shape and cwd, but does NOT hold the log file
		// open -- reproduces the round-1 CRITICAL's `/usr/bin/tail -F sidecar`
		// case (real process, real ps+lsof, argv+cwd match, no log held open).
		const decoyProc = Bun.spawn([process.execPath, decoyScript, 'sidecar'], {
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
			expect(decoyProc.pid).toBeGreaterThan(0);
			expect(otherProc.pid).toBeGreaterThan(0);

			// Poll performStop (idempotent, no side effect until a real match is
			// found) until the real ps+lsof scan discovers and SIGTERMs the
			// genuine sidecar process. Bounded poll instead of a fixed sleep: the
			// processes need a moment to register in the OS process table.
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

			// The real SIGTERM was actually delivered to the genuine sidecar and
			// it actually died.
			await sidecarProc.exited;
			expect(() => process.kill(sidecarProc.pid, 0)).toThrow();

			// The decoy (same argv shape + cwd, no log held open) was never
			// matched: it is still alive. This is the US-R2-001 regression check.
			expect(() => process.kill(decoyProc.pid, 0)).not.toThrow();

			// The adjacent non-sidecar-argv process in the SAME cwd was never
			// matched either: it is still alive.
			expect(() => process.kill(otherProc.pid, 0)).not.toThrow();
		} finally {
			try {
				otherProc.kill();
			} catch {
				// best-effort cleanup
			}
			try {
				decoyProc.kill();
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
