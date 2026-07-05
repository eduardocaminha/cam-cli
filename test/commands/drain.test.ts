// test/commands/drain.test.ts
//
// Unit tests for `cam drain` — the inter-cycle drain kill-switch command.
//
// All fs operations are injected so the real filesystem is never touched.
// Tests cover the kill-switch module helpers and the drain command's
// --stop / --clear / status flows.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	DRAIN_STOP_MARKER,
	setDrainStop,
	clearDrainStop,
	isDrainStopSet,
} from '../../src/supervisor/drain-kill-switch.ts';
import {
	parseDrainArgs,
	runDrain,
} from '../../src/commands/drain.ts';

// ---------------------------------------------------------------------------
// DRAIN_STOP_MARKER constant
// ---------------------------------------------------------------------------

describe('DRAIN_STOP_MARKER', () => {
	test('value is .cam-drain-stop', () => {
		expect(DRAIN_STOP_MARKER).toBe('.cam-drain-stop');
	});
});

// ---------------------------------------------------------------------------
// drain-kill-switch module helpers
// ---------------------------------------------------------------------------

describe('setDrainStop', () => {
	test('calls injected writeFn with correct path', () => {
		const written: Array<{ path: string; data: string }> = [];
		setDrainStop('/fake/.claude', (path, data) => written.push({ path, data }));
		expect(written).toHaveLength(1);
		expect(written[0]?.path).toBe(join('/fake/.claude', DRAIN_STOP_MARKER));
		expect(written[0]?.data).toBe('');
	});

	test('is idempotent: calling twice calls writeFn twice (file presence is OS concern)', () => {
		const called: number[] = [];
		const writeFn = () => called.push(1);
		setDrainStop('/fake/.claude', writeFn);
		setDrainStop('/fake/.claude', writeFn);
		expect(called).toHaveLength(2);
	});

	test('swallows write errors (never throws)', () => {
		expect(() =>
			setDrainStop('/fake/.claude', () => {
				throw new Error('disk full');
			}),
		).not.toThrow();
	});
});

describe('clearDrainStop', () => {
	test('calls injected removeFn with correct path', () => {
		const removed: string[] = [];
		clearDrainStop('/fake/.claude', (path) => removed.push(path));
		expect(removed).toHaveLength(1);
		expect(removed[0]).toBe(join('/fake/.claude', DRAIN_STOP_MARKER));
	});

	test('is idempotent: missing file (ENOENT) does not throw', () => {
		expect(() =>
			clearDrainStop('/fake/.claude', () => {
				const err: NodeJS.ErrnoException = new Error('not found');
				err.code = 'ENOENT';
				throw err;
			}),
		).not.toThrow();
	});
});

describe('isDrainStopSet', () => {
	test('returns true when existsFn reports present', () => {
		expect(isDrainStopSet('/fake/.claude', () => true)).toBe(true);
	});

	test('returns false when existsFn reports absent', () => {
		expect(isDrainStopSet('/fake/.claude', () => false)).toBe(false);
	});

	test('calls existsFn with correct path', () => {
		const checked: string[] = [];
		isDrainStopSet('/fake/.claude', (p) => {
			checked.push(p);
			return false;
		});
		expect(checked[0]).toBe(join('/fake/.claude', DRAIN_STOP_MARKER));
	});

	test('returns false when existsFn throws (never throws)', () => {
		expect(
			isDrainStopSet('/fake/.claude', () => {
				throw new Error('unexpected');
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseDrainArgs
// ---------------------------------------------------------------------------

describe('parseDrainArgs', () => {
	test('empty args -> status mode', () => {
		expect(parseDrainArgs([])).toEqual({ flag: null, help: false });
	});

	test('--stop -> stop flag', () => {
		expect(parseDrainArgs(['--stop'])).toEqual({ flag: 'stop', help: false });
	});

	test('--clear -> clear flag', () => {
		expect(parseDrainArgs(['--clear'])).toEqual({ flag: 'clear', help: false });
	});

	test('--help -> help mode', () => {
		const result = parseDrainArgs(['--help']);
		expect(result?.help).toBe(true);
	});

	test('-h -> help mode', () => {
		const result = parseDrainArgs(['-h']);
		expect(result?.help).toBe(true);
	});

	test('unknown flag -> null (caller should print error)', () => {
		expect(parseDrainArgs(['--unknown'])).toBeNull();
	});

	test('excess args -> null', () => {
		expect(parseDrainArgs(['--stop', '--clear'])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// runDrain — injectable seams, no real fs
// ---------------------------------------------------------------------------

describe('runDrain', () => {
	test('--stop calls writeFn and returns 0', () => {
		const written: string[] = [];
		const exitCode = runDrain({
			flag: 'stop',
			cwd: '/fake/project',
			writeFn: (path) => written.push(path),
		});
		expect(exitCode).toBe(0);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(DRAIN_STOP_MARKER);
	});

	test('--clear calls removeFn and returns 0', () => {
		const removed: string[] = [];
		const exitCode = runDrain({
			flag: 'clear',
			cwd: '/fake/project',
			removeFn: (path) => removed.push(path),
		});
		expect(exitCode).toBe(0);
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain(DRAIN_STOP_MARKER);
	});

	test('status (no flag) calls existsFn and returns 0 when marker absent', () => {
		const checked: string[] = [];
		const exitCode = runDrain({
			flag: null,
			cwd: '/fake/project',
			existsFn: (path) => {
				checked.push(path);
				return false;
			},
		});
		expect(exitCode).toBe(0);
		expect(checked).toHaveLength(1);
		expect(checked[0]).toContain(DRAIN_STOP_MARKER);
	});

	test('status (no flag) calls existsFn and returns 0 when marker present', () => {
		const exitCode = runDrain({
			flag: null,
			cwd: '/fake/project',
			existsFn: () => true,
		});
		expect(exitCode).toBe(0);
	});

	test('--stop does NOT call removeFn (distinct from cam stop)', () => {
		const removed: string[] = [];
		runDrain({
			flag: 'stop',
			cwd: '/fake/project',
			writeFn: () => {},
			removeFn: (path) => removed.push(path),
		});
		expect(removed).toHaveLength(0);
	});

	test('--clear does NOT call writeFn', () => {
		const written: string[] = [];
		runDrain({
			flag: 'clear',
			cwd: '/fake/project',
			writeFn: (path) => written.push(path),
			removeFn: () => {},
		});
		expect(written).toHaveLength(0);
	});
});
