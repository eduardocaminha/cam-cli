/**
 * Tests for src/retry/tmux.ts
 * No real tmux process is spawned — all tests use fixture strings.
 */

import { test, expect, describe } from "bun:test";
import {
  buildCaptureArgs,
  buildSendKeysArgs,
  buildDisplayArgs,
  parseTmuxVersion,
  isInsideTmux,
  getCurrentPane,
} from "../../src/retry/tmux.ts";

describe("buildCaptureArgs", () => {
  test("returns correct tmux args with default lines", () => {
    expect(buildCaptureArgs("main")).toEqual([
      "capture-pane",
      "-t",
      "main",
      "-p",
      "-S",
      "-200",
    ]);
  });

  test("respects custom lines count", () => {
    const args = buildCaptureArgs("%1", 50);
    expect(args).toEqual(["capture-pane", "-t", "%1", "-p", "-S", "-50"]);
  });

  test("handles pane with window spec", () => {
    const args = buildCaptureArgs("session:window.1");
    expect(args[2]).toBe("session:window.1");
  });
});

describe("buildSendKeysArgs", () => {
  test("returns correct send-keys args", () => {
    expect(buildSendKeysArgs("main", "Continue")).toEqual([
      "send-keys",
      "-t",
      "main",
      "Continue",
      "Enter",
    ]);
  });

  test("handles text with spaces", () => {
    const args = buildSendKeysArgs("%0", "hello world");
    expect(args).toEqual(["send-keys", "-t", "%0", "hello world", "Enter"]);
  });
});

describe("buildDisplayArgs", () => {
  test("returns correct display-message args", () => {
    expect(buildDisplayArgs("main", "#{pane_current_command}")).toEqual([
      "display-message",
      "-t",
      "main",
      "-p",
      "#{pane_current_command}",
    ]);
  });
});

describe("parseTmuxVersion", () => {
  test("parses standard version string", () => {
    expect(parseTmuxVersion("tmux 3.3a")).toBe(3.3);
  });

  test("parses version without letter suffix", () => {
    expect(parseTmuxVersion("tmux 3.2")).toBe(3.2);
  });

  test("parses tmux 2.x version", () => {
    expect(parseTmuxVersion("tmux 2.9")).toBe(2.9);
  });

  test("returns 0 for empty string", () => {
    expect(parseTmuxVersion("")).toBe(0);
  });

  test("returns 0 for unrecognized format", () => {
    expect(parseTmuxVersion("not a tmux version string")).toBe(0);
  });

  test("returns 0 for partial match without digits", () => {
    expect(parseTmuxVersion("tmux abc")).toBe(0);
  });
});

describe("isInsideTmux", () => {
  test("returns false when TMUX env var is absent", () => {
    const original = process.env["TMUX"];
    delete process.env["TMUX"];
    expect(isInsideTmux()).toBe(false);
    if (original !== undefined) process.env["TMUX"] = original;
  });

  test("returns true when TMUX env var is set", () => {
    const original = process.env["TMUX"];
    process.env["TMUX"] = "/private/tmp/tmux-501/default,12345,0";
    expect(isInsideTmux()).toBe(true);
    if (original !== undefined) process.env["TMUX"] = original;
    else delete process.env["TMUX"];
  });
});

describe("getCurrentPane", () => {
  test("returns null when TMUX_PANE is absent", () => {
    const original = process.env["TMUX_PANE"];
    delete process.env["TMUX_PANE"];
    expect(getCurrentPane()).toBeNull();
    if (original !== undefined) process.env["TMUX_PANE"] = original;
  });

  test("returns the pane identifier when TMUX_PANE is set", () => {
    const original = process.env["TMUX_PANE"];
    process.env["TMUX_PANE"] = "%3";
    expect(getCurrentPane()).toBe("%3");
    if (original !== undefined) process.env["TMUX_PANE"] = original;
    else delete process.env["TMUX_PANE"];
  });
});
