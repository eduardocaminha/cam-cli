// test/check-all.test.ts
//
// Unit tests for scripts/check-all.ts (US-001, CAM-59 PRD).
//
// All tests drive runGates with a fake spawnFn; no real subprocess is invoked.
// Coverage:
//   GATES manifest: length, order, correct cmd/args per gate.
//   runGates: all pass (exit 0), any fail (exit 1), bail stops early.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { GATES, runGates, type Gate, type SpawnFn } from '../scripts/check-all.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResult(exitCode: number): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [],
		stdout: '',
		stderr: exitCode !== 0 ? 'error' : '',
		status: exitCode,
		signal: null,
	};
}

interface Call {
	cmd: string;
	args: string[];
}

/** Returns a recording fake spawnFn driven by a fixed sequence of exit codes. */
function makeRecordingSpawn(exitCodes: number[]): { calls: Call[]; fn: SpawnFn } {
	const calls: Call[] = [];
	let idx = 0;
	const fn: SpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args: [...args] });
		const code = exitCodes[idx++] ?? 0;
		return makeResult(code);
	};
	return { calls, fn };
}

// ---------------------------------------------------------------------------
// GATES manifest
// ---------------------------------------------------------------------------

describe('GATES manifest', () => {
	test('has 3 gates in order: typecheck, test, embed-vendor', () => {
		expect(GATES).toHaveLength(3);
		expect(GATES[0]?.name).toBe('typecheck');
		expect(GATES[1]?.name).toBe('test');
		expect(GATES[2]?.name).toBe('embed-vendor');
	});

	test('typecheck gate: bunx tsc --noEmit', () => {
		const gate = GATES[0];
		expect(gate?.cmd).toBe('bunx');
		expect(gate?.args).toContain('tsc');
		expect(gate?.args).toContain('--noEmit');
	});

	test('test gate: bun test', () => {
		const gate = GATES[1];
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['test']);
	});

	test('embed-vendor gate: bun scripts/generate-embedded-vendor.ts --check', () => {
		const gate = GATES[2];
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toContain('scripts/generate-embedded-vendor.ts');
		expect(gate?.args).toContain('--check');
	});
});

// ---------------------------------------------------------------------------
// runGates: exit code
// ---------------------------------------------------------------------------

describe('runGates exit code', () => {
	test('returns 0 when all gates pass', () => {
		const { fn } = makeRecordingSpawn([0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		expect(runGates({ gates, spawnFn: fn })).toBe(0);
	});

	test('returns 1 when any gate fails', () => {
		const { fn } = makeRecordingSpawn([0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		expect(runGates({ gates, spawnFn: fn })).toBe(1);
	});

	test('returns 1 when first gate fails (no bail)', () => {
		const { fn } = makeRecordingSpawn([1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		expect(runGates({ gates, spawnFn: fn })).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runGates: gate execution order and count (no bail)
// ---------------------------------------------------------------------------

describe('runGates without bail', () => {
	test('runs all gates even when first fails', () => {
		const { calls, fn } = makeRecordingSpawn([1, 0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		runGates({ gates, spawnFn: fn });
		expect(calls).toHaveLength(3);
	});

	test('runs all gates even when middle gate fails', () => {
		const { calls, fn } = makeRecordingSpawn([0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		runGates({ gates, spawnFn: fn });
		expect(calls).toHaveLength(3);
	});

	test('passes correct cmd and args to spawnFn', () => {
		const { calls, fn } = makeRecordingSpawn([0]);
		const gates: Gate[] = [
			{ name: 'typecheck', cmd: 'bunx', args: ['tsc', '--noEmit'] },
		];
		runGates({ gates, spawnFn: fn });
		expect(calls[0]?.cmd).toBe('bunx');
		expect(calls[0]?.args).toEqual(['tsc', '--noEmit']);
	});
});

// ---------------------------------------------------------------------------
// runGates: --bail
// ---------------------------------------------------------------------------

describe('runGates with bail', () => {
	test('stops after first failing gate', () => {
		const { calls, fn } = makeRecordingSpawn([1, 0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		const code = runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test('stops in the middle when second gate fails', () => {
		const { calls, fn } = makeRecordingSpawn([0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		const code = runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(1);
		expect(calls).toHaveLength(2);
	});

	test('runs all gates when all pass (bail is no-op)', () => {
		const { calls, fn } = makeRecordingSpawn([0, 0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		const code = runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(0);
		expect(calls).toHaveLength(3);
	});

	test('returns 1 and stops when bail set and gate fails', () => {
		const { calls, fn } = makeRecordingSpawn([0, 0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
			{ name: 'd', cmd: 'bun', args: ['d'] },
		];
		const code = runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(1);
		expect(calls).toHaveLength(3);
	});
});
