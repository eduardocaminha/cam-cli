export const RUN_STATES = [
	'queued',
	'working',
	'verify',
	'review',
	'ready-to-ship',
	'shipping',
	'done',
	'waiting-user',
	'failed',
	'interrupted',
	'cancelled',
] as const;

export type RunState = (typeof RUN_STATES)[number];

export interface RunStateSnapshot {
	state: RunState;
	fixRounds: number;
}

const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
	queued: ['working', 'interrupted'],
	working: ['verify', 'waiting-user', 'failed', 'interrupted'],
	verify: ['review', 'ready-to-ship', 'failed', 'interrupted'],
	review: ['working', 'ready-to-ship', 'waiting-user', 'failed', 'interrupted'],
	'ready-to-ship': ['shipping', 'failed', 'interrupted'],
	// A ship attempt is a phase of its own, so a merge is the only way out to
	// done and every other end returns the same diff to ready-to-ship.
	shipping: ['done', 'ready-to-ship', 'interrupted'],
	done: [],
	'waiting-user': ['working', 'interrupted'],
	failed: [],
	// An interrupted run is the only one the operator can still end instead of
	// resume: abandoning it is the explicit way out of the provider session.
	interrupted: ['working', 'cancelled'],
	cancelled: [],
};

export function isRunState(value: string): value is RunState {
	return (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalRunState(state: RunState): boolean {
	return state === 'done' || state === 'failed' || state === 'cancelled';
}

export function canTransition(fromState: RunState, toState: RunState): boolean {
	return ALLOWED_TRANSITIONS[fromState].includes(toState);
}

export function nextFixRounds(
	current: RunStateSnapshot,
	nextState: RunState,
): number {
	if (!canTransition(current.state, nextState)) {
		throw new Error(`invalid run transition: ${current.state} -> ${nextState}`);
	}
	if (current.state !== 'review' || nextState !== 'working') {
		return current.fixRounds;
	}
	if (current.fixRounds >= 1) {
		throw new Error('automatic review fixes are limited to one round');
	}
	return current.fixRounds + 1;
}
