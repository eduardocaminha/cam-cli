import { randomUUID } from 'node:crypto';

import { canTransition, isTerminalRunState } from './run-state.ts';
import type { RuntimeWorkspace } from './git-workspace.ts';
import {
	type RunEvent,
	type RunRecord,
	RunStore,
} from './run-store.ts';

export interface RuntimeExecutionInput {
	runId: string;
	issueId: string;
	sessionId: string;
	resume: boolean;
	cwd: string;
	signal: AbortSignal;
	emit: (kind: string, payload?: Record<string, unknown>) => void;
	/**
	 * Findings from the independent review, present only on the single
	 * automatic fix round. The reviewer runs in its own session, so this is the
	 * only channel that puts its verdict in front of the executor.
	 */
	reviewFeedback?: string;
}

export type RuntimeExecutionResult =
	| { outcome: 'completed'; summary?: string }
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
		this.#store.interruptUnownedRuns(this.#now());
	}

	startRun(issueId: string): RunRecord {
		if (this.#executor === undefined || this.#verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		const normalizedIssueId = issueId.trim();
		if (normalizedIssueId.length === 0) throw new Error('issueId is required');
		const blockingRun = this.#store.listRuns().find((run) =>
			run.state !== 'done' && run.state !== 'failed');
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
			workspacePath,
			createdAt: this.#now(),
		});
		this.#publish(created.event);
		this.#launch(created.run, false);
		return created.run;
	}

	resumeRun(runId: string): RunRecord {
		if (this.#executor === undefined || this.#verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		if (this.#active.has(runId)) throw new Error(`run is already active: ${runId}`);
		const run = this.#store.getRun(runId);
		if (run === null) throw new Error(`run not found: ${runId}`);
		if (run.state !== 'interrupted' && run.state !== 'waiting-user') {
			throw new Error(`run cannot resume from state ${run.state}`);
		}
		this.#launch(run, true);
		return run;
	}

	/**
	 * Ship one verified run in the background. Only a run that reached
	 * ready-to-ship can be shipped, and only one operation at a time owns a run,
	 * so a second request never opens a second pull request.
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
		return run;
	}

	getRun(runId: string): RunRecord | null {
		return this.#store.getRun(runId);
	}

	listRuns(limit?: number): RunRecord[] {
		return this.#store.listRuns(limit);
	}

	listEvents(afterSeq?: number): RunEvent[] {
		return this.#store.listEvents(afterSeq);
	}

	listRunEvents(runId: string): RunEvent[] {
		return this.#store.listRunEvents(runId);
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

	#launch(run: RunRecord, resume: boolean): void {
		const controller = new AbortController();
		const promise = this.#drive(run, controller.signal, resume)
			.finally(() => this.#active.delete(run.id));
		this.#active.set(run.id, { controller, promise });
	}

	async #drive(run: RunRecord, signal: AbortSignal, resume: boolean): Promise<void> {
		const executor = this.#executor;
		const verifier = this.#verifier;
		if (executor === undefined || verifier === undefined) {
			throw new RuntimeUnavailableError();
		}
		this.#transition(run.id, 'working', 'run.started');

		try {
			// One pass per implementation attempt. A findings verdict starts the
			// second and last pass; the fix-round ceiling lives in run-state.ts.
			let attempt: RunAttempt = { resume };
			for (;;) {
				const executionInput = this.#executionInput(run, signal, attempt);
				const verified = await this.#work(executor, verifier, run, signal, executionInput);
				if (!verified) return;
				const next = await this.#review(run, signal, executionInput);
				if (next === null) return;
				attempt = next;
			}
		} catch (error) {
			if (signal.aborted) {
				this.#interrupt(run.id);
				return;
			}
			const current = this.#store.getRun(run.id);
			if (current !== null && canTransition(current.state, 'failed')) {
				this.#transition(run.id, 'failed', 'run.failed', {
					error: errorMessage(error),
				});
			}
		}
	}

	/**
	 * One ship attempt. The run reaches done only on a real merge; a failed
	 * attempt leaves it in ready-to-ship, so the same diff can be shipped again
	 * once GitHub or CI recovers, and cancellation is recorded the same way.
	 */
	async #driveShip(
		shipper: RuntimeShipper,
		run: RunRecord,
		signal: AbortSignal,
	): Promise<void> {
		this.#emit(run.id, 'run.ship-started');
		try {
			const result = await shipper.ship({
				runId: run.id,
				issueId: run.issueId,
				cwd: run.workspacePath.length === 0 ? this.#cwd : run.workspacePath,
				signal,
				emit: (kind, payload) => this.#emit(run.id, kind, payload),
			});
			if (signal.aborted) {
				this.#emit(run.id, 'run.ship-cancelled');
				return;
			}
			if (result.outcome === 'merged') {
				this.#transition(run.id, 'done', 'run.shipped', {
					payload: { prNumber: result.prNumber },
				});
				return;
			}
			this.#emit(run.id, 'run.ship-failed', { error: result.detail });
		} catch (error) {
			if (signal.aborted) {
				this.#emit(run.id, 'run.ship-cancelled');
				return;
			}
			this.#emit(run.id, 'run.ship-failed', { error: errorMessage(error) });
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
		const verification = await verifier.verify(executionInput);
		if (signal.aborted) {
			this.#interrupt(run.id);
			return false;
		}
		if (verification.ok) return true;
		this.#transition(run.id, 'failed', 'run.verification-failed', {
			error: verification.detail ?? 'Verification failed.',
		});
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

	#executionInput(
		run: RunRecord,
		signal: AbortSignal,
		attempt: RunAttempt,
	): RuntimeExecutionInput {
		return {
			runId: run.id,
			issueId: run.issueId,
			sessionId: run.sessionId,
			resume: attempt.resume,
			cwd: run.workspacePath.length === 0 ? this.#cwd : run.workspacePath,
			signal,
			emit: (kind, payload) => this.#emit(run.id, kind, payload),
			...(attempt.reviewFeedback === undefined
				? {}
				: { reviewFeedback: attempt.reviewFeedback }),
		};
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
}
