// Forked from jayminwest/overstory@main (MIT). See LICENSE-OVERSTORY.md.
// Minimal type stubs to support the visual-identity primitives forked in US-004.
// These types will be extended (or replaced) as later stories (US-005+) define
// the real ralph-cli domain (stories, iterations, plugin state).

/**
 * Agent execution state. Used by the state-color/icon palette in `theme.ts`.
 * Mirrored verbatim from jayminwest/overstory@main:src/types.ts.
 */
export type AgentState = "working" | "booting" | "stalled" | "zombie" | "completed";

/**
 * Event type label catalog. Used by the event-label palette in `theme.ts`.
 * Mirrored verbatim from jayminwest/overstory@main:src/types.ts so the
 * forked code can be diffed cleanly. Some entries (mail_*, spawn) are
 * Overstory-specific and may be pruned in a later "simplify" pass.
 */
export type EventType =
	| "tool_start"
	| "tool_end"
	| "session_start"
	| "session_end"
	| "mail_sent"
	| "mail_received"
	| "spawn"
	| "error"
	| "custom"
	| "turn_start"
	| "turn_end"
	| "progress"
	| "result";

/**
 * Stub StoredEvent — the minimum shape required by `format.ts` helpers.
 * Real ralph-cli events will be defined in a later story; this stub keeps
 * the forked formatters typecheckable in isolation.
 */
export interface StoredEvent {
	createdAt: string;
	eventType: EventType;
	storyId: string;
	level?: "debug" | "info" | "warn" | "error";
	toolName?: string;
	toolArgs?: string;
	toolDurationMs?: number | null;
	data?: string;
}
