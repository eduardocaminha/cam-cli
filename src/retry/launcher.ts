/**
 * Ported from claude-auto-retry v0.2.2
 * Original authors: cheapestinference contributors
 * Port: Eduardo Caminha
 * License: MIT — see LICENSES/claude-auto-retry-MIT.txt
 */

// src/retry/launcher.ts
//
// launchClaude — print-mode launcher with auto-retry on rate limits.
// launchClaudeInteractive — interactive/tmux launcher that forks a detached
//   retry-monitor child. (US-005)
//
// Design: spawn functions are injectable so tests can stub without real processes.

import { isRateLimited } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import { loadConfig } from './config.ts';

// ---------------------------------------------------------------------------
// Spawn adapter interface — injectable for tests
// ---------------------------------------------------------------------------

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A function that spawns a child process and returns its combined output.
 * The real adapter uses Bun.spawn; tests inject a stub.
 *
 * Args forwarded verbatim as argv[0..n]; env and cwd mirror the parent process.
 */
export type SpawnAdapter = (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
) => Promise<SpawnResult>;

// ---------------------------------------------------------------------------
// Real Bun spawn adapter
// ---------------------------------------------------------------------------

/**
 * Default spawn adapter: uses Bun.spawn with stdio:inherit for stdout/stderr
 * piped mode so we can capture and inspect them for rate-limit messages.
 */
export async function bunSpawnAdapter(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<SpawnResult> {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return { stdout: stdoutText, stderr: stderrText, exitCode };
}

// ---------------------------------------------------------------------------
// findClaudeBinary
// ---------------------------------------------------------------------------

/**
 * Locate the `claude` binary on PATH. Falls back to the bare name so the
 * shell resolution still applies when `which` is unavailable.
 */
function findClaudeBinary(): string {
  const result = Bun.spawnSync(['which', 'claude'], { stdout: 'pipe' });
  if (result.exitCode === 0 && result.stdout) {
    const path = Buffer.from(result.stdout).toString('utf8').trim();
    if (path) return path;
  }
  return 'claude';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** argv to forward to `claude` (e.g. ['-p', '--model', 'sonnet', '/cam-next']) */
  args: string[];
  /** cwd to pass to the child process. Defaults to process.cwd(). */
  cwd?: string;
  /** env to pass to the child process. Defaults to process.env (filtered). */
  env?: Record<string, string>;
  /** Injectable spawn adapter. Defaults to bunSpawnAdapter. */
  spawn?: SpawnAdapter;
}

/**
 * Launch `claude` in print mode with auto-retry on rate limits.
 *
 * - Captures stdout+stderr to detect rate-limit messages.
 * - On clean exit: replays buffered stdout/stderr to the parent streams
 *   and returns the child exit code.
 * - On rate limit: waits the calculated delay and retries up to
 *   `config.maxRetries` times.
 * - Does NOT call createTmuxSession — interactive/tmux mode is US-005.
 *
 * Returns the process exit code (0 on success, non-zero on error or
 * exhausted retries).
 */
export async function launchClaude(opts: LaunchOptions): Promise<number> {
  const { args, cwd = process.cwd(), spawn = bunSpawnAdapter } = opts;

  // Build a clean env without undefined values (Bun.spawn requires Record<string, string>).
  const env: Record<string, string> = {
    ...(opts.env ?? filteredProcessEnv()),
    CLAUDE_AUTO_RETRY_ACTIVE: '1',
  };

  const claudeBin = findClaudeBinary();
  const argv = [claudeBin, ...args];

  const config = await loadConfig();
  let retries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await spawn(argv, env, cwd);
    const combined = result.stdout + result.stderr;

    if (!isRateLimited(combined, config.customPatterns)) {
      // Clean exit — replay buffered output to parent streams.
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }

    // Rate limited — discard buffer, wait and retry.
    retries++;
    if (retries > config.maxRetries) {
      process.stderr.write(
        `[cam] Rate limit retries exhausted (${config.maxRetries}). Giving up.\n`,
      );
      return 1;
    }

    const parsed = parseResetTime(combined);
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    const waitSec = Math.round(waitMs / 1000);

    process.stderr.write(
      `[cam] Rate limited. Waiting ${waitSec}s before retry ${retries}/${config.maxRetries}...\n`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

// ---------------------------------------------------------------------------
// Interactive launcher (US-005)
// ---------------------------------------------------------------------------

/**
 * An adapter that detaches a background monitor process.
 * Injectable for tests (avoids real Bun.spawn calls).
 */
export interface DetachedSpawnAdapter {
  (argv: string[]): void;
}

/**
 * An adapter that registers a signal handler.
 * Injectable for tests.
 */
export type SignalHandler = (signal: NodeJS.Signals, handler: () => void) => void;

export interface InteractiveOptions {
  /** Forwarded args to pass to claude (must NOT include -p/--print). */
  args: string[];
  /** Tmux pane target (e.g. "%1" or "cam:1.0"). */
  pane: string;
  /** PID of the claude process (for monitor liveness checks). */
  claudePid: number;
  /** Cleanup callback invoked on SIGINT/SIGTERM/SIGHUP (e.g. remove PID file). */
  cleanup: () => void;
  /**
   * Injectable adapter for spawning the detached monitor child.
   * Defaults to the real Bun.spawn detached adapter.
   */
  detachedSpawn?: DetachedSpawnAdapter;
  /**
   * Injectable signal registration fn.
   * Defaults to `process.on`.
   */
  onSignal?: SignalHandler;
}

/**
 * Fork a detached `cam retry-monitor <pane> <claudePid>` child that watches
 * the tmux pane and resumes on rate-limit clear.
 *
 * The child is fully detached (detached:true, stdio:'ignore', unref'd) so it
 * outlives the parent process and does not block the parent's event loop.
 *
 * SIGINT/SIGTERM/SIGHUP handlers propagate the signal to the claude child and
 * call `cleanup()`. SIGWINCH is forwarded for terminal resize.
 *
 * Call this AFTER the claude child process has been spawned so that
 * `claudePid` is the real PID.
 */
export function forkMonitor(opts: InteractiveOptions): void {
  const {
    pane,
    claudePid,
    cleanup,
    detachedSpawn = defaultDetachedSpawn,
    onSignal = (sig, fn) => process.on(sig, fn),
  } = opts;

  // Resolve the argv for the monitor child.
  // We invoke ourselves (the cam binary / bun + this entry point) with
  // the `retry-monitor` subcommand so the child reuses all our own code.
  const self = process.execPath; // path to bun executable
  const mainScript = process.argv[1] ?? 'cam'; // path to index.ts / cam binary
  const monitorArgv = [self, mainScript, 'retry-monitor', pane, String(claudePid)];

  detachedSpawn(monitorArgv);

  // Install signal handlers that propagate to the claude child and clean up.
  const propagate = (signal: NodeJS.Signals) => {
    try {
      process.kill(claudePid, signal);
    } catch {
      // ignore — process already gone
    }
    cleanup();
  };

  onSignal('SIGINT', () => propagate('SIGINT'));
  onSignal('SIGTERM', () => propagate('SIGTERM'));
  onSignal('SIGHUP', () => propagate('SIGHUP'));

  // Forward SIGWINCH for terminal resize (claude handles it natively).
  onSignal('SIGWINCH', () => {
    try {
      process.kill(claudePid, 'SIGWINCH');
    } catch {
      // ignore
    }
  });
}

/**
 * The real detached spawn adapter: uses Bun.spawn with detached:true and
 * stdio:'ignore', then unrefs the child so it does not keep the event loop alive.
 */
function defaultDetachedSpawn(argv: string[]): void {
  const proc = Bun.spawn(argv, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  proc.unref();
}

/**
 * Validate that the environment is suitable for interactive mode.
 *
 * Returns `null` if valid, or an error message string if not.
 * "Valid" means: $TMUX is set (running inside tmux) AND args do NOT include
 * -p/--print (which would be print mode, not interactive).
 */
export function validateInteractiveEnv(
  args: string[],
  tmux: string | undefined,
): string | null {
  const hasPrint = args.includes('-p') || args.includes('--print');
  if (hasPrint) {
    // Caller is in print mode — interactive path should not be taken.
    return 'print mode detected — use launchClaude instead';
  }
  if (!tmux) {
    return (
      '$TMUX is not set. Interactive auto-retry requires a tmux session.\n' +
      "Use `cam run` to open the orchestrator session, which provides tmux."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter process.env to a Record<string, string> (drop undefined values).
 */
function filteredProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
