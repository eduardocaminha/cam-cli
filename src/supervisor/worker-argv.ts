// src/supervisor/worker-argv.ts
//
// Pure argv builder for launching an interactive implementer worker session.
//
// The supervisor calls buildImplementerWorkerArgv to construct the shell
// string that gets passed to `respawn-pane` (via respawnPaneArgv). The
// string launches claude as a TUI session:
//
//   claude --permission-mode <mode> --session-id <uuid> \
//     --agent <agentName> '<prompt>'
//
// Completion is detected by the supervisor via capture-pane polling for
// the CAM_*_STATUS sentinel line; there is no exit/wait-for chain.
//
// Design decisions:
//   - Pure function; no spawning, no file I/O.
//   - The shell string is prefixed with `env -u <var> ...` to strip the
//     nesting-detection env vars (CLAUDECODE etc) from the worker process.
//     When the tmux `-L cam` server is bootstrapped from inside a claude
//     session, its global env carries these vars, the respawn-pane worker
//     inherits them, claude detects nesting and dies pre-session (no
//     transcript, empty pane). Stripping them locally in the worker command
//     fixes this without perturbing the env of whoever inspects the session
//     (CAM-43, found in CAM-42 US-006 validation).
//   - Task prompt is single-quote-escaped so any embedded quotes,
//     dollar signs, or backticks cannot escape the shell argument boundary.
//   - agentName defaults to 'subagent-implementer' (matches .claude/agents/
//     subagent-implementer.md frontmatter `name` field).
//   - `--permission-mode` is NOT a CLI flag on any cam subcommand; it is
//     forwarded programmatically to the spawned claude process only.

import { DEFAULTS } from '../config/models.ts';

/** Arguments for buildImplementerWorkerArgv. */
export interface ImplementerWorkerArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/** Free-text task prompt sent to the implementer agent. Will be shell-escaped. */
	taskPrompt: string;
	/** Claude permission mode (e.g. 'bypassPermissions', 'acceptEdits'). */
	permissionMode: string;
	/**
	 * Agent name matching the .claude/agents/<name>.md frontmatter.
	 * Defaults to 'subagent-implementer'.
	 */
	agentName?: string;
	/**
	 * Model to pass as `--model` to the spawned claude process.
	 * Defaults to DEFAULTS.implementer when absent. The caller (loop.ts)
	 * passes readPhaseModel('implementer') so the project config is respected.
	 */
	model?: string;
}

/** Default agent name; matches .claude/agents/subagent-implementer.md. */
export const DEFAULT_IMPLEMENTER_AGENT = 'subagent-implementer';

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
 * Render the `env -u VAR1 -u VAR2 ... ` prefix (with a trailing space) that
 * strips WORKER_ENV_UNSET from a spawned worker. Prepended to every worker
 * shell string so the worker does not inherit nesting-detection env vars from
 * the tmux server (CAM-43). The var names are fixed identifiers, so no escaping
 * is needed.
 */
export function workerEnvPrefix(): string {
	return `env ${WORKER_ENV_UNSET.map((v) => `-u ${v}`).join(' ')} `;
}

/**
 * Escape a string for safe embedding inside a POSIX single-quoted shell argument.
 *
 * Single-quoting is the safest general-purpose shell escape: no characters
 * inside single quotes are interpreted by the shell except a single quote
 * itself, which terminates the quote. We handle embedded single quotes by
 * ending the current quote, inserting an escaped quote, then reopening.
 *
 * Example: `she said 'hi'` -> `'she said '\''hi'\''`
 */
function shellEscape(s: string): string {
	// Replace each ' with '\'' (end-quote, literal-quote, start-quote).
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the shell string passed to `respawn-pane` to launch an implementer worker.
 *
 * Returns:
 *
 *   env -u CLAUDECODE -u ... claude --permission-mode <mode> --session-id <uuid> \
 *     --agent <agentName> '<task>'
 *
 * The `env -u ...` prefix strips nesting-detection env vars (CAM-43). -p and
 * --output-format are omitted so the process stays open for operator
 * interaction. The tmux wait-for chain is also omitted; the supervisor detects
 * completion by polling capture-pane for the sentinel text.
 *
 * `<task>` is single-quote-escaped. The other interpolated values (uuid,
 * permissionMode, agentName) are controlled by the supervisor and are expected
 * to be shell-safe identifiers; they are not additionally escaped to keep the
 * output readable.
 */
export function buildImplementerWorkerArgv(opts: ImplementerWorkerArgvOptions): string {
	const agentName = opts.agentName ?? DEFAULT_IMPLEMENTER_AGENT;
	const model = opts.model ?? DEFAULTS.implementer;
	const escapedPrompt = shellEscape(opts.taskPrompt);
	return (
		workerEnvPrefix() +
		`claude` +
		` --permission-mode ${opts.permissionMode}` +
		` --session-id ${opts.uuid}` +
		` --model ${shellEscape(model)}` +
		` --agent ${agentName}` +
		` ${escapedPrompt}`
	);
}
