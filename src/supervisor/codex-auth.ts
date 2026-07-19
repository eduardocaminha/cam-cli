// src/supervisor/codex-auth.ts
//
// Fail-closed codex auth preflight (US-001, CAM-352). Sibling to
// backend-adapter.ts: this module decides whether a codex-backed dispatch may
// proceed, BEFORE any argv is built or any process is spawned, so an
// unauthenticated (or misconfigured) codex dispatch is aborted early and
// actionably instead of surfacing as opaque 401/400 noise from the spawned
// `codex exec` process.
//
// Two exports:
//   - codexAuthCheck (default production check): a synchronous point-read of
//     `~/.codex/auth.json` presence. See its own doc comment for the exact
//     limitation this implies.
//   - codexAuthPreflight: the pure decision fn. Takes the auth-check as an
//     injectable DI seam so tests never spawn or probe the real codex binary.
//
// This story only builds the check + decision fn and retires the old
// informational-only CODEX_GUARD_NOTICE (src/logging/spawn-resolution.ts).
// Wiring codexAuthPreflight into the actual dispatch call sites is US-002
// (the 3 supervisor worker-dispatch sites) and US-003 (the run.ts
// orchestrator dispatch site).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Auth-check seam
// ---------------------------------------------------------------------------

/** Result of a codex auth-check. */
export interface CodexAuthCheckResult {
	/** Whether codex appears to be authenticated. */
	authenticated: boolean;
}

/** Injectable auth-check function (DI seam for codexAuthPreflight). */
export type CodexAuthCheck = () => CodexAuthCheckResult;

/**
 * Default production auth-check: does `~/.codex/auth.json` exist?
 *
 * Codex authenticates via ChatGPT login, which writes credentials to
 * `~/.codex/auth.json`; there is no env var equivalent to Claude Code's
 * `CLAUDE_CODE_OAUTH_TOKEN` (deliberately NOT checking OPENAI_API_KEY /
 * CODEX_API_KEY / CODEX_ACCESS_TOKEN here — those are unrelated to the
 * ChatGPT-login flow codex actually uses).
 *
 * LIMITATION (documented, not a bug): this is a presence check, not a
 * validity check. It detects the never-logged-in case (no file at all) but
 * does NOT detect an expired-but-present token — `codex login status`
 * itself reports "Logged in" even when the token inside auth.json has
 * expired, so a presence check is exactly as strong as that status command
 * and no stronger. Do not extend this function to claim expiry-detection
 * without actually parsing and validating the token.
 *
 * Synchronous `existsSync` is a deliberate point-read (curated invariant:
 * the Bun-only rule carves out `node:fs` sync reads for this shape).
 */
export function codexAuthCheck(): CodexAuthCheckResult {
	const authPath = join(homedir(), '.codex', 'auth.json');
	return { authenticated: existsSync(authPath) };
}

// ---------------------------------------------------------------------------
// Claude-alias model guard
// ---------------------------------------------------------------------------

/**
 * Matches a bare or dashed claude tier alias (opus/sonnet/haiku) anywhere in
 * a model string, case-insensitive, as a whole word. Catches both the bare
 * default project.toml values (`"opus"`, `"sonnet"`) and dated/prefixed
 * variants (`"claude-opus-4-8"`), which is exactly the shape that produced
 * the live 400 this preflight exists to prevent: codex's `-m` flag rejects
 * these claude-only model names outright.
 */
const CLAUDE_ALIAS_MODEL_RE = /\b(opus|sonnet|haiku)\b/i;

/** True when `model` is an obviously-claude tier alias, never a valid codex model id. */
function isClaudeAliasModel(model: string): boolean {
	return CLAUDE_ALIAS_MODEL_RE.test(model);
}

// ---------------------------------------------------------------------------
// Decision fn
// ---------------------------------------------------------------------------

/** Inputs to {@link codexAuthPreflight}. */
export interface CodexAuthPreflightOptions {
	/** Resolved backend for this dispatch (e.g. 'claude', 'codex'). */
	backend: string;
	/** Resolved model for this dispatch. */
	model: string;
	/**
	 * Injectable auth-check (DI seam). Defaults to {@link codexAuthCheck}
	 * (real `~/.codex/auth.json` presence read) when omitted.
	 */
	authCheck?: CodexAuthCheck;
}

/** The dispatch may proceed. */
export interface CodexAuthPreflightProceed {
	proceed: true;
}

/** The dispatch must be aborted; `message` is actionable and safe to surface to the operator. */
export interface CodexAuthPreflightAbort {
	proceed: false;
	message: string;
}

export type CodexAuthPreflightResult = CodexAuthPreflightProceed | CodexAuthPreflightAbort;

/**
 * Fail-closed codex auth preflight decision fn.
 *
 * - backend !== 'codex': always proceeds, and never invokes `authCheck`
 *   (the claude path does no codex-auth work at all).
 * - backend === 'codex' with an obviously-claude model alias
 *   (opus/sonnet/haiku): aborts immediately, before invoking `authCheck` --
 *   this is a static argv-shape problem, not an auth problem, and is exactly
 *   the live 400 this preflight exists to prevent.
 * - backend === 'codex' with a codex-shaped model: invokes `authCheck`
 *   (default {@link codexAuthCheck} when not injected) and aborts with an
 *   actionable `codex login` message when unauthenticated, else proceeds.
 */
export function codexAuthPreflight(opts: CodexAuthPreflightOptions): CodexAuthPreflightResult {
	const { backend, model, authCheck = codexAuthCheck } = opts;

	if (backend !== 'codex') {
		return { proceed: true };
	}

	if (isClaudeAliasModel(model)) {
		return {
			proceed: false,
			message:
				`codex backend selected but model '${model}' is a claude-only tier alias ` +
				`(opus/sonnet/haiku); set a codex-compatible model in project.toml [models] ` +
				`before retrying`,
		};
	}

	const { authenticated } = authCheck();
	if (!authenticated) {
		return {
			proceed: false,
			message: 'codex is not authenticated; run `codex login` to authenticate before retrying',
		};
	}

	return { proceed: true };
}
