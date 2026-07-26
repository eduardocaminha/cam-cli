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
//       the first attempt, no remediation, no event
//     - send-once guard (US-001, CAM-375): cursor geometry differs every sample (composer
//       never empties): the PAYLOAD-CARRYING send-keys fires EXACTLY ONCE, bare submit
//       remediations run between verify attempts, then exactly one push-undelivered event
//       records maxAttempts VERIFY attempts
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
//     - pane-not-idle path (US-003, CAM-406): the same geometry/prompt-row
//       verify + bare-submit remediation loop runs while payload text is sent once
//     - idle-gate cadence (US-R1-004, CAM-406): a fake clock pins the exact
//       derived poll count and interval independently of post-gate sleeps
//     - both terminal reasons report maxAttempts VERIFY attempts; pane-not-idle
//       is selected if and only if the idle gate timed out
//     - the timed-out path's post-gate sleeps are exactly the existing settle +
//       derived backoff sequence, with no extra constant/wait
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
	test('first-try success still emits no event and spawns exactly one send-keys call', () => {
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

	test('bare submit remediation on the idle path uses one explicit Enter and never repeats payload text', () => {
		const spawnFn = makeSpawnFn();
		const payload = '/cam-review';
		let sampleCalls = 0;

		sendKeysVerified({
			paneId: '%8',
			text: payload,
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sampleGeometryFn: () => (++sampleCalls === 2 ? FILLED_GEOMETRY : EMPTY_BASELINE),
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 3,
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(2);
		expect(sendKeysCalls[0]?.args.slice(2)).toEqual(['send-keys', '-t', '%8', payload, 'Enter']);
		expect(sendKeysCalls[1]?.args.slice(2)).toEqual(['send-keys', '-t', '%8', 'Enter']);
		expect(sendKeysCalls.slice(1).some((call) => call.args.includes(payload))).toBe(false);
	});

	test('push-recovered after remediation emits once with the idle-path remediation count', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];
		let sampleCalls = 0;

		sendKeysVerified({
			paneId: '%6',
			text: '/cam-next',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sampleGeometryFn: () => (++sampleCalls === 2 ? FILLED_GEOMETRY : EMPTY_BASELINE),
			sleepFn: () => {},
			idleTimeoutMs: 5,
			maxAttempts: 3,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(events).toEqual([
			{
				kind: 'push-recovered',
				detail: { paneId: '%6', submitRemediations: 1, paneWasIdle: true },
			},
		]);
		expect(events.some((event) => event.kind === 'push-undelivered')).toBe(false);
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

	test('send-once guard (US-001, CAM-375): exhausted verification sends payload text once, bare submits between attempts, and only push-undelivered', () => {
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

		// The payload-bearing call stays physically unique. Each later call is
		// exactly one bare Enter remediation and can never duplicate the text.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		const payloadCalls = sendKeysCalls.filter((c) => c.args.includes('/cam-review'));
		expect(payloadCalls).toHaveLength(1);
		expect(sendKeysCalls).toHaveLength(3);
		expect(sendKeysCalls.slice(1).every((c) => c.args.slice(2).join(' ') === 'send-keys -t %9 Enter')).toBe(true);
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

		// Send-once guard: payload text appears in exactly one physical call.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls.filter((c) => c.args.includes('/cam-ship'))).toHaveLength(1);
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

		// Send-once guard: payload text appears in exactly one physical call.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls.filter((c) => c.args.includes('/cam-next'))).toHaveLength(1);
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

		// Send-once guard: payload text appears in exactly one physical call.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls.filter((c) => c.args.includes('/cam-issue'))).toHaveLength(1);
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

		// Send-once guard: payload text appears in exactly one physical call.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls.filter((c) => c.args.includes(payload))).toHaveLength(1);
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

		// Send-once guard: payload text appears in exactly one physical call.
		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls.filter((c) => c.args.includes(payload))).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	});

	test('idle-gate timeout preserves the exact injected poll cadence before the unified post-gate flow (US-R1-004, CAM-406)', () => {
		const POLL_INTERVAL_MS = 1_000;
		const IDLE_TIMEOUT_MS = 5_000;
		const recordedGateSleeps: number[] = [];
		const recordedSpawn = makeSpawnFn();
		let payloadSent = false;
		const spawnFn: TmuxSpawnFn = (cmd, args, opts) => {
			if (args[2] === 'send-keys' && args.includes('/cam-review')) payloadSent = true;
			return recordedSpawn(cmd, args, opts);
		};

		withFakeClock(({ advance, chunks }) => {
			sendKeysVerified({
				paneId: '%7',
				text: '/cam-review',
				tmuxSpawnFn: spawnFn,
				capturePaneFn: () => '⠋ Busy forever\n',
				pollIntervalMs: POLL_INTERVAL_MS,
				idleTimeoutMs: IDLE_TIMEOUT_MS,
				sampleGeometryFn: () => EMPTY_BASELINE,
				visibleCaptureFn: () => paneContentWithRow(EMPTY_BASELINE.cursorY, '❯ '),
				sleepFn: (ms) => {
					if (payloadSent) return;
					recordedGateSleeps.push(ms);
					advance(ms);
				},
				maxAttempts: 1,
			});

			expect(chunks.join('')).toContain(`did not go idle within ${IDLE_TIMEOUT_MS} ms`);
		});

		// Both assertions are derived from the injected values: the count closes
		// the vacuous [].every gap, while strict equality rejects a leaked
		// settle/backoff magnitude or a truncated final poll.
		expect(recordedGateSleeps).toHaveLength(IDLE_TIMEOUT_MS / POLL_INTERVAL_MS);
		expect(recordedGateSleeps.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true);
	});

	test('pane-not-idle path runs the unified verify loop with bounded blocking on the pane-not-idle path and sends payload text exactly once', () => {
		const MAX_ATTEMPTS = 4;
		const RETRY_BASE_MS = 20;
		const RETRY_MAX_MS = 50;
		const recordedSpawn = makeSpawnFn();
		const payload = '/cam-review';
		const lifecycle: string[] = [];
		const recordedSleeps: number[] = [];
		const events: Array<{ kind: string; detail: unknown }> = [];
		const spawnFn: TmuxSpawnFn = (cmd, args, opts) => {
			if (args[2] === 'send-keys') {
				lifecycle.push(args.includes(payload) ? 'send:payload' : 'send:bare-submit');
			}
			return recordedSpawn(cmd, args, opts);
		};
		let sampleCalls = 0;
		let visibleCaptureCalls = 0;
		sendKeysVerified({
			paneId: '%7',
			text: payload,
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '⠋ Busy forever\n',
			idleTimeoutMs: 0,
			sampleGeometryFn: () => {
				sampleCalls++;
				lifecycle.push(`sample:${sampleCalls}`);
				return sampleCalls === 1 || sampleCalls === MAX_ATTEMPTS + 1
					? EMPTY_BASELINE
					: FILLED_GEOMETRY;
			},
			visibleCaptureFn: () => {
				visibleCaptureCalls++;
				return paneContentWithRow(EMPTY_BASELINE.cursorY, '❯ ');
			},
			sleepFn: (ms) => { recordedSleeps.push(ms); },
			maxAttempts: MAX_ATTEMPTS,
			retryBaseMs: RETRY_BASE_MS,
			retryMaxMs: RETRY_MAX_MS,
			jitterFraction: 0.25,
			randomFn: () => 0.5,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});
		// The baseline is immediately before the one payload send.
		expect(lifecycle.slice(0, 2)).toEqual(['sample:1', 'send:payload']);
		const sendKeysCalls = recordedSpawn.calls.filter((call) => call.args[2] === 'send-keys');
		expect(sendKeysCalls.filter((call) => call.args.includes(payload))).toHaveLength(1);
		expect(sendKeysCalls.slice(1).every((call) => call.args.at(-1) === 'Enter')).toBe(true);
		expect(visibleCaptureCalls).toBe(1);
		expect(events).toEqual([
			{
				kind: 'push-recovered',
				detail: { paneId: '%7', submitRemediations: MAX_ATTEMPTS - 1, paneWasIdle: false },
			},
		]);
		// randomFn=0.5 makes the jitter multiplier exactly 1. Derive the exact
		// post-gate settle/backoff sequence from the injected base/cap/attempts.
		const expectedBackoffs = Array.from(
			{ length: MAX_ATTEMPTS - 1 },
			(_, index) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** index),
		);
		const expectedSleeps = expectedBackoffs.flatMap((backoff) => [SEND_KEYS_SETTLE_MS, backoff]);
		expectedSleeps.push(SEND_KEYS_SETTLE_MS);
		expect(recordedSleeps).toEqual(expectedSleeps);
	});

	test('retriesExhausted equals maxAttempts on both terminal reasons and reason tracks only the idle timeout', () => {
		const MAX_ATTEMPTS = 4;
		const runTerminal = (timedOut: boolean) => {
			const spawnFn = makeSpawnFn();
			const events: Array<{ kind: string; detail: unknown }> = [];
			let sampleCalls = 0;
			sendKeysVerified({
				paneId: timedOut ? '%8' : '%9',
				text: '/cam-ship',
				tmuxSpawnFn: spawnFn,
				capturePaneFn: () => (timedOut ? '⠋ Busy forever\n' : '> '),
				idleTimeoutMs: 0,
				sampleGeometryFn: () => (++sampleCalls === 1 ? EMPTY_BASELINE : FILLED_GEOMETRY),
				sleepFn: () => {},
				maxAttempts: MAX_ATTEMPTS,
				jitterFraction: 0,
				logEvent: (kind, detail) => events.push({ kind, detail }),
			});
			return events;
		};
		expect(runTerminal(true)).toEqual([
			{
				kind: 'push-undelivered',
				detail: { paneId: '%8', retriesExhausted: MAX_ATTEMPTS, reason: 'pane-not-idle' },
			},
			{ kind: 'orch-pane-busy', detail: { paneId: '%8', idleTimeoutMs: 0 } },
		]);
		expect(runTerminal(false)).toEqual([
			{
				kind: 'push-undelivered',
				detail: { paneId: '%9', retriesExhausted: MAX_ATTEMPTS, reason: 'retries-exhausted' },
			},
		]);
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
