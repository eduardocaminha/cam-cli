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
//   - Pure: no I/O beyond the injectable writeEvent/emitNotice seams.
//   - Codex guard: when backend === 'codex', a notice is emitted (to stderr
//     by default, to the injected emitNotice in tests). The guard is
//     INFORMATIONAL; it does not abort the spawn. CAM-54 will wire codex.
//   - The injectable seams (writeEvent, emitNotice) let unit tests collect
//     events in memory without touching the filesystem or stderr.
//   - writeEvent is optional: when absent the caller relies only on the codex
//     guard side-effect (useful for simple call-sites that do not inject a
//     logger yet). When a full event-log writer is desired, pass one.

import process from 'node:process';

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

/**
 * Injectable notice emitter for the codex guard.
 * Default: write to process.stderr. Tests supply a capture function.
 */
export type NoticeEmitter = (msg: string) => void;

// ---------------------------------------------------------------------------
// Guard notice constant
// ---------------------------------------------------------------------------

/**
 * Exact literal text emitted when backend === 'codex'.
 *
 * The codex backend is not yet wired (CAM-54). This notice exists so the loop
 * cannot silently degrade when codex is selected: the operator will see this
 * string in the supervisor stderr/log before the spawn proceeds.
 */
export const CODEX_GUARD_NOTICE = 'codex backend not yet wired (CAM-54)';

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
	 * Optional event sink. When provided, called with the structured event before
	 * the codex guard check. When absent, the event is silently dropped; only the
	 * codex guard side-effect fires (if applicable).
	 */
	writeEvent?: SpawnEventWriter;
	/**
	 * Optional notice emitter. When provided, used for the codex guard notice.
	 * When absent, defaults to writing to process.stderr.
	 */
	emitNotice?: NoticeEmitter;
}

/**
 * Emit a structured {phase, model, backend} spawn-resolution event and, when
 * backend === 'codex', emit the codex guard notice.
 *
 * The function always returns normally: the codex guard is informational and
 * does NOT abort the spawn. CAM-54 will wire the codex backend; until then
 * the notice informs the operator of the gap.
 */
export function emitSpawnResolution(opts: EmitSpawnResolutionOpts): void {
	const { phase, model, backend, writeEvent, emitNotice } = opts;

	// Emit the structured event (no-op when writer is absent).
	writeEvent?.({ phase, model, backend });

	// Codex guard: informational notice, never aborts.
	if (backend === 'codex') {
		(emitNotice ?? defaultNotice)(CODEX_GUARD_NOTICE);
	}
}

// ---------------------------------------------------------------------------
// Default notice emitter
// ---------------------------------------------------------------------------

function defaultNotice(msg: string): void {
	process.stderr.write(`[cam] ${msg}\n`);
}
