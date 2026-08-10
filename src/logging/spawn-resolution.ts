// src/logging/spawn-resolution.ts
//
// Pure structured emitter for cam-controlled spawns (US-007).
//
// Every cam spawn (orchestrator, implementer, reviewer) should call
// emitSpawnResolution immediately before the respawn-pane tmux call so the
// operator can audit exactly which {phase, model, backend} triple was resolved
// for each worker invocation. A structural fail-close that happens after
// backend resolution but before model resolution may instead record
// {phase, model: null, backend, blockedReason}; this keeps the audit trail
// truthful without making an irrelevant model/cache lookup a prerequisite.
//
// Design decisions:
//   - Pure: no I/O beyond the injectable writeEvent seam.
//   - The injectable seam (writeEvent) lets unit tests collect events in
//     memory without touching the filesystem.
//   - writeEvent is optional: when absent the caller silently drops the
//     event (useful for simple call-sites that do not inject a logger yet).
//     When a full event-log writer is desired, pass one.
//
// US-001 (CAM-352) retired the codex-backend informational guard notice this
// module used to emit (`CODEX_GUARD_NOTICE`, 'codex backend not yet wired
// (CAM-54)'): codex is now actually wired (CAM-350), and a fail-closed
// preflight (src/supervisor/codex-auth.ts) supersedes the old
// informational-only notice at the actual dispatch call sites.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured payload for a dispatch whose model and backend both resolved. */
export interface ResolvedSpawnResolutionEvent {
	/** Which cam phase is being spawned (orchestrator, implementer, reviewer). */
	phase: string;
	/** Resolved model string (e.g. 'claude-sonnet-4-6'). */
	model: string;
	/** Resolved backend string (e.g. 'claude', 'codex'). */
	backend: string;
	/**
	 * Resolved effort tier (e.g. 'xhigh', 'high'). Optional (US-001, CAM-425):
	 * pre-existing call sites (run.ts, loop.ts, review.ts, plan-runner.ts) do
	 * not resolve an effort and omit this field; `cam orch-resolve` is the
	 * first caller to populate it.
	 */
	effort?: string;
	/** Present only on a structural block that precedes model resolution. */
	blockedReason?: never;
}

/** Structured payload for a structural block that deliberately skips model resolution. */
export interface BlockedSpawnResolutionEvent {
	/** Which cam phase would have been spawned. */
	phase: string;
	/** No model was resolved because a prior structural guard failed. */
	model: null;
	/** Backend resolved before the structural guard fired. */
	backend: string;
	/** Stable machine-readable reason for skipping model resolution and dispatch. */
	blockedReason: string;
	/** Effort is not resolved for a blocked dispatch. */
	effort?: never;
}

/** Structured payload of a successful or structurally blocked spawn-resolution audit event. */
export type SpawnResolutionEvent = ResolvedSpawnResolutionEvent | BlockedSpawnResolutionEvent;

/**
 * Injectable event sink for spawn-resolution events.
 * Tests supply a capture function; production callers may write to a log file.
 */
export type SpawnEventWriter = (event: SpawnResolutionEvent) => void;

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** Fields shared by resolved and structurally blocked spawn-resolution events. */
interface EmitSpawnResolutionBaseOpts {
	/** The cam phase being spawned. */
	phase: string;
	/** Resolved backend for this phase. */
	backend: string;
	/**
	 * Optional event sink. When provided, called with the structured event.
	 * When absent, the event is silently dropped.
	 */
	writeEvent?: SpawnEventWriter;
}

/** Options for a normal dispatch with a resolved model. */
export interface EmitResolvedSpawnResolutionOpts extends EmitSpawnResolutionBaseOpts {
	/** Resolved model for this phase. */
	model: string;
	/** Resolved effort tier for this phase (US-001, CAM-425). Optional. */
	effort?: string;
	/** Present only on a structural block that precedes model resolution. */
	blockedReason?: never;
}

/** Options for a structural fail-close that deliberately precedes model resolution. */
export interface EmitBlockedSpawnResolutionOpts extends EmitSpawnResolutionBaseOpts {
	/** No model was resolved because the structural guard failed first. */
	model: null;
	/** Stable machine-readable reason for the structural block. */
	blockedReason: string;
	/** Effort is not resolved for a blocked dispatch. */
	effort?: never;
}

/** Options for emitSpawnResolution. */
export type EmitSpawnResolutionOpts = EmitResolvedSpawnResolutionOpts | EmitBlockedSpawnResolutionOpts;

/**
 * Emit a structured {phase, model, backend[, effort]} spawn-resolution event.
 */
export function emitSpawnResolution(opts: EmitSpawnResolutionOpts): void {
	if (opts.model === null) {
		const { phase, model, backend, blockedReason, writeEvent } = opts;
		writeEvent?.({ phase, model, backend, blockedReason });
		return;
	}

	const { phase, model, backend, effort, writeEvent } = opts;

	// Emit the structured event (no-op when writer is absent). `effort` is
	// only included when the caller resolved one (US-001, CAM-425); existing
	// call sites that pass no `effort` keep emitting the pre-existing
	// {phase, model, backend} shape byte-for-byte.
	writeEvent?.(effort !== undefined ? { phase, model, backend, effort } : { phase, model, backend });
}
