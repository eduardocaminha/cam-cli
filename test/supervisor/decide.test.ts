// test/supervisor/decide.test.ts
//
// Tests for decideNextAction (src/supervisor/decide.ts).
// Covers all 4 outcome kinds and edge cases from the acceptance criteria.

import { test, expect, describe } from 'bun:test';
import { decideNextAction, type PrdSnapshot } from '../../src/supervisor/decide';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(
	id: string,
	priority: number,
	passes: boolean,
	requires?: string | null,
) {
	return { id, priority, passes, requires: requires ?? null };
}

// ---------------------------------------------------------------------------
// 'implement' outcome
// ---------------------------------------------------------------------------

describe('implement', () => {
	test('picks the only implementable story', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, false)],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-001' });
	});

	test('picks highest priority (lower number wins)', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-003', 3, false),
				makeStory('US-001', 1, false),
				makeStory('US-002', 2, false),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-001' });
	});

	test('tie-breaks by id asc when priority is equal', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-002', 5, false),
				makeStory('US-001', 5, false),
				makeStory('US-003', 5, false),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-001' });
	});

	test('skips already-passing stories', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, true),
				makeStory('US-002', 2, false),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-002' });
	});

	test('skips operator-required stories, picks implementable one', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, false, 'operator'),
				makeStory('US-002', 2, false),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-002' });
	});

	test('picks implementable even when operator stories are lower priority', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-003', 3, false, 'operator'),
				makeStory('US-001', 1, false),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-001' });
	});

	test('mixed passing and failing stories picks correct next', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, true),
				makeStory('US-002', 2, true),
				makeStory('US-003', 3, false),
				makeStory('US-004', 4, false),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-003' });
	});
});

// ---------------------------------------------------------------------------
// 'blocked-no-implementable' outcome
// ---------------------------------------------------------------------------

describe('blocked-no-implementable', () => {
	test('returns blocked when all remaining stories are operator-required', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, true),
				makeStory('US-002', 2, false, 'operator'),
				makeStory('US-003', 3, false, 'operator'),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'blocked-no-implementable' });
	});

	test('returns blocked when entire PRD is operator-required stories', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, false, 'operator'),
				makeStory('US-002', 2, false, 'operator'),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'blocked-no-implementable' });
	});

	test('empty userStories falls through to review (not blocked)', () => {
		const prd: PrdSnapshot = { userStories: [] };
		// No stories at all: all non-operator stories trivially pass -> review
		const action = decideNextAction(prd);
		expect(action.kind).toBe('review');
	});

	test('undefined userStories falls through to review', () => {
		const prd: PrdSnapshot = {};
		const action = decideNextAction(prd);
		expect(action.kind).toBe('review');
	});
});

// ---------------------------------------------------------------------------
// 'review' outcome
// ---------------------------------------------------------------------------

describe('review', () => {
	test('dispatches review when all non-operator stories pass and no review yet', () => {
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, true),
				makeStory('US-002', 2, true),
			],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'review' });
	});

	test('dispatches review when lastVerdict is FIXES_PENDING', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 1,
				maxRounds: 3,
				lastVerdict: 'FIXES_PENDING',
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'review' });
	});

	test('dispatches review when review block present but lastVerdict is null', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 0,
				maxRounds: 3,
				lastVerdict: null,
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'review' });
	});

	test('returns blocked-no-implementable when operator stories pending (not review)', () => {
		// All non-operator stories pass, but operator stories are still incomplete.
		// The loop cannot proceed autonomously until the operator ceremony is done.
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, true),
				makeStory('US-002', 2, false, 'operator'),
			],
			review: { roundsCompleted: 0, maxRounds: 3, lastVerdict: null },
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'blocked-no-implementable' });
	});

	test('dispatches review when roundsCompleted is less than maxRounds', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 2,
				maxRounds: 3,
				lastVerdict: 'FIXES_PENDING',
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'review' });
	});
});

// ---------------------------------------------------------------------------
// 'complete' outcome
// ---------------------------------------------------------------------------

describe('complete', () => {
	test('returns complete when lastVerdict is CLEAN', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 1,
				maxRounds: 3,
				lastVerdict: 'CLEAN',
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'complete' });
	});

	test('returns complete when lastVerdict is MAX_ROUNDS_DEBT', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 3,
				maxRounds: 3,
				lastVerdict: 'MAX_ROUNDS_DEBT',
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'complete' });
	});

	test('returns complete when roundsCompleted >= maxRounds (cap row) even if lastVerdict is not terminal', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 3,
				maxRounds: 3,
				lastVerdict: 'FIXES_PENDING',
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'complete' });
	});

	test('returns complete when roundsCompleted exceeds maxRounds', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 5,
				maxRounds: 3,
				lastVerdict: null,
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'complete' });
	});

	test('cap row: uses default maxRounds=3 when review.maxRounds is absent', () => {
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
			review: {
				roundsCompleted: 3,
				// maxRounds absent -> default 3
				lastVerdict: 'FIXES_PENDING',
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'complete' });
	});

	test('cap row: default roundsCompleted=0 does not trigger cap when no review block', () => {
		// No review block -> roundsCompleted=0 < maxRounds=3 -> review
		const prd: PrdSnapshot = {
			userStories: [makeStory('US-001', 1, true)],
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'review' });
	});
});

// ---------------------------------------------------------------------------
// Priority of implement over review/complete
// ---------------------------------------------------------------------------

describe('implement takes priority over review/complete', () => {
	test('dispatches implement when CLEAN verdict but stories still pending', () => {
		// This should not happen in practice (review runs after all pass) but
		// the matrix says "any passes=false -> implement" first.
		const prd: PrdSnapshot = {
			userStories: [
				makeStory('US-001', 1, true),
				makeStory('US-002', 2, false),
			],
			review: {
				roundsCompleted: 1,
				maxRounds: 3,
				lastVerdict: 'CLEAN',
			},
		};
		const action = decideNextAction(prd);
		expect(action).toEqual({ kind: 'implement', storyId: 'US-002' });
	});
});
