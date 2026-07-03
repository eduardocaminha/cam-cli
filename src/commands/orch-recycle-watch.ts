// src/commands/orch-recycle-watch.ts
//
// `cam orch-recycle-watch` — INTERNAL subcommand.
//
// Polls for the orchestrator recycle marker (ORCH_RECYCLE_MARKER) and, when
// present, resolves the orchestrator claude PID, sends SIGTERM, and removes
// the marker (consume-once invariant).
//
// Key invariants:
//   - Fires SIGTERM on the recycle marker only; never on the handoff file.
//   - The PID is resolved via `pgrep -f <uuid>` scoped to the session UUID
//     read fresh from ORCH_SESSION_MARKER on every poll — no tmux call made.
//   - After sending SIGTERM the marker is removed so a single arm triggers
//     at most one SIGTERM (the respawned session sees no marker).
//   - All I/O is injectable so unit tests never touch real fs/processes.
//
// NOT listed in top-level HELP. Spawned as a detached background process by
// `cam run` (mirroring the `cam sidecar` pattern). Responds to `--help` when
// invoked directly.
//
// IMPORTANT INVARIANT: this file does NOT register a `--permission-mode` flag
// of its own. `test/no-permission-mode-flag.test.ts` enforces this by scanning
// every file in `src/commands/`.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { ORCH_RECYCLE_MARKER, ORCH_SESSION_MARKER } from '../tmux/session.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchRecycleWatchOptions {
	/** Working directory — defaults to process.cwd(). */
	cwd?: string;
	/**
	 * Returns true when the recycle marker is present on disk.
	 * Production: existsSync('<claudeDir>/ORCH_RECYCLE_MARKER').
	 * Tests inject a controlled sequence.
	 */
	readMarkerFn?: () => boolean;
	/**
	 * Returns the orchestrator session UUID (contents of ORCH_SESSION_MARKER),
	 * or null when the file is absent or empty.
	 * Production: readFileSync('<claudeDir>/ORCH_SESSION_MARKER').trim() | null.
	 * Tests inject a constant or sequence.
	 */
	readSessionIdFn?: () => string | null;
	/**
	 * Resolves the orchestrator claude PID from the session UUID via pgrep.
	 * Returns null when no matching process is found.
	 * Production: spawnSync('pgrep', ['-f', sessionId]).
	 * Tests inject a fake to avoid real process scanning.
	 */
	resolvePidFn?: (sessionId: string) => number | null;
	/**
	 * Sends a signal to the given PID.
	 * Production: process.kill(pid, 'SIGTERM').
	 * Tests inject a spy to assert the signal value without killing real processes.
	 */
	killFn?: (pid: number, signal: NodeJS.Signals) => void;
	/**
	 * Removes the recycle marker from disk (consume-once).
	 * Production: unlinkSync('<claudeDir>/ORCH_RECYCLE_MARKER').
	 * Tests inject a spy.
	 */
	removeMarkerFn?: () => void;
	/**
	 * Sleeps for the given number of milliseconds between polls.
	 * Production: Bun.sleepSync(ms).
	 * Tests inject a no-op (pair with small pollIntervalMs).
	 */
	sleepFn?: (ms: number) => void;
	/** Poll interval in milliseconds. Default: 2000ms. */
	pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Production dep factories
// ---------------------------------------------------------------------------

function makeReadMarkerFn(claudeDir: string): () => boolean {
	const markerPath = join(claudeDir, ORCH_RECYCLE_MARKER);
	return () => existsSync(markerPath);
}

function makeReadSessionIdFn(claudeDir: string): () => string | null {
	const sessionPath = join(claudeDir, ORCH_SESSION_MARKER);
	return () => {
		try {
			const content = readFileSync(sessionPath, 'utf8').trim();
			return content.length > 0 ? content : null;
		} catch {
			return null;
		}
	};
}

function makeResolvePidFn(): (sessionId: string) => number | null {
	return (sessionId: string) => {
		const result = spawnSync('pgrep', ['-f', sessionId], { encoding: 'utf8' });
		if ((result.status ?? 1) !== 0) return null;
		const raw = typeof result.stdout === 'string' ? result.stdout.trim() : '';
		if (raw.length === 0) return null;
		// pgrep may return multiple PIDs (one per line); take the first.
		const firstLine = raw.split('\n')[0] ?? '';
		const pid = parseInt(firstLine, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	};
}

function makeRemoveMarkerFn(claudeDir: string): () => void {
	const markerPath = join(claudeDir, ORCH_RECYCLE_MARKER);
	return () => {
		try {
			unlinkSync(markerPath);
		} catch {
			// Best-effort: marker may have already been removed.
		}
	};
}

// ---------------------------------------------------------------------------
// Poll tick helper (extracted to keep runOrchRecycleWatch under biome's
// noExcessiveCognitiveComplexity limit of 15; CAM-60 factory/helper pattern)
// ---------------------------------------------------------------------------

interface TickDeps {
	readMarkerFn: () => boolean;
	readSessionIdFn: () => string | null;
	resolvePidFn: (sessionId: string) => number | null;
	killFn: (pid: number, signal: NodeJS.Signals) => void;
	removeMarkerFn: () => void;
}

/**
 * Execute one poll tick: check for the recycle marker and fire SIGTERM if found.
 *
 * Consume-once: removes the marker regardless of whether a PID was resolved.
 * This ensures a single arm produces at most one SIGTERM and the respawned
 * session sees no stale marker.
 */
function handleOneTick(deps: TickDeps): void {
	if (!deps.readMarkerFn()) return;

	// Read session UUID fresh (rewritten on every respawn).
	const sessionId = deps.readSessionIdFn();
	if (sessionId !== null) {
		const pid = deps.resolvePidFn(sessionId);
		if (pid !== null) {
			deps.killFn(pid, 'SIGTERM');
		}
	}

	// Consume-once: remove marker even when PID was not found, so the respawned
	// session does not see the stale marker.
	deps.removeMarkerFn();
}

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

/**
 * Run the orchestrator recycle watcher.
 *
 * Polls for the ORCH_RECYCLE_MARKER file. When present:
 *   1. Reads the ORCH_SESSION_MARKER file to get the session UUID (fresh each poll).
 *   2. Resolves the orchestrator claude PID via `pgrep -f <uuid>`.
 *   3. Sends SIGTERM to that PID (graceful exit, not SIGKILL).
 *   4. Removes the marker (consume-once: the respawned session sees no marker).
 *
 * Returns a Promise<void> that never resolves; the process is killed by the
 * caller's cleanup handler (same contract as `cam sidecar`).
 */
export async function runOrchRecycleWatch(options: OrchRecycleWatchOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir = join(cwd, '.claude');

	const deps: TickDeps = {
		readMarkerFn: options.readMarkerFn ?? makeReadMarkerFn(claudeDir),
		readSessionIdFn: options.readSessionIdFn ?? makeReadSessionIdFn(claudeDir),
		resolvePidFn: options.resolvePidFn ?? makeResolvePidFn(),
		killFn: options.killFn ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); }),
		removeMarkerFn: options.removeMarkerFn ?? makeRemoveMarkerFn(claudeDir),
	};
	const sleepFn = options.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
	const pollIntervalMs = options.pollIntervalMs ?? 2000;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		handleOneTick(deps);
		sleepFn(pollIntervalMs);
	}
}
