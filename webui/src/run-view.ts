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
	| 'shipping'
	| 'done'
	| 'waiting-user'
	| 'failed'
	| 'interrupted'
	| 'cancelled';

export interface RunView {
	id: string;
	issueId: string;
	state: RunState;
	summary: string | null;
	error: string | null;
	updatedAt: string;
}

export interface RunEventView {
	seq: number;
	runId: string;
	kind: string;
	fromState: RunState | null;
	toState: RunState;
	payload: Record<string, unknown>;
	createdAt: string;
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
	'shipping',
	'done',
];

const OFF_SPINE_PHASE: Readonly<Record<string, RunState>> = {
	'waiting-user': 'working',
	interrupted: 'working',
	// Abandoning ends the run where it stopped; it never advances the spine.
	cancelled: 'working',
	failed: 'review',
};

/** Human phase label, always one of the spine names. */
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

/** What the screen answers at a glance: does Gateship need the operator now? */
export type OperatorAttention = 'Precisa de você' | 'Trabalhando' | 'Ocioso';

const ATTENTION_STATES: Readonly<Record<RunState, OperatorAttention>> = {
	queued: 'Trabalhando',
	working: 'Trabalhando',
	verify: 'Trabalhando',
	review: 'Trabalhando',
	shipping: 'Trabalhando',
	'ready-to-ship': 'Precisa de você',
	'waiting-user': 'Precisa de você',
	failed: 'Precisa de você',
	interrupted: 'Precisa de você',
	done: 'Ocioso',
	// The operator already decided this one: nothing is pending on it.
	cancelled: 'Ocioso',
};

/**
 * The run state and the preserved workspaces read as one human state, because
 * the operator asks a single question of the header. A notice outlives the run
 * that left it, so it decides before the state does.
 */
export function attentionOf(
	run: RunView | null,
	notices: boolean | readonly unknown[],
): OperatorAttention {
	const hasNotice = typeof notices === 'boolean' ? notices : notices.length > 0;
	if (hasNotice) return 'Precisa de você';
	if (run === null) return 'Ocioso';
	return ATTENTION_STATES[run.state];
}

const ATTENTION_TONE: Readonly<Record<OperatorAttention, StateTone>> = {
	'Precisa de você': 'warning',
	Trabalhando: 'info',
	Ocioso: 'default',
};

/** Badge variant for a human state, which no longer follows a single run. */
export function attentionToneOf(attention: OperatorAttention): StateTone {
	return ATTENTION_TONE[attention];
}

/**
 * Whether an event makes the operational snapshot stale, so the client re-reads
 * it. A state transition changes the run, `run.created` changes the run list,
 * and `workspace.cleanup-warning` is emitted done-to-done but leaves a preserved
 * workspace behind -- the header and the notices panel would otherwise stay on
 * the pre-warning snapshot until the operator reloads the page.
 */
export function invalidatesSnapshot(event: RunEventView): boolean {
	if (event.fromState !== event.toState) return true;
	return event.kind === 'run.created' || event.kind === 'workspace.cleanup-warning';
}

const CANCELLABLE: readonly RunState[] = [
	'queued',
	'working',
	'verify',
	'review',
	'ready-to-ship',
	'shipping',
];

/** Mirrors isTerminalRunState in src/runtime/run-state.ts. */
const TERMINAL: readonly RunState[] = ['done', 'failed', 'cancelled'];

export interface RunActions {
	start: boolean;
	resume: boolean;
	abandon: boolean;
	cancel: boolean;
	ship: boolean;
}

/**
 * Which commands the current run admits. A run only exists in one state, so
 * these are derived together rather than asked one at a time.
 */
export function actionsFor(run: RunView | null, hasSelection: boolean): RunActions {
	const state = run?.state;
	const settled = state === undefined || TERMINAL.includes(state);
	return {
		start: hasSelection && settled,
		resume: state === 'interrupted' || state === 'waiting-user',
		// The way out of an interrupted run that is not worth resuming, and the
		// only state that admits it.
		abandon: state === 'interrupted',
		cancel: state !== undefined && CANCELLABLE.includes(state),
		// A verified run ships itself, so the command is only the explicit retry
		// of an attempt that came back to ready-to-ship.
		ship: state === 'ready-to-ship',
	};
}
