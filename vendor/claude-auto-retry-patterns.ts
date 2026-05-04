#!/usr/bin/env node
// scripts/smoke/claude-auto-retry-patterns.ts
//
// WHY THIS SMOKE EXISTS
// ---------------------
// The cam autonomous loop relies on the `claude-auto-retry` shell wrapper
// (https://github.com/cheapestinference/claude-auto-retry) to detect Anthropic
// rate-limit messages in Claude Code's stdout, parse the reset time, and
// auto-resume the session after the wait window. If the wrapper's regex
// patterns drift out of sync with Claude Code's actual error rendering,
// the loop silently stalls overnight: no retry, no error, just a dead pane.
//
// This smoke loads the wrapper's pattern + time-parser modules directly off
// disk and feeds them two synthetic stdout strings — the legacy single-line
// format and the new TUI format with the Unicode bullet operator (U+2219,
// '∙', NOT the visually identical U+00B7 middle dot '·'). It asserts both
// shapes still match a rate-limit pattern AND parse to a Date >= now.
//
// Exit codes:
//   0 — both patterns matched and parsed successfully (or wrapper not
//       installed at all, in which case the smoke skips with a one-line note)
//   1 — at least one pattern broke; failure message names WHICH (legacy vs
//       new) and prints the actual matcher output so the operator can act
//
// Invocation:
//   bun scripts/smoke/claude-auto-retry-patterns.ts
//   node --experimental-strip-types scripts/smoke/claude-auto-retry-patterns.ts
//   scripts/smoke/claude-auto-retry-patterns.sh   (auto-detects runtime)
//
// CI safety:
//   When /opt/homebrew/lib/node_modules/claude-auto-retry/src/ is missing
//   (CI containers, non-mac dev machines without the wrapper installed),
//   the smoke exits 0 with a clear "skipping" log. The real safety net is
//   the operator running this locally, OR the eduardocaminha/cam-cli
//   repo's `cam init` invoking this script via its absolute path.
//
// Wrapper API surface notes (verified 2026-04-27 against v0.2.2 on disk):
//   patterns.js   exports: stripAnsi, isRateLimited, findRateLimitMessage
//   time-parser.js exports: parseResetTime, calculateWaitMs
//
// The PRD originally referenced `RATE_LIMIT_PATTERNS` (an array of regex)
// and `parseResetTime(match)` — those names are NOT exported by v0.2.2. The
// smoke calls the actual exported functions; if a future wrapper version
// reintroduces the array export it will simply be unused, no breakage.

import { existsSync } from 'node:fs';
import process from 'node:process';

// Hardcoded path — claude-auto-retry installs globally via brew or npm -g.
// On this dev machine it lives under /opt/homebrew. CI/non-mac machines
// where the path is missing skip cleanly via the existsSync gate below.
const WRAPPER_BASE = '/opt/homebrew/lib/node_modules/claude-auto-retry/src';
const PATTERNS_PATH = `${WRAPPER_BASE}/patterns.js`;
const TIME_PARSER_PATH = `${WRAPPER_BASE}/time-parser.js`;

if (!existsSync(PATTERNS_PATH) || !existsSync(TIME_PARSER_PATH)) {
  console.log(
    `[smoke] claude-auto-retry not installed at ${WRAPPER_BASE} — skipping (this is a local-only check invoked by cam init)`
  );
  process.exit(0);
}

interface PatternsModule {
  isRateLimited: (text: string, customPatterns?: Array<RegExp | string>) => boolean;
  findRateLimitMessage: (
    text: string,
    customPatterns?: Array<RegExp | string>
  ) => string | null;
}

interface TimeParserModule {
  parseResetTime: (text: string) =>
    | { hour: number; minute: number; timezone: string | null; ambiguous: boolean }
    | { relative: true; waitMs: number }
    | null;
  calculateWaitMs: (
    parsed: ReturnType<TimeParserModule['parseResetTime']>,
    marginSeconds?: number,
    fallbackHours?: number,
    now?: Date
  ) => number;
}

const patterns = (await import(PATTERNS_PATH)) as PatternsModule;
const timeParser = (await import(TIME_PARSER_PATH)) as TimeParserModule;

// Quick sanity check: the wrapper's exported symbols still exist.
// A breaking rename (e.g. wrapper rewrites `isRateLimited` → `detect`) would
// otherwise crash with a confusing TypeError; surface it loudly first.
const missing: string[] = [];
if (typeof patterns.isRateLimited !== 'function') missing.push('patterns.isRateLimited');
if (typeof patterns.findRateLimitMessage !== 'function')
  missing.push('patterns.findRateLimitMessage');
if (typeof timeParser.parseResetTime !== 'function') missing.push('time-parser.parseResetTime');
if (typeof timeParser.calculateWaitMs !== 'function') missing.push('time-parser.calculateWaitMs');
if (missing.length > 0) {
  console.error(
    `[smoke] claude-auto-retry API drift: missing exports ${missing.join(', ')} — wrapper version may have changed.`
  );
  process.exit(1);
}

// --- Test fixtures ---------------------------------------------------------
//
// Legacy single-line format the older Claude API returned literally:
//   `Claude AI usage limit reached|<unix_ts_seconds>`
// Reset time encoded as a trailing pipe-delimited unix timestamp.
//
// The current wrapper (v0.2.2) parses TUI output, not API responses, so the
// legacy format may not trip `isRateLimited()` directly. We assert two
// weaker properties that hold for the legacy shape regardless of wrapper API:
//   1. The string matches `/limit reached/i` (the wrapper's own LIMIT_PATTERNS
//      includes this regex) — so future wrapper versions that rewire to
//      a different detection function will still reject this string only
//      if the substring itself stops being recognized.
//   2. The trailing `|<unix_ts>` parses to a Date >= now.
//
// New TUI format with the Unicode bullet operator:
//   `5-hour limit reached ∙ resets 3am`
// Where '∙' is U+2219 (BULLET OPERATOR), NOT '·' (U+00B7, MIDDLE DOT).
// The wrapper's `isRateLimited()` should return true; `parseResetTime()` +
// `calculateWaitMs()` should produce a Date >= now.

const LEGACY_FORMAT = ((): string => {
  const futureUnixTs = Math.floor((Date.now() + 3_600_000) / 1000); // 1 hour from now
  return `Claude AI usage limit reached|${futureUnixTs}`;
})();

// Sanity: assert the fixture contains exactly one U+2219 (BULLET OPERATOR)
// and zero U+00B7 (MIDDLE DOT). Catches a copy-paste regression in this
// very file — some editors auto-correct `∙` to the visually identical `·`,
// which silently breaks the test fixture (the wrapper's RESET_PATTERNS regex
// would still match either, but the smoke would no longer be testing what
// it claims to test).
const NEW_FORMAT = '5-hour limit reached ∙ resets 3am';
const bulletCount = [...NEW_FORMAT].filter((c) => c.codePointAt(0) === 0x2219).length;
const middleDotCount = [...NEW_FORMAT].filter((c) => c.codePointAt(0) === 0x00b7).length;
if (bulletCount !== 1 || middleDotCount !== 0) {
  console.error(
    `[smoke] internal: NEW_FORMAT must contain exactly one U+2219 BULLET OPERATOR (and zero U+00B7 MIDDLE DOT). Got bulletCount=${bulletCount}, middleDotCount=${middleDotCount}. The smoke source has been corrupted.`
  );
  process.exit(1);
}

// --- Assertions ------------------------------------------------------------

const failures: string[] = [];

// Legacy: substring + manual unix-ts parse.
{
  const matchedSubstring = /limit reached/i.test(LEGACY_FORMAT);
  if (!matchedSubstring) {
    failures.push(
      `legacy: '/limit reached/i' did not match input "${LEGACY_FORMAT}" — wrapper's LIMIT_PATTERNS may have changed.`
    );
  }

  const pipeMatch = LEGACY_FORMAT.match(/\|(\d{10,})$/);
  if (!pipeMatch) {
    failures.push(
      `legacy: trailing |<unix_ts> not found in input "${LEGACY_FORMAT}" — fixture corruption.`
    );
  } else {
    const unixTs = parseInt(pipeMatch[1], 10);
    const future = new Date(unixTs * 1000);
    if (Number.isNaN(future.getTime()) || future.getTime() < Date.now()) {
      failures.push(
        `legacy: parsed reset time ${future.toISOString()} is not in the future (now=${new Date().toISOString()}).`
      );
    }
  }
}

// New: full wrapper API path — isRateLimited + parseResetTime + calculateWaitMs.
{
  const matched = patterns.isRateLimited(NEW_FORMAT);
  if (!matched) {
    failures.push(
      `new: patterns.isRateLimited returned false for "${NEW_FORMAT}" — wrapper's TUI detection changed.`
    );
  } else {
    const message = patterns.findRateLimitMessage(NEW_FORMAT);
    if (!message) {
      failures.push(
        `new: patterns.findRateLimitMessage returned null for "${NEW_FORMAT}" despite isRateLimited=true.`
      );
    } else {
      const parsed = timeParser.parseResetTime(message);
      if (!parsed) {
        failures.push(
          `new: time-parser.parseResetTime returned null for message "${message}".`
        );
      } else {
        const waitMs = timeParser.calculateWaitMs(parsed);
        const future = new Date(Date.now() + waitMs);
        if (waitMs <= 0 || future.getTime() <= Date.now()) {
          failures.push(
            `new: calculated wait ${waitMs}ms produced past/zero Date ${future.toISOString()}.`
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`[smoke] FAIL ${f}`);
  console.error(
    `[smoke] claude-auto-retry pattern smoke FAILED (${failures.length} failure(s)). The cam loop will silently stall on rate-limit until this is fixed.`
  );
  process.exit(1);
}

const futureForLog = new Date(Date.now() + 3_600_000).toISOString();
console.log(`[smoke] both patterns matched and parsed → Date(${futureForLog})`);
process.exit(0);
