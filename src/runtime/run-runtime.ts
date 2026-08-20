import { randomUUID } from 'node:crypto';
import {
	PROVIDER_ERROR_KINDS,
	ProviderCallError,
	type AgentProviderId,
	type ProviderErrorKind,
} from './agent-session.ts';
import { isPlannable } from '../issues/plannable.ts';
import type { IssueEntry } from '../issues/types.ts';
import type {
	RuntimeWorkspace,
	WorkspaceNotice,
	WorkspaceRunReference,
} from './git-workspace.ts';
import type { ModelSettings } from './model-settings.ts';
import { selectOperatorDecisions } from './operator-decision.ts';
import { selectRunRoundOrigins, type RunRoundOrigins } from './round-origin.ts';
import type { ProposalDraft, RunProposal } from './run-proposal.ts';
import { canTransition, isTerminalRunState } from './run-state.ts';
import {
	type OrchestratorHandoff,
	type OrchestratorMessage,
	type OrchestratorMessageRole,
	type OrchestratorMessageUsage,
	type ProjectBrief,
	type RunCostSummary,
	type RunEvent,
	type RunEventClass,
	type RunRecord,
	RunStore,
} from './run-store.ts';

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
	/**
	 * The full-project verification's failure output (GSHIP-649), present only
	 * on the single automatic fix round after the project's own `verify`
	 * script rejected an otherwise clean, reviewed change. Independent of
	 * `reviewFeedback`: this channel never carries the code reviewer's own
	 * verdict, only the full verification's.
	 */
	fullVerifyFeedback?: string;
	/** Explicit response supplied by the operator when resuming a paused run. */
	operatorGuidance?: string;
	/**
	 * Every decision the operator has already made for this run, chronological
	 * (GSHIP-630) -- not only the latest one `operatorGuidance` carries. Read
	 * from the durable event log, so it survives past the resume that produced
	 * it. Reviewers fold this into their prompt so a ratification already made
	 * is not re-litigated on the next review; empty on a run's first review.
	 */
	operatorDecisions?: readonly string[];
}

export type RuntimeExecutionResult =
	/** `proposals` are ideas found outside the issue, never work done for it. */
	| { outcome: 'completed'; summary?: string; proposals?: readonly ProposalDraft[] }
	| { outcome: 'waiting-user'; summary: string };

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

/** What shipping one run needs: its own worktree, and a channel for progress. */
export interface RuntimeShipInput {
	runId: string;
	issueId: string;
	cwd: string;
	signal: AbortSignal;
	emit: (kind: string, payload?: Record<string, unknown>, eventClass?: RunEventClass) => void;
}

/**
 * Outcome of one ship attempt. `merged` is reported only once the pull request
 * is really merged; every other end is a failure the run can retry.
 */
export type RuntimeShipResult =
	| { outcome: 'merged'; prNumber: number }
	| { outcome: 'failed'; detail: string };

export interface RuntimeShipper {
	ship: (input: RuntimeShipInput) => Promise<RuntimeShipResult>;
}

export interface RunRuntimeOptions {
	cwd: string;
	store: RunStore;
	executor?: RuntimeExecutor;
	verifier?: RuntimeVerifier;
	reviewer?: RuntimeReviewer;
	/**
	 * The project's full verification manifest (GSHIP-649), run once the
	 * issue's own verify and the independent review are both clean and before
	 * the run is ever shipped. Optional like `reviewer`: a project or a test
	 * runtime with none configured skips straight to shipping, unchanged from
	 * before this gate existed.
	 */
	fullVerifier?: RuntimeVerifier;
	shipper?: RuntimeShipper;
	now?: () => string;
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
	phase: 'working' | 'review';
	retryAt?: string;
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
 * One implementation attempt: the first pass, the single review fix, or the
 * single full-verification fix (GSHIP-649).
 */
interface RunAttempt {
	resume: boolean;
	reviewFeedback?: string;
	fullVerifyFeedback?: string;
	operatorGuidance?: string;
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

export class RunRuntime {
	readonly #cwd: string;
	readonly #store: RunStore;
	readonly #executor: RuntimeExecutor | undefined;
	readonly #verifier: RuntimeVerifier | undefined;
	readonly #reviewer: RuntimeReviewer | undefined;
	readonly #fullVerifier: RuntimeVerifier | undefined;
	readonly #shipper: RuntimeShipper | undefined;
	readonly #now: () => string;
	readonly #newId: () => string;
	readonly #newSessionId: () => string;
	readonly #preflight: ((issueId: string) => void) | undefined;
	readonly #evidenceCheck: RuntimeEvidenceCheck | undefined;
	readonly #workspace: RuntimeWorkspace | undefined;
	readonly #listBacklog: (() => IssueEntry[]) | undefined;
	readonly #listeners = new Set<EventListener>();
	readonly #active = new Map<string, ActiveRun>();
	#workspaceNotices: WorkspaceNotice[] = [];

	constructor(options: RunRuntimeOptions) {
		this.#cwd = options.cwd;
		this.#store = options.store;
		this.#executor = options.executor;
		this.#verifier = options.verifier;
		this.#reviewer = options.reviewer;
		this.#fullVerifier = options.fullVerifier;
		this.#shipper = options.shipper;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#newId = options.newId ?? randomUUID;
		this.#newSessionId = options.newSessionId ?? randomUUID;
		this.#preflight = options.preflight;
		this.#evidenceCheck = options.evidenceCheck;
		this.#workspace = options.workspace;
		this.#listBacklog = options.listBacklog;
		this.#store.recoverUnownedRuns(this.#now());
		this.#reconcileFinishedWorkspaces();
		this.#refreshWorkspaceNotices();
	}

	startRun(issueId: string): RunRecord {
		if (this.#executor === undefined || this.#verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		const normalizedIssueId = issueId.trim();
		if (normalizedIssueId.length === 0) throw new Error('issueId is required');
		const blockingRun = this.#store.listRuns().find((run) => !isTerminalRunState(run.state));
		if (blockingRun !== undefined) {
			throw new RuntimeConflictError(
				`run ${blockingRun.id} is still ${blockingRun.state}; resume or finish it first`,
			);
		}
		this.#preflight?.(normalizedIssueId);
		const id = this.#newId();
		const workspacePath = this.#workspace?.prepare({
			runId: id,
			issueId: normalizedIssueId,
		}) ?? this.#cwd;
		const created = this.#store.createRun({
			id,
			issueId: normalizedIssueId,
			sessionId: this.#newSessionId(),
			providerId: this.#store.getSelectedProvider(),
			workspacePath,
			createdAt: this.#now(),
		});
		this.#publish(created.event);
		this.#launch(created.run, { resume: false });
		return created.run;
	}

	resumeRun(runId: string, operatorGuidance?: string): RunRecord {
		if (this.#executor === undefined || this.#verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		if (this.#active.has(runId)) throw new Error(`run is already active: ${runId}`);
		const run = this.#store.getRun(runId);
		if (run === null) throw new Error(`run not found: ${runId}`);
		if (run.state !== 'interrupted'
			&& run.state !== 'waiting-user'
			&& run.state !== 'waiting-provider') {
			throw new Error(`run cannot resume from state ${run.state}`);
		}
		const guidance = operatorGuidance?.trim();
		if (run.state === 'waiting-user' && (guidance === undefined || guidance.length === 0)) {
			throw new Error('operator guidance is required to resume a waiting-user run');
		}
		if (guidance !== undefined && guidance.length > 0) {
			this.#emit(run.id, 'run.operator-guidance', { text: guidance });
		}
		this.#launch(run, {
			resume: true,
			...(guidance === undefined || guidance.length === 0
				? {}
				: { operatorGuidance: guidance }),
		});
		return run;
	}

	/**
	 * End an interrupted run the operator does not want to resume. The provider
	 * session is never reopened -- abandoning is the opposite of resuming -- and
	 * the run settles as cancelled, so it stops blocking the next issue. Only the
	 * run's own clean workspace and branch are released; a dirty leftover is
	 * preserved and surfaced, exactly as it is for a merged run.
	 */
	abandonRun(runId: string): RunRecord {
		if (this.#active.has(runId)) throw new Error(`run is already active: ${runId}`);
		const run = this.#store.getRun(runId);
		if (run === null) throw new Error(`run not found: ${runId}`);
		if (run.state !== 'interrupted') {
			throw new Error(`run cannot be abandoned from state ${run.state}`);
		}
		const abandoned = this.#transition(runId, 'cancelled', 'run.abandoned').run;
		this.#releaseFinishedWorkspace(abandoned, false);
		return abandoned;
	}

	/**
	 * Retry the ship of a run whose automatic attempt did not merge. A verified
	 * run ships itself, so this is the explicit second chance: only a run that
	 * is back in ready-to-ship can be shipped, and only one operation at a time
	 * owns a run, so a second request never opens a second pull request.
	 */
	shipRun(runId: string): RunRecord {
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
		const controller = new AbortController();
		const promise = this.#driveShip(shipper, run, controller.signal)
			.finally(() => this.#active.delete(run.id));
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

	/**
	 * Where this run's correction rounds came from -- the executor's own
	 * automatic fix or the consequence of an operator decision (GSHIP-659) --
	 * derived from the same durable decision log `listRunDecisionEvents`
	 * already exposes, unbounded by `listRunEvents`' display window.
	 */
	getRunRoundOrigins(runId: string): RunRoundOrigins {
		return selectRunRoundOrigins(this.#store.listRunDecisionEvents(runId));
	}

	/** Latest structured provider hold, present only while that run is resting on it. */
	getRunProviderWait(runId: string): RunProviderWait | null {
		if (this.#store.getRun(runId)?.state !== 'waiting-provider') return null;
		const event = this.#store.listRunDecisionEvents(runId)
			.findLast((candidate) => candidate.kind === 'run.provider-waiting');
		if (event === undefined) return null;
		const { provider, kind, message, phase, retryAt } = event.payload;
		if ((provider !== 'claude' && provider !== 'codex')
			|| typeof kind !== 'string'
			|| !(PROVIDER_ERROR_KINDS as readonly string[]).includes(kind)
			|| typeof message !== 'string'
			|| (phase !== 'working' && phase !== 'review')) {
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
		return this.#store.getSelectedProvider();
	}

	selectProvider(providerId: AgentProviderId): void {
		this.#store.setSelectedProvider(providerId);
	}

	/**
	 * The operator's per-role model choice. Read on demand -- every spawn asks
	 * again -- so a change takes effect without restarting the service.
	 */
	getModelSettings(): ModelSettings {
		return this.#store.getModelSettings();
	}

	setModelSettings(settings: ModelSettings): void {
		this.#store.setModelSettings(settings);
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

	getOrchestratorHandoff(): OrchestratorHandoff {
		return this.#store.getOrchestratorHandoff();
	}

	setOrchestratorHandoff(handoff: OrchestratorHandoff): void {
		this.#store.setOrchestratorHandoff(handoff, this.#now());
	}

	getProjectBrief(): ProjectBrief {
		return this.#store.getProjectBrief();
	}

	setProjectBrief(brief: ProjectBrief): void {
		this.#store.setProjectBrief(brief, this.#now());
	}

	appendOrchestratorMessage(
		providerId: AgentProviderId,
		role: OrchestratorMessageRole,
		text: string,
		usage?: OrchestratorMessageUsage,
	): OrchestratorMessage {
		return this.#store.appendOrchestratorMessage({
			providerId,
			role,
			text,
			createdAt: this.#now(),
			...(usage === undefined ? {} : { usage }),
		});
	}

	listOrchestratorMessages(limit?: number): OrchestratorMessage[] {
		return this.#store.listOrchestratorMessages(limit);
	}

	subscribe(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async cancelRun(runId: string): Promise<RunRecord | null> {
		const active = this.#active.get(runId);
		if (active !== undefined) {
			active.controller.abort();
			await active.promise;
			return this.#store.getRun(runId);
		}

		const current = this.#store.getRun(runId);
		if (current === null || isTerminalRunState(current.state)) return current;
		if (canTransition(current.state, 'interrupted')) {
			return this.#transition(runId, 'interrupted', 'run.cancelled').run;
		}
		return current;
	}

	async stop(): Promise<void> {
		const active = [...this.#active.values()];
		for (const run of active) run.controller.abort();
		await Promise.allSettled(active.map((run) => run.promise));
	}

	close(): void {
		if (this.#active.size > 0) throw new Error('cannot close a runtime with active runs');
		this.#store.close();
	}

	#launch(run: RunRecord, attempt: RunAttempt): void {
		const controller = new AbortController();
		const promise = this.#drive(run, controller.signal, attempt)
			.finally(() => this.#active.delete(run.id));
		this.#active.set(run.id, { controller, promise });
	}

	async #drive(run: RunRecord, signal: AbortSignal, firstAttempt: RunAttempt): Promise<void> {
		const executor = this.#executor;
		const verifier = this.#verifier;
		if (executor === undefined || verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		const providerWaitPhase = run.state === 'waiting-provider'
			? this.#providerWaitPhase(run.id)
			: null;
		if (providerWaitPhase !== 'review') {
			this.#transition(
				run.id,
				'working',
				providerWaitPhase === 'working' ? 'run.provider-retry-started' : 'run.started',
			);
		}

		try {
			if (await this.#checkEvidence(run, signal, firstAttempt)) return;
			await this.#driveImplementation(
				executor,
				verifier,
				run,
				signal,
				firstAttempt,
				providerWaitPhase === 'review',
			);
		} catch (error) {
			if (signal.aborted) {
				this.#interrupt(run.id);
				return;
			}
			if (this.#restForProviderFailure(run.id, error)) return;
			const current = this.#store.getRun(run.id);
			if (current !== null && canTransition(current.state, 'failed')) {
				const failedRun = this.#transition(run.id, 'failed', 'run.failed', {
					error: errorMessage(error),
				}).run;
				this.#releaseFinishedWorkspace(failedRun, false);
			}
		}
	}

	/**
	 * One pass per implementation attempt through work, review and the full
	 * project verification, and -- once all three are clean -- the ship
	 * attempt. A review finding or a full-verify failure (GSHIP-649) each buy
	 * the run its own single automatic fix round; either one persisting past
	 * that round ends the run at waiting-user instead of shipping or looping.
	 * The fix-round ceiling for review lives in run-state.ts; full-verify's own
	 * ceiling is tracked independently, by `#fullVerifyFixUsed`. `#review` owns
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
		resumeAtReview = false,
	): Promise<void> {
		let attempt = firstAttempt;
		if (resumeAtReview) {
			const next = await this.#review(
				run,
				signal,
				this.#executionInput(run, signal, attempt),
				'run.provider-retry-started',
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
			if (!verified) return;
			const next = await this.#review(run, signal, executionInput);
			if (next === null) break;
			attempt = next;
		}
		// A run that got here verified, reviewed and fully verified clean ships
		// under the same ownership: the operator asked for the change, not for a
		// button.
		await this.#shipIfReady(run, signal);
	}

	async #shipIfReady(run: RunRecord, signal: AbortSignal): Promise<void> {
		const shipper = this.#shipper;
		if (shipper === undefined) return;
		if (this.#store.getRun(run.id)?.state !== 'ready-to-ship') return;
		await this.#driveShip(shipper, run, signal);
	}

	#providerWaitPhase(runId: string): 'working' | 'review' {
		return this.getRunProviderWait(runId)?.phase ?? 'working';
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
			const result = await shipper.ship({
				runId: run.id,
				issueId: run.issueId,
				cwd: run.workspacePath.length === 0 ? this.#cwd : run.workspacePath,
				signal,
				emit: (kind, payload, eventClass) => this.#emit(run.id, kind, payload, eventClass),
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
			this.#transition(run.id, 'ready-to-ship', 'run.ship-failed', {
				payload: { error: result.detail },
			});
		} catch (error) {
			if (signal.aborted) {
				this.#transition(run.id, 'ready-to-ship', 'run.ship-cancelled');
				return;
			}
			this.#transition(run.id, 'ready-to-ship', 'run.ship-failed', {
				payload: { error: errorMessage(error) },
			});
		}
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
	 * One implementation pass plus its verification. Returns true only when the
	 * change is verified and the run is ready to be reviewed; every other
	 * outcome has already settled the run.
	 */
	async #work(
		executor: RuntimeExecutor,
		verifier: RuntimeVerifier,
		run: RunRecord,
		signal: AbortSignal,
		executionInput: RuntimeExecutionInput,
	): Promise<boolean> {
		const execution = await executor.execute(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return false;
		}
		if (execution?.outcome === 'waiting-user') {
			this.#transition(run.id, 'waiting-user', 'run.waiting-user', {
				summary: execution.summary,
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
		const failedRun = this.#transition(run.id, 'failed', 'run.verification-failed', {
			error: verification.detail ?? 'Verification failed.',
		}).run;
		this.#releaseFinishedWorkspace(failedRun, false);
		return false;
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
		const review = await reviewer.review(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return null;
		}
		if (review.verdict === 'clean') {
			return this.#enterFullVerify(run, signal, executionInput, 'run.review-clean');
		}
		if ((this.#store.getRun(run.id)?.fixRounds ?? 0) >= 1) {
			this.#transition(run.id, 'waiting-user', 'run.review-fix-limit', {
				summary: review.detail,
				payload: { findings: review.detail },
			});
			return null;
		}
		this.#transition(run.id, 'working', 'run.review-fix-requested', {
			payload: { findings: review.detail },
		});
		return { resume: true, reviewFeedback: review.detail };
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
			this.#transition(run.id, 'waiting-user', 'run.full-verify-fix-limit', {
				summary: detail,
				payload: { findings: detail },
			});
			return null;
		}
		this.#transition(run.id, 'working', 'run.full-verify-fix-requested', {
			payload: { findings: detail },
		});
		return { resume: true, fullVerifyFeedback: detail };
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

	#executionInput(
		run: RunRecord,
		signal: AbortSignal,
		attempt: RunAttempt,
	): RuntimeExecutionInput {
		return {
			runId: run.id,
			issueId: run.issueId,
			sessionId: run.sessionId,
			providerId: run.providerId,
			resume: attempt.resume,
			cwd: run.workspacePath.length === 0 ? this.#cwd : run.workspacePath,
			signal,
			emit: (kind, payload, eventClass) => this.#emit(run.id, kind, payload, eventClass),
			setSessionId: (sessionId) => this.#setSessionId(run, sessionId),
			operatorDecisions: selectOperatorDecisions(this.#store.listRunDecisionEvents(run.id)),
			...(attempt.reviewFeedback === undefined
				? {}
				: { reviewFeedback: attempt.reviewFeedback }),
			...(attempt.fullVerifyFeedback === undefined
				? {}
				: { fullVerifyFeedback: attempt.fullVerifyFeedback }),
			...(attempt.operatorGuidance === undefined
				? {}
				: { operatorGuidance: attempt.operatorGuidance }),
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
		try {
			this.startRun(nextIssueId);
		} catch (error) {
			const reason = error instanceof RuntimeConflictError
				? CHAIN_PAUSE_REASONS.runActive
				: CHAIN_PAUSE_REASONS.startFailed;
			this.#emitChainPause(run.id, reason, { issueId: nextIssueId, error: errorMessage(error) });
		}
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
