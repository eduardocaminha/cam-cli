// test/integration/orch-recycle-pid-resolve.test.ts
//
// Integration test (REAL processes) for CAM-165 / US-001.
//
// Reproduces the CAM-173 / CAM-165 failure mode chain:
//   - In CAM-173, `pgrep -f <uuid>` was replaced with `pgrep -P <wrapper_pid>`.
//   - In production, claude 2.1.200 rewrites its own process.title at runtime,
//     leaving KERN_PROCARGS2 in a state that makes pgrep SKIP the process in
//     ALL modes (-P, -f, -x, name). Verified empirically ~10x (cam-171-ship
//     journal). `ps` still reports the process normally.
//   - CAM-165 fixes this by switching to `ps -ax -o pid=,ppid=` ppid-walk
//     (kernel proc table, immune to process-title rewriting).
//
// Stand-in design: a bun script that calls `process.title = 'cam-orch-stand-in'`
// simulates the claude 2.1.200 behavior. A plain `sleep` stand-in gives FALSE
// confidence because it does not rewrite its title (CAM-173 lesson).
//
// What this test proves:
//   (a) SOFT: pgrep -P <wrapperPid> may be blind to the title-rewritten child.
//       Environment-dependent (macOS behavior); never gate CI on this.
//   (b) HARD: `ps -ax -o pid=,ppid=` ppid-walk resolves the child by ppid
//       despite the process-title rewrite.
//   (c) HARD: a real SIGTERM terminates the child.
//
// Pattern: real Bun.spawn / spawnSync, skipIf when pgrep or bun is absent,
// mkdtemp cwd, cleanup in afterEach.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ORCH_PID_MARKER } from '../../src/tmux/session.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const pgrepCheck = spawnSync('pgrep', ['--version'], { stdio: 'pipe' });
// pgrep exits non-zero or fails to spawn when absent.
const pgrepAvailable = pgrepCheck.status !== null;

const bunCheck = spawnSync('bun', ['--version'], { stdio: 'pipe' });
const bunAvailable = bunCheck.status === 0;

// `ps` (from procps) is required to reproduce ppid-walk behavior.
// It is absent in oven/bun:1.2-slim (no procps package installed); skip there.
// The production recycle-watcher runs on the host (not inside the container),
// so this is env-specific: the test does not reflect a container toolchain gap.
const psAvailable = Bun.which('ps') !== null;

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
			// Already dead -- fine.
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
 * Parse `ps -ax -o pid=,ppid=` output and return the pids of processes whose
 * ppid equals the given wrapperPid. Mirrors resolveChildViaPs in source.
 */
function findChildrenViaPs(wrapperPid: number): number[] {
	const r = spawnSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' });
	if ((r.status ?? 1) !== 0) return [];
	const matched: number[] = [];
	for (const line of (typeof r.stdout === 'string' ? r.stdout : '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		const ppid = parseInt(parts[1] ?? '', 10);
		if (!Number.isFinite(ppid) || ppid !== wrapperPid) continue;
		const pid = parseInt(parts[0] ?? '', 10);
		if (Number.isFinite(pid) && pid > 0) matched.push(pid);
	}
	return matched;
}

/**
 * Poll via ps ppid-walk until the wrapper has at least one child, up to
 * timeoutMs. Returns the first child pid found or null on timeout.
 * Uses ps (not pgrep) because the child may rewrite its title.
 */
async function waitForChildViaPs(wrapperPid: number, timeoutMs = 5000): Promise<number | null> {
	let found: number | null = null;
	try {
		await waitForCondition(
			() => {
				const first = findChildrenViaPs(wrapperPid)[0];
				if (first === undefined) return false;
				found = first;
				return true;
			},
			{ timeoutMs, intervalMs: 50 },
		);
	} catch {
		return null;
	}
	return found;
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

test.skipIf(!pgrepAvailable || !bunAvailable || !psAvailable)(
	'CAM-165: ps ppid-walk resolves title-rewritten child; pgrep-P blindness documented; SIGTERM terminates',
	async () => {
		// Setup: mkdtemp for .claude dir.
		const cwd = mkdtempSync(join(tmpdir(), 'cam-it-pid-resolve-'));
		const claudeDir = join(cwd, '.claude');
		cleanupDirs.push(cwd);
		mkdirSync(claudeDir, { recursive: true });

		// Write the title-rewriting stand-in script.
		// It sets process.title (simulating claude 2.1.200's behavior) then sleeps.
		// A plain `sleep` stand-in is NOT used: it does not rewrite its title and
		// thus does not reproduce the production failure mode (CAM-165 lesson).
		const standInScript = `// cam-orch-stand-in: simulates claude 2.1.200 process-title rewrite
process.title = 'cam-orch-stand-in';
await Bun.sleep(60000);
`;
		const standInPath = join(cwd, 'stand-in.ts');
		writeFileSync(standInPath, standInScript, 'utf8');

		// Spawn a bash wrapper that forks the bun stand-in as a genuine child.
		// `cmd & wait $!` prevents bash's exec-optimization (bash -c 'cmd'
		// replaces itself with cmd, leaving no separate parent/child for ppid-walk).
		const wrapperProc = Bun.spawn(
			['bash', '-c', `bun '${standInPath}' & wait $!`],
			{ stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
		);
		const wrapperPid = wrapperProc.pid;
		cleanupPids.push(wrapperPid);

		// Write wrapper pid to .cam-orch-pid (mirrors the production path in run.ts).
		const pidFilePath = join(claudeDir, ORCH_PID_MARKER);
		writeFileSync(pidFilePath, String(wrapperPid), 'utf8');

		// Wait for the bun stand-in to appear as a child of the wrapper (via ps).
		const childPid = await waitForChildViaPs(wrapperPid);
		expect(childPid).not.toBeNull();
		const resolvedChild = childPid as number;
		cleanupPids.push(resolvedChild);

		// --- (a) SOFT assertion: pgrep -P blindness (environment-dependent) ---
		// On macOS, claude 2.1.200's process.title rewrite makes pgrep SKIP the
		// process in all modes (verified ~10x empirically, cam-171-ship journal).
		// A title-rewriting bun stand-in MAY or MAY NOT reproduce this depending
		// on the runtime environment (EMPIRICAL CAVEAT in CAM-165 notes).
		// We document the result without gating CI on it.
		const pgrepP = spawnSync('pgrep', ['-P', String(wrapperPid)], {
			encoding: 'utf8',
		});
		const pgrepPOutput = (typeof pgrepP.stdout === 'string' ? pgrepP.stdout : '').trim();
		// Not a hard assertion. If blind (empty): CAM-173 failure mode reproduced.
		// If not blind: pgrep still works in this environment (ps dominates either way).
		void pgrepPOutput; // suppresses unused-var lint; value is intentionally not asserted

		// --- (b) HARD assertion: ps ppid-walk resolves child by ppid ---
		// This is the load-bearing proof: regardless of pgrep behavior, the
		// ps-based ppid-walk must always find the child.
		const psChildren = findChildrenViaPs(wrapperPid);
		expect(psChildren.length).toBeGreaterThan(0);
		expect(psChildren).toContain(resolvedChild);

		// --- (c) HARD assertion: real SIGTERM terminates the child ---
		process.kill(resolvedChild, 'SIGTERM');

		// Wait for the child to exit (up to 2s).
		let childExited = false;
		try {
			await waitForCondition(
				() => {
					try {
						process.kill(resolvedChild, 0); // signal-0: alive check
						return false;
					} catch {
						return true; // ESRCH: process is gone
					}
				},
				{ timeoutMs: 2000, intervalMs: 50 },
			);
			childExited = true;
		} catch {
			// leave childExited false; assertion below reports the timeout
		}
		expect(childExited).toBe(true);
	},
);
