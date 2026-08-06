// test/check-all.test.ts
//
// Unit tests for scripts/check-all.ts (US-001, US-004, CAM-59, CAM-60 PRD;
// US-002, CAM-488 PRD).
//
// All tests drive runGates with a fake spawnFn; no real subprocess is invoked.
// The two full-manifest name/order assertions in the "--json mode" describe
// block below do NOT pass the real GATES array to runGates() either (US-R1-003,
// CAM-488 PRD): GATES now includes two in-process gates (coverage, skip-
// ratchet) whose real `run` fns shell out to `git diff --cached` and read real
// budget/expectations files off disk (see scripts/check-all.ts), which would
// give these unit tests an ambient git + cwd dependency. They instead pass
// `spawnOnlyGates`, a name/order-preserving spawn-shaped derivation of GATES
// (see helper below), so every gate in the fixture is a plain spawn gate
// dispatched through the fake spawnFn like everywhere else in this file.
// Coverage:
//   GATES manifest: length (14), order, correct cmd/args per spawn gate; the
//   coverage and skip-ratchet gates are in-process (a `run` fn, no cmd/args).
//   runGates: all pass (exit 0), any fail (exit 1), bail stops early.
//   --json mode: onResults callback receives correctly shaped GateResult[].

import { describe, expect, test } from 'bun:test';
import type { ResourceUsage, SyncSubprocess } from 'bun';

import { GATES, runGates, type Gate, type GateResult, type SpawnFn } from '../scripts/check-all.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResourceUsage(): ResourceUsage {
	return {
		contextSwitches: { voluntary: 0, involuntary: 0 },
		cpuTime: { user: 0, system: 0, total: 0 },
		maxRSS: 0,
		messages: { sent: 0, received: 0 },
		ops: { in: 0, out: 0 },
		shmSize: 0,
		signalCount: 0,
		swapCount: 0,
	};
}

function makeResult(exitCode: number, stdout?: string, stderr?: string): SyncSubprocess<'pipe' | 'inherit', 'pipe' | 'inherit'> {
	return {
		pid: 1,
		stdout: stdout === undefined ? undefined : Buffer.from(stdout),
		stderr: stderr === undefined ? undefined : Buffer.from(stderr),
		exitCode,
		success: exitCode === 0,
		resourceUsage: makeResourceUsage(),
		signalCode: undefined,
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
	const fn: SpawnFn = async (cmd, args) => {
		calls.push({ cmd, args: [...args] });
		const code = exitCodes[idx++] ?? 0;
		return makeResult(code);
	};
	return { calls, fn };
}

/**
 * Spawn-shaped derivation of GATES, preserving name and order but replacing
 * each entry (including the two real in-process gates) with a plain
 * cmd/args pair (US-R1-003, CAM-488 PRD). Used by the full-manifest tests in
 * the "--json mode" describe block below so they can assert on the real
 * manifest's names/order via a fake spawnFn without tripping the real
 * coverage/skip-ratchet gates' ambient git + real-file I/O. Derived from
 * GATES (not hand-duplicated) so it tracks the manifest automatically.
 */
function spawnOnlyGates(): Gate[] {
	return GATES.map((gate) => ({ name: gate.name, cmd: 'bun', args: [gate.name] }));
}

// ---------------------------------------------------------------------------
// GATES manifest
// ---------------------------------------------------------------------------

describe('GATES manifest', () => {
	test('has 15 gates in order: typecheck, test, embed-vendor, lint, file-size, debt-markers, version-skips, coverage, dead-code, dup, ci-parity, agents-md, test-sleeps, test-tmpdir, skip-ratchet', () => {
		expect(GATES).toHaveLength(15);
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
		expect(GATES[11]?.name).toBe('agents-md');
		expect(GATES[12]?.name).toBe('test-sleeps');
		expect(GATES[13]?.name).toBe('test-tmpdir');
		expect(GATES[14]?.name).toBe('skip-ratchet');
	});

	test('typecheck gate: bunx tsc --noEmit', () => {
		const gate = GATES[0];
		expect(gate?.cmd).toBe('bunx');
		expect(gate?.args).toContain('tsc');
		expect(gate?.args).toContain('--noEmit');
	});

	test('test gate: bun test --coverage', () => {
		const gate = GATES[1];
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['test', '--coverage']);
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

	test('coverage gate: in-process (US-002, CAM-488), reaches its verdict via a `run` fn, not a cmd/args spawn pair', () => {
		const gate = GATES[7];
		expect(gate?.name).toBe('coverage');
		expect(gate && 'run' in gate).toBe(true);
		expect(gate && 'cmd' in gate).toBe(false);
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

	test('agents-md gate: bun scripts/validate-agents-md.ts', () => {
		const gate = GATES[11];
		expect(gate?.name).toBe('agents-md');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['scripts/validate-agents-md.ts']);
	});

	test('test-sleeps gate: bun scripts/check-test-sleeps.ts', () => {
		const gate = GATES[12];
		expect(gate?.name).toBe('test-sleeps');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['scripts/check-test-sleeps.ts']);
	});

	test('test-tmpdir gate: bun scripts/check-test-tmpdir.ts', () => {
		const gate = GATES[13];
		expect(gate?.name).toBe('test-tmpdir');
		expect(gate?.cmd).toBe('bun');
		expect(gate?.args).toEqual(['scripts/check-test-tmpdir.ts']);
	});

	test('skip-ratchet gate: in-process (US-002, CAM-488), reaches its verdict via a `run` fn, not a cmd/args spawn pair', () => {
		const gate = GATES[14];
		expect(gate?.name).toBe('skip-ratchet');
		expect(gate && 'run' in gate).toBe(true);
		expect(gate && 'cmd' in gate).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runGates: exit code
// ---------------------------------------------------------------------------

describe('runGates exit code', () => {
	test('returns 0 when all gates pass', async () => {
		const { fn } = makeRecordingSpawn([0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		expect(await runGates({ gates, spawnFn: fn })).toBe(0);
	});

	test('returns 1 when any gate fails', async () => {
		const { fn } = makeRecordingSpawn([0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		expect(await runGates({ gates, spawnFn: fn })).toBe(1);
	});

	test('returns 1 when first gate fails (no bail)', async () => {
		const { fn } = makeRecordingSpawn([1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		expect(await runGates({ gates, spawnFn: fn })).toBe(1);
	});

	test('returns 1 when a gate is signal-terminated (null exitCode, success false)', async () => {
		const signalTerminated: SyncSubprocess<'inherit', 'inherit'> = {
			pid: 1,
			stdout: undefined,
			stderr: undefined,
			exitCode: null as unknown as number,
			success: false,
			resourceUsage: makeResourceUsage(),
			signalCode: 'SIGTERM',
		};
		const fn: SpawnFn = async () => signalTerminated;
		const gates: Gate[] = [{ name: 'a', cmd: 'bun', args: ['a'] }];
		expect(await runGates({ gates, spawnFn: fn })).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runGates: gate execution order and count (no bail)
// ---------------------------------------------------------------------------

describe('runGates without bail', () => {
	test('runs all gates even when first fails', async () => {
		const { calls, fn } = makeRecordingSpawn([1, 0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		await runGates({ gates, spawnFn: fn });
		expect(calls).toHaveLength(3);
	});

	test('runs all gates even when middle gate fails', async () => {
		const { calls, fn } = makeRecordingSpawn([0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		await runGates({ gates, spawnFn: fn });
		expect(calls).toHaveLength(3);
	});

	test('passes correct cmd and args to spawnFn', async () => {
		const { calls, fn } = makeRecordingSpawn([0]);
		const gates: Gate[] = [
			{ name: 'typecheck', cmd: 'bunx', args: ['tsc', '--noEmit'] },
		];
		await runGates({ gates, spawnFn: fn });
		expect(calls[0]?.cmd).toBe('bunx');
		expect(calls[0]?.args).toEqual(['tsc', '--noEmit']);
	});
});

// ---------------------------------------------------------------------------
// runGates: --bail
// ---------------------------------------------------------------------------

describe('runGates with bail', () => {
	test('stops after first failing gate', async () => {
		const { calls, fn } = makeRecordingSpawn([1, 0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		const code = await runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test('stops in the middle when second gate fails', async () => {
		const { calls, fn } = makeRecordingSpawn([0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		const code = await runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(1);
		expect(calls).toHaveLength(2);
	});

	test('runs all gates when all pass (bail is no-op)', async () => {
		const { calls, fn } = makeRecordingSpawn([0, 0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
		];
		const code = await runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(0);
		expect(calls).toHaveLength(3);
	});

	test('returns 1 and stops when bail set and gate fails', async () => {
		const { calls, fn } = makeRecordingSpawn([0, 0, 1, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
			{ name: 'c', cmd: 'bun', args: ['c'] },
			{ name: 'd', cmd: 'bun', args: ['d'] },
		];
		const code = await runGates({ gates, spawnFn: fn, bail: true });
		expect(code).toBe(1);
		expect(calls).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// --json mode: onResults shape and manifest gate coverage
// ---------------------------------------------------------------------------

describe('--json mode (onResults)', () => {
	test('onResults receives array of GateResult with exactly name/status/durationMs keys', async () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'alpha', cmd: 'bun', args: ['alpha'] },
			{ name: 'beta', cmd: 'bun', args: ['beta'] },
		];
		let captured: GateResult[] | null = null;
		await runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		expect(captured).not.toBeNull();
		const results = captured as unknown as GateResult[];
		expect(results).toHaveLength(2);

		// Verify exact key set on each entry
		for (const entry of results) {
			const keys = Object.keys(entry).sort();
			expect(keys).toEqual(['durationMs', 'name', 'status']);
		}
	});

	test('onResults status is "ok" for passing gate and "fail" for failing gate', async () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'pass-gate', cmd: 'bun', args: ['x'] },
			{ name: 'fail-gate', cmd: 'bun', args: ['y'] },
		];
		let captured: GateResult[] | null = null;
		await runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		expect(results[0]?.status).toBe('ok');
		expect(results[1]?.status).toBe('fail');
	});

	test('onResults entries match manifest gate names in order', async () => {
		const gates = spawnOnlyGates();
		const exitCodes = gates.map(() => 0);
		const { fn } = makeRecordingSpawn(exitCodes);
		let captured: GateResult[] | null = null;
		await runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		expect(results).toHaveLength(GATES.length);
		for (let i = 0; i < GATES.length; i++) {
			expect(results[i]?.name).toBe(GATES[i]?.name);
		}
	});

	test('onResults entry names match manifest gate names (typecheck, test, embed-vendor, lint, file-size, debt-markers, version-skips, coverage, dead-code, dup, ci-parity, agents-md, test-sleeps, test-tmpdir, skip-ratchet)', async () => {
		const gates = spawnOnlyGates();
		const { fn } = makeRecordingSpawn([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		let captured: GateResult[] | null = null;
		await runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		const names = results.map((r) => r.name);
		expect(names).toEqual(['typecheck', 'test', 'embed-vendor', 'lint', 'file-size', 'debt-markers', 'version-skips', 'coverage', 'dead-code', 'dup', 'ci-parity', 'agents-md', 'test-sleeps', 'test-tmpdir', 'skip-ratchet']);
	});

	test('onResults receives durationMs as a non-negative number', async () => {
		const { fn } = makeRecordingSpawn([0]);
		const gates: Gate[] = [{ name: 'x', cmd: 'bun', args: ['x'] }];
		let captured: GateResult[] | null = null;
		await runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const results = captured as unknown as GateResult[];
		expect(typeof results[0]?.durationMs).toBe('number');
		expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	test('onResults result array parses cleanly as JSON and round-trips', async () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'g1', cmd: 'bun', args: ['g1'] },
			{ name: 'g2', cmd: 'bun', args: ['g2'] },
		];
		let captured: GateResult[] | null = null;
		await runGates({ gates, spawnFn: fn, onResults: (r) => { captured = r; } });

		const json = JSON.stringify(captured);
		const parsed = JSON.parse(json) as GateResult[];
		expect(parsed).toHaveLength(2);
		expect(parsed[0]?.name).toBe('g1');
		expect(parsed[0]?.status).toBe('ok');
		expect(parsed[1]?.name).toBe('g2');
		expect(parsed[1]?.status).toBe('fail');
	});

	test('exit code is still nonzero even when onResults is provided and a gate fails', async () => {
		const { fn } = makeRecordingSpawn([0, 1]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		const code = await runGates({ gates, spawnFn: fn, onResults: () => {} });
		expect(code).toBe(1);
	});

	test('exit code is 0 when all pass and onResults is provided', async () => {
		const { fn } = makeRecordingSpawn([0, 0]);
		const gates: Gate[] = [
			{ name: 'a', cmd: 'bun', args: ['a'] },
			{ name: 'b', cmd: 'bun', args: ['b'] },
		];
		const code = await runGates({ gates, spawnFn: fn, onResults: () => {} });
		expect(code).toBe(0);
	});
});
