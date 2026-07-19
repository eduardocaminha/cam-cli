// src/logging/spawn-resolution.ts
//
// Pure structured emitter for cam-controlled spawns (US-007).
//
// Every cam spawn (orchestrator, implementer, reviewer) should call
// emitSpawnResolution immediately before the respawn-pane tmux call so the
// operator can audit exactly which {phase, model, backend} triple was resolved
// for each worker invocation.
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

/** Structured payload of a spawn-resolution event. */
export interface SpawnResolutionEvent {
	/** Which cam phase is being spawned (orchestrator, implementer, reviewer). */
	phase: string;
	/** Resolved model string (e.g. 'claude-sonnet-4-6'). */
	model: string;
	/** Resolved backend string (e.g. 'claude', 'codex'). */
	backend: string;
}

/**
 * Injectable event sink for spawn-resolution events.
 * Tests supply a capture function; production callers may write to a log file.
 */
export type SpawnEventWriter = (event: SpawnResolutionEvent) => void;

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** Options for emitSpawnResolution. */
export interface EmitSpawnResolutionOpts {
	/** The cam phase being spawned. */
	phase: string;
	/** Resolved model for this phase. */
	model: string;
	/** Resolved backend for this phase. */
	backend: string;
	/**
	 * Optional event sink. When provided, called with the structured event.
	 * When absent, the event is silently dropped.
	 */
	writeEvent?: SpawnEventWriter;
}

/**
 * Emit a structured {phase, model, backend} spawn-resolution event.
 */
export function emitSpawnResolution(opts: EmitSpawnResolutionOpts): void {
	const { phase, model, backend, writeEvent } = opts;

	// Emit the structured event (no-op when writer is absent).
	writeEvent?.({ phase, model, backend });
}
