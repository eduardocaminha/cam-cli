// webui/src/App.tsx
//
// The operator screen, as a pure function of its props: an app shell whose
// content is the all-projects overview or one of four project-scoped surfaces,
// chosen by the browser path. Each operational surface carries one task, so no
// column has to mix execution, telemetry, planning and configuration.
//
// Navigation is plain links to real paths, which the server answers with this
// same document; there is no router, no history state and no navigation branch
// to keep in sync. No fetching, no timers and no application state live here,
// so every branch is reachable by static rendering (ADR-0067) -- including the
// ones a collapsed panel hides, because disclosure is native <details> and
// never a mounted/unmounted branch. The single exception is where the
// transcript is scrolled, which no prop can describe; it lives in
// ./live-edge.ts, decides by a pure predicate, and renders nothing.

import React, { useCallback, useEffect, useState } from 'react';
import type { AppProps } from './app-props.ts';
import { AppShell, MAIN_CONTENT_ID } from './app-shell.tsx';
import {
	aggregateChatTurnCosts,
	type ChainPauseReason,
	type ChainRunsView,
	type DiagnosticCadenceView,
	type DiagnosticFindingView,
	type DiagnosticsView,
	emptyModelSettings,
	type IssueReviewDraft,
	MODEL_PROVIDER_IDS,
	MODEL_ROLE_NAMES,
	type ModelRoleName,
	type ModelSettingsView,
	type ModelSlotView,
	NOTIFICATION_CHANNEL_IDS,
	type NotificationChannelId,
	type NotificationChannelView,
	type ProjectOperationalOverviewView,
	type ProjectOverviewView,
	type ProjectStatusView,
	type ProviderStatusView,
	type RegisteredProjectView,
} from './client.ts';
import { GateshipMark, GateshipWordmark } from './components/gateship-logo.tsx';
import { AttentionCard } from './components/ui/attention-card.tsx';
import { EmptyState } from './components/ui/empty-state.tsx';
import { Input } from './components/ui/input.tsx';
import { Badge, type BadgeVariant } from './components/ui/badge.tsx';
import { Button, buttonVariants } from './components/ui/button.tsx';
import { Callout } from './components/ui/callout.tsx';
import {
	Card,
	CardAction,
	CardDescription,
	CardDisclosure,
	CardHeader,
	CardPanel,
	CardSummary,
	CardTitle,
} from './components/ui/card.tsx';
import { Progress } from './components/ui/progress.tsx';
import { SelectField } from './components/ui/select.tsx';
import { Stat } from './components/ui/stat.tsx';
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from './components/ui/table.tsx';
import { Menu } from '@base-ui/react/menu';
import {
	Activity01Icon,
	ArrowExpand01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowShrink01Icon,
	CubeIcon,
	Globe02Icon,
	Grid2X2Icon,
	ListViewIcon,
	Message01Icon,
	Moon02Icon,
	Settings01Icon,
	SidebarLeft01Icon,
	SidebarLeftIcon,
	Sun02Icon,
	Tick02Icon,
	UnfoldMoreIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tabs, TabsCount, TabsList, TabsPanel, TabsTab } from './components/ui/tabs.tsx';
import { Textarea } from './components/ui/textarea.tsx';
import { Separator } from './components/ui/separator.tsx';
import { cn } from './lib/cn.ts';
import { useLiveEdge } from './live-edge.ts';
import { RouteScreen } from './screens/route-screen.tsx';
import { SurfaceColumn } from './screens/surface-column.tsx';
import {
	type ConversationCatalog,
	DEFAULT_LOCALE,
	LOCALE_CATALOG,
	type Locale,
	type OnboardingCatalog,
	type OverviewCatalog,
	type ProjectsCatalog,
	type RunInspectorCatalog,
	type RunsOperationalCatalog,
	type RunsWorkflowCatalog,
	type SettingsCatalog,
	type ShellCatalog,
	type WorkCatalog,
} from './locale.ts';
import {
	PROJECT_SURFACES as SURFACES,
	routeSelection,
	type OperatorRoute,
	type RouteSelection,
} from './routes.ts';
import {
	actionsFor,
	activeRunIssueId,
	attentionOf,
	type OperatorAttention,
	type ProviderUsageView,
	type ProviderUsageWindowView,
	phaseOf,
	progressOf,
	type RunCostRole,
	type RunCostRoleUsage,
	type RunEventView,
	type RunExecutorHandoffView,
	type RunProviderWaitView,
	type RunState,
	type RunView,
	summarizeWorkflow,
	summarizeWorkflowCohorts,
	toneOf,
	type WorkflowCohort,
} from './run-view.ts';

export { projectIdOf, routeOf } from './routes.ts';
export type { AppProps } from './app-props.ts';
export type { OperatorRoute } from './routes.ts';

function formatCount(count: number, locale: Locale): string {
	return new Intl.NumberFormat(locale).format(count);
}

/** Reads a named field out of the form that was just submitted, trimmed. */
function fieldReader(form: EventTarget): (name: string) => string {
	const fields = (form as unknown as {
		elements: { namedItem: (name: string) => { value?: unknown } | null };
	}).elements;
	return (name) => {
		const field = fields.namedItem(name);
		return field?.value === undefined ? '' : String(field.value).trim();
	};
}

function eventDetail(event: RunEventView, toolsLabel = 'Tools'): string | null {
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
function isOperational(event: RunEventView): boolean {
	if (event.kind.endsWith('.system')) return event.payload['subtype'] !== 'thinking_tokens';
	if (event.kind.endsWith('.activity')) return eventDetail(event) !== null;
	return true;
}

/**
 * The operator pays a subscription, not the API, so this is always presented
 * as the expected cost an equivalent API call would have billed -- never as
 * an amount charged (GSHIP-623).
 */
function formatCostUsd(
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

function formatEventTime(value: string, locale: Locale): string {
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

function formatRunTimestamp(value: string, locale: Locale): string {
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
function hasNoRounds(origins: RunView['roundOrigins']): boolean {
	return origins.executor + (origins.ci ?? 0) + origins.decision + (origins.orchestrator ?? 0) + origins.indeterminate === 0;
}

/** Compact token-count line for one breakdown entry; omits a count the CLI never reported. */
function formatTokenCounts(
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
function formatRoleUsage(
	role: RunCostRole,
	usage: RunCostRoleUsage | undefined,
	catalog: RunsOperationalCatalog['cost'],
): string {
	const label = catalog.roleLabels[role];
	const suffix = usage?.effort === undefined ? '' : catalog.effort(usage.effort);
	const thinking = usage?.thinkingTokens === undefined ? '' : ` · ${catalog.thinking(usage.thinkingTokens)}`;
	return `${label}${suffix}${thinking}`;
}

const BUTTON_CLASS = buttonVariants({ variant: 'outline' });

const PRIMARY_BUTTON_CLASS = buttonVariants({ variant: 'default' });

/*
 * The active item is styled off aria-current, so state and appearance cannot
 * drift apart: a subtle fill and weight, no marker.
 */
const NAV_LINK_CLASS =
	'flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sidebar-foreground text-sm outline-none lg:min-h-0 ' +
	'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ' +
	'focus-visible:ring-2 focus-visible:ring-sidebar-ring ' +
	'aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium ' +
	'aria-[current=page]:text-sidebar-accent-foreground';

const TEXT_LINK_CLASS =
	'w-fit rounded-md text-muted-foreground text-sm underline underline-offset-4 outline-none ' +
	'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';

/* A link that IS a title: full ink, underline only on intent. */
const TITLE_LINK_CLASS =
	'rounded-md text-foreground outline-none underline-offset-4 hover:underline ' +
	'focus-visible:ring-2 focus-visible:ring-ring';

function ActionButton({
	label,
	enabled,
	onClick,
}: {
	label: string;
	enabled: boolean;
	onClick: () => void;
}): React.ReactElement {
	return (
		<Button variant="outline" disabled={!enabled} onClick={onClick} type="button">
			{label}
		</Button>
	);
}

/**
 * A panel of a secondary surface: the same card, disclosed natively so a page
 * can carry everything the operator may need without any one panel taking the
 * viewport. The whole panel stays in the markup when it is closed, which is
 * what keeps it readable by static rendering and by find-in-page.
 */
function ContextPanel({
	title,
	description,
	open = false,
	children,
	actionLabels = { open: 'open', close: 'close' },
}: {
	title: string;
	description: string;
	open?: boolean;
	children: React.ReactNode;
	actionLabels?: { open: string; close: string };
}): React.ReactElement {
	return (
		<CardDisclosure className="group" open={open}>
			<CardSummary>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
				<CardAction aria-hidden="true">
					<span className="text-muted-foreground text-xs group-open:hidden">{actionLabels.open}</span>
					<span className="hidden text-muted-foreground text-xs group-open:inline">{actionLabels.close}</span>
				</CardAction>
			</CardSummary>
			<CardPanel>{children}</CardPanel>
		</CardDisclosure>
	);
}

function RunActivity({
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
	const liveEdge = useLiveEdge<HTMLOListElement>(visible.at(-1)?.seq ?? null, run?.id ?? null);
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

function RunProgress({
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

function PullRequestDelivery({
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

function ciBadgeVariant(status: NonNullable<RunView['pullRequest']>['ciStatus']): BadgeVariant {
	if (status === 'failed') return 'error';
	if (status === 'pending') return 'warning';
	if (status === 'passed') return 'success';
	return 'outline';
}

function ProviderWaitCallout({
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
function ExecutorHandoffCallout({
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
function RunCommands({
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
function RunCard({
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
				<CardPanel className="flex flex-col gap-4">
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

function RunCardContent({
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
function RunReport({
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
function RunCostPanel({
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
const PREVIOUS_RUNS_SHOWN = 4;

function PreviousRunRow({
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
function PreviousRunsPanel({
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
function WorkflowInsightsPanel({
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

function formatWallTime(
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

function configurationLabel(
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

function WorkflowCohortCard({
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
function WorkflowBenchmarkPanel({
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

function WorkspaceNoticesPanel({
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

type ProviderPanelProps = Pick<
	AppProps,
	| 'providers' | 'selectedProvider' | 'pending' | 'onConnectCodex' | 'onSelectProvider'
	| 'onConnectClaudeCredential' | 'claudeCredentialError' | 'onDismissClaudeCredentialError'
	| 'onDisconnectClaudeCredential'
>;

function providerDescription(provider: ProviderStatusView, catalog: SettingsCatalog): string {
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

function formatUsageWindowDuration(minutes: number, locale: Locale, catalog: SettingsCatalog): string {
	if (minutes % 1_440 === 0) return catalog.providers.duration.days(minutes / 1_440, formatCount(minutes / 1_440, locale));
	if (minutes % 60 === 0) return catalog.providers.duration.hours(minutes / 60, formatCount(minutes / 60, locale));
	return catalog.providers.duration.minutes(formatCount(minutes, locale));
}

function usageWindowLabel(window: ProviderUsageWindowView, locale: Locale, catalog: SettingsCatalog): string {
	const known = catalog.providers.usageWindowLabels[window.window];
	if (known !== undefined) return known;
	return window.windowMinutes === undefined ? window.window : formatUsageWindowDuration(window.windowMinutes, locale, catalog);
}

function usageWindowVariant(status: ProviderUsageWindowView['status']): BadgeVariant {
	if (status === 'rejected') return 'error';
	if (status === 'allowed_warning') return 'warning';
	return 'outline';
}

function formatUsageTime(value: string, locale: Locale): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

function formatExactPercent(value: number, locale: Locale): string {
	return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 20 }).format(value / 100);
}

/** One window's percentage and reset time, each shown only when the source actually reported it. */
function ProviderUsageWindowRow({ window, locale, catalog }: { window: ProviderUsageWindowView; locale: Locale; catalog: SettingsCatalog }): React.ReactElement {
	const percent = window.usedPercent === undefined ? null : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(window.usedPercent / 100);
	return (
		<li className="flex flex-wrap items-center gap-2">
			<span>{usageWindowLabel(window, locale, catalog)}</span>
			{window.usedPercent === undefined ? null : (
				<Badge variant={usageWindowVariant(window.status)}>{catalog.providers.usedPercent(percent ?? '')}</Badge>
			)}
			{window.resetsAt === undefined ? null : (
				<span>{catalog.providers.resets} <time dateTime={window.resetsAt}>{formatUsageTime(window.resetsAt, locale)}</time></span>
			)}
			<span className="text-muted-foreground">
				{catalog.providers.asOf} <time dateTime={window.observedAt}>{formatUsageTime(window.observedAt, locale)}</time>
			</span>
		</li>
	);
}

/** Compact progressive detail (GSHIP-664): each piece of the source's telemetry renders only when present, never absent as a fabricated zero. */
function ProviderUsageDetail({ usage, locale, catalog }: { usage: ProviderUsageView | undefined; locale: Locale; catalog: SettingsCatalog }): React.ReactElement | null {
	if (usage === undefined) return null;
	const hasContent = usage.windows.length > 0
		|| usage.credits !== undefined
		|| usage.spendLimit !== undefined
		|| usage.resetCreditCount !== undefined;
	if (!hasContent) return null;
	return (
		<div className="mt-1 flex flex-col gap-1 text-xs">
			{usage.windows.length === 0 ? null : (
				<ul className="flex flex-col gap-1">
					{usage.windows.map((window) => <ProviderUsageWindowRow catalog={catalog} key={window.window} locale={locale} window={window} />)}
				</ul>
			)}
			{usage.credits === undefined ? null : (
				<p className="text-muted-foreground">
					{catalog.providers.credits}: {usage.credits.unlimited
						? catalog.providers.unlimited
						: usage.credits.hasCredits
							? (usage.credits.balance ?? catalog.providers.available)
							: catalog.providers.none}
				</p>
			)}
			{usage.spendLimit === undefined ? null : (
				<p className="text-muted-foreground">
					{catalog.providers.spendLimit(usage.spendLimit.used, usage.spendLimit.limit, formatExactPercent(usage.spendLimit.remainingPercent, locale))}
					{usage.spendLimit.resetsAt === undefined ? null : (
						<> · {catalog.providers.resets} <time dateTime={usage.spendLimit.resetsAt}>{formatUsageTime(usage.spendLimit.resetsAt, locale)}</time></>
					)}
				</p>
			)}
			{usage.resetCreditCount === undefined ? null : (
				<p className="text-muted-foreground">{catalog.providers.resetCredits(usage.resetCreditCount, formatCount(usage.resetCreditCount, locale))}</p>
			)}
		</div>
	);
}

/**
 * Read-only whenever `CLAUDE_CODE_OAUTH_TOKEN` is set in the service's own
 * environment (GSHIP-704): it always wins over the file, so a Settings write
 * here would create or remove a file with no effect on what actually
 * authenticates. The service refuses the write server-side too (PUT/DELETE
 * both answer 409 `env-managed`); this component keeps Ajustes from ever
 * offering an action that route would reject.
 */
function ClaudeCredentialEnvManagedNotice({
	provider,
	text,
}: {
	provider: ProviderStatusView;
	text: SettingsCatalog['providers']['claudeCredential'];
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
			<p>{provider.subscription ? text.connected : text.needsReconnect}</p>
			<p className="text-muted-foreground text-xs">{text.usageGuidance}</p>
			<p className="text-muted-foreground text-xs">{text.envManaged}</p>
		</div>
	);
}

/**
 * The connected card: what a dedicated credential offers once it is in
 * place. Rotating opens the same token form Connect uses, which is itself
 * only offered while `provider.installed`. Gating Rotate the same way means
 * the form the operator is sent to is always actually reachable, so
 * Disconnect -- the one escape from a connected card -- is never left
 * unrenderable with the Claude CLI absent (installed:false plus
 * login:'dedicated' is a real status `claudeStatus` reports on an ENOENT
 * read).
 *
 * That absent-CLI case is also the one where this card, not the form, has to
 * carry a refusal: a single missing `claude` binary both fails the validation
 * closed and makes the very next status read report `installed: false`, and
 * the form -- alert span included -- is gated on `installed`. Showing the
 * service's own words here, beside a Disconnect that stays enabled, is what
 * keeps that combination from stranding the operator with a silent card.
 */
function ClaudeCredentialConnectedCard({
	provider,
	pending,
	onRotate,
	error,
	onDismissError,
	onDisconnectClaudeCredential,
	text,
}: {
	provider: ProviderStatusView;
	pending: boolean;
	onRotate: () => void;
	error: AppProps['claudeCredentialError'];
	onDismissError: AppProps['onDismissClaudeCredentialError'];
	onDisconnectClaudeCredential: AppProps['onDisconnectClaudeCredential'];
	text: SettingsCatalog['providers']['claudeCredential'];
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
			<p>{provider.subscription ? text.connected : text.needsReconnect}</p>
			<p className="text-muted-foreground text-xs">{text.usageGuidance}</p>
			{error === null ? null : <span className="text-destructive text-xs" role="alert">{error}</span>}
			<div className="flex flex-wrap gap-2">
				{provider.installed ? (
					<button className={BUTTON_CLASS} onClick={onRotate} type="button">{text.rotate}</button>
				) : null}
				{error === null ? null : (
					<button className={BUTTON_CLASS} onClick={onDismissError} type="button">{text.cancel}</button>
				)}
				<button
					className={cn(BUTTON_CLASS, 'self-end')}
					disabled={pending}
					onClick={onDisconnectClaudeCredential}
					type="button"
				>{text.disconnect}</button>
			</div>
		</div>
	);
}

/**
 * Ajustes > Providers universal onboarding for a dedicated Claude
 * subscription (GSHIP-704). `rotating` is local, ephemeral UI state -- never
 * lifted to `AppProps` -- the same "reveal a form behind a button" pattern
 * `IssueReviewForm`'s own confirm gate already uses. Connect, reconnect and
 * rotate all submit through the one `onConnectClaudeCredential` call; the
 * server validates the candidate token before persisting it and never
 * returns it, so this form is write-only exactly like the Resend key field.
 *
 * A refusal (GSHIP-705) keeps the form open with the typed token and its
 * confirmation untouched, and shows the service's own words beside the
 * field: the token was printed once by `claude setup-token`, so clearing it
 * on failure would cost the operator the credential itself. That is why
 * `error` forces the form open even from the connected card -- a rotation
 * that was refused must not collapse back to "connected" with the refusal
 * hidden.
 *
 * `provider.installed` outranks both, because the form is gated on it: with
 * the Claude CLI absent, neither a refusal nor a `rotating` flag set while it
 * was still installed may route a connected operator to a branch that renders
 * no form, no Cancel and no Disconnect. The connected card carries the
 * refusal in that case instead.
 */
function ClaudeCredentialSection({
	provider,
	pending,
	onConnectClaudeCredential,
	error,
	onDismissError,
	onDisconnectClaudeCredential,
	catalog,
}: {
	provider: ProviderStatusView;
	pending: boolean;
	onConnectClaudeCredential: AppProps['onConnectClaudeCredential'];
	error: AppProps['claudeCredentialError'];
	onDismissError: AppProps['onDismissClaudeCredentialError'];
	onDisconnectClaudeCredential: AppProps['onDisconnectClaudeCredential'];
	catalog: SettingsCatalog;
}): React.ReactElement {
	const text = catalog.providers.claudeCredential;
	const [rotating, setRotating] = useState(false);
	const [token, setToken] = useState('');
	const [confirmed, setConfirmed] = useState(false);
	const connected = provider.login === 'dedicated';

	if (provider.credential?.envManaged === true) {
		return <ClaudeCredentialEnvManagedNotice provider={provider} text={text} />;
	}

	if (connected && (!provider.installed || (!rotating && error === null))) {
		return (
			<ClaudeCredentialConnectedCard
				error={error}
				onDisconnectClaudeCredential={onDisconnectClaudeCredential}
				onDismissError={onDismissError}
				onRotate={() => setRotating(true)}
				pending={pending}
				provider={provider}
				text={text}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
			<p className="font-medium">{text.advancedTitle}</p>
			<p className="text-muted-foreground">{text.explanation}</p>
			<p className="text-muted-foreground text-xs">{text.inferenceOnly}</p>
			{provider.installed ? (
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-xs">{text.setupCommandLabel}</span>
					<div className="flex flex-wrap items-center gap-2">
						<code className="break-all">claude setup-token</code>
						<button
							className={BUTTON_CLASS}
							onClick={() => {
								const clipboard = (globalThis as unknown as {
									navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } };
								}).navigator?.clipboard;
								void clipboard?.writeText?.('claude setup-token');
							}}
							type="button"
						>{text.copyCommand}</button>
					</div>
				</div>
			) : (
				<p className="text-muted-foreground text-xs">{text.cliMissing}</p>
			)}
			{provider.installed ? (
				<form
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						// Only a persisted credential clears the field: a refused token is
						// still the one the operator must correct, and the CLI will not
						// print it a second time.
						void onConnectClaudeCredential(token).then((connectedNow) => {
							if (!connectedNow) return;
							setToken('');
							setConfirmed(false);
							setRotating(false);
						});
					}}
				>
					<label className="flex flex-col gap-1" htmlFor="claude-credential-token">
						<span className="font-medium">{text.tokenLabel}</span>
						<Input
							autoComplete="off"
							disabled={pending}
							id="claude-credential-token"
							name="claude-credential-token"
							onChange={(event) => setToken((event.currentTarget as unknown as { value: string }).value)}
							placeholder={text.tokenPlaceholder}
							type="password"
							value={token}
						/>
						{error === null ? null : <span className="text-destructive text-xs" role="alert">{error}</span>}
					</label>
					<label className="flex items-start gap-2">
						<input
							checked={confirmed}
							name="claude-credential-confirm"
							onChange={(event) => setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)}
							type="checkbox"
						/>
						<span>{text.confirm}</span>
					</label>
					<div className="flex flex-wrap gap-2">
						<button
							className={cn(PRIMARY_BUTTON_CLASS, 'self-end')}
							disabled={pending || token.trim().length === 0 || !confirmed}
							type="submit"
						>{connected ? text.rotate : text.connect}</button>
						{connected ? (
							<button
								className={BUTTON_CLASS}
								onClick={() => {
									// Giving up on this attempt: the refusal that forced the form
									// open goes with it, or Cancel would leave the form open.
									onDismissError();
									setToken('');
									setConfirmed(false);
									setRotating(false);
								}}
								type="button"
							>{text.cancel}</button>
						) : null}
					</div>
				</form>
			) : null}
		</div>
	);
}

function ClaudeInteractiveLoginNotice({
	provider,
	text,
}: {
	provider: ProviderStatusView;
	text: SettingsCatalog['providers']['claudeCredential'];
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
			<p className="font-medium">{text.recommendedTitle}</p>
			<p className="text-muted-foreground">{text.recommendedGuidance}</p>
			<p className="text-muted-foreground text-xs">{text.usageGuidance}</p>
			{provider.installed ? (
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-xs">{text.recommendedCommandLabel}</span>
					<code className="break-all">claude auth login --claudeai</code>
				</div>
			) : <p className="text-muted-foreground text-xs">{text.cliMissing}</p>}
		</div>
	);
}

function ProviderRow({
	provider,
	catalog,
	locale,
	selectedProvider,
	pending,
	onConnectCodex,
	onConnectClaudeCredential,
	claudeCredentialError,
	onDismissClaudeCredentialError,
	onDisconnectClaudeCredential,
	onSelectProvider,
}: Omit<ProviderPanelProps, 'providers'> & { provider: ProviderStatusView; catalog: SettingsCatalog; locale: Locale }): React.ReactElement {
	return (
		<li className="flex flex-col gap-3 text-sm">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="flex flex-wrap items-center gap-2 font-medium">
						{provider.label}
						{provider.id === selectedProvider ? <Badge variant="secondary">{catalog.providers.inUse}</Badge> : null}
						{provider.id === 'claude' ? <Badge variant="outline">{catalog.providers.claudeCredential.originLabels[provider.login]}</Badge> : null}
					</p>
					<p className="break-words text-muted-foreground">{providerDescription(provider, catalog)}</p>
					<ProviderUsageDetail catalog={catalog} locale={locale} usage={provider.usage} />
				</div>
				{provider.id === 'codex' && !provider.subscription && provider.installed ? (
					<ActionButton enabled={!pending} label={catalog.providers.connectChatGpt} onClick={onConnectCodex} />
				) : null}
				{provider.subscription && provider.id !== selectedProvider ? (
					<ActionButton
						enabled={!pending}
						label={catalog.providers.useProvider(provider.label)}
						onClick={() => onSelectProvider(provider.id)}
					/>
				) : null}
			</div>
			{provider.id === 'claude' ? (
				<>
					{provider.login === 'dedicated' ? null : <ClaudeInteractiveLoginNotice provider={provider} text={catalog.providers.claudeCredential} />}
					<ClaudeCredentialSection
						catalog={catalog}
						error={claudeCredentialError}
						onConnectClaudeCredential={onConnectClaudeCredential}
						onDisconnectClaudeCredential={onDisconnectClaudeCredential}
						onDismissError={onDismissClaudeCredentialError}
						pending={pending}
						provider={provider}
					/>
				</>
			) : null}
			{provider.id === 'codex' ? (
				<div className="flex flex-col gap-1 text-xs text-muted-foreground">
					<p>{catalog.providers.codexSubscriptionGuidance}</p>
					<code className="break-all">codex login</code>
					<p>{catalog.providers.codexApiKeyWarning}</p>
					<p>{catalog.providers.codexEnterpriseFuture}</p>
				</div>
			) : null}
		</li>
	);
}

function ProvidersPanel(props: ProviderPanelProps & { catalog: SettingsCatalog; locale: Locale }): React.ReactElement {
	return (
		<ContextPanel
			actionLabels={props.catalog.disclosure}
			description={props.catalog.providers.description}
			open
			title={props.catalog.providers.title}
		>
			<ul className="flex flex-col gap-3">
				{props.providers.map((provider) => (
					<ProviderRow
						catalog={props.catalog}
						claudeCredentialError={props.claudeCredentialError}
						key={provider.id}
						locale={props.locale}
						onConnectClaudeCredential={props.onConnectClaudeCredential}
						onConnectCodex={props.onConnectCodex}
						onDisconnectClaudeCredential={props.onDisconnectClaudeCredential}
						onDismissClaudeCredentialError={props.onDismissClaudeCredentialError}
						onSelectProvider={props.onSelectProvider}
						pending={props.pending}
						provider={provider}
						selectedProvider={props.selectedProvider}
					/>
				))}
			</ul>
		</ContextPanel>
	);
}

const MODEL_PROVIDER_LABELS: Readonly<Record<ProviderStatusView['id'], string>> = {
	claude: 'Claude',
	codex: 'Codex',
};

/**
 * Each vendor's own model page. Gateship cannot track vendor releases, so it
 * points at the source of truth instead of embedding a list that goes stale:
 * the field stays free text and an unknown value is refused by the CLI itself.
 */
const MODEL_DOC_URLS: Readonly<Record<ProviderStatusView['id'], string>> = {
	claude: 'https://platform.claude.com/docs/en/about-claude/models/overview',
	codex: 'https://learn.chatgpt.com/docs/models',
};

/** Reads all six slots out of the one form that was just submitted. */
function readModelSettings(form: EventTarget): ModelSettingsView {
	const value = fieldReader(form);
	const settings = emptyModelSettings();
	for (const providerId of MODEL_PROVIDER_IDS) {
		for (const role of MODEL_ROLE_NAMES) {
			settings[providerId][role] = {
				model: value(`${providerId}-${role}-model`),
				effort: value(`${providerId}-${role}-effort`),
			};
		}
	}
	return settings;
}

function ModelSlotFields({
	providerId,
	role,
	slot,
	catalog,
}: {
	providerId: ProviderStatusView['id'];
	role: ModelRoleName;
	slot: ModelSlotView;
	catalog: SettingsCatalog;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-2 sm:flex-row">
			<label
				className="flex min-w-0 flex-1 flex-col gap-1 text-sm"
				htmlFor={`${providerId}-${role}-model`}
			>
				<span className="font-medium">{catalog.models.roleLabels[role]} — {catalog.models.model}</span>
				<Input
					className="font-mono"
					defaultValue={slot.model}
					id={`${providerId}-${role}-model`}
					name={`${providerId}-${role}-model`}
					placeholder={catalog.models.cliDefault}
				/>
			</label>
			<label
				className="flex min-w-0 flex-1 flex-col gap-1 text-sm"
				htmlFor={`${providerId}-${role}-effort`}
			>
				<span className="font-medium">{catalog.models.roleLabels[role]} — {catalog.models.effort}</span>
				<Input
					className="font-mono"
					defaultValue={slot.effort}
					id={`${providerId}-${role}-effort`}
					name={`${providerId}-${role}-effort`}
					placeholder={catalog.models.cliDefault}
				/>
			</label>
		</div>
	);
}

function ModelProviderFields({
	providerId,
	modelSettings,
	catalog,
}: Pick<AppProps, 'modelSettings'> & {
	providerId: ProviderStatusView['id'];
	catalog: SettingsCatalog;
}): React.ReactElement {
	return (
		<fieldset className="flex flex-col gap-3">
			<legend className="font-medium text-sm">{MODEL_PROVIDER_LABELS[providerId]}</legend>
			<a
				className={TEXT_LINK_CLASS}
				href={MODEL_DOC_URLS[providerId]}
				rel="noreferrer noopener"
				target="_blank"
			>
				{catalog.models.documentation(MODEL_PROVIDER_LABELS[providerId])}
			</a>
			{MODEL_ROLE_NAMES.map((role) => (
				<ModelSlotFields
					catalog={catalog}
					key={role}
					providerId={providerId}
					role={role}
					slot={modelSettings[providerId][role]}
				/>
			))}
		</fieldset>
	);
}

/**
 * The operator's own model choice, one slot per provider and role. Leaving a
 * field empty passes no flag at all, so each CLI keeps deciding exactly as it
 * did before this section existed.
 */
function ModelSettingsPanel({
	modelSettings,
	pending,
	onSaveModelSettings,
	catalog,
}: Pick<AppProps, 'modelSettings' | 'pending' | 'onSaveModelSettings'> & { catalog: SettingsCatalog }): React.ReactElement {
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.models.description}
			open
			title={catalog.models.title}
		>
			<form
				className="flex flex-col gap-6"
				// Re-synced with the server's answer after a save, the only thing that
				// changes this record while the operator is looking at it.
				key={JSON.stringify(modelSettings)}
				onSubmit={(event) => {
					event.preventDefault();
					onSaveModelSettings(readModelSettings(event.currentTarget));
				}}
			>
				{MODEL_PROVIDER_IDS.map((providerId) => (
					<ModelProviderFields
						catalog={catalog}
						key={providerId}
						modelSettings={modelSettings}
						providerId={providerId}
					/>
				))}
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.models.save}
				</button>
			</form>
		</ContextPanel>
	);
}

/**
 * The switch that lets the runtime start the next admissible issue by itself
 * once a run ends in `done` (GSHIP-638). It creates no new authority: it only
 * starts what the operator already approved, and it never approves, reviews
 * or promotes anything on its own. Off by default, because autonomy never
 * turns itself on. A stopped queue is reported in the shell header instead of
 * here (GSHIP-650): it is a state that asks for attention, not configuration.
 */
function ChainRunsPanel({
	chainRuns,
	pending,
	onSetChainRuns,
	catalog,
}: Pick<AppProps, 'chainRuns' | 'pending' | 'onSetChainRuns'> & { catalog: SettingsCatalog }): React.ReactElement {
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.chain.description}
			open
			title={catalog.chain.title}
		>
			<label className="flex items-center gap-2 text-sm">
				<input
					checked={chainRuns.enabled}
					disabled={pending}
					onChange={(event) =>
						onSetChainRuns((event.currentTarget as unknown as { checked: boolean }).checked)}
					type="checkbox"
				/>
				<span className="font-medium">{catalog.chain.label}</span>
			</label>
		</ContextPanel>
	);
}

/**
 * The executor handoff opt-in (GSHIP-722): off by default, same shape as
 * `ChainRunsPanel`. Turning it on lets a run transfer only its executor role
 * to the other provider, once, when the primary reports a subscription usage
 * limit or a rate limit while implementing.
 */
function ExecutorHandoffPanel({
	executorHandoff,
	pending,
	onSetExecutorHandoff,
	catalog,
}: Pick<AppProps, 'executorHandoff' | 'pending' | 'onSetExecutorHandoff'> & { catalog: SettingsCatalog }): React.ReactElement {
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.executorHandoff.description}
			open
			title={catalog.executorHandoff.title}
		>
			<label className="flex items-center gap-2 text-sm">
				<input
					checked={executorHandoff.enabled}
					disabled={pending}
					onChange={(event) =>
						onSetExecutorHandoff((event.currentTarget as unknown as { checked: boolean }).checked)}
					type="checkbox"
				/>
				<span className="font-medium">{catalog.executorHandoff.label}</span>
			</label>
		</ContextPanel>
	);
}

function SelfUpdatePanel({
	selfUpdate,
	pending,
	onSetSelfUpdate,
	catalog,
	locale,
}: Pick<AppProps, 'selfUpdate' | 'pending' | 'onSetSelfUpdate'> & { catalog: SettingsCatalog; locale: Locale }): React.ReactElement {
	const unavailable = selfUpdate.availability.kind !== 'native';
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.updates.description}
			title={catalog.updates.title}
		>
			<label className="flex items-center gap-2 text-sm">
				<input
					checked={selfUpdate.enabled}
					disabled={pending || unavailable || selfUpdate.applying}
					onChange={(event) => onSetSelfUpdate(
						(event.currentTarget as unknown as { checked: boolean }).checked,
					)}
					type="checkbox"
				/>
				<span className="font-medium">{catalog.updates.label}</span>
			</label>
			<p className="text-muted-foreground text-xs">
				{catalog.updates.guidance}
			</p>
			{unavailable ? (
				<p className="text-muted-foreground text-sm">{selfUpdate.availability.reason}</p>
			) : null}
			{selfUpdate.available !== null ? (
				<p className="text-sm">{catalog.updates.available}: v{selfUpdate.available.version} ({selfUpdate.available.commit})</p>
			) : null}
			{selfUpdate.result !== null ? (
				<div className="flex flex-col gap-1 text-sm">
					<Badge variant={selfUpdate.result.status === 'success' ? 'success' : 'warning'}>
						{catalog.updates.statusLabels[selfUpdate.result.status]}
					</Badge>
					<p>{selfUpdate.result.reason}</p>
					<p className="text-muted-foreground text-xs">
						{catalog.updates.result(selfUpdate.result.previousVersion, selfUpdate.result.targetVersion ?? catalog.updates.unknown, formatUsageTime(selfUpdate.result.at, locale))}
					</p>
				</div>
			) : null}
		</ContextPanel>
	);
}

/**
 * ntfy's own publish docs, and Resend's own API-key and domain-verification
 * pages: DNS verification happens outside Gateship (GSHIP-653), which is the
 * part an operator following this panel actually gets stuck on, so both of
 * Resend's pages are linked, not just the key page.
 */
const NOTIFICATION_CHANNEL_DOCS: Readonly<Record<NotificationChannelId, ReadonlyArray<{ label: 'ntfy' | 'resendApiKeys' | 'resendDomain'; href: string }>>> = {
	ntfy: [{ label: 'ntfy', href: 'https://docs.ntfy.sh/publish/' }],
	resend: [
		{ label: 'resendApiKeys', href: 'https://resend.com/api-keys' },
		{ label: 'resendDomain', href: 'https://resend.com/domains' },
	],
};

/** Setup instructions text, the one part of the row that differs enough per channel to branch on directly. */
const NOTIFICATION_INSTRUCTION_VALUES: Readonly<Record<string, string>> = {
	file: '', url: 'GATESHIP_NTFY_URL', key: 'GATESHIP_RESEND_API_KEY', from: 'GATESHIP_RESEND_FROM', to: 'GATESHIP_RESEND_TO',
};

function NotificationChannelInstructions({ channelId, catalog }: { channelId: NotificationChannelId; catalog: SettingsCatalog }): React.ReactElement {
	const values: Readonly<Record<string, string>> = { ...NOTIFICATION_INSTRUCTION_VALUES, file: channelId === 'resend' ? 'GATESHIP_HOME/.gship/resend-api-key' : 'GATESHIP_HOME/.gship/ntfy-url' };
	return <>{catalog.notifications.instructions[channelId].split(/(\{(?:file|url|key|from|to)\})/).map((part) => {
		const key = part.startsWith('{') ? part.slice(1, -1) : null;
		return key === null ? part : <code className="break-all" key={key}>{values[key]}</code>;
	})}</>;
}

/**
 * One remote channel's status, test button and setup instructions (GSHIP-652,
 * GSHIP-653). Never renders a secret, or any field that could carry one --
 * `channel.configured` is a boolean, `channel.missing` names only which
 * values are absent, and the instructions name files and env vars, not
 * values.
 */
function NotificationChannelRow({
	channelId,
	channel,
	pending,
	onSendNotificationTest,
	onSaveResendSettings,
	onRemoveResendCredential,
	catalog,
}: {
	channelId: NotificationChannelId;
	channel: NotificationChannelView;
	pending: boolean;
	onSendNotificationTest: (channelId: NotificationChannelId) => void;
	onSaveResendSettings: AppProps['onSaveResendSettings'];
	onRemoveResendCredential: AppProps['onRemoveResendCredential'];
	catalog: SettingsCatalog;
}): React.ReactElement {
	const label = catalog.notifications.channelLabels[channelId];
	const resendForm = channelId === 'resend' ? (
		<form
			className="grid gap-3 sm:grid-cols-2"
			key={JSON.stringify(channel)}
			onSubmit={(event) => {
				event.preventDefault();
				const read = fieldReader(event.currentTarget);
				onSaveResendSettings({ from: read('resend-from'), to: read('resend-to'), apiKey: read('resend-api-key') });
			}}
		>
			{(['from', 'to'] as const).map((field) => (
				<label className="flex flex-col gap-1 text-sm" key={field}>
					<span className="font-medium">
						{catalog.notifications.resendFields[field]}
						{channel.externallyManaged[field] ? ` · ${catalog.notifications.externallyManaged}` : null}
					</span>
					<Input
						defaultValue={channel[field] ?? ''}
						disabled={pending}
						maxLength={512}
						name={`resend-${field}`}
						placeholder={catalog.notifications.resendPlaceholders[field]}
						required
					/>
				</label>
			))}
			<label className="flex flex-col gap-1 text-sm sm:col-span-2">
				<span className="font-medium">
					{catalog.notifications.resendFields.apiKey}
					{channel.externallyManaged.apiKey ? ` · ${catalog.notifications.externallyManaged}` : null}
				</span>
				<Input
					autoComplete="new-password"
					disabled={pending}
					name="resend-api-key"
					placeholder={catalog.notifications.resendPlaceholders.apiKey}
					type="password"
				/>
			</label>
			<p className="text-muted-foreground text-xs sm:col-span-2">
				{channel.fileCredentialExists ? catalog.notifications.fileCredentialPresent : catalog.notifications.fileCredentialAbsent}
			</p>
			<div className="flex flex-wrap gap-2 sm:col-span-2">
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.notifications.saveResend}
				</button>
				<button
					className={cn(BUTTON_CLASS, 'self-end')}
					disabled={pending || !channel.fileCredentialExists}
					onClick={onRemoveResendCredential}
					type="button"
				>
					{catalog.notifications.removeResendCredential}
				</button>
			</div>
		</form>
	) : null;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-3">
				<p className="text-sm">
					{label}: {channel.configured ? catalog.notifications.configured : catalog.notifications.notConfigured}
					{!channel.configured && channel.missing.length > 0 ? catalog.notifications.missing(channel.missing.join(', ')) : null}
				</p>
				<ActionButton
					enabled={channel.configured && !pending}
					label={catalog.notifications.sendTest}
					onClick={() => onSendNotificationTest(channelId)}
				/>
			</div>
			<p className="text-muted-foreground text-sm">
				<NotificationChannelInstructions catalog={catalog} channelId={channelId} />
				{NOTIFICATION_CHANNEL_DOCS[channelId].map((doc, index) => (
					<React.Fragment key={doc.href}>
						{index > 0 ? ' ' : null}
						<a className={TEXT_LINK_CLASS} href={doc.href} rel="noreferrer noopener" target="_blank">
							{catalog.notifications.docLabels[doc.label]}
						</a>
					</React.Fragment>
				))}
			</p>
			{resendForm}
		</div>
	);
}

function NotificationsPanel({
	notificationChannels,
	notificationPermission,
	onEnableNotifications,
	onSendNotificationTest,
	onSaveResendSettings,
	onRemoveResendCredential,
	pending,
	catalog,
}: Pick<
	AppProps,
	'notificationChannels' | 'notificationPermission' | 'onEnableNotifications' | 'onSendNotificationTest' | 'onSaveResendSettings' | 'onRemoveResendCredential' | 'pending'
> & { catalog: SettingsCatalog }): React.ReactElement {
	const actionLabel = catalog.notifications.actionLabels[notificationPermission];
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.notifications.description}
			open
			title={catalog.notifications.title}
		>
			<div className="flex flex-col gap-4">
				<div className="flex items-center justify-between gap-3">
					<p className="text-muted-foreground text-sm">
						{catalog.notifications.permissionStates[notificationPermission]}
					</p>
					<ActionButton
						enabled={notificationPermission === 'default'}
						label={actionLabel}
						onClick={onEnableNotifications}
					/>
				</div>
				<div className="flex flex-col gap-3 border-border border-t pt-4">
					{NOTIFICATION_CHANNEL_IDS.map((channelId) => (
						<NotificationChannelRow
							catalog={catalog}
							channel={notificationChannels[channelId]}
							channelId={channelId}
							key={channelId}
							onSendNotificationTest={onSendNotificationTest}
							onSaveResendSettings={onSaveResendSettings}
							onRemoveResendCredential={onRemoveResendCredential}
							pending={pending}
						/>
					))}
				</div>
			</div>
		</ContextPanel>
	);
}

/**
 * The transcript: one scroll region, announced as a log and reachable by the
 * keyboard, that opens at the newest turn and follows later ones only while the
 * operator stands at the live edge (./live-edge.ts). The empty state lives
 * inside the same region so the region -- and its label -- never moves.
 */
/*
 * The transcript follows the chat-primitive grammar: system entries render as
 * markers (a quiet centered status line between rules), the operator's turns
 * are compact bubbles on the right, and the orchestrator's turns are
 * documents, no bubble, because prose reads better as a page than as a
 * terminal dump. Every header datum (provider, time) speaks mono.
 */
function ChatLog({
	chatMessages,
	catalog,
	locale,
}: Pick<AppProps, 'chatMessages'> & { catalog: ConversationCatalog; locale: Locale }): React.ReactElement {
	const liveEdge = useLiveEdge(chatMessages.at(-1)?.seq ?? null);
	return (
		<section
			{...liveEdge}
			aria-label={catalog.transcriptLabel}
			className="min-h-24 min-w-0 overflow-x-hidden overflow-y-visible rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring xl:flex-1 xl:overflow-y-auto"
		>
			{chatMessages.length === 0 ? (
				<EmptyState>{catalog.emptyStateGuidance}</EmptyState>
			) : (
				<ol className="flex flex-col gap-4">
					{chatMessages.map((message) => {
						if (message.role === 'system') {
							return (
								<li className="flex items-center gap-3 py-0.5 text-muted-foreground text-xs" key={message.seq}>
									<span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />
									<span className="max-w-[75%] whitespace-pre-wrap break-words text-center">
										{message.text}
									</span>
									<span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />
								</li>
							);
						}
						const operator = message.role === 'operator';
						return (
							<li
								className={cn('flex min-w-0 flex-col gap-1', operator && 'items-end')}
								key={message.seq}
							>
								<div className="flex items-baseline gap-2 text-muted-foreground text-xs">
									<span className="font-medium">
										{operator ? catalog.roleLabels.operator : catalog.roleLabels.orchestrator}
									</span>
									<span className="font-mono text-[10px]">{message.providerId}</span>
									<time className="font-mono text-[10px]">
										{formatEventTime(message.createdAt, locale)}
									</time>
								</div>
								{operator ? (
									<p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border bg-secondary px-3.5 py-2.5 text-sm">
										{message.text}
									</p>
								) : (
									<p className="max-w-[92%] whitespace-pre-wrap break-words text-sm leading-relaxed">
										{message.text}
									</p>
								)}
							</li>
						);
					})}
				</ol>
			)}
		</section>
	);
}

/**
 * The expected cost across every orchestrator turn the transcript carries a
 * usage event for (GSHIP-634) -- the same label the run cards use, since the
 * operator pays one subscription for both. A turn that never reported usage
 * contributes nothing and is not counted in the turns it covers; hidden
 * entirely when no turn ever reported one, the same absence-over-zero rule
 * the run cost summary already follows.
 */
function ChatCostSummary({
	chatMessages,
	catalog,
	locale,
}: Pick<AppProps, 'chatMessages' | 'locale'> & {
	catalog: ConversationCatalog;
}): React.ReactElement | null {
	const aggregate = aggregateChatTurnCosts(chatMessages);
	if (aggregate.totalCostUsd === null) return null;
	return (
		<p className="text-muted-foreground text-sm">
			{catalog.costSummary(aggregate.turnCount, formatCostUsd(aggregate.totalCostUsd, locale))}
		</p>
	);
}

/**
 * The run's own question, asked where the operator is already answering. It
 * only exists while the runtime is holding for a decision, and resuming is the
 * one run command that belongs on the conversation surface.
 */
function OperatorAnswer({
	run,
	pending,
	onResume,
	catalog,
}: Pick<AppProps, 'pending' | 'onResume'> & {
	run: RunView | null;
	catalog: ConversationCatalog;
}): React.ReactElement | null {
	if (run === null || run.state !== 'waiting-user') return null;
	return (
		<AttentionCard title={catalog.waitingDecisionPrompt}>
			{run.summary === null ? null : (
				<p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
					{run.summary}
				</p>
			)}
			<form
				className="flex flex-col gap-2"
				key={run.updatedAt}
				onSubmit={(event) => {
					event.preventDefault();
					onResume(fieldReader(event.currentTarget)('operatorGuidance'));
				}}
			>
				<label className="font-medium text-sm" htmlFor="operator-guidance">
					{catalog.response.label}
				</label>
				<Textarea
					disabled={pending}
					id="operator-guidance"
					name="operatorGuidance"
					placeholder={catalog.response.placeholder}
					required
					rows={3}
				/>
				<Button disabled={pending} type="submit" variant="attention">
					{catalog.response.button}
				</Button>
			</form>
		</AttentionCard>
	);
}

/** The last command outcome, announced wherever the command was issued. */
function StatusOutput({ status }: Pick<AppProps, 'status'>): React.ReactElement | null {
	if (status === null) return null;
	return (
		<output aria-live="polite" className="break-words text-muted-foreground text-sm">
			{status}
		</output>
	);
}

/**
 * The primary surface: the durable conversation, whatever the run is asking
 * right now, the last command outcome, and the composer -- in the order the
 * operator reads them, and filling the column on a wide viewport.
 */
export function ConversationColumn({
	run,
	chatMessages,
	status,
	pending,
	onResume,
	onSendMessage,
	locale,
	catalog,
}: Pick<AppProps, 'chatMessages' | 'status' | 'pending' | 'onResume' | 'onSendMessage'> & {
	run: RunView | null;
	locale: Locale;
	catalog: ConversationCatalog;
}): React.ReactElement {
	return (
		<main
			className="flex w-full min-w-0 shrink-0 flex-col p-4 lg:p-6 xl:min-h-0 xl:flex-1 xl:shrink"
			id={MAIN_CONTENT_ID}
			tabIndex={-1}
		>
			<Card className="mx-auto flex w-full max-w-(--content-measure) flex-col xl:min-h-0 xl:flex-1">
				<CardHeader>
					<CardTitle>{catalog.title}</CardTitle>
					<CardDescription>{catalog.description}</CardDescription>
				</CardHeader>
				<CardPanel className="flex flex-col gap-4 xl:min-h-0 xl:flex-1">
					<ChatLog catalog={catalog} chatMessages={chatMessages} locale={locale} />
					<ChatCostSummary catalog={catalog} chatMessages={chatMessages} locale={locale} />
					<OperatorAnswer catalog={catalog} onResume={onResume} pending={pending} run={run} />
					<StatusOutput status={status} />
					<form
						className="flex gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							const form = event.currentTarget as unknown as { reset: () => void };
							const value = fieldReader(event.currentTarget)('message');
							if (value.length > 0) {
								onSendMessage(value);
								form.reset();
							}
						}}
					>
						<label className="sr-only" htmlFor="orchestrator-message">
							{catalog.composer.label}
						</label>
						<Textarea
							className="max-h-40 min-w-0"
							disabled={pending}
							id="orchestrator-message"
							name="message"
							onKeyDown={(event) => {
								if (event.key === 'Enter' && !event.shiftKey) {
									event.preventDefault();
									// Same idiom as the reset() cast below: the root tsconfig
									// checks this file without the DOM lib.
									const field = event.currentTarget as unknown as {
										closest: (selector: string) => { requestSubmit: () => void } | null;
									};
									field.closest('form')?.requestSubmit();
								}
							}}
							placeholder={catalog.composer.placeholder}
							required
							rows={1}
						/>
						<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
							{catalog.composer.button}
						</button>
					</form>
				</CardPanel>
			</Card>
		</main>
	);
}

function BacklogPanel({
	backlog,
	catalog,
	locale,
	selectedIssueId,
	canStart,
	onSelectIssue,
	onStart,
}: Pick<AppProps, 'backlog' | 'selectedIssueId' | 'onSelectIssue' | 'onStart'> & {
	canStart: boolean;
	catalog: WorkCatalog['backlog'];
	locale: Locale;
}): React.ReactElement {
	if (backlog.length === 0) {
		return (
			<Card data-state="empty">
				<CardHeader className="py-3">
					<CardTitle>{catalog.title}</CardTitle>
					<CardDescription>{catalog.description(0, formatCount(0, locale))}</CardDescription>
				</CardHeader>
			</Card>
		);
	}
	return (
		<ContextPanel
			description={catalog.description(backlog.length, formatCount(backlog.length, locale))}
			open
			title={catalog.title}
		>
			<div className="flex flex-col gap-3">
				<ul className="flex flex-col gap-1">
					{backlog.map((issue) => (
						<li key={issue.id}>
							<button
								aria-pressed={issue.id === selectedIssueId}
								className={cn(
									'flex w-full items-baseline gap-3 break-words rounded-lg border border-transparent px-3 py-2 text-left text-sm outline-none',
									'focus-visible:ring-2 focus-visible:ring-ring',
									issue.id === selectedIssueId
										? 'border-border bg-secondary text-foreground'
										: 'hover:bg-muted',
								)}
								onClick={() => onSelectIssue(issue.id)}
								type="button"
							>
								<span className="shrink-0 font-mono text-muted-foreground text-xs">{issue.id}</span>
								<span className="min-w-0 font-medium">{issue.title}</span>
							</button>
						</li>
					))}
				</ul>
				<div className="flex justify-end">
					<Button disabled={!canStart} onClick={onStart} type="button">
						{catalog.start}
					</Button>
				</div>
			</div>
		</ContextPanel>
	);
}

function IssueIntakePanel({
	catalog,
	pending,
	onCreateIssue,
}: Pick<AppProps, 'pending' | 'onCreateIssue'> & { catalog: WorkCatalog }): React.ReactElement {
	return (
		<ContextPanel
			description={catalog.intake.description}
			title={catalog.intake.title}
		>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					const value = fieldReader(event.currentTarget);
					onCreateIssue({
						title: value('title'),
						scope: value('scope'),
						verificationCommand: value('verificationCommand'),
					});
				}}
			>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-title">
					<span className="font-medium">{catalog.form.title}</span>
					<Input id="issue-title" name="title" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-scope">
					<span className="font-medium">{catalog.form.scope}</span>
					<Textarea className="min-h-24" id="issue-scope" name="scope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-command">
					<span className="font-medium">{catalog.form.verificationCommand}</span>
					<Input
						className="font-mono"
						id="issue-command"
						name="verificationCommand"
						placeholder={catalog.form.verificationPlaceholder}
						required
					/>
				</label>
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.intake.create}
				</button>
			</form>
		</ContextPanel>
	);
}

function IssueSpecifyPanel({
	catalog,
	ideas,
	pending,
	onSpecifyIssue,
}: Pick<AppProps, 'ideas' | 'pending' | 'onSpecifyIssue'> & { catalog: WorkCatalog }): React.ReactElement | null {
	if (ideas.length === 0) return null;
	return (
		<ContextPanel
			description={catalog.specification.description}
			title={catalog.specification.title}
		>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					const value = fieldReader(event.currentTarget);
					onSpecifyIssue(value('ideaId'), {
						scope: value('ideaScope'),
						verificationCommand: value('ideaVerificationCommand'),
					});
				}}
			>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-id">
					<span className="font-medium">{catalog.specification.idea}</span>
					<SelectField
						defaultValue={ideas[0]?.id}
						id="idea-id"
						items={ideas.map((idea) => ({ value: idea.id, label: `${idea.id} — ${idea.title}` }))}
						name="ideaId"
						required
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-scope">
					<span className="font-medium">{catalog.form.scope}</span>
					<Textarea className="min-h-24" id="idea-scope" name="ideaScope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-command">
					<span className="font-medium">{catalog.form.verificationCommand}</span>
					<Input
						className="font-mono"
						id="idea-command"
						name="ideaVerificationCommand"
						placeholder={catalog.form.verificationPlaceholder}
						required
					/>
				</label>
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.specification.submit}
				</button>
			</form>
		</ContextPanel>
	);
}

/**
 * The three list fields both records carry, named once: the form edits them as
 * text, the read-only panel prints them, and neither spells the names twice.
 */
const BRIEF_LISTS: readonly {
	name: 'decisions' | 'constraints' | 'openItems';
}[] = [
	{ name: 'decisions' },
	{ name: 'constraints' },
	{ name: 'openItems' },
];

/** One item per line; blank lines are what an operator leaves while typing. */
function briefLines(value: string): string[] {
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * The context the operator owns. It is the authority the orchestrator reads
 * before every turn, so correcting it here is how stale intent gets fixed.
 * A successful write clears the generated handoff below without touching the
 * conversation, runs, or provider sessions.
 */
function ProjectBriefPanel({
	brief,
	pending,
	onSaveBrief,
	catalog,
}: Pick<AppProps, 'brief' | 'pending' | 'onSaveBrief'> & { catalog: SettingsCatalog }): React.ReactElement {
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.brief.description}
			open
			title={catalog.brief.title}
		>
			<form
				className="flex flex-col gap-4"
				// Re-synced with the server's answer after either the editor or an
				// explicitly authorized conversational brief write.
				key={JSON.stringify(brief)}
				onSubmit={(event) => {
					event.preventDefault();
					const value = fieldReader(event.currentTarget);
					onSaveBrief({
						objective: value('objective'),
						decisions: briefLines(value('decisions')),
						constraints: briefLines(value('constraints')),
						openItems: briefLines(value('openItems')),
					});
				}}
			>
				<label className="flex flex-col gap-1 text-sm" htmlFor="brief-objective">
					<span className="font-medium">{catalog.brief.fieldLabels.objective}</span>
					<Textarea
						className="min-h-16"
						defaultValue={brief.objective}
						id="brief-objective"
						name="objective"
					/>
				</label>
				{BRIEF_LISTS.map((field) => (
					<label
						className="flex flex-col gap-1 text-sm"
						htmlFor={`brief-${field.name}`}
						key={field.name}
					>
						<span className="font-medium">{catalog.brief.fieldLabels[field.name]}</span>
						<Textarea
							className="min-h-20"
							defaultValue={brief[field.name].join('\n')}
							id={`brief-${field.name}`}
							name={field.name}
							placeholder={catalog.brief.linePlaceholder}
						/>
					</label>
				))}
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.brief.save}
				</button>
			</form>
		</ContextPanel>
	);
}

/**
 * The same four fields, written by the orchestrator instead of by the operator:
 * observed session state, printed and never edited. It can lag behind what the
 * brief above already says, and when the two disagree the brief is the one that
 * counts -- which is why this panel offers nothing to type into.
 */
function HandoffPanel({ handoff, catalog }: Pick<AppProps, 'handoff'> & { catalog: SettingsCatalog }): React.ReactElement {
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.handoff.description}
			title={catalog.handoff.title}
		>
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">{catalog.handoff.readOnly}</Badge>
					<span className="text-muted-foreground text-sm">
						{catalog.handoff.rewritten}
					</span>
				</div>
				<Separator />
				<div className="flex flex-col gap-1 text-sm">
					<span className="font-medium">{catalog.brief.fieldLabels.objective}</span>
					<p className="whitespace-pre-wrap break-words text-muted-foreground">
						{handoff.objective === '' ? catalog.handoff.nothingRecorded : handoff.objective}
					</p>
				</div>
				{BRIEF_LISTS.map((field) => (
					<div className="flex flex-col gap-1 text-sm" key={field.name}>
						<span className="font-medium">{catalog.brief.fieldLabels[field.name]}</span>
						{handoff[field.name].length === 0 ? (
							<p className="text-muted-foreground">{catalog.handoff.nothingRecorded}</p>
						) : (
							<ul className="flex flex-col gap-1">
								{handoff[field.name].map((item) => (
									<li className="whitespace-pre-wrap break-words text-muted-foreground" key={item}>
										{item}
									</li>
								))}
							</ul>
						)}
					</div>
				))}
			</div>
		</ContextPanel>
	);
}

/**
 * The service is older than the code it reads from, said where the shell
 * already carries global state so it is on every surface and stays there until
 * the restart clears it. It is a statement, not a decision: no button, no
 * dismissal, nothing held back.
 */
function StaleServiceCallout({
	staleService,
}: Pick<AppProps, 'staleService'>): React.ReactElement | null {
	if (staleService === null) return null;
	return (
		<Callout aria-label="Outdated service" title="Restart the service" tone="warning">
			<p className="break-words text-xs">{staleService.detail}</p>
			<code className="break-all text-xs">boot {staleService.bootSha}</code>
			<code className="break-all text-xs">origin/main {staleService.currentSha}</code>
		</Callout>
	);
}

/**
 * No global git author identity is configured, so the first commit a run or a
 * ship attempts would fail with "Author identity unknown" (GSHIP-654). A
 * statement, not a decision: no button, no dismissal. Unlike
 * `StaleServiceCallout`, this never asks for a restart -- derivation happens
 * on the commit path itself the moment a run or a ship actually needs it, so
 * it needs no operator action here at all; this callout is a display of that
 * outcome and clears on the next snapshot a command or a run event triggers,
 * not on a poll, since there is none.
 */
function GitIdentityCallout({
	gitIdentity,
}: Pick<AppProps, 'gitIdentity'>): React.ReactElement | null {
	if (gitIdentity === null) return null;
	return (
		<Callout aria-label="Missing Git identity" title="Missing Git identity" tone="warning">
			<p className="break-words text-xs">{gitIdentity.detail}</p>
		</Callout>
	);
}

/** One line per reason the queue is not advancing on its own (GSHIP-638). */
const CHAIN_PAUSE_LABELS: Readonly<Record<ChainPauseReason, string>> = {
	'chain-disabled': 'the switch is off.',
	'previous-run-not-done': 'the previous run did not finish in done.',
	'no-admissible-issue': 'there is no eligible work left in the backlog.',
	'run-active': 'a run is still active.',
	'chain-start-failed': 'the attempt to start the next run failed.',
};

/**
 * A visible queue outcome only exists while the switch is on. `setChainRuns` writes
 * the setting alone and emits no event (GSHIP-638), so a pause recorded
 * before the operator turned the switch off -- `no-admissible-issue`,
 * `previous-run-not-done`, any reason -- would otherwise survive the turn-off
 * and keep reading "Needs you" with a warning callout on every surface,
 * with nothing to clear it until some future run reaches a terminal state and
 * records a fresh `chain-disabled` pause, which may never happen (GSHIP-650
 * review). `chain-disabled` itself never escalates either, on or off: chaining
 * is off by default (GSHIP-638), so it is the steady state of a default
 * install, not a stopped queue.
 */
function visibleQueuePause(chainRuns: ChainRunsView): ChainRunsView['pause'] {
	if (!chainRuns.enabled) return null;
	const { pause } = chainRuns;
	return pause === null || pause.reason === 'chain-disabled' ? null : pause;
}

/**
 * The queue outcome, named where the operator already looks for run status --
 * not a secondary line inside the chaining switch's own
 * settings panel, next to the toggle that turned it on. A pause whose read
 * could not resolve the issue that stopped it is still shown by its reason
 * alone: never a fabricated link. `pause` is already filtered to reasons that
 * represent a visible outcome -- see `visibleQueuePause`.
 */
function ChainPauseCallout({
	pause,
}: { pause: ChainRunsView['pause'] }): React.ReactElement | null {
	if (pause === null) return null;
	const complete = pause.reason === 'no-admissible-issue';
	const named = pause.issue === undefined
		? CHAIN_PAUSE_LABELS[pause.reason]
		: `${pause.issue.id}: ${pause.issue.title} — ${CHAIN_PAUSE_LABELS[pause.reason]}`;
	return (
		<Callout
			aria-label={complete ? 'Completed run queue' : 'Stopped run queue'}
			title={complete ? 'Queue complete' : 'Queue stopped'}
			tone={complete ? 'success' : 'warning'}
		>
			<p className="break-words text-xs">{named}</p>
		</Callout>
	);
}

function humanVersionOf(version: string): string {
	const buildMetadata = version.indexOf('+');
	return buildMetadata === -1 ? version : version.slice(0, buildMetadata);
}


/**
 * The nav glyphs, from Hugeicons' free set (operator decision, 2026-08-25:
 * hugeicons is the product's icon source), muted beside their labels and
 * held to one 16px slot so rows lane-align.
 */
const NAV_GLYPHS = {
	overview: Grid2X2Icon,
	project: CubeIcon,
	conversation: Message01Icon,
	runs: Activity01Icon,
	work: ListViewIcon,
	settings: Settings01Icon,
	globalSettings: Globe02Icon,
} as const;

function NavGlyph({ name }: { name: keyof typeof NAV_GLYPHS }): React.ReactElement {
	return (
		<HugeiconsIcon
			className="size-4 shrink-0 opacity-70"
			icon={NAV_GLYPHS[name]}
			size={16}
			strokeWidth={2.25}
		/>
	);
}

/*
 * The project switcher (operator decision, 2026-08-31, two-line
 * team-switcher anatomy): the trigger scopes projects only -- the overview
 * is a standing nav item, not a sibling scope -- and the status rides the
 * second line as text, never as a chip beside the name. The acid dot on
 * "Needs you" keeps the sidebar's one acid signal.
 */
const SWITCHER_ITEM_CLASS =
	'flex w-full cursor-default select-none items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm outline-none ' +
	'data-highlighted:bg-accent data-highlighted:text-accent-foreground';

function ProjectSwitcher({
	projects,
	selection,
	status,
	catalog,
}: {
	projects: AppProps['projects'];
	selection: ReturnType<typeof routeSelection>;
	status: { label: string; acid: boolean } | null;
	catalog: ShellCatalog;
}): React.ReactElement {
	const selected = projects.find((project) => project.id === selection.projectId) ?? null;
	return (
		<>
		<Menu.Root>
			<Menu.Trigger className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[popup-open]:bg-sidebar-accent">
				<span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg border">
					<NavGlyph name={selected === null ? 'overview' : 'project'} />
				</span>
				<span className="grid min-w-0 flex-1 leading-tight">
					<span className={cn('overflow-hidden text-ellipsis whitespace-nowrap font-medium text-sm', selected === null && 'text-muted-foreground')}>
						{selected?.name ?? catalog.switcherPlaceholder}
					</span>
					{selected === null || status === null ? null : (
						<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
							{status.acid ? <span className="size-1.5 shrink-0 rounded-full bg-attention" /> : null}
							<span className="overflow-hidden text-ellipsis whitespace-nowrap">{status.label}</span>
						</span>
					)}
				</span>
				<HugeiconsIcon className="size-3.5 shrink-0 opacity-70" icon={UnfoldMoreIcon} size={14} strokeWidth={2.25} />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="start" className="z-50" sideOffset={6}>
					<Menu.Popup className="relative min-w-(--anchor-width) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding p-1 text-popover-foreground shadow-lg/5 duration-100 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
						<div className="px-2 pt-1.5 pb-1 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
							{catalog.projectNavigationLabel}
						</div>
						{projects.map((project) => (
							<Menu.Item
								className={SWITCHER_ITEM_CLASS}
								key={project.id}
								render={<a href={`/projects/${encodeURIComponent(project.id)}`} />}
							>
								<NavGlyph name="project" />
								<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
									{project.name}
								</span>
								{project.id === selection.projectId ? (
									<HugeiconsIcon className="size-3.5 shrink-0" icon={Tick02Icon} size={14} strokeWidth={2.25} />
								) : null}
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
		{/* The registry as plain links (sr-only): a portal never reaches the
		 * static render, so without this nav the closed menu would drop
		 * every registry link from the no-JS document and from keyboard
		 * reach before hydration. */}
		<nav aria-label={catalog.projectNavigationLabel} className="sr-only">
			<ul>
				{projects.map((project) => (
					<li key={project.id}>
						<a href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</a>
					</li>
				))}
			</ul>
		</nav>
		</>
	);
}

function ShellNavigation({
	catalog,
	projects,
	selection,
	status,
}: {
	catalog: ShellCatalog;
	projects: AppProps['projects'];
	selection: ReturnType<typeof routeSelection>;
	status: { label: string; acid: boolean } | null;
}): React.ReactElement {
	/* The overview is a standing destination, never a scope the switcher can
	 * hold: it stays one click away from every project. The project surfaces
	 * follow with no group label -- the switcher above already names the
	 * scope (operator decision, 2026-08-31). */
	return <>
		<ProjectSwitcher
			catalog={catalog}
			projects={projects}
			selection={selection}
			status={status}
		/>
		<nav aria-label={catalog.operatorNavigationLabel}>
			<ul className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap lg:gap-0.5">
				<li className="shrink-0">
					<a
						aria-current={selection.surface === 'overview' ? 'page' : undefined}
						className={cn(
							NAV_LINK_CLASS,
							selection.surface === 'overview' && 'bg-sidebar-accent text-sidebar-accent-foreground',
						)}
						href="/overview"
					>
						<NavGlyph name="overview" /><span>{catalog.routeLabels.overview}</span>
					</a>
				</li>
				{selection.projectId === null ? null : SURFACES.map((surface) => (
					<li className="shrink-0" key={surface.surface}>
						<a
							aria-current={surface.surface === selection.surface ? 'page' : undefined}
							className={cn(
								NAV_LINK_CLASS,
								surface.surface === selection.surface && 'bg-sidebar-accent text-sidebar-accent-foreground',
							)}
							href={`/projects/${encodeURIComponent(selection.projectId ?? '')}${surface.suffix}`}
						>
							<NavGlyph name={surface.surface} /><span>{catalog.routeLabels[surface.label]}</span>
						</a>
					</li>
				))}
				<li className="shrink-0 lg:hidden">
					<a
						aria-current={selection.surface === 'global-settings' ? 'page' : undefined}
						className={cn(
							NAV_LINK_CLASS,
							selection.surface === 'global-settings' && 'bg-sidebar-accent text-sidebar-accent-foreground',
						)}
						href="/settings"
					>
						<NavGlyph name="globalSettings" /><span>{catalog.routeLabels.globalSettings}</span>
					</a>
				</li>
			</ul>
		</nav>
	</>;
}

/*
 * The root tsconfig checks this file without the DOM lib (browser types are
 * scoped to webui's own config), so the browser surface this screen touches
 * is named here, the same idiom notifications.ts uses.
 */
interface PanelRuntime {
	localStorage?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
	addEventListener?: (type: 'keydown', listener: (event: PanelKeyEvent) => void) => void;
	removeEventListener?: (type: 'keydown', listener: (event: PanelKeyEvent) => void) => void;
	matchMedia?: (query: string) => { matches: boolean };
	document?: { documentElement: { classList: { toggle: (name: string, force: boolean) => void } } };
}

interface PanelKeyEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	preventDefault: () => void;
}

function panelRuntime(): PanelRuntime {
	return globalThis as unknown as PanelRuntime;
}

/**
 * Collapse state for the two side panels, persisted per browser. Reading is
 * guarded so static rendering (tests) sees the expanded default; writing
 * happens only on a real toggle, in a real browser.
 */
function useStoredOpen(key: string): [boolean, () => void] {
	const [open, setOpen] = useState(() => panelRuntime().localStorage?.getItem(key) !== 'closed');
	const toggle = useCallback(() => {
		setOpen((previous) => {
			panelRuntime().localStorage?.setItem(key, previous ? 'closed' : 'open');
			return !previous;
		});
	}, [key]);
	return [open, toggle];
}

/**
 * The shell's persistent preferences, one row at the top right of the
 * content area (operator decision, 2026-08-25, replacing the segmented
 * pills at the sidebar's foot): language, theme and content measure, each a
 * single outline button whose face names the state it switches TO. Theme
 * and measure store an explicit choice that main.tsx re-applies at boot.
 */
function ShellControls({
	locale,
	onSelectLocale,
	catalog,
	sidebarOpen,
	onToggleSidebar,
}: Pick<AppProps, 'locale' | 'onSelectLocale'> & {
	catalog: ShellCatalog;
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
}): React.ReactElement {
	const [dark, setDark] = useState(() => {
		const runtime = panelRuntime();
		const stored = runtime.localStorage?.getItem('gship-theme') ?? null;
		if (stored !== null) return stored === 'dark';
		return runtime.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
	});
	const [wide, setWide] = useState(
		() => panelRuntime().localStorage?.getItem('gship-width') === 'wide',
	);
	const toggleTheme = (): void => {
		const next = !dark;
		const runtime = panelRuntime();
		runtime.localStorage?.setItem('gship-theme', next ? 'dark' : 'light');
		runtime.document?.documentElement.classList.toggle('dark', next);
		setDark(next);
	};
	const toggleWidth = (): void => {
		const next = !wide;
		const runtime = panelRuntime();
		runtime.localStorage?.setItem('gship-width', next ? 'wide' : 'centered');
		runtime.document?.documentElement.classList.toggle('gship-wide', next);
		setWide(next);
	};
	const targetLocale = locale === 'en-US' ? 'pt-BR' : 'en-US';
	return (
		<div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 lg:px-6">
			{/* The sidebar toggle lives in the content area, not the sidebar
			 * (operator decision, 2026-08-25): a panel glyph whose side bar is
			 * wide while the sidebar is open and narrow while it is collapsed. */}
			<Button
				aria-label={sidebarOpen ? catalog.sidebarToggle.collapse : catalog.sidebarToggle.expand}
				onClick={onToggleSidebar}
				size="icon"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={sidebarOpen ? SidebarLeftIcon : SidebarLeft01Icon}
					size={14}
					strokeWidth={3}
				/>
			</Button>
			<div aria-label={catalog.languageLabel} className="flex items-center gap-2" role="group">
			<Button
				aria-label={targetLocale === 'pt-BR' ? 'Português (Brasil)' : 'English (US)'}
				id="gateship-locale"
				onClick={() => onSelectLocale(targetLocale)}
				size="icon"
				type="button"
				variant="outline"
			>
				<span className="font-mono text-xs">{targetLocale === 'pt-BR' ? 'PT' : 'EN'}</span>
			</Button>
			<Button
				aria-label={dark ? catalog.themeToggle.light : catalog.themeToggle.dark}
				onClick={toggleTheme}
				size="icon"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={dark ? Sun02Icon : Moon02Icon}
					size={14}
					strokeWidth={3}
				/>
			</Button>
			<Button
				aria-label={wide ? catalog.widthToggle.compact : catalog.widthToggle.wide}
				onClick={toggleWidth}
				size="icon"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={wide ? ArrowShrink01Icon : ArrowExpand01Icon}
					size={14}
					strokeWidth={3}
				/>
			</Button>
			</div>
		</div>
	);
}

/* The sidebar's group label: mono, tiny, quiet (dashboard-01's anatomy). */
/* A chevron pointing where the panel will go; the label carries the meaning. */
function PanelChevron({ direction }: { direction: 'left' | 'right' }): React.ReactElement {
	return (
		<HugeiconsIcon
			className="size-3.5"
			icon={direction === 'left' ? ArrowLeft01Icon : ArrowRight01Icon}
			size={14}
			strokeWidth={3}
		/>
	);
}

/**
 * Run state, preserved workspaces and the callouts all describe the selected
 * project, whose own scoped snapshot is what this document loaded
 * (GSHIP-707). A queue pause is the one exception: run chaining is the boot
 * runtime's switch, so it is only ever stated for the current project.
 */
function shellAttention(
	selected: RegisteredProjectView | null,
	chainRuns: ChainRunsView,
	run: RunView | null,
	workspaceNotices: AppProps['workspaceNotices'],
): { operational: boolean; queuePause: ChainRunsView['pause']; attention: OperatorAttention } {
	const operational = selected !== null && (selected.current || selected.readiness === 'ready');
	const queuePause = selected?.current === true ? visibleQueuePause(chainRuns) : null;
	const stoppedQueue = queuePause !== null && queuePause.reason !== 'no-admissible-issue';
	return {
		operational,
		queuePause,
		attention: attentionOf(operational ? run : null, operational ? workspaceNotices : [], stoppedQueue),
	};
}

/**
 * The collapsed shell: the mark, the attention signal if any, and the way
 * back. Everything else waits behind the toggle (or Cmd/Ctrl+B).
 */
function ShellRail({ needsYou }: { needsYou: boolean }): React.ReactElement {
	/* pt-6 at lg matches the expanded sidebar's own p-6 (operator decision,
	 * 2026-08-25): the mark shares the same vertical anchor collapsed and
	 * expanded, so toggling reads as a width change, not the logo jumping. */
	return (
		<header className="flex shrink-0 items-center gap-3 p-4 lg:h-full lg:w-18 lg:flex-col lg:items-center lg:pt-8">
			<GateshipMark className="size-6 translate-x-px" portal />
			{needsYou ? <span aria-hidden="true" className="size-2 rounded-full bg-attention" /> : null}
		</header>
	);
}

function ShellSidebar({
	chainRuns,
	gitIdentity,
	locale,
	runInspectorCatalog,
	route,
	projects,
	run,
	staleService,
	version,
	workspaceNotices,
	open,
}: Pick<AppProps, 'chainRuns' | 'gitIdentity' | 'locale' | 'projects' | 'staleService' | 'workspaceNotices'> & {
	runInspectorCatalog: RunInspectorCatalog;
	route: OperatorRoute;
	run: RunView | null;
	version: string;
	open: boolean;
}): React.ReactElement {
	// The header answers one question -- is Gateship waiting on the operator --
	// so it carries the human state alone. The run's own state stays on the
	// card. A stopped chain queue (GSHIP-650) answers it too, the same way a
	// preserved workspace already does -- but only while the switch is on and
	// something else stopped it, never for the switch simply being off.
	const catalog = LOCALE_CATALOG[locale].shell;
	const currentId = projects.find((project) => project.current)?.id ?? null;
	const selection = routeSelection(route, currentId);
	const selected = projects.find((project) => project.id === selection.projectId) ?? null;
	const { operational, queuePause, attention } = shellAttention(
		selected,
		chainRuns,
		run,
		workspaceNotices,
	);
	const humanVersion = humanVersionOf(version);
	if (!open) {
		return <ShellRail needsYou={operational && attention === 'Needs you'} />;
	}
	/* The shell chrome deepens its own --sidebar one step (operator decision,
	 * 2026-08-25): the body canvas keeps the global token, so the sidebar
	 * separates from the content by fill, not only by its hairline border.
	 * @theme inline makes bg-sidebar read the var in cascade, so the
	 * element-level override is all it takes. */
	return (
		<header className="flex shrink-0 flex-col gap-2 px-3 pt-3 lg:h-full lg:w-64 lg:gap-4 lg:overflow-y-auto lg:p-6 lg:pt-8">
			<h1 className="flex items-center gap-2">
				<span aria-hidden="true">
					<GateshipMark className="size-6 translate-x-px" portal />
				</span>
				<GateshipWordmark className="block aspect-[10187/2750] h-5 w-auto" />
			</h1>
			<ShellNavigation
				catalog={catalog}
				projects={projects}
				selection={selection}
				/* "Needs you" is the navigation's one acid point (design-system.md 1). */
				status={operational ? { label: runInspectorCatalog.attentionLabels[attention], acid: attention === 'Needs you' } : null}
			/>
			<div className="hidden lg:contents">
				<ChainPauseCallout pause={queuePause} />
				{operational ? <StaleServiceCallout staleService={staleService} /> : null}
				{operational ? <GitIdentityCallout gitIdentity={gitIdentity} /> : null}
			</div>
			<nav aria-label={catalog.routeLabels.globalSettings} className="hidden lg:mt-auto lg:block">
				<a
					aria-current={selection.surface === 'global-settings' ? 'page' : undefined}
					className={cn(NAV_LINK_CLASS, selection.surface === 'global-settings' && 'bg-sidebar-accent text-sidebar-accent-foreground')}
					href="/settings"
				>
					<NavGlyph name="globalSettings" /><span className="min-w-0 overflow-hidden text-ellipsis">{catalog.routeLabels.globalSettings}</span>
				</a>
			</nav>
			{version === '' ? null : (
				<span className="hidden px-3 font-mono text-[10px] text-sidebar-foreground/50 uppercase tracking-wider lg:inline">v{humanVersion}</span>
			)}
		</header>
	);
}

/**
 * The one onboarding write the overview offers: an absolute path to a checkout
 * the operator already has. No file picker, no clone and no new repository --
 * the service reads local Git metadata and refuses anything not ready.
 */
function RegisterProjectPanel({
	catalog,
	pending,
	onRegisterProject,
}: Pick<AppProps, 'pending' | 'onRegisterProject'> & {
	catalog: ProjectsCatalog;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.register.title}</CardTitle>
				<CardDescription>{catalog.register.description}</CardDescription>
			</CardHeader>
			<CardPanel>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						const root = fieldReader(event.currentTarget)('project-root');
						if (root !== '') onRegisterProject(root);
					}}
				>
					<label className="flex flex-col gap-1 text-sm" htmlFor="project-root">
						<span className="font-medium">{catalog.register.rootLabel}</span>
						<Input
							id="project-root"
							name="project-root"
							placeholder={catalog.register.rootPlaceholder}
						/>
						<span className="text-muted-foreground text-xs">{catalog.register.rootGuidance}</span>
						<span className="text-muted-foreground text-xs">{catalog.register.containerGuidance}</span>
					</label>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
						{catalog.register.submit}
					</button>
				</form>
			</CardPanel>
		</Card>
	);
}

/**
 * The other onboarding write the overview offers: a GitHub repository, not a
 * path. Gateship owns the destination, the clone and the credential -- the
 * operator only ever names the repository, using their existing GitHub login.
 */
function ImportProjectPanel({
	catalog,
	pending,
	projectOnboardingPending,
	onImportProject,
}: Pick<AppProps, 'pending' | 'projectOnboardingPending' | 'onImportProject'> & {
	catalog: ProjectsCatalog;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.import.title}</CardTitle>
				<CardDescription>{catalog.import.description}</CardDescription>
			</CardHeader>
			<CardPanel>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						const repository = fieldReader(event.currentTarget)('project-import-repository');
						if (repository !== '') onImportProject(repository);
					}}
				>
					<label className="flex flex-col gap-1 text-sm" htmlFor="project-import-repository">
						<span className="font-medium">{catalog.import.repositoryLabel}</span>
						<Input
							id="project-import-repository"
							name="project-import-repository"
							placeholder={catalog.import.repositoryPlaceholder}
						/>
						<span className="text-muted-foreground text-xs">{catalog.import.destinationGuidance}</span>
						<span className="text-muted-foreground text-xs">{catalog.import.credentialGuidance}</span>
					</label>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
						{catalog.import.submit}
					</button>
					{projectOnboardingPending === 'import'
						? <p className="text-muted-foreground text-xs" role="status">{catalog.import.pending}</p>
						: null}
				</form>
			</CardPanel>
		</Card>
	);
}

/** New-repository onboarding is intentionally separate from importing or registering. */
function CreateProjectPanel({
	catalog,
	pending,
	projectOnboardingPending,
	onCreateProject,
}: Pick<AppProps, 'pending' | 'projectOnboardingPending' | 'onCreateProject'> & {
	catalog: ProjectsCatalog;
}): React.ReactElement {
	const [repository, setRepository] = useState('');
	const [description, setDescription] = useState('');
	const [visibility, setVisibility] = useState<'private' | 'public'>('private');
	const [confirmed, setConfirmed] = useState(false);
	const namedRepository = repository.trim();
	const visibilityLabel = visibility === 'private'
		? catalog.create.privateLabel.toLocaleLowerCase()
		: catalog.create.publicLabel.toLocaleLowerCase();
	const authorization = catalog.create.confirm(namedRepository, visibilityLabel);
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.create.title}</CardTitle>
				<CardDescription>{catalog.create.description}</CardDescription>
			</CardHeader>
			<CardPanel>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (namedRepository === '' || !confirmed) return;
						onCreateProject({
							repository: namedRepository,
							visibility,
							...(description.trim() === '' ? {} : { description: description.trim() }),
							authorization,
						});
					}}
				>
					<label className="flex flex-col gap-1 text-sm" htmlFor="project-create-repository">
						<span className="font-medium">{catalog.create.repositoryLabel}</span>
						<Input
							id="project-create-repository"
							name="project-create-repository"
							onChange={(event) => {
								setRepository((event.currentTarget as unknown as { value: string }).value);
								setConfirmed(false);
							}}
							placeholder={catalog.create.repositoryPlaceholder}
							value={repository}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm" htmlFor="project-create-description">
						<span className="font-medium">{catalog.create.descriptionLabel}</span>
						<Input
							id="project-create-description"
							maxLength={350}
							name="project-create-description"
							onChange={(event) =>
								setDescription((event.currentTarget as unknown as { value: string }).value)}
							placeholder={catalog.create.descriptionPlaceholder}
							value={description}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm" htmlFor="project-create-visibility">
						<span className="font-medium">{catalog.create.visibilityLabel}</span>
						<SelectField
							id="project-create-visibility"
							items={[
								{ value: 'private', label: catalog.create.privateLabel },
								{ value: 'public', label: catalog.create.publicLabel },
							]}
							name="project-create-visibility"
							onValueChange={(value) => {
								setVisibility(value as 'private' | 'public');
								setConfirmed(false);
							}}
							value={visibility}
						/>
					</label>
					{visibility === 'public' ? (
						<p className="text-destructive text-sm" role="alert">{catalog.create.publicWarning}</p>
					) : null}
					<p className="text-muted-foreground text-xs">{catalog.create.destinationGuidance}</p>
					<p className="text-muted-foreground text-xs">{catalog.create.credentialGuidance}</p>
					<label className="flex items-start gap-2 text-sm">
						<input
							checked={confirmed}
							disabled={pending || namedRepository === ''}
							name="project-create-confirm"
							onChange={(event) =>
								setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)}
							type="checkbox"
						/>
						<span>{authorization}</span>
					</label>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending || !confirmed || namedRepository === ''} type="submit">
						{catalog.create.submit}
					</button>
					{projectOnboardingPending === 'create'
						? <p className="text-muted-foreground text-xs" role="status">{catalog.create.pending}</p>
						: null}
				</form>
			</CardPanel>
		</Card>
	);
}

/**
 * Removing a project is a registry write and nothing else, so the copy says
 * exactly that and the explicit confirmation is the same checkbox gate the
 * approve and abandon actions already use -- no second dialog, no new
 * confirmation surface.
 */
function UnregisterProjectPanel({
	catalog,
	pending,
	project,
	onUnregisterProject,
}: Pick<AppProps, 'pending' | 'onUnregisterProject'> & {
	catalog: ProjectsCatalog;
	project: RegisteredProjectView;
}): React.ReactElement {
	const [confirmed, setConfirmed] = useState(false);
	return (
		<Card>
			<CardHeader>
				<CardTitle>{catalog.remove.title}</CardTitle>
				<CardDescription>{catalog.remove.description}</CardDescription>
			</CardHeader>
			<CardPanel className="flex flex-col gap-3">
				<p className="text-muted-foreground text-sm">{catalog.remove.filesRemain}</p>
				<label className="flex items-start gap-2 text-sm">
					<input
						checked={confirmed}
						disabled={pending}
						name="project-unregister-confirm"
						onChange={(event) =>
							setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)}
						type="checkbox"
					/>
					<span>{catalog.remove.confirm(project.name)}</span>
				</label>
				<button
					className={cn(BUTTON_CLASS, 'self-end')}
					disabled={pending || !confirmed}
					onClick={() => {
						setConfirmed(false);
						onUnregisterProject(project.id);
					}}
					type="button"
				>
					{catalog.remove.submit}
				</button>
			</CardPanel>
		</Card>
	);
}

type OverviewCardEntry =
	| { project: RegisteredProjectView; snapshot: false }
	| (ProjectOverviewView & { snapshot: true });

/* One fact of a project tile: quiet label left, value right. */
function OverviewFact({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-right">{children}</dd>
		</div>
	);
}

const READINESS_TONE: Readonly<Record<RegisteredProjectView['readiness'], BadgeVariant>> = {
	ready: 'success',
	empty: 'secondary',
	'needs-attention': 'warning',
};

const OUTCOME_TONE: Readonly<Record<string, BadgeVariant>> = {
	shipped: 'success',
	failed: 'error',
	cancelled: 'secondary',
	incomplete: 'warning',
};

function OverviewOperationalFacts({ entry, catalog, locale }: { entry: ProjectOverviewView; catalog: OverviewCatalog; locale: Locale }): React.ReactElement {
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

function OverviewProjectDetails({ entry, catalog, projectCatalog, locale }: { entry: OverviewCardEntry; catalog: OverviewCatalog; projectCatalog: ProjectsCatalog; locale: Locale }): React.ReactElement {
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

function OverviewProjectCard({ entry, catalog, projectCatalog, locale }: { entry: OverviewCardEntry; catalog: OverviewCatalog; projectCatalog: ProjectsCatalog; locale: Locale }): React.ReactElement {
	const project = entry.project;
	return <li className="min-w-0"><Card><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle><a className={TITLE_LINK_CLASS} href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</a></CardTitle>{project.current ? <Badge variant="info">{projectCatalog.currentBadge}</Badge> : null}</div><CardDescription className="break-all font-mono text-xs">{project.repository ?? projectCatalog.repositoryUnknown}</CardDescription></CardHeader><CardPanel><dl className="flex flex-col gap-1.5 text-sm"><OverviewProjectDetails entry={entry} catalog={catalog} projectCatalog={projectCatalog} locale={locale} /></dl></CardPanel></Card></li>;
}

function OverviewProjectCards({ props, overview, catalog, projectCatalog }: { props: AppProps; overview: ProjectOperationalOverviewView | null; catalog: OverviewCatalog; projectCatalog: ProjectsCatalog }): React.ReactElement | null {
	if (overview === null && props.overviewLoading) return null;
	const entries: OverviewCardEntry[] = overview === null ? props.projects.map((project) => ({ project, snapshot: false })) : overview.projects.map((entry) => ({ ...entry, snapshot: true }));
	return <ul className="card-ring-group grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">{entries.map((entry) => <OverviewProjectCard key={entry.project.id} entry={entry} catalog={catalog} projectCatalog={projectCatalog} locale={props.locale} />)}</ul>;
}

function OverviewData({ props, overview, catalog, attention, activeProjects }: { props: AppProps; overview: ProjectOperationalOverviewView; catalog: OverviewCatalog; attention: number; activeProjects: number }): React.ReactElement {
	const historical = overview.overview;
	const completed = historical.totalRuns - historical.activeRuns;
	return <>
		{/*
		 * The bento's hero answers "what needs me?" first. It is the one tile
		 * allowed to go acid, and only while something actually waits; a zero
		 * stays as quiet as every other number.
		 */}
		<div className="card-ring-group grid gap-4 sm:grid-cols-2 xl:grid-cols-7">
			<Stat
				className={cn(
					'xl:col-span-2',
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
		</div>
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

function OverviewSurface(props: AppProps): React.ReactElement {
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
			{/* One title, one description: the middle line duplicated the main
			 * region's own label and diluted the page header. */}
			<div>
				<h2 className="font-semibold text-xl tracking-tight">{projectCatalog.title}</h2>
				<p className="mt-1 text-muted-foreground text-sm">{catalog.description}</p>
			</div>
			{props.overviewLoading && overview === null ? <p role="status">{catalog.loading}</p> : null}
			{overview === null && props.overviewError !== null && props.overviewError !== undefined ? <Card><CardPanel><p role="alert">{catalog.error}</p><p className="text-muted-foreground text-xs">{props.overviewError}</p></CardPanel></Card> : null}
			{(overview === null || overview.projects.length === 0) && !props.overviewLoading && !props.overviewError && props.projects.length === 0 ? <Card><CardPanel><EmptyState>{catalog.empty}</EmptyState></CardPanel></Card> : null}
			{props.overviewError ? <p className="text-warning-foreground text-sm" role="alert">{catalog.error}: {props.overviewError}</p> : null}
			{overview === null || overview.projects.length === 0 ? null : <OverviewData props={props} overview={overview} catalog={catalog} attention={attention} activeProjects={activeProjects} />}
			<OverviewProjectCards props={props} overview={overview} catalog={catalog} projectCatalog={projectCatalog} />
			<CreateProjectPanel
				catalog={projectCatalog}
				onCreateProject={props.onCreateProject}
				pending={props.pending}
				projectOnboardingPending={props.projectOnboardingPending}
			/>
			<div className="grid gap-6 md:grid-cols-2">
				<ImportProjectPanel
					catalog={projectCatalog}
					onImportProject={props.onImportProject}
					pending={props.pending}
					projectOnboardingPending={props.projectOnboardingPending}
				/>
				<RegisterProjectPanel
					catalog={projectCatalog}
					onRegisterProject={props.onRegisterProject}
					pending={props.pending}
				/>
			</div>
		</SurfaceColumn>
	);
}

function UnavailableProjectSurface({
	project,
	locale,
	pending,
	status,
	onUnregisterProject,
}: Pick<AppProps, 'pending' | 'onUnregisterProject'> & {
	project: RegisteredProjectView;
	locale: Locale;
	status: string | null;
}): React.ReactElement {
	const catalog = LOCALE_CATALOG[locale].projects;
	return (
		<SurfaceColumn label={project.name} status={status}>
			<Card>
				<CardHeader>
					<CardTitle>{project.name}</CardTitle>
					<CardDescription>{project.repository ?? catalog.repositoryUnknown}</CardDescription>
				</CardHeader>
				<CardPanel>
					<Badge variant={project.readiness === 'ready' ? 'success' : 'warning'}>{catalog.readiness[project.readiness]}</Badge>
					<h2 className="font-semibold text-lg">{catalog.unavailableTitle}</h2>
					<p className="text-muted-foreground text-sm">{catalog.unavailableDescription}</p>
				</CardPanel>
			</Card>
			<UnregisterProjectPanel
				catalog={catalog}
				onUnregisterProject={onUnregisterProject}
				pending={pending}
				project={project}
			/>
		</SurfaceColumn>
	);
}

function HomeSurface(props: AppProps & { projectId: string }): React.ReactElement {
	const run = props.runs[0] ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const [inspectorOpen, toggleInspector] = useStoredOpen('gship-inspector');
	if (!inspectorOpen) {
		return (
			<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden" data-slot="conversation-layout">
				<ConversationColumn
					catalog={localeCatalog.conversation}
					chatMessages={props.chatMessages}
					locale={props.locale}
					onResume={props.onResume}
					onSendMessage={props.onSendMessage}
					pending={props.pending}
					run={run}
					status={props.status}
				/>
				<aside
					aria-label={localeCatalog.runInspector.homeAccessibleLabel}
					className="flex shrink-0 items-start justify-end p-3 xl:w-12 xl:justify-center xl:border-l xl:pt-4"
					data-slot="run-inspector"
				>
					<Button
						aria-label={localeCatalog.shell.inspectorToggle.expand}
						onClick={toggleInspector}
						size="icon"
						type="button"
						variant="ghost"
					>
						<PanelChevron direction="left" />
					</Button>
				</aside>
			</div>
		);
	}
	return (
		<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden" data-slot="conversation-layout">
			<ConversationColumn
				catalog={localeCatalog.conversation}
				chatMessages={props.chatMessages}
				locale={props.locale}
				onResume={props.onResume}
				onSendMessage={props.onSendMessage}
				pending={props.pending}
				run={run}
				status={props.status}
			/>
			<aside
				aria-label={localeCatalog.runInspector.homeAccessibleLabel}
				className="flex w-full min-w-0 flex-col gap-6 p-4 pt-0 lg:p-6 lg:pt-0 xl:w-96 xl:shrink-0 xl:overflow-y-auto xl:border-l xl:pt-6"
				data-slot="run-inspector"
			>
				<div className="-mb-4 flex justify-end">
					<Button
						aria-label={localeCatalog.shell.inspectorToggle.collapse}
						onClick={toggleInspector}
						size="icon"
						type="button"
						variant="ghost"
					>
						<PanelChevron direction="right" />
					</Button>
				</div>
				<RunCard
					catalog={localeCatalog.runInspector}
					footer={
						<a className={TEXT_LINK_CLASS} href={`/projects/${encodeURIComponent(props.projectId)}/runs`}>
							{localeCatalog.runInspector.viewDetailsLabel}
						</a>
					}
					locale={props.locale}
					onAbandon={props.onAbandon}
					onCancel={props.onCancel}
					onResume={props.onResume}
					onShip={props.onShip}
					pending={props.pending}
					run={run}
					title={localeCatalog.runInspector.currentRunTitle}
				/>
			</aside>
		</div>
	);
}

function RunsSurface(props: AppProps): React.ReactElement {
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

function draftChanged(draft: IssueReviewDraft, scope: string, command: string): boolean {
	return scope !== draft.scope || command !== draft.verificationCommand;
}

/** The editable contract of one draft: its revision, its approval, and its abandonment. */
function IssueReviewForm({
	catalog,
	draft,
	pending,
	onReviewIssue,
	onApproveIssue,
	onAbandonIssue,
}: Pick<AppProps, 'pending' | 'onReviewIssue' | 'onApproveIssue' | 'onAbandonIssue'> & {
	catalog: WorkCatalog;
	draft: IssueReviewDraft;
}): React.ReactElement {
	const [scope, setScope] = useState(draft.scope);
	const [verificationCommand, setVerificationCommand] = useState(draft.verificationCommand);
	const [confirmed, setConfirmed] = useState(false);
	const [abandonReason, setAbandonReason] = useState('');
	const [abandonConfirmed, setAbandonConfirmed] = useState(false);

	const dirty = draftChanged(draft, scope, verificationCommand);

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				setConfirmed(false);
				onReviewIssue(draft.id, {
					scope: scope.trim(),
					verificationCommand: verificationCommand.trim(),
					evidence: draft.evidence,
				});
			}}
		>
			<div><Badge variant={draft.state === 'approved' ? 'success' : draft.state === 'stale' ? 'warning' : 'outline'}>{catalog.review.stateLabels[draft.state]}</Badge></div>
			<label className="flex flex-col gap-1 text-sm" htmlFor="review-scope">
				<span className="font-medium">{catalog.form.scope}</span>
				<Textarea className="min-h-24" id="review-scope" onChange={(event) => setScope((event.currentTarget as unknown as { value: string }).value)} required value={scope} />
			</label>
			<label className="flex flex-col gap-1 text-sm" htmlFor="review-command">
				<span className="font-medium">{catalog.form.verificationCommand}</span>
				<Input className="font-mono" id="review-command" onChange={(event) => setVerificationCommand((event.currentTarget as unknown as { value: string }).value)} required value={verificationCommand} />
			</label>
			{draft.evidence === undefined || draft.evidence.length === 0 ? null : (
				<div className="flex flex-col gap-2 text-sm">
					<span className="font-medium">{catalog.review.evidence}</span>
					<ul className="flex flex-col gap-2">
						{draft.evidence.map((item, index) => (
							<li className="flex flex-col gap-1" key={index}>
								<code className="break-all text-xs">{item.command}</code>
								<p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.output}</p>
							</li>
						))}
					</ul>
				</div>
			)}
			<button className={cn(BUTTON_CLASS, 'self-end')} disabled={pending || !dirty} type="submit">{catalog.review.saveRevision}</button>
			<label className="flex items-start gap-2 text-sm">
				<input checked={confirmed} disabled={pending || dirty} onChange={(event) => setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>{catalog.review.confirmPersisted}</span>
			</label>
			<button
				className={cn(PRIMARY_BUTTON_CLASS, 'self-end')}
				disabled={pending || dirty || !confirmed}
				onClick={() => { setConfirmed(false); onApproveIssue(draft.id); }}
				type="button"
			>{catalog.review.approve}</button>
			<label className="flex flex-col gap-1 text-sm" htmlFor="abandon-reason">
				<span className="font-medium">{catalog.review.abandonReason}</span>
				<Textarea className="min-h-20" id="abandon-reason" onChange={(event) => setAbandonReason((event.currentTarget as unknown as { value: string }).value)} value={abandonReason} />
			</label>
			<label className="flex items-start gap-2 text-sm">
				<input checked={abandonConfirmed} disabled={pending || abandonReason.trim().length === 0} onChange={(event) => setAbandonConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>{catalog.review.confirmAbandon(draft.id)}</span>
			</label>
			<button
				className={cn(BUTTON_CLASS, 'self-end')}
				disabled={pending || abandonReason.trim().length === 0 || !abandonConfirmed}
				onClick={() => {
					setAbandonConfirmed(false);
					onAbandonIssue(draft.id, abandonReason.trim());
				}}
				type="button"
			>{catalog.review.abandon}</button>
		</form>
	);
}

function IssueReviewPanel({
	catalog,
	drafts,
	locale,
	pending,
	runs,
	onReviewIssue,
	onApproveIssue,
	onAbandonIssue,
}: Pick<
	AppProps,
	'drafts' | 'locale' | 'pending' | 'runs' | 'onReviewIssue' | 'onApproveIssue' | 'onAbandonIssue'
> & { catalog: WorkCatalog }): React.ReactElement {
	const [selectedId, setSelectedId] = useState<string | null>(drafts[0]?.id ?? null);
	const selected = drafts.find((draft) => draft.id === selectedId) ?? null;
	// The run owns the issue file while it is in flight: revising, approving or
	// abandoning it would write on main what the ship closes on the run's branch.
	const ownedByRun = selected !== null && activeRunIssueId(runs) === selected.id;

	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.review.title}</CardTitle>
				<CardDescription>{catalog.review.description(drafts.length, formatCount(drafts.length, locale))}</CardDescription>
				<CardAction><Badge variant="secondary">{formatCount(drafts.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				<label className="flex flex-col gap-1 text-sm" htmlFor="review-issue">
					<span className="font-medium">{catalog.review.draft}</span>
					<SelectField
						id="review-issue"
						items={[
							{ value: '', label: catalog.review.selectDraft },
							...drafts.map((draft) => ({ value: draft.id, label: `${draft.id} — ${draft.title}` })),
						]}
						onValueChange={(value) => setSelectedId(value === '' ? null : value)}
						value={selectedId ?? ''}
					/>
				</label>
				{selected === null || !ownedByRun ? null : (
					<p className="text-muted-foreground text-sm">
						{catalog.review.ownedByRun(selected.id)}
					</p>
				)}
				{selected === null || ownedByRun ? null : (
					<IssueReviewForm
						catalog={catalog}
						draft={selected}
						key={JSON.stringify([selected.id, selected.scope, selected.verificationCommand])}
						onAbandonIssue={onAbandonIssue}
						onApproveIssue={onApproveIssue}
						onReviewIssue={onReviewIssue}
						pending={pending}
					/>
				)}
			</CardPanel>
		</CardDisclosure>
	);
}

function diagnosticFindingLocation(finding: DiagnosticFindingView): string {
	if (finding.line === undefined) return finding.file;
	return `${finding.file}:${finding.line}${finding.column === undefined ? '' : `:${finding.column}`}`;
}

function diagnosticSeverityVariant(severity: DiagnosticFindingView['severity']): BadgeVariant {
	if (severity === 'error') return 'error';
	if (severity === 'warning') return 'warning';
	return 'info';
}

function diagnosticScanVariant(
	state: NonNullable<DiagnosticsView['scan']>['state'],
): BadgeVariant {
	if (state === 'completed') return 'success';
	if (state === 'failed') return 'error';
	if (state === 'queued' || state === 'running') return 'info';
	return 'secondary';
}

function DiagnosticScanSummary({
	catalog,
	scan,
}: Pick<DiagnosticsView, 'scan'> & { catalog: WorkCatalog['diagnostics'] }): React.ReactElement | null {
	if (scan === null) return null;
	return (
		<div className="flex flex-col gap-1 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={diagnosticScanVariant(scan.state)}>{catalog.scanStateLabels[scan.state]}</Badge>
				{scan.sourceSha === null ? null : <code className="text-xs">{scan.sourceSha.slice(0, 12)}</code>}
				{scan.state === 'completed' && !scan.coverageComplete ? <Badge variant="warning">{catalog.partial}</Badge> : null}
			</div>
			{scan.error === null ? null : <p className="text-destructive-foreground">{scan.error}</p>}
		</div>
	);
}

function DiagnosticFindingCard({
	catalog,
	finding,
	locale,
	pending,
	onDismiss,
	onPromote,
}: {
	finding: DiagnosticFindingView;
	catalog: WorkCatalog;
	locale: Locale;
	pending: boolean;
	onDismiss: AppProps['onDismissDiagnosticFinding'];
	onPromote: AppProps['onPromoteDiagnosticFinding'];
}): React.ReactElement {
	return (
		<details className="rounded-lg border border-border p-4 text-sm">
			<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
				<Badge variant={diagnosticSeverityVariant(finding.severity)}>{catalog.diagnostics.severityLabels[finding.severity]}</Badge>
				<span className="font-semibold">{finding.rule}</span>
				{finding.occurrenceCount > 1 ? <Badge variant="outline">{catalog.diagnostics.occurrences(formatCount(finding.occurrenceCount, locale))}</Badge> : null}
				<code className="w-full break-all font-mono text-muted-foreground text-xs">{diagnosticFindingLocation(finding)}</code>
			</summary>
			<div className="mt-4 flex flex-col gap-4">
				<p className="whitespace-pre-wrap break-words text-muted-foreground">{finding.evidence}</p>
				<div className="flex flex-wrap items-center justify-between gap-2 font-mono text-muted-foreground text-xs">
					<span>{catalog.diagnostics.toolVersion(finding.toolVersion)}</span>
					<code>{finding.sourceSha.slice(0, 12)}</code>
				</div>
				<div className="flex justify-end">
					<Button disabled={pending} onClick={() => onDismiss(finding.id)} size="sm" type="button" variant="ghost">
						{catalog.diagnostics.dismiss}
					</Button>
				</div>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						const value = fieldReader(event.currentTarget);
						onPromote(finding.id, {
							title: value('diagnosticTitle'),
							scope: value('diagnosticScope'),
							verificationCommand: value('diagnosticVerificationCommand'),
						});
					}}
				>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.title}</span>
						<Input defaultValue={catalog.diagnostics.defaultIssueTitle(finding.rule, finding.file).slice(0, 120)} name="diagnosticTitle" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.scope}</span>
						<Textarea className="min-h-24" name="diagnosticScope" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.verificationCommand}</span>
						<Input className="font-mono" name="diagnosticVerificationCommand" placeholder={catalog.form.verificationPlaceholder} required />
					</label>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">{catalog.form.promote}</button>
				</form>
			</div>
		</details>
	);
}

function PendingDiagnosticFindings({
	catalog,
	findings,
	locale,
	pending,
	onDismiss,
	onPromote,
}: {
	findings: readonly DiagnosticFindingView[];
	catalog: WorkCatalog;
	locale: Locale;
	pending: boolean;
	onDismiss: AppProps['onDismissDiagnosticFinding'];
	onPromote: AppProps['onPromoteDiagnosticFinding'];
}): React.ReactElement {
	if (findings.length === 0) {
		return <EmptyState compact>{catalog.diagnostics.noPending}</EmptyState>;
	}
	return (
		<ul className="flex flex-col gap-3">
			{findings.map((finding) => (
				<li key={finding.id}>
					<DiagnosticFindingCard catalog={catalog} finding={finding} locale={locale} onDismiss={onDismiss} onPromote={onPromote} pending={pending} />
				</li>
			))}
		</ul>
	);
}

function ResolvedDiagnosticFindings({
	catalog,
	findings,
	locale,
	omittedCount,
}: {
	findings: readonly DiagnosticFindingView[];
	catalog: WorkCatalog['diagnostics'];
	locale: Locale;
	omittedCount: number;
}): React.ReactElement {
	return (
		<details className="text-sm">
			<summary className="cursor-pointer text-muted-foreground">{catalog.resolved(formatCount(findings.length, locale))}</summary>
			<ul className="mt-3 flex flex-col gap-2">
				{findings.map((finding) => (
					<li className="flex flex-wrap items-center gap-2" key={finding.id}>
						<Badge variant="secondary">{catalog.statusLabels[finding.status]}</Badge>
						<span>{finding.rule}</span>
						<code className="break-all text-xs text-muted-foreground">{diagnosticFindingLocation(finding)}</code>
						{finding.promotedIssueId === null ? null : <Badge variant="info">{finding.promotedIssueId}</Badge>}
					</li>
				))}
			</ul>
			{omittedCount > 0 ? <p className="mt-2 text-muted-foreground">{catalog.omitted(formatCount(omittedCount, locale))}</p> : null}
		</details>
	);
}

function DiagnosticOutcomeSummary({
	catalog,
	locale,
	stats,
}: Pick<DiagnosticsView, 'stats'> & { catalog: WorkCatalog['diagnostics']; locale: Locale }): React.ReactElement {
	if (stats.total === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				{catalog.noHistory}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1 text-sm">
			<p>
				{catalog.history(
					formatCount(stats.promoted, locale),
					formatCount(stats.dismissed, locale),
					formatCount(stats.cleared, locale),
					formatCount(stats.pending, locale),
				)}
			</p>
			{stats.recurring === 0 ? null : (
				<p className="text-muted-foreground">{catalog.recurring(stats.recurring, formatCount(stats.recurring, locale))}</p>
			)}
			<p className="text-muted-foreground text-xs">
				{catalog.dismissalDisclaimer}
			</p>
		</div>
	);
}

/**
 * One optional, advisory analyzer at a time. The summary stays compact; raw
 * evidence and issue promotion live behind per-finding disclosure.
 */
function DiagnosticsPanel({
	catalog,
	diagnostics,
	locale,
	pending,
	onStartDiagnostic,
	onCancelDiagnostic,
	onDismissDiagnosticFinding,
	onPromoteDiagnosticFinding,
}: Pick<
	AppProps,
	| 'diagnostics'
	| 'pending'
	| 'onStartDiagnostic'
	| 'onCancelDiagnostic'
	| 'onDismissDiagnosticFinding'
	| 'onPromoteDiagnosticFinding'
	| 'locale'
> & { catalog: WorkCatalog }): React.ReactElement {
	const scan = diagnostics.scan;
	const active = scan?.state === 'queued' || scan?.state === 'running';
	const analyzer = diagnostics.analyzers[0];
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.diagnostics.title}</CardTitle>
				<CardDescription>
					{active ? catalog.diagnostics.analyzing : catalog.diagnostics.pendingCount(diagnostics.findings.length, formatCount(diagnostics.findings.length, locale))}
				</CardDescription>
				<CardAction><Badge variant={active ? 'info' : 'secondary'}>{active ? catalog.diagnostics.running : formatCount(diagnostics.findings.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				<div className="flex flex-col gap-2 text-sm">
					<p className="text-muted-foreground">
						{catalog.diagnostics.advisory}
					</p>
					{analyzer === undefined ? null : (
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="outline">{analyzer.label}</Badge>
							<code className="text-xs">v{analyzer.version}</code>
							<span className="text-muted-foreground">
								{analyzer.id === 'react'
									? catalog.diagnostics.analyzerDescriptions.react
									: analyzer.description}
							</span>
						</div>
					)}
				</div>
				<DiagnosticScanSummary catalog={catalog.diagnostics} scan={scan} />
				<div className="flex flex-wrap gap-2">
					{!active && analyzer !== undefined ? (
						<ActionButton
							enabled={!pending}
							label={catalog.diagnostics.runNow}
							onClick={() => onStartDiagnostic(analyzer.id)}
						/>
					) : null}
					{active && scan !== null ? (
						<ActionButton
							enabled={!pending}
							label={catalog.diagnostics.cancel}
							onClick={() => onCancelDiagnostic(scan.id)}
						/>
					) : null}
				</div>
				{diagnostics.workspaceNotices.map((notice) => (
					<p className="text-warning-foreground text-sm" key={notice}>{notice}</p>
				))}
				<DiagnosticOutcomeSummary catalog={catalog.diagnostics} locale={locale} stats={diagnostics.stats} />
				<Separator />
				<PendingDiagnosticFindings
					catalog={catalog}
					findings={diagnostics.findings}
					locale={locale}
					onDismiss={onDismissDiagnosticFinding}
					onPromote={onPromoteDiagnosticFinding}
					pending={pending}
				/>
				<ResolvedDiagnosticFindings
					catalog={catalog.diagnostics}
					findings={diagnostics.resolvedFindings}
					locale={locale}
					omittedCount={diagnostics.resolvedFindingsOmittedCount}
				/>
			</CardPanel>
		</CardDisclosure>
	);
}

/**
 * The inbox of ideas the runs found outside their issue: the evidence exactly
 * as it was captured, and the two decisions it admits. Discarding writes
 * nothing else; promoting files a new task with the contract the operator
 * authors here, pre-filled with the proposal's own title and never approved or
 * started by this screen. A settled proposal leaves the list.
 */
function ProposalsPanel({
	catalog,
	locale,
	proposals,
	pending,
	onDismissProposal,
	onPromoteProposal,
}: Pick<
	AppProps,
	'locale' | 'proposals' | 'pending' | 'onDismissProposal' | 'onPromoteProposal'
> & { catalog: WorkCatalog }): React.ReactElement {
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.proposals.pendingTitle}</CardTitle>
				<CardDescription>{catalog.proposals.pendingCount(proposals.length, formatCount(proposals.length, locale))}</CardDescription>
				<CardAction><Badge variant="secondary">{formatCount(proposals.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				{proposals.length === 0 ? (
					<EmptyState compact>{catalog.proposals.emptyPending}</EmptyState>
				) : (
					<ul className="flex flex-col divide-y divide-border">
						{proposals.map((proposal) => (
							<li className="flex min-w-0 flex-col gap-3 py-5 text-sm first:pt-0 last:pb-0" key={proposal.id}>
								<div className="flex items-start justify-between gap-3">
									<div className="flex min-w-0 flex-col gap-1.5">
										<span className="break-words font-semibold">{proposal.title}</span>
										<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
											<Badge variant="outline">{proposal.sourceIssueId}</Badge>
											<code className="break-all text-xs">{proposal.sourceRunId}</code>
										</div>
									</div>
									<Button
										disabled={pending}
										onClick={() => onDismissProposal(proposal.id)}
										size="sm"
										type="button"
										variant="ghost"
									>
										{catalog.proposals.dismiss}
									</Button>
								</div>
								<p className="whitespace-pre-wrap break-words text-muted-foreground">
									{proposal.evidence}
								</p>
								{/* Forty of these live on one tab: the promote form discloses
								 * per item instead of stacking three fields forty times. */}
								<details>
									<summary className="w-fit cursor-pointer text-muted-foreground text-sm hover:text-foreground">
										{catalog.form.promote}
									</summary>
								<form
									className="mt-3 flex flex-col gap-3"
									onSubmit={(event) => {
										event.preventDefault();
										const value = fieldReader(event.currentTarget);
										onPromoteProposal(proposal.id, {
											title: value('proposalTitle'),
											scope: value('proposalScope'),
											verificationCommand: value('proposalVerificationCommand'),
										});
									}}
								>
									<label
										className="flex flex-col gap-1"
										htmlFor={`proposal-title-${proposal.id}`}
									>
										<span className="font-medium">{catalog.form.title}</span>
										<Input
															defaultValue={proposal.title}
											id={`proposal-title-${proposal.id}`}
											name="proposalTitle"
											required
										/>
									</label>
									<label
										className="flex flex-col gap-1"
										htmlFor={`proposal-scope-${proposal.id}`}
									>
										<span className="font-medium">{catalog.form.scope}</span>
										<Textarea
											className="min-h-24"
											id={`proposal-scope-${proposal.id}`}
											name="proposalScope"
											required
										/>
									</label>
									<label
										className="flex flex-col gap-1"
										htmlFor={`proposal-command-${proposal.id}`}
									>
										<span className="font-medium">{catalog.form.verificationCommand}</span>
										<Input
											className="font-mono"
											id={`proposal-command-${proposal.id}`}
											name="proposalVerificationCommand"
											placeholder={catalog.form.verificationPlaceholder}
											required
										/>
									</label>
									<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
										{catalog.form.promote}
									</button>
								</form>
								</details>
							</li>
						))}
					</ul>
				)}
			</CardPanel>
		</CardDisclosure>
	);
}

/**
 * What a settled proposal became, read-only: a dismissed one stays a
 * discarded idea, a promoted one names the issue it turned into (GSHIP-643).
 * Separate from `ProposalsPanel` above so the pending inbox is never mixed
 * with this historical record, and offers no decision -- no undo, no
 * re-promotion -- only the outcome.
 */
function ResolvedProposalsPanel({
	catalog,
	locale,
	resolvedProposals,
	resolvedProposalsOmittedCount,
}: Pick<AppProps, 'locale' | 'resolvedProposals' | 'resolvedProposalsOmittedCount'> & { catalog: WorkCatalog }): React.ReactElement {
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.proposals.resolvedTitle}</CardTitle>
				<CardDescription>{catalog.proposals.resolvedCount(resolvedProposals.length, formatCount(resolvedProposals.length, locale))}</CardDescription>
				<CardAction><Badge variant="secondary">{formatCount(resolvedProposals.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">{catalog.proposals.readOnly}</Badge>
					<span className="text-muted-foreground text-sm">
						{catalog.proposals.settledNote}
					</span>
				</div>
				<Separator />
				{resolvedProposals.length === 0 ? (
					<EmptyState compact>{catalog.proposals.emptyResolved}</EmptyState>
				) : (
					<ul className="flex flex-col divide-y divide-border">
						{resolvedProposals.map((proposal) => (
							<li className="flex min-w-0 flex-col gap-2 py-4 text-sm first:pt-0 last:pb-0" key={proposal.id}>
								<div className="flex flex-wrap items-center gap-2">
									<span className="break-words font-semibold">{proposal.title}</span>
									{proposal.status === 'promoted' ? (
										<Badge variant="success">{catalog.proposals.statusLabels.promoted}</Badge>
									) : (
										<Badge variant="secondary">{catalog.proposals.statusLabels.dismissed}</Badge>
									)}
								</div>
								<p className="whitespace-pre-wrap break-words text-muted-foreground">
									{proposal.evidence}
								</p>
								<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
									<Badge variant="outline">{proposal.sourceIssueId}</Badge>
									<code className="break-all text-xs">{proposal.sourceRunId}</code>
									{proposal.status === 'promoted' && proposal.promotedIssueId !== null ? (
										<span className="break-words">
											{catalog.proposals.became} <Badge variant="info">{proposal.promotedIssueId}</Badge>
										</span>
									) : null}
								</div>
							</li>
						))}
					</ul>
				)}
				{resolvedProposalsOmittedCount > 0 ? (
					<p className="text-muted-foreground text-sm">
						{catalog.proposals.omitted(resolvedProposalsOmittedCount, formatCount(resolvedProposalsOmittedCount, locale))}
					</p>
				) : null}
			</CardPanel>
		</CardDisclosure>
	);
}

/**
 * Work is four operator questions, one visible at a time (the panels
 * themselves are unchanged from GSHIP-712; only the disclosure is new):
 * what is ready to run (queue), what waits on my approval (the only tab whose
 * count may go acid, because approval is the operator's turn), what is still
 * an idea (specify and intake), and what does the system suggest
 * (diagnostics, boot-runtime-only, and the project-scoped proposal inbox with
 * its resolved history). Panels stay mounted behind their tabs so
 * find-in-page and static rendering keep seeing the whole surface. The
 * surface opens on approval when something actually waits there.
 */
function WorkSurface(props: AppProps): React.ReactElement {
	const actions = actionsFor(props.runs[0] ?? null, props.selectedIssueId !== null);
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const catalog = localeCatalog.work;
	return (
		<SurfaceColumn label={localeCatalog.shell.routeLabels.work} status={props.status}>
			<Tabs defaultValue={props.drafts.length > 0 ? 'approval' : 'queue'}>
				<TabsList aria-label={localeCatalog.shell.routeLabels.work}>
					<TabsTab value="queue">
						{catalog.tabs.queue}
						<TabsCount>{props.backlog.length}</TabsCount>
					</TabsTab>
					<TabsTab value="approval">
						{catalog.tabs.approval}
						<TabsCount attention={props.drafts.length > 0}>{props.drafts.length}</TabsCount>
					</TabsTab>
					<TabsTab value="ideas">
						{catalog.tabs.ideas}
						<TabsCount>{props.ideas.length}</TabsCount>
					</TabsTab>
					<TabsTab value="suggestions">
						{catalog.tabs.suggestions}
						<TabsCount>{props.proposals.length}</TabsCount>
					</TabsTab>
				</TabsList>
				<TabsPanel value="queue">
					<BacklogPanel
						backlog={props.backlog}
						canStart={actions.start && !props.pending}
						catalog={catalog.backlog}
						locale={props.locale}
						onSelectIssue={props.onSelectIssue}
						onStart={props.onStart}
						selectedIssueId={props.selectedIssueId}
					/>
				</TabsPanel>
				<TabsPanel value="approval">
					<IssueReviewPanel catalog={catalog} drafts={props.drafts} locale={props.locale} onAbandonIssue={props.onAbandonIssue} onApproveIssue={props.onApproveIssue} onReviewIssue={props.onReviewIssue} pending={props.pending} runs={props.runs} />
				</TabsPanel>
				<TabsPanel value="ideas">
					<IssueSpecifyPanel
						catalog={catalog}
						ideas={props.ideas}
						onSpecifyIssue={props.onSpecifyIssue}
						pending={props.pending}
					/>
					<IssueIntakePanel catalog={catalog} onCreateIssue={props.onCreateIssue} pending={props.pending} />
				</TabsPanel>
				<TabsPanel value="suggestions">
					<DiagnosticsPanel
						catalog={catalog}
						diagnostics={props.diagnostics}
						locale={props.locale}
						onCancelDiagnostic={props.onCancelDiagnostic}
						onDismissDiagnosticFinding={props.onDismissDiagnosticFinding}
						onPromoteDiagnosticFinding={props.onPromoteDiagnosticFinding}
						onStartDiagnostic={props.onStartDiagnostic}
						pending={props.pending}
					/>
					<ProposalsPanel
						catalog={catalog}
						locale={props.locale}
						onDismissProposal={props.onDismissProposal}
						onPromoteProposal={props.onPromoteProposal}
						pending={props.pending}
						proposals={props.proposals}
					/>
					<ResolvedProposalsPanel
						catalog={catalog}
						locale={props.locale}
						resolvedProposals={props.resolvedProposals}
						resolvedProposalsOmittedCount={props.resolvedProposalsOmittedCount}
					/>
				</TabsPanel>
			</Tabs>
		</SurfaceColumn>
	);
}

function ProjectPanel({ project, catalog }: Pick<AppProps, 'project'> & { catalog: SettingsCatalog }): React.ReactElement {
	const ready = project.state === 'ready';
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.project.description}
			open
			title={catalog.project.title}
		>
			<div className="flex flex-col gap-3 text-sm">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={ready ? 'success' : project.state === 'checking' ? 'secondary' : 'warning'}>
						{ready ? catalog.project.stateLabels.ready : project.state === 'checking' ? catalog.project.stateLabels.checking : catalog.project.stateLabels.attention}
					</Badge>
					<span className="font-medium">{project.name === '' ? catalog.project.localProject : project.name}</span>
				</div>
				{ready ? (
					<dl className="grid gap-2 sm:grid-cols-[8rem_1fr]">
						<dt className="text-muted-foreground">{catalog.project.repository}</dt>
						<dd><code className="break-all">{project.repository}</code></dd>
						<dt className="text-muted-foreground">{catalog.project.runSource}</dt>
						<dd><code className="break-all">{project.sourceRef}</code></dd>
					</dl>
				) : (
					<p className="text-muted-foreground">{project.detail}</p>
				)}
			</div>
		</ContextPanel>
	);
}

function OperatorProfilePanel({
	operatorProfile,
	pending,
	suggestedTimezone,
	onSaveOperatorProfile,
	catalog,
}: Pick<
	AppProps,
	'operatorProfile' | 'pending' | 'suggestedTimezone' | 'onSaveOperatorProfile'
> & { catalog: SettingsCatalog }): React.ReactElement {
	const initialTimezone = operatorProfile.timezone || suggestedTimezone;
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.operator.description}
			open
			title={catalog.operator.title}
		>
			<form
				className="flex flex-col gap-4"
				key={JSON.stringify([operatorProfile, suggestedTimezone])}
				onSubmit={(event) => {
					event.preventDefault();
					const value = fieldReader(event.currentTarget);
					onSaveOperatorProfile({
						name: value('operator-name'),
						timezone: value('operator-timezone'),
					});
				}}
			>
				<label className="flex flex-col gap-1 text-sm" htmlFor="operator-name">
					<span className="font-medium">{catalog.operator.name}</span>
					<Input
						defaultValue={operatorProfile.name}
						id="operator-name"
						name="operator-name"
						placeholder={catalog.operator.namePlaceholder}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="operator-timezone">
					<span className="font-medium">{catalog.operator.timezone}</span>
					<Input
						defaultValue={initialTimezone}
						id="operator-timezone"
						name="operator-timezone"
						placeholder={catalog.operator.timezonePlaceholder}
					/>
					<span className="text-muted-foreground text-xs">
						{catalog.operator.timezoneGuidance}
					</span>
				</label>
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.operator.save}
				</button>
			</form>
		</ContextPanel>
	);
}

function DiagnosticSchedulePanel({
	catalog,
	diagnostics,
	locale,
	pending,
	onSave,
}: {
	catalog: SettingsCatalog;
	diagnostics: DiagnosticsView;
	locale: Locale;
	pending: boolean;
	onSave: AppProps['onSaveDiagnosticSchedule'];
}): React.ReactElement {
	const active = diagnostics.scan?.state === 'queued' || diagnostics.scan?.state === 'running';
	const schedule = diagnostics.schedule;
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.diagnostics.description}
			title={catalog.diagnostics.title}
		>
			<form
				aria-busy={active}
				className="flex flex-col gap-4"
				key={JSON.stringify(schedule)}
				onSubmit={(event) => {
					event.preventDefault();
					const fields = (event.currentTarget as unknown as {
						elements: { namedItem: (name: string) => unknown };
					}).elements;
					const enabled = (fields.namedItem('diagnostic-enabled') as { checked: boolean }).checked;
					const cadence = (fields.namedItem('diagnostic-cadence') as { value: string }).value as DiagnosticCadenceView;
					onSave(enabled, cadence);
				}}
			>
				<label className="flex items-center gap-2 text-sm" htmlFor="diagnostic-enabled">
					<input defaultChecked={schedule.enabled} id="diagnostic-enabled" name="diagnostic-enabled" type="checkbox" />
					<span className="font-medium">{catalog.diagnostics.label}</span>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="diagnostic-cadence">
					<span className="font-medium">{catalog.diagnostics.cadence}</span>
					<SelectField
						defaultValue={schedule.cadence}
						id="diagnostic-cadence"
						items={[
							{ value: 'daily', label: catalog.diagnostics.cadenceLabels.daily },
							{ value: 'weekly', label: catalog.diagnostics.cadenceLabels.weekly },
						]}
						name="diagnostic-cadence"
					/>
				</label>
				<p className="text-muted-foreground text-xs">
					{active
						? catalog.diagnostics.calculating
						: !schedule.enabled
							? catalog.diagnostics.disabled
							: schedule.overdue
								? catalog.diagnostics.overdue
								: schedule.nextRunAt === null
									? catalog.diagnostics.calculating
									: catalog.diagnostics.nextRun(formatRunTimestamp(schedule.nextRunAt, locale))}

				</p>
				<p className="text-muted-foreground text-xs">{catalog.diagnostics.guidance}</p>
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.diagnostics.save}
				</button>
			</form>
		</ContextPanel>
	);
}

const PROJECT_RECOVERY_COMMAND: Readonly<Record<
	Exclude<ProjectStatusView, { state: 'ready' | 'empty' | 'checking' }>['reason'],
	string
>> = {
	'not-repository': 'cd /path/to/project && gship',
	'origin-missing': 'git remote add origin git@github.com:OWNER/REPO.git && git fetch origin main',
	'github-origin-required': 'git remote set-url origin git@github.com:OWNER/REPO.git',
	'origin-main-missing': 'git fetch origin main',
};

function CommandLine({ children }: { children: string }): React.ReactElement {
	return (
		<code className="block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
			{children}
		</code>
	);
}

/**
 * First-run guidance, not a project manager: a browser cannot change the cwd
 * of this process or a container mount, so every path ends by restarting
 * Gateship from the intended local clone.
 */
function OnboardingSurface({
	catalog,
	project,
	settingsHref,
	status,
}: Pick<AppProps, 'project' | 'status'> & { catalog: OnboardingCatalog; settingsHref: string }): React.ReactElement {
	return (
		<SurfaceColumn label={catalog.title} status={status}>
			<Card>
				<CardHeader>
					<CardTitle>{catalog.cardTitle}</CardTitle>
					<CardDescription>{catalog.description}</CardDescription>
				</CardHeader>
				<CardPanel className="flex flex-col gap-5">
					{project.state === 'checking' ? (
						<p className="text-muted-foreground text-sm">{project.detail}</p>
					) : null}
					{project.state === 'empty' ? (
						<>
							<p className="text-muted-foreground text-sm">{project.detail}</p>
							<section className="flex flex-col gap-2">
								<h3 className="font-medium text-sm">{catalog.existingProject.title}</h3>
								<p className="text-muted-foreground text-sm">
									{catalog.existingProject.guidance}
								</p>
								<CommandLine>cd /path/to/project && gship</CommandLine>
							</section>
							<Separator />
							<section className="flex flex-col gap-2">
								<h3 className="font-medium text-sm">{catalog.newProject.title}</h3>
								<p className="text-muted-foreground text-sm">
									{catalog.newProject.guidance}
								</p>
								<CommandLine>gh repo create OWNER/REPO --private --add-readme --clone</CommandLine>
								<CommandLine>cd REPO && gship</CommandLine>
							</section>
						</>
					) : null}
					{project.state === 'needs-attention' ? (
						<>
							<div className="flex flex-col gap-2">
								<Badge variant="warning">{catalog.incompleteBadge}</Badge>
								<p className="text-sm">{project.detail}</p>
							</div>
							<CommandLine>{PROJECT_RECOVERY_COMMAND[project.reason]}</CommandLine>
							<p className="text-muted-foreground text-sm">
								{catalog.recoveryGuidance}
							</p>
						</>
					) : null}
					<p className="text-muted-foreground text-sm">
						{catalog.settingsGuidance.beforeLink}
						<a className={TEXT_LINK_CLASS} href={settingsHref}>
							{catalog.settingsGuidance.linkLabel}
						</a>
						{catalog.settingsGuidance.afterLink}
					</p>
				</CardPanel>
			</Card>
		</SurfaceColumn>
	);
}

/**
 * Settings is three operator questions behind tabs: who executes (providers
 * and their models), how execution behaves (chaining, executor handoff, the
 * diagnostic schedule), and what the project is (binding, brief, session
 * handoff). Panels are unchanged; only the disclosure is new, and every
 * panel stays mounted so find-in-page keeps seeing the whole surface.
 */
function SettingsSurface(props: AppProps & { removePanel?: React.ReactNode }): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].settings;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<Tabs defaultValue="providers">
				<TabsList>
					<TabsTab value="providers">{catalog.tabs.providers}</TabsTab>
					<TabsTab value="execution">{catalog.tabs.execution}</TabsTab>
					<TabsTab value="project">{catalog.tabs.project}</TabsTab>
				</TabsList>
				<TabsPanel value="providers">
					<ProvidersPanel
						catalog={catalog}
						claudeCredentialError={props.claudeCredentialError}
						locale={props.locale}
						onConnectClaudeCredential={props.onConnectClaudeCredential}
						onConnectCodex={props.onConnectCodex}
						onDisconnectClaudeCredential={props.onDisconnectClaudeCredential}
						onDismissClaudeCredentialError={props.onDismissClaudeCredentialError}
						onSelectProvider={props.onSelectProvider}
						pending={props.pending}
						providers={props.providers}
						selectedProvider={props.selectedProvider}
					/>
					<ModelSettingsPanel
						catalog={catalog}
						modelSettings={props.modelSettings}
						onSaveModelSettings={props.onSaveModelSettings}
						pending={props.pending}
					/>
				</TabsPanel>
				<TabsPanel value="execution">
					<ChainRunsPanel
						catalog={catalog}
						chainRuns={props.chainRuns}
						onSetChainRuns={props.onSetChainRuns}
						pending={props.pending}
					/>
					<ExecutorHandoffPanel
						catalog={catalog}
						executorHandoff={props.executorHandoff}
						onSetExecutorHandoff={props.onSetExecutorHandoff}
						pending={props.pending}
					/>
					{props.project.state === 'ready' ? (
						<DiagnosticSchedulePanel
							catalog={catalog}
							diagnostics={props.diagnostics}
							locale={props.locale}
							onSave={props.onSaveDiagnosticSchedule}
							pending={props.pending}
						/>
					) : null}
				</TabsPanel>
				<TabsPanel value="project">
					<ProjectPanel catalog={catalog} project={props.project} />
					<ProjectBriefPanel
						brief={props.brief}
						catalog={catalog}
						onSaveBrief={props.onSaveBrief}
						pending={props.pending}
					/>
					<HandoffPanel catalog={catalog} handoff={props.handoff} />
					{props.removePanel}
				</TabsPanel>
			</Tabs>
		</SurfaceColumn>
	);
}

function GlobalSettingsSurface(props: AppProps): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].settings;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<OperatorProfilePanel
						catalog={catalog}
						onSaveOperatorProfile={props.onSaveOperatorProfile}
						operatorProfile={props.operatorProfile}
						pending={props.pending}
						suggestedTimezone={props.suggestedTimezone}
					/>
					<SelfUpdatePanel
						catalog={catalog}
						locale={props.locale}
						onSetSelfUpdate={props.onSetSelfUpdate}
						pending={props.pending}
						selfUpdate={props.selfUpdate}
					/>
			<NotificationsPanel
						catalog={catalog}
						notificationChannels={props.notificationChannels}
						notificationPermission={props.notificationPermission}
						onEnableNotifications={props.onEnableNotifications}
						onSendNotificationTest={props.onSendNotificationTest}
						onSaveResendSettings={props.onSaveResendSettings}
						onRemoveResendCredential={props.onRemoveResendCredential}
						pending={props.pending}
			/>
		</SurfaceColumn>
	);
}

/**
 * GSHIP-707, GSHIP-712, GSHIP-723: every registered ready project has its own
 * conversation, runs and work surfaces. Settings and the remaining extras stay
 * on the boot project, and a project the registry does not report ready keeps
 * the same typed answer it always had.
 */
function NonCurrentProjectSurface({
	props,
	selectedProject,
	surface,
}: {
	props: AppProps;
	selectedProject: RegisteredProjectView;
	surface: RouteSelection['surface'];
}): React.ReactElement {
	if (selectedProject.readiness === 'ready') {
		if (surface === 'conversation') return <HomeSurface {...props} projectId={selectedProject.id} />;
		if (surface === 'runs') return <RunsSurface {...props} />;
		if (surface === 'work') return <WorkSurface {...props} />;
		if (surface === 'settings') {
			/* The remove card rides inside the Project tab: as a sibling of the
			 * surface it would join the shell's flex row and steal its width. */
			return (
				<SettingsSurface
					{...props}
					removePanel={
						<UnregisterProjectPanel
							catalog={LOCALE_CATALOG[props.locale].projects}
							onUnregisterProject={props.onUnregisterProject}
							pending={props.pending}
							project={selectedProject}
						/>
					}
				/>
			);
		}
	}
	return (
		<UnavailableProjectSurface
			locale={props.locale}
			onUnregisterProject={props.onUnregisterProject}
			pending={props.pending}
			project={selectedProject}
			status={props.status}
		/>
	);
}

function SelectedRouteSurface({
	props,
	selectedProject,
	selection,
}: {
	props: AppProps;
	selectedProject: RegisteredProjectView | null;
	selection: RouteSelection;
}): React.ReactElement {
	const localeCatalog = LOCALE_CATALOG[props.locale];
	return (
		<RouteScreen
			currentProjectReady={props.project.state === 'ready'}
			screens={{
				overview: () => <OverviewSurface {...props} />,
				globalSettings: () => <GlobalSettingsSurface {...props} />,
				notFound: () => (
			<SurfaceColumn label={localeCatalog.projects.notFoundTitle} status={props.status}>
				<h2 className="font-semibold text-xl">{localeCatalog.projects.notFoundTitle}</h2>
				<p className="text-muted-foreground text-sm">{localeCatalog.projects.notFoundDescription}</p>
			</SurfaceColumn>
				),
				nonCurrent: (project, surface) => <NonCurrentProjectSurface
				props={props}
					selectedProject={project}
					surface={surface}
				/>,
				onboarding: (project) => <OnboardingSurface
				catalog={localeCatalog.onboarding}
				project={props.project}
				settingsHref={`/projects/${encodeURIComponent(project.id)}/settings`}
				status={props.status}
				/>,
				conversation: () => <HomeSurface {...props} projectId={selectedProject?.id ?? ''} />,
				runs: () => <RunsSurface {...props} />,
				work: () => <WorkSurface {...props} />,
				settings: () => <SettingsSurface {...props} />,
			}}
			selectedProject={selectedProject}
			selection={selection}
		/>
	);
}

export function App(props: AppProps): React.ReactElement {
	// The array arrives newest first, so the operable run is its head and the
	// history below it is the same array, read once.
	const run = props.runs[0] ?? null;
	const currentProject = props.projects.find((project) => project.current) ?? null;
	const selection = routeSelection(props.route, currentProject?.id ?? null);
	const selectedProject = props.projects.find((project) => project.id === selection.projectId) ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const [sidebarOpen, toggleSidebar] = useStoredOpen('gship-sidebar');
	// The sidebar-07 mechanic: Cmd/Ctrl+B toggles the shell sidebar.
	useEffect(() => {
		const runtime = panelRuntime();
		const onKeyDown = (event: PanelKeyEvent): void => {
			if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				toggleSidebar();
			}
		};
		runtime.addEventListener?.('keydown', onKeyDown);
		return () => runtime.removeEventListener?.('keydown', onKeyDown);
	}, [toggleSidebar]);
	return (
		<AppShell
			controls={(
				<ShellControls
					catalog={localeCatalog.shell}
					locale={props.locale}
					onSelectLocale={props.onSelectLocale}
					onToggleSidebar={toggleSidebar}
					sidebarOpen={sidebarOpen}
				/>
			)}
			sidebar={<ShellSidebar
				chainRuns={props.chainRuns}
				gitIdentity={props.gitIdentity}
				locale={props.locale}
				open={sidebarOpen}
				projects={props.projects}
				runInspectorCatalog={localeCatalog.runInspector}
				route={props.route}
				run={run}
				staleService={props.staleService}
				version={props.version}
				workspaceNotices={props.workspaceNotices}
			/>}
			skipLabel={localeCatalog.shell.skipLinkLabel}
		>
			<SelectedRouteSurface props={props} selectedProject={selectedProject} selection={selection} />
		</AppShell>
	);
}
