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
//   - US-003 (CAM-339): buildImplementerWorkerArgv is now a thin wrapper over
//     ClaudeAdapter.buildSpawnArgv('implementer', opts) (backend-adapter.ts),
//     which resolves the adapter per-actor and holds the actual assembly
//     logic. WORKER_ENV_UNSET, HOST_ONLY_ENV_UNSET, workerEnvPrefix,
//     WORKER_ACTOR_ENV, and DEFAULT_IMPLEMENTER_AGENT are re-exported from
//     there for existing callers/tests that import them from this file.

import type { WorkerIsolation } from '../config/models.ts';
import { ClaudeAdapter } from './backend-adapter.ts';

export {
	WORKER_ENV_UNSET,
	HOST_ONLY_ENV_UNSET,
	workerEnvPrefix,
	WORKER_ACTOR_ENV,
	DEFAULT_IMPLEMENTER_AGENT,
} from './backend-adapter.ts';

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
	/**
	 * Worker isolation mode (US-001, CAM-242). On 'host', CLAUDE_CODE_OAUTH_TOKEN
	 * is additionally stripped (HOST_ONLY_ENV_UNSET) so the worker falls back to
	 * the interactive config-dir login instead of a possibly rate-limited token
	 * account. On 'container', the token is left intact: worker-container.ts
	 * injects it via `-e CLAUDE_CODE_OAUTH_TOKEN` and there is no logged-in
	 * config dir inside the container. Defaults to 'host'.
	 */
	isolation?: WorkerIsolation;
}

/**
 * Build the shell string passed to `respawn-pane` to launch an implementer worker.
 *
 * Returns:
 *
 *   env -u CLAUDECODE -u ... CAM_WORKER=1 claude --permission-mode <mode> \
 *     --session-id <uuid> --agent <agentName> '<task>'
 *
 * `CAM_WORKER=1` (WORKER_ACTOR_ENV, US-002/CAM-63) marks the spawned process as
 * a worker actor so a later ACL hook can distinguish it from a planner/
 * orchestrator Write.
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
 *
 * US-003 (CAM-339): thin wrapper resolving the 'implementer' actor and
 * delegating to ClaudeAdapter.buildSpawnArgv for the actual assembly.
 */
export function buildImplementerWorkerArgv(opts: ImplementerWorkerArgvOptions): string {
	return new ClaudeAdapter().buildSpawnArgv('implementer', opts);
}
