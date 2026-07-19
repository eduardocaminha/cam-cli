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

import type { LlmPhase } from '../config/models.ts';

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

/**
 * Phase -> project-local runtime file path (relative to cwd) whose `effort:`
 * frontmatter line is rewritten on `cam config` save.
 *
 * Distinct from FRONTMATTER_TARGET_PHASE_PATHS: effort is a subagent-level
 * concept, so the targets are the 5 LLM-phase agent personas under
 * `.claude/agents/subagent-<phase>.md`, never `.claude/commands/cam-ship.md`.
 * `ship` is deterministic (zero LLM calls, ADR-0009) and has no effort
 * concept, so it is never a key here (mirrors LlmPhase = Exclude<Phase, 'ship'>).
 */
export const FRONTMATTER_TARGET_EFFORT_PATHS: Record<LlmPhase, string> = {
	orchestrator: join('.claude', 'agents', 'subagent-orchestrator.md'),
	planner: join('.claude', 'agents', 'subagent-planner.md'),
	auditor: join('.claude', 'agents', 'subagent-auditor.md'),
	implementer: join('.claude', 'agents', 'subagent-implementer.md'),
	reviewer: join('.claude', 'agents', 'subagent-reviewer.md'),
};

/**
 * Rewrites the `effort: <value>` line inside a YAML frontmatter block.
 * All other frontmatter keys and the document body are preserved byte-for-byte.
 *
 * Unlike rewriteFrontmatterModel, this ALSO inserts the `effort:` line when
 * absent (e.g. subagent-implementer.md ships with no effort: line today): the
 * new line is appended inside the frontmatter fence, immediately before the
 * closing `---`, never appended to the document body. If the content has no
 * frontmatter fence at all, the original string is returned unchanged.
 *
 * Uses a scoped regex, same rationale as rewriteFrontmatterModel: does NOT
 * parse YAML (js-yaml ESM-only v5 incompatibility, patterns.md: CAM-69 rule).
 */
export function rewriteFrontmatterEffort(content: string, newEffort: string): string {
	if (/^effort:\s*.+$/m.test(content)) {
		return content.replace(/^(effort:)\s*.+$/m, `$1 ${newEffort}`);
	}

	const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fenceMatch) return content;
	const frontmatterBody = fenceMatch[1] ?? '';
	const updatedFence = `---\n${frontmatterBody}\neffort: ${newEffort}\n---`;
	// Replacer function (not a replacement string): frontmatterBody may contain
	// literal `$`-sequences ($&, $1, $$) that String.prototype.replace would
	// otherwise reinterpret as special patterns if passed as the 2nd arg string.
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, () => updatedFence);
}

/**
 * Strips a leading YAML frontmatter fence (`---\n...\n---`), returning only
 * the document body. Used by CodexAdapter (US-001, CAM-350) to turn a
 * `.claude/agents/<name>.md` file into a codex `model_instructions_file`
 * payload: codex has no `--agent` analog (ADR-0047 mismatch d), so the agent
 * body itself is handed to codex as raw instructions text, with the
 * claude-specific frontmatter (name/description/tools/effort/color) stripped.
 *
 * Uses the same scoped fence regex as rewriteFrontmatterEffort: does NOT
 * parse YAML (js-yaml ESM-only v5 incompatibility, patterns.md: CAM-69 rule).
 * If the content has no frontmatter fence at all, it is returned unchanged.
 */
export function stripFrontmatter(content: string): string {
	const fenceMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (!fenceMatch) return content;
	return content.slice(fenceMatch[0].length);
}
