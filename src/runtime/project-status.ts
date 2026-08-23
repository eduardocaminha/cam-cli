import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

import { readBacklogFromMain } from '../issues/backlog.ts';
import { deriveBacklogJson, type BacklogJsonView } from '../issues/list.ts';
import type { RegisteredProject } from './project-registry.ts';
import {
	readPersistedRunOverview,
	readPersistedRunStatuses,
	type PersistedRunStatus,
} from './run-store.ts';
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

export interface ProjectOperationalOverview {
	summary: {
		totalProjects: number;
		readyProjects: number;
		unavailableProjects: number;
		nonTerminalRuns: number;
		backlog: BacklogJsonView['counts'];
	};
	projects: Array<ProjectOperationalStatus & {
		activeRun: PersistedRunStatus | null;
		latestRun: PersistedRunStatus | null;
		recentRuns: PersistedRunStatus[];
	}>;
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

export function readProjectOperationalOverview(
	projects: readonly RegisteredProject[],
	readStatus: (project: RegisteredProject) => ProjectOperationalStatus = readProjectOperationalStatus,
	readRunOverview: typeof readPersistedRunOverview = readPersistedRunOverview,
): ProjectOperationalOverview {
	const statuses = projects.map(readStatus);
	const overviewProjects: Array<ProjectOperationalStatus & {
		activeRun: PersistedRunStatus | null;
		latestRun: PersistedRunStatus | null;
		recentRuns: PersistedRunStatus[];
		nonTerminalRuns: number;
	}> = statuses.map((status) => {
		if (status.database.state !== 'available') {
			return {
				...status,
				activeRun: null,
				latestRun: null,
				recentRuns: [],
				nonTerminalRuns: 0,
			};
		}
		try {
			const runOverview = readRunOverview(status.database.path);
			return {
				...status,
				activeRun: runOverview.activeRun,
				latestRun: status.database.runs[0] ?? null,
				recentRuns: status.database.runs,
				nonTerminalRuns: runOverview.nonTerminalRuns,
			};
		} catch (error) {
			return {
				...status,
				database: {
					state: 'unavailable' as const,
					path: status.database.path,
					reason: unavailableReason(error),
				},
				activeRun: null,
				latestRun: status.database.runs[0] ?? null,
				recentRuns: status.database.runs,
				nonTerminalRuns: 0,
			};
		}
	});
	const backlog = { idea: 0, specified: 0, planned: 0 };
	let readyProjects = 0;
	let nonTerminalRuns = 0;

	for (const status of overviewProjects) {
		const available = status.root.state === 'available'
			&& status.backlog.state === 'available'
			&& status.database.state === 'available';
		if (available) readyProjects += 1;
		if (status.database.state === 'available') {
			nonTerminalRuns += status.nonTerminalRuns;
		}
		if (status.backlog.state === 'available') {
			backlog.idea += status.backlog.counts.idea;
			backlog.specified += status.backlog.counts.specified;
			backlog.planned += status.backlog.counts.planned;
		}
	}

	return {
		summary: {
			totalProjects: statuses.length,
			readyProjects,
			unavailableProjects: statuses.length - readyProjects,
			nonTerminalRuns,
			backlog,
		},
		projects: overviewProjects.map(({ nonTerminalRuns: _nonTerminalRuns, ...project }) => project),
	};
}
