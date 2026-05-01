/**
 * Agent execution state. Used by the state-color/icon palette in `theme.ts`.
 */
export type AgentState = "working" | "booting" | "stalled" | "zombie" | "completed";

/**
 * Event type label catalog. Used by the event-label palette in `theme.ts`.
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
 * StoredEvent — the minimum shape required by `format.ts` helpers.
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
