// test/supervisor/observe.test.ts
//
// Unit tests for the pure observe decide-fn (CAM-132, US-003).
//
// All tests are self-contained: no filesystem, no git, no network.
// Each test constructs an IssueEntry and threads ObserveState explicitly.

import { describe, expect, test } from 'bun:test';
import { observeDecide, type ObserveState } from '../../src/supervisor/observe.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import type { MetaLoopObserveEventDetail } from '../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INITIAL_STATE: ObserveState = { kind: 'none' };

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
	return {
		id: 'CAM-1',
		title: 'Test issue',
		stage: 'specified',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

// Type-guard helpers for the discriminated union.
function isSelectDetail(
	d: MetaLoopObserveEventDetail,
): d is { wouldSelect: string; rank: number; wsjf: number } {
	return 'wouldSelect' in d;
}

function isDrainedDetail(d: MetaLoopObserveEventDetail): d is { drained: true } {
	return 'drained' in d;
}

// ---------------------------------------------------------------------------
// AC2: plannable issue path
// ---------------------------------------------------------------------------

describe('AC2: plannable issue path', () => {
	test('returns { wouldSelect, rank, wsjf } when selector returns an issue', () => {
		const issue = makeIssue({
			id: 'CAM-10',
			rank: 3,
			wsjf: { value: 8, timeCriticality: 4, riskReduction: 2, jobSize: 2 },
		});

		const result = observeDecide(issue, INITIAL_STATE);

		expect(result).not.toBeNull();
		if (result === null) throw new Error('unreachable');

		expect(isSelectDetail(result.detail)).toBe(true);
		if (!isSelectDetail(result.detail)) throw new Error('unreachable');

		expect(result.detail.wouldSelect).toBe('CAM-10');
		expect(result.detail.rank).toBe(3);
		// (8+4+2)/2 = 7
		expect(result.detail.wsjf).toBe(7);
	});

	test('rank defaults to 0 when issue.rank is absent', () => {
		const issue = makeIssue({ id: 'CAM-11' }); // no rank, no wsjf
		const result = observeDecide(issue, INITIAL_STATE);

		expect(result).not.toBeNull();
		if (result === null) throw new Error('unreachable');
		if (!isSelectDetail(result.detail)) throw new Error('unreachable');

		expect(result.detail.rank).toBe(0);
	});

	test('wsjf falls back to 0 when issue.wsjf is absent', () => {
		const issue = makeIssue({ id: 'CAM-12' }); // no wsjf field
		const result = observeDecide(issue, INITIAL_STATE);

		expect(result).not.toBeNull();
		if (result === null) throw new Error('unreachable');
		if (!isSelectDetail(result.detail)) throw new Error('unreachable');

		expect(result.detail.wsjf).toBe(0);
	});

	test('wsjf falls back to 0 when jobSize <= 0', () => {
		const issue = makeIssue({
			id: 'CAM-13',
			wsjf: { value: 5, timeCriticality: 3, riskReduction: 2, jobSize: 0 },
		});
		const result = observeDecide(issue, INITIAL_STATE);

		expect(result).not.toBeNull();
		if (result === null) throw new Error('unreachable');
		if (!isSelectDetail(result.detail)) throw new Error('unreachable');

		expect(result.detail.wsjf).toBe(0);
	});

	test('newState is { kind: selected, id } after first emit', () => {
		const issue = makeIssue({ id: 'CAM-20', rank: 1 });
		const result = observeDecide(issue, INITIAL_STATE);

		expect(result).not.toBeNull();
		if (result === null) throw new Error('unreachable');

		expect(result.newState).toEqual({ kind: 'selected', id: 'CAM-20' });
	});
});

// ---------------------------------------------------------------------------
// AC3: drained path
// ---------------------------------------------------------------------------

describe('AC3: drained path', () => {
	test('returns { drained: true } when selector returns null', () => {
		const result = observeDecide(null, INITIAL_STATE);

		expect(result).not.toBeNull();
		if (result === null) throw new Error('unreachable');

		expect(isDrainedDetail(result.detail)).toBe(true);
		expect(result.detail).toEqual({ drained: true });
	});

	test('newState is { kind: drained } after null selection', () => {
		const result = observeDecide(null, INITIAL_STATE);

		expect(result).not.toBeNull();
		if (result === null) throw new Error('unreachable');

		expect(result.newState).toEqual({ kind: 'drained' });
	});
});

// ---------------------------------------------------------------------------
// AC4: dedup -- same id across multiple ticks
// ---------------------------------------------------------------------------

describe('AC4: dedup - same id yields exactly one emit', () => {
	test('3 consecutive ticks with the same issue yield exactly 1 emit', () => {
		const issue = makeIssue({ id: 'CAM-42', rank: 5 });
		let state: ObserveState = INITIAL_STATE;
		const emits: MetaLoopObserveEventDetail[] = [];

		for (let i = 0; i < 3; i++) {
			const result = observeDecide(issue, state);
			if (result !== null) {
				emits.push(result.detail);
				state = result.newState;
			}
		}

		// Only the first tick should emit; ticks 2 and 3 are deduped.
		expect(emits).toHaveLength(1);
		if (!isSelectDetail(emits[0]!)) throw new Error('unreachable');
		expect(emits[0]!.wouldSelect).toBe('CAM-42');
	});

	test('10 consecutive ticks with the same id still yield exactly 1 emit', () => {
		const issue = makeIssue({ id: 'CAM-99' });
		let state: ObserveState = INITIAL_STATE;
		let emitCount = 0;

		for (let i = 0; i < 10; i++) {
			const result = observeDecide(issue, state);
			if (result !== null) {
				emitCount += 1;
				state = result.newState;
			}
		}

		expect(emitCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC5: re-emit on change; drained dedup
// ---------------------------------------------------------------------------

describe('AC5: re-emit on change and drained dedup', () => {
	test('different issue id after first selection re-emits', () => {
		const issue1 = makeIssue({ id: 'CAM-1', rank: 1 });
		const issue2 = makeIssue({ id: 'CAM-2', rank: 2 });

		// First tick: emit issue1.
		const r1 = observeDecide(issue1, INITIAL_STATE);
		expect(r1).not.toBeNull();
		const state1 = r1!.newState;

		// Second tick: same issue1 -- dedup, no emit.
		const r1b = observeDecide(issue1, state1);
		expect(r1b).toBeNull();

		// Third tick: issue2 -- different id, must re-emit.
		const r2 = observeDecide(issue2, state1);
		expect(r2).not.toBeNull();
		if (r2 === null) throw new Error('unreachable');
		if (!isSelectDetail(r2.detail)) throw new Error('unreachable');
		expect(r2.detail.wouldSelect).toBe('CAM-2');
	});

	test('transition from plannable to null emits {drained:true} exactly once', () => {
		const issue = makeIssue({ id: 'CAM-5' });

		// Emit the selection first.
		const r1 = observeDecide(issue, INITIAL_STATE);
		expect(r1).not.toBeNull();
		const state1 = r1!.newState;

		// First null tick: must emit drained.
		const r2 = observeDecide(null, state1);
		expect(r2).not.toBeNull();
		if (r2 === null) throw new Error('unreachable');
		expect(r2.detail).toEqual({ drained: true });
		const state2 = r2.newState;

		// Subsequent null ticks: deduped, no emit.
		const r3 = observeDecide(null, state2);
		expect(r3).toBeNull();

		const r4 = observeDecide(null, state2);
		expect(r4).toBeNull();
	});

	test('staying drained across 5 further ticks emits nothing', () => {
		// Reach drained state.
		const r1 = observeDecide(null, INITIAL_STATE);
		expect(r1).not.toBeNull();
		const drainedState = r1!.newState;

		let emitCount = 0;
		let state: ObserveState = drainedState;
		for (let i = 0; i < 5; i++) {
			const r = observeDecide(null, state);
			if (r !== null) {
				emitCount += 1;
				state = r.newState;
			}
		}

		expect(emitCount).toBe(0);
	});

	test('plannable -> drained -> plannable again re-emits', () => {
		const issue = makeIssue({ id: 'CAM-77', rank: 7 });

		const r1 = observeDecide(issue, INITIAL_STATE);
		expect(r1).not.toBeNull();
		const selected1State = r1!.newState;

		const r2 = observeDecide(null, selected1State);
		expect(r2).not.toBeNull();
		const drainedState = r2!.newState;

		// Back to plannable: must emit again (different transition).
		const r3 = observeDecide(issue, drainedState);
		expect(r3).not.toBeNull();
		if (r3 === null) throw new Error('unreachable');
		if (!isSelectDetail(r3.detail)) throw new Error('unreachable');
		expect(r3.detail.wouldSelect).toBe('CAM-77');
	});
});
