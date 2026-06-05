// src/tmux/session.ts
//
// Canonical tmux helper module for cam-cli.
//
// All loop commands share these helpers to name, create, and split into the
// per-project orchestrator session. Each helper accepts an injectable spawn
// function so unit tests can assert exact argv without spinning a real tmux
// server.
//
// Design decisions (cam-run-workspace cycle):
//   - One tmux session per project, named by projectSessionName().
//   - The full session layout has three panes (US-011):
//       Pane 0 (left):         orchestrator (claude)
//       Pane 1 (top-right):    cam dashboard (permanent)
//       Pane 2 (bottom-right): interactive menu
//     ensureProjectSession creates it lazily with two split-window calls.
//   - openPaneInSession opens a new pane via split-window -t into an existing
//     session; loop commands use this to host their claude invocations.
//   - isInsideProjectSession checks the $TMUX_PANE and $CAM_SESSION env vars
//     to detect whether the caller is already running inside the project
//     session (prevents double-attach).

import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal spawn signature the helpers need; injectable for tests. */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options?: { stdio?: 'ignore' | 'inherit' | 'pipe' },
) => SpawnSyncReturns<Buffer | string>;

/** Shape of process.env subset we inspect; injectable for tests. */
export type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Session naming
// ---------------------------------------------------------------------------

/**
 * Derive a tmux session name from the project's working directory.
 *
 * Format: `cam-orch-<basename>-<6-char hash>`. Sanitized to tmux-safe chars.
 *
 * This is the canonical source of truth for the session name; the copy that
 * lived in src/commands/run.ts delegates here.
 */
export function projectSessionName(cwd: string): string {
	const baseRaw = basename(cwd) || 'project';
	const base = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
	const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 6);
	return `cam-orch-${base}-${hash}`;
}

// ---------------------------------------------------------------------------
// Session existence check
// ---------------------------------------------------------------------------

/**
 * Return true if a tmux session with the given name already exists.
 * Uses `tmux has-session -t <name>` (exit 0 = exists).
 */
export function hasSession(sessionName: string, spawnFn: SpawnFn): boolean {
	const r = spawnFn('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
	return (r.status ?? 1) === 0;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Lazily create the full project tmux session if it does not already exist.
 *
 * Layout (3-pane, US-011):
 *   Pane 0 (left):         orchestrator — starts with `bash`; callers
 *                          send-keys the actual claude command.
 *   Pane 1 (top-right):    cam dashboard (permanent) — callers send-keys
 *                          `cam dashboard` here after creation.
 *   Pane 2 (bottom-right): interactive menu — callers send-keys the menu
 *                          script here.
 *
 * Two split-window calls build the right column: the first creates pane 1
 * (horizontal split of the full window), the second splits pane 1 vertically
 * to produce pane 2.
 *
 * Returns `true` when the session was freshly created, `false` when it already
 * existed (caller can decide whether to attach or skip).
 *
 * The session is created detached (`-d`) so the caller controls when/whether
 * to attach.
 */
export function ensureProjectSession(
	sessionName: string,
	spawnFn: SpawnFn,
): boolean {
	if (hasSession(sessionName, spawnFn)) {
		return false;
	}

	// Create the detached session with pane 0 running bash (orchestrator slot).
	spawnFn(
		'tmux',
		[
			'new-session', '-d',
			'-s', sessionName,
			'-x', '220', '-y', '50',
			'bash',
		],
		{ stdio: 'ignore' },
	);

	// Split horizontally to add pane 1 (dashboard slot, 36-column right pane).
	spawnFn(
		'tmux',
		[
			'split-window',
			'-t', `${sessionName}:0.0`,
			'-h',
			'-l', '36',
			'-d',
			'bash',
		],
		{ stdio: 'ignore' },
	);

	// Split pane 1 vertically to add pane 2 (menu slot, bottom of right column).
	spawnFn(
		'tmux',
		[
			'split-window',
			'-t', `${sessionName}:0.1`,
			'-v',
			'-d',
			'bash',
		],
		{ stdio: 'ignore' },
	);

	return true;
}

// ---------------------------------------------------------------------------
// Open a pane inside an existing session
// ---------------------------------------------------------------------------

/**
 * Split a new pane into an existing project session and run `cmd` in it.
 *
 * Uses `split-window -t <sessionName>:0 -v -d <cmd>` (vertical split,
 * detached so the caller is not immediately switched into it).
 *
 * Intended for loop commands that want to host their claude invocation inside
 * the project session without re-creating the session layout.
 */
export function openPaneInSession(
	sessionName: string,
	cmd: string,
	spawnFn: SpawnFn,
): void {
	spawnFn(
		'tmux',
		[
			'split-window',
			'-t', `${sessionName}:0`,
			'-v',
			'-d',
			cmd,
		],
		{ stdio: 'ignore' },
	);
}

// ---------------------------------------------------------------------------
// Inside-session detection
// ---------------------------------------------------------------------------

/**
 * Return true if the current process is already running inside the named
 * project session.
 *
 * Detection strategy:
 *   1. If `env.TMUX` is falsy, we are not inside any tmux session.
 *   2. If `env.CAM_SESSION` matches `sessionName`, we were explicitly tagged
 *      (callers set this when they spawn claude inside the session).
 *   3. As a fallback heuristic, check whether the tmux display-message
 *      value embedded in $TMUX_PANE starts with sessionName.
 *      $TMUX_PANE has the form `%<n>`; the session name is not directly in it,
 *      so we rely primarily on CAM_SESSION for correctness.
 *
 * This is intentionally a pure env-inspection function (no spawn) so it can
 * be called cheaply and tested without side effects.
 */
export function isInsideProjectSession(
	sessionName: string,
	env: Env,
): boolean {
	if (!env['TMUX']) {
		return false;
	}
	// Explicit tag wins.
	if (env['CAM_SESSION'] === sessionName) {
		return true;
	}
	return false;
}
