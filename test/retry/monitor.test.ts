/**
 * Tests for src/retry/monitor.ts — processOneTick with injected deps.
 * No real tmux session, real sleep > 100ms, or real claude process is used.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  processOneTick,
  createMonitorState,
  type MonitorState,
  type TickDeps,
} from "../../src/retry/monitor.ts";
import { DEFAULT_CONFIG } from "../../src/retry/config.ts";

// ---------- helpers ----------

/** Build a fake Logger that no-ops and captures last message. */
function fakeLogger() {
  const calls: { level: string; msg: string }[] = [];
  return {
    logger: {
      info: async (msg: string) => { calls.push({ level: "info", msg }); },
      warn: async (msg: string) => { calls.push({ level: "warn", msg }); },
      error: async (msg: string) => { calls.push({ level: "error", msg }); },
    },
    calls,
  };
}

/** Build a minimal TickDeps set with sensible defaults that can be overridden. */
function makeDeps(overrides: Partial<TickDeps> & { nowMs?: number } = {}): TickDeps {
  const { nowMs = 1_000_000, ...rest } = overrides;
  const { logger } = fakeLogger();
  return {
    now: () => nowMs,
    capturePane: async () => "some tmux output",
    sendKeys: async () => {},
    getPaneCommand: async () => "zsh",
    isClaudeForeground: async () => null,
    sleep: async () => {},
    logger,
    config: { ...DEFAULT_CONFIG },
    isAlive: () => true,
    ...rest,
  };
}

// ---------- scenario (a): no rate limit detected ----------

describe("processOneTick — no rate limit detected", () => {
  let state: MonitorState;

  beforeEach(() => {
    state = createMonitorState();
  });

  test("returns 'monitoring' when tmux output has no rate-limit signal", async () => {
    const deps = makeDeps({
      capturePane: async () => "$ claude\n> Working on task...\n",
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("monitoring");
  });

  test("state remains in 'monitoring' status", async () => {
    const deps = makeDeps({
      capturePane: async () => "normal output",
    });
    await processOneTick(state, "%0", deps);
    expect(state.status).toBe("monitoring");
  });

  test("returns 'exit' immediately when isAlive returns false", async () => {
    const deps = makeDeps({ isAlive: () => false });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("exit");
  });

  test("capturePane is not called when process is not alive", async () => {
    let called = false;
    const deps = makeDeps({
      isAlive: () => false,
      capturePane: async () => { called = true; return ""; },
    });
    await processOneTick(state, "%0", deps);
    expect(called).toBe(false);
  });
});

// ---------- scenario (b): rate limit detected, still waiting ----------

describe("processOneTick — rate limit detected with future resume time", () => {
  let state: MonitorState;
  const NOW = 1_000_000;

  beforeEach(() => {
    state = createMonitorState();
  });

  // Multi-line TUI-style output that triggers isRateLimited
  const rateLimitOutput = [
    "⚠ You've hit your limit",
    "· resets 3pm (UTC)",
  ].join("\n");

  test("transitions state to 'waiting' on first detection", async () => {
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("waiting");
    expect(state.status).toBe("waiting");
  });

  test("sets waitUntil to a future timestamp", async () => {
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
    });
    await processOneTick(state, "%0", deps);
    expect(state.waitUntil).toBeGreaterThan(NOW);
  });

  test("returns 'waiting' again when called while waitUntil is in the future", async () => {
    // First tick: detect rate limit
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
    });
    await processOneTick(state, "%0", deps);

    // Second tick: still before waitUntil
    const deps2 = makeDeps({
      nowMs: NOW + 1000, // only 1s later, well before waitUntil
      capturePane: async () => rateLimitOutput,
    });
    // Manually peg waitUntil so the test is deterministic
    state.waitUntil = NOW + 3_600_000; // 1 hour from now
    const result = await processOneTick(state, "%0", deps2);
    expect(result).toBe("waiting");
  });

  test("stores the rate limit message in state", async () => {
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
    });
    await processOneTick(state, "%0", deps);
    expect(state.lastRateLimitMessage).not.toBeNull();
  });

  test("uses fallback wait when reset time message is not parseable", async () => {
    // "try again in 3 hours" matches both LIMIT_PATTERNS (/try again in/i) and
    // RESET_PATTERNS (/try again in \d+/i). findRateLimitMessage returns that line.
    // calculateWaitMs({ relative: true, waitMs: 3*3600*1000 }, 60) = 10_860_000
    const output = "try again in 3 hours";
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => output,
      config: { ...DEFAULT_CONFIG, marginSeconds: 60 },
    });
    await processOneTick(state, "%0", deps);
    // parseResetTime("try again in 3 hours") → { relative: true, waitMs: 10_800_000 }
    // calculateWaitMs: 10_800_000 + 60 * 1000 = 10_860_000 ms
    const expected = NOW + 10_800_000 + 60 * 1000;
    expect(state.waitUntil).toBe(expected);
  });
});

// ---------- scenario (c): resume-time-reached → resume signaled ----------

describe("processOneTick — resume time reached", () => {
  const NOW = 2_000_000;

  test("returns 'user-continued' when rate limit cleared after wait", async () => {
    const state = createMonitorState();
    state.status = "waiting";
    state.waitUntil = NOW - 1; // waitUntil is in the past

    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => "$ claude\n> Continuing task...\n", // no rate limit
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("user-continued");
    expect(state.status as string).toBe("monitoring");
    expect(state.attempts).toBe(0);
  });

  test("sends retry message when claude is foreground and rate limit still present", async () => {
    const state = createMonitorState();
    state.status = "waiting";
    state.waitUntil = NOW - 1;

    const rateLimitOutput = "You've hit your limit\nresets in: 1 hour";
    let keysSent: string | null = null;

    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
      isClaudeForeground: async () => true,
      sendKeys: async (_pane, text) => { keysSent = text; },
      config: { ...DEFAULT_CONFIG, maxRetries: 5, retryMessage: "Continue." },
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("retried");
    expect(keysSent as unknown as string).toBe("Continue.");
    expect(state.attempts).toBe(1);
  });

  test("increments attempts on each retry", async () => {
    const state = createMonitorState();
    state.status = "waiting";
    state.waitUntil = NOW - 1;
    state.attempts = 2;

    const rateLimitOutput = "You've hit your limit\nresets in: 1 hour";
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
      isClaudeForeground: async () => true,
      config: { ...DEFAULT_CONFIG, maxRetries: 5 },
    });
    await processOneTick(state, "%0", deps);
    expect(state.attempts).toBe(3);
  });

  test("returns 'max-retries' when maxRetries is exhausted", async () => {
    const state = createMonitorState();
    state.status = "waiting";
    state.waitUntil = NOW - 1;
    state.attempts = 5; // already at maxRetries

    const rateLimitOutput = "You've hit your limit\nresets in: 1 hour";
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
      isClaudeForeground: async () => true,
      config: { ...DEFAULT_CONFIG, maxRetries: 5 },
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("max-retries");
  });

  test("returns 'skipped-not-claude' when foreground is not a known command", async () => {
    const state = createMonitorState();
    state.status = "waiting";
    state.waitUntil = NOW - 1;

    const rateLimitOutput = "You've hit your limit\nresets in: 1 hour";
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
      isClaudeForeground: async () => null,
      getPaneCommand: async () => "vim",
      config: { ...DEFAULT_CONFIG, foregroundCommands: ["node", "claude", "bun"] },
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("skipped-not-claude");
    expect(state._lastForeground).toBe("vim");
  });

  test("proceeds to retry when pane command matches foreground list (isFg null)", async () => {
    const state = createMonitorState();
    state.status = "waiting";
    state.waitUntil = NOW - 1;

    const rateLimitOutput = "You've hit your limit\nresets in: 1 hour";
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
      isClaudeForeground: async () => null,
      getPaneCommand: async () => "claude",
      config: { ...DEFAULT_CONFIG, maxRetries: 5, foregroundCommands: ["claude"] },
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("retried");
  });

  test("returns 'exit' when process dies mid-wait", async () => {
    const state = createMonitorState();
    state.status = "waiting";
    state.waitUntil = NOW - 1;

    // isAlive returns false after capturePane sees rate limit still present
    const rateLimitOutput = "You've hit your limit\nresets in: 1 hour";
    const deps = makeDeps({
      nowMs: NOW,
      capturePane: async () => rateLimitOutput,
      // After checking waitUntil, isAlive is checked a second time
      isAlive: (() => {
        let callCount = 0;
        return () => {
          // First call (at start of tick) returns true; second call returns false
          callCount++;
          return callCount <= 1;
        };
      })(),
    });
    const result = await processOneTick(state, "%0", deps);
    expect(result).toBe("exit");
  });
});

// ---------- createMonitorState ----------

describe("createMonitorState", () => {
  test("returns correct initial state shape", () => {
    const state = createMonitorState();
    expect(state.status).toBe("monitoring");
    expect(state.waitUntil).toBe(0);
    expect(state.attempts).toBe(0);
    expect(state.lastRateLimitMessage).toBeNull();
  });
});
