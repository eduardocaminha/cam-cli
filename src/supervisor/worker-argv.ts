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
	/**
	 * tmux wait-for channel name; will be shell-escaped.
	 * Required for autonomous (exit) mode. Not used when interactive: true.
	 */
	channel?: string;
	/**
	 * Agent name matching the .claude/agents/<name>.md frontmatter.
	 * Defaults to 'subagent-implementer'.
	 */
	agentName?: string;
	/**
	 * Durable output-log path. When set, the worker's stdout+stderr is tee'd to
	 * this file so the supervisor can read the result AFTER the ephemeral pane
	 * dies (CAM-32 BUG 1). Will be shell-escaped. When omitted, output goes only
	 * to the pane (legacy behaviour).
	 */
	outFile?: string;
	/**
	 * When true, launch claude in interactive mode: omit -p and --output-format
	 * flags, and omit the tmux wait-for chain. The supervisor will poll
	 * capture-pane for the sentinel instead of waiting for a channel signal.
	 * Defaults to false (autonomous headless mode).
	 */
	interactive?: boolean;
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
 * Autonomous (default, interactive: false) returns:
 *
 *   claude -p --permission-mode <mode> --session-id <uuid> \
 *     --output-format text --agent <agentName> '<task>' \
 *     ; tmux -L cam wait-for -S '<channel>'
 *
 * Interactive mode (interactive: true) returns:
 *
 *   claude --permission-mode <mode> --session-id <uuid> \
 *     --agent <agentName> '<task>'
 *
 * In interactive mode, -p and --output-format are omitted so the process stays
 * open for operator interaction. The tmux wait-for chain is also omitted; the
 * supervisor detects completion by polling capture-pane for the sentinel text.
 *
 * Both `<task>` and `<channel>` are single-quote-escaped. The other
 * interpolated values (uuid, permissionMode, agentName) are controlled by
 * the supervisor and are expected to be shell-safe identifiers; they are
 * not additionally escaped to keep the output readable.
 */
export function buildImplementerWorkerArgv(opts: ImplementerWorkerArgvOptions): string {
	const agentName = opts.agentName ?? DEFAULT_IMPLEMENTER_AGENT;
	const escapedPrompt = shellEscape(opts.taskPrompt);
	// When outFile is set, tee stdout+stderr to a durable log so the supervisor
	// can read the worker result even after the pane dies (CAM-32 BUG 1). The
	// pipe binds tighter than `;`, so it is (claude ... | tee file) ; (tmux ...).
	const teePart = opts.outFile ? ` 2>&1 | tee ${shellEscape(opts.outFile)}` : '';

	if (opts.interactive) {
		// Interactive mode: no -p, no --output-format, no wait-for chain, and no
		// tee. Piping stdout would strip the pty from the TUI renderer (Ink needs
		// a TTY), so outFile is ignored here; durable capture comes from
		// `capture-pane -S -` over the pane scrollback instead (CAM-42).
		return (
			`claude` +
			` --permission-mode ${opts.permissionMode}` +
			` --session-id ${opts.uuid}` +
			` --agent ${agentName}` +
			` ${escapedPrompt}`
		);
	}

	const escapedChannel = shellEscape(opts.channel ?? '');
	return (
		`claude -p` +
		` --permission-mode ${opts.permissionMode}` +
		` --session-id ${opts.uuid}` +
		` --output-format text` +
		` --agent ${agentName}` +
		` ${escapedPrompt}` +
		teePart +
		` ; tmux -L cam wait-for -S ${escapedChannel}`
	);
}
