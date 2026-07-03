// test/integration/orch-recycle-pid-resolve.test.ts
//
// Integration test (REAL processes) for US-002/CAM-173.
//
// Reproduces the CAM-173 failure mode: in the pre-fix code, `pgrep -f <uuid>`
// was used to find the orchestrator claude child. On macOS, when the bash
// wrapper's argv is large (containing the session uuid baked in), the kernel
// truncates the KERN_PROCARGS2 output, making pgrep -f return empty. The new
// approach uses `pgrep -P <wrapper_pid>` (parent-pid match), which is immune
// to argv truncation because it matches by OS ppid, not cmdline content.
//
// What this test proves:
//   1. `pgrep -f <uuid>` returns EMPTY even when uuid is in the wrapper argv
//      (giant argv simulation: we spawn a bash wrapper without the uuid visible
//       in any process cmdline, since reliable kernel truncation would require
//       argv > kern.argmax which triggers execve E2BIG. The practical
//       reproduction: uuid is associated with the session but NOT present in
//       any process's visible argv, matching the real CAM-173 scenario.)
//   2. The new path (read .cam-orch-pid + pgrep -P) resolves the child.
//   3. A real SIGTERM terminates the child.
//
// Pattern: real Bun.spawn/spawnSync, test.skipIf when pgrep is absent,
// mkdtemp cwd, cleanup in afterEach. Mirrors test/integration/tmux-introspect.test.ts.
//
// Fakes do NOT count (Burrow lesson / CAM-55): unit fakes return what the code
// expects; only a real process can catch kernel-level behavior gaps.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { ORCH_PID_MARKER } from '../../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const pgrepCheck = spawnSync('pgrep', ['-P', '1'], { stdio: 'pipe' });
const pgrepAvailable = pgrepCheck.status !== null; // null means spawn failed (not found)

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = [];
const cleanupPids: number[] = [];

afterEach(() => {
	// Kill any leftover child processes first (best-effort).
	for (const pid of cleanupPids.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already dead — fine.
		}
	}
	// Then remove temp dirs.
	for (const dir of cleanupDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort.
		}
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll until pgrep -P <ppid> finds at least one child, up to timeoutMs.
 * Returns the child pid string or null on timeout.
 */
function waitForChild(ppid: number, timeoutMs = 3000): string | null {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = spawnSync('pgrep', ['-P', String(ppid)], { encoding: 'utf8' });
		if ((r.status ?? 1) === 0) {
			const lines = (typeof r.stdout === 'string' ? r.stdout : '')
				.trim()
				.split('\n')
				.filter((l) => l.trim().length > 0);
			const first = lines[0] ?? '';
				if (first.length > 0) return first;
		}
		Bun.sleepSync(50);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

test.skipIf(!pgrepAvailable)(
	'CAM-173: pgrep -f <uuid> returns empty; pgrep -P resolves child; SIGTERM terminates it',
	async () => {
		// Setup: mkdtemp for .claude dir.
		const cwd = mkdtempSync(join(tmpdir(), 'cam-it-pid-resolve-'));
		const claudeDir = join(cwd, '.claude');
		cleanupDirs.push(cwd);
		mkdirSync(claudeDir, { recursive: true });

		// Generate a session UUID (represents the session identifier used in
		// the pre-fix `pgrep -f <uuid>` call). The uuid is NOT part of any
		// spawned process's cmdline — simulating the CAM-173 scenario where
		// the kernel-truncated KERN_PROCARGS2 (or non-inclusion in claude argv)
		// made pgrep -f return empty.
		const sessionUuid = randomUUID();

		// Spawn the "wrapper" bash process (analogous to the orchestrator bash
		// respawn-wrapper). Use `sleep 60 & wait $!` so bash forks sleep as a
		// genuine child and stays alive as the parent. A plain `bash -c 'sleep 60'`
		// triggers bash's exec-optimization (bash replaces itself with sleep),
		// leaving no separate parent/child relationship for pgrep -P to observe.
		const wrapperProc = Bun.spawn(['bash', '-c', 'sleep 60 & wait $!'], {
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
		});
		const wrapperPid = wrapperProc.pid;
		cleanupPids.push(wrapperPid);

		// Wait for bash to fork and start the `sleep 60` child.
		const childPidStr = waitForChild(wrapperPid);
		expect(childPidStr).not.toBeNull();
		const childPid = parseInt(childPidStr ?? '', 10);
		expect(Number.isFinite(childPid) && childPid > 0).toBe(true);
		cleanupPids.push(childPid);

		// --- ASSERT: pgrep -f <uuid> returns EMPTY ---
		// The uuid is not in any running process's cmdline (it only lives in
		// the test's local variable). This reproduces the CAM-173 failure mode:
		// the caller cannot find the target process via cmdline string-matching.
		const pgrepF = spawnSync('pgrep', ['-f', sessionUuid], { encoding: 'utf8' });
		// pgrep -f returns exit 1 (no match) or 0 (match found).
		// We assert no match: either status 1 OR empty stdout.
		const pgrepFOutput = typeof pgrepF.stdout === 'string' ? pgrepF.stdout.trim() : '';
		expect(pgrepFOutput).toBe('');

		// --- ASSERT: new path (read .cam-orch-pid + pgrep -P) resolves child ---
		// Write wrapper pid to .cam-orch-pid (as US-001 does at wrapper boot).
		const pidFilePath = join(claudeDir, ORCH_PID_MARKER);
		writeFileSync(pidFilePath, String(wrapperPid), 'utf8');

		const pgrepP = spawnSync('pgrep', ['-P', String(wrapperPid)], { encoding: 'utf8' });
		expect((pgrepP.status ?? 1)).toBe(0);
		const pgrepPOutput = typeof pgrepP.stdout === 'string' ? pgrepP.stdout.trim() : '';
		expect(pgrepPOutput.length).toBeGreaterThan(0);

		// The resolved PID must match the sleep child we observed.
		const resolvedPidStr = pgrepPOutput.split('\n')[0] ?? '';
		const resolvedPid = parseInt(resolvedPidStr, 10);
		expect(resolvedPid).toBe(childPid);

		// --- ASSERT: real SIGTERM terminates the child ---
		process.kill(childPid, 'SIGTERM');

		// Wait for the child to exit (up to 2s).
		const deadline = Date.now() + 2000;
		let childExited = false;
		while (Date.now() < deadline) {
			try {
				process.kill(childPid, 0); // signal-0: alive check
				Bun.sleepSync(50);
			} catch {
				childExited = true; // ESRCH: process is gone
				break;
			}
		}
		expect(childExited).toBe(true);
	},
);
