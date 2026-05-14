// src/commands/claude.ts
//
// `cam claude [args...]` — run claude in print mode under the retry launcher.
//
// All args after `cam claude` are forwarded verbatim to the child `claude`
// process. cam does NOT parse them beyond a leading `--help` / `-h`.
// This means callers can pass any claude flag — including
// `--permission-mode bypassPermissions` — without cam needing to know it.
//
// IMPORTANT INVARIANT: this file does NOT register a `--permission-mode` flag
// of its own. The literal `--permission-mode` may appear only in forwarded
// argv. `test/no-permission-mode-flag.test.ts` enforces this invariant via
// textual scan of `src/commands/`.

import { launchClaude, type LaunchOptions } from '../retry/launcher.ts';

export const CLAUDE_HELP = `cam claude — run claude in print mode with auto-retry on rate limits

Usage:
  cam claude [args...]

Flags consumed by cam:
  --help, -h    Print this help and exit.

All other flags are forwarded verbatim to the child \`claude\` process.
Examples:
  cam claude -p "Hello world"
  cam claude --print --model claude-opus-4-5 /cam-next
  cam claude --permission-mode bypassPermissions /cam-plan

Permission mode for cam's own spawned sessions is read from
~/.config/cam/config.toml — \`cam claude\` does not expose a CLI flag for it.
To use a specific permission mode, pass it directly as a claude flag:
  cam claude --permission-mode <mode> <prompt>`;

export interface ClaudeOptions {
  /** Args to forward verbatim to claude (after stripping the leading --help). */
  args: string[];
  /** Injectable spawn adapter — used by tests to avoid real claude invocations. */
  spawn?: LaunchOptions['spawn'];
  /** Override cwd — primarily for tests. */
  cwd?: string;
}

/**
 * Run `cam claude`.
 *
 * Returns the child process exit code (forwarded unchanged so the caller can
 * `process.exit(code)` directly).
 */
export async function runClaude(options: ClaudeOptions): Promise<number> {
  return launchClaude({
    args: options.args,
    cwd: options.cwd,
    spawn: options.spawn,
  });
}

/**
 * Parse `cam claude` args.
 *
 * The only flag cam itself consumes is `--help` / `-h`. Everything else is
 * forwarded verbatim. Returns `{ help: true }` when the user asked for help,
 * or `{ help: false, forwardedArgs: string[] }` for all other inputs.
 */
export function parseClaudeArgs(args: string[]): { help: true } | { help: false; forwardedArgs: string[] } {
  // Only consume a leading --help / -h. Any other position or any other flag
  // is forwarded to claude as-is.
  const first = args[0];
  if (first === '--help' || first === '-h') {
    return { help: true };
  }
  return { help: false, forwardedArgs: args };
}
