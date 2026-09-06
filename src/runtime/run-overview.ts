import { join } from 'node:path';

import type { RegisteredProject } from './project-registry.ts';
import { type PullRequestDelivery, selectPullRequestDelivery } from './pull-request-delivery.ts';
import { isRunState, type RunState } from './run-state.ts';
import {
	type PersistedRunHistory,
	readPersistedRunHistory,
} from './run-store.ts';

export const RUN_OVERVIEW_DEFAULT_LIMIT = 20;
export const RUN_OVERVIEW_MAX_LIMIT = 100;
export const RUN_OVERVIEW_MAX_OFFSET = 10_000;

export interface RunOverviewFilters {
	limit?: number;
	offset?: number;
	projectId?: string;
	state?: RunState;
	providerId?: 'claude' | 'codex';
}

export interface RunOverviewRow {
	projectId: string;
	projectName: string;
	repository?: string;
	runId: string;
	issueId: string;
	state: RunState;
	createdAt: string;
	updatedAt: string;
	providerId: 'claude' | 'codex';
	evaluation: PersistedRunHistory['evaluation'];
	cost: PersistedRunHistory['cost'];
	roles: PersistedRunHistory['evaluation']['roles'];
	coverage: {
		verified: boolean;
		reviewed: boolean;
		fullVerification: boolean;
	};
	pullRequest: PullRequestDelivery | null;
	ci: { status: NonNullable<RunOverviewRow['pullRequest']>['ciStatus'] } | null;
	merge: { status: 'merged' } | null;
}

export interface RunOverviewError {
	projectId: string;
	projectName: string;
	code: 'project-unavailable';
	message: 'Project runs are unavailable.';
}

export interface RunOverviewPage {
	runs: RunOverviewRow[];
	page: { limit: number; offset: number; returned: number; total: number };
	errors: RunOverviewError[];
}

export interface RunOverviewReadOptions {
	readHistory?: typeof readPersistedRunHistory;
}

function boundedPage(filters: RunOverviewFilters): { limit: number; offset: number } {
	const limit = Number.isSafeInteger(filters.limit) && (filters.limit ?? 0) > 0
		? Math.min(filters.limit!, RUN_OVERVIEW_MAX_LIMIT) : RUN_OVERVIEW_DEFAULT_LIMIT;
	const offset = Number.isSafeInteger(filters.offset) && (filters.offset ?? 0) >= 0
		? Math.min(filters.offset!, RUN_OVERVIEW_MAX_OFFSET) : 0;
	return { limit, offset };
}

function coverageOf(item: PersistedRunHistory): RunOverviewRow['coverage'] {
	const kinds = new Set(item.events.map((event) => event.kind));
	return {
		verified: kinds.has('run.verified'),
		reviewed: kinds.has('run.review-clean'),
		fullVerification: kinds.has('run.full-verify-clean'),
	};
}

function projectRun(project: RegisteredProject, item: PersistedRunHistory): RunOverviewRow {
	const delivery = selectPullRequestDelivery(item.events);
	return {
		projectId: project.id,
		projectName: project.name,
		...(project.repository === undefined ? {} : { repository: project.repository }),
		runId: item.run.id,
		issueId: item.run.issueId,
		state: item.run.state,
		createdAt: item.run.createdAt,
		updatedAt: item.run.updatedAt,
		providerId: item.run.providerId,
		evaluation: item.evaluation,
		cost: item.cost,
		roles: item.evaluation.roles,
		coverage: coverageOf(item),
		pullRequest: delivery,
		ci: delivery === null ? null : { status: delivery.ciStatus },
		merge: delivery !== null && item.evaluation.outcome === 'shipped' ? { status: 'merged' } : null,
	};
}

function matches(row: RunOverviewRow, filters: RunOverviewFilters): boolean {
	return (filters.projectId === undefined || row.projectId === filters.projectId)
		&& (filters.state === undefined || row.state === filters.state)
		&& (filters.providerId === undefined || row.providerId === filters.providerId);
}

export function readRunOverview(
	projects: readonly RegisteredProject[],
	filters: RunOverviewFilters = {},
	options: RunOverviewReadOptions = {},
): RunOverviewPage {
	const readHistory = options.readHistory ?? readPersistedRunHistory;
	const errors: RunOverviewError[] = [];
	const rows: RunOverviewRow[] = [];
	for (const project of projects) {
		if (filters.projectId !== undefined && project.id !== filters.projectId) continue;
		try {
			for (const item of readHistory(join(project.stateDir, 'runtime.sqlite'))) {
				const row = projectRun(project, item);
				if (matches(row, filters)) rows.push(row);
			}
		} catch {
			errors.push({
				projectId: project.id,
				projectName: project.name,
				code: 'project-unavailable',
				message: 'Project runs are unavailable.',
			});
		}
	}
	rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
		|| left.projectId.localeCompare(right.projectId)
		|| left.runId.localeCompare(right.runId));
	const { limit, offset } = boundedPage(filters);
	return {
		runs: rows.slice(offset, offset + limit),
		page: { limit, offset, returned: Math.min(limit, Math.max(0, rows.length - offset)), total: rows.length },
		errors,
	};
}

export function parseRunOverviewFilters(params: URLSearchParams): RunOverviewFilters {
	const state = params.get('state');
	const providerId = params.get('providerId');
	if (state !== null && !isRunState(state)) throw new Error('state must be a valid run state.');
	if (providerId !== null && providerId !== 'claude' && providerId !== 'codex') {
		throw new Error('providerId must be claude or codex.');
	}
	const number = (name: string): number | undefined => {
		const value = params.get(name);
		if (value === null) return undefined;
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer.`);
		return parsed;
	};
	return {
		limit: number('limit'), offset: number('offset'),
		...(params.get('projectId') === null ? {} : { projectId: params.get('projectId')! }),
		...(state === null ? {} : { state }),
		...(providerId === null ? {} : { providerId }),
	};
}
