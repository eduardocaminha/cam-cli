// src/templates/frontmatter.ts
//
// Pure helper for rewriting the `model:` line inside a YAML frontmatter block.
// String-in / string-out: no filesystem access, fully unit-testable.
//
// Also exports the single project-local .claude/ runtime target path whose
// model: line is rewritten by `mergeConfigChoices` on each `cam config` save.
// This path is not under templates/; templates/ holds the shipped defaults
// (owned by US-004) and is never touched by this module.

import { join } from 'node:path';

/**
 * Phase -> project-local runtime file path (relative to cwd) whose `model:`
 * frontmatter line is rewritten on `cam config` save.
 *
 * Only `ship` is listed here: ship-runner is deterministic (zero LLM calls,
 * see src/supervisor/ship-runner.ts) so its model can never be passed via a
 * `--model` CLI flag the way every other phase's is -- cam-ship.md's
 * frontmatter is the sole documented source for the ship model. The other
 * in-session roles were removed from this map (US-003, CAM-286): all of them
 * actually run as pane workers spawned with `--model <readPhaseModel(phase)>`,
 * so rewriting their frontmatter was dead effort even before their `model:`
 * line was stripped entirely (US-002). Every non-ship role, including the
 * pane/root roles, takes its model from project.toml via --model and has no
 * frontmatter-sourced path at all.
 */
export const FRONTMATTER_TARGET_PHASE_PATHS: Record<string, string> = {
	ship: join('.claude', 'commands', 'cam-ship.md'),
};

/**
 * Rewrites the `model: <value>` line inside a YAML frontmatter block.
 * All other frontmatter keys and the document body are preserved byte-for-byte.
 * If the content contains no `model:` line, the original string is returned
 * unchanged (no error is thrown).
 *
 * Uses a scoped regex over the model: line; does NOT parse YAML (avoiding the
 * js-yaml ESM-only v5 incompatibility documented in patterns.md: CAM-69 rule).
 */
export function rewriteFrontmatterModel(content: string, newModel: string): string {
	return content.replace(/^(model:)\s*.+$/m, `$1 ${newModel}`);
}
