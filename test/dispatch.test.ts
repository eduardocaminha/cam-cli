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
//     - send-keys uses -l flag and 'Enter' as separate args (atomic)
//     - send-keys targets the correct pane ID

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	isOrchPaneIdle,
	sendKeysWhenIdle,
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
		let sleepCount = 0;

		sendKeysWhenIdle({
			paneId: '%3',
			text: '/cam-plan',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ', // idle on first call
			sleepFn: () => { sleepCount++; },
			idleTimeoutMs: 5,
		});

		// No sleep needed: idle on first check.
		expect(sleepCount).toBe(0);

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

	test('send-keys uses -l flag (literal)', () => {
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
		expect(sendKeys?.args).toContain('-l');
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
