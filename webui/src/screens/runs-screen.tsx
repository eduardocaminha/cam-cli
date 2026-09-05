// webui/src/screens/runs-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { IssueReviewDraft } from '../client.ts';
import { Stat } from '../components/ui/stat.tsx';
import { CardGrid, CardSplit, CardStack } from '../components/ui/card-layout.tsx';
import { LOCALE_CATALOG } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { OperationalReadPanel } from '../operational-unavailable.tsx';
import { PreviousRunsPanel, RunActivity, RunCard, RunCostPanel, RunReport, WorkflowBenchmarkPanel, WorkflowInsightsPanel, WorkspaceNoticesPanel, formatCostUsd } from './runs.tsx';

export function RunsSurface(props: AppProps): React.ReactElement {
	const run = props.runs[0] ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const catalog = localeCatalog.runInspector;
	const runsFailure = props.operationalFailures?.Runs;
	const runsLoaded = props.operationalLoaded?.Runs === true;
	const runsPending = props.operationalPending?.Runs === true;
	const activityFailure = props.operationalFailures?.['Run activity'];
	const activityLoaded = props.operationalLoaded?.['Run activity'] === true;
	const activityPending = props.operationalPending?.['Run activity'] === true;
	const snapshotFailure = props.operationalFailures?.Snapshot;
	const snapshotLoaded = props.operationalLoaded?.Snapshot === true;
	const snapshotPending = props.operationalPending?.Snapshot === true;
	return (
		<SurfaceColumn label={localeCatalog.shell.routeLabels.runs} status={props.status}>
			<OperationalReadPanel detail={runsFailure} loaded={runsLoaded} locale={props.locale} pending={runsPending} resource="Runs">
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
				<CardGrid className="sm:grid-cols-2" compact>
					{run.cost.totalCostUsd === null ? null : (
						<Stat
							label={catalog.stats.expectedCost}
							value={formatCostUsd(run.cost.totalCostUsd, props.locale)}
						/>
					)}
					<Stat
						label={catalog.stats.events}
						value={activityFailure !== undefined && !activityLoaded ? '—' : props.events.filter((event) => event.runId === run.id).length}
					/>
				</CardGrid>
			)}
			<CardSplit>
				<CardStack className="min-w-0">
					<OperationalReadPanel detail={activityFailure} loaded={activityLoaded} locale={props.locale} pending={activityPending} resource="Run activity">
						<RunActivity
							catalog={localeCatalog.runsOperational}
							events={props.events}
							locale={props.locale}
							run={run}
						/>
					</OperationalReadPanel>
					{run === null ? null : <RunReport catalog={catalog} run={run} />}
				</CardStack>
				<CardStack className="min-w-0">
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
				</CardStack>
			</CardSplit>
			<PreviousRunsPanel
				catalog={localeCatalog.runsOperational}
				locale={props.locale}
				runs={props.runs}
			/>
			</OperationalReadPanel>
			<OperationalReadPanel detail={snapshotFailure} loaded={snapshotLoaded} locale={props.locale} pending={snapshotPending} resource="Snapshot">
				<WorkspaceNoticesPanel
					catalog={localeCatalog.runsOperational}
					workspaceNotices={props.workspaceNotices}
				/>
			</OperationalReadPanel>
		</SurfaceColumn>
	);
}

export function draftChanged(draft: IssueReviewDraft, scope: string, command: string): boolean {
	return scope !== draft.scope || command !== draft.verificationCommand;
}

/** The editable contract of one draft: its revision, its approval, and its abandonment. */
