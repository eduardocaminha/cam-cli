// test/commands/status.test.ts
//
// Unit test for the 'review' LoopPhase (US-001, CAM-403).
//
// `review` is a first-class LoopPhase alongside idle/planning/implementing/
// awaiting-operator/shipping, so a `phase:review` state file round-trips
// through `parseStateFile` (phase === 'review' after parse) instead of being
// silently dropped as an unrecognized value. `active` derives to `false`
// since only `phase:implementing` derives `active:true`.

import { describe, expect, test } from 'bun:test';

import { parseStateFile } from '../../src/commands/status.ts';

describe('parseStateFile — review phase (US-001, CAM-403)', () => {
	test('round-trips a phase:review state file', () => {
		const body = ['---', 'phase: review', 'iteration: 4', 'max_iterations: 30', '---', ''].join(
			'\n',
		);
		const out = parseStateFile(body);
		expect(out).not.toBeNull();
		expect(out?.phase).toBe('review');
		// active MUST derive from phase; only 'implementing' derives true.
		expect(out?.active).toBe(false);
	});
});
