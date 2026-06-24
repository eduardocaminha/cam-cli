// src/templates/frontmatter.ts
//
// Pure helper for rewriting the `model:` line inside a YAML frontmatter block.
// String-in / string-out: no filesystem access, fully unit-testable.
//
// Also exports the three project-local .claude/ runtime target paths whose
// model: line is rewritten by `mergeConfigChoices` on each `cam config` save.
// None of these paths is under templates/; templates/ holds the shipped defaults
// (owned by US-004) and is never touched by this module.

import { join } from 'node:path';

/**
 * Phase -> project-local runtime file path (relative to cwd) whose `model:`
 * frontmatter line is rewritten on `cam config` save.
 *
 * Only the three in-session phases that run as Task subagents or slash steps
 * are listed here: planner, auditor, ship. The implementer and reviewer run
 * as pane workers and receive --model from the supervisor argv, not via
 * frontmatter. The orchestrator is the root pane itself (no agent file).
 */
export const FRONTMATTER_TARGET_PHASE_PATHS: Record<string, string> = {
	planner: join('.claude', 'agents', 'subagent-planner.md'),
	auditor: join('.claude', 'agents', 'subagent-auditor.md'),
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
