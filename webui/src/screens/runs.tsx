// webui/src/screens/runs.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { ProviderStatusView } from '../client.ts';
import { Badge } from '../components/ui/badge.tsx';
import type { BadgeVariant } from '../components/ui/badge.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card, CardAction, CardHeader, CardPanel, CardTitle } from '../components/ui/card.tsx';
import { Progress } from '../components/ui/progress.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { cn } from '../lib/cn.ts';
import { useLiveEdge } from '../live-edge.ts';
import { DEFAULT_LOCALE, LOCALE_CATALOG } from '../locale.ts';
import type { Locale, RunInspectorCatalog, RunsOperationalCatalog, RunsWorkflowCatalog, SettingsCatalog } from '../locale.ts';
import { actionsFor, phaseOf, progressOf, summarizeWorkflow, summarizeWorkflowCohorts, toneOf } from '../run-view.ts';
import type { ProviderUsageWindowView, RunCostRole, RunCostRoleUsage, RunEventView, RunExecutorHandoffView, RunProviderWaitView, RunView, WorkflowCohort } from '../run-view.ts';
import { ActionButton, ContextPanel } from './operator-controls.tsx';
import { TEXT_LINK_CLASS } from './operator-links.ts';

export function formatCount(count: number, locale: Locale): string {
	return new Intl.NumberFormat(locale).format(count);
}

/** Reads a named field out of the form that was just submitted, trimmed. */
export function fieldReader(form: EventTarget): (name: string) => string {
	const fields = (form as unknown as {
		elements: { namedItem: (name: string) => { value?: unknown } | null };
	}).elements;
	return (name) => {
		const field = fields.namedItem(name);
		return field?.value === undefined ? '' : String(field.value).trim();
	};
}

export function eventDetail(event: RunEventView, toolsLabel = 'Tools'): string | null {
	const details: string[] = [];
	const text = event.payload['text'];
	if (typeof text === 'string' && text.trim().length > 0) details.push(text);
	const tools = event.payload['tools'];
	if (Array.isArray(tools) && tools.every((tool) => typeof tool === 'string')) {
		details.push(`${toolsLabel}: ${tools.join(', ')}`);
	}
	for (const key of ['findings', 'error']) {
		const value = event.payload[key];
		if (typeof value === 'string' && value.trim().length > 0) details.push(value);
	}
	const scalars = Object.entries(event.payload)
		.filter(([key]) => !['text', 'tools', 'findings', 'error'].includes(key))
		.filter((entry): entry is [string, string | number | boolean] =>
			['string', 'number', 'boolean'].includes(typeof entry[1]))
		.map(([key, value]) => `${key}: ${String(value)}`);
	details.push(...scalars);
	return details.length === 0 ? null : details.join('\n');
}

/**
 * Provider chatter the operator cannot act on: thinking-token accounting, and
 * assistant turns whose public projection came back with nothing to show. It is
 * dropped before the window so a burst of it cannot push cycle events out.
 */
export function isOperational(event: RunEventView): boolean {
	if (event.kind.endsWith('.system')) return event.payload['subtype'] !== 'thinking_tokens';
	if (event.kind.endsWith('.activity')) return eventDetail(event) !== null;
	return true;
}

/**
 * The operator pays a subscription, not the API, so this is always presented
 * as the expected cost an equivalent API call would have billed -- never as
 * an amount charged (GSHIP-623).
 */
export function formatCostUsd(
	value: number,
	locale: Locale = DEFAULT_LOCALE,
	maximumFractionDigits: 2 | 4 = 4,
): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits,
	}).format(value);
}

export function formatEventTime(value: string, locale: Locale): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleTimeString(locale, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
			timeZone: 'UTC',
		});
}

export function formatRunTimestamp(value: string, locale: Locale): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleString(locale, {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
			timeZone: 'UTC',
		});
}

/** No correction round yet: nothing to report, not a fabricated zero line. */
export function hasNoRounds(origins: RunView['roundOrigins']): boolean {
	return origins.executor + (origins.ci ?? 0) + origins.decision + (origins.orchestrator ?? 0) + origins.indeterminate === 0;
}

/** Compact token-count line for one breakdown entry; omits a count the CLI never reported. */
export function formatTokenCounts(
	entry: RunView['cost']['breakdown'][number],
	catalog: RunsOperationalCatalog['cost'],
): string | null {
	const parts: string[] = [];
	if (entry.inputTokens !== undefined) parts.push(`${entry.inputTokens} ${catalog.tokenLabels.input}`);
	if (entry.outputTokens !== undefined) parts.push(`${entry.outputTokens} ${catalog.tokenLabels.output}`);
	if (entry.cacheReadInputTokens !== undefined) {
		parts.push(`${entry.cacheReadInputTokens} ${catalog.tokenLabels.cacheRead}`);
	}
	if (entry.cacheCreationInputTokens !== undefined) {
		parts.push(`${entry.cacheCreationInputTokens} ${catalog.tokenLabels.cacheCreated}`);
	}
	return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The role heading's own line: effort beside the role name, thinking tokens
 * after it -- both properties of the invocation, not of any one model below
 * it (GSHIP-628) -- omitted individually when that role's invocations never
 * reported them, and the whole role label falls back to its bare name when
 * neither did.
 */
export function formatRoleUsage(
	role: RunCostRole,
	usage: RunCostRoleUsage | undefined,
	catalog: RunsOperationalCatalog['cost'],
): string {
	const label = catalog.roleLabels[role];
	const suffix = usage?.effort === undefined ? '' : catalog.effort(usage.effort);
	const thinking = usage?.thinkingTokens === undefined ? '' : ` · ${catalog.thinking(usage.thinkingTokens)}`;
	return `${label}${suffix}${thinking}`;
}


export function RunActivity({
	catalog,
	locale,
	run,
	events,
}: Pick<AppProps, 'events' | 'locale'> & {
	catalog: RunsOperationalCatalog;
	run: RunView | null;
}): React.ReactElement | null {
	const visible = run === null
		? []
		: events
			.filter((event) => event.runId === run.id && isOperational(event))
			.slice(-30);
	const {
		canReturnToLiveEdge: _canReturnToLiveEdge,
		returnToLiveEdge: _returnToLiveEdge,
		...liveEdge
	} = useLiveEdge<HTMLOListElement>(visible.at(-1)?.seq ?? null, run?.id ?? null);
	if (run === null) return null;
	return (
		<ContextPanel
			description={catalog.activity.description(visible.length)}
			open
			title={catalog.activity.title}
		>
			<ol
				{...liveEdge}
				aria-label={catalog.activity.title}
				className="flex max-h-80 flex-col gap-3 overflow-x-hidden overflow-y-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				{visible.map((event) => {
					const detail = eventDetail(event, catalog.activity.toolsLabel);
					return (
						<li className="min-w-0 border-border border-l-2 pl-3 text-sm" key={event.seq}>
							<div className="flex items-baseline justify-between gap-3">
							<code className="min-w-0 break-all">{event.kind}</code>
							{event.kind === 'run.cycle-response' ? <Badge>{catalog.activity.cycleResponseLabel}</Badge> : null}
								<time className="shrink-0 font-mono text-muted-foreground text-xs">
									{formatEventTime(event.createdAt, locale)}
								</time>
							</div>
							{detail === null ? null : (
								<p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
									{detail}
								</p>
							)}
						</li>
					);
				})}
			</ol>
		</ContextPanel>
	);
}

export function RunProgress({
	catalog,
	run,
}: { catalog: RunInspectorCatalog; run: RunView }): React.ReactElement {
	const phase = phaseOf(run.state);
	return (
		<Progress
			label={catalog.phaseLabel(catalog.stateLabels[phase])}
			value={Math.round(progressOf(run.state) * 100)}
		/>
	);
}

export function PullRequestDelivery({
	catalog,
	run,
}: { catalog: RunInspectorCatalog; run: RunView }): React.ReactElement | null {
	const delivery = run.pullRequest;
	const correction = run.ciCorrection ?? null;
	if (delivery === null && correction === null) return null;
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			{delivery === null ? null : <>
				<a className={TEXT_LINK_CLASS} href={delivery.url} rel="noreferrer" target="_blank">
					{catalog.pullRequestLabel(delivery.prNumber)}
				</a>
				{run.state === 'done' ? <Badge variant="merged">Merged</Badge> : null}
				<Badge variant={ciBadgeVariant(delivery.ciStatus)}>{catalog.ciLabels[delivery.ciStatus]}</Badge>
			</>}
			{correction === null ? null : correction.check.url === undefined ? (
				<span className="text-warning-foreground text-xs">
					{catalog.ciCorrectionLabel(correction.check.name)}
				</span>
			) : (
				<a className={TEXT_LINK_CLASS} href={correction.check.url} rel="noreferrer" target="_blank">
					{catalog.ciCorrectionLabel(correction.check.name)}
				</a>
			)}
			{delivery?.failedChecks.map((check) => check.url === undefined ? (
				<span className="text-destructive-foreground text-xs" key={check.name}>{check.name}</span>
			) : (
				<a className={TEXT_LINK_CLASS} href={check.url} key={check.name} rel="noreferrer" target="_blank">
					{check.name}
				</a>
			))}
		</div>
	);
}

export function ciBadgeVariant(status: NonNullable<RunView['pullRequest']>['ciStatus']): BadgeVariant {
	if (status === 'failed') return 'error';
	if (status === 'pending') return 'warning';
	if (status === 'passed') return 'success';
	return 'outline';
}

export function ProviderWaitCallout({
	catalog,
	locale,
	wait,
}: {
	catalog: RunInspectorCatalog;
	locale: Locale;
	wait: RunProviderWaitView | null;
}): React.ReactElement | null {
	if (wait === null) return null;
	const retryDate = wait.retryAt === undefined ? null : new Date(wait.retryAt);
	const retryText = retryDate === null || Number.isNaN(retryDate.getTime())
		? wait.retryAt
		: retryDate.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
	const providerName = wait.provider === 'claude' ? 'Claude Code' : 'Codex';
	return (
		<Callout
			aria-label={catalog.providerHold.accessibleLabel}
			title={catalog.providerHold.title(providerName)}
			tone="warning"
		>
			<p className="text-sm">{catalog.providerHold.waitReasons[wait.kind]}.</p>
			<p className="break-words text-xs">{wait.message}</p>
			{retryText === undefined ? null : (
				<p className="text-xs">
					{catalog.providerHold.retryBefore}
					<time dateTime={wait.retryAt}>{retryText}</time>
					{catalog.providerHold.retryAfter}
				</p>
			)}
		</Callout>
	);
}

/**
 * Discloses that a run's executor role handed off between providers
 * (GSHIP-722) and its origin -- never an invented balance, only the fact, the
 * direction and why. Shown regardless of the run's current state: once a
 * handoff happened, it stays a fact about the run.
 */
export function ExecutorHandoffCallout({
	catalog,
	handoff,
}: {
	catalog: RunInspectorCatalog;
	handoff: RunExecutorHandoffView | null;
}): React.ReactElement | null {
	if (handoff === null) return null;
	const fromProviderName = handoff.from === 'claude' ? 'Claude Code' : 'Codex';
	const toProviderName = handoff.to === 'claude' ? 'Claude Code' : 'Codex';
	// A refused attempt never transferred anything: the run stayed on its own
	// origin, so the title says the attempt was refused instead of claiming a
	// handoff that did not happen.
	const title = handoff.outcome === 'refused'
		? catalog.executorHandoff.refusedTitle(fromProviderName, toProviderName)
		: catalog.executorHandoff.title(fromProviderName, toProviderName);
	return (
		<Callout aria-label={catalog.executorHandoff.accessibleLabel} title={title}>
			<p className="text-xs">{catalog.executorHandoff.reasonPrefix}{catalog.providerHold.waitReasons[handoff.reason]}</p>
		</Callout>
	);
}

/**
 * The commands the run admits right now, and only those: a command the runtime
 * would refuse is not rendered as a dead button. `pending` still holds the ones
 * that are offered, so a command in flight cannot be issued twice.
 */
export function RunCommands({
	catalog,
	run,
	pending,
	onResume,
	onAbandon,
	onCancel,
	onShip,
}: Pick<AppProps, 'pending' | 'onResume' | 'onAbandon' | 'onCancel' | 'onShip'> & {
	catalog: RunInspectorCatalog;
	run: RunView | null;
}): React.ReactElement | null {
	// Only `start` depends on a backlog selection, and no run surface offers it.
	const actions = actionsFor(run, false);
	const offered = [
		// While the run waits, resuming IS the answer, and the conversation asks it.
		// The bare command carries no guidance, so the click is dropped rather than
		// forwarded: `onResume` takes an optional string, and a SyntheticEvent in
		// its place would be posted as the operator's message and refused as 400.
		{
			label: catalog.commandLabels.resume,
			shown: actions.resume && run?.state !== 'waiting-user',
			onClick: () => onResume(),
		},
		// The other way out of an interrupted run: end it here, without reopening
		// the provider session, so the next issue is no longer blocked by it.
		{ label: catalog.commandLabels.abandon, shown: actions.abandon, onClick: onAbandon },
		{ label: catalog.commandLabels.cancel, shown: actions.cancel, onClick: onCancel },
		{ label: catalog.commandLabels.ship, shown: actions.ship, onClick: onShip },
	].filter((command) => command.shown);
	if (offered.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{offered.map((command) => (
				<ActionButton
					enabled={!pending}
					key={command.label}
					label={command.label}
					onClick={command.onClick}
				/>
			))}
		</div>
	);
}

/**
 * The run's identity and its live commands: which issue, what state, how far
 * along, and the commands that exist. That is the whole inspector the
 * conversation surface carries -- no identifier, no report, no telemetry, only
 * `footer`'s way to the surface that has them -- and it is also the head of
 * /runs, where the depth it refuses is disclosed below it.
 */
export function RunCard({
	catalog,
	locale,
	run,
	title,
	footer,
	pending,
	onResume,
	onAbandon,
	onCancel,
	onShip,
	showCost = true,
}: Pick<AppProps, 'pending' | 'onResume' | 'onAbandon' | 'onCancel' | 'onShip'> & {
	catalog: RunInspectorCatalog;
	locale: Locale;
	run: RunView | null;
	title: string;
	footer?: React.ReactNode;
	showCost?: boolean;
}): React.ReactElement {
	return (
		<Card>
			{/*
			 * The issue is the run's identity, so it is the title; the section
			 * label ("Latest run") demotes to a mono overline, and the state
			 * badge holds the action corner. Same hierarchy in both themes.
			 */}
			<CardHeader>
				<div className="flex min-w-0 flex-col gap-1">
					<span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
						{title}
					</span>
					<CardTitle className={cn('break-all text-sm', run !== null && 'font-mono')}>
						{run === null ? catalog.noRunLabel : run.issueId}
					</CardTitle>
				</div>
				{run === null ? null : (
					<CardAction>
						<Badge variant={toneOf(run.state)}>{catalog.stateLabels[run.state]}</Badge>
					</CardAction>
				)}
			</CardHeader>
			{run === null && footer === undefined ? null : (
				<CardPanel>
					{run === null ? null : (
						<RunCardContent
							catalog={catalog}
							locale={locale}
							onAbandon={onAbandon}
							onCancel={onCancel}
							onResume={onResume}
							onShip={onShip}
							pending={pending}
							run={run}
							showCost={showCost}
						/>
					)}
					{footer}
				</CardPanel>
			)}
		</Card>
	);
}

export function RunCardContent({
	catalog,
	locale,
	run,
	pending,
	onResume,
	onAbandon,
	onCancel,
	onShip,
	showCost = true,
}: Pick<AppProps, 'pending' | 'onResume' | 'onAbandon' | 'onCancel' | 'onShip'> & {
	catalog: RunInspectorCatalog;
	locale: Locale;
	run: RunView;
	showCost?: boolean;
}): React.ReactElement {
	return (
		<>
			<RunProgress catalog={catalog} run={run} />
			<PullRequestDelivery catalog={catalog} run={run} />
			<ProviderWaitCallout catalog={catalog} locale={locale} wait={run.providerWait} />
			<ExecutorHandoffCallout catalog={catalog} handoff={run.executorHandoff} />
			{/* /runs shows the cost in its stat row, so the card yields the sentence
			 * there. The round origins stay a sentence everywhere: their breakdown
			 * is provenance and never collapses into one number. */}
			{showCost && run.cost.totalCostUsd !== null ? (
				<p className="text-muted-foreground text-sm">
					{catalog.expectedCost(formatCostUsd(run.cost.totalCostUsd, locale))}
				</p>
			) : null}
			{hasNoRounds(run.roundOrigins) ? null : (
				<p className="text-muted-foreground text-sm">
					{catalog.correctionRounds(
						run.roundOrigins.executor,
						run.roundOrigins.ci ?? 0,
						run.roundOrigins.decision,
						run.roundOrigins.orchestrator ?? 0,
						run.roundOrigins.indeterminate,
					)}
				</p>
			)}
			<RunCommands
				catalog={catalog}
				onAbandon={onAbandon}
				onCancel={onCancel}
				onResume={onResume}
				onShip={onShip}
				pending={pending}
				run={run}
			/>
		</>
	);
}

/**
 * The same run, at the depth the inspector deliberately refuses: the report the
 * runtime wrote and the identifier it wrote it under, behind a disclosure that
 * opens only when the operator is reading a run rather than commanding one.
 */
export function RunReport({
	catalog,
	run,
}: { catalog: RunInspectorCatalog; run: RunView }): React.ReactElement | null {
	if (run.summary === null && run.error === null) return null;
	return (
		<ContextPanel
			description={catalog.report.description}
			title={catalog.report.title}
		>
			<div className="flex flex-col gap-3">
				{run.error === null ? null : (
					<Callout tone="destructive">
						<p className="whitespace-pre-wrap break-words">{run.error}</p>
					</Callout>
				)}
				{run.summary === null ? null : (
					<p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
						{run.summary}
					</p>
				)}
				<code className="break-all text-muted-foreground text-xs">{run.id}</code>
			</div>
		</ContextPanel>
	);
}

/**
 * The same total the card shows, broken down by which role and which model
 * produced it (GSHIP-623). `total_cost_usd` is the sum across every model a
 * provider invocation used, including auxiliary calls the operator's own
 * model settings never name, so attributing the whole total to "the
 * configured model" would misrepresent it -- the breakdown is shown instead.
 * Always the expected cost an equivalent API call would have billed, never an
 * amount charged: the operator pays a subscription.
 *
 * Effort and thinking tokens are properties of the invocation, not of any one
 * model in it (GSHIP-628), so they sit on the role heading above its model
 * rows instead of on a model row itself.
 */
export function RunCostPanel({
	catalog,
	locale,
	run,
}: Pick<AppProps, 'locale'> & {
	catalog: RunsOperationalCatalog;
	run: RunView;
}): React.ReactElement | null {
	if (run.cost.breakdown.length === 0) return null;
	const roles: RunCostRole[] = [];
	for (const entry of run.cost.breakdown) {
		if (!roles.includes(entry.role)) roles.push(entry.role);
	}
	return (
		<ContextPanel
			description={catalog.cost.description}
			title={catalog.cost.title}
		>
			<ul className="flex flex-col gap-4">
				{roles.map((role) => {
					const usage = run.cost.roles.find((entry) => entry.role === role);
					return (
						<li className="flex flex-col gap-2" key={role}>
							<p className="text-sm font-medium">{formatRoleUsage(role, usage, catalog.cost)}</p>
							<ul className="flex flex-col gap-3 pl-3">
								{run.cost.breakdown.filter((entry) => entry.role === role).map((entry) => {
									const tokens = formatTokenCounts(entry, catalog.cost);
									return (
										<li className="flex flex-col gap-1 text-sm" key={`${entry.role}-${entry.model}`}>
										<div className="flex items-baseline justify-between gap-3">
											<span className="min-w-0 break-all font-mono text-xs">{entry.model}</span>
											<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
												{formatCostUsd(entry.costUsd, locale)}
											</span>
										</div>
										{tokens === null ? null : (
											<span className="font-mono text-muted-foreground text-xs tabular-nums">
												{tokens} {catalog.cost.tokensSuffix}
											</span>
										)}
										</li>
									);
								})}
							</ul>
						</li>
					);
				})}
			</ul>
		</ContextPanel>
	);
}

/** How much history the operator needs to place the current run in a session. */
export const PREVIOUS_RUNS_SHOWN = 4;

export function PreviousRunRow({
	locale,
	run,
	runInspector,
	showCost,
}: {
	locale: Locale;
	run: RunView;
	runInspector: RunInspectorCatalog;
	showCost: boolean;
}): React.ReactElement {
	const delivery = run.pullRequest;
	return (
		<TableRow>
			<TableCell className="break-all font-mono text-xs">{run.issueId}</TableCell>
			<TableCell>
				<span className="flex flex-wrap items-center gap-1.5">
					<Badge variant={toneOf(run.state)}>{runInspector.stateLabels[run.state]}</Badge>
					{delivery !== null && run.state === 'done'
						? <Badge variant="merged">Merged</Badge>
						: null}
				</span>
			</TableCell>
			<TableCell>
				{delivery === null ? null : (
					<span className="flex flex-wrap items-center gap-1.5">
						<a className={TEXT_LINK_CLASS} href={delivery.url} rel="noreferrer" target="_blank">
							{runInspector.pullRequestLabel(delivery.prNumber)}
						</a>
						<Badge variant={ciBadgeVariant(delivery.ciStatus)}>
							{runInspector.ciLabels[delivery.ciStatus]}
						</Badge>
					</span>
				)}
			</TableCell>
			{showCost ? (
				<TableCell className="text-right font-mono text-muted-foreground text-xs">
					{run.cost.totalCostUsd === null
						? null
						: runInspector.expectedCost(formatCostUsd(run.cost.totalCostUsd, locale))}
				</TableCell>
			) : null}
			<TableCell className="text-right">
				<time className="font-mono text-muted-foreground text-xs">
					{formatRunTimestamp(run.updatedAt, locale)}
				</time>
			</TableCell>
		</TableRow>
	);
}

/**
 * The runs before the one the page above commands, read-only: there is no
 * selection and no command here, only what an operator returning to the screen
 * needs to know about what already ran. Each row carries its own expected cost
 * (GSHIP-639) so Sonnet and another choice can be compared without opening
 * either run -- labeled the same "expected cost" as every other cost figure
 * on this screen, never the amount actually billed, and omitted entirely
 * rather than shown as zero when its run never reported one.
 */
export function PreviousRunsPanel({
	catalog,
	locale,
	runs,
}: Pick<AppProps, 'locale' | 'runs'> & {
	catalog: RunsOperationalCatalog;
}): React.ReactElement | null {
	const previous = runs.slice(1, 1 + PREVIOUS_RUNS_SHOWN);
	if (previous.length === 0) return null;
	const runInspector = LOCALE_CATALOG[locale].runInspector;
	// A column with no datum in any row is not drawn.
	const showCost = previous.some((run) => run.cost.totalCostUsd !== null);
	return (
		<ContextPanel
			description={catalog.previousRuns.description(previous.length)}
			title={catalog.previousRuns.title}
		>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{catalog.previousRuns.columns.issue}</TableHead>
						<TableHead>{catalog.previousRuns.columns.state}</TableHead>
						<TableHead>{catalog.previousRuns.columns.delivery}</TableHead>
						{showCost ? (
							<TableHead className="text-right">{catalog.previousRuns.columns.cost}</TableHead>
						) : null}
						<TableHead className="text-right">{catalog.previousRuns.columns.updated}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{previous.map((run) => (
						<PreviousRunRow key={run.id} locale={locale} run={run} runInspector={runInspector} showCost={showCost} />
					))}
				</TableBody>
			</Table>
		</ContextPanel>
	);
}

/**
 * One compact read of the complete /api/runs window. The raw outcome,
 * correction and cost facts stay inspectable; Gateship does not collapse them
 * into a score that an agent could optimize instead of shipping useful work.
 */
export function WorkflowInsightsPanel({
	catalog,
	locale,
	runs,
}: Pick<AppProps, 'locale' | 'runs'> & { catalog: RunsWorkflowCatalog }): React.ReactElement | null {
	if (runs.length === 0) return null;
	const insights = summarizeWorkflow(runs);
	const correctionRounds = insights.corrections.executor
		+ (insights.corrections.ci ?? 0)
		+ insights.corrections.decision
		+ (insights.corrections.orchestrator ?? 0)
		+ insights.corrections.indeterminate;
	return (
		<ContextPanel
			description={catalog.signals.description(insights.runCount)}
			title={catalog.signals.title}
		>
			<dl className="grid gap-3 text-sm sm:grid-cols-[9rem_1fr]">
				<dt className="text-muted-foreground">{catalog.signals.outcomesLabel}</dt>
				<dd>{catalog.signals.outcomes(
					insights.outcomes.done,
					insights.outcomes.failed,
					insights.outcomes.cancelled,
					insights.outcomes.active,
				)}</dd>
				<dt className="text-muted-foreground">{catalog.signals.correctionsLabel}</dt>
				<dd>{catalog.signals.corrections(
					correctionRounds,
					insights.corrections.runCount,
					insights.corrections.executor,
					insights.corrections.ci ?? 0,
					insights.corrections.decision,
					insights.corrections.orchestrator ?? 0,
					insights.corrections.indeterminate,
				)}</dd>
				<dt className="text-muted-foreground">{catalog.signals.cycleResponsesLabel}</dt>
				<dd>{catalog.signals.cycleResponses(
					insights.cycleResponses.count,
					insights.cycleResponses.runCount,
				)}</dd>
				<dt className="text-muted-foreground">{catalog.signals.knownCostLabel}</dt>
				<dd>
					{insights.cost.totalCostUsd === null
						? catalog.signals.noReportedCost
						: catalog.signals.reportedCost(
							formatCostUsd(insights.cost.totalCostUsd, locale),
							insights.cost.reportedRunCount,
							insights.runCount,
						)}
				</dd>
			</dl>
			{insights.cost.totalCostUsd === null ? null : (
				<p className="text-muted-foreground text-xs">
					{LOCALE_CATALOG[locale].runsOperational.cost.description}
				</p>
			)}
		</ContextPanel>
	);
}

export function formatWallTime(
	milliseconds: number | null,
	catalog: RunsWorkflowCatalog['benchmarks']['card']['wallTime'],
): string {
	if (milliseconds === null) return catalog.notRecorded;
	const minutes = Math.round(milliseconds / 60_000);
	if (minutes < 1) return catalog.lessThanMinute;
	if (minutes < 60) return catalog.minutes(minutes);
	const hours = minutes / 60;
	return catalog.hours(hours < 10 ? hours : Math.round(hours));
}

export function configurationLabel(
	configuration: WorkflowCohort['configurations'][number],
	catalog: RunsWorkflowCatalog,
	locale: Locale,
): string {
	const roleLabels = LOCALE_CATALOG[locale].runsOperational.cost.roleLabels;
	const roles = configuration.roles.map(({ role, models, efforts, providers }) => {
		const model = models.length === 0 ? catalog.benchmarks.card.modelMissing : models.join(' + ');
		// The providers that actually ran the role sit beside its effort
		// (GSHIP-709): a review that fell back shows both, so the run's own
		// provider still reads as the origin it is.
		const detail = [
			...(efforts.length === 0 ? [] : [efforts.join(' + ')]),
			...(providers === undefined || providers.length === 0 ? [] : [providers.join(' + ')]),
		];
		return `${roleLabels[role]}: ${model}${detail.length === 0 ? '' : ` (${detail.join(', ')})`}`;
	});
	return [configuration.provider, ...roles].join(' · ');
}

export function WorkflowCohortCard({
	catalog,
	cohort,
	label,
	locale,
}: {
	catalog: RunsWorkflowCatalog;
	cohort: WorkflowCohort;
	label: string;
	locale: Locale;
}): React.ReactElement {
	const card = catalog.benchmarks.card;
	const correctionCount = cohort.corrections.executor
		+ (cohort.corrections.ci ?? 0)
		+ cohort.corrections.decision
		+ (cohort.corrections.orchestrator ?? 0)
		+ cohort.corrections.indeterminate;
	return (
		<section className="rounded-lg border p-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h4 className="font-medium">{label}</h4>
				<code className="break-all text-muted-foreground text-xs">{cohort.revision}</code>
			</div>
			<dl className="grid gap-2 text-sm sm:grid-cols-[9rem_1fr]">
				<dt className="text-muted-foreground">{card.terminalSampleLabel}</dt>
				<dd>{card.terminalSample(cohort.terminalRunCount, cohort.incompleteRunCount)}</dd>
				<dt className="text-muted-foreground">{card.outcomesLabel}</dt>
				<dd>{card.outcomes(
					cohort.outcomes.shipped,
					cohort.outcomes.failed,
					cohort.outcomes.cancelled,
				)}</dd>
				<dt className="text-muted-foreground">{card.humanAttentionLabel}</dt>
				<dd>{card.humanAttention(
					cohort.attention.requests,
					cohort.attention.runCount,
					cohort.attention.interventions,
				)}</dd>
				<dt className="text-muted-foreground">{card.cycleResponsesLabel}</dt>
				<dd>{card.cycleResponses(cohort.cycleResponses.count, cohort.cycleResponses.runCount)}</dd>
				<dt className="text-muted-foreground">{card.correctionsLabel}</dt>
				<dd>{card.corrections(correctionCount, cohort.corrections.runCount)}</dd>
				<dt className="text-muted-foreground">{card.providerHoldsLabel}</dt>
				<dd>{card.providerHolds(cohort.providerHolds.count, cohort.providerHolds.runCount)}</dd>
				<dt className="text-muted-foreground">{card.medianTimeLabel}</dt>
				<dd>{card.medianTime(formatWallTime(cohort.medianWallTimeMs, card.wallTime))}</dd>
				<dt className="text-muted-foreground">{card.knownCostLabel}</dt>
				<dd>
					{cohort.cost.totalCostUsd === null
						? card.noReportedCost
						: card.reportedCost(
							formatCostUsd(cohort.cost.totalCostUsd, locale),
							cohort.cost.reportedRunCount,
						)}
				</dd>
			</dl>
			<div className="mt-3 flex flex-col gap-1 text-muted-foreground text-xs">
				{cohort.configurations.length === 0 ? (
					<span>{card.configurationMissing}</span>
				) : cohort.configurations.map((configuration) => (
					<span key={configurationLabel(configuration, catalog, locale)}>
						{configuration.runCount}× {configurationLabel(configuration, catalog, locale)}
					</span>
				))}
			</div>
		</section>
	);
}

/** Adjacent immutable revision cohorts, never one synthetic score. */
export function WorkflowBenchmarkPanel({
	catalog,
	locale,
	runs,
}: Pick<AppProps, 'locale' | 'runs'> & { catalog: RunsWorkflowCatalog }): React.ReactElement | null {
	if (runs.length === 0) return null;
	const cohorts = summarizeWorkflowCohorts(runs).slice(0, 2);
	return (
		<ContextPanel
			description={catalog.benchmarks.description}
			title={catalog.benchmarks.title}
		>
			{cohorts.length === 0 ? (
				<p className="text-muted-foreground text-sm">{catalog.benchmarks.emptyGuidance}</p>
			) : (
				<div className="grid gap-3 xl:grid-cols-2">
					{cohorts.map((cohort, index) => (
						<WorkflowCohortCard
							catalog={catalog}
							cohort={cohort}
							key={cohort.revision}
							label={index === 0
								? catalog.benchmarks.latestCohortLabel
								: catalog.benchmarks.previousBaselineLabel}
							locale={locale}
						/>
					))}
				</div>
			)}
			{cohorts.length === 1 ? (
				<p className="mt-3 text-muted-foreground text-xs">{catalog.benchmarks.singleCohortGuidance}</p>
			) : null}
			<p className="mt-3 text-muted-foreground text-xs">{catalog.benchmarks.observationalDisclaimer}</p>
		</ContextPanel>
	);
}


export function WorkspaceNoticesPanel({
	catalog,
	workspaceNotices,
}: Pick<AppProps, 'workspaceNotices'> & {
	catalog: RunsOperationalCatalog;
}): React.ReactElement | null {
	if (workspaceNotices.length === 0) return null;
	return (
		<ContextPanel
			description={catalog.workspaces.description(workspaceNotices.length)}
			open
			title={catalog.workspaces.title}
		>
			<ul className="flex flex-col gap-3">
				{workspaceNotices.map((notice) => (
					<li
						className="flex flex-col gap-1 text-sm"
						key={`${notice.kind}-${notice.runId}-${notice.workspacePath}-${notice.branch}`}
					>
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="outline">{notice.kind}</Badge>
							{notice.runId === null ? null : <code className="break-all">{notice.runId}</code>}
						</div>
						<code className="break-all text-muted-foreground">
							{notice.workspacePath ?? notice.branch}
						</code>
						<p className="break-words text-muted-foreground">{notice.detail}</p>
					</li>
				))}
			</ul>
		</ContextPanel>
	);
}

export type ProviderPanelProps = Pick<
	AppProps,
	| 'providers' | 'selectedProvider' | 'pending' | 'onConnectCodex' | 'onSelectProvider'
	| 'onConnectClaudeCredential' | 'claudeCredentialError' | 'onDismissClaudeCredentialError'
	| 'onDisconnectClaudeCredential'
>;

export function providerDescription(provider: ProviderStatusView, catalog: SettingsCatalog): string {
	if (provider.availability !== undefined) {
		const reason = catalog.providers.waitReasons[provider.availability.kind];
		return provider.subscription
			? catalog.providers.connectedUnavailable(reason)
			: catalog.providers.unavailable(reason);
	}
	if (provider.subscription) {
		return catalog.providers.connected(provider.plan);
	}
	return provider.installed ? catalog.providers.installedDisconnected : catalog.providers.clientMissing;
}

export function formatUsageWindowDuration(minutes: number, locale: Locale, catalog: SettingsCatalog): string {
	if (minutes % 1_440 === 0) return catalog.providers.duration.days(minutes / 1_440, formatCount(minutes / 1_440, locale));
	if (minutes % 60 === 0) return catalog.providers.duration.hours(minutes / 60, formatCount(minutes / 60, locale));
	return catalog.providers.duration.minutes(formatCount(minutes, locale));
}

export function usageWindowLabel(window: ProviderUsageWindowView, locale: Locale, catalog: SettingsCatalog): string {
	const known = catalog.providers.usageWindowLabels[window.window];
	if (known !== undefined) return known;
	return window.windowMinutes === undefined ? window.window : formatUsageWindowDuration(window.windowMinutes, locale, catalog);
}

export function usageWindowVariant(status: ProviderUsageWindowView['status']): BadgeVariant {
	if (status === 'rejected') return 'error';
	if (status === 'allowed_warning') return 'warning';
	return 'outline';
}

export function formatUsageTime(value: string, locale: Locale): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

export function formatExactPercent(value: number, locale: Locale): string {
	return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 20 }).format(value / 100);
}

/** One window's percentage and reset time, each shown only when the source actually reported it. */
