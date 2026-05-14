/**
 * Ported from claude-auto-retry v0.2.2
 * Original authors: cheapestinference contributors
 * Port: Eduardo Caminha
 * License: MIT — see LICENSES/claude-auto-retry-MIT.txt
 */

// src/retry/launcher.ts
//
// launchClaude — print-mode launcher with auto-retry on rate limits.
//
// This module handles ONLY print mode (`claude -p / --print`).
// Interactive/tmux mode is handled separately in US-005.
//
// Design: the `spawn` function is injectable so tests can stub it without
// spawning a real `claude` process.

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
