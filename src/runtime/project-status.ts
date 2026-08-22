import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

import { readBacklogFromMain } from '../issues/backlog.ts';
import { deriveBacklogJson, type BacklogJsonView } from '../issues/list.ts';
import type { RegisteredProject } from './project-registry.ts';
import { readPersistedRunStatuses, type PersistedRunStatus } from './run-store.ts';
import { RUNTIME_SOURCE_REF } from './source-ref.ts';

export const PROJECT_STATUS_RUN_LIMIT = 20;

type Availability = { state: 'available' } | { state: 'unavailable'; reason: string };

export interface ProjectOperationalStatus {
	project: RegisteredProject;
	root: Availability;
	backlog: ({ state: 'available' } & BacklogJsonView) | { state: 'unavailable'; reason: string };
	database:
		| { state: 'available'; path: string; runs: PersistedRunStatus[] }
		| { state: 'unavailable'; path: string; reason: string };
}

function unavailableReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rootAvailability(root: string): Availability {
	try {
		if (!statSync(root).isDirectory()) {
			return { state: 'unavailable', reason: 'Project root is not a directory.' };
		}
		accessSync(root, constants.R_OK | constants.X_OK);
		return { state: 'available' };
	} catch (error) {
		return { state: 'unavailable', reason: unavailableReason(error) };
	}
}

export function readProjectOperationalStatus(project: RegisteredProject): ProjectOperationalStatus {
	const root = rootAvailability(project.root);
	let backlog: ProjectOperationalStatus['backlog'];
	if (root.state === 'unavailable') {
		backlog = { state: 'unavailable', reason: 'Project root is unavailable.' };
	} else {
		try {
			backlog = {
				state: 'available',
				...deriveBacklogJson(readBacklogFromMain(project.root, undefined, RUNTIME_SOURCE_REF)),
			};
		} catch (error) {
			backlog = { state: 'unavailable', reason: unavailableReason(error) };
		}
	}

	const databasePath = join(project.stateDir, 'runtime.sqlite');
	let database: ProjectOperationalStatus['database'];
	try {
		const stat = statSync(databasePath);
		if (!stat.isFile()) throw new Error('Runtime database is not a file.');
		database = {
			state: 'available',
			path: databasePath,
			runs: readPersistedRunStatuses(databasePath, PROJECT_STATUS_RUN_LIMIT),
		};
	} catch (error) {
		database = { state: 'unavailable', path: databasePath, reason: unavailableReason(error) };
	}

	return { project, root, backlog, database };
}
