// test/gates-manifest.test.ts
//
// Asserts that the GATES manifest in scripts/check-all.ts contains every
// expected gate name by exact-string membership.
//
// The 4 CAM-59 gates: typecheck, test, embed-vendor, ci-parity
// The 6 CAM-60 static-layer gates: lint, file-size, debt-markers, coverage,
//   dead-code, dup
// The 1 CAM-201 gate: version-skips
// The 1 CAM-61 gate: agents-md
// The 1 CAM-305 gate: test-sleeps
//
// This file is intentionally separate from check-all.test.ts (which tests the
// runGates runner and per-gate command shapes). Its sole job is to catch any
// accidental removal of a required gate name from the manifest.

import { describe, expect, test } from 'bun:test';
import { GATES } from '../scripts/check-all.ts';

const GATE_NAMES: string[] = GATES.map((g) => g.name);

const CAM59_GATES = ['typecheck', 'test', 'embed-vendor', 'ci-parity'] as const;
const CAM60_GATES = ['lint', 'file-size', 'debt-markers', 'coverage', 'dead-code', 'dup'] as const;
const CAM201_GATES = ['version-skips'] as const;
const CAM61_GATES = ['agents-md'] as const;
const CAM305_GATES = ['test-sleeps'] as const;

describe('GATES manifest completeness (US-007)', () => {
	test('contains all 4 CAM-59 foundation gates by exact name', () => {
		for (const name of CAM59_GATES) {
			expect(GATE_NAMES).toContain(name);
		}
	});

	test('contains all 6 CAM-60 static-layer gates by exact name', () => {
		for (const name of CAM60_GATES) {
			expect(GATE_NAMES).toContain(name);
		}
	});

	test('contains the CAM-201 version-skips gate by exact name', () => {
		for (const name of CAM201_GATES) {
			expect(GATE_NAMES).toContain(name);
		}
	});

	test('contains the CAM-61 agents-md gate by exact name', () => {
		for (const name of CAM61_GATES) {
			expect(GATE_NAMES).toContain(name);
		}
	});

	test('contains the CAM-305 test-sleeps gate by exact name', () => {
		for (const name of CAM305_GATES) {
			expect(GATE_NAMES).toContain(name);
		}
	});

	test('total gate count is 13 (4 CAM-59 + 6 CAM-60 + 1 CAM-201 + 1 CAM-61 + 1 CAM-305)', () => {
		expect(GATES).toHaveLength(13);
	});

	test('all 13 expected names are present in the manifest', () => {
		const expected = [...CAM59_GATES, ...CAM60_GATES, ...CAM201_GATES, ...CAM61_GATES, ...CAM305_GATES];
		for (const name of expected) {
			expect(GATE_NAMES).toContain(name);
		}
	});
});
