import { test, expect, describe } from "bun:test";
import { stripAnsi, isRateLimited, findRateLimitMessage } from "../../src/retry/patterns";

describe("stripAnsi", () => {
  test("removes CSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("removes OSC sequences (hyperlinks)", () => {
    expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  test("removes OSC sequences terminated by BEL", () => {
    expect(stripAnsi("\x1b]0;window title\x07text")).toBe("text");
  });

  test("removes DCS sequences", () => {
    expect(stripAnsi("\x1bPdata\x1b\\text")).toBe("text");
  });

  test("removes APC/SOS/PM sequences", () => {
    expect(stripAnsi("\x1b_data\x1b\\text")).toBe("text");
  });

  test("passes through plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("removes private-mode CSI sequences", () => {
    expect(stripAnsi("\x1b[?25hvisible")).toBe("visible");
  });
});

describe("isRateLimited", () => {
  const makeMultiLine = (limitLine: string, resetLine: string) =>
    `Some output\n${limitLine}\n${resetLine}\nMore output`;

  test("detects 'hit your limit' + 'resets 3pm'", () => {
    expect(isRateLimited(makeMultiLine("You've hit your limit", "· resets 3pm (UTC)"))).toBe(true);
  });

  test("detects 'usage limit' + 'resets at 3:00 PM'", () => {
    expect(isRateLimited(makeMultiLine("usage limit exceeded", "resets at 3:00 PM"))).toBe(true);
  });

  test("detects 'rate limit' + 'try again in 5 hours'", () => {
    expect(isRateLimited(makeMultiLine("rate limit reached", "try again in 5 hours"))).toBe(true);
  });

  test("detects '5-hour limit' pattern", () => {
    expect(isRateLimited(makeMultiLine("5-hour limit reached", "resets in: 3 hours"))).toBe(true);
  });

  test("detects 'out of extra usage'", () => {
    expect(isRateLimited(makeMultiLine("out of extra usage", "resets 6pm"))).toBe(true);
  });

  test("detects 'limit reached' + 'resets in 2 hours'", () => {
    expect(isRateLimited(makeMultiLine("limit reached", "resets in: 2 hours"))).toBe(true);
  });

  test("detects single-line 'try again in' message", () => {
    // "try again in" matches both LIMIT_PATTERNS and RESET_PATTERNS on same line
    expect(isRateLimited("try again in 5 hours")).toBe(true);
  });

  test("returns false for plain non-limit text", () => {
    expect(isRateLimited("Everything is working fine")).toBe(false);
  });

  test("returns false when limit found but no nearby reset", () => {
    // 10 blank lines separate the two — beyond the 6-line window
    const text = "hit your limit\n\n\n\n\n\n\n\n\n\nresets 3pm";
    expect(isRateLimited(text)).toBe(false);
  });

  test("strips ANSI before matching", () => {
    const text = "\x1b[31mYou've hit your limit\x1b[0m\nresets 3pm (UTC)";
    expect(isRateLimited(text)).toBe(true);
  });

  test("custom string pattern matches", () => {
    expect(isRateLimited("quota exceeded today", ["quota exceeded"])).toBe(true);
  });

  test("custom RegExp pattern matches", () => {
    expect(isRateLimited("QUOTA_EXCEEDED", [/quota_exceeded/i])).toBe(true);
  });

  test("custom pattern returns false when no match", () => {
    expect(isRateLimited("everything fine", ["quota exceeded"])).toBe(false);
  });
});

describe("findRateLimitMessage", () => {
  test("returns the reset line preferentially", () => {
    const text = "You've hit your limit\nresets 3pm (UTC)";
    expect(findRateLimitMessage(text)).toBe("resets 3pm (UTC)");
  });

  test("returns first reset line", () => {
    const text = "noise\ntry again in 5 hours\nresets 6pm";
    expect(findRateLimitMessage(text)).toBe("try again in 5 hours");
  });

  test("falls back to limit line when no reset line present", () => {
    const text = "usage limit exceeded\nsome other text";
    expect(findRateLimitMessage(text)).toBe("usage limit exceeded");
  });

  test("returns null for non-rate-limit text", () => {
    expect(findRateLimitMessage("everything is fine")).toBeNull();
  });

  test("trims whitespace from matched line", () => {
    const text = "  resets 3pm (UTC)  ";
    expect(findRateLimitMessage(text)).toBe("resets 3pm (UTC)");
  });

  test("strips ANSI before matching", () => {
    const text = "\x1b[33mresets 3pm (UTC)\x1b[0m";
    expect(findRateLimitMessage(text)).toBe("resets 3pm (UTC)");
  });
});
