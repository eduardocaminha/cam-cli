// src/commands/claude.ts
//
// `cam claude [args...]` — run claude with auto-retry on rate limits.
//
// Routing logic (US-005):
//   • args include -p/--print → print mode (launchClaude, captures stdout)
//   • $TMUX is set + no -p/--print → interactive mode (TTY-attached spawn + monitor fork)
//   • no $TMUX + no -p/--print → error, point at `cam run`
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

import { launchClaude, forkMonitor, validateInteractiveEnv, type LaunchOptions, type DetachedSpawnAdapter, type SignalHandler } from '../retry/launcher.ts';

export const CLAUDE_HELP = `cam claude — run claude with auto-retry on rate limits

Usage:
  cam claude [args...]

Flags consumed by cam:
  --help, -h    Print this help and exit.

All other flags are forwarded verbatim to the child \`claude\` process.
Examples:
  cam claude -p "Hello world"
  cam claude --print --model claude-opus-4-5 /cam-next
  cam claude --permission-mode bypassPermissions /cam-plan

Routing:
  • With -p/--print:      print mode — cam captures output and auto-retries.
  • Inside tmux (no -p):  interactive mode — cam forks a background monitor
                           that watches the pane and retries on rate limits.
  • Outside tmux (no -p): error — run \`cam run\` to get a tmux session first.

Permission mode for cam's own spawned sessions is read from
~/.config/cam/config.toml — \`cam claude\` does not expose a CLI flag for it.
To use a specific permission mode, pass it directly as a claude flag:
  cam claude --permission-mode <mode> <prompt>`;

export interface ClaudeOptions {
  /** Args to forward verbatim to claude (after stripping the leading --help). */
  args: string[];
  /** Injectable spawn adapter — used by tests to avoid real claude invocations (print mode). */
  spawn?: LaunchOptions['spawn'];
  /** Override cwd — primarily for tests. */
  cwd?: string;
  /**
   * Override $TMUX value. Defaults to `process.env['TMUX']`.
   * Tests inject this to simulate tmux/non-tmux environments.
   */
  tmux?: string;
  /**
   * Override the current tmux pane. Defaults to `process.env['TMUX_PANE']`.
   * In interactive mode, this is forwarded to the retry-monitor child as <pane>.
   */
  tmuxPane?: string;
  /**
   * Injectable detached spawn adapter for the monitor child (interactive mode).
   * Defaults to the real Bun.spawn detached adapter used by forkMonitor.
   */
  detachedSpawn?: DetachedSpawnAdapter;
  /**
   * Injectable signal registration fn (interactive mode).
   * Defaults to `process.on`.
   */
  onSignal?: SignalHandler;
}

/**
 * Run `cam claude`.
 *
 * Returns the child process exit code (forwarded unchanged so the caller can
 * `process.exit(code)` directly).
 */
export async function runClaude(options: ClaudeOptions): Promise<number> {
  const { args, cwd, spawn, tmux, tmuxPane, detachedSpawn, onSignal } = options;

  const hasPrint = args.includes('-p') || args.includes('--print');

  if (hasPrint) {
    // Print mode: capture stdout/stderr, auto-retry on rate limits.
    return launchClaude({ args, cwd, spawn });
  }

  // Interactive mode: must be inside tmux.
  const tmuxEnv = tmux !== undefined ? tmux : process.env['TMUX'];
  const validationError = validateInteractiveEnv(args, tmuxEnv);
  if (validationError) {
    process.stderr.write(`[cam] ${validationError}\n`);
    return 1;
  }

  // Resolve the tmux pane (TMUX_PANE is set by tmux automatically).
  const pane = tmuxPane ?? process.env['TMUX_PANE'] ?? '';

  // Spawn claude attached to the TTY so the user can interact.
  const claudeBin = findClaudeBinary();
  const argv = [claudeBin, ...args];
  const env: Record<string, string> = {
    ...filteredProcessEnv(),
    CLAUDE_AUTO_RETRY_ACTIVE: '1',
  };

  const proc = Bun.spawn(argv, {
    cwd: cwd ?? process.cwd(),
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    detached: false,
  });

  const claudePid = proc.pid;

  // Fork the detached monitor child AFTER getting the PID.
  forkMonitor({
    args,
    pane,
    claudePid,
    cleanup: () => {
      // No PID file yet (US-006 adds retry-pid.ts). Nothing to clean up here.
    },
    detachedSpawn,
    onSignal,
  });

  const exitCode = await proc.exited;
  return exitCode;
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

// ---------------------------------------------------------------------------
// Helpers (duplicated from launcher.ts to avoid circular dep)
// ---------------------------------------------------------------------------

function findClaudeBinary(): string {
  const result = Bun.spawnSync(['which', 'claude'], { stdout: 'pipe' });
  if (result.exitCode === 0 && result.stdout) {
    const path = Buffer.from(result.stdout).toString('utf8').trim();
    if (path) return path;
  }
  return 'claude';
}

function filteredProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
