// test/integration/stop-sidecar-real.test.ts
//
// Integration test (REAL subprocess + REAL tmux): proves two live-system
// behaviors that unit fakes cannot catch:
//
//   1. performStop kills a real subprocess (written to .cam-sidecar.pid in a
//      temp project root) and removes every marker file. Uses the default
//      killFn (real process.kill), not an injected stub.
//
//   2. runSidecarLoop self-exits when the host tmux session disappears for
//      real. Creates a real tmux session on a private socket the way
//      test/integration/tmux-introspect.test.ts does, so the hasSession call
//      is a genuine OS round-trip to the tmux binary, not a fake return value.
//
// Both tests skip cleanly when tmux is not on PATH (matching the convention in
// test/integration/tmux-introspect.test.ts).
//
// Isolation: the tmux tests run on a PRIVATE socket (cam-it-stop), NEVER on
// -L cam (which may host a live cam run session). The socket is torn down in
// afterAll. The subprocess test uses an OS temp dir for the project root.

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { performStop } from '../../src/commands/stop.ts';
import { writeSidecarPid, SIDECAR_PID_FILE } from '../../src/supervisor/sidecar-pid.ts';
import { SUPERVISOR_LOCK_FILE } from '../../src/supervisor/lock.ts';
import { ORCH_READY_MARKER } from '../../src/tmux/bootstrap-wait.ts';
import {
	WORKER_PANE_MARKER,
	ORCH_SESSION_MARKER,
	hasSession,
	type SpawnFn,
} from '../../src/tmux/session.ts';
import { WORKER_REPORT_FILENAME } from '../../src/supervisor/worker-report.ts';
import { runSidecarLoop } from '../../src/supervisor/loop.ts';

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const TEST_SOCK = 'cam-it-stop';
const TEST_SESSION = 'stop-sidecar-test';

/** Detect tmux availability once at module load time. */
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux on the private test socket directly (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/**
 * SpawnFn that rewrites `-L cam` to the private test socket. The session
 * helpers emit `['-L', 'cam', 'has-session', ...]`; swapping the socket name
 * here means each call lands on the private server instead of the live cam one.
 */
const swapSocketSpawn: SpawnFn = (cmd, args, opts) => {
	const swapped = [...args];
	const lIdx = swapped.indexOf('-L');
	if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
	return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? 'pipe' }) as ReturnType<SpawnFn>;
};

afterAll(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

// ---------------------------------------------------------------------------
// Test 1 — performStop kills a real subprocess and removes all marker files
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'performStop: kills real sleeper subprocess via pid file and removes every marker file',
	async () => {
		// 1. Create a temporary project root with the directory layout that
		//    performStop and the marker-writing helpers expect.
		const tempCwd = mkdtempSync(join(tmpdir(), 'cam-stop-real-'));
		const claudeDir = join(tempCwd, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(join(tempCwd, 'scripts', 'cam'), { recursive: true });

		// 2. Spawn a long-running sleeper as a stand-in for the sidecar process.
		//    `sleep 9999` stays alive until sent a signal, which is exactly what
		//    performStop will do via process.kill(pid, 'SIGTERM').
		const sleeper = Bun.spawn(['sleep', '9999'], {
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		const pid = sleeper.pid;
		expect(pid).toBeGreaterThan(0);

		// Confirm the process is alive before we invoke stop.
		expect(() => process.kill(pid, 0)).not.toThrow();

		// 3. Write the sidecar pid to the US-001 marker file.
		writeSidecarPid(claudeDir, pid);
		expect(existsSync(join(claudeDir, SIDECAR_PID_FILE))).toBe(true);

		// 4. Write the full per-session marker set so we can assert all are removed.
		//    This mirrors exactly what cam run + cam next write at lifecycle entry.
		const stateFile = join(claudeDir, 'cam-loop.local.md');
		writeFileSync(stateFile, 'active: false\n', 'utf8');
		writeFileSync(join(claudeDir, SUPERVISOR_LOCK_FILE), '', 'utf8');
		writeFileSync(join(claudeDir, ORCH_SESSION_MARKER), '', 'utf8');
		writeFileSync(join(claudeDir, WORKER_PANE_MARKER), '', 'utf8');
		writeFileSync(join(claudeDir, ORCH_READY_MARKER), '', 'utf8');
		writeFileSync(join(tempCwd, WORKER_REPORT_FILENAME), '{}', 'utf8');

		// 5. Run the real performStop with NO injected killFn — the production
		//    process.kill(pid, 'SIGTERM') path must execute for this test to prove
		//    the live-process kill, not a fake.
		const report = performStop({ cwd: tempCwd });

		// 6. Assert: performStop reports that the sidecar was found alive and killed.
		expect(report.sidecarKilled).toBe(true);

		// 7. Wait for the OS to reap the sleeper process (SIGTERM was already sent
		//    by performStop; exited resolves once the OS confirms the exit).
		await sleeper.exited;

		// 8. Assert: the process is actually dead. process.kill(pid, 0) (signal-0
		//    probe) throws ESRCH when the process no longer exists. This is the same
		//    check sidecarPidAlive() uses, inverted.
		let processActuallyDead = false;
		try {
			process.kill(pid, 0);
		} catch (err) {
			const code =
				err instanceof Error && 'code' in err
					? (err as NodeJS.ErrnoException).code
					: undefined;
			// ESRCH = process does not exist (dead). EPERM = exists but no permission
			// to signal (still alive). Any other error also means dead.
			processActuallyDead = code === 'ESRCH';
		}
		expect(processActuallyDead).toBe(true);

		// 9. Assert: the pid file was removed.
		expect(existsSync(join(claudeDir, SIDECAR_PID_FILE))).toBe(false);

		// 10. Assert: every marker file in the per-session set is absent.
		const markersToCheck = [
			stateFile,
			join(claudeDir, SUPERVISOR_LOCK_FILE),
			join(claudeDir, ORCH_SESSION_MARKER),
			join(claudeDir, WORKER_PANE_MARKER),
			join(claudeDir, ORCH_READY_MARKER),
			join(tempCwd, WORKER_REPORT_FILENAME),
		];
		for (const p of markersToCheck) {
			expect(existsSync(p)).toBe(false);
		}
	},
);

// ---------------------------------------------------------------------------
// Test 2 — runSidecarLoop self-exits when real tmux session disappears
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'runSidecarLoop: stays idle while session is alive then self-exits when session is killed',
	async () => {
		// 1. Create a real tmux session on the private socket. A fresh kill-server
		//    ensures no leftover state from a previous run of this test.
		tmuxRaw(['kill-server']);
		tmuxRaw(['new-session', '-d', '-s', TEST_SESSION, '-x', '80', '-y', '10']);
		Bun.sleepSync(200);

		// 2. Build a hasSessionFn that calls the REAL tmux has-session against the
		//    private socket. The swapSocketSpawn adapter rewrites `-L cam` to the
		//    private socket so the helper never touches a live cam session.
		//
		//    State machine:
		//      - While the session is alive, hasSession returns true and seenAliveCount
		//        increments. This latches sessionSeen inside runSidecarLoop.
		//      - After SESSION_SEEN_THRESHOLD positive results, we kill the session.
		//      - The very next call to hasSession returns false (session is gone)
		//        and, because sessionSeen is latched, runSidecarLoop returns.
		const SESSION_SEEN_THRESHOLD = 3;
		let seenAliveCount = 0;
		let sessionKilled = false;

		const hasSessionFn = (): boolean => {
			const alive = hasSession(TEST_SESSION, swapSocketSpawn);
			if (alive) {
				seenAliveCount++;
				if (seenAliveCount >= SESSION_SEEN_THRESHOLD && !sessionKilled) {
					sessionKilled = true;
					tmuxRaw(['kill-session', '-t', TEST_SESSION]);
				}
			}
			return alive;
		};

		// 3. Run runSidecarLoop with:
		//    - no-op sleep: the loop polls hasSessionFn at CPU speed (no wall-clock
		//      delays). This keeps the test fast while still driving real tmux calls.
		//    - readActive always returns undefined: the loop stays idle (never calls
		//      buildOpts or acquires the lock). This is the "stays idle" assertion.
		//    - acquireLock always returns acquired:false: belt-and-suspenders guard
		//      so the supervisor is never accidentally started.
		//    - buildOpts throws: proves the loop never attempted to run a supervisor.
		const startMs = Date.now();

		await runSidecarLoop({
			buildOpts: () => {
				throw new Error('buildOpts must not be called: loop should stay idle throughout');
			},
			readActive: () => undefined,
			clearActive: () => {},
			sleep: () => {},
			idlePollMs: 0,
			acquireLock: () => ({ acquired: false as const, holderPid: 0 }),
			hasSessionFn,
		});

		const elapsedMs = Date.now() - startMs;

		// 4. Assert: the session was seen alive at least SESSION_SEEN_THRESHOLD times
		//    before the loop exited. This proves the sessionSeen latch was set
		//    (startup grace was satisfied) before the self-exit fired.
		expect(seenAliveCount).toBeGreaterThanOrEqual(SESSION_SEEN_THRESHOLD);

		// 5. Assert: the loop exited within a reasonable bound. With a no-op sleep
		//    and a small number of real tmux calls, this should take < 500ms.
		//    The 5_000ms guard exists only to catch a pathological hang (the Bun
		//    per-test timeout is the ultimate backstop).
		expect(elapsedMs).toBeLessThan(5000);

		// 6. Assert: the tmux session is actually gone (sanity-check via real tmux).
		const sessionStillAlive = hasSession(TEST_SESSION, swapSocketSpawn);
		expect(sessionStillAlive).toBe(false);
	},
	10_000,
);
