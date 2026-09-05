import { randomUUID } from 'node:crypto';
import { isPlannable } from '../issues/plannable.ts';
import type { IssueEntry } from '../issues/types.ts';
import { type ExecutorHandoffRecord, selectExecutorHandoff } from './agent-executor-router.ts';
import {
	type AgentProviderId,
	PROVIDER_ERROR_KINDS,
	ProviderCallError,
	type ProviderErrorKind,
} from './agent-session.ts';
import type {
	RuntimeWorkspace,
	WorkspaceNotice,
	WorkspaceRunReference,
} from './git-workspace.ts';
import {
	emptyModelSettings,
	type AgentDefaults,
	type AgentSettingSource,
	type ModelSettings,
} from './model-settings.ts';
import { selectOperatorDecisions } from './operator-decision.ts';
import type { OperatorProfile } from './operator-profile.ts';
import {
	type PullRequestCiStatus,
	type PullRequestDelivery,
	selectPullRequestDelivery,
} from './pull-request-delivery.ts';
import { type RunRoundOrigins, selectRunRoundOrigins } from './round-origin.ts';
import { evaluateRun, type RunEvaluation } from './run-evaluation.ts';
import type { ProposalDraft, RunProposal } from './run-proposal.ts';
import { canTransition, isTerminalRunState } from './run-state.ts';
import {
	type ClaudeUsageWindow,
	type ProjectBrief,
	type RunCostSummary,
	type RunEvent,
	type RunEventClass,
	type RunRecord,
	RunStore,
} from './run-store.ts';

function commandPayload(payload: Record<string, unknown>, source?: string): Record<string, unknown> {
	return { ...payload, ...(source === undefined ? {} : { source }) };
}

/** Single `runtime_settings` row holding the executor handoff opt-in (GSHIP-722), beside `chain-runs`. */
const EXECUTOR_HANDOFF_ENABLED_KEY = 'executor-handoff-enabled';

export interface RuntimeExecutionInput {
	runId: string;
	issueId: string;
	sessionId: string;
	providerId?: AgentProviderId;
	resume: boolean;
	cwd: string;
	signal: AbortSignal;
	/** `eventClass` is the caller's declaration (GSHIP-627); omitted defaults to `decision`. */
	emit: (kind: string, payload?: Record<string, unknown>, eventClass?: RunEventClass) => void;
	/** Persist a provider-assigned thread id as soon as it becomes available. */
	setSessionId?: (sessionId: string) => void;
	/**
	 * Findings from the independent review, present only on the single
	 * automatic fix round. The reviewer runs in its own session, so this is the
	 * only channel that puts its verdict in front of the executor.
	 */
	reviewFeedback?: string;
	/** The issue verification's failure detail, for its one mechanical correction round. */
	verificationFeedback?: string;
	/**
	 * The full-project verification's failure output (GSHIP-649), present only
	 * on the single automatic fix round after the project's own `verify`
	 * script rejected an otherwise clean, reviewed change. Independent of
	 * `reviewFeedback`: this channel never carries the code reviewer's own
	 * verdict, only the full verification's.
	 */
	fullVerifyFeedback?: string;
	/** Sanitized evidence from the one automatic correction of a failed required CI check. */
	ciFeedback?: string;
	/** Explicit response supplied by the operator when resuming a paused run. */
	operatorGuidance?: string;
	/**
	 * Binding answer produced internally by the read-only orchestrator for an
	 * executor question already covered by the approved contract. This is
	 * deliberately distinct from operator guidance and review feedback: it
	 * resumes the same native executor session without attributing a decision
	 * or intervention to the human.
	 */
	internalGuidance?: RuntimeInternalGuidance;
	/**
	 * Every decision the operator has already made for this run, chronological
	 * (GSHIP-630) -- not only the latest one `operatorGuidance` carries. Read
	 * from the durable event log, so it survives past the resume that produced
	 * it. Reviewers fold this into their prompt so a ratification already made
	 * is not re-litigated on the next review; empty on a run's first review.
	 */
	operatorDecisions?: readonly string[];
	/**
	 * Durable-state-and-diff handoff (GSHIP-722), present only on the one turn
	 * that opens the alternate provider's brand new native session after the
	 * primary hit a subscription limit. Never a resume: the alternate has no
	 * memory of the primary's reasoning, so this is the only channel that puts
	 * the run's current state in front of it instead of the blind initial
	 * prompt.
	 */
	executorHandoff?: RuntimeExecutorHandoff;
	/**
	 * Whether this run may still spend its one executor handoff (GSHIP-722):
	 * the operator's opt-in is on and no handoff, successful or refused, has
	 * been recorded for this run yet. Computed once per round from durable
	 * state; the router decides everything else -- reason, direction, outcome
	 * -- but never whether it is allowed to try at all.
	 */
	executorHandoffAllowed?: boolean;
	/**
	 * The alternate provider and its own native session (GSHIP-722), present
	 * only once a prior handoff already succeeded for this run. Read only by
	 * `AgentExecutorRouter`, which routes the executor call there instead of
	 * `providerId`/`sessionId` above. Those two stay the run's own historical
	 * origin for every other reader -- the reviewer included -- because only
	 * the executor role ever transfers; a run's review keeps running on the
	 * provider the run started on regardless of where its executor now sits.
	 */
	executorRoute?: { providerId: AgentProviderId; sessionId: string };
}

/** See `RuntimeExecutionInput.executorHandoff` (GSHIP-722). */
export interface RuntimeExecutorHandoff {
	fromProvider: AgentProviderId;
	reason: ProviderErrorKind;
	status: string;
	diff: string;
}

export type RuntimeExecutionResult =
	/** `proposals` are ideas found outside the issue, never work done for it. */
	| { outcome: 'completed'; summary?: string; proposals?: readonly ProposalDraft[]; reconciliation?: RuntimeExecutionReconciliation }
	| {
		outcome: 'waiting-user';
		summary: string;
		reconciliation?: RuntimeExecutionReconciliation;
		/** Issue record loaded from the immutable run source by the provider adapter. */
		approvedContract?: string;
	};

export interface RuntimeInternalGuidance {
	question: string;
	guidance: string;
}

export type RuntimeReconciliationOutcome = 'unchanged' | 'adapted' | 'contract-change-required';

export interface RuntimeExecutionReconciliation {
	outcome: RuntimeReconciliationOutcome;
	summary: string;
}

export interface RuntimeExecutor {
	execute: (input: RuntimeExecutionInput) => Promise<RuntimeExecutionResult>;
}

export interface RuntimeVerificationResult {
	ok: boolean;
	detail?: string;
	/**
	 * Set on an `ok` result the check never actually ran (GSHIP-649), e.g. a
	 * full verifier finding no `verify` script declared. Lets the caller tell
	 * a real pass from a step that had nothing to check without treating
	 * either one as a failure.
	 */
	skipped?: boolean;
}

export interface RuntimeVerifier {
	verify: (input: RuntimeExecutionInput) => Promise<RuntimeVerificationResult>;
}

/**
 * The spec's executable premise (GSHIP-629), checked against the run's own
 * freshly prepared workspace and before the executor is ever invoked. Skipped
 * once it has already passed for this run -- tracked by a durable decision
 * event, not by whether the current pass is a resume, so an interruption
 * mid-check is re-checked on resume instead of releasing the run on a premise
 * nothing ever verified.
 */
export interface RuntimeEvidenceCheck {
	check: (input: RuntimeExecutionInput) => Promise<RuntimeVerificationResult>;
}

/** Verdict of one independent review of the change produced by a run. */
export type RuntimeReviewResult =
	| { verdict: 'clean' }
	| { verdict: 'findings'; detail: string };

export interface RuntimeReviewer {
	review: (input: RuntimeExecutionInput) => Promise<RuntimeReviewResult>;
}

export interface RuntimeCycleResponseUsage {
	model: string;
	effort: string;
	totalCostUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
	thinkingTokens?: number;
	modelUsage?: readonly Record<string, unknown>[];
}

export interface RuntimeCycleResponse {
	questionId: string;
	outcome: 'continue' | 'operator';
	finding: string;
	origin: RuntimeCycleQuestionOrigin;
	text: string;
	createdAt: string;
}

export type RuntimeCycleQuestionOrigin = 'executor' | 'review' | 'full-verify';

export interface RuntimeCycleQuestionInput {
	runId: string;
	issueId: string;
	workspace: string;
	finding: string;
	origin: RuntimeCycleQuestionOrigin;
	/** Present for executor-origin questions, loaded by its provider adapter. */
	approvedContract?: string;
	priorResponses: readonly RuntimeCycleResponse[];
	providerId: AgentProviderId;
	signal: AbortSignal;
	emit: (kind: string, payload?: Record<string, unknown>, eventClass?: RunEventClass) => void;
}

export type RuntimeCycleQuestionResult =
	| { outcome: 'continue'; guidance: string; usage: RuntimeCycleResponseUsage }
	| { outcome: 'operator'; reason: string; usage: RuntimeCycleResponseUsage };

/** Transport-neutral, fresh read-only answer to one unresolved review cycle. */
export interface RuntimeCycleQuestionResolver {
	resolve: (input: RuntimeCycleQuestionInput) => Promise<RuntimeCycleQuestionResult>;
}

/** What shipping one run needs: its own worktree, and a channel for progress. */
export interface RuntimeShipInput {
	runId: string;
	issueId: string;
	cwd: string;
	signal: AbortSignal;
	emit: (kind: string, payload?: Record<string, unknown>, eventClass?: RunEventClass) => void;
	evidence: {
		workflowRevision: string | null;
		review: 'passed' | 'not-applicable';
		fullVerification: 'passed' | 'not-applicable';
	};
	initialCiStatus: PullRequestCiStatus;
}

/**
 * Outcome of one ship attempt. `merged` is reported only once the pull request
 * is really merged; every other end is a failure the run can retry.
 */
export type RuntimeShipResult =
	| { outcome: 'merged'; prNumber: number }
	| { outcome: 'ci-failed'; evidence: RuntimeCiFailureEvidence }
	| { outcome: 'failed'; detail: string };

export interface RuntimeCiFailureEvidence {
	prNumber: number;
	headSha: string;
	check: { name: string; url?: string };
}

/** Browser-safe replay of the latest durable CI correction request. */
export interface RunCiCorrection {
	prNumber: number;
	headSha: string;
	check: { name: string; url?: string };
}

export interface RuntimeShipper {
	ship: (input: RuntimeShipInput) => Promise<RuntimeShipResult>;
}

export interface RunRuntimeOptions {
	cwd: string;
	store: RunStore;
	/** Gateship build/source revision that owns every run this process creates. */
	workflowRevision?: string;
	executor?: RuntimeExecutor;
	verifier?: RuntimeVerifier;
	reviewer?: RuntimeReviewer;
	cycleQuestionResolver?: RuntimeCycleQuestionResolver;
	/**
	 * The project's full verification manifest (GSHIP-649), run once the
	 * issue's own verify and the independent review are both clean and before
	 * the run is ever shipped. Optional like `reviewer`: a project or a test
	 * runtime with none configured skips straight to shipping, unchanged from
	 * before this gate existed.
	 */
	fullVerifier?: RuntimeVerifier;
	shipper?: RuntimeShipper;
	/** Production git-backed check used only to reject a no-change CI correction. */
	hasWorkspaceChanges?: (cwd: string) => boolean;
	now?: () => string;
	/**
	 * The one-shot timer the automatic provider retry is armed on (GSHIP-711),
	 * paired with `now`: both are injected together so a scheduled retry is
	 * exercised deterministically instead of by waiting for the clock.
	 */
	timer?: RuntimeTimer;
	newId?: () => string;
	newSessionId?: () => string;
	preflight?: (issueId: string) => void;
	evidenceCheck?: RuntimeEvidenceCheck;
	workspace?: RuntimeWorkspace;
	/**
	 * Fresh backlog snapshot for chain selection (GSHIP-638), read from the same
	 * source ref a new run is admitted against. Absent reads as an empty
	 * backlog, so chaining pauses on "no admissible issue" instead of guessing
	 * at one.
	 */
	listBacklog?: () => IssueEntry[];
	/** Read fresh at each use so registry settings apply without a restart. */
	agentDefaults?: () => AgentDefaults;
}

export class RuntimeUnavailableError extends Error {
	constructor(message = 'No runtime executor and verifier are configured yet.') {
		super(message);
		this.name = 'RuntimeUnavailableError';
	}
}

export class RuntimeConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RuntimeConflictError';
	}
}

/**
 * Why the queue did not advance on its own at a terminal transition
 * (GSHIP-638). The first four are the ones the spec names explicitly;
 * `chain-start-failed` is the catch-all for a chaining attempt that itself
 * broke -- a bad backlog read, a stale preflight -- so that failure is always
 * explicit too, never a silent stop.
 */
export const CHAIN_PAUSE_REASONS = {
	disabled: 'chain-disabled',
	notDone: 'previous-run-not-done',
	noAdmissibleIssue: 'no-admissible-issue',
	runActive: 'run-active',
	startFailed: 'chain-start-failed',
} as const;

export type ChainPauseReason = (typeof CHAIN_PAUSE_REASONS)[keyof typeof CHAIN_PAUSE_REASONS];

/**
 * The reason alone named nothing the operator could act on without opening
 * the runtime's own event log (GSHIP-650). `run` and `issue` name what the
 * `run.chain-paused` event's own runId resolves to, when it still resolves --
 * the run_events foreign key means it always should, but the read never
 * assumes that and degrades to the reason alone rather than invent a link.
 */
export interface ChainPauseView {
	reason: ChainPauseReason;
	createdAt: string;
	run?: { id: string; issueId: string };
	issue?: { id: string; title: string };
}

export interface RunProviderWait {
	provider: AgentProviderId;
	kind: ProviderErrorKind;
	message: string;
	phase: 'working' | 'review' | 'full-verify';
	retryAt?: string;
}

/** Opaque handle of one armed automatic retry, owned by the timer that made it. */
export type RuntimeTimerHandle = unknown;

/**
 * The one-shot timer the automatic provider retry runs on (GSHIP-711). A seam
 * so the schedule is testable without wall-clock waiting; the process default
 * below is the host timer.
 */
export interface RuntimeTimer {
	set: (callback: () => void, delayMs: number) => RuntimeTimerHandle;
	clear: (handle: RuntimeTimerHandle) => void;
}

const HOST_TIMER: RuntimeTimer = {
	set: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		// A pending retry is not a reason to keep the process alive; it only
		// matters while the service that owns the run is running anyway.
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One armed automatic retry: the run it resumes and the hold it answers. */
interface ArmedProviderRetry {
	runId: string;
	waitSeq: number;
	handle: RuntimeTimerHandle;
}

/** The last automatic retry already spent for a run, so none is ever spent twice. */
interface SpentProviderRetry {
	waitSeq: number;
	retryAtMs: number;
}

function isChainPauseReason(value: unknown): value is ChainPauseReason {
	return typeof value === 'string' && (Object.values(CHAIN_PAUSE_REASONS) as string[]).includes(value);
}

type EventListener = (event: RunEvent) => void;

interface ActiveRun {
	controller: AbortController;
	promise: Promise<void>;
}

/**
 * One implementation attempt and its current correction context.
 */
interface RunAttempt {
	resume: boolean;
	reviewFeedback?: string;
	verificationFeedback?: string;
	fullVerifyFeedback?: string;
	ciFeedback?: string;
	operatorGuidance?: string;
	internalGuidance?: RuntimeInternalGuidance;
}

const PROVIDER_AVAILABILITY_FAILURES: readonly ProviderErrorKind[] = [
	'auth-required',
	'usage-limit',
	'rate-limited',
	'overloaded',
	'model-refused',
	'transport-unavailable',
];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compactDefined(entries: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function cycleUsageEventPayload(usage: RuntimeCycleResponseUsage): Record<string, unknown> {
	const invocationUsage = compactDefined({
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheCreationInputTokens: usage.cacheCreationInputTokens,
		cacheReadInputTokens: usage.cacheReadInputTokens,
		thinkingTokens: usage.thinkingTokens,
	});
	const synthesizedModelUsage = usage.model === undefined || usage.totalCostUsd === undefined
		? undefined
		: [{
			...compactDefined({
				model: usage.model,
				costUsd: usage.totalCostUsd,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheCreationInputTokens: usage.cacheCreationInputTokens,
				cacheReadInputTokens: usage.cacheReadInputTokens,
			}),
		}];
	return compactDefined({
		model: usage.model,
		effort: usage.effort,
		totalCostUsd: usage.totalCostUsd,
		modelUsage: usage.modelUsage ?? synthesizedModelUsage,
		usage: Object.keys(invocationUsage).length === 0 ? undefined : invocationUsage,
	});
}

type ValidatedCycleQuestionResult =
	| { ok: true; result: RuntimeCycleQuestionResult; normalized: string }
	| { ok: false; reason: string };

function validateCycleQuestionResult(
	result: RuntimeCycleQuestionResult | undefined,
	origin: RuntimeCycleQuestionOrigin,
	finding: string,
	priorResponses: readonly RuntimeCycleResponse[],
): ValidatedCycleQuestionResult {
	const text = result?.outcome === 'continue' ? result.guidance
		: result?.outcome === 'operator' ? result.reason : '';
	const normalized = typeof text === 'string' ? text.trim() : '';
	const validAudit = typeof result?.usage?.model === 'string' && result.usage.model.trim().length > 0
		&& typeof result.usage.effort === 'string' && result.usage.effort.trim().length > 0;
	const repeatsAnsweredExecutorQuestion = origin === 'executor'
		&& result?.outcome === 'continue'
		&& priorResponses.some((response) => response.origin === 'executor'
			&& response.finding.trim() === finding.trim());
	if (repeatsAnsweredExecutorQuestion) {
		return { ok: false, reason: 'Cycle question resolver returned continue for a repeated executor question.' };
	}
	if ((result?.outcome !== 'continue' && result?.outcome !== 'operator')
		|| normalized.length === 0 || !validAudit) {
		return { ok: false, reason: 'Cycle question resolver returned an invalid response.' };
	}
	return { ok: true, result, normalized };
}

export class RunRuntime {
	readonly #cwd: string;
	readonly #store: RunStore;
	readonly #workflowRevision: string | undefined;
	#agentDefaults: () => AgentDefaults;
	readonly #executor: RuntimeExecutor | undefined;
	readonly #verifier: RuntimeVerifier | undefined;
	readonly #reviewer: RuntimeReviewer | undefined;
	readonly #cycleQuestionResolver: RuntimeCycleQuestionResolver | undefined;
	readonly #fullVerifier: RuntimeVerifier | undefined;
	readonly #shipper: RuntimeShipper | undefined;
	readonly #hasWorkspaceChanges: ((cwd: string) => boolean) | undefined;
	readonly #now: () => string;
	readonly #timer: RuntimeTimer;
	readonly #newId: () => string;
	readonly #newSessionId: () => string;
	readonly #preflight: ((issueId: string) => void) | undefined;
	readonly #evidenceCheck: RuntimeEvidenceCheck | undefined;
	readonly #workspace: RuntimeWorkspace | undefined;
	readonly #listBacklog: (() => IssueEntry[]) | undefined;
	readonly #listeners = new Set<EventListener>();
	readonly #active = new Map<string, ActiveRun>();
	readonly #spentProviderRetries = new Map<string, SpentProviderRetry>();
	#armedProviderRetry: ArmedProviderRetry | null = null;
	#workspaceNotices: WorkspaceNotice[] = [];
	#admissionBlockedReason: string | null = null;
	readonly #admissionFences = new Map<symbol, string>();
	#preparingWorkspace = false;

	constructor(options: RunRuntimeOptions) {
		this.#cwd = options.cwd;
		this.#store = options.store;
		const workflowRevision = options.workflowRevision?.trim();
		this.#workflowRevision = workflowRevision === undefined || workflowRevision.length === 0
			? undefined
			: workflowRevision.slice(0, 200);
		this.#agentDefaults = options.agentDefaults ?? (() => ({}));
		this.#executor = options.executor;
		this.#verifier = options.verifier;
		this.#reviewer = options.reviewer;
		this.#cycleQuestionResolver = options.cycleQuestionResolver;
		this.#fullVerifier = options.fullVerifier;
		this.#shipper = options.shipper;
		this.#hasWorkspaceChanges = options.hasWorkspaceChanges;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#timer = options.timer ?? HOST_TIMER;
		this.#newId = options.newId ?? randomUUID;
		this.#newSessionId = options.newSessionId ?? randomUUID;
		this.#preflight = options.preflight;
		this.#evidenceCheck = options.evidenceCheck;
		this.#workspace = options.workspace;
		this.#listBacklog = options.listBacklog;
		this.#store.recoverUnownedRuns(this.#now());
		this.#reconcileFinishedWorkspaces();
		this.#refreshWorkspaceNotices();
		// The scheduler starts with the runtime and owns nothing else: a retry
		// whose instant already passed while this process was down is armed
		// here at zero delay rather than waiting for the next hold.
		this.#armProviderRetryForWaitingRun();
	}

	/** Binds the registry-owned defaults for an injected boot runtime. */
	setAgentDefaultsResolver(agentDefaults: () => AgentDefaults): void {
		this.#agentDefaults = agentDefaults;
	}

	async startRun(issueId: string, source?: string): Promise<RunRecord> {
		if (this.#executor === undefined || this.#verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		const admissionBlock = this.#admissionBlockedReason ?? this.#firstAdmissionFenceReason();
		if (admissionBlock !== null) {
			throw new RuntimeConflictError(admissionBlock);
		}
		const normalizedIssueId = issueId.trim();
		if (normalizedIssueId.length === 0) throw new Error('issueId is required');
		const blockingRun = this.#store.listRuns().find((run) => !isTerminalRunState(run.state));
		if (blockingRun !== undefined) {
			throw new RuntimeConflictError(
				`run ${blockingRun.id} is still ${blockingRun.state}; resume or finish it first`,
			);
		}
		if (this.#preparingWorkspace) {
			throw new RuntimeConflictError('a workspace is still being prepared; wait for it to finish');
		}
		this.#preflight?.(normalizedIssueId);
		const id = this.#newId();
		this.#preparingWorkspace = true;
		let workspacePath: string;
		try {
			workspacePath = await this.#workspace?.prepare({
				runId: id,
				issueId: normalizedIssueId,
			}) ?? this.#cwd;
		} finally {
			this.#preparingWorkspace = false;
		}
		const created = this.#store.createRun({
			id,
			issueId: normalizedIssueId,
			sessionId: this.#newSessionId(),
			providerId: this.#store.getSelectedProvider(),
			workflowRevision: this.#workflowRevision,
			...(source === undefined ? {} : { source }),
			workspacePath,
			createdAt: this.#now(),
		});
		this.#publish(created.event);
		this.#launch(created.run, { resume: false });
		return created.run;
	}

	/** Wake the existing chain scheduler after an approval makes work admissible. */
	async startNextAdmissibleIssue(admit?: () => void): Promise<RunRecord | null> {
		if (!this.#store.getChainRunsEnabled()) return null;
		const issueId = this.#nextAdmissibleIssueId();
		if (issueId === null) return null;
		admit?.();
		return await this.startRun(issueId);
	}

	/** Synchronous admission fence used only during the native update handoff. */
	setAdmissionBlocked(reason: string | null): void {
		this.#admissionBlockedReason = reason;
	}

	/** A releasable fence owned by one caller; independent admission stays intact. */
	acquireAdmissionFence(reason: string): () => void {
		const token = Symbol('run-admission-fence');
		this.#admissionFences.set(token, reason);
		return () => { this.#admissionFences.delete(token); };
	}

	resumeRun(runId: string, operatorGuidance?: string, source?: string): RunRecord {
		const guidance = operatorGuidance?.trim();
		const run = this.#resumableRun(runId, guidance);
		if (guidance !== undefined && guidance.length > 0) {
			this.#emit(run.id, 'run.operator-guidance', commandPayload({ text: guidance }, source));
		}
		const recoveredCycle = this.#recoveredCycleAttempt(run);
		const recoveredVerification = this.#unconsumedVerificationAttempt(run.id);
		const recoveredCi = this.#unconsumedCiAttempt(run.id);
		this.#launch(run, {
			resume: true,
			...(recoveredCycle ?? {}),
			...(recoveredVerification ?? {}),
			...(recoveredCi ?? {}),
			...(guidance === undefined || guidance.length === 0
				? {}
				: { operatorGuidance: guidance }),
		});
		return run;
	}

	/** The run a resume may reopen, or the reason it may not. */
	#resumableRun(runId: string, guidance: string | undefined): RunRecord {
		if (this.#executor === undefined || this.#verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		const admissionBlock = this.#admissionBlockedReason ?? this.#firstAdmissionFenceReason();
		if (admissionBlock !== null) {
			throw new RuntimeConflictError(admissionBlock);
		}
		if (this.#active.has(runId)) throw new Error(`run is already active: ${runId}`);
		const run = this.#store.getRun(runId);
		if (run === null) throw new Error(`run not found: ${runId}`);
		if (run.state !== 'interrupted'
			&& run.state !== 'waiting-user'
			&& run.state !== 'waiting-provider') {
			throw new Error(`run cannot resume from state ${run.state}`);
		}
		if (run.state === 'waiting-user' && (guidance === undefined || guidance.length === 0)) {
			throw new Error('operator guidance is required to resume a waiting-user run');
		}
		return run;
	}

	#firstAdmissionFenceReason(): string | null {
		return this.#admissionFences.values().next().value ?? null;
	}

	/**
	 * End an interrupted run the operator does not want to resume. The provider
	 * session is never reopened -- abandoning is the opposite of resuming -- and
	 * the run settles as cancelled, so it stops blocking the next issue. Only the
	 * run's own clean workspace and branch are released; a dirty leftover is
	 * preserved and surfaced, exactly as it is for a merged run.
	 */
	abandonRun(runId: string, source?: string): RunRecord {
		if (this.#active.has(runId)) throw new Error(`run is already active: ${runId}`);
		const run = this.#store.getRun(runId);
		if (run === null) throw new Error(`run not found: ${runId}`);
		if (run.state !== 'interrupted') {
			throw new Error(`run cannot be abandoned from state ${run.state}`);
		}
		const abandoned = this.#transition(runId, 'cancelled', 'run.abandoned', {
			...(source === undefined ? {} : { payload: { source } }),
		}).run;
		this.#releaseFinishedWorkspace(abandoned, false);
		return abandoned;
	}

	/**
	 * Retry the ship of a run whose automatic attempt did not merge. A verified
	 * run ships itself, so this is the explicit second chance: only a run that
	 * is back in ready-to-ship can be shipped, and only one operation at a time
	 * owns a run, so a second request never opens a second pull request.
	 */
	shipRun(runId: string, source?: string): RunRecord {
		const shipper = this.#shipper;
		if (shipper === undefined) {
			throw new RuntimeUnavailableError('No runtime shipper is configured yet.');
		}
		if (this.#active.has(runId)) throw new Error(`run is already active: ${runId}`);
		const run = this.#store.getRun(runId);
		if (run === null) throw new Error(`run not found: ${runId}`);
		if (run.state !== 'ready-to-ship') {
			throw new Error(`run cannot ship from state ${run.state}`);
		}
		if (source !== undefined) this.#emit(run.id, 'run.ship-requested', { source });
		const controller = new AbortController();
		const promise = this.#driveShip(shipper, run, controller.signal)
			.finally(() => {
				this.#active.delete(run.id);
				// A ship can enter the CI correction and rest on a provider
				// there, so this path arms the automatic resume exactly like
				// #launch does: the hold is only answerable once the run is
				// unowned.
				this.#armProviderRetry(run.id);
			});
		this.#active.set(run.id, { controller, promise });
		// The ship phase is already persisted: report it, not the state the
		// caller read before asking.
		return this.#store.getRun(run.id) ?? run;
	}

	getRun(runId: string): RunRecord | null {
		return this.#store.getRun(runId);
	}

	listRuns(limit?: number): RunRecord[] {
		return this.#store.listRuns(limit);
	}

	/**
	 * The run that owns this issue's file right now, or null. The issue is closed
	 * on the run's own branch and never on main, so while this answers a run every
	 * write of that file to main is a conflict the ship would have to resolve.
	 * Ownership is exactly non-terminality: a done, failed or cancelled run owns
	 * nothing.
	 */
	findActiveRunForIssue(issueId: string): RunRecord | null {
		const normalized = issueId.trim();
		if (normalized.length === 0) return null;
		return this.#store.listRuns(10_000)
			.find((run) => run.issueId === normalized && !isTerminalRunState(run.state))
			?? null;
	}

	listEvents(afterSeq?: number): RunEvent[] {
		return this.#store.listEvents(afterSeq);
	}

	listRunEvents(runId: string): RunEvent[] {
		return this.#store.listRunEvents(runId);
	}

	/**
	 * Every durable decision event for one run, unbounded (GSHIP-627) unlike
	 * `listRunEvents`' display window.
	 */
	listRunDecisionEvents(runId: string): RunEvent[] {
		return this.#store.listRunDecisionEvents(runId);
	}

	/**
	 * The run's total reported cost and its breakdown by role and model
	 * (GSHIP-623), read from the complete event log rather than the display
	 * window `listRunEvents` caps.
	 */
	getRunCost(runId: string): RunCostSummary {
		return this.#store.getRunCostSummary(runId);
	}

	/** The latest observed state of every Claude subscription rate-limit window (GSHIP-664). */
	getClaudeUsageWindows(): ClaudeUsageWindow[] {
		return this.#store.getClaudeUsageWindows(this.#now());
	}

	/**
	 * Where this run's correction rounds came from -- the executor's own
	 * automatic fix or the consequence of an operator decision (GSHIP-659) --
	 * derived from the same durable decision log `listRunDecisionEvents`
	 * already exposes, unbounded by `listRunEvents`' display window.
	 */
	getRunRoundOrigins(runId: string): RunRoundOrigins {
		return selectRunRoundOrigins(this.#store.listRunDecisionEvents(runId));
	}

	/** Latest CI correction evidence, read from the complete durable decision log. */
	getRunCiCorrection(runId: string): RunCiCorrection | null {
		const evidence = this.#store.listRunDecisionEvents(runId)
			.findLast((event) => event.kind === 'run.ci-fix-requested')?.payload['evidence'];
		if (!this.#isCiEvidence(evidence)) return null;
		const url = evidence.check.url;
		return {
			prNumber: evidence.prNumber,
			headSha: evidence.headSha,
			check: {
				name: evidence.check.name,
				...(typeof url === 'string' && /^https?:\/\//.test(url) ? { url } : {}),
			},
		};
	}

	/** GitHub delivery state projected from the complete durable decision log. */
	getPullRequestDelivery(runId: string): PullRequestDelivery | null {
		return selectPullRequestDelivery(this.#store.listRunDecisionEvents(runId));
	}

	/**
	 * The run's one executor handoff (GSHIP-722), present once it was tried --
	 * successfully or not -- and absent while the run never spent it. Read
	 * unconditionally from the complete decision log, like
	 * `getPullRequestDelivery`: a handoff, once it happened, stays a fact about
	 * the run regardless of its current state.
	 */
	getRunExecutorHandoff(runId: string): ExecutorHandoffRecord | null {
		return selectExecutorHandoff(this.#store.listRunDecisionEvents(runId));
	}

	/** Replay the run's objective evaluation from its unbounded decision log. */
	getRunEvaluation(runId: string): RunEvaluation | null {
		const run = this.#store.getRun(runId);
		return run === null ? null : evaluateRun(run, this.#store.listRunDecisionEvents(runId));
	}

	/** Latest structured provider hold, present only while that run is resting on it. */
	getRunProviderWait(runId: string): RunProviderWait | null {
		if (this.#store.getRun(runId)?.state !== 'waiting-provider') return null;
		const event = this.#latestProviderWaitEvent(runId);
		if (event === null) return null;
		const { provider, kind, message, phase, retryAt } = event.payload;
		if ((provider !== 'claude' && provider !== 'codex')
			|| typeof kind !== 'string'
			|| !(PROVIDER_ERROR_KINDS as readonly string[]).includes(kind)
			|| typeof message !== 'string'
			|| (phase !== 'working' && phase !== 'review' && phase !== 'full-verify')) {
			return null;
		}
		return {
			provider,
			kind: kind as ProviderErrorKind,
			message,
			phase,
			...(typeof retryAt === 'string' ? { retryAt } : {}),
		};
	}

	/** An observed active hold for this provider; absence never claims a quota balance. */
	getProviderWait(providerId: AgentProviderId): RunProviderWait | null {
		for (const run of this.#store.listRuns(10_000)) {
			if (run.state !== 'waiting-provider') continue;
			const wait = this.getRunProviderWait(run.id);
			if (wait?.provider === providerId) return wait;
		}
		return null;
	}

	listWorkspaceNotices(): WorkspaceNotice[] {
		return [...this.#workspaceNotices];
	}

	/**
	 * The proposal inbox and the two decisions it admits. None of them touches a
	 * run, an issue or an approval: a proposal is evidence the operator settles.
	 */
	listPendingProposals(limit?: number): RunProposal[] {
		return this.#store.listPendingProposals(limit);
	}

	/**
	 * The dismissed and promoted proposals, newest decision first, so the
	 * operator can see what a proposal became without mixing it into the
	 * pending inbox above (GSHIP-643).
	 */
	listResolvedProposals(limit?: number): { proposals: RunProposal[]; omittedCount: number } {
		return this.#store.listResolvedProposals(limit);
	}

	getProposal(id: string): RunProposal | null {
		return this.#store.getProposal(id);
	}

	dismissProposal(id: string): RunProposal {
		return this.#store.dismissProposal(id, this.#now());
	}

	promoteProposal(id: string, issueId: string): RunProposal {
		return this.#store.promoteProposal(id, issueId, this.#now());
	}

	getSelectedProvider(): AgentProviderId {
		return this.#store.getSelectedProviderOverride()
			?? this.#agentDefaults().provider
			?? 'claude';
	}

	getSelectedProviderSource(): AgentSettingSource {
		return this.#store.getSelectedProviderOverride() !== null ? 'project'
			: this.#agentDefaults().provider !== undefined ? 'global' : 'provider-default';
	}

	getSelectedProviderOverride(): AgentProviderId | null {
		return this.#store.getSelectedProviderOverride();
	}

	selectProvider(providerId: AgentProviderId): void {
		this.#store.setSelectedProvider(providerId);
	}

	clearSelectedProviderOverride(): void {
		this.#store.clearSelectedProviderOverride();
	}

	/**
	 * The operator's per-role model choice. Read on demand -- every spawn asks
	 * again -- so a change takes effect without restarting the service.
	 */
	getModelSettings(): ModelSettings {
		return this.#store.getModelSettingsOverride()
			?? this.#agentDefaults().modelSettings
			?? emptyModelSettings();
	}

	getModelSettingsSource(): AgentSettingSource {
		return this.#store.getModelSettingsOverride() !== null ? 'project'
			: this.#agentDefaults().modelSettings !== undefined ? 'global' : 'provider-default';
	}

	getModelSettingsOverride(): ModelSettings | null {
		return this.#store.getModelSettingsOverride();
	}

	setModelSettings(settings: ModelSettings): void {
		this.#store.setModelSettings(settings);
	}

	clearModelSettingsOverride(): void {
		this.#store.clearModelSettingsOverride();
	}

	/**
	 * The operator's chain switch (GSHIP-638), stored beside the provider and
	 * the model slots. Off by default: autonomy never turns itself on.
	 */
	getChainRuns(): boolean {
		return this.#store.getChainRunsEnabled();
	}

	setChainRuns(enabled: boolean): void {
		this.#store.setChainRunsEnabled(enabled);
	}

	/**
	 * The operator's opt-in for the executor handoff (GSHIP-722): off by
	 * default, same as every other autonomy switch, stored beside the chain
	 * switch in the runtime's own opaque settings row rather than a dedicated
	 * column.
	 */
	getExecutorHandoffEnabled(): boolean {
		return this.#store.getRuntimeSetting(EXECUTOR_HANDOFF_ENABLED_KEY) === 'true';
	}

	setExecutorHandoffEnabled(enabled: boolean): void {
		this.#store.setRuntimeSetting(EXECUTOR_HANDOFF_ENABLED_KEY, enabled ? 'true' : 'false');
	}

	/**
	 * Why the queue is not advancing on its own right now, or null while it is
	 * not stopped -- i.e. a run is actively in flight. Reflects only the most
	 * recent terminal run: a run started since, chained or manual, always
	 * supersedes an earlier pause. Names the run and issue the pausing event
	 * fired on (GSHIP-650), the issue read from the same `listBacklog` chaining
	 * itself reads, so the operator sees what stopped the queue without opening
	 * the event log.
	 */
	getChainPause(): ChainPauseView | null {
		const latest = this.#store.listRuns(1)[0];
		if (latest !== undefined && !isTerminalRunState(latest.state)) return null;
		const event = this.#store.getLastChainPauseEvent();
		if (event === null) return null;
		const reason = event.payload['reason'];
		if (!isChainPauseReason(reason)) return null;
		const run = this.#store.getRun(event.runId);
		if (run === null) return { reason, createdAt: event.createdAt };
		const issue = this.#findIssue(run.issueId);
		return {
			reason,
			createdAt: event.createdAt,
			run: { id: run.id, issueId: run.issueId },
			...(issue === undefined ? {} : { issue: { id: issue.id, title: issue.title } }),
		};
	}

	/**
	 * `listBacklog` (e.g. `readBacklogFromMain`) is fail-closed by contract
	 * (src/issues/backlog.ts): a caller that needs non-fatal behavior must wrap
	 * the call itself, exactly as `#maybeChain` already does for chaining.
	 * `getChainPause` is now read by both the GET and the PUT of
	 * /api/chain-runs, and the browser fetches every snapshot through one
	 * `Promise.all` (webui/src/main.tsx), so an exception here would take down
	 * runs, backlog, providers and chat with it -- not just this one field. A
	 * pause whose issue can't be read this way still shows by its reason and
	 * run alone, never propagating the read failure.
	 */
	#findIssue(issueId: string): IssueEntry | undefined {
		try {
			return this.#listBacklog?.().find((entry) => entry.id === issueId);
		} catch {
			return undefined;
		}
	}

	getOrchestratorSession(providerId: AgentProviderId): string | null {
		return this.#store.getOrchestratorSession(providerId);
	}

	setOrchestratorSession(providerId: AgentProviderId, sessionId: string): void {
		this.#store.setOrchestratorSession(providerId, sessionId, this.#now());
	}

	getProjectBrief(): ProjectBrief {
		return this.#store.getProjectBrief();
	}

	setProjectBrief(brief: ProjectBrief): void {
		this.#store.setProjectBrief(brief, this.#now());
	}

	getOperatorProfile(): OperatorProfile {
		return this.#store.getOperatorProfile();
	}

	setOperatorProfile(profile: OperatorProfile): void {
		this.#store.setOperatorProfile(profile);
	}

	subscribe(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async cancelRun(runId: string, source?: string): Promise<RunRecord | null> {
		const active = this.#active.get(runId);
		if (active !== undefined) {
			if (source !== undefined) this.#emit(runId, 'run.cancel-requested', { source });
			active.controller.abort();
			await active.promise;
			return this.#store.getRun(runId);
		}

		const current = this.#store.getRun(runId);
		if (current === null || isTerminalRunState(current.state)) return current;
		if (canTransition(current.state, 'interrupted')) {
			return this.#transition(runId, 'interrupted', 'run.cancelled', {
				...(source === undefined ? {} : { payload: { source } }),
			}).run;
		}
		return current;
	}

	async stop(): Promise<void> {
		this.#cancelProviderRetry();
		const active = [...this.#active.values()];
		for (const run of active) run.controller.abort();
		await Promise.allSettled(active.map((run) => run.promise));
	}

	close(): void {
		if (this.#active.size > 0) throw new Error('cannot close a runtime with active runs');
		this.#cancelProviderRetry();
		this.#store.close();
	}

	#launch(run: RunRecord, attempt: RunAttempt): void {
		// Whoever launches the run owns it; an armed retry for it is moot.
		this.#cancelProviderRetry(run.id);
		const controller = new AbortController();
		const promise = this.#drive(run, controller.signal, attempt)
			.finally(() => {
				this.#active.delete(run.id);
				// Only now is the run unowned, so a hold this pass just recorded
				// is the first moment an automatic retry can be armed for it.
				this.#armProviderRetry(run.id);
			});
		this.#active.set(run.id, { controller, promise });
	}

	async #drive(run: RunRecord, signal: AbortSignal, firstAttempt: RunAttempt): Promise<void> {
		const executor = this.#executor;
		const verifier = this.#verifier;
		if (executor === undefined || verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		const resumePhase = this.#resumePhase(run);
		// A provider retry names itself; a crash recovery resumes under the same
		// `run.started` an interrupted run has always resumed with, so its round
		// accounting does not change with the phase it re-enters.
		const resumeKind = run.state === 'waiting-provider' ? 'run.provider-retry-started' : 'run.started';
		if (resumePhase !== 'review' && resumePhase !== 'full-verify') {
			this.#transition(run.id, 'working', resumePhase === 'working' ? resumeKind : 'run.started');
		}

		try {
			if (await this.#checkEvidence(run, signal, firstAttempt)) return;
			await this.#driveImplementation(
				executor,
				verifier,
				run,
				signal,
				firstAttempt,
				resumePhase === 'review' || resumePhase === 'full-verify' ? resumePhase : null,
			);
		} catch (error) {
			this.#settleDriveFailure(run.id, signal, error);
		}
	}

	/**
	 * How a cycle pass that threw comes to rest: cancelled first, then a
	 * provider hold that can still be retried, and only otherwise `failed`.
	 */
	#settleDriveFailure(runId: string, signal: AbortSignal, error: unknown): void {
		if (signal.aborted) {
			this.#interrupt(runId);
			return;
		}
		if (this.#restForProviderFailure(runId, error)) return;
		const current = this.#store.getRun(runId);
		if (current !== null && canTransition(current.state, 'failed')) {
			const failedRun = this.#transition(runId, 'failed', 'run.failed', {
				error: errorMessage(error),
			}).run;
			this.#releaseFinishedWorkspace(failedRun, false);
		}
	}

	/**
	 * One pass per implementation attempt through work, review and the full
	 * project verification, and -- once all three are clean -- the ship
	 * attempt. A review finding or a full-verify failure (GSHIP-649) each buy
	 * the run a correction; the cycle resolver decides whether a later finding
	 * remains in scope or needs the operator. `#review` owns
	 * the whole clean path through to `ready-to-ship`, including full
	 * verification's own phase and retry, so this loop only ever sees one of:
	 * a fix-round attempt to redo, or the settled run.
	 */
	async #driveImplementation(
		executor: RuntimeExecutor,
		verifier: RuntimeVerifier,
		run: RunRecord,
		signal: AbortSignal,
		firstAttempt: RunAttempt,
		resumeAtReview: 'review' | 'full-verify' | null = null,
	): Promise<void> {
		let attempt = await this.#resumePendingExecutorQuestion(run, signal, firstAttempt);
		if (attempt === null) return;
		if (resumeAtReview === 'full-verify') {
			const next = await this.#enterFullVerify(
				run, signal, this.#executionInput(run, signal, attempt), 'run.review-clean',
			);
			if (next === null) {
				await this.#shipIfReady(run, signal);
				return;
			}
			attempt = next;
		} else if (resumeAtReview === 'review') {
			const next = await this.#review(
				run,
				signal,
				this.#executionInput(run, signal, attempt),
				resumeAtReview,
			);
			if (next === null) {
				await this.#shipIfReady(run, signal);
				return;
			}
			attempt = next;
		}
		for (;;) {
			const executionInput = this.#executionInput(run, signal, attempt);
			const verified = await this.#work(executor, verifier, run, signal, executionInput);
			if (verified === false) return;
			if (verified !== true) {
				attempt = verified;
				continue;
			}
			const next = await this.#review(run, signal, executionInput);
			if (next === null) break;
			attempt = next;
		}
		// A run that got here verified, reviewed and fully verified clean ships
		// under the same ownership: the operator asked for the change, not for a
		// button.
		await this.#shipIfReady(run, signal);
	}

	async #resumePendingExecutorQuestion(
		run: RunRecord,
		signal: AbortSignal,
		attempt: RunAttempt,
	): Promise<RunAttempt | null> {
		const pending = this.#pendingCycleQuestion(run.id);
		if (pending?.origin !== 'executor') return attempt;
		return await this.#answerCycleQuestion(
			run,
			signal,
			pending.questionId,
			pending.finding,
			pending.origin,
			attempt.ciFeedback,
			pending.approvedContract,
		);
	}

	async #shipIfReady(run: RunRecord, signal: AbortSignal): Promise<void> {
		const shipper = this.#shipper;
		if (shipper === undefined) return;
		if (this.#store.getRun(run.id)?.state !== 'ready-to-ship') return;
		await this.#driveShip(shipper, run, signal);
	}

	#providerWaitPhase(runId: string): 'working' | 'review' | 'full-verify' {
		return this.getRunProviderWait(runId)?.phase ?? 'working';
	}

	/**
	 * Where a resume re-enters the cycle. A provider hold names its own phase.
	 * A crash is read from the one event that put the run in `interrupted` now:
	 * an older recovery says nothing about the current interruption, so a stop
	 * taken from working after it resumes working, not the reviewer. Only an
	 * event that actually entered `interrupted` counts; an informational one
	 * emitted while the run already sits there, such as the operator's own
	 * guidance on the resume, carries the state forward and never names a phase.
	 */
	#resumePhase(run: RunRecord): 'working' | 'review' | 'full-verify' | null {
		if (run.state === 'waiting-provider') return this.#providerWaitPhase(run.id);
		if (run.state !== 'interrupted') return null;
		const interruption = this.#store.listRunDecisionEvents(run.id)
			.findLast((event) => event.toState === 'interrupted' && event.fromState !== 'interrupted');
		return interruption?.kind === 'run.recovered-interrupted' && interruption.fromState === 'review'
			? 'review'
			: null;
	}

	#latestProviderWaitEvent(runId: string): RunEvent | null {
		return this.#store.listRunDecisionEvents(runId)
			.findLast((event) => event.kind === 'run.provider-waiting')
			?? null;
	}

	/** The one waiting-provider run there can be, since only one run is ever live. */
	#armProviderRetryForWaitingRun(): void {
		const waiting = this.#store.listRuns(10_000)
			.find((run) => run.state === 'waiting-provider');
		if (waiting !== undefined) this.#armProviderRetry(waiting.id);
	}

	/**
	 * Arm the single automatic resume the run's latest provider hold admits
	 * (GSHIP-711). The hold's own `retryAt` is the whole schedule: absent or
	 * unparseable it stays armed for nobody and the run keeps waiting for the
	 * operator. A retry already spent is never armed again -- neither for the
	 * same wait event nor for a repeated `retryAt` a new refusal carries -- so
	 * a provider that keeps refusing produces at most one automatic attempt
	 * per genuinely new instant instead of a tight loop.
	 */
	#armProviderRetry(runId: string): void {
		this.#cancelProviderRetry(runId);
		if (this.#executor === undefined || this.#verifier === undefined) return;
		if (this.#active.has(runId)) return;
		if (this.#store.getRun(runId)?.state !== 'waiting-provider') return;
		const event = this.#latestProviderWaitEvent(runId);
		if (event === null) return;
		const retryAt = event.payload['retryAt'];
		const retryAtMs = typeof retryAt === 'string' ? Date.parse(retryAt) : Number.NaN;
		if (!Number.isFinite(retryAtMs)) return;
		const spent = this.#spentProviderRetries.get(runId);
		if (spent !== undefined
			&& (event.seq <= spent.waitSeq || retryAtMs <= spent.retryAtMs)) {
			return;
		}
		const nowMs = Date.parse(this.#now());
		const delayMs = Number.isFinite(nowMs) ? Math.max(0, retryAtMs - nowMs) : 0;
		const waitSeq = event.seq;
		const handle = this.#timer.set(() => this.#retryAfterProviderWait(runId, waitSeq), delayMs);
		this.#armedProviderRetry = { runId, waitSeq, handle };
	}

	/** Drop the armed retry, for this run or -- with no run named -- for any. */
	#cancelProviderRetry(runId?: string): void {
		const armed = this.#armedProviderRetry;
		if (armed === null) return;
		if (runId !== undefined && armed.runId !== runId) return;
		this.#timer.clear(armed.handle);
		this.#armedProviderRetry = null;
	}

	/**
	 * The retry instant arrived. Everything the wait promised is re-read here
	 * rather than trusted from when it was armed: the run must still be resting
	 * on a provider, nothing else may own it -- a manual resume that took the
	 * run first wins outright -- and the hold answered must still be the latest
	 * one. The resume itself is the ordinary one, without guidance, so the
	 * provider, the session, the worktree and the working-or-review phase are
	 * exactly those `resumeRun` already preserves.
	 */
	#retryAfterProviderWait(runId: string, waitSeq: number): void {
		if (this.#armedProviderRetry?.runId === runId) this.#armedProviderRetry = null;
		if (this.#active.has(runId)) return;
		if (this.#store.getRun(runId)?.state !== 'waiting-provider') return;
		const event = this.#latestProviderWaitEvent(runId);
		if (event === null || event.seq !== waitSeq) return;
		const retryAt = event.payload['retryAt'];
		const retryAtMs = typeof retryAt === 'string' ? Date.parse(retryAt) : Number.NaN;
		if (!Number.isFinite(retryAtMs)) return;
		this.#spentProviderRetries.set(runId, { waitSeq, retryAtMs });
		// The automatic source and the hold this answers, durable and apart
		// from any operator record: no guidance, no state change, so neither
		// the run's attention requests nor its operator interventions move.
		this.#emit(runId, 'run.provider-retry-automatic', {
			source: 'automatic',
			waitSeq,
			retryAt,
		});
		try {
			this.resumeRun(runId);
		} catch (error) {
			this.#emit(runId, 'run.provider-retry-unavailable', { error: errorMessage(error) });
		}
	}

	/**
	 * Availability and configuration failures preserve the run and its
	 * workspace. Protocol defects and unclassified failures still use the
	 * ordinary terminal failure path below.
	 */
	#restForProviderFailure(runId: string, error: unknown): boolean {
		if (!(error instanceof ProviderCallError)) return false;
		const current = this.#store.getRun(runId);
		if (current === null) return false;
		if (error.kind === 'cancelled') {
			this.#interrupt(runId);
			return true;
		}
		const payload = {
			provider: error.provider,
			kind: error.kind,
			message: error.message,
			phase: current.state,
			...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
		};
		if (PROVIDER_AVAILABILITY_FAILURES.includes(error.kind)
			&& canTransition(current.state, 'waiting-provider')) {
			this.#transition(runId, 'waiting-provider', 'run.provider-waiting', { payload });
			return true;
		}
		return false;
	}

	/**
	 * One ship attempt, persisted as the shipping phase. The run reaches done
	 * only on a real merge; a failed attempt returns it to ready-to-ship, so the
	 * same diff can be shipped again once GitHub or CI recovers, and
	 * cancellation is recorded the same way.
	 */
	async #driveShip(
		shipper: RuntimeShipper,
		run: RunRecord,
		signal: AbortSignal,
	): Promise<void> {
		this.#transition(run.id, 'shipping', 'run.ship-started');
		try {
			const decisions = this.#store.listRunDecisionEvents(run.id);
			const created = decisions.find((event) => event.kind === 'run.created');
			const workflowRevision = created?.payload['workflowRevision'];
			const delivery = selectPullRequestDelivery(decisions);
			const result = await shipper.ship({
				runId: run.id,
				issueId: run.issueId,
				cwd: run.workspacePath.length === 0 ? this.#cwd : run.workspacePath,
				signal,
				emit: (kind, payload, eventClass) => this.#emit(run.id, kind, payload, eventClass),
				evidence: {
					workflowRevision: typeof workflowRevision === 'string' ? workflowRevision : null,
					review: decisions.some((event) => event.kind === 'run.review-clean')
						? 'passed' : 'not-applicable',
					fullVerification: decisions.some((event) => event.kind === 'run.full-verify-clean')
						? 'passed' : 'not-applicable',
				},
				initialCiStatus: delivery?.ciStatus ?? 'not-reported',
			});
			if (signal.aborted) {
				this.#transition(run.id, 'ready-to-ship', 'run.ship-cancelled');
				return;
			}
			if (result.outcome === 'merged') {
				const doneRun = this.#transition(run.id, 'done', 'run.shipped', {
					payload: { prNumber: result.prNumber },
				}).run;
				this.#releaseFinishedWorkspace(doneRun, false);
				return;
			}
			if (result.outcome === 'ci-failed') {
				await this.#handleCiFailure(run, signal, result.evidence);
				return;
			}
			this.#transition(run.id, 'ready-to-ship', 'run.ship-failed', {
				payload: { error: result.detail },
			});
		} catch (error) {
			this.#settleShipFailure(run.id, signal, error);
		}
	}

	/**
	 * A ship pass that threw. Once the CI correction has moved the run off
	 * `shipping`, the throw belongs to the cycle and rests the way any cycle
	 * pass does; still shipping, it returns to `ready-to-ship` so the same diff
	 * can be shipped again.
	 */
	#settleShipFailure(runId: string, signal: AbortSignal, error: unknown): void {
		const current = this.#store.getRun(runId);
		if (current !== null && current.state !== 'shipping') {
			this.#settleDriveFailure(runId, signal, error);
			return;
		}
		if (signal.aborted) {
			this.#transition(runId, 'ready-to-ship', 'run.ship-cancelled');
			return;
		}
		this.#transition(runId, 'ready-to-ship', 'run.ship-failed', {
			payload: { error: errorMessage(error) },
		});
	}

	async #handleCiFailure(
		run: RunRecord,
		signal: AbortSignal,
		evidence: RuntimeCiFailureEvidence,
	): Promise<void> {
		const prior = this.#store.listRunDecisionEvents(run.id)
			.find((event) => event.kind === 'run.ci-fix-requested');
		if (prior !== undefined) {
			this.#transition(run.id, 'waiting-user', 'run.ci-fix-limit', {
				summary: `Required check "${evidence.check.name}" failed after the CI correction.`,
				payload: { evidence, previousEvidence: prior.payload['evidence'] },
			});
			return;
		}
		this.#transition(run.id, 'working', 'run.ci-fix-requested', {
			payload: { origin: 'ci', evidence },
		});
		const executor = this.#executor;
		const verifier = this.#verifier;
		if (executor === undefined || verifier === undefined) throw new RuntimeUnavailableError();
		await this.#driveImplementation(executor, verifier, run, signal, {
			resume: true,
			ciFeedback: this.#ciFeedback(evidence),
		});
	}

	/**
	 * The durable evidence only: PR, head, check name and check URL. Both the
	 * executor and the reviewer read this same text, and the two roles have
	 * different powers -- the reviewer is read-only by contract and cannot run
	 * `gh`, so telling it how to fetch failed output would hand it an
	 * instruction it is forbidden to follow. How to diagnose ephemerally
	 * belongs to the executors' own CI prompt section instead (GSHIP-720),
	 * where it reaches exactly the role that can act on it.
	 */
	#ciFeedback(evidence: RuntimeCiFailureEvidence): string {
		return [
			`PR: #${evidence.prNumber}`,
			`Head: ${evidence.headSha}`,
			`Required check: ${evidence.check.name}`,
			...(evidence.check.url === undefined ? [] : [`Check URL: ${evidence.check.url}`]),
		].join('\n');
	}

	/**
	 * The spec's executable premise, checked against the workspace
	 * `workspace.prepare` already cut for this run -- before the executor is
	 * ever invoked (GSHIP-629). Gated on a durable `run.evidence-checked`
	 * decision event for this run, never on whether this pass is a resume: a
	 * resume is only *evidence* that the check ran before, and the two come
	 * apart exactly when the process died mid-check -- an interruption while
	 * the check itself was running leaves no such event, so resuming checks
	 * again instead of releasing the run on a premise nothing ever verified.
	 * `listRunDecisionEvents` reads the durable class GSHIP-627 established,
	 * unbounded by `listRunEvents`' display window. Returns true only when the
	 * check ended the run (diverged, or the signal was already aborted), so
	 * `#drive` knows to return without starting the executor.
	 */
	async #checkEvidence(
		run: RunRecord,
		signal: AbortSignal,
		attempt: RunAttempt,
	): Promise<boolean> {
		const evidenceCheck = this.#evidenceCheck;
		if (evidenceCheck === undefined || this.#evidenceAlreadyChecked(run.id)) return false;
		const evidence = await evidenceCheck.check(this.#executionInput(run, signal, attempt));
		if (signal.aborted) {
			this.#interrupt(run.id);
			return true;
		}
		if (!evidence.ok) {
			const failedRun = this.#transition(run.id, 'failed', 'run.evidence-diverged', {
				error: evidence.detail
					?? "The run ended because the spec's evidence diverged from the repository.",
			}).run;
			this.#releaseFinishedWorkspace(failedRun, false);
			return true;
		}
		this.#emit(run.id, 'run.evidence-checked');
		return false;
	}

	#evidenceAlreadyChecked(runId: string): boolean {
		return this.#store.listRunDecisionEvents(runId)
			.some((event) => event.kind === 'run.evidence-checked');
	}

	/**
	 * One implementation pass plus its verification. A failed issue verification
	 * returns its one correction attempt; false means the run already settled.
	 */
	async #work(
		executor: RuntimeExecutor,
		verifier: RuntimeVerifier,
		run: RunRecord,
		signal: AbortSignal,
		executionInput: RuntimeExecutionInput,
	): Promise<true | false | RunAttempt> {
		const execution = await executor.execute(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return false;
		}
		if (execution.reconciliation !== undefined
			&& ((!executionInput.resume && executionInput.executorHandoff === undefined)
				|| executionInput.operatorGuidance !== undefined)) {
			this.#emit(run.id, 'run.plan-reconciled', {
				outcome: execution.reconciliation.outcome,
				summary: execution.reconciliation.summary,
			});
		}
		if (execution?.outcome === 'waiting-user') {
			return await this.#handleExecutorQuestion(run, signal, executionInput, execution);
		}
		if (executionInput.ciFeedback !== undefined
			&& this.#hasWorkspaceChanges !== undefined
			&& !this.#hasWorkspaceChanges(executionInput.cwd)) {
			this.#transition(run.id, 'waiting-user', 'run.ci-fix-no-change', {
				summary: 'The CI correction produced no change.',
				payload: { evidence: this.#latestCiEvidence(run.id) },
			});
			return false;
		}
		this.#transition(run.id, 'verify', 'run.work-completed', { summary: execution.summary });
		this.#captureProposals(run, execution.proposals);
		const verification = await verifier.verify(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return false;
		}
		if (verification.ok) return true;
		const detail = verification.detail ?? 'A verificação específica da issue falhou.';
		if (!this.#verificationFixUsed(run.id)) {
			this.#transition(run.id, 'working', 'run.verification-fix-requested', {
				payload: { findings: detail },
			});
			return {
				resume: true,
				verificationFeedback: detail,
				...(executionInput.ciFeedback === undefined ? {} : { ciFeedback: executionInput.ciFeedback }),
			};
		}
		const failedRun = this.#transition(run.id, 'failed', 'run.verification-failed', {
			error: detail,
		}).run;
		this.#releaseFinishedWorkspace(failedRun, false);
		return false;
	}

	async #handleExecutorQuestion(
		run: RunRecord,
		signal: AbortSignal,
		executionInput: RuntimeExecutionInput,
		execution: Extract<RuntimeExecutionResult, { outcome: 'waiting-user' }>,
	): Promise<false | RunAttempt> {
		if (this.#cycleQuestionResolver !== undefined) {
			return await this.#askCycleQuestion(
				run,
				signal,
				execution.summary,
				'executor',
				executionInput.ciFeedback,
				execution.approvedContract,
			) ?? false;
		}
		this.#transition(run.id, 'waiting-user', 'run.waiting-user', {
			summary: execution.summary,
			payload: { summary: execution.summary },
		});
		return false;
	}

	/** Whether the one automatic correction for issue verification was already used. */
	#verificationFixUsed(runId: string): boolean {
		return this.#store.listRunDecisionEvents(runId)
			.some((event) => event.kind === 'run.verification-fix-requested');
	}

	/**
	 * One independent review of a verified change. Returns the next attempt when
	 * findings buy the single automatic fix, or once the review itself is clean,
	 * defers to `#enterFullVerify` for the rest of the path to `ready-to-ship`.
	 */
	async #review(
		run: RunRecord,
		signal: AbortSignal,
		executionInput: RuntimeExecutionInput,
		startKind = 'run.review-started',
	): Promise<RunAttempt | null> {
		const reviewer = this.#reviewer;
		if (reviewer === undefined) {
			return this.#enterFullVerify(run, signal, executionInput, 'run.verified');
		}
		this.#transition(run.id, 'review', startKind);
		const pendingQuestion = this.#pendingCycleQuestion(run.id);
		if (pendingQuestion !== null) {
			return this.#answerCycleQuestion(
				run, signal, pendingQuestion.questionId, pendingQuestion.finding,
				pendingQuestion.origin, executionInput.ciFeedback,
			);
		}
		const review = await reviewer.review(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return null;
		}
		if (review.verdict === 'clean') {
			return this.#enterFullVerify(run, signal, executionInput, 'run.review-clean');
		}
		if ((this.#store.getRun(run.id)?.fixRounds ?? 0) >= 1) {
			return this.#askCycleQuestion(run, signal, review.detail, 'review', executionInput.ciFeedback);
		}
		this.#transition(run.id, 'working', 'run.review-fix-requested', {
			payload: { findings: review.detail },
		});
		return {
			resume: true,
			reviewFeedback: review.detail,
			...(executionInput.ciFeedback === undefined ? {} : { ciFeedback: executionInput.ciFeedback }),
		};
	}

	#cycleResponses(runId: string): RuntimeCycleResponse[] {
		return this.#store.listRunDecisionEvents(runId)
			.filter((event) => event.kind === 'run.cycle-response')
			.flatMap((event) => {
				const questionId = event.payload['questionId'];
				const outcome = event.payload['outcome'];
				const finding = event.payload['findings'];
				const origin = event.payload['origin'];
				const normalizedOrigin = origin === undefined ? 'review' : origin;
				const text = outcome === 'continue' ? event.payload['guidance'] : event.payload['reason'];
				if (typeof questionId !== 'string'
					|| (outcome !== 'continue' && outcome !== 'operator')
					|| typeof finding !== 'string'
					|| (normalizedOrigin !== 'executor' && normalizedOrigin !== 'review' && normalizedOrigin !== 'full-verify')
					|| typeof text !== 'string') return [];
				return [{ questionId, outcome, finding, origin: normalizedOrigin, text, createdAt: event.createdAt }];
			});
	}

	#recoveredCycleAttempt(
		run: RunRecord,
	): Pick<RunAttempt, 'internalGuidance' | 'reviewFeedback' | 'fullVerifyFeedback'> | null {
		if (run.state !== 'interrupted' && run.state !== 'waiting-provider') return null;
		return this.#unconsumedCycleAttempt(run.id);
	}

	/** Restore an unconsumed issue-verification correction after any resume. */
	#unconsumedVerificationAttempt(runId: string): Pick<RunAttempt, 'verificationFeedback'> | null {
		const events = this.#store.listRunDecisionEvents(runId);
		const requestIndex = events.findLastIndex((event) => event.kind === 'run.verification-fix-requested');
		if (requestIndex < 0 || events.slice(requestIndex + 1).some((event) => event.kind === 'run.work-completed')) {
			return null;
		}
		const finding = events[requestIndex]?.payload['findings'];
		return typeof finding === 'string' ? { verificationFeedback: finding } : null;
	}

	/**
	 * A `continue` response and its review -> working transition are one durable
	 * event. If the process dies before that working attempt records
	 * `run.work-completed`, recovery must put the same binding guidance back in
	 * front of the existing executor session instead of reviewing unchanged
	 * work or spending another cycle response.
	 */
	#unconsumedCycleAttempt(
		runId: string,
	): Pick<RunAttempt, 'internalGuidance' | 'reviewFeedback' | 'fullVerifyFeedback'> | null {
		const events = this.#store.listRunDecisionEvents(runId);
		const responseIndex = events.findLastIndex((event) =>
			event.kind === 'run.cycle-response' && event.payload['outcome'] === 'continue');
		if (responseIndex < 0) return null;
		if (events.slice(responseIndex + 1).some((event) => event.kind === 'run.work-completed')) {
			return null;
		}
		const response = events[responseIndex];
		const finding = response?.payload['findings'];
		const guidance = response?.payload['guidance'];
		const origin = response?.payload['origin'];
		const normalizedOrigin = origin === undefined ? 'review' : origin;
		if (typeof finding !== 'string' || typeof guidance !== 'string') return null;
		if (normalizedOrigin !== 'executor' && normalizedOrigin !== 'review' && normalizedOrigin !== 'full-verify') return null;
		if (normalizedOrigin === 'executor') {
			return { internalGuidance: { question: finding, guidance } };
		}
		const feedback = this.#cycleReviewFeedback(finding, guidance);
		return normalizedOrigin === 'review'
			? { reviewFeedback: feedback }
			: { fullVerifyFeedback: feedback };
	}

	/** Rebuild CI context until that correction reaches ready-to-ship or a terminal state. */
	#unconsumedCiAttempt(runId: string): Pick<RunAttempt, 'ciFeedback'> | null {
		const events = this.#store.listRunDecisionEvents(runId);
		const requestIndex = events.findLastIndex((event) => event.kind === 'run.ci-fix-requested');
		if (requestIndex < 0 || events.slice(requestIndex + 1).some((event) =>
			event.toState === 'ready-to-ship' || isTerminalRunState(event.toState))) {
			return null;
		}
		const evidence = events[requestIndex]?.payload['evidence'];
		if (!this.#isCiEvidence(evidence)) return null;
		return { ciFeedback: this.#ciFeedback(evidence) };
	}

	#isCiEvidence(value: unknown): value is RuntimeCiFailureEvidence {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
		const evidence = value as Record<string, unknown>;
		const check = evidence['check'];
		return typeof evidence['prNumber'] === 'number'
			&& typeof evidence['headSha'] === 'string'
			&& check !== null && typeof check === 'object' && !Array.isArray(check)
			&& typeof (check as Record<string, unknown>)['name'] === 'string';
	}

	#cycleReviewFeedback(finding: string, guidance: string): string {
		return `${finding}\n\nBinding orchestrator guidance:\n${guidance}\n\nA no-change response is allowed only when backed by concrete evidence.`;
	}

	#pendingCycleQuestion(runId: string): {
		questionId: string;
		finding: string;
		origin: RuntimeCycleQuestionOrigin;
		approvedContract?: string;
	} | null {
		const events = this.#store.listRunDecisionEvents(runId);
		const answered = new Set(this.#cycleResponses(runId).map((response) => response.questionId));
		let supersededByOperator = false;
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.kind === 'run.operator-guidance') supersededByOperator = true;
			if (event?.kind !== 'run.cycle-question') continue;
			const questionId = event.payload['questionId'];
			const finding = event.payload['finding'];
			const origin = event.payload['origin'];
			const approvedContract = event.payload['approvedContract'];
			const normalizedOrigin = origin === undefined ? 'review' : origin;
			if (typeof questionId === 'string' && typeof finding === 'string'
				&& (normalizedOrigin === 'executor' || normalizedOrigin === 'review' || normalizedOrigin === 'full-verify')
				&& !answered.has(questionId) && !supersededByOperator) {
				return {
					questionId,
					finding,
					origin: normalizedOrigin,
					...(typeof approvedContract === 'string' ? { approvedContract } : {}),
				};
			}
			return null;
		}
		return null;
	}

	async #askCycleQuestion(
		run: RunRecord,
		signal: AbortSignal,
		finding: string,
		origin: RuntimeCycleQuestionOrigin,
		ciFeedback?: string,
		approvedContract?: string,
	): Promise<RunAttempt | null> {
		const questionId = this.#newId();
		this.#emit(run.id, 'run.cycle-question', {
			questionId, issueId: run.issueId, finding, origin,
			...(approvedContract === undefined ? {} : { approvedContract }),
		});
		return this.#answerCycleQuestion(
			run, signal, questionId, finding, origin, ciFeedback, approvedContract,
		);
	}

	async #answerCycleQuestion(
		run: RunRecord,
		signal: AbortSignal,
		questionId: string,
		finding: string,
		origin: RuntimeCycleQuestionOrigin,
		ciFeedback?: string,
		approvedContract?: string,
	): Promise<RunAttempt | null> {
		const resolver = this.#cycleQuestionResolver;
		if (resolver === undefined) {
			this.#transition(run.id, 'waiting-user', 'run.review-fix-limit', {
				summary: finding,
				payload: { questionId, findings: finding, origin, reason: 'Cycle question resolver is unavailable.' },
			});
			return null;
		}
		const started = performance.now();
		const priorResponses = this.#cycleResponses(run.id);
		const unresolved = await resolver.resolve({
			runId: run.id,
			issueId: run.issueId,
			workspace: run.workspacePath.length === 0 ? this.#cwd : run.workspacePath,
			finding,
			origin,
			...(approvedContract === undefined ? {} : { approvedContract }),
			priorResponses,
			providerId: run.providerId,
			signal,
			emit: (kind, payload, eventClass) => this.#emit(run.id, kind, payload, eventClass),
		});
		if (signal.aborted) {
			this.#interrupt(run.id);
			return null;
		}
		const validation = validateCycleQuestionResult(unresolved, origin, finding, priorResponses);
		if (!validation.ok) {
			const { reason } = validation;
			if (origin === 'executor') throw new Error(reason);
			this.#transition(run.id, 'waiting-user', 'run.cycle-response-invalid', {
				summary: reason,
				payload: {
					questionId,
					findings: finding,
					origin,
					reason,
					latencyMs: Math.max(0, Math.round(performance.now() - started)),
					provider: run.providerId,
				},
			});
			return null;
		}
		const { result, normalized } = validation;
		const responsePayload = {
			questionId,
			responder: 'orchestrator',
			source: 'internal',
			outcome: result.outcome,
			...(result.outcome === 'continue' ? { guidance: normalized } : { reason: normalized }),
			latencyMs: Math.max(0, Math.round(performance.now() - started)),
			provider: run.providerId,
			...cycleUsageEventPayload(result.usage),
		};
		if (result.outcome === 'operator') {
			this.#transition(run.id, 'waiting-user', 'run.cycle-response', {
				summary: normalized,
				payload: { ...responsePayload, findings: finding, origin },
			});
			return null;
		}
		const payload = { ...responsePayload, findings: finding, origin };
		if (origin === 'executor') this.#emit(run.id, 'run.cycle-response', payload);
		else this.#transition(run.id, 'working', 'run.cycle-response', { payload });
		return {
			resume: true,
			...(origin === 'executor'
				? { internalGuidance: { question: finding, guidance: normalized } }
				: origin === 'review'
				? { reviewFeedback: this.#cycleReviewFeedback(finding, normalized) }
				: { fullVerifyFeedback: this.#cycleReviewFeedback(finding, normalized) }),
			...(ciFeedback === undefined ? {} : { ciFeedback }),
		};
	}

	/**
	 * The project's full verification manifest (GSHIP-649) -- `package.json`'s
	 * own `verify` script, e.g. `bun run check:all` -- run once the issue's own
	 * verify and the independent review are both clean, in its own phase
	 * (`full-verify`, run-state.ts) exactly like shipping is its own phase after
	 * `ready-to-ship`. The slice the issue verify and the review each cover is
	 * always a cutout of the project's whole; this is the gate that catches what
	 * the cutout missed -- a stale bundle, a lint rule that moved -- as a fix
	 * round the executor still owns, instead of a CI failure discovered once
	 * nobody is in the loop anymore. `cleanKind` is the transition that got the
	 * run here (`run.verified` with no reviewer configured, `run.review-clean`
	 * otherwise); reused verbatim as the entry into `full-verify` so the event
	 * still reads as what actually happened. Optional like `#reviewer`: with no
	 * full verifier configured, `cleanKind` instead lands the run directly on
	 * `ready-to-ship`, unchanged from before this gate existed. Returns the next
	 * attempt when a failure buys the single automatic fix, or null once the run
	 * has settled (clean, skipped, or handed to the operator).
	 */
	async #enterFullVerify(
		run: RunRecord,
		signal: AbortSignal,
		executionInput: RuntimeExecutionInput,
		cleanKind: string,
	): Promise<RunAttempt | null> {
		const fullVerifier = this.#fullVerifier;
		if (fullVerifier === undefined) {
			this.#transition(run.id, 'ready-to-ship', cleanKind);
			return null;
		}
		this.#transition(run.id, 'full-verify', cleanKind);
		const pendingQuestion = this.#pendingCycleQuestion(run.id);
		if (pendingQuestion !== null) {
			return this.#answerCycleQuestion(
				run, signal, pendingQuestion.questionId, pendingQuestion.finding,
				pendingQuestion.origin, executionInput.ciFeedback,
			);
		}
		const result = await fullVerifier.verify(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return null;
		}
		if (result.ok) {
			this.#transition(run.id, 'ready-to-ship', result.skipped ? 'run.full-verify-skipped' : 'run.full-verify-clean');
			return null;
		}
		const detail = result.detail ?? 'Full project verification failed.';
		if (this.#fullVerifyFixUsed(run.id)) {
			return this.#askCycleQuestion(run, signal, detail, 'full-verify', executionInput.ciFeedback);
		}
		this.#transition(run.id, 'working', 'run.full-verify-fix-requested', {
			payload: { findings: detail },
		});
		return {
			resume: true,
			fullVerifyFeedback: detail,
			...(executionInput.ciFeedback === undefined ? {} : { ciFeedback: executionInput.ciFeedback }),
		};
	}

	/**
	 * Whether this run already spent its one automatic full-verify fix round,
	 * read from the durable decision log (GSHIP-649) rather than an in-memory
	 * counter, so a second failure ends the run at waiting-user even across a
	 * crash-and-resume between the two full-verify attempts. Deliberately
	 * independent of `fixRounds`: a full-verify failure is never a review
	 * finding, and consuming the review's own one-round budget for it would tie
	 * two unrelated gates together for no reason the spec asks for.
	 */
	#fullVerifyFixUsed(runId: string): boolean {
		return this.#store.listRunDecisionEvents(runId)
			.some((event) => event.kind === 'run.full-verify-fix-requested');
	}

	#latestCiEvidence(runId: string): unknown {
		return this.#store.listRunDecisionEvents(runId)
			.findLast((event) => event.kind === 'run.ci-fix-requested')?.payload['evidence'];
	}

	/**
	 * Durable capture of the ideas an accepted result reported outside the issue
	 * it implemented. Deliberately outside the state machine: capturing an idea
	 * never moves the run, and a capture that fails is recorded and left behind
	 * instead of turning verified work into a failure.
	 */
	#captureProposals(run: RunRecord, proposals: readonly ProposalDraft[] | undefined): void {
		if (proposals === undefined || proposals.length === 0) return;
		try {
			const captured = this.#store.recordProposals({
				runId: run.id,
				issueId: run.issueId,
				proposals,
				createdAt: this.#now(),
			});
			if (captured.length === 0) return;
			this.#emit(run.id, 'run.proposals-captured', {
				proposalIds: captured.map((proposal) => proposal.id),
			});
		} catch (error) {
			this.#emit(run.id, 'run.proposals-failed', { error: errorMessage(error) });
		}
	}

	/**
	 * `providerId` and `sessionId` always name the run's own historical origin
	 * -- the reviewer, the verifier and everything else this input reaches read
	 * only those, unaffected by any executor handoff. Once this run has spent
	 * its one executor handoff (GSHIP-722) -- win or refusal, `selectExecutorHandoff`
	 * reads either -- `executorRoute` carries where the executor role alone
	 * keeps running: a successful handoff keeps resuming the alternate's own
	 * native session, forever, on this run; a refused one leaves `executorRoute`
	 * absent, exactly as if the handoff had never existed. Either way
	 * `executorHandoffAllowed` is false, so the router never spends a second
	 * one and never pings back to the provider this run started on.
	 */
	#executionInput(
		run: RunRecord,
		signal: AbortSignal,
		attempt: RunAttempt,
	): RuntimeExecutionInput {
		const decisionEvents = this.#store.listRunDecisionEvents(run.id);
		const handoff = selectExecutorHandoff(decisionEvents);
		const onAlternate = handoff !== null && handoff.outcome !== 'refused';
		return {
			runId: run.id,
			issueId: run.issueId,
			sessionId: run.sessionId,
			providerId: run.providerId,
			resume: attempt.resume,
			cwd: run.workspacePath.length === 0 ? this.#cwd : run.workspacePath,
			signal,
			emit: (kind, payload, eventClass) => this.#emit(run.id, kind, payload, eventClass),
			setSessionId: (sessionId: string) => this.#setSessionId(run, sessionId),
			operatorDecisions: selectOperatorDecisions(decisionEvents),
			executorHandoffAllowed: handoff === null && this.#store.getRuntimeSetting(EXECUTOR_HANDOFF_ENABLED_KEY) === 'true',
			...(onAlternate ? { executorRoute: { providerId: handoff.to, sessionId: handoff.sessionId } } : {}),
			...(attempt.reviewFeedback === undefined
				? {}
				: { reviewFeedback: attempt.reviewFeedback }),
			...(attempt.verificationFeedback === undefined
				? {}
				: { verificationFeedback: attempt.verificationFeedback }),
			...(attempt.fullVerifyFeedback === undefined
				? {}
				: { fullVerifyFeedback: attempt.fullVerifyFeedback }),
			...(attempt.ciFeedback === undefined ? {} : { ciFeedback: attempt.ciFeedback }),
			...(attempt.operatorGuidance === undefined
				? {}
				: { operatorGuidance: attempt.operatorGuidance }),
			...(attempt.internalGuidance === undefined
				? {}
				: { internalGuidance: attempt.internalGuidance }),
		};
	}

	#setSessionId(run: RunRecord, sessionId: string): void {
		const normalized = sessionId.trim();
		if (normalized.length === 0 || normalized === run.sessionId) return;
		this.#store.setSessionId(run.id, normalized);
		run.sessionId = normalized;
		this.#emit(run.id, 'provider.session', { providerSessionId: normalized });
	}

	/** Persist one progress event that does not move the run's state. */
	#emit(runId: string, kind: string, payload?: Record<string, unknown>, eventClass?: RunEventClass): void {
		const event = this.#store.appendEvent({
			runId,
			kind,
			createdAt: this.#now(),
			...(payload === undefined ? {} : { payload }),
			...(eventClass === undefined ? {} : { eventClass }),
		});
		this.#publish(event);
	}

	#interrupt(runId: string): void {
		const current = this.#store.getRun(runId);
		if (current !== null && canTransition(current.state, 'interrupted')) {
			this.#transition(runId, 'interrupted', 'run.interrupted');
		}
	}

	#transition(
		runId: string,
		toState: RunRecord['state'],
		kind: string,
		values: {
			summary?: string;
			error?: string;
			payload?: Record<string, unknown>;
		} = {},
	): { run: RunRecord; event: RunEvent } {
		const transitioned = this.#store.transition({
			runId,
			toState,
			kind,
			createdAt: this.#now(),
			...(values.summary === undefined ? {} : { summary: values.summary }),
			...(values.error === undefined ? {} : { error: values.error }),
			...(values.payload === undefined ? {} : { payload: values.payload }),
		});
		this.#publish(transitioned.event);
		// The terminal transition IS the trigger (GSHIP-638): no loop, no timer,
		// no process of its own chases it separately.
		if (isTerminalRunState(toState)) this.#maybeChain(transitioned.run);
		return transitioned;
	}

	#publish(event: RunEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	/**
	 * Evaluate chaining at the terminal transition that already exists
	 * (GSHIP-638). Wrapped end-to-end so a chaining failure -- a bad backlog
	 * read, a stale preflight -- is recorded and never unwinds into the
	 * transition that triggered it.
	 */
	#maybeChain(run: RunRecord): void {
		try {
			this.#attemptChain(run);
		} catch (error) {
			this.#emitChainPause(run.id, CHAIN_PAUSE_REASONS.startFailed, { error: errorMessage(error) });
		}
	}

	/**
	 * The chain switch creates no new authority: it only starts what is already
	 * admissible (approved, with a matching fingerprint, and not blocked --
	 * `isPlannable`, src/issues/plannable.ts), and only a run that settled as
	 * `done` advances it. Every other outcome -- including the switch being off
	 * -- is an explicit, reasoned pause, recorded in the same durable event log.
	 */
	#attemptChain(run: RunRecord): void {
		if (!this.#store.getChainRunsEnabled()) {
			this.#emitChainPause(run.id, CHAIN_PAUSE_REASONS.disabled);
			return;
		}
		if (run.state !== 'done') {
			this.#emitChainPause(run.id, CHAIN_PAUSE_REASONS.notDone);
			return;
		}
		const nextIssueId = this.#nextAdmissibleIssueId();
		if (nextIssueId === null) {
			this.#emitChainPause(run.id, CHAIN_PAUSE_REASONS.noAdmissibleIssue);
			return;
		}
		void this.startNextAdmissibleIssue().catch((error) => {
			const reason = error instanceof RuntimeConflictError
				? CHAIN_PAUSE_REASONS.runActive
				: CHAIN_PAUSE_REASONS.startFailed;
			this.#emitChainPause(run.id, reason, { issueId: nextIssueId, error: errorMessage(error) });
		});
	}

	/**
	 * Deterministic by id order (GSHIP-638), never a priority field: the first
	 * plannable entry in the backlog's own order, which `listBacklog` (e.g.
	 * `readBacklogFromMain`) already returns sorted ascending by numeric id.
	 */
	#nextAdmissibleIssueId(): string | null {
		const backlog = this.#listBacklog?.() ?? [];
		return backlog.find((entry) => isPlannable(entry, backlog))?.id ?? null;
	}

	#emitChainPause(runId: string, reason: ChainPauseReason, extra?: Record<string, unknown>): void {
		this.#emit(runId, 'run.chain-paused', { reason, ...extra });
	}

	/** Retry cleanup of runs a merge, an abandon or a failure already settled durably. */
	#reconcileFinishedWorkspaces(): void {
		if (this.#workspace?.release === undefined) return;
		for (const run of this.#store.listRuns(10_000)) {
			if (run.state === 'done' || run.state === 'cancelled' || run.state === 'failed') {
				this.#releaseFinishedWorkspace(run, true, false);
			}
		}
	}

	/**
	 * Cleanup is deliberately outside the run state machine: a merged, cancelled
	 * or failed run keeps its terminal state even when local resource release
	 * needs operator attention or a later startup retry. Abandoned and failed
	 * releases additionally only proceed once the branch has no commit missing
	 * from the base ref (GSHIP-658), because nothing else guarantees that work
	 * exists anywhere but that branch -- it stays preserved on both the local
	 * and the remote side, next to the notice, instead of being thrown away.
	 * The merge path never gates on that check: `ship` merges with
	 * `--squash` (github-shipper.ts), which lands a brand-new commit on the
	 * base ref, so a merged branch's own commits are never reachable from it
	 * -- the check would misreport every merge as carrying a missing commit.
	 * The merge itself, not commit reachability, is the merge path's own proof
	 * that the work landed elsewhere. A remote-delete failure never preserves
	 * the release itself (the local side is already gone): it is instead
	 * recorded durably by `#hasPendingRemoteDelete` and retried on every later
	 * call for this run, e.g. the next service startup, until it succeeds or
	 * the branch turns out already gone.
	 */
	#releaseFinishedWorkspace(run: RunRecord, reconciled: boolean, refresh = true): void {
		if (this.#workspace?.release === undefined || run.workspacePath.length === 0) return;
		const hadPendingRemoteDelete = this.#hasPendingRemoteDelete(run.id);
		let result: ReturnType<NonNullable<RuntimeWorkspace['release']>>;
		try {
			result = this.#workspace.release({
				runId: run.id,
				issueId: run.issueId,
				workspacePath: run.workspacePath,
				requireUpstream: run.state !== 'done',
				...(hadPendingRemoteDelete ? { retryRemoteDelete: true } : {}),
			});
		} catch (error) {
			this.#emitWorkspaceCleanupWarning(run.id, errorMessage(error));
			if (refresh) this.#refreshWorkspaceNotices();
			return;
		}

		if (result.outcome === 'preserved') {
			this.#emitWorkspaceCleanupWarning(run.id, result.detail);
		} else {
			if (!this.#store.listRunEvents(run.id)
				.some((event) => event.kind === 'workspace.released')) {
				this.#emit(run.id, 'workspace.released', {
					branch: result.branch,
					outcome: result.outcome,
					reconciled,
				});
			}
			if (result.remoteWarning !== undefined) {
				this.#emitWorkspaceCleanupWarning(run.id, result.remoteWarning);
				this.#markPendingRemoteDelete(run.id, result.remoteWarning);
			} else if (hadPendingRemoteDelete) {
				this.#resolvePendingRemoteDelete(run.id);
			}
		}
		if (refresh) this.#refreshWorkspaceNotices();
	}

	#emitWorkspaceCleanupWarning(runId: string, detail: string): void {
		const last = this.#store.listRunEvents(runId).at(-1);
		if (last?.kind === 'workspace.cleanup-warning' && last.payload['detail'] === detail) return;
		this.#emit(runId, 'workspace.cleanup-warning', { detail });
	}

	/**
	 * Durable, unbounded by `listRunEvents`' display window (GSHIP-658): a run
	 * whose remote branch delete failed long ago must still be found the next
	 * time this is checked, however many events it has accumulated since.
	 */
	#hasPendingRemoteDelete(runId: string): boolean {
		const last = this.#store.listRunDecisionEvents(runId)
			.filter((event) => event.kind === 'workspace.remote-delete-pending'
				|| event.kind === 'workspace.remote-delete-resolved')
			.at(-1);
		return last?.kind === 'workspace.remote-delete-pending';
	}

	/**
	 * Recorded once per failure streak, not on every retry: the visible
	 * `workspace.cleanup-warning` above already dedupes on the detail text, so
	 * this only needs to track whether the streak is still open.
	 */
	#markPendingRemoteDelete(runId: string, detail: string): void {
		if (this.#hasPendingRemoteDelete(runId)) return;
		this.#emit(runId, 'workspace.remote-delete-pending', { detail });
	}

	#resolvePendingRemoteDelete(runId: string): void {
		this.#emit(runId, 'workspace.remote-delete-resolved');
	}

	#refreshWorkspaceNotices(): void {
		const inspect = this.#workspace?.inspect;
		if (inspect === undefined) {
			this.#workspaceNotices = [];
			return;
		}
		const runs: WorkspaceRunReference[] = this.#store.listRuns(10_000)
			.filter((run) => run.workspacePath.length > 0)
			.map((run) => ({
				runId: run.id,
				issueId: run.issueId,
				workspacePath: run.workspacePath,
				state: run.state === 'done' || run.state === 'failed' || run.state === 'cancelled'
					? run.state
					: 'active',
			}));
		this.#workspaceNotices = inspect.call(this.#workspace, runs);
	}
}
