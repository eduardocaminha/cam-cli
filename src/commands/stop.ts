// src/commands/stop.ts
//
// Implementation of `cam stop` — cleanly cancels a running loop.
//
// What it does, in order:
//   1. Removes `.claude/cam-loop.local.md` (the plugin's state file). After
//      this, the next `cam next` invocation does NOT detect a stale loop.
//   2. If the project's tmux session (derived from cwd via projectSessionName)
//      is alive, kills it. We only kill the project-specific session — nothing
//      else — so unrelated sessions are untouched.
//   3. Exits 0. Both steps are idempotent: missing state file + missing tmux
//      session both report `nothing to clean` and still exit 0. `cam stop`
//      is the kill-switch operators reach for, so it never fails on "the
//      loop wasn't running" — that's the success state.
//
// Acceptance criteria (US-005, rewire):
//   - `cam stop` targets the project session (projectSessionName(cwd)) rather
//     than the legacy hardcoded `cam` session name.
//   - After `cam stop`, the next `cam next` invocation does NOT detect a
//     stale loop.
//
// Tmux detection contract: `tmux has-session -t <sessionName> 2>/dev/null`
// — exit 0 means the session exists. We only call `tmux kill-session -t
// <sessionName>` when has-session succeeded. The `tmux` binary may not be
// installed at all (e.g. on a fresh dev box) — also "nothing to clean".

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import {
	readSidecarPid,
	removeSidecarPid,
	sidecarPidAlive,
	readWatcherPid,
	removeWatcherPid,
	readSidecarLivenessWatcherPid,
	removeSidecarLivenessWatcherPid,
} from '../supervisor/sidecar-pid.ts';
import { SUPERVISOR_LOCK_FILE } from '../supervisor/lock.ts';
import { WORKER_REPORT_FILENAME } from '../supervisor/worker-report.ts';
import { DRAIN_STOP_MARKER } from '../supervisor/drain-kill-switch.ts';
import { PAUSE_MARKER } from '../supervisor/pause-marker.ts';
import { ORCH_READY_MARKER } from '../tmux/bootstrap-wait.ts';
import { DEFAULT_CONTAINER_NAME } from '../supervisor/worker-container.ts';
import { readWorkerIsolation, type WorkerIsolation } from '../config/models.ts';

import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';
import { parseStateFile } from './status.ts';
import {
	projectSessionName,
	readWorkerPaneMarker,
	tmuxArgs,
	WORKER_PANE_MARKER,
	ORCH_SESSION_MARKER,
	ORCH_RECYCLE_MARKER,
	ORCH_PID_MARKER,
} from '../tmux/session.ts';

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = '.claude/cam-loop.local.md';

// --- Types -----------------------------------------------------------------

/** Minimal subset of `spawnSync` we use; injectable for tests. */
export type SpawnSyncFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8' },
) => SpawnSyncReturns<string>;

/**
 * A snapshot of a running process: its pid, full argv array, and current
 * working directory. Used by the fallback scoped-scan in `performStop`.
 */
export type ProcessRecord = {
	pid: number;
	argv: string[];
	cwd: string;
};

/**
 * Injectable dep that returns a list of running processes. The production
 * default shells out to `ps`+`lsof`; unit tests inject a static list.
 */
export type ListProcessesFn = () => ProcessRecord[];

/**
 * Minimal kill-signal function; injectable so tests never signal real PIDs.
 * `process.kill(pid, 'SIGTERM')` is the canonical graceful-terminate signal.
 */
export type KillFn = (pid: number, signal: 'SIGTERM') => void;

export interface StopOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Override `existsSync` for tests. */
	existsSyncFn?: (path: string) => boolean;
	/** Override `unlinkSync` for tests (also lets tests record the call). */
	unlinkSyncFn?: (path: string) => void;
	/** Override `spawnSync` for tests (used to fake tmux). */
	spawnSyncFn?: SpawnSyncFn;
	/**
	 * Override `process.kill` for tests (used to fake PID signals).
	 * When undefined, defaults to `process.kill`.
	 */
	killFn?: KillFn;
	/**
	 * Override the worker-pane-id reader for tests.
	 * When undefined, defaults to `readWorkerPaneMarker`.
	 */
	workerPaneReader?: (claudeDir: string) => string | null;
	/**
	 * Override the sidecar pid reader for tests.
	 * When undefined, defaults to `readSidecarPid` from sidecar-pid.ts.
	 */
	sidecarPidReader?: (claudeDir: string) => number | null;
	/**
	 * Override the signal-0 liveness probe for tests (real process.kill(pid, 0)
	 * cannot be called against fake pids in unit tests).
	 * When undefined, defaults to `sidecarPidAlive` from sidecar-pid.ts.
	 */
	sidecarPidAliveFn?: (pid: number) => boolean;
	/**
	 * Override the sidecar pid-file remover for tests.
	 * When undefined, defaults to `removeSidecarPid` from sidecar-pid.ts.
	 */
	sidecarPidRemover?: (claudeDir: string) => void;
	/**
	 * Override the process-listing function for tests.
	 * The production default shells out to `ps`+`lsof` to discover cam sidecar
	 * processes; unit tests inject a static list. Only called when the pid-file
	 * path did NOT find a live sidecar (absent file or dead pid).
	 */
	listProcessesFn?: ListProcessesFn;
	/**
	 * Override the recycle watcher pid reader for tests.
	 * When undefined, defaults to `readWatcherPid` from sidecar-pid.ts.
	 */
	watcherPidReader?: (claudeDir: string) => number | null;
	/**
	 * Override the signal-0 liveness probe for the watcher pid.
	 * When undefined, defaults to `sidecarPidAlive` (same probe, generic).
	 */
	watcherPidAliveFn?: (pid: number) => boolean;
	/**
	 * Override the watcher pid-file remover for tests.
	 * When undefined, defaults to `removeWatcherPid` from sidecar-pid.ts.
	 */
	watcherPidRemover?: (claudeDir: string) => void;
	/**
	 * Override the sidecar-liveness watcher pid reader for tests.
	 * When undefined, defaults to `readSidecarLivenessWatcherPid` from sidecar-pid.ts.
	 */
	sidecarLivenessWatcherPidReader?: (claudeDir: string) => number | null;
	/**
	 * Override the signal-0 liveness probe for the sidecar-liveness watcher pid.
	 * When undefined, defaults to `sidecarPidAlive` (same probe, generic).
	 */
	sidecarLivenessWatcherPidAliveFn?: (pid: number) => boolean;
	/**
	 * Override the sidecar-liveness watcher pid-file remover for tests.
	 * When undefined, defaults to `removeSidecarLivenessWatcherPid` from sidecar-pid.ts.
	 */
	sidecarLivenessWatcherPidRemover?: (claudeDir: string) => void;
	/**
	 * Override the worker-isolation reader for tests (US-004, CAM-207).
	 * When undefined, defaults to `readWorkerIsolation` from `../config/models.ts`,
	 * pointed at `<cwd>/scripts/cam/project.toml`.
	 */
	workerIsolationReader?: (configPath: string) => WorkerIsolation;
	/**
	 * Override the cam-worker container name for tests (US-004, CAM-207).
	 * When undefined, defaults to `DEFAULT_CONTAINER_NAME` ('cam-worker').
	 */
	containerName?: string;
}

export interface StopReport {
	/** Was the state file present + removed by this call? */
	stateFileRemoved: boolean;
	/** Was the project's tmux session present + killed by this call? */
	tmuxKilled: boolean;
	/** Was the `tmux` binary unavailable on PATH? (Distinguishes "not installed" from "no session".) */
	tmuxUnavailable: boolean;
	/** The project session name that was targeted (for diagnostic output). */
	sessionName: string;
	/**
	 * Was the supervisor PID (from the state file) sent SIGTERM?
	 * False when the state file had no pid field, the PID was already dead,
	 * or the kill call threw.
	 */
	supervisorKilled: boolean;
	/**
	 * Was the worker slot pane sent a `respawn-pane -k 'echo stopped'` kill?
	 * False when .cam-worker-pane was absent, tmux was unavailable, or the
	 * command failed.
	 */
	workerPaneKilled: boolean;
	/**
	 * Was the sidecar process (from .claude/.cam-sidecar.pid) sent SIGTERM?
	 * False when the pid file is absent, the pid is dead (signal-0 fails),
	 * or the kill call threw. The pid file is always removed when present,
	 * regardless of liveness.
	 */
	sidecarKilled: boolean;
	/**
	 * Relative paths (from cwd) of every marker file actually unlinked by this
	 * call. Empty when no markers were present. Populated by step 2 (state file)
	 * and step 2b (per-session marker set). Useful for diagnostic output so the
	 * operator knows exactly which files were cleaned without re-reading source.
	 */
	markersRemoved: string[];
	/**
	 * Were any orphaned sidecar processes found via the fallback scoped scan and
	 * sent SIGTERM? True when the pid-file path found nothing alive AND the
	 * scoped process scan matched at least one `cam sidecar` process whose cwd
	 * equals this project's cwd.
	 */
	fallbackSidecarKilled: boolean;
	/**
	 * Was the recycle watcher process (from .claude/.cam-watcher.pid) sent SIGTERM?
	 * False when the pid file is absent, the pid is dead (signal-0 fails),
	 * or the kill call threw. The pid file is always removed when present,
	 * regardless of liveness.
	 */
	watcherKilled: boolean;
	/**
	 * Was the sidecar-liveness watcher process (from
	 * .claude/.cam-sidecar-liveness-watcher.pid) sent SIGTERM?
	 * False when the pid file is absent, the pid is dead (signal-0 fails),
	 * or the kill call threw. The pid file is always removed when present,
	 * regardless of liveness.
	 */
	sidecarLivenessWatcherKilled: boolean;
	/**
	 * Was the cam-worker container torn down via `docker rm -f` (US-004,
	 * CAM-207)? Always `false` in host mode (`worker_isolation != 'container'`),
	 * which is a no-op by design — this repo runs host mode. In container
	 * mode, `false` also covers "container was already absent" (`docker rm -f`
	 * exits non-zero against a missing container; that's tolerated as
	 * best-effort, never thrown).
	 */
	containerTornDown: boolean;
}

// --- Helpers ---------------------------------------------------------------

/**
 * Best-effort: is the `tmux` binary on PATH? We probe with `tmux -V` (prints
 * the version + exits 0). A non-zero exit means the binary isn't reachable;
 * we treat that as "tmux unavailable" and skip the session kill cleanly.
 */
function tmuxAvailable(spawnFn: SpawnSyncFn): boolean {
	const result = spawnFn('tmux', tmuxArgs(['-V']), { encoding: 'utf8' });
	return result.status === 0;
}

/**
 * Does the named tmux session exist? `tmux has-session -t <name>` exits 0
 * when the session is alive, non-zero otherwise.
 */
function sessionAlive(spawnFn: SpawnSyncFn, sessionName: string): boolean {
	const result = spawnFn('tmux', tmuxArgs(['has-session', '-t', sessionName]), { encoding: 'utf8' });
	return result.status === 0;
}

/**
 * Kill the named tmux session. Returns whether the kill command exited
 * cleanly. Caller has already verified the session exists.
 */
function killSession(spawnFn: SpawnSyncFn, sessionName: string): boolean {
	const result = spawnFn('tmux', tmuxArgs(['kill-session', '-t', sessionName]), { encoding: 'utf8' });
	return result.status === 0;
}

/**
 * Returns true when `argv` matches the shape emitted by
 * `buildSidecarSpawnArgv`/`buildSelfSpawnArgv(execPath, argv1, 'sidecar')`
 * (US-004, CAM-482; re-anchored in US-R1-001, CAM-482; token-count dropped in
 * US-R1-002, CAM-482): the final element is the literal subcommand token
 * `'sidecar'`, AND `argv[0]` is an absolute path. The compiled-binary
 * self-spawn shape is `[execPath, 'sidecar']` (2 elements) and the
 * interpreted-runtime shape is `[runtime, script, 'sidecar']` (3 elements),
 * but the exact element COUNT is deliberately not checked (see below).
 *
 * Deliberately independent of what argv[0]/argv[1] actually name (a binary
 * path, its basename, a runtime, a script path): a fixed binary-name literal
 * or a fixed subcommand index breaks the moment self-spawn resolves by
 * execPath (US-002/US-003) or the binary ships under a different name.
 *
 * The absolute-path requirement on `argv[0]` is NOT name-agnosticism being
 * abandoned; it re-anchors on a property the real self-spawn always has and
 * an ad-hoc shell command does not. Both production shapes are built from
 * `resolveSelfInvokeArgv` (src/util/self-invoke.ts), which always spreads
 * `process.execPath` as `argv[0]` -- `process.execPath` is always an absolute
 * filesystem path to the running binary/runtime (verified empirically: Bun
 * resolves `process.argv[1]`/`execPath` to an absolute path even when the
 * process itself was invoked with a relative script name). An interactive
 * command a developer happens to type in the project cwd (`rg sidecar`,
 * `tail -F sidecar`, `git log sidecar`) is invoked via a bare PATH-relative
 * name as `argv[0]`, never an absolute path, so it can no longer collide with
 * this predicate. Without this anchor, ANY 2-or-3-token command ending in the
 * literal word `sidecar` was misclassified as this project's sidecar process
 * and SIGTERM'd by the fallback scan (CAM-482).
 *
 * No exact token-count check (US-R1-002, CAM-482): `defaultListProcesses`
 * builds `argv` by splitting the raw `ps -eo pid,args` column on whitespace,
 * which has no way to distinguish "one argv element containing a space" from
 * "two separate elements" -- `ps` itself loses that boundary. An install path
 * containing a space (e.g. `/Users/x/My Tools/cam`) therefore fragments
 * `execPath`/`script` across 3+ (compiled) or 4+ (interpreted) array
 * elements, which an exact `length === 2 || length === 3` check would reject
 * even though it is the same live sidecar. Anchoring on the last element
 * (`'sidecar'`, a literal with no spaces, always intact as its own token) and
 * an absolute-path first element tolerates any amount of internal
 * fragmentation from a space-bearing path without reopening the false-match
 * class this predicate exists to close (`sidecar` is still required as the
 * exact trailing token, and a bare PATH-relative command still can't start
 * with `/`).
 */
export function isSidecarArgv(argv: string[]): boolean {
	const first = argv[0];
	const last = argv[argv.length - 1];
	return argv.length >= 2 && last === 'sidecar' && first !== undefined && first.startsWith('/');
}

/**
 * Returns true when `record` is a sidecar process (per {@link isSidecarArgv})
 * whose cwd matches `projectCwd` exactly. Scoped strictly: cwd equality, not
 * prefix/substring, so no other project's sidecar is touched.
 */
export function matchesSidecarForProject(record: ProcessRecord, projectCwd: string): boolean {
	return record.cwd === projectCwd && isSidecarArgv(record.argv);
}

/**
 * Production default for `listProcessesFn`.
 *
 * Uses `ps -eo pid,args` to enumerate processes, then `lsof -a -d cwd -p <pid>
 * -F n` to resolve the cwd for any candidate that looks like `cam sidecar`.
 * Returns an empty array when either command is unavailable or fails.
 */
function defaultListProcesses(): ProcessRecord[] {
	const psResult = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
	if (psResult.status !== 0 || !psResult.stdout) return [];

	const records: ProcessRecord[] = [];
	const lines = psResult.stdout.split('\n').slice(1); // skip header row

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const spaceIdx = trimmed.indexOf(' ');
		if (spaceIdx === -1) continue;

		const pidStr = trimmed.slice(0, spaceIdx);
		const argsStr = trimmed.slice(spaceIdx + 1).trim();
		const pid = parseInt(pidStr, 10);
		if (!Number.isFinite(pid) || pid <= 0) continue;

		const argv = argsStr.split(/\s+/).filter(Boolean);
		// Quick filter: skip anything that cannot be a sidecar self-spawn
		// (cheap, avoids an lsof call per process). Name-agnostic: see
		// isSidecarArgv for the argv shape this matches against.
		if (!isSidecarArgv(argv)) continue;

		// Resolve cwd via lsof. The -F n format emits lines prefixed with 'n'.
		const lsofResult = spawnSync(
			'lsof',
			['-a', '-d', 'cwd', '-p', String(pid), '-F', 'n'],
			{ encoding: 'utf8' },
		);
		if (lsofResult.status !== 0 || !lsofResult.stdout) continue;

		const cwdLine = lsofResult.stdout.split('\n').find((l) => l.startsWith('n'));
		if (!cwdLine) continue;
		const cwd = cwdLine.slice(1).trim();
		if (!cwd) continue;

		records.push({ pid, argv, cwd });
	}

	return records;
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Read the supervisor PID from the state file under `cwd`.
 * Returns `null` when the file is missing, unreadable, or has no `pid` field.
 */
function readSupervisorPid(cwd: string): number | null {
	const statePath = join(cwd, STATE_FILE_PATH);
	let body: string;
	try {
		body = readFileSync(statePath, 'utf8');
	} catch {
		return null;
	}
	const state = parseStateFile(body);
	if (!state) return null;
	return typeof state.pid === 'number' && state.pid > 0 ? state.pid : null;
}

/**
 * Send SIGTERM to the supervisor PID. Returns `true` when the kill succeeded,
 * `false` when the process was already dead or the call threw for any reason.
 */
function killSupervisorPid(pid: number, killFn: KillFn): boolean {
	try {
		killFn(pid, 'SIGTERM');
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill the worker slot pane by running `respawn-pane -k -t <paneId> echo stopped`.
 * This terminates whatever is running in the pane without destroying the pane id.
 * Returns `true` when the tmux call exited 0.
 */
function killWorkerPane(spawnFn: SpawnSyncFn, paneId: string): boolean {
	const result = spawnFn(
		'tmux',
		tmuxArgs(['respawn-pane', '-k', '-t', paneId, 'echo', 'stopped']),
		{ encoding: 'utf8' },
	);
	return result.status === 0;
}

/**
 * Run the `cam stop` flow without printing — returns a structured report.
 * Exposed for tests and any future programmatic consumer (e.g. `cam resume`
 * in US-010 may want to call into stop's primitives to wipe state).
 */
export function performStop(options: StopOptions = {}): StopReport {
	const cwd = options.cwd ?? process.cwd();
	const existsSyncImpl = options.existsSyncFn ?? existsSync;
	const unlinkSyncImpl = options.unlinkSyncFn ?? unlinkSync;
	const spawnFn = options.spawnSyncFn ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));
	const killFn = options.killFn ?? ((pid: number, signal: 'SIGTERM') => process.kill(pid, signal));
	const workerPaneReader = options.workerPaneReader ?? readWorkerPaneMarker;
	const sidecarPidReaderImpl = options.sidecarPidReader ?? readSidecarPid;
	const sidecarPidAliveImpl = options.sidecarPidAliveFn ?? sidecarPidAlive;
	const sidecarPidRemoverImpl = options.sidecarPidRemover ?? removeSidecarPid;
	const listProcessesImpl = options.listProcessesFn ?? defaultListProcesses;
	const watcherPidReaderImpl = options.watcherPidReader ?? readWatcherPid;
	const watcherPidAliveImpl = options.watcherPidAliveFn ?? sidecarPidAlive;
	const watcherPidRemoverImpl = options.watcherPidRemover ?? removeWatcherPid;
	const sidecarLivenessWatcherPidReaderImpl =
		options.sidecarLivenessWatcherPidReader ?? readSidecarLivenessWatcherPid;
	const sidecarLivenessWatcherPidAliveImpl =
		options.sidecarLivenessWatcherPidAliveFn ?? sidecarPidAlive;
	const sidecarLivenessWatcherPidRemoverImpl =
		options.sidecarLivenessWatcherPidRemover ?? removeSidecarLivenessWatcherPid;

	const session = projectSessionName(cwd);
	const claudeDir = join(cwd, '.claude');

	const report: StopReport = {
		stateFileRemoved: false,
		tmuxKilled: false,
		tmuxUnavailable: false,
		sessionName: session,
		supervisorKilled: false,
		workerPaneKilled: false,
		sidecarKilled: false,
		markersRemoved: [],
		fallbackSidecarKilled: false,
		watcherKilled: false,
		sidecarLivenessWatcherKilled: false,
		containerTornDown: false,
	};

	// 1. Kill the supervisor PID from the state file (before we remove it).
	const supervisorPid = readSupervisorPid(cwd);
	if (supervisorPid !== null) {
		report.supervisorKilled = killSupervisorPid(supervisorPid, killFn);
	}

	// 1b. Kill the sidecar process from .claude/.cam-sidecar.pid.
	//     Probe liveness first (signal-0); SIGTERM only when alive.
	//     Always remove the pid file when present (idempotent).
	const sidecarPid = sidecarPidReaderImpl(claudeDir);
	let sidecarFoundAlive = false;
	if (sidecarPid !== null) {
		const alive = sidecarPidAliveImpl(sidecarPid);
		if (alive) {
			sidecarFoundAlive = true;
			try {
				killFn(sidecarPid, 'SIGTERM');
				report.sidecarKilled = true;
			} catch {
				// kill threw — pid may have died in the instant between probe and kill
			}
		}
		// Always remove the pid file (idempotent whether alive or dead).
		sidecarPidRemoverImpl(claudeDir);
	}

	// 1c. Fallback scoped scan: if the pid-file path did NOT find a live sidecar
	//     (file absent or pid dead), enumerate processes and SIGTERM any
	//     `cam sidecar` whose cwd matches THIS project exactly.
	//     Scoped strictly: cwd equality, never a blanket process kill.
	if (!sidecarFoundAlive) {
		for (const record of listProcessesImpl()) {
			if (matchesSidecarForProject(record, cwd)) {
				try {
					killFn(record.pid, 'SIGTERM');
					report.fallbackSidecarKilled = true;
				} catch {
					// process may have exited between listing and kill
				}
			}
		}
	}

	// 1d. Kill the recycle watcher from .claude/.cam-watcher.pid.
	//     Mirrors step 1b: probe liveness (signal-0), SIGTERM only when alive,
	//     always remove the pid file (idempotent).
	const watcherPid = watcherPidReaderImpl(claudeDir);
	if (watcherPid !== null) {
		const watcherAlive = watcherPidAliveImpl(watcherPid);
		if (watcherAlive) {
			try {
				killFn(watcherPid, 'SIGTERM');
				report.watcherKilled = true;
			} catch {
				// kill threw — pid may have died in the instant between probe and kill
			}
		}
		// Always remove the pid file (idempotent whether alive or dead).
		watcherPidRemoverImpl(claudeDir);
	}

	// 1e. Kill the sidecar-liveness watcher from
	//     .claude/.cam-sidecar-liveness-watcher.pid (US-002, CAM-207).
	//     Mirrors step 1d: probe liveness (signal-0), SIGTERM only when alive,
	//     always remove the pid file (idempotent). A no-op in host-mode
	//     projects (the pid file was never written by `cam run`).
	const sidecarLivenessWatcherPid = sidecarLivenessWatcherPidReaderImpl(claudeDir);
	if (sidecarLivenessWatcherPid !== null) {
		const alive = sidecarLivenessWatcherPidAliveImpl(sidecarLivenessWatcherPid);
		if (alive) {
			try {
				killFn(sidecarLivenessWatcherPid, 'SIGTERM');
				report.sidecarLivenessWatcherKilled = true;
			} catch {
				// kill threw — pid may have died in the instant between probe and kill
			}
		}
		// Always remove the pid file (idempotent whether alive or dead).
		sidecarLivenessWatcherPidRemoverImpl(claudeDir);
	}

	// 1f. Tear down the cam-worker container at session exit (US-004, CAM-207).
	//     Gated to container mode: a no-op in host mode (this repo, and most
	//     projects, run host mode). Root cause this closes: a container left
	//     running across `cam stop` keeps its stale dnsmasq bound to port 53,
	//     which then hard-wedges the NEXT session's firewall init when it
	//     tries to bind the same port. Best-effort: `docker rm -f` against an
	//     absent container (or an absent `docker` binary) exits non-zero /
	//     throws; both are tolerated and never propagate out of `cam stop`.
	const workerIsolationReaderImpl = options.workerIsolationReader ?? readWorkerIsolation;
	const isolation = workerIsolationReaderImpl(join(cwd, 'scripts/cam/project.toml'));
	if (isolation === 'container') {
		const containerNameImpl = options.containerName ?? DEFAULT_CONTAINER_NAME;
		try {
			const result = spawnFn('docker', ['rm', '-f', containerNameImpl], { encoding: 'utf8' });
			report.containerTornDown = result.status === 0;
		} catch {
			// docker binary absent or the call threw — best-effort, never fails `cam stop`.
		}
	}

	// 2. Remove the loop state file.
	const statePath = join(cwd, STATE_FILE_PATH);
	if (existsSyncImpl(statePath)) {
		try {
			unlinkSyncImpl(statePath);
			report.stateFileRemoved = true;
			report.markersRemoved.push(STATE_FILE_PATH);
		} catch {
			// Couldn't unlink (permissions / race). Treat as not-removed; the
			// operator gets a warning + exit 0 still — the next `cam next`
			// will refuse to clobber the file and surface the same diagnostic.
		}
	}

	// 2b. Remove the full per-session marker set (US-002).
	//
	// Files cleaned (all idempotent: existsSync + unlinkSync in try/catch):
	//   - .cam-supervisor.lock  (SUPERVISOR_LOCK_FILE)    in .claude/
	//   - .cam-orch-session     (ORCH_SESSION_MARKER)     in .claude/
	//   - .cam-worker-pane      (WORKER_PANE_MARKER)      in .claude/
	//   - .cam-orch-ready       (ORCH_READY_MARKER)       in .claude/
	//   - .cam-orch-recycle     (ORCH_RECYCLE_MARKER)     in .claude/
	//   - .cam-orch-pid         (ORCH_PID_MARKER)         in .claude/
	//   - scripts/cam/worker-report.json (WORKER_REPORT_FILENAME) in cwd
	//
	// Absent markers are a no-op (existsSyncImpl returns false -> skip).
	// Diagnostic-value files (.cam-worker-*.session, cam-worker-events.jsonl,
	// cam-supervisor.log) are intentionally NOT removed.
	for (const [dir, name] of [
		[claudeDir, SUPERVISOR_LOCK_FILE],
		[claudeDir, ORCH_SESSION_MARKER],
		[claudeDir, WORKER_PANE_MARKER],
		[claudeDir, ORCH_READY_MARKER],
		[claudeDir, ORCH_RECYCLE_MARKER],
		[claudeDir, ORCH_PID_MARKER],
		[claudeDir, DRAIN_STOP_MARKER],
		[claudeDir, PAUSE_MARKER],
		[cwd, WORKER_REPORT_FILENAME],
	] as [string, string][]) {
		const p = join(dir, name);
		if (existsSyncImpl(p)) {
			try {
				unlinkSyncImpl(p);
				report.markersRemoved.push(relative(cwd, p));
			} catch {
				// best-effort: permission race or already gone
			}
		}
	}

	// 3. Kill the project tmux session if alive.
	if (!tmuxAvailable(spawnFn)) {
		report.tmuxUnavailable = true;
	} else if (sessionAlive(spawnFn, session)) {
		const killed = killSession(spawnFn, session);
		report.tmuxKilled = killed;

		// 4. Also kill the worker slot pane (before or after the full session kill).
		//    If the full session kill succeeded, the pane is already gone — but
		//    the `respawn-pane -k` call is idempotent (it just fails silently if
		//    the pane is already dead). We still attempt it when the session is
		//    alive so the worker pane exits cleanly even if kill-session fails.
		const workerPaneId = workerPaneReader(claudeDir);
		if (workerPaneId) {
			report.workerPaneKilled = killWorkerPane(spawnFn, workerPaneId);
		}
	} else {
		// Session not alive — try the worker pane kill anyway using tmux
		// in case the pane outlived the session check race window.
		const workerPaneId = workerPaneReader(claudeDir);
		if (workerPaneId) {
			report.workerPaneKilled = killWorkerPane(spawnFn, workerPaneId);
		}
	}

	return report;
}

/**
 * Run the full `cam stop` flow with printed diagnostics. Always exits 0 —
 * the kill-switch is forgiving by design.
 */
export function runStop(options: StopOptions = {}): number {
	const report = performStop(options);

	emitTitle('cam stop');
	emitSectionHeading('Cleanup');

	if (report.supervisorKilled) {
		emitOk('Sent SIGTERM to supervisor PID');
	}

	if (report.sidecarKilled) {
		emitOk('Sent SIGTERM to sidecar process');
	}

	if (report.fallbackSidecarKilled) {
		emitOk('Sent SIGTERM to orphaned sidecar process (fallback scoped scan)');
	}

	if (report.watcherKilled) {
		emitOk('Sent SIGTERM to recycle watcher process');
	}

	if (report.sidecarLivenessWatcherKilled) {
		emitOk('Sent SIGTERM to sidecar-liveness watcher process');
	}

	if (report.containerTornDown) {
		emitOk('Tore down cam-worker container');
	}

	if (report.markersRemoved.length > 0) {
		emitOk(`Removed ${report.markersRemoved.length} marker file(s): ${report.markersRemoved.join(', ')}`);
	}

	if (report.stateFileRemoved) {
		emitOk(`Removed ${STATE_FILE_PATH}`);
	} else {
		emitMutedHint(`No ${STATE_FILE_PATH} present (nothing to clean)`);
	}

	if (report.workerPaneKilled) {
		emitOk('Killed worker slot pane');
	}

	if (report.tmuxUnavailable) {
		emitMutedHint('tmux not on PATH (skipping session check)');
	} else if (report.tmuxKilled) {
		emitOk(`Killed tmux session "${report.sessionName}"`);
	} else {
		emitMutedHint(`No tmux session named "${report.sessionName}" (nothing to kill)`);
	}

	// Closing "Done" section. The divisor stays muted like every other section;
	// success is signaled by the accent ✓ glyph on the content line (`emitOk`),
	// matching how the Ink screens do it.
	emitSectionHeading('Done');
	if (report.stateFileRemoved || report.tmuxKilled || report.supervisorKilled || report.sidecarKilled || report.fallbackSidecarKilled || report.watcherKilled || report.sidecarLivenessWatcherKilled || report.containerTornDown || report.markersRemoved.length > 0) {
		emitOk('Loop stopped');
	} else {
		emitMutedHint('Nothing to clean — no active loop or stale state');
	}

	emitTrailingBlank();
	return 0;
}
