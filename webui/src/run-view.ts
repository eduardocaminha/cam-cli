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
	| 'waiting-provider'
	| 'failed'
	| 'interrupted'
	| 'cancelled';

/** Mirrors RunCostRole in src/runtime/run-store.ts. */
export type RunCostRole = 'executor' | 'reviewer' | 'orchestrator';

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

/**
 * Where a run's correction rounds came from, counted by origin (GSHIP-659).
 * Mirrors RunRoundOrigins in src/runtime/round-origin.ts. `indeterminate` is a
 * round the recorded history admits no pattern for -- never a guess.
 */
export interface RunRoundOriginsView {
	executor: number;
	ci?: number;
	decision: number;
	orchestrator?: number;
	indeterminate: number;
}

export interface RunProviderWaitView {
	provider: 'claude' | 'codex';
	kind:
		| 'auth-required'
		| 'usage-limit'
		| 'rate-limited'
		| 'overloaded'
		| 'model-refused'
		| 'transport-unavailable'
		| 'protocol-invalid'
		| 'cancelled'
		| 'unknown';
	message: string;
	phase: 'working' | 'review';
	retryAt?: string;
}

/**
 * One run's executor handoff (GSHIP-722), present once it was tried --
 * successfully or not. Mirrors ExecutorHandoffRecord in
 * src/runtime/agent-executor-router.ts. Never a stand-in for a balance: the
 * screen shows origin, destination, reason and outcome, and nothing else.
 */
export interface RunExecutorHandoffView {
	from: 'claude' | 'codex';
	to: 'claude' | 'codex';
	reason: RunProviderWaitView['kind'];
	message: string;
	outcome: string;
	createdAt: string;
	model?: string;
	effort?: string;
}

export interface PullRequestDeliveryView {
	prNumber: number;
	url: string;
	ciStatus: 'not-reported' | 'pending' | 'passed' | 'failed';
	failedChecks: Array<{ name: string; url?: string }>;
}

export interface CiCorrectionView {
	prNumber: number;
	headSha: string;
	check: { name: string; url?: string };
}

/**
 * One reported usage window, credit summary, spend-limit summary and
 * reset-credit count (GSHIP-664). Mirrors ProviderUsage and its nested types
 * in src/runtime/provider-auth.ts. A field the source never reported stays
 * absent, never a fabricated zero.
 */
export interface ProviderUsageWindowView {
	window: string;
	status?: 'allowed' | 'allowed_warning' | 'rejected';
	usedPercent?: number;
	windowMinutes?: number;
	observedAt: string;
	resetsAt?: string;
}

export interface ProviderUsageCreditsView {
	hasCredits: boolean;
	unlimited: boolean;
	balance?: string;
}

export interface ProviderUsageSpendLimitView {
	limit: string;
	used: string;
	remainingPercent: number;
	resetsAt?: string;
}

export interface ProviderUsageView {
	windows: ProviderUsageWindowView[];
	credits?: ProviderUsageCreditsView;
	spendLimit?: ProviderUsageSpendLimitView;
	resetCreditCount?: number;
}

/** Mirrors the provider-neutral replay derived in src/runtime/run-evaluation.ts. */
export interface RunEvaluationView {
	workflowRevision: string | null;
	provider: 'claude' | 'codex';
	outcome: 'shipped' | 'failed' | 'cancelled' | 'incomplete';
	wallTimeMs: number | null;
	attentionRequests: number;
	operatorInterventions: number;
	providerHolds: number;
	resolvedCycleQuestions?: number;
	roles: Array<{
		role: RunCostRole;
		models: string[];
		efforts: string[];
		/** Absent on a run replayed before providers were recorded by role (GSHIP-709). */
		providers?: Array<'claude' | 'codex'>;
	}>;
}

export interface RunView {
	id: string;
	issueId: string;
	state: RunState;
	summary: string | null;
	error: string | null;
	updatedAt: string;
	cost: RunCostView;
	roundOrigins: RunRoundOriginsView;
	ciCorrection?: CiCorrectionView | null;
	evaluation?: RunEvaluationView | null;
	providerWait: RunProviderWaitView | null;
	pullRequest: PullRequestDeliveryView | null;
	executorHandoff: RunExecutorHandoffView | null;
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

/**
 * The small, factual workflow summary shown on /runs. It deliberately has no
 * synthetic score: each number is either a persisted run outcome, a correction
 * origin already derived from that run's complete decision log, or provider-
 * reported cost. The caller controls the window by choosing which runs to pass.
 */
export interface WorkflowInsights {
	runCount: number;
	outcomes: {
		done: number;
		failed: number;
		cancelled: number;
		active: number;
	};
	corrections: RunRoundOriginsView & {
		runCount: number;
	};
	cycleResponses: { count: number; runCount: number };
	cost: RunCostAggregate & {
		reportedRunCount: number;
	};
}

type CorrectionTotals = Required<RunRoundOriginsView> & { runCount: number };

/** Adds one run's rounds to the totals, counting the run once if it had any. */
function addCorrections(totals: CorrectionTotals, origins: RunRoundOriginsView): void {
	const ci = origins.ci ?? 0;
	const orchestrator = origins.orchestrator ?? 0;
	const rounds = origins.executor + ci + origins.decision + orchestrator + origins.indeterminate;
	if (rounds > 0) totals.runCount += 1;
	totals.executor += origins.executor;
	totals.ci += ci;
	totals.decision += origins.decision;
	totals.orchestrator += orchestrator;
	totals.indeterminate += origins.indeterminate;
}

export function summarizeWorkflow(runs: readonly RunView[]): WorkflowInsights {
	const outcomes = { done: 0, failed: 0, cancelled: 0, active: 0 };
	const corrections = {
		executor: 0,
		ci: 0,
		decision: 0,
		orchestrator: 0,
		indeterminate: 0,
		runCount: 0,
	};
	const cycleResponses = { count: 0, runCount: 0 };
	for (const run of runs) {
		if (run.state === 'done') outcomes.done += 1;
		else if (run.state === 'failed') outcomes.failed += 1;
		else if (run.state === 'cancelled') outcomes.cancelled += 1;
		else outcomes.active += 1;

		addCorrections(corrections, run.roundOrigins);
		const responseCount = run.evaluation?.resolvedCycleQuestions ?? 0;
		cycleResponses.count += responseCount;
		if (responseCount > 0) cycleResponses.runCount += 1;
	}
	const cost = aggregateRunCosts(runs);
	return {
		runCount: runs.length,
		outcomes,
		corrections,
		cycleResponses,
		cost: {
			...cost,
			reportedRunCount: runs.filter((run) => run.cost.totalCostUsd !== null).length,
		},
	};
}

export interface WorkflowConfiguration {
	provider: RunEvaluationView['provider'];
	roles: RunEvaluationView['roles'];
	runCount: number;
}

/** One immutable cohort: terminal runs started by the same Gateship revision. */
export interface WorkflowCohort {
	revision: string;
	trackedRunCount: number;
	terminalRunCount: number;
	incompleteRunCount: number;
	outcomes: { shipped: number; failed: number; cancelled: number };
	attention: { requests: number; interventions: number; runCount: number };
	cycleResponses: { count: number; runCount: number };
	providerHolds: { count: number; runCount: number };
	corrections: RunRoundOriginsView & { runCount: number };
	medianWallTimeMs: number | null;
	cost: RunCostAggregate & { reportedRunCount: number };
	configurations: WorkflowConfiguration[];
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle] ?? null
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function configurationKey(evaluation: RunEvaluationView): string {
	return JSON.stringify({ provider: evaluation.provider, roles: evaluation.roles });
}

type RecordedRun = RunView & {
	evaluation: RunEvaluationView & { workflowRevision: string };
};

function hasRecordedRevision(run: RunView): run is RecordedRun {
	return run.evaluation?.workflowRevision !== null
		&& run.evaluation?.workflowRevision !== undefined;
}

function configurationsOf(runs: readonly RecordedRun[]): WorkflowConfiguration[] {
	const configurations = new Map<string, WorkflowConfiguration>();
	for (const { evaluation } of runs) {
		const key = configurationKey(evaluation);
		const current = configurations.get(key);
		configurations.set(key, current === undefined
			? { provider: evaluation.provider, roles: evaluation.roles, runCount: 1 }
			: { ...current, runCount: current.runCount + 1 });
	}
	return [...configurations.values()];
}

function observationsOf(runs: readonly RecordedRun[]): Pick<
	WorkflowCohort,
	'outcomes' | 'attention' | 'cycleResponses' | 'providerHolds' | 'corrections'
> {
	const outcomes = { shipped: 0, failed: 0, cancelled: 0 };
	const attention = { requests: 0, interventions: 0, runCount: 0 };
	const cycleResponses = { count: 0, runCount: 0 };
	const providerHolds = { count: 0, runCount: 0 };
	const corrections = { executor: 0, ci: 0, decision: 0, orchestrator: 0, indeterminate: 0, runCount: 0 };
	for (const run of runs) {
		const { evaluation } = run;
		if (evaluation.outcome === 'incomplete') continue;
		outcomes[evaluation.outcome] += 1;
		attention.requests += evaluation.attentionRequests;
		attention.interventions += evaluation.operatorInterventions;
		if (evaluation.attentionRequests > 0) attention.runCount += 1;
		cycleResponses.count += evaluation.resolvedCycleQuestions ?? 0;
		if ((evaluation.resolvedCycleQuestions ?? 0) > 0) cycleResponses.runCount += 1;
		providerHolds.count += evaluation.providerHolds;
		if (evaluation.providerHolds > 0) providerHolds.runCount += 1;
		addCorrections(corrections, run.roundOrigins);
	}
	return { outcomes, attention, cycleResponses, providerHolds, corrections };
}

function summarizeCohort(revision: string, tracked: readonly RecordedRun[]): WorkflowCohort {
	const terminal = tracked.filter((run) => run.evaluation.outcome !== 'incomplete');
	const cost = aggregateRunCosts(terminal);
	return {
		revision,
		trackedRunCount: tracked.length,
		terminalRunCount: terminal.length,
		incompleteRunCount: tracked.length - terminal.length,
		...observationsOf(terminal),
		medianWallTimeMs: median(terminal.flatMap(({ evaluation }) =>
			evaluation.wallTimeMs === null ? [] : [evaluation.wallTimeMs])),
		cost: {
			...cost,
			reportedRunCount: terminal.filter((run) => run.cost.totalCostUsd !== null).length,
		},
		configurations: configurationsOf(terminal),
	};
}

/**
 * Replays comparable cohorts from the same bounded run window the screen
 * already reads. Legacy runs without a recorded revision remain visible in
 * the ordinary workflow summary but cannot be assigned to a benchmark.
 */
export function summarizeWorkflowCohorts(runs: readonly RunView[]): WorkflowCohort[] {
	const revisions: string[] = [];
	const grouped = new Map<string, RecordedRun[]>();
	for (const run of runs) {
		if (!hasRecordedRevision(run)) continue;
		const revision = run.evaluation.workflowRevision;
		if (!grouped.has(revision)) revisions.push(revision);
		grouped.set(revision, [...(grouped.get(revision) ?? []), run]);
	}
	return revisions.map((revision) => summarizeCohort(revision, grouped.get(revision) ?? []));
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
	'waiting-provider': 'working',
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

export type StateTone = 'default' | 'secondary' | 'info' | 'success' | 'warning' | 'error';

/** Badge variant for a state. The five families the theme declares. */
export function toneOf(state: RunState): StateTone {
	if (state === 'failed') return 'error';
	if (state === 'done') return 'success';
	if (state === 'waiting-user' || state === 'waiting-provider' || state === 'interrupted') {
		return 'warning';
	}
	if (state === 'ready-to-ship') return 'info';
	return 'default';
}

/** What the screen answers at a glance: does Gateship need the operator now? */
export type OperatorAttention = 'Needs you' | 'Working' | 'Idle';

const ATTENTION_STATES: Readonly<Record<RunState, OperatorAttention>> = {
	queued: 'Working',
	working: 'Working',
	verify: 'Working',
	review: 'Working',
	'full-verify': 'Working',
	shipping: 'Working',
	'ready-to-ship': 'Needs you',
	'waiting-user': 'Needs you',
	'waiting-provider': 'Needs you',
	failed: 'Needs you',
	interrupted: 'Needs you',
	done: 'Idle',
	// The operator already decided this one: nothing is pending on it.
	cancelled: 'Idle',
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
	if (hasNotice || chainPaused) return 'Needs you';
	if (run === null) return 'Idle';
	return ATTENTION_STATES[run.state];
}

const ATTENTION_TONE: Readonly<Record<OperatorAttention, StateTone>> = {
	'Needs you': 'warning',
	Working: 'info',
	// Idle is the quiet state by definition; the solid primary chip read as a
	// glowing button, worst on dark.
	Idle: 'secondary',
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
	'waiting-provider',
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
		resume: state === 'interrupted' || state === 'waiting-user' || state === 'waiting-provider',
		// The way out of an interrupted run that is not worth resuming, and the
		// only state that admits it.
		abandon: state === 'interrupted',
		cancel: state !== undefined && CANCELLABLE.includes(state),
		// A verified run ships itself, so the command is only the explicit retry
		// of an attempt that came back to ready-to-ship.
		ship: state === 'ready-to-ship',
	};
}
