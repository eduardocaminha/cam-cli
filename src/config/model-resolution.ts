// src/config/model-resolution.ts
//
// Backend-aware model resolution layer (US-003, CAM-398). `readPhaseModel`
// (src/config/models.ts) already resolves a *string* per phase+backend, but
// it has no notion of "is this string actually dispatchable on this
// backend": a claude tier alias (`opus`/`sonnet`) handed to codex's `-m`
// flag produces a live 400, and a mistyped claude model (`sonnett`) is
// happily returned verbatim and only fails once `claude --model` rejects it
// at spawn time. `resolvePhaseModel` is the single decision fn that turns
// (phase, backend) into either a concrete dispatchable model or an
// actionable abort, composed ON TOP of `readPhaseModel` (never reimplementing
// its fallback chain, which this story does not touch).
//
// Codex precedence (highest to lowest):
//   1. A nested `[models.codex].<phase>` pin: returned verbatim, no
//      claude-shape check (an explicit backend-scoped pin is trusted as-is).
//   2. A non-claude-shaped flat `[models].<phase>` value: returned verbatim.
//      A claude-shaped flat value (including the claude-tier `DEFAULTS`
//      fallback when nothing is configured at all) is NOT honored as a pin.
//   3. Cache auto-resolution: the injectable `cacheReader` (defaults to the
//      US-002 production `readCodexModelsCache`) picks the current top
//      available codex model slug.
//   4. Fail-closed abort: an actionable message naming the cache path and
//      the `[models.codex]` pin remedy.
//
// Claude precedence: the flat `[models].<phase>` value (or `DEFAULTS`) is
// validated with the STRICT `validateClaudeModel` typo-guard and returned
// verbatim when valid, else an actionable ok:false naming the offending
// value and the project.toml `[models]` key. The codex cache reader is
// never invoked on this path.
//
// The "is this flat value claude-shaped" decision on the codex path is the
// SAME `isClaudeAliasModel` superset predicate `codexAuthPreflight` already
// uses (src/supervisor/codex-auth.ts) -- see that module's doc comment for
// why it must never be merged with `validateClaudeModel`'s strict guard.

import { validateClaudeModel } from './claude-models.ts';
import { readCodexModelsCache } from './codex-models-cache.ts';
import type { CodexModelsCacheReader } from './codex-models-cache.ts';
import { readPhaseModel } from './models.ts';
import type { Phase } from './models.ts';
import { isClaudeAliasModel } from '../supervisor/codex-auth.ts';

/** Inputs to {@link resolvePhaseModel}. */
export interface ResolvePhaseModelOptions {
	/** The cam phase to resolve a dispatchable model for. */
	phase: Phase;
	/** The phase's already-resolved backend (e.g. from `readPhaseBackend`). */
	backend: string;
	/**
	 * Override the config file path (default: `scripts/cam/project.toml`
	 * resolved from `process.cwd()`). Used by tests to target a tmp fixture.
	 */
	configPath?: string;
	/**
	 * Injectable codex models-cache reader (DI seam). Defaults to
	 * {@link readCodexModelsCache} (the real `~/.codex/models_cache.json`
	 * reader) when omitted. Never invoked on the claude path, and never
	 * invoked on the codex path when a valid pin (nested or non-claude-shaped
	 * flat) is already found.
	 */
	cacheReader?: CodexModelsCacheReader;
}

/** Resolution succeeded: `model` is dispatchable verbatim. */
export interface ResolvePhaseModelOk {
	ok: true;
	model: string;
}

/** Resolution failed; `message` is actionable and safe to surface to the operator. */
export interface ResolvePhaseModelAbort {
	ok: false;
	message: string;
}

export type ResolvePhaseModelResult = ResolvePhaseModelOk | ResolvePhaseModelAbort;

/**
 * Resolve the claude-backend model: validate the flat `[models].<phase>`
 * value (or `DEFAULTS[phase]`) with the strict claude typo-guard. Never
 * touches the codex cache reader.
 */
function resolveClaudeModel(phase: Phase, configPath: string | undefined): ResolvePhaseModelResult {
	const model = readPhaseModel(phase, configPath);
	const validation = validateClaudeModel(model);
	if (validation.ok) {
		return { ok: true, model };
	}
	return {
		ok: false,
		message: `${validation.message}; check the project.toml [models].${phase} key`,
	};
}

/**
 * Resolve the codex-backend model per the precedence documented on this
 * module: nested pin > non-claude-shaped flat value > cache auto-resolution
 * > fail-closed abort.
 *
 * Distinguishing "the nested `[models.codex].<phase>` pin fired" from "we
 * fell through to the flat value" reuses `readPhaseModel` itself as the
 * discriminator (cheapest available: no second parse path to maintain): a
 * lookup WITH `backend: 'codex'` that differs from the same lookup WITHOUT a
 * backend means the nested table supplied the value; an equal result means
 * the flat table (or `DEFAULTS`) did.
 */
function resolveCodexModel(
	phase: Phase,
	configPath: string | undefined,
	cacheReader: CodexModelsCacheReader,
): ResolvePhaseModelResult {
	const withNested = readPhaseModel(phase, configPath, 'codex');
	const flatOnly = readPhaseModel(phase, configPath);
	const nestedPinFired = withNested !== flatOnly;

	if (nestedPinFired) {
		return { ok: true, model: withNested };
	}

	if (!isClaudeAliasModel(flatOnly)) {
		return { ok: true, model: flatOnly };
	}

	const selection = cacheReader();
	if (selection.ok) {
		return { ok: true, model: selection.slug };
	}

	return {
		ok: false,
		message:
			`no valid codex model pin for phase '${phase}' (flat/default value '${flatOnly}' is a claude ` +
			`tier alias, not a codex model), and the codex models cache could not be resolved ` +
			`(${selection.reason}); pin a model under [models.codex] in project.toml, or ensure ` +
			`~/.codex/models_cache.json is present and readable`,
	};
}

/**
 * Turn (phase, backend) into either a concrete dispatchable model or an
 * actionable abort. See the module doc comment for the full precedence
 * rules on each backend.
 */
export function resolvePhaseModel(opts: ResolvePhaseModelOptions): ResolvePhaseModelResult {
	const { phase, backend, configPath, cacheReader = readCodexModelsCache } = opts;

	if (backend !== 'codex') {
		return resolveClaudeModel(phase, configPath);
	}

	return resolveCodexModel(phase, configPath, cacheReader);
}
