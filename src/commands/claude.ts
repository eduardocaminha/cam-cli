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
import { writeRetryPid, removeRetryPid } from '../util/retry-pid.ts';

import { renderHelp } from '../logging/help.ts';

export const CLAUDE_HELP = renderHelp({
	title: 'cam claude',
	tagline: 'Run claude with built-in auto-retry on rate limits',
	usage: 'cam claude [args...]',
	sections: [
		{
			heading: 'Flags consumed by cam',
			entries: [
				{ name: '--help, -h', description: 'Print this help and exit' },
			],
		},
		{
			heading: 'Examples',
			body:
				'cam claude -p "Hello world"\n' +
				'cam claude --print --model claude-opus-4-5 /cam-next\n' +
				'cam claude --permission-mode bypassPermissions /cam-plan',
		},
		{
			heading: 'Routing',
			body:
				'• With -p/--print:      print mode — cam captures stdout/stderr and retries\n' +
				'                          automatically when claude returns a rate-limit error.\n' +
				'• Inside tmux (no -p):  interactive mode — cam forks a detached background\n' +
				'                          monitor (cam retry-monitor) that watches the pane\n' +
				'                          and sends the retry keystroke after the back-off\n' +
				'                          window expires.\n' +
				'• Outside tmux (no -p): error — run `cam run` to get a tmux session first.',
		},
		{
			heading: 'Config',
			body:
				'Retry policy:     ~/.config/cam/retry.toml  (written by `cam init`; safe to edit)\n' +
				'Retry logs:       ~/.cam/retry-logs/\n' +
				'Permission mode:  ~/.config/cam/config.toml — `cam claude` does not expose a\n' +
				'                  CLI flag for it. Pass it directly as a claude arg if needed:\n' +
				'                    cam claude --permission-mode <mode> <prompt>',
		},
	],
	footer: 'All other flags are forwarded verbatim to the child `claude` process.',
});

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
  // onMonitorSpawned writes the monitor's PID to ~/.cam/retry.pid so that
  // cam resume (US-007) can check liveness via isRetryPidAlive.
  // cleanup removes the PID file on SIGINT/SIGTERM/SIGHUP.
  forkMonitor({
    args,
    pane,
    claudePid,
    onMonitorSpawned: writeRetryPid,
    cleanup: () => {
      // Remove the monitor PID file on SIGINT/SIGTERM/SIGHUP so cam resume
      // (US-007) can tell the monitor is no longer running.
      removeRetryPid();
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
