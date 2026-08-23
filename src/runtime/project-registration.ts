// src/runtime/project-registration.ts
//
// The first multi-project onboarding seam: one deterministic operation that
// admits a checkout the operator already has on disk. It reads local Git
// metadata only -- no fetch, clone, `gh` call, repository creation, file move
// or Git mutation belongs here -- so registering a project can never change
// the project being registered.

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
	inspectProject,
	readLocalGitMetadata,
	type ProjectCommandRunner,
	type ProjectStatus,
} from './project-readiness.ts';
import type { ProjectRegistry, RegisteredProject } from './project-registry.ts';

/** Project-owned mutable state lives beside the checkout, never in the global home. */
export const PROJECT_STATE_DIRECTORY = '.gship';

export type ProjectRegistrationErrorCode =
	/** Missing, blank, or non-absolute `root`. */
	| 'invalid-request'
	/** The path is not visible to the Gateship process at all. */
	| 'root-not-found'
	| 'root-not-directory'
	/** Not a repository, or a repository without a GitHub origin and origin/main. */
	| 'project-not-ready';

export class ProjectRegistrationError extends Error {
	constructor(
		readonly code: ProjectRegistrationErrorCode,
		message: string,
		readonly status: number,
		/** The existing readiness detail, so a refusal says which condition failed. */
		readonly readiness?: ProjectStatus,
	) {
		super(message);
		this.name = 'ProjectRegistrationError';
	}
}

function requestedRoot(body: unknown): string {
	const value = body !== null && typeof body === 'object' && !Array.isArray(body)
		? (body as { root?: unknown }).root
		: undefined;
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ProjectRegistrationError('invalid-request', 'A JSON root is required.', 400);
	}
	const root = value.trim();
	if (!isAbsolute(root)) {
		throw new ProjectRegistrationError(
			'invalid-request',
			'The project root must be an absolute path.',
			400,
		);
	}
	return root;
}

/**
 * Resolve the path the Gateship process itself can see, symlinks included. In
 * a container that is the mounted path, not the operator's host path, so an
 * unmounted checkout is refused here instead of being registered as a
 * location nothing can later read.
 */
function visibleDirectory(root: string): string {
	let resolved: string;
	try {
		resolved = realpathSync(root);
	} catch {
		throw new ProjectRegistrationError(
			'root-not-found',
			'That path does not exist for the Gateship process. In Docker it must be mounted into the container.',
			404,
		);
	}
	if (!statSync(resolved).isDirectory()) {
		throw new ProjectRegistrationError('root-not-directory', 'That path is not a directory.', 400);
	}
	return resolved;
}

/** `null` when the path is not inside a repository at all; readiness names why. */
function repositoryTopLevel(root: string, run: ProjectCommandRunner): string | null {
	const result = run(root, ['rev-parse', '--show-toplevel']);
	if (result.exitCode !== 0 || result.stdout === '') return null;
	return realpathSync(result.stdout);
}

/**
 * Register an existing checkout, by absolute path, into the global registry.
 * Any subdirectory or symlink of a repository resolves to its one real
 * top-level, so the same checkout named three ways stays one registration
 * with one identity.
 */
export function registerExistingCheckout(
	body: unknown,
	registry: ProjectRegistry,
	currentRoot: string,
	run: ProjectCommandRunner = readLocalGitMetadata,
): RegisteredProject {
	const visible = visibleDirectory(requestedRoot(body));
	const root = repositoryTopLevel(visible, run) ?? visible;
	const readiness = inspectProject(root, run);
	if (readiness.state !== 'ready') {
		throw new ProjectRegistrationError('project-not-ready', readiness.detail, 409, readiness);
	}
	const registered = registry.reconcile({
		root,
		stateDir: join(root, PROJECT_STATE_DIRECTORY),
		readiness,
	});
	// `reconcile` reports the row it just wrote as the current one. The honest
	// answer for a newly registered checkout is whether it is the root this
	// process itself serves, which is what the list and sidebar already mean.
	return registry.get(registered.id, currentRoot) ?? registered;
}
