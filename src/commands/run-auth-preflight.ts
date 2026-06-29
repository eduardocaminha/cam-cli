// src/commands/run-auth-preflight.ts
//
// Fast non-interactive preflight that confirms the operator is logged in to
// Claude Code before `cam run` starts the orchestrator session (US-001, CAM-82).
//
// Extracted to a sibling module so src/commands/run.ts stays within its
// file-size budget. Consumers import via run.ts (which re-exports).

import type { SpawnFn } from '../tmux/session.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Successful auth probe result.
 * `subscriptionType` is surfaced informational-only; it is NEVER a hard gate.
 */
export interface ClaudeAuthOk {
	ok: true;
	/** Informational only. Any value (including undefined) passes the gate. */
	subscriptionType: string | undefined;
	message: string;
}

/** Auth probe failure — carries a human-readable actionable message. */
export interface ClaudeAuthFail {
	ok: false;
	message: string;
}

/** Discriminated union returned by {@link checkClaudeAuth}. */
export type ClaudeAuthResult = ClaudeAuthOk | ClaudeAuthFail;

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/**
 * Parse the raw stdout string from `claude auth status --json`.
 * Returns `null` when parsing fails or the JSON is not a plain object.
 * Extracted so the main function stays within the cognitive complexity limit.
 */
function parseAuthJson(raw: string): { loggedIn: unknown; subscriptionType: unknown } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const p = parsed as Record<string, unknown>;
	return { loggedIn: p['loggedIn'], subscriptionType: p['subscriptionType'] };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Fast non-interactive preflight that confirms the operator is logged in to
 * Claude Code. Accepts an injectable SpawnFn so tests can assert behaviour
 * without spawning a real `claude` process.
 *
 * Hard gate: `loggedIn === true` parsed from the JSON stdout of
 * `claude auth status --json`.
 * `subscriptionType` is surfaced informational-only, never a gate.
 * Fail-closed: if login cannot be confirmed for ANY reason, returns fail.
 *
 * Must NOT use `claude -p` (subscription rule, CAM-42) or `claude --version`
 * (does not check auth). Uses `claude auth status --json` only.
 *
 * JSON shape verified live (claude 2.1.195+):
 *   { loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType }
 */
export function checkClaudeAuth(spawnFn: SpawnFn): ClaudeAuthResult {
	let result: ReturnType<SpawnFn>;
	try {
		result = spawnFn('claude', ['auth', 'status', '--json'], { stdio: 'pipe' });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			message: `claude auth probe failed (spawn error: ${msg}); run \`claude auth login\` to authenticate`,
		};
	}

	// spawnSync sets result.error on ENOENT (claude not on PATH) without throwing.
	if (result.error != null) {
		return {
			ok: false,
			message: "claude not found on PATH; install Claude Code and run `claude auth login`",
		};
	}

	if ((result.status ?? 1) !== 0) {
		return {
			ok: false,
			message: 'claude auth status exited non-zero; run `claude auth login` to authenticate',
		};
	}

	const stdoutRaw = result.stdout;
	const raw = Buffer.isBuffer(stdoutRaw) ? stdoutRaw.toString('utf8') : (stdoutRaw ?? '');

	if (raw.trim() === '') {
		return {
			ok: false,
			message:
				'claude auth status returned empty output (fail-closed); run `claude auth login` to authenticate',
		};
	}

	const authJson = parseAuthJson(raw);
	if (authJson === null) {
		return {
			ok: false,
			message:
				'claude auth status returned non-JSON output (fail-closed); run `claude auth login` to authenticate',
		};
	}

	if (authJson.loggedIn !== true) {
		return {
			ok: false,
			message: 'Not logged in to Claude Code; run `claude auth login` to authenticate',
		};
	}

	const subscriptionType =
		typeof authJson.subscriptionType === 'string' ? authJson.subscriptionType : undefined;

	return {
		ok: true,
		subscriptionType,
		message: subscriptionType !== undefined ? `logged in (${subscriptionType})` : 'logged in',
	};
}
