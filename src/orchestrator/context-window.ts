// src/orchestrator/context-window.ts
//
// Pure config/decision layer for context window sizing and the orchestrator
// backstop fraction. No cumulative token accounting happens here (that lives
// in budget.ts / transcript/usage.ts). This module only names constants and
// provides a deterministic decision function.

import { readPhaseModel } from '../config/models.ts';

/**
 * Context window (in tokens) for the current Claude Opus 4.x generation
 * (claude-opus-4-6 and later, including claude-opus-4-8).
 *
 * Per Anthropic docs (2026-07-03): claude-opus-4-6, 4-7, and 4-8 each
 * expose a 1M token context window. Earlier Opus variants (4-1, 4-5) had
 * a 200k window; those are listed explicitly in MODEL_CONTEXT_WINDOWS.
 */
export const OPUS_CONTEXT_WINDOW = 1_000_000;

/**
 * Default fraction of the context window at which the orchestrator recycle
 * watcher should trigger a backstop. A value of 0.8 means the watcher fires
 * when occupancy exceeds 80% of the model's declared window.
 *
 * No operator override is in scope for this constant; tightening or relaxing
 * the fraction is a future-story concern.
 */
export const ORCH_CONTEXT_BACKSTOP_FRACTION = 0.8;

/**
 * Model-to-context-window mapping. Keyed by model identifier prefix.
 *
 * Per Anthropic docs (2026-07-03):
 *   1M token models: claude-opus-4-6+, claude-sonnet-4-6+, claude-sonnet-5,
 *                    claude-fable-5, claude-mythos-5.
 *   200k token models: claude-opus-4-1, claude-opus-4-5, claude-sonnet-4-5,
 *                      claude-haiku-4-5, claude-3-* generation.
 *
 * Entries are checked in order; first prefix match wins. Unknown/future models
 * fall back to OPUS_CONTEXT_WINDOW (1M). The mapping uses prefixes long enough
 * to distinguish within-generation variants (e.g. opus-4-1 vs opus-4-6).
 */
const MODEL_CONTEXT_WINDOWS: Array<{ prefix: string; window: number }> = [
	// 200k models: older opus 4.x (must be listed before the generic opus-4 fallback)
	{ prefix: 'claude-opus-4-1', window: 200_000 },
	{ prefix: 'claude-opus-4-5', window: 200_000 },
	// 200k models: haiku and older sonnet
	{ prefix: 'claude-sonnet-4-5', window: 200_000 },
	{ prefix: 'claude-haiku-4-5', window: 200_000 },
	{ prefix: 'claude-haiku-4', window: 200_000 },
	{ prefix: 'claude-3', window: 200_000 },
	// 1M models: current generation opus 4.x (4-6, 4-7, 4-8, ...)
	{ prefix: 'claude-opus-4', window: OPUS_CONTEXT_WINDOW },
	// 1M models: current generation sonnet and beyond
	{ prefix: 'claude-sonnet-4', window: OPUS_CONTEXT_WINDOW },
	{ prefix: 'claude-sonnet-5', window: OPUS_CONTEXT_WINDOW },
	{ prefix: 'claude-fable-5', window: OPUS_CONTEXT_WINDOW },
	{ prefix: 'claude-mythos-5', window: OPUS_CONTEXT_WINDOW },
];

/**
 * Resolve the context window size (in tokens) for the configured orchestrator
 * model. Reads the model via `readPhaseModel('orchestrator', configPath)`,
 * matches it against the known model-to-window map, and returns the
 * corresponding window size.
 *
 * **Never throws**: an unknown or absent model falls back to
 * `OPUS_CONTEXT_WINDOW` (200k), mirroring the defensive contract of
 * `readPhaseModel`.
 *
 * @param configPath  Optional override for the project config path (used by
 *                    tests to avoid touching the real `project.toml`).
 */
export function orchestratorContextWindow(configPath?: string): number {
	const model = readPhaseModel('orchestrator', configPath);
	for (const entry of MODEL_CONTEXT_WINDOWS) {
		if (model.startsWith(entry.prefix)) {
			return entry.window;
		}
	}
	// Unknown model: fall back to the Opus window (never throws).
	return OPUS_CONTEXT_WINDOW;
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
