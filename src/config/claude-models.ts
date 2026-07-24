// src/config/claude-models.ts
//
// Canonical claude model vocabulary (US-001, CAM-398). Single doc-verified
// source of truth for what counts as a valid claude model, so the
// claude-backend typo-guard (validateClaudeModel) and the codex flat-pin
// "claude-shaped" decision (isClaudeAliasModel, src/supervisor/codex-auth.ts)
// can never silently disagree about what a claude model looks like.
//
// Doc-verified against the Claude Code model-config doc (Step 5.5,
// https://code.claude.com/docs/en/model-config, fetched 2026-07-23):
// the "Model aliases" table lists default/best/fable/sonnet/opus/haiku/
// sonnet[1m]/opus[1m]/opusplan (9 values); the "opusplan model setting"
// section documents `opusplan[1m]` as a settable value ("To force 1M
// context for both phases ... set the model to opusplan[1m]"), so the
// 10th value is included here too -- omitting it would fail-close a
// documented-valid config.
//
// Non-UI module: no ink/react import here. src/ui/ConfigScreen.tsx's
// MODEL_OPTIONS (a subset used for the interactive picker) is checked
// against this list by a drift guard in test/config/claude-models.test.ts,
// never the other way around.

/** The ten doc-verified claude model alias values (see module doc comment). */
export const CLAUDE_MODEL_ALIASES = [
	'default',
	'best',
	'fable',
	'opus',
	'sonnet',
	'haiku',
	'opusplan',
	'sonnet[1m]',
	'opus[1m]',
	'opusplan[1m]',
] as const;

export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

const CLAUDE_MODEL_ALIAS_SET: ReadonlySet<string> = new Set(CLAUDE_MODEL_ALIASES);

/** Matches any full claude model name, e.g. `claude-opus-4-8`. */
const CLAUDE_FULL_NAME_RE = /^claude-/;

/** Result of {@link validateClaudeModel}. */
export type ClaudeModelValidation = { ok: true } | { ok: false; message: string };

/**
 * STRICT typo-guard predicate for the claude backend.
 *
 * `ok` for every {@link CLAUDE_MODEL_ALIASES} member (exact membership,
 * never substring matching) and for any `claude-`-prefixed full model name.
 * `not-ok` otherwise, with a message naming the offending value -- this
 * catches typos (`sonnett`), foreign model names (`gpt-5.6-sol`), and
 * plausible-looking-but-invalid dashed forms (`sonnet-4-5`, which is not a
 * recognized alias or a `claude-`-prefixed full name).
 */
export function validateClaudeModel(model: string): ClaudeModelValidation {
	if (CLAUDE_MODEL_ALIAS_SET.has(model) || CLAUDE_FULL_NAME_RE.test(model)) {
		return { ok: true };
	}
	return {
		ok: false,
		message: `'${model}' is not a recognized claude model (expected one of ${CLAUDE_MODEL_ALIASES.join(', ')}, or a claude-* full name)`,
	};
}
