// test/test-in-container.test.ts
//
// Unit tests for scripts/test-in-container.ts (US-001, CAM-186 PRD; waiver +
// exact skip-count assertion coverage added in US-006, CAM-424 PRD; the
// checkSuiteRan positive-evidence guard on the container lane added in
// US-R2-002, review round 2 finding on this file).
//
// All tests drive parseBunOutput and runInContainerTests with injected fakes;
// no real Docker daemon is touched.  The parse logic is tested against inline
// Bun-output fixtures that match the format produced by `bun test v1.x.x`.
//
// Coverage:
//   parseBunOutput: pass/fail/skip counts, failingTests extraction.
//   runInContainerTests: exit code 0 only when fail count is 0 AND the
//     checkSuiteRan positive-evidence guard passes AND the observed skip
//     count exactly matches the injected container-lane expectation;
//     non-zero on a failure, a crashed/partial run (no completion tally or
//     pass count below the recorded passFloor), or a skip-count mismatch;
//     ensureFn call count; container name threading.
//   makeDefaultExecFn (via a spawnSync-observing integration-style check on
//     the real production fn is not exercised here -- covered instead by
//     grepping the built argv string through a thin exported seam is not
//     needed since CONTAINER_WAIVED_DEPS/WAIVER_ENV_VAR wiring is asserted
//     structurally through the file's own source text in the acceptance
//     criteria oracles).

import { describe, expect, test } from 'bun:test';
import {
	buildContainerTestExecArgv,
	parseBunOutput,
	runInContainerTests,
} from '../scripts/test-in-container.ts';
import type { LaneExpectationsFile } from '../scripts/check-skip-ratchet.ts';

/**
 * Minimal fake test/helpers/lane-expectations.json reader for a given
 * container expectedSkips and (optional) passFloor. passFloor defaults to 0
 * so existing skip-comparison-focused tests are unaffected by the
 * checkSuiteRan positive-evidence guard.
 */
function fakeExpectations(
	containerExpectedSkips: number,
	containerPassFloor = 0,
): () => LaneExpectationsFile {
	return () => ({
		lanes: {
			host: { expectedSkips: 0, passFloor: 0 },
			container: { expectedSkips: containerExpectedSkips, passFloor: containerPassFloor },
		},
		triage: { hardDependency: 0, legitimateEnvironmental: 0 },
	});
}

// ---------------------------------------------------------------------------
// Fixtures: recorded Bun test output (format: bun test v1.x.x, non-TTY)
//
// Real bun emits '(fail) <name>' in non-TTY mode (docker-exec capture path).
// With CLAUDECODE=1 it appends a bracketed duration: '(fail) <name> [Nms]'.
// The ✗ glyph appears only in TTY (interactive terminal) mode.
// ---------------------------------------------------------------------------

/** All tests pass: 5 pass, 0 fail, 2 skip. */
const FIXTURE_ALL_PASS = `bun test v1.x.x (abc123)

 test/foo.test.ts:
   ✓ should do thing (1ms)
   ✓ should do other thing (2ms)
   - skipped a
   - skipped b

 test/bar.test.ts:
   ✓ bar test 1 (1ms)
   ✓ bar test 2 (1ms)
   ✓ bar test 3 (1ms)

 5 pass
 0 fail
 2 skip
Ran 7 tests across 2 files. [0.10s]
`;

/**
 * Some tests fail: 3 pass, 2 fail, 1 skip.
 * Uses the real non-TTY '(fail) <name> [Nms]' format (CLAUDECODE=1 path).
 */
const FIXTURE_WITH_FAILURES = `bun test v1.x.x (abc123)

 test/foo.test.ts:
   ✓ should do thing (1ms)
(fail) should fail [2ms]

     Error: expected 1 but got 2
       at foo.test.ts:5:5

 test/bar.test.ts:
   ✓ bar test 1 (1ms)
(fail) another failing test [3ms]

     TypeError: Cannot read property 'x' of undefined
       at bar.test.ts:10:3

   ✓ bar test 2 (1ms)

 test/baz.test.ts:
   - skipped here

 3 pass
 2 fail
 1 skip
Ran 6 tests across 3 files. [0.10s]
`;

/** Only skips, zero failures: 0 pass, 0 fail, 3 skip. */
const FIXTURE_ONLY_SKIPS = `bun test v1.x.x (abc123)

 test/foo.test.ts:
   - all tests skipped
   - another skipped
   - yet another

 0 pass
 0 fail
 3 skip
Ran 3 tests across 1 files. [0.10s]
`;

/** Empty output (no bun test ran). */
const FIXTURE_EMPTY = '';

/**
 * Crashed run: no completion tally, no summary lines at all -- the exact
 * shape the reviewer used to demonstrate the finding (US-R2-002). Container
 * `expectedSkips` can be 0 and this must still fail the run: checkSuiteRan
 * must reject it before the skip-count comparison is ever reached.
 */
const FIXTURE_CRASHED = 'error: Cannot find module "x"\nbun: command crashed\n';

/** Single failing test, no duration suffix -- plain '(fail) <name>' format. */
const FIXTURE_NO_DURATION = `bun test v1.x.x (abc123)

 test/x.test.ts:
(fail) bare failing test

 0 pass
 1 fail
 0 skip
`;

/**
 * Real bun non-TTY output with CLAUDECODE=1: three entries including a
 * '(todo)' test.  Confirms that the '[Nms]' duration is stripped and that
 * '(todo)' entries are captured alongside '(fail)' entries.
 */
const FIXTURE_REAL_BUN_CLAUDECODE = `bun test v1.x.x (abc123)

(fail) first failing test [5ms]
(fail) second failing test [12ms]
(todo) a todo test [1ms]

 0 pass
 3 fail
 0 skip
`;

// ---------------------------------------------------------------------------
// parseBunOutput
// ---------------------------------------------------------------------------

describe('parseBunOutput', () => {
	describe('all-pass fixture', () => {
		test('pass count is 5', () => {
			expect(parseBunOutput(FIXTURE_ALL_PASS).pass).toBe(5);
		});

		test('fail count is 0', () => {
			expect(parseBunOutput(FIXTURE_ALL_PASS).fail).toBe(0);
		});

		test('skip count is 2', () => {
			expect(parseBunOutput(FIXTURE_ALL_PASS).skip).toBe(2);
		});

		test('failingTests is empty when no failures', () => {
			expect(parseBunOutput(FIXTURE_ALL_PASS).failingTests).toHaveLength(0);
		});
	});

	describe('failures fixture', () => {
		test('pass count is 3', () => {
			expect(parseBunOutput(FIXTURE_WITH_FAILURES).pass).toBe(3);
		});

		test('fail count is 2', () => {
			expect(parseBunOutput(FIXTURE_WITH_FAILURES).fail).toBe(2);
		});

		test('skip count is 1', () => {
			expect(parseBunOutput(FIXTURE_WITH_FAILURES).skip).toBe(1);
		});

		test('failingTests has 2 entries', () => {
			expect(parseBunOutput(FIXTURE_WITH_FAILURES).failingTests).toHaveLength(2);
		});

		test('first failing test name is extracted', () => {
			expect(parseBunOutput(FIXTURE_WITH_FAILURES).failingTests[0]).toBe('should fail');
		});

		test('second failing test name is extracted', () => {
			expect(parseBunOutput(FIXTURE_WITH_FAILURES).failingTests[1]).toBe(
				'another failing test',
			);
		});
	});

	describe('only-skips fixture', () => {
		test('fail count is 0', () => {
			expect(parseBunOutput(FIXTURE_ONLY_SKIPS).fail).toBe(0);
		});

		test('skip count is 3', () => {
			expect(parseBunOutput(FIXTURE_ONLY_SKIPS).skip).toBe(3);
		});

		test('pass count is 0', () => {
			expect(parseBunOutput(FIXTURE_ONLY_SKIPS).pass).toBe(0);
		});

		test('failingTests is empty', () => {
			expect(parseBunOutput(FIXTURE_ONLY_SKIPS).failingTests).toHaveLength(0);
		});
	});

	describe('empty output', () => {
		test('returns zeros and empty failingTests', () => {
			const r = parseBunOutput(FIXTURE_EMPTY);
			expect(r.pass).toBe(0);
			expect(r.fail).toBe(0);
			expect(r.skip).toBe(0);
			expect(r.failingTests).toHaveLength(0);
		});
	});

	describe('no-duration fixture', () => {
		test('extracts test name from plain (fail) line without [Nms]', () => {
			const r = parseBunOutput(FIXTURE_NO_DURATION);
			expect(r.fail).toBe(1);
			expect(r.failingTests[0]).toBe('bare failing test');
		});
	});

	describe('real bun non-TTY (CLAUDECODE=1) fixture', () => {
		test('fail count is 3', () => {
			expect(parseBunOutput(FIXTURE_REAL_BUN_CLAUDECODE).fail).toBe(3);
		});

		test('failingTests has 3 entries', () => {
			expect(parseBunOutput(FIXTURE_REAL_BUN_CLAUDECODE).failingTests).toHaveLength(3);
		});

		test('extracts (fail) test names stripping [Nms] suffix', () => {
			const r = parseBunOutput(FIXTURE_REAL_BUN_CLAUDECODE);
			expect(r.failingTests).toContain('first failing test');
			expect(r.failingTests).toContain('second failing test');
		});

		test('extracts (todo) test name', () => {
			const r = parseBunOutput(FIXTURE_REAL_BUN_CLAUDECODE);
			expect(r.failingTests).toContain('a todo test');
		});
	});

	describe('large counts', () => {
		test('parses 100 pass / 50 fail / 10 skip', () => {
			const r = parseBunOutput(' 100 pass\n 50 fail\n 10 skip\n');
			expect(r.pass).toBe(100);
			expect(r.fail).toBe(50);
			expect(r.skip).toBe(10);
		});
	});
});

// ---------------------------------------------------------------------------
// runInContainerTests exit code
// ---------------------------------------------------------------------------

describe('runInContainerTests exit code', () => {
	test('exits 0 when fail count is 0 and skip count matches expectation', () => {
		const { exitCode } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ALL_PASS, exitCode: 0 }),
			readExpectations: fakeExpectations(2), // FIXTURE_ALL_PASS has 2 skip
		});
		expect(exitCode).toBe(0);
	});

	test('exits 1 when fail count > 0', () => {
		const { exitCode } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_WITH_FAILURES, exitCode: 1 }),
			readExpectations: fakeExpectations(1), // FIXTURE_WITH_FAILURES has 1 skip
		});
		expect(exitCode).toBe(1);
	});

	test('exits 0 when only skips (fail count 0) and skip count matches expectation', () => {
		const { exitCode } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ONLY_SKIPS, exitCode: 0 }),
			readExpectations: fakeExpectations(3), // FIXTURE_ONLY_SKIPS has 3 skip
		});
		expect(exitCode).toBe(0);
	});

	test('exits 1 when fail count is 0 but skip count does NOT match expectation', () => {
		const { exitCode, skipCheck } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ONLY_SKIPS, exitCode: 0 }),
			readExpectations: fakeExpectations(99), // FIXTURE_ONLY_SKIPS has 3 skip, not 99
		});
		expect(exitCode).toBe(1);
		expect(skipCheck.ok).toBe(false);
		expect(skipCheck.message).toContain('observed 3 skip, expected 99');
	});

	test('exits 0 even when docker exec exits non-zero but bun reports 0 failures', () => {
		// bun test may exit non-zero on skips; exit code is re-derived from parsed fail.
		const { exitCode, summary } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ONLY_SKIPS, exitCode: 1 }),
			readExpectations: fakeExpectations(3),
		});
		expect(exitCode).toBe(0);
		expect(summary.fail).toBe(0);
	});

	test('exits 1 even when docker exec exits 0 but bun reports failures', () => {
		const { exitCode } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_WITH_FAILURES, exitCode: 0 }),
			readExpectations: fakeExpectations(1),
		});
		expect(exitCode).toBe(1);
	});

	// -------------------------------------------------------------------------
	// checkSuiteRan positive-evidence guard (US-R2-002, review round 2 finding)
	// -------------------------------------------------------------------------

	test('exits 1 on a crashed run with no completion tally, even though expectedSkips is 0', () => {
		const { exitCode, skipCheck } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_CRASHED, exitCode: 1 }),
			readExpectations: fakeExpectations(0),
		});
		expect(exitCode).toBe(1);
		expect(skipCheck.ok).toBe(false);
		expect(skipCheck.message).toContain('did not report a completion tally');
	});

	test('exits 1 when the completion tally is present but observed pass is below the container passFloor', () => {
		// FIXTURE_ONLY_SKIPS has 0 pass and a matching 3-skip count; a passFloor
		// above the observed pass count must still fail the run even though the
		// skip count itself would otherwise match.
		const { exitCode, skipCheck } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ONLY_SKIPS, exitCode: 0 }),
			readExpectations: fakeExpectations(3, 5),
		});
		expect(exitCode).toBe(1);
		expect(skipCheck.ok).toBe(false);
		expect(skipCheck.message).toContain('below recorded');
	});

	test('exits 0 when the completion tally is present and observed pass meets the container passFloor', () => {
		const { exitCode } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ALL_PASS, exitCode: 0 }),
			readExpectations: fakeExpectations(2, 5), // FIXTURE_ALL_PASS has 5 pass
		});
		expect(exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// runInContainerTests: ensureFn call behaviour
// ---------------------------------------------------------------------------

describe('runInContainerTests ensureFn', () => {
	test('calls ensureFn exactly once', () => {
		let callCount = 0;
		runInContainerTests({
			ensureFn: () => {
				callCount++;
			},
			execFn: () => ({ output: FIXTURE_ALL_PASS, exitCode: 0 }),
			readExpectations: fakeExpectations(2),
		});
		expect(callCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runInContainerTests: container name threading
// ---------------------------------------------------------------------------

describe('runInContainerTests container name', () => {
	test('passes DEFAULT_CONTAINER_NAME to execFn when containerName absent', () => {
		let capturedName: string | undefined;
		runInContainerTests({
			ensureFn: () => {},
			execFn: (name) => {
				capturedName = name;
				return { output: FIXTURE_ALL_PASS, exitCode: 0 };
			},
			readExpectations: fakeExpectations(2),
		});
		expect(capturedName).toBe('cam-worker');
	});

	test('passes custom containerName to execFn', () => {
		let capturedName: string | undefined;
		runInContainerTests({
			containerName: 'my-test-container',
			ensureFn: () => {},
			execFn: (name) => {
				capturedName = name;
				return { output: FIXTURE_ALL_PASS, exitCode: 0 };
			},
			readExpectations: fakeExpectations(2),
		});
		expect(capturedName).toBe('my-test-container');
	});
});

// ---------------------------------------------------------------------------
// runInContainerTests: returned summary fields
// ---------------------------------------------------------------------------

describe('runInContainerTests returned summary', () => {
	test('returns failing test names when failures present', () => {
		const { summary } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_WITH_FAILURES, exitCode: 1 }),
			readExpectations: fakeExpectations(1),
		});
		expect(summary.fail).toBe(2);
		expect(summary.failingTests).toContain('should fail');
		expect(summary.failingTests).toContain('another failing test');
	});

	test('returns empty failingTests when all pass', () => {
		const { summary } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ALL_PASS, exitCode: 0 }),
			readExpectations: fakeExpectations(2),
		});
		expect(summary.failingTests).toHaveLength(0);
	});

	test('skip count is correct for skips-only run', () => {
		const { summary } = runInContainerTests({
			ensureFn: () => {},
			execFn: () => ({ output: FIXTURE_ONLY_SKIPS, exitCode: 0 }),
			readExpectations: fakeExpectations(3),
		});
		expect(summary.skip).toBe(3);
		expect(summary.fail).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// buildContainerTestExecArgv
// ---------------------------------------------------------------------------

describe('buildContainerTestExecArgv', () => {
	test('injects CAM_TEST_WAIVERS=tmux,pgrep,uuidgen via -e', () => {
		const argv = buildContainerTestExecArgv('cam-worker');
		expect(argv).toEqual([
			'exec',
			'-e',
			'CAM_TEST_WAIVERS=tmux,pgrep,uuidgen',
			'cam-worker',
			'bun',
			'test',
		]);
	});

	test('threads the given container name', () => {
		const argv = buildContainerTestExecArgv('my-test-container');
		expect(argv).toContain('my-test-container');
	});

	test('does not include ps in the waiver (legitimate-environmental, needs none)', () => {
		const argv = buildContainerTestExecArgv('cam-worker');
		const envArg = argv[2] ?? '';
		expect(envArg).not.toContain('ps');
	});
});
