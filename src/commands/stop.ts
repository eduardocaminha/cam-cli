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
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';
import { parseStateFile } from './status.ts';
import { projectSessionName, readWorkerPaneMarker, tmuxArgs } from '../tmux/session.ts';

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

	const session = projectSessionName(cwd);
	const claudeDir = join(cwd, '.claude');

	const report: StopReport = {
		stateFileRemoved: false,
		tmuxKilled: false,
		tmuxUnavailable: false,
		sessionName: session,
		supervisorKilled: false,
		workerPaneKilled: false,
	};

	// 1. Kill the supervisor PID from the state file (before we remove it).
	const supervisorPid = readSupervisorPid(cwd);
	if (supervisorPid !== null) {
		report.supervisorKilled = killSupervisorPid(supervisorPid, killFn);
	}

	// 2. Remove the loop state file.
	const statePath = join(cwd, STATE_FILE_PATH);
	if (existsSyncImpl(statePath)) {
		try {
			unlinkSyncImpl(statePath);
			report.stateFileRemoved = true;
		} catch {
			// Couldn't unlink (permissions / race). Treat as not-removed; the
			// operator gets a warning + exit 0 still — the next `cam next`
			// will refuse to clobber the file and surface the same diagnostic.
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
	if (report.stateFileRemoved || report.tmuxKilled || report.supervisorKilled) {
		emitOk('Loop stopped');
	} else {
		emitMutedHint('Nothing to clean — no active loop or stale state');
	}

	emitTrailingBlank();
	return 0;
}
