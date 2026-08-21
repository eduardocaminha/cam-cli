// src/runtime/model-settings.ts
//
// Gateship's own model and reasoning-effort choice, one slot per (provider,
// role) pair for the three roles that call a model: orchestrator, executor and
// reviewer.
//
// A slot carries opaque argv elements. Gateship does not know the list of model
// names or effort levels -- that list belongs to each CLI and changes without
// Gateship -- so only the SHAPE is validated: a non-empty token with no
// whitespace, which argv can carry as a single element. An unknown value
// therefore reaches the CLI and is refused by the CLI's own error, and the
// screen suggests known values without restricting them.
//
// An empty slot pushes no flag at all, which is exactly the behaviour the
// runtime had before this setting existed.

import type { AgentProviderId } from './agent-session.ts';

/** The three roles that spawn a model-backed session. */
export const MODEL_ROLES = ['orchestrator', 'executor', 'reviewer'] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export const MODEL_PROVIDERS: readonly AgentProviderId[] = ['claude', 'codex'];

/** Single `runtime_settings` row holding the whole per-role choice as JSON. */
export const MODEL_SETTINGS_KEY = 'model-settings';

export interface ModelSlot {
	model?: string;
	effort?: string;
}

export type ModelSettings = Record<AgentProviderId, Record<ModelRole, ModelSlot>>;

/**
 * Read at every spawn instead of at boot, so changing the setting in Ajustes
 * takes effect on the next child without restarting the service.
 */
export type ModelSlotResolver = () => ModelSlot;

export interface ModelSlotOptions {
	model?: string;
	effort?: string;
	resolveModel?: ModelSlotResolver;
}

export function isModelRole(value: unknown): value is ModelRole {
	return MODEL_ROLES.some((role) => role === value);
}

export function isModelProvider(value: unknown): value is AgentProviderId {
	return MODEL_PROVIDERS.some((provider) => provider === value);
}

/** Form only: a non-empty token argv can carry as one element. */
export function isModelToken(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

export function emptyModelSettings(): ModelSettings {
	return {
		claude: { orchestrator: {}, executor: {}, reviewer: {} },
		codex: { orchestrator: {}, executor: {}, reviewer: {} },
	};
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function decodeToken(value: unknown): string | undefined {
	const trimmed = typeof value === 'string' ? value.trim() : '';
	return isModelToken(trimmed) ? trimmed : undefined;
}

function decodeSlot(value: unknown): ModelSlot {
	const record = recordOf(value);
	if (record === null) return {};
	const model = decodeToken(record['model']);
	const effort = decodeToken(record['effort']);
	return {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
	};
}

/**
 * Accepts any shape; anything unusable degrades to an empty slot. The stored
 * row is read defensively here, while the HTTP write path refuses a malformed
 * value instead of guessing at it.
 */
export function normalizeModelSettings(value: unknown): ModelSettings {
	const settings = emptyModelSettings();
	const record = recordOf(value);
	if (record === null) return settings;
	for (const provider of MODEL_PROVIDERS) {
		const roles = recordOf(record[provider]);
		if (roles === null) continue;
		for (const role of MODEL_ROLES) settings[provider][role] = decodeSlot(roles[role]);
	}
	return settings;
}

/**
 * The pair one spawn will use. The resolver wins over the option an adapter was
 * constructed with, so the operator's choice overrides an injected default and
 * an unset choice preserves it.
 */
export function resolveModelSlot(options: ModelSlotOptions): ModelSlot {
	const configured = options.resolveModel?.() ?? {};
	const model = isModelToken(configured.model) ? configured.model : options.model;
	const effort = isModelToken(configured.effort) ? configured.effort : options.effort;
	return {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
	};
}

/** Claude names both flags; an unset slot contributes nothing to the argv. */
export function claudeModelArgv(slot: ModelSlot): string[] {
	return [
		...(slot.model === undefined ? [] : ['--model', slot.model]),
		...(slot.effort === undefined ? [] : ['--effort', slot.effort]),
	];
}

/** Codex takes the model as `-m` and the effort as a config override. */
export function codexModelArgv(slot: ModelSlot): string[] {
	return [
		...(slot.model === undefined ? [] : ['-m', slot.model]),
		...(slot.effort === undefined ? [] : ['-c', `model_reasoning_effort="${slot.effort}"`]),
	];
}

/**
 * Record the resolved pair on the run's spawn, so the history shows which model
 * did which work without a new column. An empty slot emits nothing: the CLI
 * default ran, Gateship does not know its name, and the run reads exactly as it
 * did before this setting existed.
 */
export function emitModelSelection(
	emit: (kind: string, payload?: Record<string, unknown>) => void,
	eventPrefix: string,
	slot: ModelSlot,
): void {
	if (slot.model === undefined && slot.effort === undefined) return;
	emit(`${eventPrefix}.model`, {
		...(slot.model === undefined ? {} : { model: slot.model }),
		...(slot.effort === undefined ? {} : { effort: slot.effort }),
	});
}

/**
 * GSHIP-620: at save time, one short read-only turn asks the provider's own
 * CLI whether it accepts the chosen model and effort, instead of Gateship
 * keeping a catalog of valid names.
 */
export type ModelProbeOutcome = 'accepted' | 'refused' | 'inconclusive';

export interface ModelProbeResult {
	outcome: ModelProbeOutcome;
	/** The CLI's own refusal text, or why the probe could not conclude. Absent when accepted. */
	message?: string;
}

/** Trivial: only the chosen model/effort combination is under test, not reasoning. */
export const MODEL_PROBE_PROMPT = 'Respond with only "ok".';

/** Short enough that a save never feels stuck; long enough for a real turn to answer. */
export const MODEL_PROBE_TIMEOUT_MS = 15_000;

export interface ModelSlotKey {
	provider: AgentProviderId;
	role: ModelRole;
}

/**
 * Only the slots whose model or effort actually differ between what is stored
 * and what is being written. Saving one field must not probe the other five:
 * each probe spawns a whole CLI process just to validate one choice.
 */
export function changedModelSlots(previous: ModelSettings, next: ModelSettings): ModelSlotKey[] {
	const changed: ModelSlotKey[] = [];
	for (const provider of MODEL_PROVIDERS) {
		for (const role of MODEL_ROLES) {
			const before = previous[provider][role];
			const after = next[provider][role];
			if (before.model !== after.model || before.effort !== after.effort) {
				changed.push({ provider, role });
			}
		}
	}
	return changed;
}
