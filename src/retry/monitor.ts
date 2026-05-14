/**
 * Ported from claude-auto-retry v0.2.2
 * Original authors: cheapestinference contributors
 * Port: Eduardo Caminha
 * License: MIT — see LICENSES/claude-auto-retry-MIT.txt
 */

import { stripAnsi, isRateLimited, findRateLimitMessage } from "./patterns.ts";
import { parseResetTime, calculateWaitMs } from "./time-parser.ts";
import { capturePane, sendKeys, getPaneCommand, isProcessForeground } from "./tmux.ts";
import { loadConfig, type RetryConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";

const DEFAULT_FOREGROUND_COMMANDS = ["node", "claude", "npx", "tsx", "bun", "deno"];

export type MonitorStatus = "monitoring" | "waiting";

export type TickResult =
  | "exit"
  | "waiting"
  | "monitoring"
  | "retried"
  | "user-continued"
  | "max-retries"
  | "skipped-not-claude";

export interface MonitorState {
  status: MonitorStatus;
  waitUntil: number;
  attempts: number;
  lastRateLimitMessage: string | null;
  _lastForeground?: string;
}

/**
 * Dependencies injected into processOneTick.
 * All production adapters are wired in startMonitor(); tests inject fakes.
 */
export interface TickDeps {
  /** Returns current unix timestamp in milliseconds (injectable for fake clock). */
  now: () => number;
  /** Captures the last `lines` lines of the given pane. */
  capturePane: (pane: string, lines: number) => Promise<string>;
  /** Sends a keypress sequence to the given pane. */
  sendKeys: (pane: string, text: string) => Promise<void>;
  /** Returns the foreground command name for the given pane. */
  getPaneCommand: (pane: string) => Promise<string>;
  /** Returns true if the claude process is in the foreground, false/null otherwise. */
  isClaudeForeground: () => Promise<boolean | null>;
  /** Async sleep (injectable to avoid real wall-clock delays in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Logger. */
  logger: Logger;
  /** Resolved retry configuration. */
  config: RetryConfig;
  /** Predicate: is the monitored process still alive? */
  isAlive: () => boolean;
}

export function createMonitorState(): MonitorState {
  return { status: "monitoring", waitUntil: 0, attempts: 0, lastRateLimitMessage: null };
}

/**
 * Process a single monitor tick. All I/O is driven through `deps` so this
 * function can be exercised in tests with a fake clock, fake tmux output, and
 * synchronous no-op sleep.
 */
export async function processOneTick(
  state: MonitorState,
  pane: string,
  deps: TickDeps,
): Promise<TickResult> {
  if (!deps.isAlive()) return "exit";

  const raw = await deps.capturePane(pane, 20);
  const stripped = stripAnsi(raw);

  if (state.status === "waiting") {
    if (deps.now() < state.waitUntil) return "waiting";
    if (!deps.isAlive()) return "exit";

    // Always check if rate limit cleared FIRST — even when maxRetries
    // exhausted, the user (or time passing) may have resolved it.
    if (!isRateLimited(stripped, deps.config.customPatterns)) {
      state.status = "monitoring";
      state.attempts = 0;
      return "user-continued";
    }

    if (state.attempts >= deps.config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit
      // on the next tick and creating an infinite max-retries loop.
      state.waitUntil = deps.now() + deps.config.pollIntervalSeconds * 1000 * 12;
      return "max-retries";
    }

    // Primary check: is the Claude process in the foreground process group?
    // On macOS, pane_current_command reports "zsh" instead of the child
    // process, so we use `ps -o stat=` to check the '+' (foreground) flag.
    // `true` short-circuits past pane_current_command (fixes macOS).
    // `false`/`null` falls back to pane_current_command for safety.
    const isFg = await deps.isClaudeForeground();
    if (isFg !== true) {
      const fg = await deps.getPaneCommand(pane);
      const fgCommands = deps.config.foregroundCommands ?? DEFAULT_FOREGROUND_COMMANDS;
      if (!fgCommands.some((c) => fg.toLowerCase().includes(c))) {
        state.waitUntil = deps.now() + deps.config.pollIntervalSeconds * 1000 * 6;
        state._lastForeground = fg;
        return "skipped-not-claude";
      }
    }

    // Increment attempts and set cooldown BEFORE sendKeys so that a failure
    // (e.g. pane destroyed) still consumes a retry and avoids tight-loop errors.
    state.attempts++;
    state.waitUntil = deps.now() + 30_000;
    await deps.sendKeys(pane, deps.config.retryMessage);
    return "retried";
  }

  if (isRateLimited(stripped, deps.config.customPatterns)) {
    const message = findRateLimitMessage(stripped, deps.config.customPatterns);
    state.lastRateLimitMessage = message;
    const parsed = message ? parseResetTime(message) : null;
    state.waitUntil =
      deps.now() + calculateWaitMs(parsed, deps.config.marginSeconds, deps.config.fallbackWaitHours, new Date(deps.now()));
    state.status = "waiting";
    return "waiting";
  }

  return "monitoring";
}

/**
 * Default entrypoint: wires real Bun-backed adapters and runs the monitor loop.
 * Preserves the original monitor.js end-to-end behavior.
 */
export async function startMonitor(pane: string, pid: number): Promise<void> {
  const config = await loadConfig();
  const logger = createLogger();
  const state = createMonitorState();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  await logger.info(`Monitor started for pane ${pane} (claude PID: ${pid})`);

  const deps: TickDeps = {
    now: () => Date.now(),
    capturePane,
    sendKeys,
    getPaneCommand,
    isClaudeForeground: () => isProcessForeground(pid),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logger,
    config,
    isAlive: () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };

  const loop = async () => {
    try {
      const result = await processOneTick(state, pane, deps);
      consecutiveErrors = 0;

      if (result === "exit") {
        await logger.info("Claude exited. Monitor shutting down.");
        process.exit(0);
      }
      if (result === "waiting" && state.lastRateLimitMessage) {
        const secs = Math.round((state.waitUntil - deps.now()) / 1000);
        await logger.info(
          `Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`,
        );
        state.lastRateLimitMessage = null;
      }
      if (result === "retried") {
        await logger.info(`Sent retry message (attempt ${state.attempts})`);
      }
      if (result === "user-continued") {
        await logger.info("User already continued. Attempt counter reset.");
      }
      if (result === "max-retries") {
        await logger.warn(
          `Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`,
        );
      }
      if (result === "skipped-not-claude") {
        await logger.warn(
          `Foreground is "${state._lastForeground}", not Claude. Skipping send-keys. (Add to foregroundCommands in config if this is wrong)`,
        );
      }
    } catch (err) {
      consecutiveErrors++;
      await logger
        .error(`Monitor tick error: ${err instanceof Error ? err.message : String(err)}`)
        .catch(() => {});
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await logger
          .error(
            `${MAX_CONSECUTIVE_ERRORS} consecutive errors. Pane likely destroyed. Exiting.`,
          )
          .catch(() => {});
        process.exit(1);
      }
    }
  };

  // Use recursive setTimeout instead of setInterval to prevent concurrent
  // tick execution when a tick takes longer than the poll interval.
  const scheduleNext = () => {
    setTimeout(async () => {
      await loop();
      scheduleNext();
    }, config.pollIntervalSeconds * 1000);
  };
  loop().then(scheduleNext);
}

// Direct execution: bun monitor.ts <pane> <pid>
const isDirectRun =
  process.argv[1]?.endsWith("monitor.ts") && process.argv.length >= 4;
if (isDirectRun) {
  startMonitor(process.argv[2] ?? "", parseInt(process.argv[3] ?? "0", 10));
}
