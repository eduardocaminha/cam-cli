import { test, expect, describe } from "bun:test";
import { parseResetTime, calculateWaitMs } from "../../src/retry/time-parser";
import type { AbsoluteParsedTime, RelativeParsedTime } from "../../src/retry/time-parser";

describe("parseResetTime — absolute times", () => {
  test("parses 'resets 3pm (UTC)'", () => {
    const r = parseResetTime("resets 3pm (UTC)") as AbsoluteParsedTime;
    expect(r).not.toBeNull();
    expect(r.hour).toBe(15);
    expect(r.minute).toBe(0);
    expect(r.timezone).toBe("UTC");
    expect(r.ambiguous).toBe(false);
  });

  test("parses 'resets at 3:00 PM'", () => {
    const r = parseResetTime("resets at 3:00 PM") as AbsoluteParsedTime;
    expect(r).not.toBeNull();
    expect(r.hour).toBe(15);
    expect(r.minute).toBe(0);
    expect(r.timezone).toBeNull();
    expect(r.ambiguous).toBe(false);
  });

  test("parses 'resets 12am' (midnight)", () => {
    const r = parseResetTime("resets 12am") as AbsoluteParsedTime;
    expect(r.hour).toBe(0);
  });

  test("parses 'resets 12pm' (noon)", () => {
    const r = parseResetTime("resets 12pm") as AbsoluteParsedTime;
    expect(r.hour).toBe(12);
  });

  test("marks hour as ambiguous when no am/pm and 1-12", () => {
    const r = parseResetTime("resets 3") as AbsoluteParsedTime;
    expect(r.ambiguous).toBe(true);
    expect(r.hour).toBe(3);
  });

  test("not ambiguous for hour 0", () => {
    // hour 0 without am/pm is unambiguous (midnight)
    const r = parseResetTime("resets 0") as AbsoluteParsedTime;
    expect(r.ambiguous).toBe(false);
  });

  test("parses hour with minutes", () => {
    const r = parseResetTime("resets at 2:30pm") as AbsoluteParsedTime;
    expect(r.hour).toBe(14);
    expect(r.minute).toBe(30);
  });

  test("parses 1am correctly (not 13)", () => {
    const r = parseResetTime("resets 1am") as AbsoluteParsedTime;
    expect(r.hour).toBe(1);
  });
});

describe("parseResetTime — relative times", () => {
  test("parses 'try again in 5 hours'", () => {
    const r = parseResetTime("try again in 5 hours") as RelativeParsedTime;
    expect(r.relative).toBe(true);
    expect(r.waitMs).toBe(5 * 3_600_000);
  });

  test("parses 'try again in 30 minutes'", () => {
    const r = parseResetTime("try again in 30 minutes") as RelativeParsedTime;
    expect(r.relative).toBe(true);
    expect(r.waitMs).toBe(30 * 60_000);
  });

  test("parses 'resets in: 2 hours'", () => {
    const r = parseResetTime("resets in: 2 hours") as RelativeParsedTime;
    expect(r.relative).toBe(true);
    expect(r.waitMs).toBe(2 * 3_600_000);
  });

  test("parses short unit 'h'", () => {
    const r = parseResetTime("try again in 1 h") as RelativeParsedTime;
    expect(r.relative).toBe(true);
    expect(r.waitMs).toBe(3_600_000);
  });

  test("parses short unit 'm'", () => {
    const r = parseResetTime("try again in 45 m") as RelativeParsedTime;
    expect(r.relative).toBe(true);
    expect(r.waitMs).toBe(45 * 60_000);
  });

  test("parses 'wait 3 hours'", () => {
    const r = parseResetTime("wait 3 hours") as RelativeParsedTime;
    expect(r.relative).toBe(true);
    expect(r.waitMs).toBe(3 * 3_600_000);
  });
});

describe("parseResetTime — invalid input", () => {
  test("returns null for unrelated text", () => {
    expect(parseResetTime("everything is fine")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseResetTime("")).toBeNull();
  });

  test("absolute match takes precedence over relative when both present", () => {
    // "resets 3pm" should win over any relative-looking text
    const r = parseResetTime("resets 3pm try again in 5 hours") as AbsoluteParsedTime;
    expect("relative" in r).toBe(false);
    expect(r.hour).toBe(15);
  });
});

describe("calculateWaitMs", () => {
  const UTC_TZ = "UTC";

  // Helper: create a Date at a specific UTC hour on a fixed date
  function utcDate(hour: number, minute = 0): Date {
    return new Date(`2026-05-14T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  }

  test("null parsed returns fallback (5h + 60s margin)", () => {
    const result = calculateWaitMs(null);
    expect(result).toBe((5 * 3600 + 60) * 1000);
  });

  test("null parsed with custom fallback hours", () => {
    const result = calculateWaitMs(null, 60, 3);
    expect(result).toBe((3 * 3600 + 60) * 1000);
  });

  test("relative parsed: waitMs + margin", () => {
    const parsed: RelativeParsedTime = { relative: true, waitMs: 30 * 60_000 };
    const result = calculateWaitMs(parsed, 60);
    expect(result).toBe(30 * 60_000 + 60_000);
  });

  test("absolute: resets at 15:00 UTC, current time 14:00 UTC → ~1h + margin", () => {
    const now = utcDate(14, 0);
    const parsed: AbsoluteParsedTime = { hour: 15, minute: 0, timezone: UTC_TZ, ambiguous: false };
    const result = calculateWaitMs(parsed, 60, 5, now);
    // Should be ~1 hour + 60 seconds
    expect(result).toBeGreaterThan(3600_000);
    expect(result).toBeLessThan(3700_000);
  });

  test("absolute: resets at 15:00 UTC, current time 16:00 UTC → wraps to ~23h + margin", () => {
    const now = utcDate(16, 0);
    const parsed: AbsoluteParsedTime = { hour: 15, minute: 0, timezone: UTC_TZ, ambiguous: false };
    const result = calculateWaitMs(parsed, 60, 5, now);
    // Should be ~23 hours + margin
    expect(result).toBeGreaterThan(23 * 3600_000);
    expect(result).toBeLessThan(24 * 3600_000);
  });

  test("ambiguous hour: picks sooner future time", () => {
    // Current time is 10:00 UTC. Ambiguous hour=3.
    // 3am UTC = 03:00 => 17h in future; 3pm UTC = 15:00 => 5h in future. Should pick 15:00.
    const now = utcDate(10, 0);
    const parsed: AbsoluteParsedTime = { hour: 3, minute: 0, timezone: UTC_TZ, ambiguous: true };
    const result = calculateWaitMs(parsed, 0, 5, now);
    // 5 hours away (15:00 - 10:00)
    expect(result).toBeGreaterThan(4 * 3600_000);
    expect(result).toBeLessThan(6 * 3600_000);
  });

  test("invalid timezone falls back to fallback hours", () => {
    const parsed: AbsoluteParsedTime = { hour: 15, minute: 0, timezone: "InvalidTZ/Bogus", ambiguous: false };
    const result = calculateWaitMs(parsed, 60, 5);
    expect(result).toBe((5 * 3600 + 60) * 1000);
  });
});
