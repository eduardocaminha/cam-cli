// test/check-all.test.ts
//
// Unit tests for scripts/check-all.ts (US-001, US-004, CAM-59, CAM-60 PRD).
//
// All tests drive runGates with a fake spawnFn; no real subprocess is invoked.
// Coverage:
//   GATES manifest: length (10), order, correct cmd/args per gate.
//   runGates: all pass (exit 0), any fail (exit 1), bail stops early.
//   --json mode: onResults callback receives correctly shaped GateResult[].

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { GATES, runGates, type Gate, type GateResult, type SpawnFn } from '../scripts/check-all.ts';

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
	test('has 11 gates in order: typecheck, test, embed-vendor, lint, file-size, debt-markers, version-skips, coverage, dead-code, dup, ci-parity', () => {
		expect(GATES).toHaveLength(11);
		expect(GATES[0]?.name).toBe('typecheck');
		expect(GATES[1]?.name).toBe('test');
		expect(GATES[2]?.name).toBe('embed-vendor');
		expect(GATES[3]?.name).toBe('lint');
		expect(GATES[4]?.name).toBe('file-size');
		expect(GATES[5]?.name).toBe('debt-markers');
		expect(GATES[6]?.name).toBe('version-skips');
		expect(GATES[7]?.name).toBe('coverage');
		expect(GATES[8]?.name).toBe('dead-code');
		expect(GATES[9]?.name).toBe('dup');
		expect(GATES[10]?.name).toBe('ci-parity');
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

	test('lint gate: bunx biome lint --error-on-warnings', () => {
		const gate = GATES[3];
		expect(gate?.name).toBe('lint');
		expect(gate?.cmd).toBe('bunx');
		expect(gate?.args).toEqual(['biome', 'lint', '--error-on-warnings']);
	});

	test('file-size gate: bun scripts/check-file-sizes.ts', () => {
		const gate = GATES[4];
		expect(gate?.name).toBe('file-size');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['scripts/check-file-sizes.ts']);
	});

	test('debt-markers gate: bun scripts/check-debt-markers.ts', () => {
		const gate = GATES[5];
		expect(gate?.name).toBe('debt-markers');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['scripts/check-debt-markers.ts']);
	});

	test('version-skips gate: bun scripts/check-version-skips.ts', () => {
		const gate = GATES[6];
		expect(gate?.name).toBe('version-skips');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['scripts/check-version-skips.ts']);
	});

	test('coverage gate: bun scripts/check-coverage.ts', () => {
		const gate = GATES[7];
		expect(gate?.name).toBe('coverage');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['scripts/check-coverage.ts']);
	});

	test('dead-code gate: bunx --bun knip', () => {
		const gate = GATES[8];
		expect(gate?.name).toBe('dead-code');
		expect(gate?.cmd).toBe('bunx');
		expect(gate?.args).toEqual(['--bun', 'knip']);
	});

	test('dup gate: bunx jscpd --config .jscpd.json src scripts', () => {
		const gate = GATES[9];
		expect(gate?.name).toBe('dup');
		expect(gate?.cmd).toBe('bunx');
		expect(gate?.args).toEqual(['jscpd', '--config', '.jscpd.json', 'src', 'scripts']);
	});

	test('ci-parity gate: bun run check:ci-parity', () => {
		const gate = GATES[10];
		expect(gate?.name).toBe('ci-parity');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['run', 'check:ci-parity']);
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

// ---------------------------------------------------------------------------
// --json mode: onResults shape and manifest gate coverage
// ---------------------------------------------------------------------------

describe('--json mode (onResults)', () => {
	test('onResults receives array of GateResult with exactly name/status/durationMs keys', () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'alpha', cmd: 'bun', args: ['alpha'] },
			{ name: 'beta', cmd: 'bun', args: ['beta'] },
		];
		let captured: GateResult[] | null = null;
		runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		expect(captured).not.toBeNull();
		const results = captured as unknown as GateResult[];
		expect(results).toHaveLength(2);

		// Verify exact key set on each entry
		for (const entry of results) {
			const keys = Object.keys(entry).sort();
			expect(keys).toEqual(['durationMs', 'name', 'status']);
		}
	});

	test('onResults status is "ok" for passing gate and "fail" for failing gate', () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'pass-gate', cmd: 'bun', args: ['x'] },
			{ name: 'fail-gate', cmd: 'bun', args: ['y'] },
		];
		let captured: GateResult[] | null = null;
		runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		expect(results[0]?.status).toBe('ok');
		expect(results[1]?.status).toBe('fail');
	});

	test('onResults entries match manifest gate names in order', () => {
		const exitCodes = GATES.map(() => 0);
		const { fn } = makeRecordingSpawn(exitCodes);
		let captured: GateResult[] | null = null;
		runGates({ spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		expect(results).toHaveLength(GATES.length);
		for (let i = 0; i < GATES.length; i++) {
			expect(results[i]?.name).toBe(GATES[i]?.name);
		}
	});

	test('onResults entry names match manifest gate names (typecheck, test, embed-vendor, lint, file-size, debt-markers, version-skips, coverage, dead-code, dup, ci-parity)', () => {
		const { fn } = makeRecordingSpawn([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		let captured: GateResult[] | null = null;
		runGates({ spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		const names = results.map((r) => r.name);
		expect(names).toEqual(['typecheck', 'test', 'embed-vendor', 'lint', 'file-size', 'debt-markers', 'version-skips', 'coverage', 'dead-code', 'dup', 'ci-parity']);
	});

	test('onResults receives durationMs as a non-negative number', () => {
		const { fn } = makeRecordingSpawn([0]);
		const gates: Gate[] = [{ name: 'x', cmd: 'bun', args: ['x'] }];
		let captured: GateResult[] | null = null;
		runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		expect(typeof results[0]?.durationMs).toBe('number');
		expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	test('onResults result array parses cleanly as JSON and round-trips', () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'g1', cmd: 'bun', args: ['g1'] },
			{ name: 'g2', cmd: 'bun', args: ['g2'] },
		];
		let captured: GateResult[] | null = null;
		runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const json = JSON.stringify(captured);
		const parsed = JSON.parse(json) as GateResult[];
		expect(parsed).toHaveLength(2);
		expect(parsed[0]?.name).toBe('g1');
		expect(parsed[0]?.status).toBe('ok');
		expect(parsed[1]?.name).toBe('g2');
		expect(parsed[1]?.status).toBe('fail');
	});

	test('exit code is still nonzero even when onResults is provided and a gate fails', () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		const code = runGates({ gates, spawnFn: fn, onResults: () => {} });
		expect(code).toBe(1);
	});

	test('exit code is 0 when all pass and onResults is provided', () => {
		const { fn } = makeRecordingSpawn([0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		const code = runGates({ gates, spawnFn: fn, onResults: () => {} });
		expect(code).toBe(0);
	});
});
