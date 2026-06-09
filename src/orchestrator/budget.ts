// src/orchestrator/budget.ts
//
// CAM-23 US-001: orchestrator token-budget check.
//
// The orchestrator is the long-lived human-facing claude session spawned by
// `cam run`. As it accumulates context it approaches Claude's silent
// auto-compaction threshold. CAM-23's strategy is a CONTROLLED self-handoff: the
// orchestrator watches its own token spend and, when it crosses a configurable
// budget, writes a handoff and respawns fresh (US-002 / US-003 / US-004) instead
// of relying on silent compaction.
//
// This module is the pure, injectable core: given a way to read the orchestrator
// transcript plus the resolved threshold inputs, it returns the current spend and
// whether the budget is exceeded. It reuses CAM-21's `parseTranscriptUsage` and
// never reinvents token counting. All I/O (transcript read, env, toml) is injected
// so tests never touch the real `~/.claude` or `process.env`.

import { parseTranscriptUsage } from '../transcript/usage.ts';

/** Default orchestrator token budget when neither env nor project.toml overrides it. */
export const DEFAULT_ORCH_TOKEN_BUDGET = 100_000;

/** Result of an orchestrator budget check. */
export interface OrchBudget {
	/** Total in-flow tokens spent so far: input + cacheCreation + cacheRead. */
	spend: number;
	/** The resolved budget threshold (env > toml > default). */
	threshold: number;
	/** True when spend >= threshold (time to hand off). */
	overBudget: boolean;
}

/** Injected inputs for {@link computeOrchBudget}. */
export interface ComputeOrchBudgetOptions {
	/**
	 * Reads the orchestrator transcript JSONL. Returns null when there is no
	 * `.cam-orch-session` marker or no transcript file yet (treated as 0 spend).
	 */
	readTranscript: () => string | null;
	/** Raw `CAM_ORCH_TOKEN_BUDGET` env value (string | undefined). Wins over toml. */
	envBudget?: string | undefined;
	/** `[orchestrator] token_budget` from project.toml (number | undefined). Wins over default. */
	tomlBudget?: number | undefined;
}

/**
 * Resolve the budget threshold with precedence env > toml > default. Non-finite
 * or non-positive overrides are ignored (fall through to the next source) so a
 * garbled `CAM_ORCH_TOKEN_BUDGET=abc` cannot silently disable the budget.
 */
export function resolveOrchThreshold(
	envBudget: string | undefined,
	tomlBudget: number | undefined,
): number {
	if (envBudget !== undefined && envBudget.trim() !== '') {
		const n = Number(envBudget);
		if (Number.isFinite(n) && n > 0) return Math.floor(n);
	}
	if (tomlBudget !== undefined && Number.isFinite(tomlBudget) && tomlBudget > 0) {
		return Math.floor(tomlBudget);
	}
	return DEFAULT_ORCH_TOKEN_BUDGET;
}

/**
 * Compute the orchestrator's current token spend and whether it is at/over the
 * resolved budget. Pure over its injected inputs.
 */
export function computeOrchBudget(opts: ComputeOrchBudgetOptions): OrchBudget {
	const threshold = resolveOrchThreshold(opts.envBudget, opts.tomlBudget);

	const jsonl = opts.readTranscript();
	let spend = 0;
	if (jsonl !== null && jsonl.length > 0) {
		const usage = parseTranscriptUsage(jsonl);
		spend = usage.input + usage.cacheCreation + usage.cacheRead;
	}

	return { spend, threshold, overBudget: spend >= threshold };
}
