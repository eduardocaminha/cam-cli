// test/check-all-inprocess-gates.test.ts
//
// Regression tests for the in-process coverage/skip-ratchet gate behaviour
// introduced by US-002 (CAM-488 PRD) and left uncovered by committed tests
// (US-R1-001, CAM-488 PRD review round 1 CRITICAL finding).
//
// Everything committed before this file asserted only the STRUCTURAL shape of
// the two collapsed gates ('run' in gate / 'cmd' not in gate,
// test/check-all.test.ts:135-140,177-182) or the suite-gate output-capture
// plumbing with gate lists that never included an in-process gate
// (test/check-all-capture.test.ts). Nothing committed proved:
//   1. runGates actually THREADS the captured suite blob into gate.run
//      (scripts/check-all.ts:332-333) -- verbatim, exactly once per gate.
//   2. An empty blob fails BOTH in-process gates closed.
//   3. A below-floor coverage blob fails the coverage gate.
//   4. The three skip-ratchet failure modes (crashed run, below pass-floor,
//      skip-count mismatch) each fail independently.
//   5. A failing suite ('test' gate exitCode != 0) does not contaminate the
//      coverage/skip-ratchet verdicts, which are derived purely from blob
//      content, never from the suite gate's own exit code.
//   6. A gate.run that THROWS (e.g. coverageGate.run's readFileSync ENOENT on
//      a missing budget file) is contained as a failed GateResult by
//      runInProcessGate's try/catch, not left to escape runGates and abort
//      the rest of the spine (US-R1-002, CAM-488 PRD round-1 finding).
//
// These tests drive the REAL coverageGate/skipRatchetGate entries pulled off
// the GATES manifest (not re-implementations), with a real fixture budget
// and lane-expectations tree under a mkdtemp'd cwd, per the story's
// instruction to use "an injected gates array of the two in-process gates".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from './helpers/test-tmpdir';
import { join } from 'node:path';
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

function makeResult(exitCode: number, stdout: string, stderr: string): SyncSubprocess<'pipe' | 'inherit', 'pipe' | 'inherit'> {
	return {
		pid: 1,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
		exitCode,
		success: exitCode === 0,
		resourceUsage: makeResourceUsage(),
		signalCode: undefined,
	};
}

/** The real in-process gates, pulled off the manifest -- never re-implemented. */
const coverageGate = GATES.find((g) => g.name === 'coverage');
const skipRatchetGate = GATES.find((g) => g.name === 'skip-ratchet');
if (!coverageGate || !skipRatchetGate) {
	throw new Error('expected GATES to contain "coverage" and "skip-ratchet" in-process gates');
}

/** A synthetic spawn gate standing in for the real 'test' gate. */
const testGate: Gate = { name: 'test', cmd: 'bun', args: ['test', '--coverage'] };

function resultByName(results: GateResult[], name: string): GateResult | undefined {
	return results.find((r) => r.name === name);
}

/**
 * A blob shaped like a healthy `bun test --coverage` run: completion tally
 * present, pass count clears the fixture's passFloor (100) with headroom
 * >= MIN_PASS_FLOOR_HEADROOM (50), skip count matches the fixture's
 * expectedSkips (2), and the coverage table clears both fixture floors
 * (functions 80, lines 75).
 */
const HEALTHY_BLOB = ['Ran 165 tests across 10 files. [1.00s]', '', ' 160 pass', ' 5 fail', ' 2 skip', 'All files | 90.00 | 85.00', ''].join(
	'\n',
);

/** Same shape as HEALTHY_BLOB but with both coverage metrics below the fixture floors. */
const BELOW_FLOOR_COVERAGE_BLOB = [
	'Ran 165 tests across 10 files. [1.00s]',
	'',
	' 160 pass',
	' 5 fail',
	' 2 skip',
	'All files | 50.00 | 40.00',
	'',
].join('\n');

// ---------------------------------------------------------------------------
// Fixture cwd: real scripts/coverage-budget.json + test/helpers/lane-
// expectations.json, so the real coverageGate.run / skipRatchetGate.run
// (which read these files off `cwd` via their own production defaults) have
// something real to compare the threaded blob against.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = createTestTmpdir('cam-check-all-inprocess-');
	mkdirSync(join(tmpDir, 'scripts'), { recursive: true });
	mkdirSync(join(tmpDir, 'test', 'helpers'), { recursive: true });
	writeFileSync(join(tmpDir, 'scripts', 'coverage-budget.json'), JSON.stringify({ floors: { functions: 80, lines: 75 } }));
	writeFileSync(
		join(tmpDir, 'test', 'helpers', 'lane-expectations.json'),
		JSON.stringify({
			lanes: {
				host: { expectedSkips: 2, passFloor: 100 },
				container: { expectedSkips: 0, passFloor: 0 },
			},
			triage: { hardDependency: 0, legitimateEnvironmental: 0 },
		}),
	);
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Direct threading proof: the captured blob reaches gate.run verbatim,
//    exactly once, regardless of what the gate does with it.
// ---------------------------------------------------------------------------

describe('runGates threads the captured suite blob into gate.run (scripts/check-all.ts:332-333)', () => {
	function makeRecordingInProcessGate(name: string): { received: string[]; gate: Gate } {
		const received: string[] = [];
		const gate: Gate = {
			name,
			run: (suiteOutput) => {
				received.push(suiteOutput);
				return { ok: true, errors: [] };
			},
		};
		return { received, gate };
	}

	test('a gate after "test" receives the exact combined stdout+stderr blob, verbatim, exactly once', async () => {
		const { received, gate: recorder } = makeRecordingInProcessGate('recorder');
		const fn: SpawnFn = async () => makeResult(0, 'STDOUT-BLOB', 'STDERR-BLOB');

		await runGates({ gates: [testGate, recorder], spawnFn: fn });

		expect(received).toEqual(['STDOUT-BLOBSTDERR-BLOB']);
	});

	test('an in-process gate that runs before any "test" gate receives the empty initial suiteOutput', async () => {
		const { received, gate: recorder } = makeRecordingInProcessGate('recorder');

		await runGates({ gates: [recorder] });

		expect(received).toEqual(['']);
	});
});

// ---------------------------------------------------------------------------
// 2. Empty blob fails both real in-process gates closed.
// ---------------------------------------------------------------------------

describe('empty blob fails both in-process gates closed', () => {
	test('coverage and skip-ratchet both fail when no "test" gate ran (suiteOutput stays "")', async () => {
		let results: GateResult[] = [];
		const code = await runGates({
			gates: [coverageGate, skipRatchetGate],
			cwd: tmpDir,
			onResults: (r) => {
				results = r;
			},
		});

		expect(code).toBe(1);
		expect(resultByName(results, 'coverage')?.status).toBe('fail');
		expect(resultByName(results, 'skip-ratchet')?.status).toBe('fail');
	});
});

// ---------------------------------------------------------------------------
// 3. Healthy blob (positive control) proves the blob is really threaded, not
//    silently dropped: if the threading regressed back to always passing ''
//    to gate.run, this test would fail as if the blob were empty.
// ---------------------------------------------------------------------------

describe('healthy blob makes both real in-process gates pass', () => {
	test('coverage and skip-ratchet both pass when fed a floor-met, lane-matched blob', async () => {
		const fn: SpawnFn = async () => makeResult(0, '', HEALTHY_BLOB);
		let results: GateResult[] = [];

		const code = await runGates({
			gates: [testGate, coverageGate, skipRatchetGate],
			spawnFn: fn,
			cwd: tmpDir,
			onResults: (r) => {
				results = r;
			},
		});

		expect(code).toBe(0);
		expect(resultByName(results, 'coverage')?.status).toBe('ok');
		expect(resultByName(results, 'skip-ratchet')?.status).toBe('ok');
	});
});

// ---------------------------------------------------------------------------
// 4. Below-floor coverage blob fails the coverage gate specifically.
// ---------------------------------------------------------------------------

describe('below-floor coverage blob fails the coverage gate', () => {
	test('coverage fails (both metrics below floor) while skip-ratchet still passes from the same blob', async () => {
		const fn: SpawnFn = async () => makeResult(0, '', BELOW_FLOOR_COVERAGE_BLOB);
		let results: GateResult[] = [];

		const code = await runGates({
			gates: [testGate, coverageGate, skipRatchetGate],
			spawnFn: fn,
			cwd: tmpDir,
			onResults: (r) => {
				results = r;
			},
		});

		expect(code).toBe(1);
		const coverageResult = resultByName(results, 'coverage');
		expect(coverageResult?.status).toBe('fail');
		expect(resultByName(results, 'skip-ratchet')?.status).toBe('ok');
	});
});

// ---------------------------------------------------------------------------
// 5. Three skip-ratchet failure modes, each fed straight through the real
//    skipRatchetGate.
// ---------------------------------------------------------------------------

describe('skip-ratchet gate: three failure modes', () => {
	test('mode 1: crashed/garbage run (no "Ran N tests across M files." tally) fails as a non-completion', () => {
		const crashedBlob = 'error: Cannot find module "foo"\nbun: command crashed\n';
		const outcome = skipRatchetGate.run?.(crashedBlob, tmpDir);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.errors[0]).toContain('did not report a completion tally');
	});

	test('mode 2: pass count below the recorded passFloor fails as a partial/crashed run', () => {
		const belowFloorPassBlob = ['Ran 92 tests across 3 files. [0.5s]', '', ' 90 pass', ' 0 fail', ' 2 skip', ''].join('\n');
		const outcome = skipRatchetGate.run?.(belowFloorPassBlob, tmpDir);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.errors[0]).toContain('below recorded');
		expect(outcome?.errors[0]).toContain('passFloor');
	});

	test('mode 3: skip-count mismatch fails even though completion tally and pass floor are both satisfied', () => {
		const skipMismatchBlob = ['Ran 165 tests across 10 files. [1.00s]', '', ' 160 pass', ' 0 fail', ' 5 skip', ''].join('\n');
		const outcome = skipRatchetGate.run?.(skipMismatchBlob, tmpDir);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.errors[0]).toContain('observed 5 skip, expected 2');
	});
});

// ---------------------------------------------------------------------------
// 6. Anti-contamination: a failing suite gate must not flip the coverage/
//    skip-ratchet verdicts, which are derived purely from blob content.
// ---------------------------------------------------------------------------

describe('anti-contamination: a failing "test" gate does not contaminate coverage/skip-ratchet rows', () => {
	test('test gate fails (exitCode 1) but a healthy blob still makes coverage and skip-ratchet pass', async () => {
		const fn: SpawnFn = async () => makeResult(1, '', HEALTHY_BLOB);
		let results: GateResult[] = [];

		const code = await runGates({
			gates: [testGate, coverageGate, skipRatchetGate],
			spawnFn: fn,
			cwd: tmpDir,
			onResults: (r) => {
				results = r;
			},
		});

		// Overall code is still 1 because the 'test' gate itself failed --
		// but that failure must not bleed into the other two verdicts.
		expect(code).toBe(1);
		expect(resultByName(results, 'test')?.status).toBe('fail');
		expect(resultByName(results, 'coverage')?.status).toBe('ok');
		expect(resultByName(results, 'skip-ratchet')?.status).toBe('ok');
	});
});

// ---------------------------------------------------------------------------
// 7. An in-process gate that throws must be contained as a failed GateResult,
//    not escape runGates and abort the rest of the spine (US-R1-002, CAM-488
//    PRD round-1 WARNING finding). Reproduces the exact repro from the
//    finding: coverageGate.run does readFileSync(cwd + '/scripts/coverage-
//    budget.json'), which throws ENOENT when that file is missing.
// ---------------------------------------------------------------------------

describe('an in-process gate that throws is contained, not left to escape runGates (scripts/check-all.ts:266-269)', () => {
	test('coverageGate.run throwing ENOENT on a missing budget file fails only that gate row; later gates still run and onResults still fires', async () => {
		const bareCwd = createTestTmpdir('cam-check-all-inprocess-bare-');
		try {
			const fn: SpawnFn = async () => makeResult(0, '', HEALTHY_BLOB);
			let results: GateResult[] = [];
			const trailingGate: Gate = { name: 'trailing', run: () => ({ ok: true, errors: [] }) };

			const code = await runGates({
				gates: [testGate, coverageGate, trailingGate],
				spawnFn: fn,
				cwd: bareCwd,
				onResults: (r) => {
					results = r;
				},
			});

			expect(code).toBe(1);
			const coverageResult = resultByName(results, 'coverage');
			expect(coverageResult?.status).toBe('fail');
			// onResults must still fire with every gate present, including the
			// one scheduled after the thrower -- a caught throw must not
			// truncate the loop.
			expect(results.map((r) => r.name)).toEqual(['test', 'coverage', 'trailing']);
			expect(resultByName(results, 'trailing')?.status).toBe('ok');
		} finally {
			rmSync(bareCwd, { recursive: true, force: true });
		}
	});

	test('a gate whose run fn throws a plain string (not an Error) is still contained with a string-coerced message', async () => {
		const throwingGate: Gate = {
			name: 'thrower',
			run: () => {
				throw 'boom';
			},
		};
		const trailingGate: Gate = { name: 'trailing', run: () => ({ ok: true, errors: [] }) };
		let results: GateResult[] = [];

		const code = await runGates({
			gates: [throwingGate, trailingGate],
			onResults: (r) => {
				results = r;
			},
		});

		expect(code).toBe(1);
		expect(resultByName(results, 'thrower')?.status).toBe('fail');
		expect(resultByName(results, 'trailing')?.status).toBe('ok');
	});
});
