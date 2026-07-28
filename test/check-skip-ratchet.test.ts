// test/check-skip-ratchet.test.ts
//
// Unit tests for scripts/check-skip-ratchet.ts (US-005, CAM-424 PRD).
//
// All tests drive the pure exported functions with in-memory fixtures; no
// real `bun test` subprocess or filesystem read happens here.

import { describe, expect, test } from 'bun:test';

import {
	checkSkipCount,
	checkSkipRatchet,
	checkSuiteRan,
	MIN_PASS_FLOOR_HEADROOM,
	parsePassCount,
	parseSkipCount,
	resolveLane,
	suiteRanToCompletion,
	type LaneExpectationsFile,
} from '../scripts/check-skip-ratchet.ts';

// ---------------------------------------------------------------------------
// parseSkipCount
// ---------------------------------------------------------------------------

describe('parseSkipCount', () => {
	test('missing skip line is treated as zero (AC3 parser constraint)', () => {
		const output = '\n 5702 pass\n 0 fail\n 12882 expect() calls\nRan 5702 tests across 340 files. [79.42s]\n';
		expect(parseSkipCount(output)).toBe(0);
	});

	test('parses a present skip line', () => {
		const output = '\n 5659 pass\n 3 fail\n 40 skip\nRan 5702 tests across 340 files. [70.12s]\n';
		expect(parseSkipCount(output)).toBe(40);
	});

	test('empty output is treated as zero', () => {
		expect(parseSkipCount('')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// parsePassCount
// ---------------------------------------------------------------------------

describe('parsePassCount', () => {
	test('parses a present pass line', () => {
		const output = '\n 5702 pass\n 0 fail\nRan 5702 tests across 340 files. [79.42s]\n';
		expect(parsePassCount(output)).toBe(5702);
	});

	test('missing pass line (crashed run) returns null, never 0', () => {
		const output = 'error: Cannot find module "foo"\nbun: command crashed\n';
		expect(parsePassCount(output)).toBeNull();
	});

	test('empty output returns null', () => {
		expect(parsePassCount('')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// suiteRanToCompletion
// ---------------------------------------------------------------------------

describe('suiteRanToCompletion', () => {
	test('true when the Ran-tally line is present', () => {
		const output = '\n 5702 pass\n 0 fail\nRan 5702 tests across 340 files. [79.42s]\n';
		expect(suiteRanToCompletion(output)).toBe(true);
	});

	test('false on a crashed/garbage run with no tally line (AC: fail-open guard)', () => {
		const output = 'error: Cannot find module "foo"\nbun: command crashed\n';
		expect(suiteRanToCompletion(output)).toBe(false);
	});

	test('false on empty output', () => {
		expect(suiteRanToCompletion('')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// checkSuiteRan
// ---------------------------------------------------------------------------

describe('checkSuiteRan', () => {
	test('null (suite ran cleanly) when tally line present and pass count clears the floor', () => {
		const output = '\n 5702 pass\n 0 fail\nRan 5702 tests across 340 files. [79.42s]\n';
		expect(checkSuiteRan(output, 5600, 'host')).toBeNull();
	});

	test('fails when the completion tally line is missing (crashed run masquerading as clean)', () => {
		const output = 'error: Cannot find module "foo"\nbun: command crashed\n';
		const result = checkSuiteRan(output, 5700, 'host');
		expect(result).not.toBeNull();
		expect(result?.ok).toBe(false);
		expect(result?.message).toContain('completion tally');
	});

	test('fails when the observed pass count is below the recorded passFloor', () => {
		const output = '\n 100 pass\n 0 fail\nRan 100 tests across 5 files. [1.00s]\n';
		const result = checkSuiteRan(output, 5700, 'host');
		expect(result).not.toBeNull();
		expect(result?.ok).toBe(false);
		expect(result?.message).toContain('passFloor');
	});

	test('fails when the recorded passFloor is floor too tight against the observed pass count', () => {
		const output = ' 5758 pass\n 0 fail\nRan 5758 tests across 343 files. [1s]\n';
		const result = checkSuiteRan(output, 5758, 'host');
		expect(result).not.toBeNull();
		expect(result?.ok).toBe(false);
		expect(result?.message).toContain('too tight');
		expect(result?.message).not.toContain('suite likely crashed');
	});

	test('a recorded floor of 0 disables the headroom rule even with a tiny observed pass count', () => {
		const output = ' 5 pass\n 0 fail\nRan 5 tests across 1 files. [0.10s]\n';
		expect(checkSuiteRan(output, 0, 'container')).toBeNull();
	});

	test('a positive floor with at least MIN_PASS_FLOOR_HEADROOM gap clears the guard', () => {
		const output = ' 200 pass\n 0 fail\nRan 200 tests across 3 files. [0.10s]\n';
		expect(checkSuiteRan(output, 200 - MIN_PASS_FLOOR_HEADROOM, 'container')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// resolveLane
// ---------------------------------------------------------------------------

describe('resolveLane', () => {
	test('defaults to host when CAM_TEST_LANE is unset', () => {
		expect(resolveLane({})).toBe('host');
	});

	test('resolves to container only on the exact literal', () => {
		expect(resolveLane({ CAM_TEST_LANE: 'container' })).toBe('container');
	});

	test('any other value falls back to host (explicit declaration, never sniffed)', () => {
		expect(resolveLane({ CAM_TEST_LANE: 'CONTAINER' })).toBe('host');
		expect(resolveLane({ CAM_TEST_LANE: 'docker' })).toBe('host');
	});
});

// ---------------------------------------------------------------------------
// checkSkipCount
// ---------------------------------------------------------------------------

describe('checkSkipCount', () => {
	test('exact-match passes', () => {
		const result = checkSkipCount(0, 0, 'host');
		expect(result.ok).toBe(true);
		expect(result.message).toContain('host');
	});

	test('+1 delta fails and names the delta', () => {
		const result = checkSkipCount(1, 0, 'host');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('+1');
		expect(result.message).toContain('observed 1 skip');
		expect(result.message).toContain('expected 0');
	});

	test('a decrease also fails and names the negative delta', () => {
		const result = checkSkipCount(38, 40, 'container');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('-2');
	});
});

// ---------------------------------------------------------------------------
// checkSkipRatchet (full DI-injected flow)
// ---------------------------------------------------------------------------

describe('checkSkipRatchet', () => {
	function makeExpectations(): LaneExpectationsFile {
		return {
			lanes: {
				// passFloor set below the fixtures' expected-clean pass count so a
				// single legitimate new skip (test below) still clears the floor,
				// AND with at least MIN_PASS_FLOOR_HEADROOM of gap so the too-tight
				// guard doesn't trip on these fixtures; only a crashed/partial run
				// should trip the guard.
				host: { expectedSkips: 0, passFloor: 5600 },
				container: { expectedSkips: 40, passFloor: 5550 },
			},
			triage: { hardDependency: 42, legitimateEnvironmental: 1 },
		};
	}

	test('host lane, missing skip line, matches recorded zero expectation', () => {
		const result = checkSkipRatchet({
			lane: 'host',
			getSuiteOutput: () => ' 5702 pass\n 0 fail\nRan 5702 tests across 340 files. [79.42s]\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(true);
	});

	test('container lane, present skip line, matches recorded expectation', () => {
		const result = checkSkipRatchet({
			lane: 'container',
			getSuiteOutput: () => ' 5662 pass\n 0 fail\n 40 skip\nRan 5702 tests across 340 files. [79.42s]\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(true);
	});

	test('a newly introduced skip on the host lane fails the gate', () => {
		const result = checkSkipRatchet({
			lane: 'host',
			getSuiteOutput: () => ' 5701 pass\n 0 fail\n 1 skip\nRan 5702 tests across 340 files. [79.42s]\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('+1');
	});

	test('a crashed run (no summary at all) fails the gate instead of matching the recorded zero-skip expectation (fail-open regression guard)', () => {
		const result = checkSkipRatchet({
			lane: 'host',
			getSuiteOutput: () => 'error: Cannot find module "foo"\nbun: command crashed\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('completion tally');
	});

	test('a run that completes but under-runs the recorded passFloor fails the gate even with a matching skip count', () => {
		const result = checkSkipRatchet({
			lane: 'host',
			getSuiteOutput: () => ' 12 pass\n 0 fail\nRan 12 tests across 1 files. [0.10s]\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('passFloor');
	});
});
