// src/supervisor/worker-argv.ts
//
// Pure argv builder for launching a headless implementer worker session.
//
// The supervisor calls buildImplementerWorkerArgv to construct the shell
// string that gets passed to `respawn-pane` (via respawnPaneArgv). The
// string is a two-command chain:
//
//   1. `claude -p ...` — runs the implementer agent headlessly and exits when done.
//   2. `; tmux -L cam wait-for -S <channel>` — signals the supervisor so the
//      wait-for client unblocks.
//
// Design decisions:
//   - Pure function; no spawning, no file I/O.
//   - Task prompt and channel are single-quote-escaped so any embedded quotes,
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
	/** tmux wait-for channel name; will be shell-escaped. */
	channel: string;
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
 * Build the shell string passed to `respawn-pane` to launch a headless
 * implementer worker.
 *
 * Returns a shell string with the shape:
 *
 *   claude -p --permission-mode <mode> --session-id <uuid> \
 *     --output-format text --agent <agentName> '<task>' \
 *     ; tmux -L cam wait-for -S '<channel>'
 *
 * Both `<task>` and `<channel>` are single-quote-escaped. The other
 * interpolated values (uuid, permissionMode, agentName) are controlled by
 * the supervisor and are expected to be shell-safe identifiers; they are
 * not additionally escaped to keep the output readable.
 */
export function buildImplementerWorkerArgv(opts: ImplementerWorkerArgvOptions): string {
	const agentName = opts.agentName ?? DEFAULT_IMPLEMENTER_AGENT;
	const escapedPrompt = shellEscape(opts.taskPrompt);
	const escapedChannel = shellEscape(opts.channel);

	return (
		`claude -p` +
		` --permission-mode ${opts.permissionMode}` +
		` --session-id ${opts.uuid}` +
		` --output-format text` +
		` --agent ${agentName}` +
		` ${escapedPrompt}` +
		` ; tmux -L cam wait-for -S ${escapedChannel}`
	);
}
