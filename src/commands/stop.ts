// src/commands/stop.ts
//
// Implementation of `cam stop` — cleanly cancels a running loop.
//
// What it does, in order:
//   1. Removes `.claude/cam-loop.local.md` (the plugin's state file). After
//      this, the next `cam next` invocation does NOT detect a stale loop.
//   2. If a tmux session named exactly `cam` is alive, kills it. Defensive
//      check: we ONLY kill `cam` — nothing else — so an unrelated tmux
//      session named e.g. `work` is untouched. The PRD note for US-008
//      explicitly calls this out.
//   3. Exits 0. Both steps are idempotent: missing state file + missing tmux
//      session both report `nothing to clean` and still exit 0. `cam stop`
//      is the kill-switch operators reach for, so it never fails on "the
//      loop wasn't running" — that's the success state.
//
// Acceptance criteria (US-008):
//   3. `cam stop` exists; removes `.claude/cam-loop.local.md`, kills any
//      tmux session named `cam` (if alive), exits 0.
//   4. After `cam stop`, the next `cam next` invocation does NOT detect a
//      stale loop.
//
// Tmux detection contract (per the PRD note): `tmux has-session -t cam
// 2>/dev/null` — exit 0 means the session exists, exit non-zero means it does
// not. We only call `tmux kill-session -t cam` when has-session succeeded.
// The `tmux` binary may not be installed at all (e.g. on a fresh dev box) —
// that's also "nothing to clean", not a failure.

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import { printWarning } from '../logging/color.ts';
import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = '.claude/cam-loop.local.md';
const TMUX_SESSION_NAME = 'cam';

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
	/** Was a `cam` tmux session present + killed by this call? */
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
 * Does the `cam` tmux session exist? `tmux has-session -t cam` exits 0
 * when the session is alive, non-zero otherwise. We don't pipe stderr through
 * to the operator — the no-session case logs to stderr by default.
 */
function camSessionAlive(spawnFn: SpawnSyncFn): boolean {
	const result = spawnFn('tmux', ['has-session', '-t', TMUX_SESSION_NAME], { encoding: 'utf8' });
	return result.status === 0;
}

/**
 * Kill the `cam` tmux session. Returns whether the kill command exited
 * cleanly. Caller has already verified the session exists.
 */
function killCamSession(spawnFn: SpawnSyncFn): boolean {
	const result = spawnFn('tmux', ['kill-session', '-t', TMUX_SESSION_NAME], { encoding: 'utf8' });
	return result.status === 0;
}

// --- Public entrypoint -----------------------------------------------------

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
			// operator gets a warning + exit 0 still — the next `cam next`
			// will refuse to clobber the file and surface the same diagnostic.
		}
	}

	// 2. Kill the `cam` tmux session if alive.
	if (!tmuxAvailable(spawnFn)) {
		report.tmuxUnavailable = true;
	} else if (camSessionAlive(spawnFn)) {
		const killed = killCamSession(spawnFn);
		report.tmuxKilled = killed;
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

	if (report.stateFileRemoved) {
		emitOk(`Removed ${STATE_FILE_PATH}`);
	} else {
		emitMutedHint(`No ${STATE_FILE_PATH} present (nothing to clean)`);
	}

	if (report.tmuxUnavailable) {
		emitMutedHint('tmux not on PATH (skipping session check)');
	} else if (report.tmuxKilled) {
		emitOk(`Killed tmux session "${TMUX_SESSION_NAME}"`);
	} else {
		emitMutedHint(`No tmux session named "${TMUX_SESSION_NAME}" (nothing to kill)`);
	}

	if (!report.stateFileRemoved && !report.tmuxKilled) {
		// printWarning lives at col 0 by design (it's an interrupt) and brings
		// its own leading blank line, so the visual rhythm stays correct even
		// outside the Section column.
		printWarning('Nothing to clean', 'No active loop or stale state detected');
	} else {
		emitOk('Clean');
	}

	emitTrailingBlank();
	return 0;
}
