// webui/src/screens/overview-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { ProjectOperationalOverviewView, ProjectOverviewView, RegisteredProjectView } from '../client.ts';
import { Badge } from '../components/ui/badge.tsx';
import type { BadgeVariant } from '../components/ui/badge.tsx';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '../components/ui/card.tsx';
import { CardGrid } from '../components/ui/card-layout.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Stat } from '../components/ui/stat.tsx';
import { cn } from '../lib/cn.ts';
import { LOCALE_CATALOG } from '../locale.ts';
import type { Locale, OverviewCatalog, ProjectsCatalog } from '../locale.ts';
import { toneOf } from '../run-view.ts';
import type { RunState } from '../run-view.ts';
import { SurfaceColumn } from './surface-column.tsx';
import type { OverviewCardEntry } from './projects.tsx';
import { TEXT_LINK_CLASS, TITLE_LINK_CLASS } from './operator-links.ts';
import { formatCostUsd, formatRunTimestamp } from './runs.tsx';
import { MODEL_PROVIDER_LABELS } from './settings.tsx';

export function OverviewFact({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-right">{children}</dd>
		</div>
	);
}

export const READINESS_TONE: Readonly<Record<RegisteredProjectView['readiness'], BadgeVariant>> = {
	ready: 'success',
	empty: 'secondary',
	'needs-attention': 'warning',
};

export const OUTCOME_TONE: Readonly<Record<string, BadgeVariant>> = {
	shipped: 'success',
	failed: 'error',
	cancelled: 'secondary',
	incomplete: 'warning',
};

export function OverviewOperationalFacts({ entry, catalog, locale }: { entry: ProjectOverviewView; catalog: OverviewCatalog; locale: Locale }): React.ReactElement {
	if (entry.database.state !== 'available') return <p className="text-muted-foreground">{catalog.databaseUnavailable}</p>;
	const provider = entry.activeRun === null ? null : MODEL_PROVIDER_LABELS[entry.activeRun.providerId];
	return <>
		{provider === null ? null : <OverviewFact label={catalog.provider}>{provider}</OverviewFact>}
		<OverviewFact label={catalog.activeRun}>
			{entry.activeRun === null
				? <span className="text-muted-foreground">{catalog.noRun}</span>
				: <a className={cn(TEXT_LINK_CLASS, 'break-all font-mono text-xs')} href={`/projects/${encodeURIComponent(entry.project.id)}/runs`}>{entry.activeRun.id}</a>}
		</OverviewFact>
		{entry.activeRun === null ? null : (
			<OverviewFact label={catalog.issue}>
				<span className="break-all font-mono text-xs">{entry.activeRun.issueId}</span>
			</OverviewFact>
		)}
		{entry.activeRun === null ? null : (
			<OverviewFact label={catalog.phase}>
				<Badge variant={toneOf(entry.activeRun.state as RunState)}>
					{LOCALE_CATALOG[locale].runInspector.stateLabels[entry.activeRun.state as RunState]}
				</Badge>
			</OverviewFact>
		)}
		{entry.latestRun === null ? null : (
			<OverviewFact label={catalog.updated}>
				<time className="font-mono text-muted-foreground text-xs">
					{formatRunTimestamp(entry.latestRun.updatedAt, locale)}
				</time>
			</OverviewFact>
		)}
	</>;
}

export function OverviewProjectDetails({ entry, catalog, projectCatalog, locale }: { entry: OverviewCardEntry; catalog: OverviewCatalog; projectCatalog: ProjectsCatalog; locale: Locale }): React.ReactElement {
	const readiness = (
		<OverviewFact label={projectCatalog.readinessLabel}>
			<Badge variant={READINESS_TONE[entry.project.readiness]}>
				{projectCatalog.readiness[entry.project.readiness]}
			</Badge>
		</OverviewFact>
	);
	if (!entry.snapshot) return readiness;
	return <>
		{readiness}
		<OverviewOperationalFacts entry={entry} catalog={catalog} locale={locale} />
		<OverviewFact label={catalog.backlogLabel}>
			<span className="font-mono text-xs tabular-nums">
				{entry.backlog.state === 'available' ? entry.backlog.counts.planned : catalog.partial}
			</span>
		</OverviewFact>
		<OverviewFact label={catalog.lastOutcome}>
			{entry.overview.overview === null
				? <span className="text-muted-foreground">{catalog.historyUnavailable}</span>
				: entry.latestRunOutcome === null
					? <span className="text-muted-foreground">{catalog.noOutcome}</span>
					: <Badge variant={OUTCOME_TONE[entry.latestRunOutcome] ?? 'secondary'}>{catalog.outcomes[entry.latestRunOutcome]}</Badge>}
		</OverviewFact>
	</>;
}

export function OverviewProjectCard({ entry, catalog, projectCatalog, locale }: { entry: OverviewCardEntry; catalog: OverviewCatalog; projectCatalog: ProjectsCatalog; locale: Locale }): React.ReactElement {
	const project = entry.project;
	return <li className="min-w-0"><Card className="h-full"><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle><a className={TITLE_LINK_CLASS} href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</a></CardTitle>{project.current ? <Badge variant="info">{projectCatalog.currentBadge}</Badge> : null}</div><CardDescription className="break-all font-mono text-xs">{project.repository ?? projectCatalog.repositoryUnknown}</CardDescription></CardHeader><CardPanel><dl className="flex flex-col gap-1.5 text-sm"><OverviewProjectDetails entry={entry} catalog={catalog} projectCatalog={projectCatalog} locale={locale} /></dl></CardPanel></Card></li>;
}

export function OverviewProjectCards({ props, overview, catalog, projectCatalog }: { props: AppProps; overview: ProjectOperationalOverviewView | null; catalog: OverviewCatalog; projectCatalog: ProjectsCatalog }): React.ReactElement | null {
	if (overview === null && props.overviewLoading) return null;
	const entries: OverviewCardEntry[] = overview === null ? props.projects.map((project) => ({ project, snapshot: false })) : overview.projects.map((entry) => ({ ...entry, snapshot: true }));
	return <CardGrid as="ul" className="lg:grid-cols-2 2xl:grid-cols-3" equalHeight>{entries.map((entry) => <OverviewProjectCard key={entry.project.id} entry={entry} catalog={catalog} projectCatalog={projectCatalog} locale={props.locale} />)}</CardGrid>;
}

export function OverviewData({ props, overview, catalog, attention, activeProjects }: { props: AppProps; overview: ProjectOperationalOverviewView; catalog: OverviewCatalog; attention: number; activeProjects: number }): React.ReactElement {
	const historical = overview.overview;
	const completed = historical.totalRuns - historical.activeRuns;
	return <>
		{/*
		 * The bento's hero answers "what needs me?" first. It is the one tile
		 * allowed to go acid, and only while something actually waits; a zero
		 * stays as quiet as every other number.
		 */}
		<CardGrid className="sm:grid-cols-2 xl:grid-cols-3" compact equalHeight>
			<Stat
				className={cn(
					attention > 0
						&& 'border-attention-ui bg-attention-surface shadow-[0_6px_28px_rgba(200,255,0,0.09)]',
				)}
				label={catalog.metrics.attention}
				value={attention}
			/>
			<Stat label={catalog.metrics.activeProjects} value={activeProjects} />
			<Stat label={catalog.metrics.backlog} value={overview.summary.backlog.planned} />
			<Stat label={catalog.metrics.completed} value={completed} />
			<Stat label={catalog.activity} value={historical.totalRuns} />
			<Stat
				hint={catalog.costCoverage(historical.runsWithKnownCost, historical.totalRuns)}
				label={catalog.metrics.cost}
				value={historical.knownCostUsd === null
					? catalog.noCost
					: formatCostUsd(historical.knownCostUsd, props.locale, 2)}
			/>
		</CardGrid>
		{historical.daily.length === 0 ? null : (
			<ul aria-label={catalog.trend} className="sr-only">
				{historical.daily.map((day) => (
					<li key={day.date}>
						{day.date}: {catalog.activity} {day.totalRuns}; {catalog.outcomes.shipped} {day.runsByOutcome.shipped}; {catalog.outcomes.failed} {day.runsByOutcome.failed}; {catalog.outcomes.cancelled} {day.runsByOutcome.cancelled}; {catalog.outcomes.incomplete} {day.runsByOutcome.incomplete}
					</li>
				))}
			</ul>
		)}
		{props.overviewLoading ? <p className="text-muted-foreground text-xs" role="status">{catalog.loading}</p> : null}
		{attention > 0 ? <p className="text-warning-foreground text-sm" role="status">{catalog.partial}</p> : null}
	</>;
}

export function OverviewSurface(props: AppProps): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].overview;
	const projectCatalog = LOCALE_CATALOG[props.locale].projects;
	const overview = props.overview ?? null;
	const activeProjects = overview?.projects.filter((project) => project.activeRun !== null).length ?? 0;
	const attention = overview?.projects.filter((project) => project.overview.overview === null
		|| project.root.state !== 'available'
		|| project.backlog.state !== 'available' || project.database.state !== 'available'
		|| project.activeRun?.state === 'waiting-user' || project.activeRun?.state === 'interrupted').length ?? 0;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			{props.overviewLoading && overview === null ? <p role="status">{catalog.loading}</p> : null}
			{overview === null && props.overviewError !== null && props.overviewError !== undefined ? <Card><CardPanel><p role="alert">{catalog.error}</p><p className="text-muted-foreground text-xs">{props.overviewError}</p></CardPanel></Card> : null}
			{(overview === null || overview.projects.length === 0) && !props.overviewLoading && !props.overviewError && props.projects.length === 0 ? <Card><CardPanel><EmptyState>{catalog.empty}</EmptyState></CardPanel></Card> : null}
			{props.overviewError ? <p className="text-warning-foreground text-sm" role="alert">{catalog.error}: {props.overviewError}</p> : null}
			{overview === null || overview.projects.length === 0 ? null : <OverviewData props={props} overview={overview} catalog={catalog} attention={attention} activeProjects={activeProjects} />}
			<OverviewProjectCards props={props} overview={overview} catalog={catalog} projectCatalog={projectCatalog} />
		</SurfaceColumn>
	);
}
