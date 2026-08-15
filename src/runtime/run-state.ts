export const RUN_STATES = [
	'queued',
	'working',
	'verify',
	'review',
	'ready-to-ship',
	'done',
	'waiting-user',
	'failed',
	'interrupted',
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
	'ready-to-ship': ['done', 'failed', 'interrupted'],
	done: [],
	'waiting-user': ['working', 'interrupted'],
	failed: [],
	interrupted: ['working'],
};

export function isRunState(value: string): value is RunState {
	return (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalRunState(state: RunState): boolean {
	return state === 'done' || state === 'failed';
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
