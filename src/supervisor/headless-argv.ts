// src/supervisor/headless-argv.ts
//
// Pure builder for the headless (`--print`) worker child process invocation:
// an argv ARRAY plus an explicit child env. US-001 (CAM-516).
//
// This is a SEPARATE path from BackendAdapter (ADR-0047, backend-adapter.ts):
// BackendAdapter.buildSpawnArgv returns a shell STRING meant for
// `respawn-pane` (the interactive tmux-pane worker contract). The headless
// path spawns a real child process directly (US-003) and therefore needs a
// real argv array (`Bun.spawn`'s `cmd` shape), never a shell string. GOTCHA
// C: do not register this builder as a third BackendAdapter method and do
// not reuse buildSpawnArgv's string return here -- the two contracts (pane
// respawn vs. direct child spawn) are deliberately kept apart.
//
// Flag set (ADR-0060 + officialDocsConsulted on this PRD, fetched against
// https://code.claude.com/docs/en/headless 2026-08-09): the CLI, not the
// Agent SDK, and exactly `--print`, `--input-format stream-json`,
// `--output-format stream-json`, `--verbose`, `--agent <agentName>`. The
// `--agent` flag was originally missing here (CRITICAL bug, US-R1-001):
// without it the spawned child boots as a generic `claude` session with no
// AGENT.md, so the implementer protocol (worker-report.json, the
// CAM_IMPLEMENTER_STATUS sentinel, story-selection rules) never applies even
// though `task-prompt.ts`'s prompt text tells the child to follow it. The
// tmux implementer contract already passes this same flag
// (`ClaudeAdapter.buildSpawnArgv`, backend-adapter.ts, ` --agent
// ${agentName}`); official docs confirm `--agent` combines with `-p`
// (https://code.claude.com/docs/en/cli-reference). Three flags are
// deliberately ABSENT:
//   - `--resume`: the Warren readSessionId path this would have fed is dead
//     (GOTCHA G).
//   - `--include-partial-messages`: would emit token-level `stream_event`
//     deltas this PRD's parser (US-002) does not consume (GOTCHA H).
//   - `--bare`: the docs page recommends `--bare` for scripted/SDK calls and
//     says it will become the default for `-p`, but `--bare` explicitly
//     never reads OAuth credentials or the system keychain and instead
//     expects ANTHROPIC_API_KEY -- the exact opposite of this repo's
//     subscription-only invariant (CAM-42) and of the host + config-dir
//     credential combination ADR-0059 actually measured. The headless path
//     must authenticate the same way the interactive tmux path does, so
//     `--bare` is refused here, next to the ANTHROPIC_API_KEY strip below.
//
// Model resolution: `model` is an INPUT to this builder, exactly like
// `loop.ts` already resolves `implModel` via `resolvePhaseModel` once and
// threads the resolved string into `buildSpawnArgv`. This file does not
// read config or env to resolve a model itself (no second reader).

import { HOST_ONLY_ENV_UNSET, WORKER_ENV_UNSET } from './backend-adapter.ts';

/** Env var stripped from the headless child in addition to WORKER_ENV_UNSET
 * and HOST_ONLY_ENV_UNSET (see the doc-comment on `stripHeadlessChildEnv`
 * below for the full justification). */
export const ANTHROPIC_API_KEY_ENV_UNSET = 'ANTHROPIC_API_KEY';

/** Inputs to {@link buildHeadlessChildInvocation}. */
export interface BuildHeadlessChildInvocationOptions {
	/**
	 * Resolved model slug to pass as `--model`. Omitted (undefined) appends
	 * nothing, leaving the child to use its own default. This builder never
	 * resolves a model itself -- see the model-resolution note above.
	 */
	model?: string;
	/**
	 * Agent name to pass as `--agent`, e.g. `DEFAULT_IMPLEMENTER_AGENT`
	 * (`'subagent-implementer'`, backend-adapter.ts). Required, not defaulted
	 * here: this builder mirrors the caller's resolved agent name the same
	 * way it mirrors `model` above, rather than re-deciding a default of its
	 * own (a second source of truth for the implementer agent name). See the
	 * module header for why this flag is mandatory.
	 */
	agentName: string;
	/**
	 * Source process env the child env is derived from (e.g. `process.env`).
	 * Never mutated: a fresh object is returned.
	 */
	sourceEnv: Record<string, string | undefined>;
}

/** Output of {@link buildHeadlessChildInvocation}. */
export interface HeadlessChildInvocation {
	/** Argv array for the headless child, e.g. for `Bun.spawn({ cmd: argv })`. */
	argv: string[];
	/** Explicit child env, derived from `sourceEnv` with the credential/nesting strips applied. */
	env: Record<string, string | undefined>;
}

/**
 * Render the fixed headless-mode argv array: `claude --print --input-format
 * stream-json --output-format stream-json --verbose --agent <agentName>`,
 * plus `--model <model>` when a model is supplied. Always an array, never a
 * shell string (GOTCHA C).
 */
function buildHeadlessArgv(model: string | undefined, agentName: string): string[] {
	const argv = [
		'claude',
		'--print',
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--verbose',
		'--agent',
		agentName,
	];
	if (model !== undefined) {
		argv.push('--model', model);
	}
	return argv;
}

/**
 * Strip the headless child's env down to an explicit, declared credential
 * policy instead of letting it inherit whatever the parent process happens
 * to carry:
 *
 *   1. WORKER_ENV_UNSET (backend-adapter.ts): the CAM-43 nesting-detection
 *      vars, so a headless child spawned from a claude-nested process still
 *      boots.
 *   2. HOST_ONLY_ENV_UNSET, i.e. CLAUDE_CODE_OAUTH_TOKEN: forces the headless
 *      child to authenticate through the config-dir login instead of a
 *      possibly rate-limited token that happens to be sitting in the parent
 *      env. This is the exact host + config-dir credential combination
 *      ADR-0059 measured (GOTCHA J); the container + env-token combination
 *      stays unmeasured and is out of scope here.
 *   3. ANTHROPIC_API_KEY: unlike the two groups above, no executable code in
 *      this repo ever reads this variable (GOTCHA K) -- so this strip is not
 *      a defense against repo code. It is a defense against the operator's
 *      ambient environment: if ANTHROPIC_API_KEY happens to be exported in
 *      the operator's shell (e.g. for an unrelated script or tool), a
 *      `claude` child that inherits it could silently authenticate via
 *      pay-per-token API billing instead of the subscription config-dir
 *      login this repo requires (CAM-42), which is also why `--bare` (which
 *      expects this exact var) is refused above. Stripping it here makes the
 *      credential choice declared rather than accidentally inherited.
 */
function stripHeadlessChildEnv(sourceEnv: Record<string, string | undefined>): Record<string, string | undefined> {
	const env = { ...sourceEnv };
	for (const key of WORKER_ENV_UNSET) {
		delete env[key];
	}
	for (const key of HOST_ONLY_ENV_UNSET) {
		delete env[key];
	}
	delete env[ANTHROPIC_API_KEY_ENV_UNSET];
	return env;
}

/**
 * Build the full headless child invocation: argv array + explicit env. The
 * single pure builder this story exists to deliver (US-001, CAM-516).
 */
export function buildHeadlessChildInvocation(
	opts: BuildHeadlessChildInvocationOptions,
): HeadlessChildInvocation {
	return {
		argv: buildHeadlessArgv(opts.model, opts.agentName),
		env: stripHeadlessChildEnv(opts.sourceEnv),
	};
}
