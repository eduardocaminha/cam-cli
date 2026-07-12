// src/orchestrator/context-window.ts
//
// Pure config/decision layer for context window sizing and the orchestrator
// backstop fraction. No cumulative token accounting happens here (that lives
// in budget.ts / transcript/usage.ts). This module only names constants and
// provides a deterministic decision function.

import { readOrchContextWindow } from '../config/models.ts';

/**
 * Default fraction of the context window at which the orchestrator recycle
 * watcher should trigger a backstop. A value of 0.8 means the watcher fires
 * when occupancy exceeds 80% of the configured window.
 *
 * No operator override is in scope for this constant; tightening or relaxing
 * the fraction is a future-story concern.
 */
export const ORCH_CONTEXT_BACKSTOP_FRACTION = 0.8;

/**
 * Resolve the context window size (in tokens) for the orchestrator.
 *
 * Reads `[loop] orch_context_window` via `readOrchContextWindow(configPath)`,
 * which defaults to 200000 (the real Claude Code flat-subscription window)
 * when the value is absent, malformed, non-integer, or <= 0. The 1M window is
 * an API/Bedrock/Vertex credit-billed feature, not available on the standard
 * subscription this orchestrator runs under, so it is never assumed here.
 *
 * **Never throws**: falls back to the 200000 default on every error path,
 * mirroring the defensive contract of `readOrchContextWindow`.
 *
 * @param configPath  Optional override for the project config path (used by
 *                    tests to avoid touching the real `project.toml`).
 */
export function orchestratorContextWindow(configPath?: string): number {
	return readOrchContextWindow(configPath);
}

/**
 * Return `true` iff `occupancy` exceeds the backstop threshold.
 *
 * The threshold is `window * fraction`. The boundary case (occupancy ===
 * window * fraction) is NOT over the backstop: the condition is strictly
 * greater than, so a session exactly at 80% capacity continues without
 * recycling.
 *
 * @param occupancy  Current context occupancy in tokens (from the last
 *                   request's `input_tokens` + cache tokens).
 * @param window     The model's declared context window in tokens.
 * @param fraction   The backstop fraction (default: ORCH_CONTEXT_BACKSTOP_FRACTION).
 */
export function isOverContextBackstop(
	occupancy: number,
	window: number,
	fraction: number = ORCH_CONTEXT_BACKSTOP_FRACTION,
): boolean {
	return occupancy > window * fraction;
}
