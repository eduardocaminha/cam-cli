// webui/src/screens/runs-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { IssueReviewDraft } from '../client.ts';
import { Stat } from '../components/ui/stat.tsx';
import { LOCALE_CATALOG } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { PreviousRunsPanel, RunActivity, RunCard, RunCostPanel, RunReport, WorkflowBenchmarkPanel, WorkflowInsightsPanel, WorkspaceNoticesPanel, formatCostUsd } from './runs.tsx';

export function RunsSurface(props: AppProps): React.ReactElement {
	const run = props.runs[0] ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const catalog = localeCatalog.runInspector;
	return (
		<SurfaceColumn label={localeCatalog.shell.routeLabels.runs} status={props.status}>
			<RunCard
				catalog={catalog}
				locale={props.locale}
				onAbandon={props.onAbandon}
				onCancel={props.onCancel}
				onResume={props.onResume}
				onShip={props.onShip}
				pending={props.pending}
				run={run}
				showCost={false}
				title={catalog.latestRunTitle}
			/>
			{/*
			 * The run's numbers as a stat row (dashboard-01 composition), then
			 * two columns: what happened on the left (activity, report), what it
			 * measured on the right (cost, insights, benchmarks, leftovers).
			 * History closes the page full-width.
			 */}
			{run === null ? null : (
				<div className="card-ring-group grid gap-4 sm:grid-cols-2">
					{run.cost.totalCostUsd === null ? null : (
						<Stat
							label={catalog.stats.expectedCost}
							value={formatCostUsd(run.cost.totalCostUsd, props.locale)}
						/>
					)}
					<Stat
						label={catalog.stats.events}
						value={props.events.filter((event) => event.runId === run.id).length}
					/>
				</div>
			)}
			<div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-6">
					<RunActivity
						catalog={localeCatalog.runsOperational}
						events={props.events}
						locale={props.locale}
						run={run}
					/>
					{run === null ? null : <RunReport catalog={catalog} run={run} />}
				</div>
				<div className="flex min-w-0 flex-col gap-6">
					{run === null ? null : (
						<RunCostPanel catalog={localeCatalog.runsOperational} locale={props.locale} run={run} />
					)}
					<WorkflowInsightsPanel
						catalog={localeCatalog.runsWorkflow}
						locale={props.locale}
						runs={props.runs}
					/>
					<WorkflowBenchmarkPanel
						catalog={localeCatalog.runsWorkflow}
						locale={props.locale}
						runs={props.runs}
					/>
					<WorkspaceNoticesPanel
						catalog={localeCatalog.runsOperational}
						workspaceNotices={props.workspaceNotices}
					/>
				</div>
			</div>
			<PreviousRunsPanel
				catalog={localeCatalog.runsOperational}
				locale={props.locale}
				runs={props.runs}
			/>
		</SurfaceColumn>
	);
}

export function draftChanged(draft: IssueReviewDraft, scope: string, command: string): boolean {
	return scope !== draft.scope || command !== draft.verificationCommand;
}

/** The editable contract of one draft: its revision, its approval, and its abandonment. */
