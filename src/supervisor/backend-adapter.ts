// src/supervisor/backend-adapter.ts
//
// BackendAdapter seam (US-002/US-003, CAM-54/339). Design record: ADR-0047
// (docs/adr/0047-backendadapter-seam-methods-vs-inputs-vs-shared-contract-and-the-six-mismatch-resolution.md).
//
// ADR-0047 fixes the seam as ONE concrete adapter method:
//
//   buildSpawnArgv(actor, opts): string
//
// where `model`, `agentName`, `permissionMode`, and the env-unset prefix are
// INPUTS threaded through opts, not separate adapter methods. Completion
// detection (worker report / sentinel text parsing) is explicitly a SHARED
// CONTRACT that lives outside the adapter (see ADR-0038) and must never be
// added here.
//
// US-003 (CAM-339) inverts the US-002 direction: the real per-actor argv
// assembly (env-strip prefix, CAM_WORKER=1 marker, shell-escaping, agent/model
// defaults) now lives HERE, in ClaudeAdapter.buildSpawnArgv, instead of inside
// the four builder functions. buildImplementerWorkerArgv (worker-argv.ts),
// buildPlannerWorkerArgv / buildAuditorWorkerArgv (plan-argv.ts), and
// buildReviewerWorkerArgv (review.ts) are now thin wrappers that resolve their
// own actor and delegate to `new ClaudeAdapter().buildSpawnArgv(actor, opts)`.
// This module intentionally does NOT import from worker-argv.ts / plan-argv.ts
// / review.ts (those three import FROM here instead) so the dependency graph
// stays a one-way fan-out with no import cycle.

import { DEFAULTS } from '../config/models.ts';
import type { WorkerIsolation } from '../config/models.ts';

/** The four worker actors in scope for the seam (ADR-0046/0047). */
export type WorkerActor = 'implementer' | 'planner' | 'auditor' | 'reviewer';

/**
 * Shared input shape for buildSpawnArgv, covering every value that varies
 * per call site across the four actors today. `taskPrompt` and
 * `permissionMode` are required for implementer/planner/auditor and optional
 * for reviewer (which has its own defaults, mirroring
 * ReviewerWorkerArgvOptions).
 */
export interface SpawnArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/**
	 * Free-text task prompt sent to the agent. Will be shell-escaped.
	 * Required for implementer/planner/auditor; optional for reviewer
	 * (defaults to REVIEWER_TASK_PROMPT).
	 */
	taskPrompt?: string;
	/**
	 * Claude permission mode forwarded to the spawned process (NEVER a cam CLI
	 * flag). Required for implementer/planner/auditor; optional for reviewer
	 * (defaults to 'bypassPermissions').
	 */
	permissionMode?: string;
	/** Agent name matching the .claude/agents/<name>.md frontmatter. */
	agentName?: string;
	/** Model to pass as `--model` to the spawned process. */
	model?: string;
	/**
	 * Worker isolation mode (US-001, CAM-242): threads into the env-unset
	 * prefix so CLAUDE_CODE_OAUTH_TOKEN is stripped on 'host' only.
	 */
	isolation?: WorkerIsolation;
}

/**
 * BackendAdapter: the seam between the supervisor and whatever CLI actually
 * gets spawned for a worker actor. Exposes exactly one concrete method
 * (ADR-0047): every per-actor/per-call-site variation is an INPUT to that
 * method, not a method of its own. Completion detection is deliberately
 * NOT part of this interface (shared contract, lives outside the adapter).
 */
export interface BackendAdapter {
	/**
	 * Build the shell string passed to `respawn-pane` to launch an
	 * interactive TUI worker for `actor`.
	 */
	buildSpawnArgv(actor: WorkerActor, opts: SpawnArgvOptions): string;
}

/**
 * Throws when a required field for the given actor is missing. Implementer,
 * planner, and auditor all require taskPrompt + permissionMode (their
 * existing builders take these as required fields); reviewer defaults both.
 */
function requireForNonReviewerActor(
	actor: 'implementer' | 'planner' | 'auditor',
	opts: SpawnArgvOptions,
): { taskPrompt: string; permissionMode: string } {
	if (opts.taskPrompt === undefined) {
		throw new Error(`buildSpawnArgv: taskPrompt is required for actor '${actor}'`);
	}
	if (opts.permissionMode === undefined) {
		throw new Error(`buildSpawnArgv: permissionMode is required for actor '${actor}'`);
	}
	return { taskPrompt: opts.taskPrompt, permissionMode: opts.permissionMode };
}

// ---------------------------------------------------------------------------
// Shared argv-assembly primitives (US-003, CAM-339: consolidated here from
// worker-argv.ts / plan-argv.ts / review.ts, which now re-export the ones
// they used to define, for call sites that still import them by that path).
// ---------------------------------------------------------------------------

/** Default agent name; matches .claude/agents/subagent-implementer.md. */
export const DEFAULT_IMPLEMENTER_AGENT = 'subagent-implementer';

/** Default planner agent name; matches .claude/agents/subagent-planner.md. */
export const DEFAULT_PLANNER_AGENT = 'subagent-planner';

/** Default auditor agent name; matches .claude/agents/subagent-auditor.md. */
export const DEFAULT_AUDITOR_AGENT = 'subagent-auditor';

/** Default agent name; matches .claude/agents/subagent-reviewer.md. */
export const DEFAULT_REVIEWER_AGENT = 'subagent-reviewer';

/**
 * Default task prompt for the interactive reviewer session (CAM-42 US-003).
 * The <review> tag on the very last line is the completion sentinel the
 * supervisor polls for.
 */
export const REVIEWER_TASK_PROMPT =
	'Review all changes on the current branch vs main per your AGENT.md. Run the project quality gates. End your output with the <review> verdict tag on the very last line.';

/**
 * Canonical list of environment variables stripped from a spawned worker so it
 * does not inherit the parent claude session's identity. `CLAUDECODE=1` is the
 * one documented nesting gate: when set, a freshly spawned `claude` detects
 * nesting and exits before its session initializes. The rest are set by the SDK
 * (session id, entrypoint, exec path, sse port, sdk version) and are stripped
 * defensively so no stale parent-session identity leaks into the worker. The
 * worker command removes these via `env -u` so a worker spawned from a tmux
 * server that was bootstrapped inside a claude session still boots (CAM-43).
 *
 * Deliberately does NOT include CLAUDE_CONFIG_DIR or PATH: the worker must keep
 * the same config dir (subscription auth lives there) and the same PATH (so the
 * `claude` / `cam` binaries resolve).
 */
export const WORKER_ENV_UNSET: readonly string[] = [
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_SSE_PORT',
	'CLAUDE_CODE_EXECPATH',
	'CLAUDE_AGENT_SDK_VERSION',
];

/**
 * Env vars stripped ONLY from host-isolation workers (US-001, CAM-242). The
 * tmux `-L cam` server is bootstrapped by `cam run` with `.env` loaded, so
 * CLAUDE_CODE_OAUTH_TOKEN lives in the server process's OS env and every
 * respawn-pane worker inherits it, overriding the interactive config-dir
 * login (~/.claude-pessoal). Stripping it forces the worker to authenticate
 * via the config-dir login instead of pinning to a possibly rate-limited
 * token account. NOT stripped in container mode: container workers have no
 * logged-in config dir and rely on worker-container.ts injecting this exact
 * var via `-e CLAUDE_CODE_OAUTH_TOKEN` (see buildDockerRunArgv).
 */
export const HOST_ONLY_ENV_UNSET: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Render the `env -u VAR1 -u VAR2 ... ` prefix (with a trailing space) that
 * strips WORKER_ENV_UNSET (always) and, on 'host' isolation, HOST_ONLY_ENV_UNSET
 * (US-001, CAM-242) from a spawned worker. Prepended to every worker shell
 * string so the worker does not inherit nesting-detection env vars from the
 * tmux server (CAM-43), and, on host, so it does not inherit a possibly
 * rate-limited CLAUDE_CODE_OAUTH_TOKEN from the server's OS env. The `isolation`
 * argument is required (not defaulted) so every call site is explicit about
 * which mode it is building for; container callers must not silently strip the
 * token their worker actually needs. The var names are fixed identifiers, so
 * no escaping is needed.
 */
export function workerEnvPrefix(isolation: WorkerIsolation): string {
	const vars = isolation === 'host' ? [...WORKER_ENV_UNSET, ...HOST_ONLY_ENV_UNSET] : WORKER_ENV_UNSET;
	return `env ${vars.map((v) => `-u ${v}`).join(' ')} `;
}

/**
 * Worker-actor env marker assignment (US-002, CAM-63): identifies a spawned
 * implementer worker process so a later ACL hook (US-006) can distinguish a
 * worker-actor Write from a planner/orchestrator Write. Both run under
 * CAM_SESSION, so that var alone cannot disambiguate them; CAM_WORKER is the
 * narrower, positive signal set ONLY on the implementer worker path.
 *
 * `env` supports mixing `-u <var>` (unset) with `NAME=VALUE` (set) assignments
 * in the same invocation, so this is appended after the `-u` flags rendered by
 * `workerEnvPrefix` and before the `claude` binary name.
 *
 * Deliberately NOT folded into `workerEnvPrefix`: that function is shared with
 * the reviewer/planner/auditor branches of buildSpawnArgv below, and the
 * planner subagent must never inherit this marker (it legitimately writes
 * prd.json). It is also never added to the orchestrator/cam-run env path
 * (src/tmux/session.ts `new-session -e CAM_SESSION`).
 */
export const WORKER_ACTOR_ENV = 'CAM_WORKER=1';

/**
 * Escape a string for safe embedding inside a POSIX single-quoted shell argument.
 *
 * Single-quoting is the safest general-purpose shell escape: no characters
 * inside single quotes are interpreted by the shell except a single quote
 * itself, which terminates the quote. We handle embedded single quotes by
 * ending the current quote, inserting an escaped quote, then reopening.
 *
 * Example: `she said 'hi'` -> `'she said '\''hi'\''`
 *
 * This is the ONE definition (US-003, CAM-339): the three copies previously
 * duplicated in worker-argv.ts, plan-argv.ts, and review.ts are removed.
 */
function shellEscape(s: string): string {
	// Replace each ' with '\'' (end-quote, literal-quote, start-quote).
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * ClaudeAdapter: the claude-CLI implementation of BackendAdapter. Holds the
 * real per-actor argv assembly (US-003, CAM-339): buildImplementerWorkerArgv /
 * buildPlannerWorkerArgv / buildAuditorWorkerArgv / buildReviewerWorkerArgv
 * are now thin per-actor wrappers around this method, so any future actor
 * variation is authored once, here.
 */
export class ClaudeAdapter implements BackendAdapter {
	buildSpawnArgv(actor: WorkerActor, opts: SpawnArgvOptions): string {
		switch (actor) {
			case 'implementer': {
				const required = requireForNonReviewerActor('implementer', opts);
				const agentName = opts.agentName ?? DEFAULT_IMPLEMENTER_AGENT;
				const model = opts.model ?? DEFAULTS.implementer;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(required.taskPrompt);
				return (
					workerEnvPrefix(isolation) +
					`${WORKER_ACTOR_ENV} ` +
					`claude` +
					` --permission-mode ${required.permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
			case 'planner': {
				const required = requireForNonReviewerActor('planner', opts);
				const agentName = opts.agentName ?? DEFAULT_PLANNER_AGENT;
				const model = opts.model ?? DEFAULTS.planner;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(required.taskPrompt);
				return (
					workerEnvPrefix(isolation) +
					`claude` +
					` --permission-mode ${required.permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
			case 'auditor': {
				const required = requireForNonReviewerActor('auditor', opts);
				const agentName = opts.agentName ?? DEFAULT_AUDITOR_AGENT;
				const model = opts.model ?? DEFAULTS.auditor;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(required.taskPrompt);
				return (
					workerEnvPrefix(isolation) +
					`claude` +
					` --permission-mode ${required.permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
			case 'reviewer': {
				const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;
				const model = opts.model ?? DEFAULTS.reviewer;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(opts.taskPrompt ?? REVIEWER_TASK_PROMPT);
				const permissionMode = opts.permissionMode ?? 'bypassPermissions';
				return (
					workerEnvPrefix(isolation) +
					`claude` +
					` --permission-mode ${permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
		}
	}
}
