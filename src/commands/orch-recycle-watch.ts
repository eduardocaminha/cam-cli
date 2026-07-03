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
//   - The PID is resolved via `ps -ax -o pid=,ppid=` filtered by ppid==wrapper_pid
//     (kernel proc table, immune to process-title rewriting; CAM-165 fix).
//     The wrapper pid is read from ORCH_PID_MARKER (.cam-orch-pid) on every poll.
//   - After sending SIGTERM the marker is removed so a single arm triggers
//     at most one SIGTERM (the respawned session sees no marker).
//   - All I/O is injectable so unit tests never touch real fs/processes.
//
// NOT listed in top-level HELP. Spawned as a detached background process by
// `cam run` (mirroring the `cam sidecar` pattern).
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
	 * Resolves the orchestrator claude PID via ps ppid-walk.
	 * Reads .cam-orch-pid to obtain the wrapper pid, then runs
	 * `ps -ax -o pid=,ppid=` filtered by ppid==wrapperPid (kernel proc table,
	 * immune to process-title rewriting; CAM-165 fix).
	 * Returns null when the pid file is absent/empty, the wrapper pid is
	 * non-finite, or ps finds no child with the expected ppid.
	 * Production: reads ORCH_PID_MARKER then spawnSync('ps', ['-ax', '-o', 'pid=,ppid=']).
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
 *
 * Exported for direct unit testing of each guard branch (reviewer finding
 * US-R1-001: zero coverage on the parsing guards).
 */
export function readWrapperPid(pidFilePath: string): number | null {
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
 * Minimal injectable seam for resolveChildViaPs.
 * Returns raw `ps -ax -o pid=,ppid=` output (all processes; filtering by ppid
 * happens in TS). Tests inject a fake to exercise guard branches without
 * spawning a real process.
 */
export type PsSpawnFn = () => { status: number | null; stdout: string };

/**
 * Parse `ps -ax -o pid=,ppid=` stdout and return pids of processes whose
 * ppid column equals wrapperPid. Columns are space-padded ("  PID  PPID").
 * Lines with non-numeric pid/ppid are skipped. Extracted to keep
 * resolveChildViaPs under biome's noExcessiveCognitiveComplexity limit.
 */
function parsePsChildPids(raw: string, wrapperPid: number): number[] {
	const matched: number[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		const ppid = parseInt(parts[1] ?? '', 10);
		if (!Number.isFinite(ppid) || ppid !== wrapperPid) continue;
		const pid = parseInt(parts[0] ?? '', 10);
		if (!Number.isFinite(pid) || pid <= 0) continue;
		matched.push(pid);
	}
	return matched;
}

/**
 * Emit an ambiguous-children structured event (>1 ps results for the same
 * wrapperPid). Extracted to keep resolveChildViaPs under the complexity limit.
 */
function emitAmbiguityEvent(
	wrapperPid: number,
	childPids: number[],
	selectedPid: number,
	emitEventFn?: (line: string) => void,
): void {
	const event = JSON.stringify({
		event: 'ambiguous-children',
		wrapperPid,
		childPids,
		selectedPid,
		ts: new Date().toISOString(),
	});
	if (emitEventFn) {
		emitEventFn(event);
	} else {
		process.stderr.write(`[cam] orch-recycle-watch: ${event}\n`);
	}
}

/**
 * Resolve the child pid of a given wrapper process via ps ppid-walk.
 * Runs `ps -ax -o pid=,ppid=` and filters lines where the ppid column equals
 * wrapperPid. The kernel proc table (ppid field) is immune to process-title
 * rewriting (the CAM-165 fix: the previous approach was blind to title-rewritten processes).
 *
 * - 0 matches: returns null (caller emits unresolved-pid event).
 * - 1 match: returns that pid.
 * - >1 matches: selects the highest pid (newest child) and records the
 *   ambiguity via emitEventFn (defaults to stderr).
 *
 * Exported for direct unit testing of each guard branch.
 * The optional spawnFn seam lets tests exercise all parsing guards
 * without real process spawning.
 */
export function resolveChildViaPs(
	wrapperPid: number,
	spawnFn?: PsSpawnFn,
	emitEventFn?: (line: string) => void,
): number | null {
	const result = spawnFn
		? spawnFn()
		: (spawnSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' }) as {
				status: number | null;
				stdout: string;
			});
	if ((result.status ?? 1) !== 0) return null;
	const raw = typeof result.stdout === 'string' ? result.stdout : '';
	const matched = parsePsChildPids(raw, wrapperPid);
	if (matched.length === 0) return null;
	if (matched.length > 1) {
		const selectedPid = Math.max(...matched);
		emitAmbiguityEvent(wrapperPid, matched, selectedPid, emitEventFn);
		return selectedPid;
	}
	return matched[0] ?? null;
}

function makeResolvePidFn(claudeDir: string): () => number | null {
	const pidFilePath = join(claudeDir, ORCH_PID_MARKER);
	return () => {
		const wrapperPid = readWrapperPid(pidFilePath);
		if (wrapperPid === null) return null;
		return resolveChildViaPs(wrapperPid);
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
 *   2. Resolves the orchestrator claude PID via ps ppid-walk (`ps -ax -o pid=,ppid=`
 *      filtered by ppid==wrapperPid). Immune to process-title rewriting (CAM-165).
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

	while (true) {
		// Check the context backstop first: if over the ceiling, arm the marker.
		// handleOneTick then sees the marker and fires SIGTERM via the existing
		// consume-once path (one unified signal route regardless of who armed it).
		checkBackstop(backstopDeps);
		handleOneTick(deps);
		sleepFn(pollIntervalMs);
	}
}
