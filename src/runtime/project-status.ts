import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

import { readBacklogFromMain } from '../issues/backlog.ts';
import { type BacklogJsonView, deriveBacklogJson } from '../issues/list.ts';
import type { RegisteredProject } from './project-registry.ts';
import {
	type PersistedRunHistory,
	type PersistedRunStatus,
	readPersistedRunHistory,
	readPersistedRunOverview,
	readPersistedRunStatuses,
} from './run-store.ts';
import { RUNTIME_SOURCE_REF } from './source-ref.ts';

export const PROJECT_STATUS_RUN_LIMIT = 20;

export type OverviewWindow = '7d' | '30d' | 'all';

export interface HistoricalOverview {
	window: OverviewWindow;
	totalRuns: number;
	runsWithKnownCost: number;
	knownCostUsd: number | null;
	runsByOutcome: Record<'shipped' | 'failed' | 'cancelled' | 'incomplete', number>;
	activeRuns: number;
	terminalWallTimeMs: number;
	fixRounds: number;
	attentionRequests: number;
	operatorInterventions: number;
	providerHolds: number;
	resolvedCycleQuestions: number;
	reportedTokens: {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheCreationInputTokens: number | null;
	cacheReadInputTokens: number | null;
	thinkingTokens: number | null;
	};
	configurations: Array<{ provider: string; role: string; model?: string; effort?: string }>;
	daily: Array<{
		date: string;
		totalRuns: number;
		runsByOutcome: HistoricalOverview['runsByOutcome'];
		runsWithKnownCost: number;
		knownCostUsd: number | null;
		inputTokens: number | null;
		outputTokens: number | null;
	}>;
}

export interface HistoricalOverviewRead {
	overview: HistoricalOverview | null;
	reason?: string;
}

const OVERVIEW_WINDOWS: Readonly<Record<OverviewWindow, number | null>> = { '7d': 7, '30d': 30, all: null };

function addNullable(total: number | null, value: number | undefined): number | null {
	return value === undefined ? total : (total ?? 0) + value;
}

function emptyOutcomes(): HistoricalOverview['runsByOutcome'] {
	return { shipped: 0, failed: 0, cancelled: 0, incomplete: 0 };
}

function emptyHistoricalOverview(window: OverviewWindow): HistoricalOverview {
	return {
		window, totalRuns: 0, runsWithKnownCost: 0, knownCostUsd: null,
		runsByOutcome: emptyOutcomes(), activeRuns: 0, terminalWallTimeMs: 0,
		fixRounds: 0, attentionRequests: 0, operatorInterventions: 0, providerHolds: 0,
		resolvedCycleQuestions: 0,
		reportedTokens: { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null,
			cacheReadInputTokens: null, thinkingTokens: null },
		configurations: [], daily: [],
	};
}

function addRunMetrics(result: HistoricalOverview, item: PersistedRunHistory): void {
	const evaluation = item.evaluation;
	result.totalRuns += 1;
	result.runsByOutcome[evaluation.outcome] += 1;
	result.activeRuns += evaluation.outcome === 'incomplete' ? 1 : 0;
	result.terminalWallTimeMs += evaluation.wallTimeMs ?? 0;
	result.fixRounds += item.run.fixRounds;
	result.attentionRequests += evaluation.attentionRequests;
	result.operatorInterventions += evaluation.operatorInterventions;
	result.providerHolds += evaluation.providerHolds;
	result.resolvedCycleQuestions += evaluation.resolvedCycleQuestions ?? 0;
	if (item.cost.totalCostUsd !== null) {
		result.runsWithKnownCost += 1;
		result.knownCostUsd = (result.knownCostUsd ?? 0) + item.cost.totalCostUsd;
	}
}

function modelProviderMap(item: PersistedRunHistory): Map<number, string> {
	const modelProviders = new Map<number, string>();
	for (const event of item.events) {
		if (event.kind === 'provider.model' || event.kind === 'review.model') {
			modelProviders.set(event.seq, item.run.providerId);
		}
	}
	return modelProviders;
}

function remapModelProvider(
	providers: Map<number, string>,
	item: PersistedRunHistory,
	transition: PersistedRunHistory['events'][number],
): void {
	const role = transition.kind === 'run.executor-handoff' ? 'executor'
		: transition.kind === 'run.review-fallback' ? 'reviewer' : null;
	if (role === null) return;
	const modelKind = role === 'executor' ? 'provider.model' : 'review.model';
	const candidates = item.events.filter((event) => event.seq < transition.seq
		&& event.kind === modelKind && providers.get(event.seq) === item.run.providerId);
	const targetModel = transition.payload['model'];
	const targetEffort = transition.payload['effort'];
	const candidate = typeof targetModel === 'string'
		? candidates.findLast((event) => event.payload['model'] === targetModel
			&& (typeof targetEffort !== 'string' || event.payload['effort'] === targetEffort))
		: candidates.at(-1);
	const targetProvider = transition.payload['to'];
	if (candidate !== undefined && (targetProvider === 'claude' || targetProvider === 'codex')) {
		providers.set(candidate.seq, targetProvider);
	}
}

function addModelConfiguration(
	configurations: Set<string>,
	providers: Map<number, string>,
	item: PersistedRunHistory,
	event: PersistedRunHistory['events'][number],
): void {
	const role = event.kind === 'provider.model' ? 'executor'
		: event.kind === 'review.model' ? 'reviewer'
			: event.kind === 'run.cycle-response' ? 'orchestrator' : null;
	if (role === null) return;
	configurations.add(JSON.stringify({
		provider: providers.get(event.seq) ?? item.run.providerId, role,
		...(typeof event.payload['model'] === 'string' ? { model: event.payload['model'] } : {}),
		...(typeof event.payload['effort'] === 'string' ? { effort: event.payload['effort'] } : {}),
	}));
}

function addRunConfigurations(configurations: Set<string>, item: PersistedRunHistory): void {
	const providers = modelProviderMap(item);
	for (const event of item.events) remapModelProvider(providers, item, event);
	for (const event of item.events) {
		addModelConfiguration(configurations, providers, item, event);
	}
}

function addReportedTokens(result: HistoricalOverview, item: PersistedRunHistory): void {
	const fields = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens'] as const;
	for (const field of fields) {
		const entries = item.cost.breakdown.filter((entry) => entry[field] !== undefined);
		if (entries.length > 0) result.reportedTokens[field] = addNullable(
			result.reportedTokens[field], entries.reduce((sum, entry) => sum + (entry[field] ?? 0), 0),
		);
	}
	const thinkingEntries = item.cost.roles.filter((entry) => entry.thinkingTokens !== undefined);
	if (thinkingEntries.length > 0) result.reportedTokens.thinkingTokens = addNullable(
		result.reportedTokens.thinkingTokens,
		thinkingEntries.reduce((sum, entry) => sum + (entry.thinkingTokens ?? 0), 0),
	);
}

function addDailyRun(daily: Map<string, HistoricalOverview['daily'][number]>, item: PersistedRunHistory): void {
	const date = runDate(item.run.createdAt);
	if (date === null) return;
	const day = daily.get(date) ?? { date, totalRuns: 0, runsByOutcome: emptyOutcomes(), runsWithKnownCost: 0, knownCostUsd: null, inputTokens: null, outputTokens: null };
	day.totalRuns += 1;
	day.runsByOutcome[evaluationOutcome(item)] += 1;
	if (item.cost.totalCostUsd !== null) {
		day.runsWithKnownCost += 1;
		day.knownCostUsd = (day.knownCostUsd ?? 0) + item.cost.totalCostUsd;
	}
	for (const field of ['inputTokens', 'outputTokens'] as const) {
		const entries = item.cost.breakdown.filter((entry) => entry[field] !== undefined);
		if (entries.length > 0) day[field] = addNullable(day[field], entries.reduce((sum, entry) => sum + (entry[field] ?? 0), 0));
	}
	daily.set(date, day);
}

function evaluationOutcome(item: PersistedRunHistory): keyof HistoricalOverview['runsByOutcome'] {
	return item.evaluation.outcome;
}

function historicalOverview(
	history: readonly PersistedRunHistory[],
	window: OverviewWindow,
	now: Date,
): HistoricalOverview {
	const days = OVERVIEW_WINDOWS[window];
	const cutoff = days === null ? -Infinity : now.getTime() - days * 24 * 60 * 60 * 1000;
	const selected = history.filter(({ run }) => {
		const timestamp = Date.parse(run.createdAt);
		return Number.isFinite(timestamp) && timestamp >= cutoff;
	});
	const result = emptyHistoricalOverview(window);
	const configurations = new Set<string>();
	const daily = new Map<string, HistoricalOverview['daily'][number]>();
	for (const item of selected) {
		addRunMetrics(result, item);
		addRunConfigurations(configurations, item);
		addReportedTokens(result, item);
		addDailyRun(daily, item);
	}
	result.configurations = [...configurations].map((value) => JSON.parse(value) as HistoricalOverview['configurations'][number]);
	result.configurations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	result.daily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
	return result;
}

function runDate(value: string): string | null {
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

export function readProjectHistoricalOverview(
	project: RegisteredProject,
	window: OverviewWindow = '7d',
	now = new Date(),
	readHistory: typeof readPersistedRunHistory = readPersistedRunHistory,
): HistoricalOverviewRead {
	try {
		return { overview: historicalOverview(readHistory(join(project.stateDir, 'runtime.sqlite')), window, now) };
	} catch (error) {
		return { overview: null, reason: error instanceof Error ? error.message : String(error) };
	}
}

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
	window: OverviewWindow;
	overview: HistoricalOverview;
	summary: {
		totalProjects: number;
		readyProjects: number;
		unavailableProjects: number;
		nonTerminalRuns: number;
		backlog: BacklogJsonView['counts'];
	};
	projects: Array<ProjectOperationalStatus & {
		overview: HistoricalOverviewRead;
		activeRun: PersistedRunStatus | null;
		latestRun: PersistedRunStatus | null;
			latestRunOutcome: 'shipped' | 'failed' | 'cancelled' | 'incomplete' | null;
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
	window: OverviewWindow = '7d',
	now = new Date(),
): ProjectOperationalOverview {
	const statuses = projects.map(readStatus);
	const overviewProjects: Array<ProjectOperationalStatus & {
		overview: HistoricalOverviewRead;
		activeRun: PersistedRunStatus | null;
		latestRun: PersistedRunStatus | null;
		latestRunOutcome: 'shipped' | 'failed' | 'cancelled' | 'incomplete' | null;
		recentRuns: PersistedRunStatus[];
		nonTerminalRuns: number;
	}> = statuses.map((status) => {
		if (status.database.state !== 'available') {
			return {
				...status,
				overview: { overview: null, reason: status.database.reason },
				activeRun: null,
				latestRun: null,
				latestRunOutcome: null,
				recentRuns: [],
				nonTerminalRuns: 0,
			};
		}
		let runOverview: ReturnType<typeof readPersistedRunOverview>;
		try {
			runOverview = readRunOverview(status.database.path);
		} catch (error) {
			return {
				...status,
				database: {
					state: 'unavailable' as const,
					path: status.database.path,
					reason: unavailableReason(error),
				},
				overview: { overview: null, reason: unavailableReason(error) },
				activeRun: null,
				latestRun: status.database.runs[0] ?? null,
				latestRunOutcome: null,
				recentRuns: status.database.runs,
				nonTerminalRuns: 0,
			};
		}
		try {
			const latestHistory = readPersistedRunHistory(status.database.path).at(-1);
			return {
				...status,
				overview: readProjectHistoricalOverview(status.project, window, now),
				activeRun: runOverview.activeRun,
				latestRun: status.database.runs[0] ?? null,
				latestRunOutcome: latestHistory?.evaluation.outcome ?? null,
				recentRuns: status.database.runs,
				nonTerminalRuns: runOverview.nonTerminalRuns,
			};
		} catch (error) {
			return {
				...status,
				overview: { overview: null, reason: unavailableReason(error) },
				activeRun: runOverview.activeRun,
				latestRun: status.database.runs[0] ?? null,
				latestRunOutcome: null,
				recentRuns: status.database.runs,
				nonTerminalRuns: runOverview.nonTerminalRuns,
			};
		}
	});
	const availableHistory = overviewProjects
		.map((project) => project.overview.overview)
		.filter((overview): overview is HistoricalOverview => overview !== null);
	// Re-aggregate from the same read-only histories to preserve project-level
	// coverage while keeping the product view free of unavailable databases.
	const productOverview = combineHistoricalOverviews(availableHistory, window);
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
		window,
		overview: productOverview,
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

function mergeHistoricalTotals(combined: HistoricalOverview, item: HistoricalOverview): void {
	combined.totalRuns += item.totalRuns;
	combined.runsWithKnownCost += item.runsWithKnownCost;
	if (item.knownCostUsd !== null) combined.knownCostUsd = (combined.knownCostUsd ?? 0) + item.knownCostUsd;
	for (const outcome of Object.keys(combined.runsByOutcome) as Array<keyof HistoricalOverview['runsByOutcome']>) {
		combined.runsByOutcome[outcome] += item.runsByOutcome[outcome];
	}
	for (const field of ['activeRuns', 'terminalWallTimeMs', 'fixRounds', 'attentionRequests',
		'operatorInterventions', 'providerHolds', 'resolvedCycleQuestions'] as const) {
		combined[field] += item[field];
	}
	for (const key of Object.keys(combined.reportedTokens) as Array<keyof HistoricalOverview['reportedTokens']>) {
		combined.reportedTokens[key] = addNullable(combined.reportedTokens[key], item.reportedTokens[key] ?? undefined);
	}
}

function mergeHistoricalDay(
	daily: Map<string, HistoricalOverview['daily'][number]>,
	itemDay: HistoricalOverview['daily'][number],
): void {
	const day = daily.get(itemDay.date) ?? { ...itemDay, totalRuns: 0, runsByOutcome: emptyOutcomes(), runsWithKnownCost: 0, knownCostUsd: null, inputTokens: null, outputTokens: null };
	day.totalRuns += itemDay.totalRuns;
	for (const outcome of Object.keys(day.runsByOutcome) as Array<keyof HistoricalOverview['runsByOutcome']>) day.runsByOutcome[outcome] += itemDay.runsByOutcome[outcome];
	day.runsWithKnownCost += itemDay.runsWithKnownCost;
	if (itemDay.knownCostUsd !== null) day.knownCostUsd = (day.knownCostUsd ?? 0) + itemDay.knownCostUsd;
	day.inputTokens = addNullable(day.inputTokens, itemDay.inputTokens ?? undefined);
	day.outputTokens = addNullable(day.outputTokens, itemDay.outputTokens ?? undefined);
	daily.set(day.date, day);
}

function addHistoricalOverview(
	combined: HistoricalOverview,
	item: HistoricalOverview,
	configurations: Set<string>,
	daily: Map<string, HistoricalOverview['daily'][number]>,
): void {
	mergeHistoricalTotals(combined, item);
	for (const entry of item.configurations) configurations.add(JSON.stringify(entry));
	for (const itemDay of item.daily) mergeHistoricalDay(daily, itemDay);
}

function combineHistoricalOverviews(overviews: readonly HistoricalOverview[], window: OverviewWindow): HistoricalOverview {
	const combined = emptyHistoricalOverview(window);
	const configurations = new Set<string>();
	const daily = new Map<string, HistoricalOverview['daily'][number]>();
	for (const item of overviews) addHistoricalOverview(combined, item, configurations, daily);
	combined.configurations = [...configurations].map((value) => JSON.parse(value) as HistoricalOverview['configurations'][number]);
	combined.daily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
	return combined;
}
