// webui/src/run-view.ts
//
// Pure derivations from a run record. Everything the operational screen needs
// to decide (which phase it is in, how far along, which buttons are live) is
// computed here so the view stays a function of its props and stays testable
// by static rendering alone.

import { isTerminalRunState } from '../../src/runtime/run-state.ts';

/** Mirrors src/runtime/run-state.ts. The server is the only writer. */
export type RunState =
	| 'queued'
	| 'working'
	| 'verify'
	| 'review'
	| 'full-verify'
	| 'ready-to-ship'
	| 'shipping'
	| 'done'
	| 'waiting-user'
	| 'failed'
	| 'interrupted'
	| 'cancelled';

/** Mirrors RunCostRole in src/runtime/run-store.ts. */
export type RunCostRole = 'executor' | 'reviewer';

/**
 * One (role, model) pair's reported cost and token counts, summed across every
 * invocation that reported it -- the total_cost_usd on a `result` event is the
 * sum of every model used, including auxiliary calls the operator's own model
 * settings never name, so the breakdown is shown per model instead of
 * attributing the whole total to the configured one (GSHIP-623).
 */
export interface RunCostBreakdownEntry {
	role: RunCostRole;
	model: string;
	costUsd: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
}

/**
 * A role's effort and thinking-token totals, summed across every invocation of
 * that role (GSHIP-628). Both are properties of the invocation -- the effort
 * flag it was called with, the thinking count reported at the call level --
 * never of one model inside it, which is why they are reported here instead
 * of on a `RunCostBreakdownEntry` row. Mirrors RunCostRoleUsage in
 * src/runtime/run-store.ts.
 */
export interface RunCostRoleUsage {
	role: RunCostRole;
	thinkingTokens?: number;
	effort?: string;
}

/**
 * A run's whole reported cost, already summed on the server from the complete
 * event log (GSHIP-623): no display limit here can ever shrink the number the
 * card shows. `totalCostUsd` is `null`, never `0`, when the CLI reported no
 * cost for this run -- `0` would read as free.
 */
export interface RunCostView {
	totalCostUsd: number | null;
	breakdown: readonly RunCostBreakdownEntry[];
	roles: readonly RunCostRoleUsage[];
}

export interface RunView {
	id: string;
	issueId: string;
	state: RunState;
	summary: string | null;
	error: string | null;
	updatedAt: string;
	cost: RunCostView;
}

/** A cost total plus exactly how many runs it spans (GSHIP-628). */
export interface RunCostAggregate {
	totalCostUsd: number | null;
	runCount: number;
}

/**
 * The expected cost across exactly the runs the caller passes -- never a wider
 * "session" or project total, and never more or fewer than what was passed in
 * (GSHIP-628). A run whose CLI never reported a cost contributes nothing to
 * the sum, never a fabricated zero; if none of the runs ever reported one,
 * there is nothing to aggregate.
 */
export function aggregateRunCosts(runs: readonly RunView[]): RunCostAggregate {
	const known = runs.filter((run) => run.cost.totalCostUsd !== null);
	const totalCostUsd = known.length === 0
		? null
		: known.reduce((sum, run) => sum + (run.cost.totalCostUsd ?? 0), 0);
	return { totalCostUsd, runCount: runs.length };
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
	'full-verify',
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
	'full-verify': 'Trabalhando',
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
 * The run state, the preserved workspaces and a stopped chain queue (GSHIP-
 * 650) read as one human state, because the operator asks a single question
 * of the header. A notice outlives the run that left it and a stopped queue
 * is silent otherwise -- either the terminal run it stopped on reads `done`
 * or `cancelled`, which alone would answer `Ocioso` -- so both decide before
 * the run state does.
 */
export function attentionOf(
	run: RunView | null,
	notices: boolean | readonly unknown[],
	chainPaused = false,
): OperatorAttention {
	const hasNotice = typeof notices === 'boolean' ? notices : notices.length > 0;
	if (hasNotice || chainPaused) return 'Precisa de você';
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
 * `workspace.cleanup-warning` is emitted done-to-done but leaves a preserved
 * workspace behind, and `run.proposals-captured` is emitted with the run's
 * state unchanged but fills the proposals inbox -- each would otherwise leave
 * the screen on a stale snapshot until an unrelated state change refreshed it.
 * Activity events are deliberately excluded: they are most of the flow, and
 * invalidating on them would make the snapshot refresh constantly.
 */
export function invalidatesSnapshot(event: RunEventView): boolean {
	if (event.fromState !== event.toState) return true;
	return event.kind === 'run.created'
		|| event.kind === 'workspace.cleanup-warning'
		|| event.kind === 'run.proposals-captured';
}

const CANCELLABLE: readonly RunState[] = [
	'queued',
	'working',
	'verify',
	'review',
	'full-verify',
	'ready-to-ship',
	'shipping',
];

/**
 * The issue whose file a run owns right now, or null. Mirrors
 * findActiveRunForIssue in src/runtime/run-runtime.ts: while a run is not
 * terminal its issue is closed on that run's branch, so the screen offers no
 * control that would write the same file on main and break the ship.
 */
export function activeRunIssueId(runs: readonly RunView[]): string | null {
	return runs.find((run) => !isTerminalRunState(run.state))?.issueId ?? null;
}

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
	const settled = state === undefined || isTerminalRunState(state);
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
