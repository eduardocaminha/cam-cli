export const RUN_STATES = [
	'queued',
	'working',
	'verify',
	'review',
	// The project's full verification manifest (GSHIP-649), run once review is
	// clean and before the diff is ever reported ready to ship -- its own phase,
	// exactly like `shipping` is its own phase after `ready-to-ship`.
	'full-verify',
	'ready-to-ship',
	'shipping',
	'done',
	'waiting-user',
	'waiting-provider',
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
	working: ['verify', 'waiting-user', 'waiting-provider', 'failed', 'interrupted'],
	// `ready-to-ship` is reached directly, skipping `full-verify` entirely, when
	// no full verifier is configured for this runtime (GSHIP-649) -- the same
	// optionality `review` already has for an unconfigured reviewer.
	verify: ['review', 'full-verify', 'ready-to-ship', 'failed', 'interrupted'],
	review: ['working', 'full-verify', 'ready-to-ship', 'waiting-user', 'waiting-provider', 'failed', 'interrupted'],
	// A full-project verification failure (GSHIP-649) sends the run back for
	// one fix round, exactly like a review finding does; a second failure ends
	// the run at waiting-user instead of shipping.
	'full-verify': ['working', 'ready-to-ship', 'waiting-user', 'failed', 'interrupted'],
	// A resting state again now that full verification has its own phase
	// (GSHIP-649): every path that reaches it has already been fully cleared,
	// so the only ways out are shipping it or ending the run.
	'ready-to-ship': ['shipping', 'failed', 'interrupted'],
	// A ship attempt is a phase of its own, so a merge is the only way out to
	// done and every other end returns the same diff to ready-to-ship.
	shipping: ['done', 'ready-to-ship', 'interrupted'],
	done: [],
	'waiting-user': ['working', 'interrupted'],
	// Availability is a resting condition, not a terminal outcome. A retry of
	// executor work returns to working; a reviewer retry returns to review.
	'waiting-provider': ['working', 'review', 'interrupted'],
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
	kind?: string,
): number {
	if (!canTransition(current.state, nextState)) {
		throw new Error(`invalid run transition: ${current.state} -> ${nextState}`);
	}
	if (current.state !== 'review' || nextState !== 'working') {
		return current.fixRounds;
	}
	if (current.fixRounds >= 1 && kind !== 'run.cycle-response') {
		throw new Error('automatic review fixes are limited to one round');
	}
	if (current.fixRounds >= 3) {
		throw new Error('review fixes are limited to three rounds');
	}
	return current.fixRounds + 1;
}
