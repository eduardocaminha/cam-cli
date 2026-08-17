// test/runtime/run-state.test.ts
//
// CAM-583: shipping is a real phase of the run, not a background operation on
// a ready-to-ship run. A merge is the only exit to done, and a lost attempt
// returns the same diff to ready-to-ship so it can be retried.

import { describe, expect, test } from 'bun:test';

import { canTransition, isRunState, isTerminalRunState } from '../../src/runtime/run-state.ts';

describe('the ship phase of the run state machine', () => {
	test('shipping is a persisted state, reached only from ready-to-ship', () => {
		expect(isRunState('shipping')).toBe(true);
		expect(canTransition('ready-to-ship', 'shipping')).toBe(true);
		expect(canTransition('review', 'shipping')).toBe(false);
		expect(canTransition('verify', 'shipping')).toBe(false);
		expect(canTransition('working', 'shipping')).toBe(false);
	});

	test('a merge is the only way to done', () => {
		expect(canTransition('shipping', 'done')).toBe(true);
		expect(canTransition('ready-to-ship', 'done')).toBe(false);
		expect(isTerminalRunState('shipping')).toBe(false);
		expect(isTerminalRunState('done')).toBe(true);
	});

	test('a lost ship attempt returns to ready-to-ship instead of failing the run', () => {
		expect(canTransition('shipping', 'ready-to-ship')).toBe(true);
		expect(canTransition('shipping', 'interrupted')).toBe(true);
		// The change is verified and reviewed: a bad attempt never burns the run.
		expect(canTransition('shipping', 'failed')).toBe(false);
		expect(canTransition('shipping', 'working')).toBe(false);
	});
});

// GSHIP-611: an interrupted run has a second way out -- abandoning it ends the
// run as cancelled instead of resuming the provider session.
describe('the abandoned end of a run', () => {
	test('cancelled is a terminal state reached only from interrupted', () => {
		expect(isRunState('cancelled')).toBe(true);
		expect(canTransition('interrupted', 'cancelled')).toBe(true);
		expect(canTransition('interrupted', 'working')).toBe(true);
		for (const state of ['queued', 'working', 'verify', 'review', 'ready-to-ship', 'shipping', 'waiting-user'] as const) {
			expect(canTransition(state, 'cancelled')).toBe(false);
		}
	});

	test('done, failed and cancelled are terminal and admit nothing', () => {
		expect(isTerminalRunState('cancelled')).toBe(true);
		expect(isTerminalRunState('interrupted')).toBe(false);
		expect(canTransition('cancelled', 'working')).toBe(false);
		expect(canTransition('cancelled', 'cancelled')).toBe(false);
		expect(canTransition('done', 'cancelled')).toBe(false);
		expect(canTransition('failed', 'cancelled')).toBe(false);
	});
});
