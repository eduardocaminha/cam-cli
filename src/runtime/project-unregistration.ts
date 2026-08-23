// src/runtime/project-unregistration.ts
//
// The reverse of admitting a checkout (GSHIP-716), and nothing more: take one
// project out of the global registry and leave everything it owns exactly
// where it is. No file is deleted or moved, no `.gship` state, worktree,
// branch, run, issue or Git metadata is touched, and no git, gh, network,
// provider or process command runs here -- so unregistering a project can
// never change the project being unregistered, and the same path can be
// registered again afterwards.

import { join } from 'node:path';

import type { ProjectRegistry, RegisteredProject } from './project-registry.ts';
import { readActivePersistedRun, type PersistedRunStatus } from './run-store.ts';

export type ProjectUnregistrationErrorCode =
	/** No registration carries that id. */
	| 'project-not-found'
	/** The checkout this process booted from: startup would register it again. */
	| 'project-is-current'
	/** A run this project has not finished still owns its runtime. */
	| 'project-has-active-run';

export class ProjectUnregistrationError extends Error {
	constructor(
		readonly code: ProjectUnregistrationErrorCode,
		message: string,
		readonly status: 404 | 409,
	) {
		super(message);
		this.name = 'ProjectUnregistrationError';
	}
}

/** The run a project has not finished, or `null` when it is idle. */
export type ActiveRunReader = (project: RegisteredProject) => PersistedRunStatus | null;

/**
 * A project with no runtime database, or one this process cannot read, has no
 * run it could still be owing: the refusal below exists to protect live work,
 * not to make an unreadable registration permanent.
 */
export const readProjectActiveRun: ActiveRunReader = (project) => {
	try {
		return readActivePersistedRun(join(project.stateDir, 'runtime.sqlite'));
	} catch {
		return null;
	}
};

/**
 * Remove one registration by id, or refuse with the reason. The two refusals
 * are ordered the way the operator can act on them: being this process's own
 * checkout is unfixable without restarting Gateship elsewhere, while an active
 * run is finished, cancelled or abandoned first. Both leave the registry
 * exactly as it was.
 */
export function unregisterProject(
	projectId: string,
	registry: ProjectRegistry,
	currentRoot: string,
	activeRun: ActiveRunReader = readProjectActiveRun,
): RegisteredProject {
	const project = registry.get(projectId, currentRoot);
	if (project === null) {
		throw new ProjectUnregistrationError('project-not-found', 'Project not found.', 404);
	}
	if (project.current) {
		throw new ProjectUnregistrationError(
			'project-is-current',
			'This checkout is the one this Gateship process serves, and startup would register it again. Run Gateship from another checkout to remove this one.',
			409,
		);
	}
	const active = activeRun(project);
	if (active !== null) {
		throw new ProjectUnregistrationError(
			'project-has-active-run',
			`Run ${active.id} is still ${active.state}. Finish, cancel or abandon it before removing this project.`,
			409,
		);
	}
	registry.unregister(project.id);
	return project;
}
