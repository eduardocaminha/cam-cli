import { randomUUID } from 'node:crypto';

import { canTransition, isTerminalRunState } from './run-state.ts';
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

export interface RunRuntimeOptions {
	cwd: string;
	store: RunStore;
	executor?: RuntimeExecutor;
	verifier?: RuntimeVerifier;
	now?: () => string;
	newId?: () => string;
	newSessionId?: () => string;
	preflight?: (issueId: string) => void;
}

export class RuntimeUnavailableError extends Error {
	constructor() {
		super('No runtime executor and verifier are configured yet.');
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RunRuntime {
	readonly #cwd: string;
	readonly #store: RunStore;
	readonly #executor: RuntimeExecutor | undefined;
	readonly #verifier: RuntimeVerifier | undefined;
	readonly #now: () => string;
	readonly #newId: () => string;
	readonly #newSessionId: () => string;
	readonly #preflight: ((issueId: string) => void) | undefined;
	readonly #listeners = new Set<EventListener>();
	readonly #active = new Map<string, ActiveRun>();

	constructor(options: RunRuntimeOptions) {
		this.#cwd = options.cwd;
		this.#store = options.store;
		this.#executor = options.executor;
		this.#verifier = options.verifier;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#newId = options.newId ?? randomUUID;
		this.#newSessionId = options.newSessionId ?? randomUUID;
		this.#preflight = options.preflight;
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
		const created = this.#store.createRun({
			id: this.#newId(),
			issueId: normalizedIssueId,
			sessionId: this.#newSessionId(),
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

	getRun(runId: string): RunRecord | null {
		return this.#store.getRun(runId);
	}

	listRuns(limit?: number): RunRecord[] {
		return this.#store.listRuns(limit);
	}

	listEvents(afterSeq?: number): RunEvent[] {
		return this.#store.listEvents(afterSeq);
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
		const executionInput: RuntimeExecutionInput = {
			runId: run.id,
			issueId: run.issueId,
			sessionId: run.sessionId,
			resume,
			cwd: this.#cwd,
			signal,
			emit: (kind, payload) => {
				const event = this.#store.appendEvent({
					runId: run.id,
					kind,
					createdAt: this.#now(),
					...(payload === undefined ? {} : { payload }),
				});
				this.#publish(event);
			},
		};

		try {
			const execution = await executor.execute(executionInput);
			if (signal.aborted) {
				this.#interrupt(run.id);
				return;
			}
			if (execution?.outcome === 'waiting-user') {
				this.#transition(run.id, 'waiting-user', 'run.waiting-user', {
					summary: execution.summary,
				});
				return;
			}

			this.#transition(run.id, 'verify', 'run.work-completed', {
				summary: execution.summary,
			});
			const verification = await verifier.verify(executionInput);
			if (signal.aborted) {
				this.#interrupt(run.id);
				return;
			}
			if (verification.ok) {
				this.#transition(run.id, 'ready-to-ship', 'run.verified');
				return;
			}
			const detail = verification.detail ?? 'Verification failed.';
			this.#transition(run.id, 'failed', 'run.verification-failed', {
				error: detail,
			});
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
		values: { summary?: string; error?: string } = {},
	): { run: RunRecord; event: RunEvent } {
		const transitioned = this.#store.transition({
			runId,
			toState,
			kind,
			createdAt: this.#now(),
			...(values.summary === undefined ? {} : { summary: values.summary }),
			...(values.error === undefined ? {} : { error: values.error }),
		});
		this.#publish(transitioned.event);
		return transitioned;
	}

	#publish(event: RunEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}
