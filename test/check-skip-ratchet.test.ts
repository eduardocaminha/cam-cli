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
	parseSkipCount,
	resolveLane,
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
				host: { expectedSkips: 0, passFloor: 5702 },
				container: { expectedSkips: 40, passFloor: 5662 },
			},
			triage: { hardDependency: 42, legitimateEnvironmental: 1 },
		};
	}

	test('host lane, missing skip line, matches recorded zero expectation', () => {
		const result = checkSkipRatchet({
			lane: 'host',
			getSuiteOutput: () => ' 5702 pass\n 0 fail\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(true);
	});

	test('container lane, present skip line, matches recorded expectation', () => {
		const result = checkSkipRatchet({
			lane: 'container',
			getSuiteOutput: () => ' 5662 pass\n 0 fail\n 40 skip\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(true);
	});

	test('a newly introduced skip on the host lane fails the gate', () => {
		const result = checkSkipRatchet({
			lane: 'host',
			getSuiteOutput: () => ' 5701 pass\n 0 fail\n 1 skip\n',
			readExpectations: makeExpectations,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain('+1');
	});
});
