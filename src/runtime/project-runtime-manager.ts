import type { RegisteredProject, ProjectRegistry } from './project-registry.ts';
import { RuntimeConflictError } from './run-runtime.ts';
import type { RunRecord } from './run-store.ts';
import { isTerminalRunState } from './run-state.ts';

export interface ManagedProjectRuntime {
	runtime: {
		listRuns(limit?: number): RunRecord[];
	};
	close(): Promise<void> | void;
}

export class ProjectRuntimeLookupError extends Error {
	constructor(
		readonly code: 'project-not-found' | 'project-not-ready',
		message: string,
		readonly status: 404 | 409,
	) {
		super(message);
		this.name = 'ProjectRuntimeLookupError';
	}
}

/**
 * Owns one lazily-composed lifecycle context per registered project. Contexts
 * are never rebound: once composed, a project keeps its own root, state
 * directory, SQLite connection and collaborators until process shutdown.
 */
export class ProjectRuntimeManager<T extends ManagedProjectRuntime> {
	readonly #contexts = new Map<string, T>();

	constructor(
		private readonly registry: ProjectRegistry,
		private readonly currentRoot: string,
		private readonly compose: (project: RegisteredProject) => T,
	) {}

	register(projectId: string, context: T): void {
		this.#contexts.set(projectId, context);
	}

	/**
	 * Readiness gates composition, not a context this manager already owns. The
	 * only context registered without being composed here is the boot project's,
	 * whose runtime is the process's own -- the same one the unscoped routes
	 * answer from whatever its readiness is. So a boot project still in
	 * onboarding keeps answering its own scoped reads and its own stream instead
	 * of losing its snapshot, its notices and its version to a refusal the
	 * unscoped routes never gave; `admitStart` and `admitResume` already read an
	 * owned context the same way. Everything else is unchanged: an unknown
	 * project is still not found, and a project with no context is still refused
	 * unless the registry reports it ready.
	 */
	get(projectId: string): { project: RegisteredProject; context: T } {
		const project = this.registry.get(projectId, this.currentRoot);
		if (project === null) {
			throw new ProjectRuntimeLookupError('project-not-found', 'Project not found.', 404);
		}
		const owned = this.#contexts.get(project.id);
		if (owned !== undefined) return { project, context: owned };
		if (project.readiness !== 'ready') {
			throw new ProjectRuntimeLookupError(
				'project-not-ready',
				'The requested project is not ready.',
				409,
			);
		}
		const context = this.compose(project);
		this.#contexts.set(project.id, context);
		return { project, context };
	}

	/** Admit a new run only when the whole registered project set is idle. */
	admitStart(projectId: string): T {
		const requested = this.#contexts.get(projectId) ?? this.get(projectId).context;
		const blocking = this.#firstBlockingRun();
		if (blocking !== null) throw globalAdmissionConflict(blocking.project, blocking.run);
		return requested;
	}

	/**
	 * An interrupted run is itself non-terminal. Resuming it is allowed when it
	 * is the sole global owner; any other non-terminal run keeps admission.
	 */
	admitResume(projectId: string, runId: string): T {
		const requested = this.#contexts.get(projectId) ?? this.get(projectId).context;
		const blocking = this.#firstBlockingRun({ projectId, runId });
		if (blocking !== null) throw globalAdmissionConflict(blocking.project, blocking.run);
		return requested;
	}

	async close(): Promise<void> {
		const contexts = [...this.#contexts.values()];
		this.#contexts.clear();
		await Promise.all(contexts.map((context) => context.close()));
	}

	#firstBlockingRun(except?: { projectId: string; runId: string }): {
		project: RegisteredProject;
		run: RunRecord;
	} | null {
		// Admission is the only operation that must observe every project. Compose
		// ready registrations here so an unopened project's durable non-terminal
		// run cannot be bypassed after a service restart.
		for (const project of this.registry.list(this.currentRoot)) {
			let context = this.#contexts.get(project.id);
			if (context === undefined) {
				if (project.readiness !== 'ready') continue;
				context = this.get(project.id).context;
			}
			const run = context.runtime.listRuns().find((candidate) =>
				!isTerminalRunState(candidate.state)
				&& (except === undefined
					|| project.id !== except.projectId
					|| candidate.id !== except.runId));
			if (run !== undefined) return { project, run };
		}
		return null;
	}
}

function globalAdmissionConflict(project: RegisteredProject, run: RunRecord): RuntimeConflictError {
	return new RuntimeConflictError(
		`run ${run.id} in project ${project.id} is still ${run.state}; resume or finish it first`,
	);
}
