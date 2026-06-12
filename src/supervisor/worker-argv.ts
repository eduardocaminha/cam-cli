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
//   - Task prompt is single-quote-escaped so any embedded quotes,
//     dollar signs, or backticks cannot escape the shell argument boundary.
//   - agentName defaults to 'subagent-implementer' (matches .claude/agents/
//     subagent-implementer.md frontmatter `name` field).
//   - `--permission-mode` is NOT a CLI flag on any cam subcommand; it is
//     forwarded programmatically to the spawned claude process only.

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
}

/** Default agent name; matches .claude/agents/subagent-implementer.md. */
export const DEFAULT_IMPLEMENTER_AGENT = 'subagent-implementer';

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
 *   claude --permission-mode <mode> --session-id <uuid> \
 *     --agent <agentName> '<task>'
 *
 * -p and --output-format are omitted so the process stays open for operator
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
	const escapedPrompt = shellEscape(opts.taskPrompt);
	return (
		`claude` +
		` --permission-mode ${opts.permissionMode}` +
		` --session-id ${opts.uuid}` +
		` --agent ${agentName}` +
		` ${escapedPrompt}`
	);
}
