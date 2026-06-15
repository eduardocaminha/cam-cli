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
//   - The full session layout has two panes (US-002):
//       Pane 0 (left):      orchestrator (claude)
//       Pane 1 (right):     cam dashboard (permanent)
//     ensureProjectSession creates it lazily with one split-window call.
//   - openPaneInSession opens a new pane via split-window -t into an existing
//     session; loop commands use this to host their claude invocations.
//   - isInsideProjectSession checks the $TMUX_PANE and $CAM_SESSION env vars
//     to detect whether the caller is already running inside the project
//     session (prevents double-attach).
//
// Worker-slot primitives (CAM-22 / US-001; wait-for helpers deleted in CAM-42):
//   - respawnPaneArgv, capturePaneArgv: pure argv builders for the supervisor
//     to drive a reused worker pane.
//   - writeWorkerPaneMarker / readWorkerPaneMarker: persist and read the worker
//     pane id in .claude/.cam-worker-pane so supervisor and lifecycle commands
//     can address the slot across process restarts.

import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Dashboard width helper
// ---------------------------------------------------------------------------

/**
 * Clamp the dashboard column width to a legible band.
 *
 * Formula: clamp(round(windowWidth * 0.26), 34, 80)
 *
 * - Minimum 34 cols: keeps the dashboard readable on narrow terminals.
 * - Maximum 80 cols: prevents the column from starving the orchestrator pane
 *   on very wide terminals.
 * - 26% of the window is the target proportion for the right column.
 *   At 188 cols (a common operator terminal), 26% yields 49 cols, which is
 *   wide enough to fit the realistic tokens status row without wrapping.
 *
 * Used by ensureProjectSession (born width) and the window-resized hook
 * (live resize). Single source of truth so both paths stay in sync.
 */
export function clampDashboardWidth(windowWidth: number): number {
	return Math.min(80, Math.max(34, Math.round(windowWidth * 0.26)));
}

// ---------------------------------------------------------------------------
// Socket / arg builder
// ---------------------------------------------------------------------------

/** Dedicated tmux socket name used by all cam-cli sessions. */
export const CAM_TMUX_SOCKET = 'cam';

/**
 * Prepend the `-L <socket>` global flag to a tmux subcommand argv.
 *
 * Usage: spawnFn('tmux', tmuxArgs(['new-session', '-d', '-s', name]))
 * Result argv: ['-L', 'cam', 'new-session', '-d', '-s', name]
 *
 * `-L` is a GLOBAL tmux option and MUST precede the subcommand.
 */
export function tmuxArgs(sub: string[]): string[] {
	return ['-L', CAM_TMUX_SOCKET, ...sub];
}

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
	const r = spawnFn('tmux', tmuxArgs(['has-session', '-t', sessionName]), { stdio: 'ignore' });
	return (r.status ?? 1) === 0;
}

/**
 * Return true if an EXISTING session is stale / malformed and should be
 * recreated rather than attached to (CAM-47). A healthy cam session has 2 or 3
 * panes: the canonical 2-pane layout (orchestrator + dashboard) is always alive,
 * and a 3rd pane is alive iff it is the titled worker-pane (identifiable by a
 * non-empty `@cam_label` user option set via `tmux set-option -p`). Any other
 * pane count, a `cat` placeholder pane, or a 3rd pane without `@cam_label`
 * (stray shell / leftover process) marks the session as stale.
 *
 * The signal is deliberately CONSERVATIVE: when in doubt (list-panes failure),
 * prefer stale=true so `cam run` recreates a clean session rather than attaching
 * to an unknown one.
 *
 * Format: `#{pane_current_command}\t#{@cam_label}` - tab-separated so command
 * and label are unambiguously parsed even when labels contain spaces.
 */
export function isSessionStale(sessionName: string, spawnFn: SpawnFn): boolean {
	const r = spawnFn(
		'tmux',
		tmuxArgs(['list-panes', '-t', sessionName, '-F', '#{pane_current_command}\t#{@cam_label}']),
		{ stdio: 'pipe' },
	);
	if ((r.status ?? 1) !== 0) return true; // list-panes failed: conservative
	const out = typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString() ?? '');
	const panes = out
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => {
			const tabIdx = l.indexOf('\t');
			const cmd = tabIdx === -1 ? l : l.slice(0, tabIdx);
			const label = tabIdx === -1 ? '' : l.slice(tabIdx + 1);
			return { cmd, label };
		});
	if (panes.length < 2) return true; // too few panes
	if (panes.some((p) => p.cmd === 'cat')) return true; // a placeholder never respawned
	if (panes.length === 2) return false; // canonical 2-pane layout: alive
	if (panes.length === 3) {
		// The orchestrator and dashboard panes are ALWAYS labeled ('orchestrator' and
		// 'dashboard' respectively, set in run.ts setupPanes). The remaining 3rd pane
		// is the worker-pane slot. It is alive only when it carries a known worker
		// @cam_label ('implementer' or 'reviewer', set in loop.ts before respawn-pane).
		// A stray/dead pane (leftover bash shell, unlabeled process) has no label or
		// an unknown label and must be treated as stale.
		const WORKER_LABELS = new Set(['implementer', 'reviewer']);
		const workerPane = panes.find(
			(p) => p.label !== 'orchestrator' && p.label !== 'dashboard',
		);
		if (!workerPane) return true; // no 3rd pane identifiable: stale
		return !WORKER_LABELS.has(workerPane.label);
	}
	return true; // 4+ panes: stale
}

// ---------------------------------------------------------------------------
// Orchestrator-alive predicate
// ---------------------------------------------------------------------------

/**
 * Return true if the orchestrator pane (pane index 0) in the given session is
 * currently running the `claude` process.
 *
 * Thin-proxies call this before injecting a `/cam-*` command via send-keys to
 * confirm the orchestrator is running and listening, not sitting in a dead pane
 * or a shell prompt.
 *
 * Returns false on any list-panes failure (conservative: treat unknown state
 * as not-alive so proxies fall back to bootstrapping).
 */
export function orchestratorAlive(sessionName: string, spawnFn: SpawnFn): boolean {
	const r = spawnFn(
		'tmux',
		tmuxArgs(['list-panes', '-t', sessionName, '-F', '#{pane_index}\t#{pane_current_command}']),
		{ stdio: 'pipe' },
	);
	if ((r.status ?? 1) !== 0) return false;
	const out = typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString() ?? '');
	const orchLine = out
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.find((l) => l.startsWith('0\t'));
	if (!orchLine) return false;
	const cmd = orchLine.slice(2); // everything after '0\t'
	return cmd === 'claude';
}

// ---------------------------------------------------------------------------
// Orchestrator pane-id lookup
// ---------------------------------------------------------------------------

/**
 * Return the tmux pane ID (e.g. `%3`) for the orchestrator pane (pane index 0)
 * in the given session.
 *
 * Used by thin-proxy commands to target `send-keys` at the orchestrator pane.
 * Returns null on list-panes failure or if pane index 0 is not found.
 */
export function getOrchPaneId(sessionName: string, spawnFn: SpawnFn): string | null {
	const r = spawnFn(
		'tmux',
		tmuxArgs(['list-panes', '-t', sessionName, '-F', '#{pane_index}\t#{pane_id}']),
		{ stdio: 'pipe' },
	);
	if ((r.status ?? 1) !== 0) return null;
	const out = typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString() ?? '');
	const line = out
		.split('\n')
		.find((l) => l.trim().startsWith('0\t'));
	if (!line) return null;
	const tabIdx = line.indexOf('\t');
	if (tabIdx === -1) return null;
	const paneId = line.slice(tabIdx + 1).trim();
	return paneId.length > 0 ? paneId : null;
}

// ---------------------------------------------------------------------------
// Pane-count mutex predicate
// ---------------------------------------------------------------------------

/**
 * States returned by `paneCountMutex`.
 *
 * - `'available'` - exactly 2 panes exist; a dispatch MAY spawn the 3rd (worker) pane.
 * - `'busy'`      - 1, 3, or more panes exist; a dispatch MUST NOT spawn a new pane.
 */
export type PaneMutexState = 'available' | 'busy';

/**
 * Return the mutex state for the worker-pane slot.
 *
 * A dispatch is only permitted to spawn the 3rd (worker) pane when exactly 2
 * panes currently exist (the canonical orchestrator + dashboard layout). Any
 * other count means a worker is already running or the session is malformed:
 * in both cases callers must not dispatch.
 *
 * Returns `'busy'` on list-panes failure (conservative).
 */
export function paneCountMutex(sessionName: string, spawnFn: SpawnFn): PaneMutexState {
	const r = spawnFn(
		'tmux',
		tmuxArgs(['list-panes', '-t', sessionName, '-F', '#{pane_id}']),
		{ stdio: 'pipe' },
	);
	if ((r.status ?? 1) !== 0) return 'busy'; // conservative: treat failure as busy
	const out = typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString() ?? '');
	const count = out
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0).length;
	return count === 2 ? 'available' : 'busy';
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/** Pane IDs captured when a new session is freshly created. */
export interface CreatedPaneIds {
	orchPaneId: string;
	dashboardPaneId: string;
}

/**
 * Lazily create the full project tmux session if it does not already exist.
 *
 * Layout (2-pane, US-002):
 *   Pane 0 (left):   orchestrator. Created with a silent `cat` placeholder;
 *                    the caller respawn-panes claude in.
 *   Pane 1 (right):  cam dashboard (permanent). Caller respawn-panes
 *                    `cam dashboard` in after creation.
 *
 * Panes start with `cat` (silent, no interactive shell) so the real command,
 * respawned directly by the caller, paints with no macOS shell notice / prompt
 * / command echo flashing first. A pane closes when its command exits (e.g.
 * the dashboard `q`); tmux reflows the survivor to fill the window.
 *
 * One split-window call builds the right column (horizontal split of the full
 * window).
 *
 * Pane IDs are captured via `-P -F '#{pane_id}'` on each tmux call so that
 * pane addressing is stable regardless of the user's `pane-base-index`
 * setting in .tmux.conf. The returned `%<n>` IDs must be used for all
 * subsequent send-keys and select-pane calls.
 *
 * `CAM_SESSION=<sessionName>` is injected as an env var on new-session so
 * every pane in the session inherits it. isInsideProjectSession and the
 * attach-hint suppression both rely on this env var being present at runtime.
 *
 * Returns a `CreatedPaneIds` record when the session was freshly created, or
 * `false` when it already existed (caller can decide whether to attach or
 * skip).
 *
 * The session is created detached (`-d`) so the caller controls when/whether
 * to attach.
 */
export function ensureProjectSession(
	sessionName: string,
	spawnFn: SpawnFn,
): CreatedPaneIds | false {
	if (hasSession(sessionName, spawnFn)) {
		return false;
	}

	// Create the detached session with pane 0 running a silent `cat` placeholder
	// (orchestrator slot); the caller respawns the real command into it.
	// -P -F '#{pane_id}' prints the stable pane id (%<n>) to stdout.
	// -e CAM_SESSION=<name> injects the session tag so isInsideProjectSession works.
	const newSessResult = spawnFn(
		'tmux',
		tmuxArgs([
			'new-session', '-d',
			'-s', sessionName,
			'-x', '220', '-y', '50',
			'-e', `CAM_SESSION=${sessionName}`,
			'-P', '-F', '#{pane_id}',
			'cat',
		]),
		{ stdio: 'pipe' },
	);
	const orchPaneId = newSessResult.stdout.toString().trim();

	// Split horizontally to add pane 1 (dashboard slot, clamped-width right pane).
	// Target the orchestrator pane by its stable id, not a positional index.
	const dashSplitResult = spawnFn(
		'tmux',
		tmuxArgs([
			'split-window',
			'-t', orchPaneId,
			'-h',
			'-l', String(clampDashboardWidth(220)),
			'-d',
			'-P', '-F', '#{pane_id}',
			'cat',
		]),
		{ stdio: 'pipe' },
	);
	const dashboardPaneId = dashSplitResult.stdout.toString().trim();

	// Install a window-resized hook so the dashboard column re-clamps on every
	// terminal resize or client attach. The hook fires inside the tmux server
	// context, so it must call tmux on the same -L cam socket.
	//
	// Hook body uses run-shell: tmux expands #{window_width} to the live window
	// width (a numeric literal) before passing the string to sh -c. Shell $(())
	// arithmetic then computes the clamped value as a literal integer for -x.
	// Both tmux format comparisons (lexical, not numeric) and resize-pane format
	// expansion (-x rejects #{...}) are avoided this way.
	//
	// Formula: (w*26+50)/100 mirrors Math.round(w*0.26) in the JS helper
	// (round-half-up, not truncation). Bounds 34-80 match clampDashboardWidth.
	//
	// || true makes the hook best-effort: a failed resize-pane never crashes
	// the session.
	const hookShell = [
		`w=#{window_width}`,
		`t=$(( (w*26+50)/100 ))`,
		`t=$(( t<34?34:t>80?80:t ))`,
		`tmux -L ${CAM_TMUX_SOCKET} resize-pane -t ${dashboardPaneId} -x $t || true`,
	].join('; ');
	const hookCmd = `run-shell '${hookShell}'`;

	// best-effort: ignore exit status of set-hook itself
	spawnFn(
		'tmux',
		tmuxArgs(['set-hook', '-t', sessionName, 'window-resized', hookCmd]),
		{ stdio: 'ignore' },
	);

	return { orchPaneId, dashboardPaneId };
}

// ---------------------------------------------------------------------------
// Open a pane inside an existing session
// ---------------------------------------------------------------------------

/**
 * Split a new pane into an existing project session and run `cmdArgv` in it.
 *
 * Uses `split-window -t <sessionName>:0 -v -d -P -F #{pane_id} -- <arg0> ...`
 * (vertical split, detached so the caller is not immediately switched into it).
 * `-P -F #{pane_id}` causes tmux to print the stable pane id (%<n>) to stdout.
 *
 * The command is passed as multiple argv elements (tmux multi-arg
 * shell-command form), which causes tmux to exec the binary directly rather
 * than routing through `/bin/sh -c`. This prevents shell-metacharacter
 * injection when any argv element contains user-supplied free text (e.g. an
 * issue description with `;`, `$()`, backticks, or quotes).
 *
 * Returns the captured pane id string (e.g. `%5`). Callers that want to
 * address the pane later (respawn-pane, capture-pane, etc.) should persist
 * this via writeWorkerPaneMarker.
 *
 * Intended for loop commands that want to host their claude invocation inside
 * the project session without re-creating the session layout.
 */
export function openPaneInSession(
	sessionName: string,
	cmdArgv: string[],
	spawnFn: SpawnFn,
): string {
	const result = spawnFn(
		'tmux',
		tmuxArgs([
			'split-window',
			'-t', `${sessionName}:0`,
			'-v',
			'-d',
			'-P', '-F', '#{pane_id}',
			'--',
			...cmdArgv,
		]),
		{ stdio: 'pipe' },
	);
	return result.stdout.toString().trim();
}

// ---------------------------------------------------------------------------
// Worker-slot argv builders (CAM-22 / US-001)
// ---------------------------------------------------------------------------

/**
 * Build the argv for `tmux respawn-pane -k -t <paneId> <shellCmd...>`.
 *
 * `respawn-pane -k` kills the currently running command in the pane and
 * starts the new command in the same pane id, so the pane address is stable
 * across multiple worker invocations.
 *
 * The shell command is passed as individual argv elements after the pane
 * target; tmux joins them with a space into a shell string internally, which
 * is the standard respawn-pane calling convention.
 */
export function respawnPaneArgv(paneId: string, shellCmd: string[]): string[] {
	return tmuxArgs(['respawn-pane', '-k', '-t', paneId, ...shellCmd]);
}

/**
 * Build the argv for `tmux capture-pane -p -t <paneId>`.
 *
 * Prints the visible pane content to stdout. The supervisor uses the output
 * to grep for completion sentinels (e.g. `CAM_IMPLEMENTER_STATUS=`).
 *
 * `-p` prints to stdout instead of writing to the capture buffer.
 */
export function capturePaneArgv(paneId: string): string[] {
	return tmuxArgs(['capture-pane', '-p', '-t', paneId]);
}

// ---------------------------------------------------------------------------
// Worker pane marker persistence (CAM-22 / US-001)
// ---------------------------------------------------------------------------

/** Filename within `.claude/` where the worker pane id is persisted. */
export const WORKER_PANE_MARKER = '.cam-worker-pane';

/**
 * Persist the worker pane id to `<claudeDir>/.cam-worker-pane`.
 *
 * `claudeDir` is typically `<cwd>/.claude`. Creates the directory if absent.
 * The file contains the bare pane id string (e.g. `%5`), no trailing newline.
 */
export function writeWorkerPaneMarker(claudeDir: string, paneId: string): void {
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, WORKER_PANE_MARKER), paneId, 'utf8');
}

/**
 * Read the worker pane id from `<claudeDir>/.cam-worker-pane`.
 *
 * Returns the pane id string (e.g. `%5`), or `null` if the file does not
 * exist or is empty. Never throws; callers must treat null as "slot not yet
 * allocated".
 */
export function readWorkerPaneMarker(claudeDir: string): string | null {
	try {
		const content = readFileSync(join(claudeDir, WORKER_PANE_MARKER), 'utf8').trim();
		return content.length > 0 ? content : null;
	} catch {
		return null;
	}
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
