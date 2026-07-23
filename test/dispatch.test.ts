// test/dispatch.test.ts
//
// Unit tests for `src/tmux/dispatch.ts` (US-008: idle-guarantee before send-keys).
//
// What we cover:
//   isOrchPaneIdle:
//     - empty content returns false
//     - idle prompt '>' returns true
//     - idle prompt '❯' returns true
//     - spinner glyph makes it busy (false)
//     - active tool-call glyph (◆) makes it busy (false)
//     - spinner in upper lines, prompt only partially shown: still busy
//   sendKeysWhenIdle:
//     - idle on first capture: send-keys called, no sleep
//     - idle after one busy poll: send-keys called after one sleep
//     - timeout (always busy): fallback sends anyway, no indefinite block
//     - send-keys does NOT use -l (would make Enter literal); Enter is a separate trailing key (atomic)
//     - send-keys targets the correct pane ID
//     - omitting idleTimeoutMs uses the exported IDLE_WAIT_DEADLINE_MS default
//       (US-002/CAM-358 regression: the review round 1 fix for US-R1-001 found
//       nothing previously exercised the default-idleTimeoutMs wiring path)
//     - IDLE_WAIT_DEADLINE_MS boundary: exceeds the old 5_000 ms default
//   sendKeysVerified (US-002, CAM-200; geometry oracle US-002/CAM-359):
//     - cursor geometry unchanged after settle (post-send == per-send baseline): delivered on
//       the first attempt, no retry, no push-undelivered
//     - send-once guard (US-001, CAM-375): cursor geometry differs every sample (composer
//       never empties): send-keys fires EXACTLY ONCE (not maxAttempts times), retries up to
//       maxAttempts VERIFY attempts, then emits exactly one push-undelivered event via the
//       injected logEvent (retriesExhausted still equals maxAttempts, counting verify
//       attempts not physical sends), using a no-op sleepFn
//     - settle window (US-001, CAM-358): a sampleGeometryFn that would report the stale
//       PRE-send geometry on the first post-send read, but the injected sleepFn advances a
//       staged reader to the POST-send (baseline-matching) geometry before that read happens,
//       still yields delivered on attempt 1
//     - a null (unknown/fail-closed) geometry sample, for either the baseline or the post-send
//       read, is treated as NOT delivered and retried, never as delivered (US-002, CAM-359 AC5)
//     - prompt-row discriminator (US-001, CAM-364, replacing the tail-matching backstop from
//       US-R1-001): a geometry pair that reads unchanged is delivered when the captured cursor
//       row starts with the prompt glyph (measured empty-composer shape), and NOT delivered
//       when it does not (measured wrap-boundary collision shape: blank cursor row, prompt one
//       row up)
//     - discriminator reads through the dedicated visibleCaptureFn, never capturePaneFn
//       (review round 2 fix, US-R2-001, CAM-359): a scrollback-shaped capturePaneFn that would
//       falsely flip the verdict does not affect a genuinely-settled read
//     - idle-gate times out (US-002, CAM-373): sends EXACTLY ONCE with no verify/retry loop,
//       zero backoff sleeps, the geometry sampler never consulted, and exactly one
//       push-undelivered event with reason 'pane-not-idle' and retriesExhausted 1 PLUS one
//       dedicated 'orch-pane-busy' event carrying the same paneId/idleTimeoutMs (US-001,
//       CAM-401); the stderr warning is preserved
//   cursorRowStartsWithPrompt (US-001, CAM-364): prompt-at-start present/absent, both glyphs
//     (> and ❯), leading whitespace, mid-row glyph (not a match), out-of-range cursorY

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	isOrchPaneIdle,
	sendKeysWhenIdle,
	sendKeysVerified,
	cursorRowStartsWithPrompt,
	SEND_KEYS_SETTLE_MS,
	IDLE_WAIT_DEADLINE_MS,
	type CapturePaneFn,
} from '../src/tmux/dispatch.ts';
import type { CursorGeometry } from '../src/tmux/display-message.ts';
import type { SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';
import { withFakeClock } from './helpers/with-fake-clock.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

/**
 * Build a minimal fake TmuxSpawnFn that records calls and returns success.
 *
 * `sendKeysVerified` (US-002, CAM-359) defaults `sampleGeometryFn` to the
 * real `sampleCursorGeometry`, which shells out through the injected
 * `tmuxSpawnFn` for a `display-message` call. Tests below that only exercise
 * the idle-gate/send mechanics (and don't care about the delivery verdict)
 * still route through that default, so this fake answers `display-message`
 * with a fixed, always-identical geometry line — baseline and post-send
 * samples both read the same value, so the delivery verdict is "delivered on
 * attempt 1" by default without every idle-gate test having to inject its
 * own `sampleGeometryFn`. Tests that DO care about the delivery verdict
 * (the `sendKeysVerified` describe block) inject an explicit
 * `sampleGeometryFn` that overrides this.
 *
 * The same reasoning applies to the prompt-row discriminator (US-001,
 * CAM-364): a non-`display-message` call (the default `visibleCaptureFn`
 * fallback, `defaultCapturePaneFn`) answers with 27 rows whose last row (the
 * fixed `cursorY: 26` from the geometry line above) starts with the prompt
 * glyph, so the ambiguous "unchanged geometry" branch still reads delivered
 * by default without every unrelated test having to inject its own
 * `visibleCaptureFn`.
 */
function makeSpawnFn(): TmuxSpawnFn & { calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const isDisplayMessage = args.includes('display-message');
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(isDisplayMessage ? '2;26;80;30' : `${'\n'.repeat(26)}❯ `),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		return base;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

// ---------------------------------------------------------------------------
// isOrchPaneIdle
// ---------------------------------------------------------------------------

describe('isOrchPaneIdle', () => {
	test('empty string returns false (pane not yet ready)', () => {
		expect(isOrchPaneIdle('')).toBe(false);
		expect(isOrchPaneIdle('   \n  ')).toBe(false);
	});

	test('last line ending with > indicates idle', () => {
		expect(isOrchPaneIdle('some output\n> ')).toBe(true);
		expect(isOrchPaneIdle('some output\n>')).toBe(true);
	});

	test('last line ending with ❯ indicates idle', () => {
		expect(isOrchPaneIdle('output\n❯ ')).toBe(true);
		expect(isOrchPaneIdle('output\n❯')).toBe(true);
	});

	test('spinner glyph ⠋ in tail returns false (busy)', () => {
		expect(isOrchPaneIdle('⠋ Processing...\n>')).toBe(false);
	});

	test('spinner glyph ⠹ in tail returns false (busy)', () => {
		expect(isOrchPaneIdle('some output\n⠹ Running\n> ')).toBe(false);
	});

	test('active tool-call glyph ◆ in tail returns false (busy)', () => {
		expect(isOrchPaneIdle('output\n◆ Running bash command\n> ')).toBe(false);
	});

	test('all braille spinner chars are treated as busy', () => {
		const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
		for (const s of spinners) {
			expect(isOrchPaneIdle(`${s}\n> `)).toBe(false);
		}
	});

	test('content with only non-prompt text (no > or ❯) returns false', () => {
		expect(isOrchPaneIdle('running tool\nsome output')).toBe(false);
	});

	test('prompt in the 5th-to-last line is detected', () => {
		const lines = ['a', 'b', 'c', '> ', 'd', 'e'].join('\n');
		// The last 5 lines contain '> ' so idle should be true (no busy glyphs).
		expect(isOrchPaneIdle(lines)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// sendKeysWhenIdle
// ---------------------------------------------------------------------------

describe('sendKeysWhenIdle', () => {
	test('sends keys immediately when pane is idle on first check', () => {
		const spawnFn = makeSpawnFn();
		const sleeps: number[] = [];

		sendKeysWhenIdle({
			paneId: '%3',
			text: '/cam-plan',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ', // idle on first call, composer empty post-send
			sleepFn: (ms) => { sleeps.push(ms); },
			idleTimeoutMs: 5,
		});

		// No idle-gate poll sleep needed: idle on first check. The one recorded
		// sleep is the unconditional post-send settle window (US-001, CAM-358),
		// not an idle-gate poll.
		expect(sleeps).toEqual([SEND_KEYS_SETTLE_MS]);

		// send-keys was called.
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
	});

	test('polls until idle before sending keys', () => {
		const spawnFn = makeSpawnFn();
		let captureCount = 0;

		// First call: busy (spinner). Second call: idle.
		const capturePaneFn: CapturePaneFn = () => {
			captureCount++;
			return captureCount === 1 ? '⠋ Processing\n' : '> ';
		};

		let sleepCount = 0;
		sendKeysWhenIdle({
			paneId: '%5',
			text: '/cam-review',
			tmuxSpawnFn: spawnFn,
			capturePaneFn,
			sleepFn: () => { sleepCount++; },
			pollIntervalMs: 1,
			idleTimeoutMs: 1_000,
		});

		// One sleep between the two captures.
		expect(sleepCount).toBeGreaterThanOrEqual(1);
		expect(captureCount).toBeGreaterThanOrEqual(2);

		// send-keys was called after idle was detected.
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
	});

	test('falls back and sends when timeout expires (never blocks indefinitely)', () => {
		const spawnFn = makeSpawnFn();

		// capturePaneFn always returns busy.
		sendKeysWhenIdle({
			paneId: '%1',
			text: '/cam-ship',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '⠋ Busy forever\n',
			sleepFn: () => {}, // no-op: advances time without real wait
			pollIntervalMs: 1,
			idleTimeoutMs: 5, // tiny budget
		});

		// Despite never going idle, send-keys still fires (fallback).
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
	});

	test('send-keys does NOT use -l (regression: -l makes "Enter" literal and never submits)', () => {
		const spawnFn = makeSpawnFn();

		sendKeysWhenIdle({
			paneId: '%0',
			text: '/cam-plan 42',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sleepFn: () => {},
			idleTimeoutMs: 5,
		});

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		// Regression guard (memory: sendkeys-literal-enter-gotcha). `-l` makes EVERY
		// arg literal, so "Enter" would be typed as the text "Enter" and the command
		// would never submit. The text is a single non-key-name arg, already literal.
		expect(sendKeys?.args).not.toContain('-l');
		// Enter must remain the LAST arg and a recognised key so it submits.
		expect(sendKeys?.args.at(-1)).toBe('Enter');
		expect(sendKeys?.args).toContain('/cam-plan 42');
	});

	test('send-keys passes text and Enter as separate args in one call', () => {
		const spawnFn = makeSpawnFn();

		sendKeysWhenIdle({
			paneId: '%0',
			text: '/cam-next',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sleepFn: () => {},
			idleTimeoutMs: 5,
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		// Exactly one send-keys call.
		expect(sendKeysCalls).toHaveLength(1);
		const call = sendKeysCalls[0];
		// Text and Enter are discrete args.
		const textIdx = call?.args.indexOf('/cam-next') ?? -1;
		const enterIdx = call?.args.lastIndexOf('Enter') ?? -1;
		expect(textIdx).toBeGreaterThan(-1);
		expect(enterIdx).toBeGreaterThan(textIdx);
	});

	test('send-keys targets the correct pane ID', () => {
		const spawnFn = makeSpawnFn();

		sendKeysWhenIdle({
			paneId: '%7',
			text: '/cam-plan',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sleepFn: () => {},
			idleTimeoutMs: 5,
		});

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys?.args).toContain('%7');
	});

	test('IDLE_WAIT_DEADLINE_MS exceeds the old 5_000 ms default (US-002, CAM-358)', () => {
		// Boundary guard: if this constant were ever lowered back to (or below)
		// the pre-US-002 5_000 ms default, CAM-358's stated fix ("a routine long
		// tool call shouldn't blow the idle budget") would be silently lost.
		expect(IDLE_WAIT_DEADLINE_MS).toBeGreaterThan(5_000);
		expect(IDLE_WAIT_DEADLINE_MS).toBe(30_000);
	});

	test('omitting idleTimeoutMs falls back to IDLE_WAIT_DEADLINE_MS, not the old 5_000 ms default (US-002, CAM-358)', () => {
		// Regression coverage for the review round 1 finding on US-R1-001: every
		// other test in this file injects an explicit tiny idleTimeoutMs, so
		// nothing previously exercised the default path at dispatch.ts's
		// `idleTimeoutMs = IDLE_WAIT_DEADLINE_MS` wiring. This test omits the
		// option entirely and proves the effective deadline via the send-anyway
		// warning text, which embeds the deadline actually used.
		const spawnFn = makeSpawnFn();

		// Fake a monotonically-advancing clock driven only by the injected
		// sleepFn, so the test doesn't burn real wall-clock time waiting out a
		// 30s deadline. capturePaneFn always reports busy, so the idle-gate
		// never resolves early and must run out the full budget.
		withFakeClock(({ advance, chunks }) => {
			sendKeysWhenIdle({
				paneId: '%1',
				text: '/cam-plan',
				tmuxSpawnFn: spawnFn,
				capturePaneFn: () => '⠋ Busy forever\n', // never idle
				sleepFn: (ms) => {
					advance(ms);
				},
				pollIntervalMs: 1_000,
				// idleTimeoutMs intentionally omitted: exercises the default.
			});

			// The warning text embeds the exact idleTimeoutMs the wiring used.
			expect(chunks.join('')).toContain(`did not go idle within ${IDLE_WAIT_DEADLINE_MS} ms`);
			expect(chunks.join('')).not.toContain('did not go idle within 5000 ms');
		});

		// Fallback still sends despite never observing idle.
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// sendKeysVerified (geometry oracle, US-002, CAM-359)
// ---------------------------------------------------------------------------

/** A stock empty-composer baseline geometry used across tests below. */
const EMPTY_BASELINE: CursorGeometry = { cursorX: 2, cursorY: 26, paneWidth: 80, paneHeight: 30 };

/** A stock "text still in composer" geometry, distinct from EMPTY_BASELINE. */
const FILLED_GEOMETRY: CursorGeometry = { cursorX: 10, cursorY: 26, paneWidth: 80, paneHeight: 30 };

describe('sendKeysVerified', () => {
	test('geometry unchanged after settle: delivered on first attempt, no retry, no push-undelivered', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		sendKeysVerified({
			paneId: '%3',
			text: '/cam-plan',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ', // idle pre-send
			sampleGeometryFn: () => EMPTY_BASELINE, // baseline == post-send: delivered
			sleepFn: () => {},
			idleTimeoutMs: 5,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(0);
	});

	test('settle window honored: sleepFn advances the staged reader so the post-send sample reflects the settled geometry, not the stale pre-settle one (US-001, CAM-358)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		// The staged reader: before the settle sleep fires, a post-send sample
		// would still observe the FILLED (pre-settle) geometry, as a lagging
		// real tmux read would report immediately after send-keys returns. Only
		// the injected sleepFn — when called with the settle window — flips
		// `settled` and advances the staged reader to the baseline-matching
		// geometry.
		let settled = false;
		const sleepFn = (ms: number) => {
			if (ms === SEND_KEYS_SETTLE_MS) settled = true;
		};

		const sendKeysCallCount = () =>
			spawnFn.calls.filter((c) => c.args[2] === 'send-keys').length;

		// Sample #1 (per-attempt baseline, taken BEFORE send-keys) always reads
		// the empty baseline. Sample #2 (post-send verify, taken AFTER the
		// settle sleep) reads FILLED until settled, EMPTY_BASELINE thereafter.
		const sampleGeometryFn = (): CursorGeometry => {
			if (sendKeysCallCount() === 0) return EMPTY_BASELINE;
			return settled ? EMPTY_BASELINE : FILLED_GEOMETRY;
		};

		sendKeysVerified({
			paneId: '%4',
			text: '/cam-spec',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sampleGeometryFn,
			sleepFn,
			idleTimeoutMs: 5,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// Delivered verdict must reflect the settled (post-send) sample: exactly
		// one send-keys call, no retry, no push-undelivered. Without the settle
		// sleep between the send-keys spawn and the verify sample, this same
		// staged reader would report FILLED on attempt 1's verify and force a
		// retry (or exhaustion), misreporting delivery.
		expect(sendKeysCallCount()).toBe(1);
		expect(events).toHaveLength(0);
	});

	test('send-once guard (US-001, CAM-375): detected-idle pane, geometry oracle never confirms delivery — send-keys fires exactly ONCE (not maxAttempts times), retries up to maxAttempts VERIFY attempts, then emits one push-undelivered event (AC1, AC4; red on unmodified main: main records 3 send-keys calls, per this story\'s handoff.json red-sweep)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];
		let sleepCount = 0;

		// A unique geometry value on every single sample call (never repeats),
		// so the baseline sample and every post-send verify sample always
		// differ — "geometry that reads changed on every sample so delivery is
		// never confirmed" (AC1's oracle wording), simulating a dropped Enter
		// that never submits, so the composer keeps holding the pushed text.
		let sampleCalls = 0;
		const sampleGeometryFn = (): CursorGeometry => {
			sampleCalls++;
			return { cursorX: sampleCalls, cursorY: 26, paneWidth: 80, paneHeight: 30 };
		};

		sendKeysVerified({
			paneId: '%9',
			text: '/cam-review',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sampleGeometryFn,
			sleepFn: () => {
				sleepCount++;
			}, // no-op: the test never actually waits
			idleTimeoutMs: 5,
			maxAttempts: 3,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// AC1: exactly ONE physical send-keys invocation, not maxAttempts (3).
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		// AC5: settle sleep (once per verify attempt) + backoff sleep between
		// attempts are both still in place: 3 settle sleeps + 2 backoff sleeps.
		expect(sleepCount).toBeGreaterThanOrEqual(2);

		// AC4: retriesExhausted still equals maxAttempts (3) -- it counts VERIFY
		// attempts, not physical sends.
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
		expect(events[0]?.detail).toEqual({ paneId: '%9', retriesExhausted: 3, reason: 'retries-exhausted' });
	});

	test('logEvent is optional: omitting it emits no event and does not throw', () => {
		const spawnFn = makeSpawnFn();

		// Baseline (first sample) reads EMPTY_BASELINE; every subsequent
		// (post-send verify) sample reads FILLED_GEOMETRY: the pair never
		// matches, so delivery never succeeds and every verify attempt is
		// spent.
		let sampleCalls = 0;
		const sampleGeometryFn = (): CursorGeometry => {
			sampleCalls++;
			return sampleCalls === 1 ? EMPTY_BASELINE : FILLED_GEOMETRY;
		};

		expect(() =>
			sendKeysVerified({
				paneId: '%2',
				text: '/cam-ship',
				tmuxSpawnFn: spawnFn,
				capturePaneFn: () => '> ',
				sampleGeometryFn,
				sleepFn: () => {},
				idleTimeoutMs: 5,
				maxAttempts: 2,
			}),
		).not.toThrow();

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// 2 verify attempts.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
	});

	test('null baseline sample (fail-closed/unknown) is treated as NOT delivered and retried (US-002, CAM-359 AC5)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		// Every sample returns null (US-001's fail-closed result, e.g. a
		// non-zero tmux exit). If a null baseline were ever treated as
		// "matches", this would misreport delivery on attempt 1.
		sendKeysVerified({
			paneId: '%5',
			text: '/cam-next',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sampleGeometryFn: () => null,
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 2,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// 2 verify attempts.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	});

	test('null post-send sample (fail-closed/unknown) is treated as NOT delivered and retried, even with a valid matching baseline (US-002, CAM-359 AC5)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		// The baseline sample (call 1) always succeeds (EMPTY_BASELINE); every
		// subsequent (post-send verify) sample always fails closed (null). A
		// geometry oracle that treated "unknown" as "assume unchanged" would
		// misreport delivery here.
		let sampleCalls = 0;
		const sampleGeometryFn = (): CursorGeometry | null => {
			sampleCalls++;
			return sampleCalls === 1 ? EMPTY_BASELINE : null;
		};

		sendKeysVerified({
			paneId: '%6',
			text: '/cam-issue',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sampleGeometryFn,
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 2,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// 2 verify attempts.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	});

	test('comparison uses the full (x, y) pair: matching y with a different x is NOT delivered', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		// Same cursorY as EMPTY_BASELINE but a different cursorX — mirrors the
		// Ink composer growing-upward gotcha (US-001/US-002 findings): y alone
		// is not a sound discriminator, so this must NOT read as delivered.
		const sameYDifferentX: CursorGeometry = { ...EMPTY_BASELINE, cursorX: 33 };

		sendKeysVerified({
			paneId: '%7',
			text: '/cam-plan 1',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sampleGeometryFn: (_paneId, _spawnFn) => {
				// Baseline call vs verify call: alternate deterministically by
				// counting send-keys calls issued so far.
				const sendKeysDone = spawnFn.calls.filter((c) => c.args[2] === 'send-keys').length;
				return sendKeysDone === 0 ? EMPTY_BASELINE : sameYDifferentX;
			},
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 1,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	});

	test('geometry pair reads unchanged AND the cursor row is blank (measured wrap-boundary collision shape): prompt-row discriminator overrides to NOT delivered (US-001, CAM-364)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];
		// Measured repro: a 77-char payload ending in a space lands the wrapped
		// cursor back on the baseline column at the SAME (cursorX, cursorY) as
		// a genuinely empty composer.
		const payload = `${'w'.repeat(76)} `;

		sendKeysVerified({
			paneId: '%10',
			text: payload,
			tmuxSpawnFn: spawnFn,
			// Geometry alone looks IDENTICAL to a genuinely delivered state on
			// every sample -- the collision the module header documents:
			// cursor_y is pinned in production, so it never discriminates, and
			// this payload's length lands cursor_x back on the baseline column.
			sampleGeometryFn: () => EMPTY_BASELINE,
			// Discriminator reader (review round 2 fix, US-R2-001, CAM-359:
			// dedicated `visibleCaptureFn`, decoupled from `capturePaneFn`, which
			// here only feeds the idle-gate via its own default). Measured
			// shape: the row AT the reported cursor y is BLANK, with the prompt
			// and the payload's remnant one row up -- the composer never
			// actually cleared.
			visibleCaptureFn: () =>
				paneContentWithRows([
					[EMPTY_BASELINE.cursorY - 1, `❯ ${payload}`],
					[EMPTY_BASELINE.cursorY, ''],
				]),
			capturePaneFn: () => '> ', // idle-gate only: pane reads ready pre-send.
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 2,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// 2 verify attempts.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	});

	test('geometry pair reads unchanged AND the cursor row starts with the prompt glyph (measured empty-composer shape): delivered on attempt 1 (US-001, CAM-364)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		sendKeysVerified({
			paneId: '%11',
			text: 'some payload text',
			tmuxSpawnFn: spawnFn,
			sampleGeometryFn: () => EMPTY_BASELINE,
			// Measured shape: the genuinely empty composer's cursor row starts
			// with the rendered prompt glyph.
			visibleCaptureFn: () =>
				paneContentWithRow(EMPTY_BASELINE.cursorY, '❯ Try "how do I log an error?"'),
			capturePaneFn: () => '> ', // idle-gate only.
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 2,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(0);
	});

	test('discriminator reads through visibleCaptureFn, NOT capturePaneFn (review round 2 fix, US-R2-001, CAM-359; preserved across US-001/CAM-364): a scrollback-shaped capturePaneFn that would falsely show the prompt at the cursor row does not flip a genuinely-undelivered verdict', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];
		const payload = `${'z'.repeat(76)} `;

		sendKeysVerified({
			paneId: '%12',
			text: payload,
			tmuxSpawnFn: spawnFn,
			sampleGeometryFn: () => EMPTY_BASELINE,
			// capturePaneFn simulates a FULL-SCROLLBACK reader that happens to
			// show the prompt glyph at the reported cursorY row purely by
			// scrollback-history coincidence (the exact CAM-359 round 2 defect:
			// indexing scrollback content by a visible-screen row number). If the
			// discriminator still consulted this reader, it would misreport
			// delivered. The dedicated visibleCaptureFn reports the true,
			// still-undelivered blank row (measured collision shape). A trailing
			// idle-prompt line is appended so the idle-gate (which DOES read
			// through capturePaneFn, US-008) resolves idle on the first check
			// rather than exercising the unrelated timed-out/send-once path
			// (US-002, CAM-373): this test's subject is the discriminator, not
			// the idle-gate.
			capturePaneFn: () => `${paneContentWithRow(EMPTY_BASELINE.cursorY, '❯ unrelated scrollback line')}\n> `,
			visibleCaptureFn: () =>
				paneContentWithRows([
					[EMPTY_BASELINE.cursorY - 1, `❯ ${payload}`],
					[EMPTY_BASELINE.cursorY, ''],
				]),
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 2,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// 2 verify attempts.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	});

	test('idle-gate times out: sends EXACTLY ONCE with no verify/retry cycle, no backoff sleeps, the geometry sampler is never consulted, and emits a push-undelivered event (reason pane-not-idle) plus a dedicated orch-pane-busy event (US-002, CAM-373; US-001, CAM-401; red on main: main sends 3 times)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		const recordedSleeps: number[] = [];
		let geometrySamplerCalls = 0;

		// Derived (not frozen) from the pollIntervalMs override passed below, per
		// the derive-don't-freeze rule (US-002, CAM-377): the idle-gate's own
		// poll sleeps must equal this value exactly, so the same constant feeds
		// both the override and the AC2 assertion below instead of two
		// independently-typed literals that could drift apart.
		const POLL_INTERVAL_MS = 1_000;
		const IDLE_TIMEOUT_MS = 5_000;

		// Fake-clock idiom (reused from the sendKeysWhenIdle default-deadline
		// test above, now via the shared withFakeClock helper, US-001, CAM-362):
		// a monotonically-advancing clock driven only by the injected sleepFn,
		// and a capturePaneFn that never reports idle, so the idle-gate must run
		// out its full budget rather than resolving early.
		withFakeClock(({ advance, chunks: stderrChunks }) => {
			sendKeysVerified({
				paneId: '%7',
				text: '/cam-review',
				tmuxSpawnFn: spawnFn,
				capturePaneFn: () => '⠋ Busy forever\n', // never idle
				sampleGeometryFn: () => {
					geometrySamplerCalls++;
					return EMPTY_BASELINE;
				},
				sleepFn: (ms) => {
					recordedSleeps.push(ms);
					advance(ms);
				},
				pollIntervalMs: POLL_INTERVAL_MS,
				idleTimeoutMs: IDLE_TIMEOUT_MS,
				maxAttempts: 3,
				logEvent: (kind, detail) => events.push({ kind, detail }),
			});

			// AC4: the existing stderr warning on the timed-out path is preserved.
			expect(stderrChunks.join('')).toContain(`did not go idle within 5000 ms`);
		});

		// AC1: exactly one send-keys invocation, no verify/retry loop.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);

		// AC2: zero backoff sleeps. The old upper-bound assertion (every sleep
		// no greater than the pollIntervalMs override) was non-falsifiable: a
		// leaked computeBackoffMs value (default base 300, well under that
		// bound) would have slipped under it undetected. With
		// idleTimeoutMs=IDLE_TIMEOUT_MS (5_000) and pollIntervalMs=POLL_INTERVAL_MS
		// (1_000), the idle-gate's own poll loop produces exactly 5 sleeps, each
		// EXACTLY POLL_INTERVAL_MS (5_000 / 1_000, evenly divisible: every
		// `remaining` value the loop observes is itself a multiple of
		// POLL_INTERVAL_MS, so `Math.min(pollIntervalMs, remaining)` is always
		// POLL_INTERVAL_MS, never a smaller remainder). Strict equality means
		// any sleep of a different shape (a leaked backoff value, a truncated
		// final poll, or any other magnitude) makes this assertion fail. The
		// count assertion below (US-R1-002, CAM-376 review round 1) closes the
		// vacuous-empty-array gap the `.every()` call alone left open: `[].every`
		// is trivially true, so a regression that stops the idle-gate from
		// sleeping at all (or returns before the poll loop) would have passed
		// silently. The comparand is derived from the same constants fed to the
		// call above, not a frozen literal, per the derive-don't-freeze rule
		// (US-002, CAM-377). The geometry sampler is never consulted for a
		// delivery verdict on this path.
		expect(recordedSleeps).toHaveLength(IDLE_TIMEOUT_MS / POLL_INTERVAL_MS);
		expect(recordedSleeps.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true);
		expect(geometrySamplerCalls).toBe(0);

		// Falsifiability record, durable copy (US-R2-002, CAM-376 review round 2):
		// scripts/cam/handoff.json is a per-story ROTATING artifact, so a mutation
		// record written only there (as originally done for US-003) is gone by
		// the very next story's finalize commit. This tracked-source copy is the
		// durable one. Proof performed: a temporary `recordedSleeps.push(300)` (a
		// computeBackoffMs-shaped value: default retryBaseMs base=300, streak=1,
		// zero jitter, per src/tmux/dispatch.ts:544) was inserted immediately
		// after the sendKeysVerified call above, then reverted before commit.
		// Against the resulting array [1000,1000,1000,1000,1000,300], the OLD
		// `every((ms) => ms <= 1_000)` bound evaluated true (vacuous pass); the
		// NEW strict-equality assertion above evaluated false, and
		// `bun test test/dispatch.test.ts` under the live mutation exited 1 (one
		// failing assertion, at this line). retryBaseMs is never actually
		// reached on this idle-gate-timeout path (sendOnceUnverified skips the
		// retry/backoff loop entirely), which is why the mutation injects a
		// retryBaseMs-SHAPED value directly into recordedSleeps rather than
		// exercising the real option end to end.

		// AC3: exactly one push-undelivered event, reason pane-not-idle,
		// retriesExhausted === 1, plus one dedicated orch-pane-busy event
		// (US-001, CAM-401) carrying the same paneId and the configured
		// idleTimeoutMs.
		expect(events).toHaveLength(2);
		expect(events[0]?.kind).toBe('push-undelivered');
		expect(events[0]?.detail).toEqual({ paneId: '%7', retriesExhausted: 1, reason: 'pane-not-idle' });
		expect(events[1]?.kind).toBe('orch-pane-busy');
		expect(events[1]?.detail).toEqual({ paneId: '%7', idleTimeoutMs: IDLE_TIMEOUT_MS });
	});
});

// ---------------------------------------------------------------------------
// cursorRowStartsWithPrompt (prompt-row discriminator, US-001, CAM-364)
// ---------------------------------------------------------------------------

/** Build captured pane content whose only non-blank line is at `rowIndex`. */
function paneContentWithRow(rowIndex: number, rowContent: string): string {
	const lines = Array.from({ length: rowIndex + 1 }, () => '');
	lines[rowIndex] = rowContent;
	return lines.join('\n');
}

/** Build captured pane content with several rows set explicitly by index. */
function paneContentWithRows(entries: Array<[number, string]>): string {
	const maxRow = Math.max(...entries.map(([rowIndex]) => rowIndex));
	const lines = Array.from({ length: maxRow + 1 }, () => '');
	for (const [rowIndex, rowContent] of entries) lines[rowIndex] = rowContent;
	return lines.join('\n');
}

describe('cursorRowStartsWithPrompt', () => {
	test('returns true when the row at cursorY starts with the ASCII prompt glyph', () => {
		const content = paneContentWithRow(3, '> ');
		expect(cursorRowStartsWithPrompt(content, 3)).toBe(true);
	});

	test('returns true when the row at cursorY starts with the production U+276F glyph', () => {
		const content = paneContentWithRow(3, '❯ Try "how do I log an error?"');
		expect(cursorRowStartsWithPrompt(content, 3)).toBe(true);
	});

	test('tolerates leading whitespace/padding before the glyph', () => {
		const content = paneContentWithRow(3, '  ❯ ');
		expect(cursorRowStartsWithPrompt(content, 3)).toBe(true);
	});

	test('returns false for a blank row (measured wrap-boundary collision shape)', () => {
		const content = paneContentWithRow(3, '');
		expect(cursorRowStartsWithPrompt(content, 3)).toBe(false);
	});

	test('returns false when the prompt glyph appears mid-row, not at the start', () => {
		const content = paneContentWithRow(3, 'some payload text > more');
		expect(cursorRowStartsWithPrompt(content, 3)).toBe(false);
	});

	test('returns false for arbitrary non-prompt row content', () => {
		const content = paneContentWithRow(3, 'word wrapped continuation row');
		expect(cursorRowStartsWithPrompt(content, 3)).toBe(false);
	});

	test('out-of-range cursorY (noUncheckedIndexedAccess guard) fails closed to false', () => {
		const content = paneContentWithRow(2, '> ');
		expect(cursorRowStartsWithPrompt(content, 99)).toBe(false);
	});
});
