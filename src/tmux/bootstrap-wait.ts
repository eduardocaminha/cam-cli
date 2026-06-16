// src/tmux/bootstrap-wait.ts
//
// Bootstrap-wait helper for cam thin-proxy commands (US-006).
//
// When cam plan / cam next / cam issue detect no live orchestrator they:
//   1. Bootstrap cam run --no-attach (via the caller-supplied bootstrapFn).
//   2. Call waitForOrchestrator() to poll .claude/.cam-orch-ready AND
//      re-validate liveness via orchestratorAlive before returning true.
//
// The two-condition check (marker present AND orchestratorAlive returns true)
// prevents false positives from stale markers left by a previously crashed
// orchestrator.
//
// Unit-tested with injected statFn (file-stat fake) and sleepFn.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratorAlive, type SpawnFn } from './session.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker filename within .claude/ written by cam run after orchestrator boot.
 * Thin-proxy commands poll for this file before sending keys.
 */
export const ORCH_READY_MARKER = '.cam-orch-ready';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapWaitOptions {
	/** Absolute path to the .claude/ directory. */
	claudeDir: string;
	/** Session name used by orchestratorAlive for the liveness re-check. */
	sessionName: string;
	/** Spawn function forwarded to orchestratorAlive (injectable for tests). */
	spawnFn: SpawnFn;
	/**
	 * Return true if the marker file exists. Defaults to fs.existsSync.
	 * Injected in tests to avoid touching the real filesystem.
	 */
	statFn?: (path: string) => boolean;
	/**
	 * Sleep function. Defaults to Bun.sleepSync (synchronous block).
	 * Injected in tests to advance time without real waits.
	 */
	sleepFn?: (ms: number) => void;
	/** Total poll budget in milliseconds. Default: 60 000 (60 s). */
	timeoutMs?: number;
	/** Interval between polls in milliseconds. Default: 500. */
	pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wait until the orchestrator is ready.
 *
 * Polls for `<claudeDir>/.cam-orch-ready` to appear (written by `cam run`
 * after session creation). Once the marker is present, re-validates liveness
 * via `orchestratorAlive` to guard against stale markers from a previous crash.
 *
 * Returns `true` when both conditions are met, `false` on timeout.
 */
export function waitForOrchestrator(opts: BootstrapWaitOptions): boolean {
	const {
		claudeDir,
		sessionName,
		spawnFn,
		statFn = existsSync,
		sleepFn = (ms: number) => {
			Bun.sleepSync(ms);
		},
		timeoutMs = 60_000,
		pollIntervalMs = 500,
	} = opts;

	const markerPath = join(claudeDir, ORCH_READY_MARKER);
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (statFn(markerPath) && orchestratorAlive(sessionName, spawnFn)) {
			return true;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		sleepFn(Math.min(pollIntervalMs, remaining));
	}
	return false;
}
