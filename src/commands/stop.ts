// src/commands/stop.ts
//
// Implementation of `ralph stop` — cleanly cancels a running loop.
//
// What it does, in order:
//   1. Removes `.claude/ralph-loop.local.md` (the plugin's state file). After
//      this, the next `ralph next` invocation does NOT detect a stale loop.
//   2. If a tmux session named exactly `ralph` is alive, kills it. Defensive
//      check: we ONLY kill `ralph` — nothing else — so an unrelated tmux
//      session named e.g. `work` is untouched. The PRD note for US-008
//      explicitly calls this out.
//   3. Exits 0. Both steps are idempotent: missing state file + missing tmux
//      session both report `nothing to clean` and still exit 0. `ralph stop`
//      is the kill-switch operators reach for, so it never fails on "the
//      loop wasn't running" — that's the success state.
//
// Acceptance criteria (US-008):
//   3. `ralph stop` exists; removes `.claude/ralph-loop.local.md`, kills any
//      tmux session named `ralph` (if alive), exits 0.
//   4. After `ralph stop`, the next `ralph next` invocation does NOT detect a
//      stale loop.
//
// Tmux detection contract (per the PRD note): `tmux has-session -t ralph
// 2>/dev/null` — exit 0 means the session exists, exit non-zero means it does
// not. We only call `tmux kill-session -t ralph` when has-session succeeded.
// The `tmux` binary may not be installed at all (e.g. on a fresh dev box) —
// that's also "nothing to clean", not a failure.

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import { printHint, printSuccess, printWarning } from '../logging/color.ts';

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = '.claude/ralph-loop.local.md';
const TMUX_SESSION_NAME = 'ralph';

// --- Types -----------------------------------------------------------------

/** Minimal subset of `spawnSync` we use; injectable for tests. */
export type SpawnSyncFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8' },
) => SpawnSyncReturns<string>;

export interface StopOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Override `existsSync` for tests. */
	existsSyncFn?: (path: string) => boolean;
	/** Override `unlinkSync` for tests (also lets tests record the call). */
	unlinkSyncFn?: (path: string) => void;
	/** Override `spawnSync` for tests (used to fake tmux). */
	spawnSyncFn?: SpawnSyncFn;
}

export interface StopReport {
	/** Was the state file present + removed by this call? */
	stateFileRemoved: boolean;
	/** Was a `ralph` tmux session present + killed by this call? */
	tmuxKilled: boolean;
	/** Was the `tmux` binary unavailable on PATH? (Distinguishes "not installed" from "no session".) */
	tmuxUnavailable: boolean;
}

// --- Helpers ---------------------------------------------------------------

/**
 * Best-effort: is the `tmux` binary on PATH? We probe with `tmux -V` (prints
 * the version + exits 0). A non-zero exit means the binary isn't reachable;
 * we treat that as "tmux unavailable" and skip the session kill cleanly.
 */
function tmuxAvailable(spawnFn: SpawnSyncFn): boolean {
	const result = spawnFn('tmux', ['-V'], { encoding: 'utf8' });
	return result.status === 0;
}

/**
 * Does the `ralph` tmux session exist? `tmux has-session -t ralph` exits 0
 * when the session is alive, non-zero otherwise. We don't pipe stderr through
 * to the operator — the no-session case logs to stderr by default.
 */
function ralphSessionAlive(spawnFn: SpawnSyncFn): boolean {
	const result = spawnFn('tmux', ['has-session', '-t', TMUX_SESSION_NAME], { encoding: 'utf8' });
	return result.status === 0;
}

/**
 * Kill the `ralph` tmux session. Returns whether the kill command exited
 * cleanly. Caller has already verified the session exists.
 */
function killRalphSession(spawnFn: SpawnSyncFn): boolean {
	const result = spawnFn('tmux', ['kill-session', '-t', TMUX_SESSION_NAME], { encoding: 'utf8' });
	return result.status === 0;
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the `ralph stop` flow without printing — returns a structured report.
 * Exposed for tests and any future programmatic consumer (e.g. `ralph resume`
 * in US-010 may want to call into stop's primitives to wipe state).
 */
export function performStop(options: StopOptions = {}): StopReport {
	const cwd = options.cwd ?? process.cwd();
	const existsSyncImpl = options.existsSyncFn ?? existsSync;
	const unlinkSyncImpl = options.unlinkSyncFn ?? unlinkSync;
	const spawnFn = options.spawnSyncFn ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));

	const report: StopReport = {
		stateFileRemoved: false,
		tmuxKilled: false,
		tmuxUnavailable: false,
	};

	// 1. Remove the loop state file.
	const statePath = join(cwd, STATE_FILE_PATH);
	if (existsSyncImpl(statePath)) {
		try {
			unlinkSyncImpl(statePath);
			report.stateFileRemoved = true;
		} catch {
			// Couldn't unlink (permissions / race). Treat as not-removed; the
			// operator gets a warning + exit 0 still — the next `ralph next`
			// will refuse to clobber the file and surface the same diagnostic.
		}
	}

	// 2. Kill the `ralph` tmux session if alive.
	if (!tmuxAvailable(spawnFn)) {
		report.tmuxUnavailable = true;
	} else if (ralphSessionAlive(spawnFn)) {
		const killed = killRalphSession(spawnFn);
		report.tmuxKilled = killed;
	}

	return report;
}

/**
 * Run the full `ralph stop` flow with printed diagnostics. Always exits 0 —
 * the kill-switch is forgiving by design.
 */
export function runStop(options: StopOptions = {}): number {
	const report = performStop(options);

	if (report.stateFileRemoved) {
		printSuccess(`removed ${STATE_FILE_PATH}`);
	} else {
		printHint(`no ${STATE_FILE_PATH} present (nothing to clean)`);
	}

	if (report.tmuxUnavailable) {
		printHint('tmux not on PATH (skipping session check)');
	} else if (report.tmuxKilled) {
		printSuccess(`killed tmux session "${TMUX_SESSION_NAME}"`);
	} else {
		printHint(`no tmux session named "${TMUX_SESSION_NAME}" (nothing to kill)`);
	}

	if (!report.stateFileRemoved && !report.tmuxKilled) {
		printWarning('ralph stop: nothing to clean', 'no active loop or stale state detected');
	} else {
		printSuccess('ralph stop: clean');
	}
	return 0;
}
