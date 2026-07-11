// test/supervisor/rearm-preconditions.test.ts
//
// Unit tests for evaluateRearmPreconditions (US-003, CAM-195, Defect 1).
//
// Coverage:
//   AC1: rearm:true when in-flight + phase:implementing + no merge-watch.
//   AC2: phase:idle (and any non-'implementing' phase, including undefined)
//        never resumes.
//   AC4: refused when any drain precondition fails (not-in-flight,
//        merge-watch-pending), and check ordering (first failing reason wins).

import { describe, expect, test } from 'bun:test';
import { evaluateRearmPreconditions } from '../../src/supervisor/rearm-preconditions.ts';

describe('evaluateRearmPreconditions', () => {
	test('AC1: rearm:true when in-flight + phase:implementing + no merge-watch', () => {
		const result = evaluateRearmPreconditions({
			phase: 'implementing',
			prdInFlight: true,
			mergeWatchPresent: false,
		});
		expect(result).toEqual({ rearm: true });
	});

	test('AC2: phase:idle never resumes', () => {
		const result = evaluateRearmPreconditions({
			phase: 'idle',
			prdInFlight: true,
			mergeWatchPresent: false,
		});
		expect(result).toEqual({ rearm: false, reason: 'not-implementing-phase' });
	});

	test('AC2: undefined phase (no state file / no phase field) never resumes', () => {
		const result = evaluateRearmPreconditions({
			phase: undefined,
			prdInFlight: true,
			mergeWatchPresent: false,
		});
		expect(result).toEqual({ rearm: false, reason: 'not-implementing-phase' });
	});

	test('AC2: phase:planning never resumes (only an exact implementing match rearms)', () => {
		const result = evaluateRearmPreconditions({
			phase: 'planning',
			prdInFlight: true,
			mergeWatchPresent: false,
		});
		expect(result).toEqual({ rearm: false, reason: 'not-implementing-phase' });
	});

	test('AC2: phase:shipping never resumes (only an exact implementing match rearms)', () => {
		const result = evaluateRearmPreconditions({
			phase: 'shipping',
			prdInFlight: true,
			mergeWatchPresent: false,
		});
		expect(result).toEqual({ rearm: false, reason: 'not-implementing-phase' });
	});

	test('AC4: refused when prd is not in-flight (checked before phase)', () => {
		const result = evaluateRearmPreconditions({
			phase: 'implementing',
			prdInFlight: false,
			mergeWatchPresent: false,
		});
		expect(result).toEqual({ rearm: false, reason: 'not-in-flight' });
	});

	test('AC4: refused when a merge-watch is pending, even with phase:implementing + in-flight', () => {
		const result = evaluateRearmPreconditions({
			phase: 'implementing',
			prdInFlight: true,
			mergeWatchPresent: true,
		});
		expect(result).toEqual({ rearm: false, reason: 'merge-watch-pending' });
	});

	test('ordering: not-in-flight wins over a bad phase when both fail', () => {
		const result = evaluateRearmPreconditions({
			phase: 'idle',
			prdInFlight: false,
			mergeWatchPresent: true,
		});
		expect(result).toEqual({ rearm: false, reason: 'not-in-flight' });
	});
});
