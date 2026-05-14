// src/commands/retry-monitor.ts
//
// `cam retry-monitor <pane> <pid>` — internal subcommand.
//
// This subcommand is NOT advertised in the top-level `cam help` listing; it
// is an internal command forked by `launchClaudeInteractive` / `forkMonitor`.
// It still responds to `--help` when invoked directly.
//
// IMPORTANT INVARIANT: this file does NOT register a `--permission-mode` flag
// of its own. `test/no-permission-mode-flag.test.ts` enforces this by scanning
// every file in `src/commands/`.

import { startMonitor } from '../retry/monitor.ts';
import { createLogger } from '../retry/logger.ts';

export const RETRY_MONITOR_HELP = `cam retry-monitor — internal monitor subcommand (not for direct use)

Usage (internal):
  cam retry-monitor <pane> <pid>

Arguments:
  <pane>   Tmux pane target to watch (e.g. "%1" or "cam:1.0").
  <pid>    PID of the claude process to monitor for liveness.

This subcommand is forked as a detached background process by \`cam claude\`
when running inside a tmux session. It watches the given pane for rate-limit
messages and sends the retry key sequence when the rate limit clears.

Logs are written to ~/.cam/retry-logs/.

Do not invoke this subcommand directly — use \`cam run\` to start a managed
tmux session where interactive auto-retry is handled automatically.`;

export interface RetryMonitorOptions {
  pane: string;
  pid: number;
  /** Injectable monitor starter for tests. Defaults to startMonitor. */
  monitor?: (pane: string, pid: number) => Promise<void>;
}

/**
 * Run the retry monitor for the given pane + claude PID.
 * This is the entrypoint called by the `retry-monitor` subcommand dispatch.
 */
export async function runRetryMonitor(opts: RetryMonitorOptions): Promise<number> {
  const { pane, pid, monitor = startMonitor } = opts;

  if (!pane || !pid || !Number.isFinite(pid) || pid <= 0) {
    process.stderr.write(
      '[cam retry-monitor] Invalid arguments. Usage: cam retry-monitor <pane> <pid>\n',
    );
    return 1;
  }

  const logger = createLogger();
  await logger.info(`retry-monitor started: pane=${pane} pid=${pid}`);

  await monitor(pane, pid);
  return 0;
}

/**
 * Parse `cam retry-monitor` args.
 *
 * Returns `{ help: true }` when --help/-h is passed.
 * Returns `{ pane, pid }` on valid args.
 * Returns `null` on a parse error (caller prints usage and exits 1).
 */
export function parseRetryMonitorArgs(
  args: string[],
): { help: true } | { help: false; pane: string; pid: number } | null {
  const first = args[0];
  if (first === '--help' || first === '-h') {
    return { help: true };
  }

  const paneArg = args[0];
  const pidArg = args[1];

  if (!paneArg || !pidArg) {
    process.stderr.write(
      '[cam retry-monitor] Missing arguments. Usage: cam retry-monitor <pane> <pid>\n',
    );
    return null;
  }

  const pid = Number.parseInt(pidArg, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    process.stderr.write(
      `[cam retry-monitor] <pid> must be a positive integer, got ${JSON.stringify(pidArg)}\n`,
    );
    return null;
  }

  return { help: false, pane: paneArg, pid };
}
