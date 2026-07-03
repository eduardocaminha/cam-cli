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

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { ORCH_PID_MARKER, ORCH_RECYCLE_MARKER } from '../tmux/session.ts';
import {
	parseContextOccupancy,
	orchestratorTranscriptPath,
} from '../transcript/usage.ts';
import {
	orchestratorContextWindow,
	ORCH_CONTEXT_BACKSTOP_FRACTION,
	isOverContextBackstop,
} from '../orchestrator/context-window.ts';

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
	 * @deprecated No longer used for pid resolution (US-002/CAM-173). The tick
	 * path now reads ORCH_PID_MARKER directly via resolvePidFn. The occupancy
	 * backstop path reads .cam-orch-session internally via orchestratorTranscriptPath.
	 * This field is accepted for backward compat but silently ignored.
	 */
	readSessionIdFn?: () => string | null;
	/**
	 * Resolves the orchestrator claude PID via pgrep -P <wrapper_pid>.
	 * Reads .cam-orch-pid to obtain the wrapper pid, then calls pgrep -P.
	 * Returns null when the pid file is absent/empty, the wrapper pid is
	 * non-finite, or pgrep -P finds no child process.
	 * Production: reads ORCH_PID_MARKER then spawnSync('pgrep', ['-P', ...]).
	 * Tests inject a fake (no-arg) to avoid real fs/process calls.
	 */
	resolvePidFn?: () => number | null;
	/**
	 * Called when the recycle marker is consumed but the pid does not resolve
	 * (pid file absent or child already dead). Receives a one-line structured
	 * JSON record. Default: process.stderr.write of the record.
	 * Tests inject a capture fn to assert the event fires exactly on the
	 * unresolved-pid-with-consumed-marker path and NOT on the resolve-ok path.
	 */
	emitEventFn?: (line: string) => void;
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

	// --- Backstop seams (US-003 / CAM-163) ---

	/**
	 * Returns the orchestrator's current context occupancy in tokens,
	 * or null when the transcript is absent or unreadable.
	 * Production: reads orchestratorTranscriptPath(cwd, claudeConfigDir) then
	 * applies parseContextOccupancy. A null return is always a no-op.
	 */
	readOccupancyFn?: () => number | null;
	/**
	 * Arms the ORCH_RECYCLE_MARKER by writing an empty file.
	 * Production: writeFileSync(join(claudeDir, ORCH_RECYCLE_MARKER), '', 'utf8').
	 * Must write to the same path that readMarkerFn reads, so handleOneTick
	 * picks up the marker and fires SIGTERM via the existing consume-once path.
	 */
	armMarkerFn?: () => void;
	/**
	 * Context window size in tokens for the configured orchestrator model.
	 * Production: orchestratorContextWindow() from src/orchestrator/context-window.ts.
	 * Resolved once at startup, not per-tick.
	 */
	contextWindow?: number;
	/**
	 * Backstop fraction (0-1). The watcher fires when occupancy exceeds
	 * contextWindow * backstopFraction.
	 * Production: ORCH_CONTEXT_BACKSTOP_FRACTION (0.8).
	 */
	backstopFraction?: number;
}

// ---------------------------------------------------------------------------
// Production dep factories
// ---------------------------------------------------------------------------

function makeReadMarkerFn(claudeDir: string): () => boolean {
	const markerPath = join(claudeDir, ORCH_RECYCLE_MARKER);
	return () => existsSync(markerPath);
}


/**
 * Read the wrapper bash pid from the pid marker file.
 * Returns null when the file is absent, empty, or contains a non-finite value.
 */
function readWrapperPid(pidFilePath: string): number | null {
	let raw: string;
	try {
		raw = readFileSync(pidFilePath, 'utf8').trim();
	} catch {
		return null; // file absent — no wrapper running
	}
	if (raw.length === 0) return null;
	const pid = parseInt(raw, 10);
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Resolve the child pid of a given wrapper process via pgrep -P.
 * pgrep -P is a kernel ppid match: deterministic and immune to argv
 * truncation (the CAM-173 failure mode with pgrep -f <uuid>).
 * Returns null when pgrep finds no child or exits non-zero.
 */
function resolveChildViaPgrep(wrapperPid: number): number | null {
	const result = spawnSync('pgrep', ['-P', String(wrapperPid)], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) return null;
	const raw = typeof result.stdout === 'string' ? result.stdout.trim() : '';
	if (raw.length === 0) return null;
	// During the active claude phase, the wrapper has exactly one child
	// (claude). Take the first pid returned.
	const lines = raw.split('\n').filter((l) => l.trim().length > 0);
	const firstLine = lines[0] ?? '';
	const pid = parseInt(firstLine, 10);
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function makeResolvePidFn(claudeDir: string): () => number | null {
	const pidFilePath = join(claudeDir, ORCH_PID_MARKER);
	return () => {
		const wrapperPid = readWrapperPid(pidFilePath);
		if (wrapperPid === null) return null;
		return resolveChildViaPgrep(wrapperPid);
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

/**
 * Reads the orchestrator's current context occupancy from its transcript.
 * Returns null when the transcript path cannot be resolved or the file is
 * absent / unreadable (caller treats null as a no-op).
 */
function makeReadOccupancyFn(cwd: string): () => number | null {
	const claudeConfigDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
	return (): number | null => {
		const transcriptPath = orchestratorTranscriptPath(cwd, claudeConfigDir);
		if (transcriptPath === null) return null;
		let jsonl: string;
		try {
			jsonl = readFileSync(transcriptPath, 'utf8');
		} catch {
			return null;
		}
		return parseContextOccupancy(jsonl);
	};
}

/**
 * Arms the recycle marker by writing an empty file.
 * Mirrors the arming pattern in index.ts:~1181 so the existing
 * handleOneTick consume-once path fires SIGTERM automatically.
 */
function makeArmMarkerFn(claudeDir: string): () => void {
	const markerPath = join(claudeDir, ORCH_RECYCLE_MARKER);
	return () => {
		writeFileSync(markerPath, '', 'utf8');
	};
}

// ---------------------------------------------------------------------------
// Poll tick helper (extracted to keep runOrchRecycleWatch under biome's
// noExcessiveCognitiveComplexity limit of 15; CAM-60 factory/helper pattern)
// ---------------------------------------------------------------------------

interface BackstopDeps {
	readOccupancyFn: () => number | null;
	armMarkerFn: () => void;
	contextWindow: number;
	backstopFraction: number;
}

/**
 * Check the context backstop once per poll tick.
 *
 * If the orchestrator transcript reports an occupancy strictly above
 * `contextWindow * backstopFraction`, the recycle marker is armed via
 * `armMarkerFn`. The immediately following `handleOneTick` call then
 * sees the marker and fires SIGTERM via the existing consume-once path.
 *
 * A null occupancy (absent/unreadable transcript) is always a no-op:
 * it never produces a false-positive recycle.
 */
function checkBackstop(deps: BackstopDeps): void {
	const occupancy = deps.readOccupancyFn();
	if (occupancy === null) return;
	if (isOverContextBackstop(occupancy, deps.contextWindow, deps.backstopFraction)) {
		deps.armMarkerFn();
	}
}

interface TickDeps {
	readMarkerFn: () => boolean;
	resolvePidFn: () => number | null;
	killFn: (pid: number, signal: NodeJS.Signals) => void;
	removeMarkerFn: () => void;
	emitEventFn?: (line: string) => void;
}

/**
 * Execute one poll tick: check for the recycle marker and fire SIGTERM if found.
 *
 * Consume-once: removes the marker regardless of whether a PID was resolved.
 * This ensures a single arm produces at most one SIGTERM and the respawned
 * session sees no stale marker.
 *
 * When the marker is consumed but the pid does not resolve (file absent or
 * child already dead), a structured event is emitted via emitEventFn so the
 * failure is never a silent no-op (AC3: non-silent unresolved-pid event).
 */
function handleOneTick(deps: TickDeps): void {
	if (!deps.readMarkerFn()) return;

	// Resolve the claude child pid from the wrapper pid in .cam-orch-pid.
	const pid = deps.resolvePidFn();
	if (pid !== null) {
		deps.killFn(pid, 'SIGTERM');
	} else {
		// Marker consumed but no pid resolved: emit a structured event so the
		// failure is observable (never a silent no-op).
		const event = JSON.stringify({
			event: 'unresolved-pid',
			ts: new Date().toISOString(),
		});
		if (deps.emitEventFn) {
			deps.emitEventFn(event);
		} else {
			process.stderr.write(`[cam] orch-recycle-watch: ${event}\n`);
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
 *   1. Reads ORCH_PID_MARKER (.cam-orch-pid) to get the wrapper bash pid.
 *   2. Resolves the orchestrator claude PID via `pgrep -P <wrapper_pid>`.
 *   3. Sends SIGTERM to that PID (graceful exit, not SIGKILL).
 *   4. Removes the marker (consume-once: the respawned session sees no marker).
 *   5. Emits a structured unresolved-pid event when the marker was consumed
 *      but no pid could be resolved (never a silent no-op).
 *
 * Returns a Promise<void> that never resolves; the process is killed by the
 * caller's cleanup handler (same contract as `cam sidecar`).
 */
export async function runOrchRecycleWatch(options: OrchRecycleWatchOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir = join(cwd, '.claude');

	const deps: TickDeps = {
		readMarkerFn: options.readMarkerFn ?? makeReadMarkerFn(claudeDir),
		resolvePidFn: options.resolvePidFn ?? makeResolvePidFn(claudeDir),
		killFn: options.killFn ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); }),
		removeMarkerFn: options.removeMarkerFn ?? makeRemoveMarkerFn(claudeDir),
		emitEventFn: options.emitEventFn,
	};
	const backstopDeps: BackstopDeps = {
		readOccupancyFn: options.readOccupancyFn ?? makeReadOccupancyFn(cwd),
		armMarkerFn: options.armMarkerFn ?? makeArmMarkerFn(claudeDir),
		contextWindow: options.contextWindow ?? orchestratorContextWindow(),
		backstopFraction: options.backstopFraction ?? ORCH_CONTEXT_BACKSTOP_FRACTION,
	};
	const sleepFn = options.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
	const pollIntervalMs = options.pollIntervalMs ?? 2000;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		// Check the context backstop first: if over the ceiling, arm the marker.
		// handleOneTick then sees the marker and fires SIGTERM via the existing
		// consume-once path (one unified signal route regardless of who armed it).
		checkBackstop(backstopDeps);
		handleOneTick(deps);
		sleepFn(pollIntervalMs);
	}
}
