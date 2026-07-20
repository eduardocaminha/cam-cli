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
//   sendKeysVerified (US-002, CAM-200):
//     - composer emptied immediately: delivered on the first attempt, no retry, no push-undelivered
//     - composer still holds the pushed line every time: retries up to maxAttempts, then emits
//       exactly one push-undelivered event via the injected logEvent, using a no-op sleepFn
//     - settle window (US-001, CAM-358): a capturePaneFn that would report the stale PRE-send
//       screen on the first post-send read, but the injected sleepFn advances a staged reader
//       to the POST-send screen before that read happens, still yields delivered on attempt 1

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	isOrchPaneIdle,
	isComposerEmptied,
	sendKeysWhenIdle,
	sendKeysVerified,
	SEND_KEYS_SETTLE_MS,
	type CapturePaneFn,
} from '../src/tmux/dispatch.ts';
import type { SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

/** Build a minimal fake TmuxSpawnFn that records calls and returns success. */
function makeSpawnFn(): TmuxSpawnFn & { calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
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
});

// ---------------------------------------------------------------------------
// isComposerEmptied
// ---------------------------------------------------------------------------

describe('isComposerEmptied', () => {
	test('returns true when the pushed text is absent from the tail', () => {
		expect(isComposerEmptied('> ', '/cam-review')).toBe(true);
	});

	test('returns false when the pushed text is still present in the tail', () => {
		expect(isComposerEmptied('> /cam-review', '/cam-review')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// sendKeysVerified
// ---------------------------------------------------------------------------

describe('sendKeysVerified', () => {
	test('delivered on first attempt: one send-keys call, no retry, no push-undelivered', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		sendKeysVerified({
			paneId: '%3',
			text: '/cam-plan',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ', // idle pre-send, composer empty post-send
			sleepFn: () => {},
			idleTimeoutMs: 5,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(0);
	});

	test('settle window honored: sleepFn advances the staged reader so the verify reads the post-send screen, not the stale pre-send one (US-001, CAM-358)', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];

		// The staged reader: before the settle sleep fires, a post-send capture
		// would still observe the PRE-send screen (payload still visibly sitting
		// in the composer, as a lagging real capture-pane would report
		// immediately after send-keys returns). Only the injected sleepFn -
		// when called with the settle window - flips `settled` and advances the
		// staged reader to the POST-send screen (composer emptied).
		let settled = false;
		const sleepFn = (ms: number) => {
			if (ms === SEND_KEYS_SETTLE_MS) settled = true;
		};

		const sendKeysCallCount = () =>
			spawnFn.calls.filter((c) => c.args[2] === 'send-keys').length;

		const capturePaneFn: CapturePaneFn = () => {
			// Before any send-keys call, this is the PRE-send idle-gate capture.
			if (sendKeysCallCount() === 0) return '> ';
			// Post-send verify capture: PRE-send (stale) screen until the settle
			// sleep has fired, POST-send (composer emptied) screen thereafter.
			return settled ? '> ' : '> /cam-spec';
		};

		sendKeysVerified({
			paneId: '%4',
			text: '/cam-spec',
			tmuxSpawnFn: spawnFn,
			capturePaneFn,
			sleepFn,
			idleTimeoutMs: 5,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// Delivered verdict must reflect the settled (POST-send) screen: exactly
		// one send-keys call, no retry, no push-undelivered. Without the settle
		// sleep between the send-keys spawn and the verify capture, this same
		// staged reader would report PRE-send on attempt 1's verify and force a
		// retry (or exhaustion), misreporting delivery.
		expect(sendKeysCallCount()).toBe(1);
		expect(events).toHaveLength(0);
	});

	test('composer never empties: retries up to maxAttempts, then emits one push-undelivered event', () => {
		const spawnFn = makeSpawnFn();
		const events: Array<{ kind: string; detail: unknown }> = [];
		let sleepCount = 0;
		let captureCalls = 0;

		// First capture (pre-send idle-gate) reports idle; every subsequent
		// capture (post-send verify) reports the composer still holding the
		// pushed line, simulating a dropped Enter that never submits.
		const capturePaneFn: CapturePaneFn = () => {
			captureCalls++;
			return captureCalls === 1 ? '> ' : '> /cam-review';
		};

		sendKeysVerified({
			paneId: '%9',
			text: '/cam-review',
			tmuxSpawnFn: spawnFn,
			capturePaneFn,
			sleepFn: () => {
				sleepCount++;
			}, // no-op: the test never actually waits
			idleTimeoutMs: 5,
			maxAttempts: 3,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(3);
		// One backoff sleep between each of the 3 attempts (2 retries).
		expect(sleepCount).toBeGreaterThanOrEqual(2);

		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
		expect(events[0]?.detail).toEqual({ paneId: '%9', retriesExhausted: 3 });
	});

	test('logEvent is optional: omitting it emits no event and does not throw', () => {
		const spawnFn = makeSpawnFn();

		expect(() =>
			sendKeysVerified({
				paneId: '%2',
				text: '/cam-ship',
				tmuxSpawnFn: spawnFn,
				capturePaneFn: () => '> /cam-ship', // composer never empties
				sleepFn: () => {},
				idleTimeoutMs: 5,
				maxAttempts: 2,
			}),
		).not.toThrow();

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeysCalls).toHaveLength(2);
	});
});
