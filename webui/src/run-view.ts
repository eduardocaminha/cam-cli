// webui/src/run-view.ts
//
// Pure derivations from a run record. Everything the operational screen needs
// to decide (which phase it is in, how far along, which buttons are live) is
// computed here so the view stays a function of its props and stays testable
// by static rendering alone.

/** Mirrors src/runtime/run-state.ts. The server is the only writer. */
export type RunState =
	| 'queued'
	| 'working'
	| 'verify'
	| 'review'
	| 'ready-to-ship'
	| 'done'
	| 'waiting-user'
	| 'failed'
	| 'interrupted';

export interface RunView {
	id: string;
	issueId: string;
	state: RunState;
	summary: string | null;
	error: string | null;
	updatedAt: string;
}

export interface PlannableIssue {
	id: string;
	title: string;
}

/** The happy-path spine, in order. Off-spine states are placed against it. */
export const RUN_PHASES: readonly RunState[] = [
	'queued',
	'working',
	'verify',
	'review',
	'ready-to-ship',
	'done',
];

const OFF_SPINE_PHASE: Readonly<Record<string, RunState>> = {
	'waiting-user': 'working',
	interrupted: 'working',
	failed: 'review',
};

/** Human phase label, always one of the six spine names. */
export function phaseOf(state: RunState): RunState {
	return OFF_SPINE_PHASE[state] ?? state;
}

/** Completed fraction of the run spine, 0..1, for a determinate progress bar. */
export function progressOf(state: RunState): number {
	const index = RUN_PHASES.indexOf(phaseOf(state));
	if (index < 0) return 0;
	return index / (RUN_PHASES.length - 1);
}

export type StateTone = 'default' | 'info' | 'success' | 'warning' | 'error';

/** Badge variant for a state. The five families the theme declares. */
export function toneOf(state: RunState): StateTone {
	if (state === 'failed') return 'error';
	if (state === 'done') return 'success';
	if (state === 'waiting-user' || state === 'interrupted') return 'warning';
	if (state === 'ready-to-ship') return 'info';
	return 'default';
}

const CANCELLABLE: readonly RunState[] = [
	'queued',
	'working',
	'verify',
	'review',
	'ready-to-ship',
];

export interface RunActions {
	start: boolean;
	resume: boolean;
	cancel: boolean;
	ship: boolean;
}

/**
 * Which commands the current run admits. A run only exists in one state, so
 * these are derived together rather than asked one at a time.
 */
export function actionsFor(run: RunView | null, hasSelection: boolean): RunActions {
	const state = run?.state;
	const settled = state === undefined || state === 'done' || state === 'failed';
	return {
		start: hasSelection && settled,
		resume: state === 'interrupted' || state === 'waiting-user',
		cancel: state !== undefined && CANCELLABLE.includes(state),
		ship: state === 'ready-to-ship',
	};
}
