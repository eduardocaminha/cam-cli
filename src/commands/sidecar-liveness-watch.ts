// src/commands/sidecar-liveness-watch.ts
//
// `cam sidecar-liveness-watch` — INTERNAL subcommand.
//
// Polls `sidecarAlive(claudeDir)` (src/supervisor/sidecar-pid.ts) to detect a
// dead container sidecar process. On a dead sidecar it attempts a bounded
// respawn (N attempts, with a backoff sleep between attempts). If the sidecar
// is still dead after the bound is exhausted, it writes the shared
// `.cam-sidecar-stalled.json` marker (src/supervisor/sidecar-stalled.ts) with
// reason `'sidecar-died'` and stops respawning (escalate, never hot-loop — no
// endless respawn of a sidecar that keeps dying on a deterministic failure).
// When the sidecar is observed alive again (manual recovery), the attempt
// counter and the exhausted flag both reset, so a later death is retried
// fresh from attempt 1.
//
// This module is spawned by `cam run` (src/commands/run.ts) ONLY when the
// project is configured for `worker_isolation = "container"` — host mode has
// no container sidecar process to monitor, so the spawn there is a no-op
// (gated by `shouldSpawnSidecarLivenessWatch` in run.ts, not by this module).
//
// Mirrors src/commands/orch-recycle-watch.ts: injectable seams, while(true)
// poll loop, Bun.sleepSync, no top-level HELP entry.
//
// IMPORTANT INVARIANT: this file does NOT register a `--permission-mode` flag
// of its own. `test/no-permission-mode-flag.test.ts` enforces this by scanning
// every file in `src/commands/`.

import { join } from 'node:path';
import process from 'node:process';

import { sidecarAlive, writeSidecarPid } from '../supervisor/sidecar-pid.ts';
import { SIDECAR_STALLED_FILENAME, writeSidecarStalledMarker } from '../supervisor/sidecar-stalled.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of a spawned sidecar process handle, mirroring SidecarProcess in run.ts. */
export interface SidecarLivenessWatchProcessHandle {
	pid: number;
	/** Kill the process. Best-effort (no-throw). */
	kill: () => void;
}

export interface SidecarLivenessWatchOptions {
	/** Working directory — defaults to process.cwd(). */
	cwd?: string;
	/**
	 * Returns true when the sidecar process is alive.
	 * Production: `sidecarAlive(claudeDir)` (signal-0 probe over the persisted
	 * `.cam-sidecar.pid`). Tests inject a controlled sequence.
	 */
	aliveFn?: () => boolean;
	/**
	 * Respawns the sidecar process. Production: spawns `cam sidecar` as a
	 * background Bun child process. Tests inject a fake that records the
	 * invocation and returns a no-op handle.
	 */
	spawnSidecarFn?: () => SidecarLivenessWatchProcessHandle;
	/**
	 * Persists the freshly respawned sidecar's pid so `cam stop` can still
	 * SIGTERM it. Production: `writeSidecarPid(claudeDir, pid)`.
	 */
	writePidFn?: (pid: number) => void;
	/**
	 * Writes the shared sidecar-stalled marker on respawn exhaustion.
	 * Production: `writeSidecarStalledMarker(markerPath, { reason:
	 * 'sidecar-died', detail, writtenAt })`.
	 */
	writeMarkerFn?: (detail: string) => void;
	/**
	 * Sleeps for the given number of milliseconds between polls/attempts.
	 * Production: `Bun.sleepSync(ms)`. Tests inject a counting fn that throws
	 * a sentinel error after a fixed number of cycles to stop the (otherwise
	 * infinite) loop.
	 */
	sleepFn?: (ms: number) => void;
	/** Poll interval in milliseconds when the sidecar is alive (or exhausted). Default: 2000ms. */
	pollIntervalMs?: number;
	/** Backoff sleep in milliseconds between respawn attempts. Default: 2000ms. */
	backoffMs?: number;
	/** Maximum number of respawn attempts before escalating. Default: 3. */
	maxRespawnAttempts?: number;
}

// ---------------------------------------------------------------------------
// Production dep factories
// ---------------------------------------------------------------------------

function makeSpawnSidecarFn(cwd: string): () => SidecarLivenessWatchProcessHandle {
	return () => {
		const proc = Bun.spawn(['cam', 'sidecar'], {
			cwd,
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		return {
			pid: proc.pid,
			kill: () => {
				try {
					proc.kill();
				} catch {
					// best-effort
				}
			},
		};
	};
}

function makeWriteMarkerFn(claudeDir: string): (detail: string) => void {
	const markerPath = join(claudeDir, SIDECAR_STALLED_FILENAME);
	return (detail: string) => {
		writeSidecarStalledMarker(markerPath, {
			reason: 'sidecar-died',
			detail,
			writtenAt: new Date().toISOString(),
		});
	};
}

// ---------------------------------------------------------------------------
// Poll tick helper
// ---------------------------------------------------------------------------

interface TickDeps {
	aliveFn: () => boolean;
	spawnSidecarFn: () => SidecarLivenessWatchProcessHandle;
	writePidFn: (pid: number) => void;
	writeMarkerFn: (detail: string) => void;
	pollIntervalMs: number;
	backoffMs: number;
	maxRespawnAttempts: number;
}

/** Mutable state carried between ticks (attempt count + escalation latch). */
export interface SidecarLivenessWatchState {
	attempts: number;
	exhausted: boolean;
}

/**
 * Execute one poll tick and return how many milliseconds to sleep before the
 * next tick.
 *
 * - Sidecar alive: reset `attempts`/`exhausted` (recovery) and sleep the
 *   normal poll interval.
 * - Sidecar dead, already exhausted: no-op (escalated once; never hot-loop)
 *   and sleep the normal poll interval so a later manual recovery is still
 *   detected.
 * - Sidecar dead, not exhausted: respawn, persist the new pid, and sleep the
 *   backoff interval. If this attempt reaches `maxRespawnAttempts`, write the
 *   shared stalled marker (reason 'sidecar-died') and latch `exhausted` so no
 *   further respawns are attempted.
 */
export function handleOneTick(deps: TickDeps, state: SidecarLivenessWatchState): number {
	if (deps.aliveFn()) {
		state.attempts = 0;
		state.exhausted = false;
		return deps.pollIntervalMs;
	}

	if (state.exhausted) {
		return deps.pollIntervalMs;
	}

	state.attempts++;
	if (state.attempts > deps.maxRespawnAttempts) {
		state.exhausted = true;
		deps.writeMarkerFn(`sidecar respawn exhausted after ${deps.maxRespawnAttempts} attempt(s)`);
		return deps.pollIntervalMs;
	}

	const proc = deps.spawnSidecarFn();
	deps.writePidFn(proc.pid);
	return deps.backoffMs;
}

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

/**
 * Run the sidecar-liveness watcher.
 *
 * Polls `aliveFn()` (default: `sidecarAlive(claudeDir)`). On a dead sidecar,
 * attempts a bounded respawn (default 3 attempts) with a backoff sleep
 * between attempts. On respawn exhaustion, writes the shared
 * `.cam-sidecar-stalled.json` marker with reason `'sidecar-died'` and stops
 * respawning until the sidecar is observed alive again.
 *
 * Returns a Promise<void> that never resolves; the process is killed by the
 * caller's cleanup handler (same contract as `cam orch-recycle-watch`).
 */
export async function runSidecarLivenessWatch(
	options: SidecarLivenessWatchOptions = {},
): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir = join(cwd, '.claude');

	const deps: TickDeps = {
		aliveFn: options.aliveFn ?? (() => sidecarAlive(claudeDir)),
		spawnSidecarFn: options.spawnSidecarFn ?? makeSpawnSidecarFn(cwd),
		writePidFn: options.writePidFn ?? ((pid: number) => writeSidecarPid(claudeDir, pid)),
		writeMarkerFn: options.writeMarkerFn ?? makeWriteMarkerFn(claudeDir),
		pollIntervalMs: options.pollIntervalMs ?? 2000,
		backoffMs: options.backoffMs ?? 2000,
		maxRespawnAttempts: options.maxRespawnAttempts ?? 3,
	};
	const sleepFn = options.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
	const state: SidecarLivenessWatchState = { attempts: 0, exhausted: false };

	while (true) {
		const sleepMs = handleOneTick(deps, state);
		sleepFn(sleepMs);
	}
}
