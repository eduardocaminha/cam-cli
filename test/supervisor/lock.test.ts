// test/supervisor/lock.test.ts
//
// Unit tests for src/supervisor/lock.ts (single-supervisor concurrency guard, US-015).
//
// Coverage (AC5):
//   1. Fresh start: no existing lock -> acquires and writes { pid, startedAt, project }.
//   2. Second start with a LIVE pid -> rejected ({ acquired: false, holderPid }).
//   3. Second start with a STALE (dead) pid -> takes over and logs a stale-lock event.
//   Plus: parseLockInfo edge cases, release() removal, unparseable-lock takeover,
//   same-pid re-acquire.

import { describe, expect, test } from 'bun:test';
import {
	acquireSupervisorLock,
	parseLockInfo,
	type LockIo,
} from '../../src/supervisor/lock.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Fake LockIo backed by a single in-memory slot
// ---------------------------------------------------------------------------

interface FakeLockState {
	content: string | null;
	alivePids: Set<number>;
	events: WorkerEvent[];
}

function makeIo(state: FakeLockState): LockIo {
	return {
		read: () => state.content,
		write: (c) => {
			state.content = c;
		},
		remove: () => {
			state.content = null;
		},
		pidAlive: (pid) => state.alivePids.has(pid),
		clock: () => '2026-06-09T00:00:00Z',
		logEvent: (e) => state.events.push(e),
	};
}

// ---------------------------------------------------------------------------
// parseLockInfo
// ---------------------------------------------------------------------------

describe('parseLockInfo', () => {
	test('parses a well-formed lock', () => {
		const info = parseLockInfo(
			JSON.stringify({ pid: 4242, startedAt: '2026-06-09T00:00:00Z', project: 'cam-cli' }),
		);
		expect(info).toEqual({ pid: 4242, startedAt: '2026-06-09T00:00:00Z', project: 'cam-cli' });
	});

	test('returns null on invalid JSON', () => {
		expect(parseLockInfo('not json {')).toBeNull();
	});

	test('returns null when pid is missing or non-numeric', () => {
		expect(parseLockInfo(JSON.stringify({ startedAt: 'x', project: 'y' }))).toBeNull();
		expect(parseLockInfo(JSON.stringify({ pid: 'nope' }))).toBeNull();
		expect(parseLockInfo(JSON.stringify({ pid: Infinity }))).toBeNull();
	});

	test('defaults missing string fields to empty strings', () => {
		expect(parseLockInfo(JSON.stringify({ pid: 1 }))).toEqual({
			pid: 1,
			startedAt: '',
			project: '',
		});
	});
});

// ---------------------------------------------------------------------------
// acquireSupervisorLock
// ---------------------------------------------------------------------------

describe('acquireSupervisorLock', () => {
	test('fresh start writes the lock and reports acquired', () => {
		const state: FakeLockState = { content: null, alivePids: new Set([100]), events: [] };
		const io = makeIo(state);

		const result = acquireSupervisorLock(100, 'cam-cli', io);

		expect(result.acquired).toBe(true);
		if (!result.acquired) throw new Error('unreachable');
		expect(result.info).toEqual({ pid: 100, startedAt: '2026-06-09T00:00:00Z', project: 'cam-cli' });
		// The lock file now holds the same payload.
		expect(parseLockInfo(state.content ?? '')).toEqual(result.info);
		// No stale-lock event on a fresh start.
		expect(state.events).toHaveLength(0);
	});

	test('second start with a LIVE pid is rejected', () => {
		const state: FakeLockState = {
			content: JSON.stringify({ pid: 100, startedAt: '2026-06-08T00:00:00Z', project: 'cam-cli' }),
			alivePids: new Set([100, 200]), // pid 100 still alive
			events: [],
		};
		const io = makeIo(state);

		const result = acquireSupervisorLock(200, 'cam-cli', io);

		expect(result.acquired).toBe(false);
		if (result.acquired) throw new Error('unreachable');
		expect(result.holderPid).toBe(100);
		// The original lock is untouched.
		expect(parseLockInfo(state.content ?? '')?.pid).toBe(100);
		expect(state.events).toHaveLength(0);
	});

	test('second start with a STALE (dead) pid takes over and logs stale-lock', () => {
		const state: FakeLockState = {
			content: JSON.stringify({ pid: 100, startedAt: '2026-06-08T00:00:00Z', project: 'cam-cli' }),
			alivePids: new Set([200]), // pid 100 is dead, 200 (us) alive
			events: [],
		};
		const io = makeIo(state);

		const result = acquireSupervisorLock(200, 'cam-cli', io);

		expect(result.acquired).toBe(true);
		if (!result.acquired) throw new Error('unreachable');
		expect(result.info.pid).toBe(200);
		// The lock is now ours.
		expect(parseLockInfo(state.content ?? '')?.pid).toBe(200);
		// A stale-lock event recorded the takeover.
		expect(state.events).toHaveLength(1);
		const ev = state.events[0]!;
		expect(ev.kind).toBe('stale-lock');
		expect(ev.uuid).toBe('supervisor');
		expect(ev.detail).toMatchObject({ takenOverPid: 100, ownPid: 200, project: 'cam-cli' });
	});

	test('release() removes the lock file (idempotent)', () => {
		const state: FakeLockState = { content: null, alivePids: new Set([1]), events: [] };
		const io = makeIo(state);

		const result = acquireSupervisorLock(1, 'cam-cli', io);
		expect(result.acquired).toBe(true);
		if (!result.acquired) throw new Error('unreachable');
		expect(state.content).not.toBeNull();

		result.release();
		expect(state.content).toBeNull();
		// Double release does not throw.
		expect(() => result.release()).not.toThrow();
	});

	test('unparseable lock is taken over without a stale-lock event', () => {
		const state: FakeLockState = { content: 'garbage{', alivePids: new Set([5]), events: [] };
		const io = makeIo(state);

		const result = acquireSupervisorLock(5, 'cam-cli', io);

		expect(result.acquired).toBe(true);
		expect(parseLockInfo(state.content ?? '')?.pid).toBe(5);
		// No pid to report -> no event.
		expect(state.events).toHaveLength(0);
	});

	test('same pid re-acquiring its own lock refreshes without rejection', () => {
		const state: FakeLockState = {
			content: JSON.stringify({ pid: 7, startedAt: '2026-06-08T00:00:00Z', project: 'cam-cli' }),
			alivePids: new Set([7]),
			events: [],
		};
		const io = makeIo(state);

		const result = acquireSupervisorLock(7, 'cam-cli', io);

		expect(result.acquired).toBe(true);
		expect(state.events).toHaveLength(0);
		expect(parseLockInfo(state.content ?? '')?.startedAt).toBe('2026-06-09T00:00:00Z');
	});
});
