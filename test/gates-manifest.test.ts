// test/gates-manifest.test.ts
//
// Asserts that the GATES manifest in scripts/check-all.ts contains every
// expected gate name by exact-string membership.
//
// The 4 CAM-59 gates: typecheck, test, embed-vendor, ci-parity
// The 6 CAM-60 static-layer gates: lint, file-size, debt-markers, coverage,
//   dead-code, dup
//
// This file is intentionally separate from check-all.test.ts (which tests the
// runGates runner and per-gate command shapes). Its sole job is to catch any
// accidental removal of a required gate name from the manifest.

import { describe, expect, test } from 'bun:test';
import { GATES } from '../scripts/check-all.ts';

const GATE_NAMES: string[] = GATES.map((g) => g.name);

const CAM59_GATES = ['typecheck', 'test', 'embed-vendor', 'ci-parity'] as const;
const CAM60_GATES = ['lint', 'file-size', 'debt-markers', 'coverage', 'dead-code', 'dup'] as const;

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

	test('total gate count is 10 (4 CAM-59 + 6 CAM-60)', () => {
		expect(GATES).toHaveLength(10);
	});

	test('all 10 expected names are present in the manifest', () => {
		const expected = [...CAM59_GATES, ...CAM60_GATES];
		for (const name of expected) {
			expect(GATE_NAMES).toContain(name);
		}
	});
});
