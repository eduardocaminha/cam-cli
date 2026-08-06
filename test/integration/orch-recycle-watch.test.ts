// test/integration/orch-recycle-watch.test.ts
//
// Integration test (REAL tmux + REAL bash wrapper): proves the orchestrator
// recycle mechanism end-to-end.
//
// Mechanism under test:
//   cam run spawns cam orch-recycle-watch alongside the sidecar. The watcher
//   polls for ORCH_RECYCLE_MARKER. When present, it resolves the orchestrator
//   claude PID via a ps ppid-walk, sends SIGTERM, and removes the marker
//   (consume-once). The bash respawn-wrapper (buildOrchestratorPaneCommand)
//   detects the SIGTERM'd claude exit, finds the handoff file written by the
//   exiting process, and respawns a fresh claude with a new session UUID.
//
// What this test does:
//   1. Creates a tmpdir as a fake project cwd.
//   2. Spawns the real recycle watcher (bun index.ts orch-recycle-watch) as a
//      subprocess against that tmpdir, BEFORE any tmux session or wrapper
//      exists, capturing its stdout/stderr to files under the tmpdir.
//   3. WATCHER_READY_PROBE: arms the real ORCH_RECYCLE_MARKER as a probe and
//      waits for it to be unlinked. With no wrapper/pid-file yet, the
//      watcher's own consume-once tick resolves no pid and still removes the
//      marker -- an effect only THIS watcher, polling THIS tmpdir, can
//      produce. This proves liveness without gating on any process-name
//      match, and keeps the watcher's cold start off the recycle critical
//      path below.
//   4. Creates a fake `claude` shell script (fake-bin/claude) that:
//        - Traps SIGTERM: writes a minimal handoff JSON and exits 143.
//        - Otherwise: sleeps in a signal-interruptible wait loop.
//   5. Runs the real bash wrapper (buildOrchestratorPaneCommand) in a real
//      tmux session (private socket) with fake-claude on the PATH.
//   6. Arms the recycle marker for real.
//   7. Asserts: ORCH_SESSION_MARKER changes to a new UUID (respawn happened).
//   8. Asserts: a process matching the new UUID is running (fresh claude).
//
// Any wait tied to the watcher's own liveness reports the watcher's
// exitCode (null while alive) plus its captured stdout/stderr on timeout,
// so a dead or never-booted watcher is diagnosable instead of collapsing
// into a bare timeout message.
//
// Skips gracefully when tmux, pgrep, or uuidgen is unavailable.
//
// Isolation: uses a private tmux socket (cam-it-recycle); never touches the
// live `cam` socket used by a real cam run session.
//
// macOS binary signing: uses `bun index.ts`, NOT the compiled cam binary.
//
// WAIT BUDGETS (US-002, CAM-446): every wait below is measured under full suite
// (a real `bun test` over the WHOLE suite, never this file run in isolation,
// since isolation is an environment where the process-table pressure that
// caused the original defect does not exist) with CAM_WAIT_TIMINGS set,
// recording the REAL elapsed time at the moment each predicate flips true
// (never the timeout value). Measured 2026-08-05, three
// consecutive full-suite (`bun test`, all 6017 tests, 360 files) green runs,
// this file's own worst observed predicate-flip elapsedMs across those three:
//   WATCHER_READY_PROBE:    203ms (budget 10_000ms, ~49x margin)
//   has-session:              4ms (budget  5_000ms, ~1250x margin)
//   pgrep-initialUUID:       16ms (budget  5_000ms, ~312x margin)
//   session-marker-change: 2517ms (budget 12_000ms, ~4.8x margin)
//   pgrep-newUUID:          237ms (budget 10_000ms, ~42x margin)
// The session-marker-change wait is the only one with real tail latency (it
// waits on the fake-claude SIGTERM trap + bash wrapper's handoff-detect +
// respawn cycle), so its margin is deliberately kept tighter-but-still-honest
// (~4.8x, not padded to match the others) rather than uniform; every other
// wait is dominated by pure OS/tmux/pgrep call overhead and gets a wide
// margin cheaply. None of these budgets are derived from the old
// right-censored 12209/12151/12183/12188 ms timeout failures (those only
// proved "at least 12s", never a real worst case, because they were captured
// AT the timeout that was firing, not at the moment the predicate flipped).
// Re-measure (CAM_WAIT_TIMINGS=<path> bun test, full suite) before trusting
// these numbers again if the suite's wall-clock profile changes materially
// (see the $TMPDIR regression note in CAM-503).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, chmodSync, appendFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join, resolve } from 'node:path';

import {
	buildOrchestratorPaneCommand,
	type SpawnWatcherFn,
} from '../../src/commands/run.ts';
import { ORCH_RECYCLE_MARKER, ORCH_SESSION_MARKER } from '../../src/tmux/session.ts';
import { waitForCondition, type WaitForConditionOptions } from '../helpers/wait-for-condition.ts';
import { tmuxAvailable, pgrepAvailable, uuidgenAvailable } from '../helpers/test-deps.ts';

// ---------------------------------------------------------------------------
// Availability checks
// ---------------------------------------------------------------------------

const shouldRun = tmuxAvailable && pgrepAvailable && uuidgenAvailable;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_SOCK = 'cam-it-recycle';
const SESSION = 'recycle-test';

// Absolute path to index.ts: test/integration/ -> test/ -> repo root.
const REPO_ROOT = resolve(import.meta.dir, '../..');
const INDEX_TS = join(REPO_ROOT, 'index.ts');

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let tmpCwd: string;
let watcherProc: ReturnType<typeof Bun.spawn> | undefined;
let watcherStdoutPath: string;
let watcherStderrPath: string;

function readCapturedSafely(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '(no output captured)';
	}
}

// ---------------------------------------------------------------------------
// Wait instrumentation (US-002, CAM-446)
// ---------------------------------------------------------------------------
//
// CAM_WAIT_TIMINGS, when set, names a JSONL artifact path this file appends
// one record to per wait, capturing the REAL elapsed time observed at the
// moment the wait's predicate flips true (never the configured timeoutMs
// budget). This is what let the header note above be filled in from genuine
// full-suite measurements instead of guessed from timeout failures.
const WAIT_TIMINGS_PATH = process.env.CAM_WAIT_TIMINGS;

/** Every wait in this file must declare its own poll interval (the shared
 * helper's 20ms default spawns a real subprocess per tick for every
 * pgrep/tmux-backed predicate here, adding exactly the process-table
 * pressure CAM-446 removed); `intervalMs` is required, not optional. */
type MeasuredWaitOptions = WaitForConditionOptions & { intervalMs: number };

/**
 * The sole call site of the shared `waitForCondition` helper in this file:
 * every wait below funnels through here, so every wait is both instrumented
 * and structurally forced (via `MeasuredWaitOptions`) to declare its own
 * `intervalMs`.
 */
async function waitForConditionMeasured(
	predicate: () => boolean | Promise<boolean>,
	opts: MeasuredWaitOptions,
	label: string,
): Promise<void> {
	const start = Date.now();
	let flippedAt: number | undefined;
	await waitForCondition(async () => {
		const result = await predicate();
		if (result && flippedAt === undefined) flippedAt = Date.now();
		return result;
	}, opts);
	if (WAIT_TIMINGS_PATH) {
		const elapsedMs = (flippedAt ?? Date.now()) - start;
		appendFileSync(
			WAIT_TIMINGS_PATH,
			`${JSON.stringify({
				label,
				elapsedMs,
				timeoutMs: opts.timeoutMs ?? 5000,
				intervalMs: opts.intervalMs,
				at: new Date().toISOString(),
			})}\n`,
			'utf8',
		);
	}
}

/**
 * Wraps waitForConditionMeasured so a timeout on a wait tied to the watcher's
 * own liveness never collapses into a bare "predicate still false" message.
 * On failure, reports the watcher's exitCode (null while alive, per the
 * Bun docs `subprocess.exitCode` entry) plus its captured stdout/stderr,
 * so a dead or never-booted watcher subprocess is diagnosable.
 */
async function waitForWatcher(
	predicate: () => boolean | Promise<boolean>,
	opts: MeasuredWaitOptions,
	label: string,
): Promise<void> {
	try {
		await waitForConditionMeasured(predicate, opts, label);
	} catch (err) {
		const exitCode = watcherProc?.exitCode ?? null;
		throw new Error(
			[
				`${label}: ${err instanceof Error ? err.message : String(err)}`,
				`watcher exitCode=${exitCode} (null means the watcher is still alive)`,
				`watcher stdout:\n${readCapturedSafely(watcherStdoutPath)}`,
				`watcher stderr:\n${readCapturedSafely(watcherStderrPath)}`,
			].join('\n'),
		);
	}
}

beforeEach(() => {
	if (!shouldRun) return;
	// Kill any leftover server from a previous run.
	tmuxRaw(['kill-server']);
	tmpCwd = createTestTmpdir('cam-recycle-');
});

afterEach(() => {
	if (!shouldRun) return;
	// Kill the watcher subprocess if it is still running.
	try { watcherProc?.kill(); } catch { /* best-effort */ }
	watcherProc = undefined;
	// Tear down the tmux server (kills all panes, including the wrapper + fake-claude).
	tmuxRaw(['kill-server']);
	// Remove the temp project dir.
	try { rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Integration test: SIGTERM + respawn end-to-end
// ---------------------------------------------------------------------------

test.skipIf(!shouldRun)(
	'recycle watcher e2e: arming marker SIGTERMs fake-claude; bash wrapper respawns with new UUID',
	async () => {
		const claudeDir = join(tmpCwd, '.claude');
		mkdirSync(claudeDir, { recursive: true });

		const handoffPath = join(claudeDir, '.cam-orch-handoff.json');
		const sessionIdPath = join(claudeDir, ORCH_SESSION_MARKER);
		const recyclePath = join(claudeDir, ORCH_RECYCLE_MARKER);

		// 1. Spawn the real recycle watcher subprocess FIRST, against tmpCwd,
		//    before any tmux session or wrapper exists. Its stdout/stderr are
		//    captured to files under tmpCwd so a boot failure leaves evidence
		//    instead of vanishing.
		watcherStdoutPath = join(tmpCwd, 'watcher.stdout.log');
		watcherStderrPath = join(tmpCwd, 'watcher.stderr.log');
		watcherProc = Bun.spawn(['bun', INDEX_TS, 'orch-recycle-watch'], {
			cwd: tmpCwd,
			stdout: Bun.file(watcherStdoutPath),
			stderr: Bun.file(watcherStderrPath),
		});

		// 2. WATCHER_READY_PROBE: arm the real recycle marker as a probe. With
		//    no wrapper/pid-file yet, the watcher's resolvePidFn resolves no
		//    pid, but its consume-once tick (handleOneTick) still unlinks the
		//    marker and emits its structured unresolved-pid event. That
		//    unlink is an effect only THIS watcher, polling THIS tmpdir's
		//    .claude, can produce -- proof of liveness without gating on any
		//    machine-wide process-name match. Runs before the wrapper exists,
		//    so the watcher's cold start (bun transpiling+importing index.ts)
		//    sits off the recycle critical path below.
		writeFileSync(recyclePath, '', 'utf8');
		await waitForWatcher(
			() => !existsSync(recyclePath),
			{ timeoutMs: 10_000, intervalMs: 200 },
			'WATCHER_READY_PROBE',
		);

		// 3. Create fake-bin/claude: a bash script that traps SIGTERM, writes
		//    the handoff file, and exits 143 so the bash wrapper can respawn.
		const fakeBinDir = join(tmpCwd, 'fake-bin');
		mkdirSync(fakeBinDir, { recursive: true });
		const fakeClaudeScript = join(fakeBinDir, 'claude');
		writeFileSync(
			fakeClaudeScript,
			[
				'#!/bin/bash',
				'cleanup() {',
				'  if [ -n "$CAM_TEST_HANDOFF_PATH" ]; then',
				"    printf '{\"reason\":\"recycle\"}' > \"$CAM_TEST_HANDOFF_PATH\"",
				'  fi',
				'  exit 143',
				'}',
				'trap cleanup SIGTERM',
				'# Signal-interruptible wait: sleep in background, wait interrupts on SIGTERM.',
				'while :; do',
				'  sleep 86400 &',
				'  wait $!',
				'done',
			].join('\n'),
		);
		chmodSync(fakeClaudeScript, 0o755);

		// 4. Write the initial session UUID to ORCH_SESSION_MARKER.
		//    Must be a string unique enough that pgrep -f won't match unrelated processes.
		const initialUUID = `cam-recycle-test-${Date.now()}`;
		writeFileSync(sessionIdPath, initialUUID, 'utf8');

		// 5. Write a minimal boot prompt file (content doesn't matter for the test).
		const promptFile = join(claudeDir, '.cam-orchestrator-prompt.txt');
		writeFileSync(promptFile, 'test prompt', 'utf8');

		// 6. Build the real bash wrapper command. Uses fake-claude from fakeBinDir via
		//    PATH manipulation prepended to the wrapper string.
		const stateFile = join(claudeDir, 'cam-loop.local.md');
		const readyMarker = join(claudeDir, '.cam-orch-ready');
		const pidMarker = join(claudeDir, '.cam-orch-pid');
		const agentCmd = buildOrchestratorPaneCommand({
			sessionName: SESSION,
			sessionId: initialUUID,
			promptFile,
			sessionIdMarker: sessionIdPath,
			handoffMarker: handoffPath,
			stateFile,
			readyMarker,
			pidMarker,
			maxRespawns: 3,
		});

		// Prepend PATH (so `claude` resolves to our fake) and the env var that
		// tells the fake where to write the handoff file.
		//
		// Single-quote-escape the paths to be safe with spaces in $TMPDIR.
		const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
		const fullCmd = [
			`export PATH=${q(fakeBinDir)}:$PATH`,
			`export CAM_TEST_HANDOFF_PATH=${q(handoffPath)}`,
			agentCmd,
		].join('; ');

		// 7. Create a tmux session and run the bash wrapper in it.
		tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50']);
		await waitForConditionMeasured(
			() => tmuxRaw(['has-session', '-t', SESSION]).status === 0,
			{ timeoutMs: 5_000, intervalMs: 50 },
			'has-session',
		);

		const paneListOut = tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
			.stdout.toString()
			.trim();
		const orchPaneId = paneListOut.split('\n')[0] ?? SESSION;

		tmuxRaw(['respawn-pane', '-k', '-t', orchPaneId, 'bash', '-c', fullCmd]);

		// 8. Wait for fake-claude to appear in pgrep results.
		await waitForConditionMeasured(
			() => spawnSync('pgrep', ['-f', initialUUID], { stdio: 'pipe', encoding: 'utf8' }).status === 0,
			{ timeoutMs: 5_000, intervalMs: 200 },
			'pgrep-initialUUID',
		);
		const fakeclaudeRunning = spawnSync('pgrep', ['-f', initialUUID], {
			stdio: 'pipe',
			encoding: 'utf8',
		}).status === 0;
		expect(fakeclaudeRunning).toBe(true);

		// 9. Arm the recycle marker for real.
		writeFileSync(recyclePath, '', 'utf8');

		// 10. Wait for ORCH_SESSION_MARKER to change (proves the bash wrapper
		//     respawned with a new UUID after the SIGTERM-and-handoff cycle).
		let newUUID = initialUUID;
		await waitForWatcher(
			() => {
				try {
					const content = readFileSync(sessionIdPath, 'utf8').trim();
					if (content.length > 0 && content !== initialUUID) {
						newUUID = content;
						return true;
					}
				} catch {
					// file may be absent momentarily during mv
				}
				return false;
			},
			{ timeoutMs: 12_000, intervalMs: 500 },
			'session-marker-change',
		);

		// 11. Core assertions.

		// The session UUID must have changed: this proves the bash wrapper respawned.
		expect(newUUID).not.toBe(initialUUID);

		// A process matching the NEW UUID must be running (fresh fake-claude is alive).
		await waitForConditionMeasured(
			() => spawnSync('pgrep', ['-f', newUUID], { stdio: 'pipe', encoding: 'utf8' }).status === 0,
			{ timeoutMs: 10_000, intervalMs: 200 },
			'pgrep-newUUID',
		);
		const pgrepNew = spawnSync('pgrep', ['-f', newUUID], {
			stdio: 'pipe',
			encoding: 'utf8',
		});
		expect(pgrepNew.status).toBe(0);
	},
	// Generous outer per-test timeout: sum of the worst-case internal poll
	// budgets across all five waits (see the WAIT BUDGETS header note above
	// for the measured elapsedMs each is derived from): WATCHER_READY_PROBE
	// (10s) + has-session (5s) + pgrep-initialUUID (5s) + session-marker-change
	// (12s) + pgrep-newUUID (10s) = 42s, plus process-spawn/tmux overhead.
	{ timeout: 45_000 },
);

// ---------------------------------------------------------------------------
// Unit-level oracle: spawnWatcherFn type is exported and usable
// ---------------------------------------------------------------------------

test('SpawnWatcherFn type is exported from run.ts', () => {
	// Structural check: a no-op watcher satisfies the SpawnWatcherFn shape.
	const noopWatcher: SpawnWatcherFn = (_cwd: string, _logPath: string) => ({
		pid: 0,
		kill: () => {},
	});
	// If this compiles, the export is correct.
	expect(typeof noopWatcher).toBe('function');
});
