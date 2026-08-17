import { randomUUID } from 'node:crypto';
import type { AgentProviderId } from './agent-session.ts';
import type {
	RuntimeWorkspace,
	WorkspaceNotice,
	WorkspaceRunReference,
} from './git-workspace.ts';
import type { ModelSettings } from './model-settings.ts';
import type { ProposalDraft, RunProposal } from './run-proposal.ts';
import { canTransition, isTerminalRunState } from './run-state.ts';
import {
	type OrchestratorHandoff,
	type OrchestratorMessage,
	type OrchestratorMessageRole,
	type ProjectBrief,
	type RunEvent,
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
	emit: (kind: string, payload?: Record<string, unknown>) => void;
	/** Persist a provider-assigned thread id as soon as it becomes available. */
	setSessionId?: (sessionId: string) => void;
	/**
	 * Findings from the independent review, present only on the single
	 * automatic fix round. The reviewer runs in its own session, so this is the
	 * only channel that puts its verdict in front of the executor.
	 */
	reviewFeedback?: string;
	/** Explicit response supplied by the operator when resuming a paused run. */
	operatorGuidance?: string;
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
}

export interface RuntimeVerifier {
	verify: (input: RuntimeExecutionInput) => Promise<RuntimeVerificationResult>;
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
	emit: (kind: string, payload?: Record<string, unknown>) => void;
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
	shipper?: RuntimeShipper;
	now?: () => string;
	newId?: () => string;
	newSessionId?: () => string;
	preflight?: (issueId: string) => void;
	workspace?: RuntimeWorkspace;
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

type EventListener = (event: RunEvent) => void;

interface ActiveRun {
	controller: AbortController;
	promise: Promise<void>;
}

/** One implementation attempt: the first pass, or the single review fix. */
interface RunAttempt {
	resume: boolean;
	reviewFeedback?: string;
	operatorGuidance?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RunRuntime {
	readonly #cwd: string;
	readonly #store: RunStore;
	readonly #executor: RuntimeExecutor | undefined;
	readonly #verifier: RuntimeVerifier | undefined;
	readonly #reviewer: RuntimeReviewer | undefined;
	readonly #shipper: RuntimeShipper | undefined;
	readonly #now: () => string;
	readonly #newId: () => string;
	readonly #newSessionId: () => string;
	readonly #preflight: ((issueId: string) => void) | undefined;
	readonly #workspace: RuntimeWorkspace | undefined;
	readonly #listeners = new Set<EventListener>();
	readonly #active = new Map<string, ActiveRun>();
	#workspaceNotices: WorkspaceNotice[] = [];

	constructor(options: RunRuntimeOptions) {
		this.#cwd = options.cwd;
		this.#store = options.store;
		this.#executor = options.executor;
		this.#verifier = options.verifier;
		this.#reviewer = options.reviewer;
		this.#shipper = options.shipper;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#newId = options.newId ?? randomUUID;
		this.#newSessionId = options.newSessionId ?? randomUUID;
		this.#preflight = options.preflight;
		this.#workspace = options.workspace;
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
		if (run.state !== 'interrupted' && run.state !== 'waiting-user') {
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
	): OrchestratorMessage {
		return this.#store.appendOrchestratorMessage({
			providerId,
			role,
			text,
			createdAt: this.#now(),
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
		this.#transition(run.id, 'working', 'run.started');

		try {
			// One pass per implementation attempt. A findings verdict starts the
			// second and last pass; the fix-round ceiling lives in run-state.ts.
			let attempt = firstAttempt;
			for (;;) {
				const executionInput = this.#executionInput(run, signal, attempt);
				const verified = await this.#work(executor, verifier, run, signal, executionInput);
				if (!verified) return;
				const next = await this.#review(run, signal, executionInput);
				if (next === null) break;
				attempt = next;
			}
			// A run that got here verified and reviewed clean ships under the same
			// ownership: the operator asked for the change, not for a button.
			const shipper = this.#shipper;
			if (shipper === undefined) return;
			if (this.#store.getRun(run.id)?.state !== 'ready-to-ship') return;
			await this.#driveShip(shipper, run, signal);
		} catch (error) {
			if (signal.aborted) {
				this.#interrupt(run.id);
				return;
			}
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
				emit: (kind, payload) => this.#emit(run.id, kind, payload),
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
	 * findings buy the single automatic fix, or null once the run has settled.
	 */
	async #review(
		run: RunRecord,
		signal: AbortSignal,
		executionInput: RuntimeExecutionInput,
	): Promise<RunAttempt | null> {
		const reviewer = this.#reviewer;
		if (reviewer === undefined) {
			this.#transition(run.id, 'ready-to-ship', 'run.verified');
			return null;
		}
		this.#transition(run.id, 'review', 'run.review-started');
		const review = await reviewer.review(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return null;
		}
		if (review.verdict === 'clean') {
			this.#transition(run.id, 'ready-to-ship', 'run.review-clean');
			return null;
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
			emit: (kind, payload) => this.#emit(run.id, kind, payload),
			setSessionId: (sessionId) => this.#setSessionId(run, sessionId),
			...(attempt.reviewFeedback === undefined
				? {}
				: { reviewFeedback: attempt.reviewFeedback }),
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
	#emit(runId: string, kind: string, payload?: Record<string, unknown>): void {
		const event = this.#store.appendEvent({
			runId,
			kind,
			createdAt: this.#now(),
			...(payload === undefined ? {} : { payload }),
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
		return transitioned;
	}

	#publish(event: RunEvent): void {
		for (const listener of this.#listeners) listener(event);
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
	 * needs operator attention or a later startup retry. `failed` additionally
	 * only releases once its branch has no commit missing from the base ref, so
	 * a commit made before the failure is preserved next to the notice.
	 */
	#releaseFinishedWorkspace(run: RunRecord, reconciled: boolean, refresh = true): void {
		if (this.#workspace?.release === undefined || run.workspacePath.length === 0) return;
		let result: ReturnType<NonNullable<RuntimeWorkspace['release']>>;
		try {
			result = this.#workspace.release({
				runId: run.id,
				issueId: run.issueId,
				workspacePath: run.workspacePath,
				...(run.state === 'failed' ? { requireUpstream: true } : {}),
			});
		} catch (error) {
			this.#emitWorkspaceCleanupWarning(run.id, errorMessage(error));
			if (refresh) this.#refreshWorkspaceNotices();
			return;
		}

		if (result.outcome === 'preserved') {
			this.#emitWorkspaceCleanupWarning(run.id, result.detail);
		} else if (!this.#store.listRunEvents(run.id)
			.some((event) => event.kind === 'workspace.released')) {
			this.#emit(run.id, 'workspace.released', {
				branch: result.branch,
				outcome: result.outcome,
				reconciled,
			});
		}
		if (refresh) this.#refreshWorkspaceNotices();
	}

	#emitWorkspaceCleanupWarning(runId: string, detail: string): void {
		const last = this.#store.listRunEvents(runId).at(-1);
		if (last?.kind === 'workspace.cleanup-warning' && last.payload['detail'] === detail) return;
		this.#emit(runId, 'workspace.cleanup-warning', { detail });
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
