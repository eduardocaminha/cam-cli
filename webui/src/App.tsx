// webui/src/App.tsx
//
// The operator screen, as a pure function of its props: an app shell whose
// content is one of four surfaces, chosen by the path the browser is on. Each
// surface carries one operator task -- converse (/), inspect what ran (/runs),
// plan what to run (/work), configure the local machine (/settings) -- so no
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

import React, { useState } from 'react';
import {
	aggregateChatTurnCosts,
	type ChainPauseReason,
	type ChainRunsView,
	type ChatMessageView,
	type DiagnosticCadenceView,
	type DiagnosticFindingView,
	type DiagnosticsView,
	emptyModelSettings,
	type GitIdentityView,
	type IssueReviewDraft,
	MODEL_PROVIDER_IDS,
	MODEL_ROLE_NAMES,
	type ModelRoleName,
	type ModelSettingsView,
	type ModelSlotView,
	NOTIFICATION_CHANNEL_IDS,
	type NotificationChannelId,
	type NotificationChannelsView,
	type NotificationChannelView,
	type OperatorIssueDraft,
	type OperatorProfileView,
	type OperatorSpecDraft,
	type ProjectBriefView,
	type ProjectStatusView,
	type ProposalView,
	type ProviderStatusView,
	type ResolvedProposalView,
	type SelfUpdateView,
	type StaleServiceView,
	type WorkspaceNoticeView,
} from './client.ts';
import { GateshipLockup } from './components/gateship-logo.tsx';
import { Badge, type BadgeVariant } from './components/ui/badge.tsx';
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
import { Separator } from './components/ui/separator.tsx';
import { cn } from './lib/cn.ts';
import { useLiveEdge } from './live-edge.ts';
import {
	type ConversationCatalog,
	DEFAULT_LOCALE,
	LOCALE_CATALOG,
	type Locale,
	type RunInspectorCatalog,
	type RunsOperationalCatalog,
	type RunsWorkflowCatalog,
	type ShellCatalog,
} from './locale.ts';
import type { BrowserNotificationPermission } from './notifications.ts';
import {
	actionsFor,
	activeRunIssueId,
	attentionOf,
	attentionToneOf,
	type PlannableIssue,
	type ProviderUsageView,
	type ProviderUsageWindowView,
	phaseOf,
	progressOf,
	type RunCostRole,
	type RunCostRoleUsage,
	type RunEventView,
	type RunProviderWaitView,
	type RunView,
	summarizeWorkflow,
	summarizeWorkflowCohorts,
	toneOf,
	type WorkflowCohort,
} from './run-view.ts';

/** The four paths the server answers with this document, and nothing else. */
export type OperatorRoute = '/' | '/runs' | '/work' | '/settings';

const MAIN_CONTENT_ID = 'main-content';

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

const SURFACES: readonly { path: OperatorRoute; label: keyof ShellCatalog['routeLabels'] }[] = [
	{ path: '/', label: 'conversation' },
	{ path: '/runs', label: 'runs' },
	{ path: '/work', label: 'work' },
	{ path: '/settings', label: 'settings' },
];

/**
 * Which surface a browser path names. Anything the server does not serve --
 * which the shell's own links can never produce -- reads as the home surface,
 * so the screen has no unreachable state.
 */
export function routeOf(pathname: string): OperatorRoute {
	const normalized = pathname.replace(/\/+$/, '');
	const surface = SURFACES.find((entry) => entry.path === (normalized === '' ? '/' : normalized));
	return surface?.path ?? '/';
}

export interface AppProps {
	/** Which of the four surfaces this document is showing. */
	route: OperatorRoute;
	/** The explicit locale shared by the cataloged shell and conversation surfaces. */
	locale: Locale;
	backlog: readonly PlannableIssue[];
	ideas: readonly PlannableIssue[];
	drafts: readonly IssueReviewDraft[];
	/** Ideas captured by executed runs, still awaiting an operator decision. */
	proposals: readonly ProposalView[];
	/** Ad hoc analyzer state and its human-decided inbox. */
	diagnostics: DiagnosticsView;
	/**
	 * Proposals already settled -- dismissed or promoted -- newest decision
	 * first, plus how many more exist beyond that window (GSHIP-643). Kept
	 * separate from `proposals` above so a historical record never mixes with a
	 * pending decision.
	 */
	resolvedProposals: readonly ResolvedProposalView[];
	resolvedProposalsOmittedCount: number;
	events: readonly RunEventView[];
	workspaceNotices: readonly WorkspaceNoticeView[];
	providers: readonly ProviderStatusView[];
	chatMessages: readonly ChatMessageView[];
	/** The operator's own context, editable here and nowhere else. */
	brief: ProjectBriefView;
	/** Read-only readiness of the cwd this process owns. */
	project: ProjectStatusView;
	/** Human-owned identity and timezone, empty until explicitly saved. */
	operatorProfile: OperatorProfileView;
	/** Browser-derived suggestion; it is never persisted without a save. */
	suggestedTimezone: string;
	/** What the orchestrator recorded about the session; read-only. */
	handoff: ProjectBriefView;
	/** Model and effort per (provider, role); empty text keeps the CLI default. */
	modelSettings: ModelSettingsView;
	/** Off by default: autonomy never turns itself on (GSHIP-638). */
	chainRuns: ChainRunsView;
	selectedProvider: ProviderStatusView['id'];
	notificationPermission: BrowserNotificationPermission;
	/** Whether each remote channel resolved a secret; never the secret itself (GSHIP-652). */
	notificationChannels: NotificationChannelsView;
	selfUpdate: SelfUpdateView;
	/** Newest first, exactly as /api/runs returned it. */
	runs: readonly RunView[];
	selectedIssueId: string | null;
	/** Binary serving this screen, read-only; empty renders nothing. */
	version: string;
	/**
	 * The service is running code older than origin/main. Null is the ordinary
	 * case; while it is set the shell says so, and no command is held back.
	 */
	staleService: StaleServiceView | null;
	/**
	 * No global git author identity is configured yet, so a commit would fail.
	 * Null is the ordinary case; nothing here is ever a restart instruction --
	 * derivation happens on the commit path itself, not here, so this can
	 * still show stale until the next snapshot read, which a command or a run
	 * event triggers rather than a timer.
	 */
	gitIdentity: GitIdentityView | null;
	/** Last command outcome, or the last transport error. */
	status: string | null;
	/** A command is in flight; every button is held until it answers. */
	pending: boolean;
	onSelectIssue: (issueId: string) => void;
	onCreateIssue: (input: OperatorIssueDraft) => void;
	onSpecifyIssue: (issueId: string, input: OperatorSpecDraft) => void;
	onReviewIssue: (issueId: string, input: OperatorSpecDraft) => void;
	onApproveIssue: (issueId: string) => void;
	onAbandonIssue: (issueId: string, reason: string) => void;
	onDismissProposal: (proposalId: string) => void;
	onPromoteProposal: (proposalId: string, input: OperatorIssueDraft) => void;
	onStartDiagnostic: (analyzer: string) => void;
	onCancelDiagnostic: (scanId: string) => void;
	onDismissDiagnosticFinding: (findingId: string) => void;
	onPromoteDiagnosticFinding: (findingId: string, input: OperatorIssueDraft) => void;
	onSaveDiagnosticSchedule: (enabled: boolean, cadence: DiagnosticCadenceView) => void;
	onStart: () => void;
	onResume: (operatorGuidance?: string) => void;
	onAbandon: () => void;
	onCancel: () => void;
	onShip: () => void;
	onConnectCodex: () => void;
	onEnableNotifications: () => void;
	onSendNotificationTest: (channelId: NotificationChannelId) => void;
	onSelectProvider: (providerId: ProviderStatusView['id']) => void;
	onSendMessage: (message: string) => void;
	onSaveBrief: (brief: ProjectBriefView) => void;
	onSaveModelSettings: (settings: ModelSettingsView) => void;
	onSaveOperatorProfile: (profile: OperatorProfileView) => void;
	onSetChainRuns: (enabled: boolean) => void;
	onSetSelfUpdate: (enabled: boolean) => void;
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
function formatCostUsd(value: number, locale: Locale = DEFAULT_LOCALE): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
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
	return origins.executor + origins.decision + origins.indeterminate === 0;
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

const BUTTON_CLASS =
	'inline-flex h-9 items-center justify-center rounded-md border px-3 font-medium text-sm ' +
	'transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
	'disabled:pointer-events-none disabled:opacity-50';

const PRIMARY_BUTTON_CLASS = cn(
	BUTTON_CLASS,
	'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
);

const FIELD_CLASS =
	'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ' +
	'placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

const NAV_LINK_CLASS =
	'block whitespace-nowrap rounded-md px-3 py-2 text-sidebar-foreground text-sm outline-none ' +
	'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ' +
	'focus-visible:ring-2 focus-visible:ring-sidebar-ring';

const TEXT_LINK_CLASS =
	'w-fit rounded-md text-muted-foreground text-sm underline underline-offset-4 outline-none ' +
	'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';

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
		<button className={BUTTON_CLASS} disabled={!enabled} onClick={onClick} type="button">
			{label}
		</button>
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
}: {
	title: string;
	description: string;
	open?: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<CardDisclosure className="group" open={open}>
			<CardSummary>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
				<CardAction aria-hidden="true">
					<span className="text-muted-foreground text-xs group-open:hidden">open</span>
					<span className="hidden text-muted-foreground text-xs group-open:inline">close</span>
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
	if (run === null) return null;
	const visible = events
		.filter((event) => event.runId === run.id && isOperational(event))
		.slice(-30);
	return (
		<ContextPanel
			description={catalog.activity.description(visible.length)}
			open
			title={catalog.activity.title}
		>
			<ol className="flex max-h-80 flex-col gap-3 overflow-x-hidden overflow-y-auto">
				{visible.map((event) => {
					const detail = eventDetail(event, catalog.activity.toolsLabel);
					return (
						<li className="min-w-0 border-border border-l-2 pl-3 text-sm" key={event.seq}>
							<div className="flex items-baseline justify-between gap-3">
								<code className="min-w-0 break-all">{event.kind}</code>
								<time className="shrink-0 text-muted-foreground">
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
		<section
			aria-label={catalog.providerHold.accessibleLabel}
			className="flex flex-col gap-1 rounded-md bg-warning/8 p-3 text-warning-foreground dark:bg-warning/16"
		>
			<span className="font-medium text-sm">
				{catalog.providerHold.title(providerName)}
			</span>
			<p className="text-sm">{catalog.providerHold.waitReasons[wait.kind]}.</p>
			<p className="break-words text-xs">{wait.message}</p>
			{retryText === undefined ? null : (
				<p className="text-xs">
					{catalog.providerHold.retryBefore}
					<time dateTime={wait.retryAt}>{retryText}</time>
					{catalog.providerHold.retryAfter}
				</p>
			)}
		</section>
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
}: Pick<AppProps, 'pending' | 'onResume' | 'onAbandon' | 'onCancel' | 'onShip'> & {
	catalog: RunInspectorCatalog;
	locale: Locale;
	run: RunView | null;
	title: string;
	footer?: React.ReactNode;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription className="break-all">
					{run === null ? catalog.noRunLabel : run.issueId}
				</CardDescription>
				{run === null ? null : (
					<Badge variant={toneOf(run.state)}>{catalog.stateLabels[run.state]}</Badge>
				)}
			</CardHeader>
			{run === null && footer === undefined ? null : (
				<CardPanel className="flex flex-col gap-4">
					{run === null ? null : <RunProgress catalog={catalog} run={run} />}
					{run === null ? null : (
						<ProviderWaitCallout catalog={catalog} locale={locale} wait={run.providerWait} />
					)}
					{run === null || run.cost.totalCostUsd === null ? null : (
						<p className="text-muted-foreground text-sm">
							{catalog.expectedCost(formatCostUsd(run.cost.totalCostUsd, locale))}
						</p>
					)}
					{run === null || hasNoRounds(run.roundOrigins) ? null : (
						<p className="text-muted-foreground text-sm">
							{catalog.correctionRounds(
								run.roundOrigins.executor,
								run.roundOrigins.decision,
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
					{footer}
				</CardPanel>
			)}
		</Card>
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
					<p className="whitespace-pre-wrap break-words rounded-md bg-destructive/8 p-3 text-destructive-foreground text-sm">
						{run.error}
					</p>
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
											<span className="min-w-0 break-all">{entry.model}</span>
											<span className="shrink-0 text-muted-foreground">
												{formatCostUsd(entry.costUsd, locale)}
											</span>
										</div>
										{tokens === null ? null : (
											<span className="text-muted-foreground text-xs">
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
	return (
		<ContextPanel
			description={catalog.previousRuns.description(previous.length)}
			title={catalog.previousRuns.title}
		>
			<ul className="flex flex-col gap-2">
				{previous.map((run) => (
					<li className="flex items-baseline justify-between gap-3 text-sm" key={run.id}>
						<span className="min-w-0 break-all font-medium">{run.issueId}</span>
						<Badge variant={toneOf(run.state)}>{runInspector.stateLabels[run.state]}</Badge>
						{run.cost.totalCostUsd === null ? null : (
							<span className="shrink-0 text-muted-foreground">
								{runInspector.expectedCost(formatCostUsd(run.cost.totalCostUsd, locale))}
							</span>
						)}
						<time className="shrink-0 text-muted-foreground">
							{formatRunTimestamp(run.updatedAt, locale)}
						</time>
					</li>
				))}
			</ul>
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
		+ insights.corrections.decision
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
					insights.corrections.decision,
					insights.corrections.indeterminate,
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
	const roles = configuration.roles.map(({ role, models, efforts }) => {
		const model = models.length === 0 ? catalog.benchmarks.card.modelMissing : models.join(' + ');
		const effort = efforts.length === 0 ? '' : ` (${efforts.join(' + ')})`;
		return `${roleLabels[role]}: ${model}${effort}`;
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
		+ cohort.corrections.decision
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
	'providers' | 'selectedProvider' | 'pending' | 'onConnectCodex' | 'onSelectProvider'
>;

function providerDescription(provider: ProviderStatusView): string {
	if (provider.availability !== undefined) {
		const reason = LOCALE_CATALOG[DEFAULT_LOCALE].runInspector.providerHold.waitReasons[
			provider.availability.kind
		];
		return provider.subscription
			? `Subscription connected, but currently unavailable: ${reason}.`
			: `Currently unavailable: ${reason}.`;
	}
	if (provider.subscription) {
		return `Subscription connected${provider.plan === undefined ? '' : ` · ${provider.plan}`}`;
	}
	return provider.installed ? 'Installed, without a connected subscription' : 'Client not found';
}

/** Friendly labels for Claude's own window names; Codex's primary/secondary fall back to their reported duration. */
const USAGE_WINDOW_LABELS: Readonly<Record<string, string>> = {
	five_hour: '5 hour',
	seven_day: '7 day',
	seven_day_opus: '7 day (Opus)',
	seven_day_sonnet: '7 day (Sonnet)',
	seven_day_overage_included: '7 day (overage)',
	overage: 'Overage',
};

function formatUsageWindowDuration(minutes: number): string {
	if (minutes % 1_440 === 0) return `${minutes / 1_440} day`;
	if (minutes % 60 === 0) return `${minutes / 60} hour`;
	return `${minutes} min`;
}

function usageWindowLabel(window: ProviderUsageWindowView): string {
	const known = USAGE_WINDOW_LABELS[window.window];
	if (known !== undefined) return known;
	return window.windowMinutes === undefined ? window.window : formatUsageWindowDuration(window.windowMinutes);
}

function usageWindowVariant(status: ProviderUsageWindowView['status']): BadgeVariant {
	if (status === 'rejected') return 'error';
	if (status === 'allowed_warning') return 'warning';
	return 'outline';
}

function formatUsageTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
}

/** One window's percentage and reset time, each shown only when the source actually reported it. */
function ProviderUsageWindowRow({ window }: { window: ProviderUsageWindowView }): React.ReactElement {
	return (
		<li className="flex flex-wrap items-center gap-2">
			<span>{usageWindowLabel(window)}</span>
			{window.usedPercent === undefined ? null : (
				<Badge variant={usageWindowVariant(window.status)}>{Math.round(window.usedPercent)}% used</Badge>
			)}
			{window.resetsAt === undefined ? null : (
				<span>resets <time dateTime={window.resetsAt}>{formatUsageTime(window.resetsAt)}</time></span>
			)}
			<span className="text-muted-foreground">
				as of <time dateTime={window.observedAt}>{formatUsageTime(window.observedAt)}</time>
			</span>
		</li>
	);
}

/** Compact progressive detail (GSHIP-664): each piece of the source's telemetry renders only when present, never absent as a fabricated zero. */
function ProviderUsageDetail({ usage }: { usage: ProviderUsageView | undefined }): React.ReactElement | null {
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
					{usage.windows.map((window) => <ProviderUsageWindowRow key={window.window} window={window} />)}
				</ul>
			)}
			{usage.credits === undefined ? null : (
				<p className="text-muted-foreground">
					Credits: {usage.credits.unlimited
						? 'unlimited'
						: usage.credits.hasCredits
							? (usage.credits.balance ?? 'available')
							: 'none'}
				</p>
			)}
			{usage.spendLimit === undefined ? null : (
				<p className="text-muted-foreground">
					Spend limit: {usage.spendLimit.used} of {usage.spendLimit.limit}
					{' '}({usage.spendLimit.remainingPercent}% remaining)
					{usage.spendLimit.resetsAt === undefined ? null : (
						<> · resets <time dateTime={usage.spendLimit.resetsAt}>{formatUsageTime(usage.spendLimit.resetsAt)}</time></>
					)}
				</p>
			)}
			{usage.resetCreditCount === undefined ? null : (
				<p className="text-muted-foreground">{usage.resetCreditCount} reset credit(s) available</p>
			)}
		</div>
	);
}

function ProviderRow({
	provider,
	selectedProvider,
	pending,
	onConnectCodex,
	onSelectProvider,
}: Omit<ProviderPanelProps, 'providers'> & { provider: ProviderStatusView }): React.ReactElement {
	return (
		<li className="flex items-center justify-between gap-3 text-sm">
			<div className="min-w-0">
				<p className="flex flex-wrap items-center gap-2 font-medium">
					{provider.label}
					{provider.id === selectedProvider ? <Badge variant="secondary">in use</Badge> : null}
				</p>
				<p className="break-words text-muted-foreground">{providerDescription(provider)}</p>
				<ProviderUsageDetail usage={provider.usage} />
			</div>
			{provider.id === 'codex' && !provider.subscription && provider.installed ? (
				<ActionButton enabled={!pending} label="Connect ChatGPT" onClick={onConnectCodex} />
			) : null}
			{provider.id === 'claude' && !provider.subscription && provider.installed ? (
				<code className="break-all text-muted-foreground">claude auth login</code>
			) : null}
			{provider.subscription && provider.id !== selectedProvider ? (
				<ActionButton
					enabled={!pending}
					label={`Use ${provider.label}`}
					onClick={() => onSelectProvider(provider.id)}
				/>
			) : null}
		</li>
	);
}

function ProvidersPanel(props: ProviderPanelProps): React.ReactElement {
	return (
		<ContextPanel
			description="Gateship uses subscriptions from installed clients and never receives tokens."
			open
			title="Local agents"
		>
			<ul className="flex flex-col gap-3">
				{props.providers.map((provider) => (
					<ProviderRow
						key={provider.id}
						onConnectCodex={props.onConnectCodex}
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

const MODEL_ROLE_LABELS: Readonly<Record<ModelRoleName, string>> = {
	orchestrator: 'Orchestrator',
	executor: 'Executor',
	reviewer: 'Reviewer',
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
}: {
	providerId: ProviderStatusView['id'];
	role: ModelRoleName;
	slot: ModelSlotView;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-2 sm:flex-row">
			<label
				className="flex min-w-0 flex-1 flex-col gap-1 text-sm"
				htmlFor={`${providerId}-${role}-model`}
			>
				<span className="font-medium">{MODEL_ROLE_LABELS[role]} — model</span>
				<input
					className={cn(FIELD_CLASS, 'font-mono')}
					defaultValue={slot.model}
					id={`${providerId}-${role}-model`}
					name={`${providerId}-${role}-model`}
					placeholder="CLI default"
				/>
			</label>
			<label
				className="flex min-w-0 flex-1 flex-col gap-1 text-sm"
				htmlFor={`${providerId}-${role}-effort`}
			>
				<span className="font-medium">{MODEL_ROLE_LABELS[role]} — effort</span>
				<input
					className={cn(FIELD_CLASS, 'font-mono')}
					defaultValue={slot.effort}
					id={`${providerId}-${role}-effort`}
					name={`${providerId}-${role}-effort`}
					placeholder="CLI default"
				/>
			</label>
		</div>
	);
}

function ModelProviderFields({
	providerId,
	modelSettings,
}: Pick<AppProps, 'modelSettings'> & {
	providerId: ProviderStatusView['id'];
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
				{MODEL_PROVIDER_LABELS[providerId]} models in the official documentation
			</a>
			{MODEL_ROLE_NAMES.map((role) => (
				<ModelSlotFields
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
}: Pick<AppProps, 'modelSettings' | 'pending' | 'onSaveModelSettings'>): React.ReactElement {
	return (
		<ContextPanel
			description={
				'Applies to the next agent started, without restarting the service. ' +
				'An empty field keeps the CLI default. The field is free text: the CLI itself ' +
				'rejects an invalid value with its own error, not Gateship.'
			}
			open
			title="Model and effort by role"
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
						key={providerId}
						modelSettings={modelSettings}
						providerId={providerId}
					/>
				))}
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Save models
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
}: Pick<AppProps, 'chainRuns' | 'pending' | 'onSetChainRuns'>): React.ReactElement {
	return (
		<ContextPanel
			description="When a run finishes in done, starts the next approved issue automatically in ID order."
			open
			title="Automatic run chaining"
		>
			<label className="flex items-center gap-2 text-sm">
				<input
					checked={chainRuns.enabled}
					disabled={pending}
					onChange={(event) =>
						onSetChainRuns((event.currentTarget as unknown as { checked: boolean }).checked)}
					type="checkbox"
				/>
				<span className="font-medium">Chain approved runs automatically</span>
			</label>
		</ContextPanel>
	);
}

function DiagnosticSchedulePanel({
	diagnostics,
	pending,
	onSaveDiagnosticSchedule,
}: Pick<
	AppProps,
	'diagnostics' | 'pending' | 'onSaveDiagnosticSchedule'
>): React.ReactElement {
	const { schedule } = diagnostics;
	return (
		<ContextPanel
			description="Runs at most one overdue diagnostic, and only while this project is idle."
			title="Diagnostic schedule"
		>
			<form
				className="flex flex-col gap-4"
				key={JSON.stringify(schedule)}
				onSubmit={(event) => {
					event.preventDefault();
					const form = event.currentTarget as unknown as {
						elements: { namedItem: (name: string) => { checked?: unknown; value?: unknown } | null };
					};
					const enabled = form.elements.namedItem('diagnostic-schedule-enabled')?.checked === true;
					const cadenceValue = form.elements.namedItem('diagnostic-schedule-cadence')?.value;
					const cadence: DiagnosticCadenceView = cadenceValue === 'daily' ? 'daily' : 'weekly';
					onSaveDiagnosticSchedule(enabled, cadence);
				}}
			>
				<label className="flex items-center gap-2 text-sm">
					<input
						defaultChecked={schedule.enabled}
						disabled={pending}
						name="diagnostic-schedule-enabled"
						type="checkbox"
					/>
					<span className="font-medium">Run diagnostics periodically</span>
				</label>
				<label className="flex max-w-sm flex-col gap-1 text-sm" htmlFor="diagnostic-schedule-cadence">
					<span className="font-medium">Cadence</span>
					<select
						className={FIELD_CLASS}
						defaultValue={schedule.cadence}
						disabled={pending}
						id="diagnostic-schedule-cadence"
						name="diagnostic-schedule-cadence"
					>
						<option value="daily">Daily</option>
						<option value="weekly">Weekly</option>
					</select>
				</label>
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Badge variant="outline">{schedule.analyzer}</Badge>
					{!schedule.enabled ? (
						<span className="text-muted-foreground">Disabled.</span>
					) : schedule.overdue ? (
						<Badge variant="warning">overdue</Badge>
					) : (
						<span className="text-muted-foreground">
							Next run: {schedule.nextRunAt ?? 'calculating'}
						</span>
					)}
				</div>
				<p className="text-muted-foreground text-xs">
					A manual scan also resets the window. Missed periods do not create catch-up runs.
				</p>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Save schedule
				</button>
			</form>
		</ContextPanel>
	);
}

function SelfUpdatePanel({
	selfUpdate,
	pending,
	onSetSelfUpdate,
}: Pick<AppProps, 'selfUpdate' | 'pending' | 'onSetSelfUpdate'>): React.ReactElement {
	const unavailable = selfUpdate.availability.kind !== 'native';
	return (
		<ContextPanel
			description="Checks official releases at most daily and applies a verified native binary only while the project is idle."
			title="Gateship updates"
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
				<span className="font-medium">Install verified native updates automatically</span>
			</label>
			<p className="text-muted-foreground text-xs">
				Fixed cadence: daily. Runs, preserved waiting states, diagnostics, containers, and source checkouts are never updated in place.
			</p>
			{unavailable ? (
				<p className="text-muted-foreground text-sm">{selfUpdate.availability.reason}</p>
			) : null}
			{selfUpdate.available !== null ? (
				<p className="text-sm">Available: v{selfUpdate.available.version} ({selfUpdate.available.commit})</p>
			) : null}
			{selfUpdate.result !== null ? (
				<div className="flex flex-col gap-1 text-sm">
					<Badge variant={selfUpdate.result.status === 'success' ? 'success' : 'warning'}>
						{selfUpdate.result.status}
					</Badge>
					<p>{selfUpdate.result.reason}</p>
					<p className="text-muted-foreground text-xs">
						{selfUpdate.result.previousVersion} → {selfUpdate.result.targetVersion ?? 'unknown'} at {selfUpdate.result.at}
					</p>
				</div>
			) : null}
		</ContextPanel>
	);
}

const NOTIFICATION_CHANNEL_LABELS: Readonly<Record<NotificationChannelId, string>> = {
	ntfy: 'ntfy',
	resend: 'email (Resend)',
};

/**
 * ntfy's own publish docs, and Resend's own API-key and domain-verification
 * pages: DNS verification happens outside Gateship (GSHIP-653), which is the
 * part an operator following this panel actually gets stuck on, so both of
 * Resend's pages are linked, not just the key page.
 */
const NOTIFICATION_CHANNEL_DOCS: Readonly<Record<NotificationChannelId, ReadonlyArray<{ label: string; href: string }>>> = {
	ntfy: [{ label: 'ntfy documentation', href: 'https://docs.ntfy.sh/publish/' }],
	resend: [
		{ label: 'Resend API keys', href: 'https://resend.com/api-keys' },
		{ label: 'Resend domain verification', href: 'https://resend.com/domains' },
	],
};

/** Setup instructions text, the one part of the row that differs enough per channel to branch on directly. */
function NotificationChannelInstructions({ channelId }: { channelId: NotificationChannelId }): React.ReactElement {
	if (channelId === 'resend') {
		return (
			<>
				Save the API key in <code className="break-all">.gship/resend-api-key</code> at the project root
				 with mode 600, or set <code className="break-all">GATESHIP_RESEND_API_KEY</code>, which takes
				 precedence over the file. Also set <code className="break-all">GATESHIP_RESEND_FROM</code>{' '}
				(sender at a verified domain) and <code className="break-all">GATESHIP_RESEND_TO</code>{' '}
				(recipient).{' '}
			</>
		);
	}
	return (
		<>
			Save the topic URL in <code className="break-all">.gship/ntfy-url</code> at the project root with
			 mode 600, or set <code className="break-all">GATESHIP_NTFY_URL</code>, which takes precedence over
			 the file.{' '}
		</>
	);
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
}: {
	channelId: NotificationChannelId;
	channel: NotificationChannelView;
	pending: boolean;
	onSendNotificationTest: (channelId: NotificationChannelId) => void;
}): React.ReactElement {
	const label = NOTIFICATION_CHANNEL_LABELS[channelId];
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-3">
				<p className="text-sm">
					{label}: {channel.configured ? 'configured' : 'not configured'}
					{!channel.configured && channel.missing.length > 0 ? ` (missing: ${channel.missing.join(', ')})` : null}
				</p>
				<ActionButton
					enabled={channel.configured && !pending}
					label="Send test"
					onClick={() => onSendNotificationTest(channelId)}
				/>
			</div>
			<p className="text-muted-foreground text-sm">
				<NotificationChannelInstructions channelId={channelId} />
				{NOTIFICATION_CHANNEL_DOCS[channelId].map((doc, index) => (
					<React.Fragment key={doc.href}>
						{index > 0 ? ' ' : null}
						<a className={TEXT_LINK_CLASS} href={doc.href} rel="noreferrer noopener" target="_blank">
							{doc.label}
						</a>
					</React.Fragment>
				))}
			</p>
		</div>
	);
}

function NotificationsPanel({
	notificationChannels,
	notificationPermission,
	onEnableNotifications,
	onSendNotificationTest,
	pending,
}: Pick<
	AppProps,
	'notificationChannels' | 'notificationPermission' | 'onEnableNotifications' | 'onSendNotificationTest' | 'pending'
>): React.ReactElement {
	const active = notificationPermission === 'granted';
	const unavailable = notificationPermission === 'unsupported';
	const denied = notificationPermission === 'denied';
	const actionLabel = active
		? 'Notifications active'
		: denied
			? 'Notifications blocked'
			: unavailable
				? 'Notifications unavailable'
				: 'Enable notifications';
	return (
		<ContextPanel
			description="The browser alerts you when a run needs you or finishes; remote channels alert you even when the tab is closed."
			open
			title="Notifications"
		>
			<div className="flex flex-col gap-4">
				<div className="flex items-center justify-between gap-3">
					<p className="text-muted-foreground text-sm">
						{active ? 'Active in this browser.' : null}
						{denied ? 'Blocked in this browser\'s permissions.' : null}
						{unavailable ? 'Unavailable in this browser.' : null}
						{notificationPermission === 'default' ? 'Permission not requested yet.' : null}
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
							channel={notificationChannels[channelId]}
							channelId={channelId}
							key={channelId}
							onSendNotificationTest={onSendNotificationTest}
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
function ChatLog({
	chatMessages,
	catalog,
}: Pick<AppProps, 'chatMessages'> & { catalog: ConversationCatalog }): React.ReactElement {
	const liveEdge = useLiveEdge(chatMessages.at(-1)?.seq ?? null);
	return (
		<section
			aria-label={catalog.transcriptLabel}
			className="max-h-[60vh] min-h-24 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring xl:max-h-none"
			onScroll={liveEdge.onScroll}
			ref={liveEdge.ref}
			role="log"
			tabIndex={0}
		>
			{chatMessages.length === 0 ? (
				<p className="flex min-h-24 items-center justify-center text-center text-muted-foreground text-sm">
					{catalog.emptyStateGuidance}
				</p>
			) : (
				<ol className="flex flex-col gap-3">
					{chatMessages.map((message) => (
						<li
							className={cn(
								'rounded-md p-3 text-sm',
								message.role === 'operator' ? 'ml-8 bg-accent' : 'mr-8 bg-muted',
							)}
							key={message.seq}
						>
							<div className="mb-1 flex items-center justify-between gap-3 text-muted-foreground text-xs">
								<span>
									{message.role === 'operator'
										? catalog.roleLabels.operator
										: message.role === 'orchestrator'
											? catalog.roleLabels.orchestrator
											: message.role}
								</span>
								<span className="shrink-0">{message.providerId}</span>
							</div>
							<p className="whitespace-pre-wrap break-words">{message.text}</p>
						</li>
					))}
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
		<section className="flex flex-col gap-2 rounded-md border border-warning/32 bg-warning/8 p-3">
			<p className="font-medium text-sm">{catalog.waitingDecisionPrompt}</p>
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
				<textarea
					className={FIELD_CLASS}
					disabled={pending}
					id="operator-guidance"
					name="operatorGuidance"
					placeholder={catalog.response.placeholder}
					required
					rows={3}
				/>
				<button className={PRIMARY_BUTTON_CLASS} disabled={pending} type="submit">
					{catalog.response.button}
				</button>
			</form>
		</section>
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
			className="flex min-h-0 w-full min-w-0 flex-1 flex-col p-4 lg:p-6"
			id={MAIN_CONTENT_ID}
			tabIndex={-1}
		>
			<Card className="flex min-h-0 flex-1 flex-col">
				<CardHeader>
					<CardTitle>{catalog.title}</CardTitle>
					<CardDescription>{catalog.description}</CardDescription>
				</CardHeader>
				<CardPanel className="flex min-h-0 flex-1 flex-col gap-4">
					<ChatLog catalog={catalog} chatMessages={chatMessages} />
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
						<input
							className={cn(FIELD_CLASS, 'min-w-0')}
							disabled={pending}
							id="orchestrator-message"
							name="message"
							placeholder={catalog.composer.placeholder}
							required
						/>
						<button className={PRIMARY_BUTTON_CLASS} disabled={pending} type="submit">
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
	selectedIssueId,
	canStart,
	onSelectIssue,
	onStart,
}: Pick<AppProps, 'backlog' | 'selectedIssueId' | 'onSelectIssue' | 'onStart'> & {
	canStart: boolean;
}): React.ReactElement {
	return (
		<ContextPanel
			description={`${countLabel(backlog.length, 'admissible issue')} right now.`}
			open
			title="Executable backlog"
		>
			<div className="flex flex-col gap-3">
				<ul className="flex flex-col gap-1">
					{backlog.map((issue) => (
						<li key={issue.id}>
							<button
								aria-pressed={issue.id === selectedIssueId}
								className={cn(
									'w-full break-words rounded-md px-3 py-2 text-left text-sm outline-none',
									'focus-visible:ring-2 focus-visible:ring-ring',
									issue.id === selectedIssueId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
								)}
								onClick={() => onSelectIssue(issue.id)}
								type="button"
							>
								<span className="font-medium">{issue.id}</span>
								<span className="text-muted-foreground"> — {issue.title}</span>
							</button>
						</li>
					))}
				</ul>
				<ActionButton enabled={canStart} label="Start run" onClick={onStart} />
			</div>
		</ContextPanel>
	);
}

function IssueIntakePanel({
	pending,
	onCreateIssue,
}: Pick<AppProps, 'pending' | 'onCreateIssue'>): React.ReactElement {
	return (
		<ContextPanel
			description="Goes directly to the executable backlog; the command is the deterministic gate."
			title="New issue"
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
					<span className="font-medium">Title</span>
					<input className={FIELD_CLASS} id="issue-title" name="title" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-scope">
					<span className="font-medium">Scope and expected outcome</span>
					<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="issue-scope" name="scope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-command">
					<span className="font-medium">Verification command</span>
					<input
						className={cn(FIELD_CLASS, 'font-mono')}
						id="issue-command"
						name="verificationCommand"
						placeholder="bun test"
						required
					/>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Create issue
				</button>
			</form>
		</ContextPanel>
	);
}

function IssueSpecifyPanel({
	ideas,
	pending,
	onSpecifyIssue,
}: Pick<AppProps, 'ideas' | 'pending' | 'onSpecifyIssue'>): React.ReactElement | null {
	if (ideas.length === 0) return null;
	return (
		<ContextPanel
			description="Promotes the idea with the same direct contract, without an intermediate planner."
			title="Specify existing idea"
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
					<span className="font-medium">Idea</span>
					<select className={FIELD_CLASS} id="idea-id" name="ideaId" required>
						{ideas.map((idea) => (
							<option key={idea.id} value={idea.id}>{idea.id} — {idea.title}</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-scope">
					<span className="font-medium">Scope and expected outcome</span>
					<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="idea-scope" name="ideaScope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-command">
					<span className="font-medium">Verification command</span>
					<input
						className={cn(FIELD_CLASS, 'font-mono')}
						id="idea-command"
						name="ideaVerificationCommand"
						placeholder="bun test"
						required
					/>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Specify idea
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
	label: string;
}[] = [
	{ name: 'decisions', label: 'Decisions' },
	{ name: 'constraints', label: 'Constraints' },
	{ name: 'openItems', label: 'Open items' },
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
 * before every turn, so correcting it here is how stale intent gets fixed --
 * without touching the conversation, the runs, or the handoff below it.
 */
function ProjectBriefPanel({
	brief,
	pending,
	onSaveBrief,
}: Pick<AppProps, 'brief' | 'pending' | 'onSaveBrief'>): React.ReactElement {
	return (
		<ContextPanel
			description="Authoritative human context, maintained by you. The orchestrator reads it and never writes it."
			open
			title="Project brief"
		>
			<form
				className="flex flex-col gap-4"
				// Re-synced with the server's answer after a save, which is the only
				// thing that can change a brief while the operator is looking at it.
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
					<span className="font-medium">Objective</span>
					<textarea
						className={cn(FIELD_CLASS, 'min-h-16')}
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
						<span className="font-medium">{field.label}</span>
						<textarea
							className={cn(FIELD_CLASS, 'min-h-20')}
							defaultValue={brief[field.name].join('\n')}
							id={`brief-${field.name}`}
							name={field.name}
							placeholder="One item per line"
						/>
					</label>
				))}
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Save brief
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
function HandoffPanel({ handoff }: Pick<AppProps, 'handoff'>): React.ReactElement {
	return (
		<ContextPanel
			description="Session state observed and generated by the orchestrator. It may be stale; the brief above prevails."
			title="Automatic handoff"
		>
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">read-only</Badge>
					<span className="text-muted-foreground text-sm">
						Rewritten after each orchestrator turn.
					</span>
				</div>
				<Separator />
				<div className="flex flex-col gap-1 text-sm">
					<span className="font-medium">Objective</span>
					<p className="whitespace-pre-wrap break-words text-muted-foreground">
						{handoff.objective === '' ? 'Nothing recorded yet.' : handoff.objective}
					</p>
				</div>
				{BRIEF_LISTS.map((field) => (
					<div className="flex flex-col gap-1 text-sm" key={field.name}>
						<span className="font-medium">{field.label}</span>
						{handoff[field.name].length === 0 ? (
							<p className="text-muted-foreground">Nothing recorded yet.</p>
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
		<section
			aria-label="Outdated service"
			className="flex flex-col gap-1 rounded-md bg-warning/8 p-3 text-warning-foreground dark:bg-warning/16"
		>
			<span className="font-medium text-sm">Restart the service</span>
			<p className="break-words text-xs">{staleService.detail}</p>
			<code className="break-all text-xs">boot {staleService.bootSha}</code>
			<code className="break-all text-xs">origin/main {staleService.currentSha}</code>
		</section>
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
		<section
			aria-label="Missing Git identity"
			className="flex flex-col gap-1 rounded-md bg-warning/8 p-3 text-warning-foreground dark:bg-warning/16"
		>
			<span className="font-medium text-sm">Missing Git identity</span>
			<p className="break-words text-xs">{gitIdentity.detail}</p>
		</section>
	);
}

/** One line per reason the queue is not advancing on its own (GSHIP-638). */
const CHAIN_PAUSE_LABELS: Readonly<Record<ChainPauseReason, string>> = {
	'chain-disabled': 'the switch is off.',
	'previous-run-not-done': 'the previous run did not finish in done.',
	'no-admissible-issue': 'there are no admissible issues in the backlog right now.',
	'run-active': 'a run is still active.',
	'chain-start-failed': 'the attempt to start the next run failed.',
};

/**
 * A stopped queue only exists while the switch is on. `setChainRuns` writes
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
function stoppedQueuePause(chainRuns: ChainRunsView): ChainRunsView['pause'] {
	if (!chainRuns.enabled) return null;
	const { pause } = chainRuns;
	return pause === null || pause.reason === 'chain-disabled' ? null : pause;
}

/**
 * The stopped queue, named where the operator already looks for what needs
 * them (GSHIP-650) -- not a secondary line inside the chaining switch's own
 * settings panel, next to the toggle that turned it on. A pause whose read
 * could not resolve the issue that stopped it is still shown by its reason
 * alone: never a fabricated link. `pause` is already filtered to reasons that
 * represent an actually stopped queue -- see `stoppedQueuePause`.
 */
function ChainPauseCallout({
	pause,
}: { pause: ChainRunsView['pause'] }): React.ReactElement | null {
	if (pause === null) return null;
	const named = pause.issue === undefined
		? CHAIN_PAUSE_LABELS[pause.reason]
		: `${pause.issue.id}: ${pause.issue.title} — ${CHAIN_PAUSE_LABELS[pause.reason]}`;
	return (
		<section
			aria-label="Stopped run queue"
			className="flex flex-col gap-1 rounded-md bg-warning/8 p-3 text-warning-foreground dark:bg-warning/16"
		>
			<span className="font-medium text-sm">Queue stopped</span>
			<p className="break-words text-xs">{named}</p>
		</section>
	);
}

function ShellSidebar({
	chainRuns,
	gitIdentity,
	locale,
	runInspectorCatalog,
	route,
	run,
	staleService,
	version,
	workspaceNotices,
}: Pick<AppProps, 'chainRuns' | 'gitIdentity' | 'locale' | 'staleService' | 'workspaceNotices'> & {
	runInspectorCatalog: RunInspectorCatalog;
	route: OperatorRoute;
	run: RunView | null;
	version: string;
}): React.ReactElement {
	// The header answers one question -- is Gateship waiting on the operator --
	// so it carries the human state alone. The run's own state stays on the
	// card. A stopped chain queue (GSHIP-650) answers it too, the same way a
	// preserved workspace already does -- but only while the switch is on and
	// something else stopped it, never for the switch simply being off.
	const stoppedQueue = stoppedQueuePause(chainRuns);
	const attention = attentionOf(run, workspaceNotices, stoppedQueue !== null);
	const catalog = LOCALE_CATALOG[locale].shell;
	return (
		<header className="flex shrink-0 flex-col gap-4 border-sidebar-border border-b bg-sidebar p-4 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:self-start lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-6">
			<div className="flex flex-col items-start gap-3">
				<div className="flex flex-col gap-1">
					<h1>
						<GateshipLockup className="block aspect-[15665/3068] h-7 w-auto" />
					</h1>
					{version === '' ? null : (
						<span className="font-mono text-muted-foreground text-xs">v{version}</span>
					)}
				</div>
				<Badge variant={attentionToneOf(attention)}>
					{runInspectorCatalog.attentionLabels[attention]}
				</Badge>
			</div>
			<ChainPauseCallout pause={stoppedQueue} />
			<StaleServiceCallout staleService={staleService} />
			<GitIdentityCallout gitIdentity={gitIdentity} />
			<Separator />
			<nav aria-label={catalog.operatorNavigationLabel}>
				<ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible">
					{SURFACES.map((surface) => (
						<li key={surface.path}>
							<a
								aria-current={surface.path === route ? 'page' : undefined}
								className={cn(
									NAV_LINK_CLASS,
									surface.path === route && 'bg-sidebar-accent text-sidebar-accent-foreground',
								)}
								href={surface.path}
							>
								{catalog.routeLabels[surface.label]}
							</a>
						</li>
					))}
				</ul>
			</nav>
		</header>
	);
}

/** The content column of a secondary surface: stacked panels, one task each. */
function SurfaceColumn({
	label,
	status,
	children,
}: Pick<AppProps, 'status'> & {
	label: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<main
			aria-label={label}
			className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 p-4 lg:p-6 xl:overflow-y-auto"
			id={MAIN_CONTENT_ID}
			tabIndex={-1}
		>
			<StatusOutput status={status} />
			{children}
		</main>
	);
}

function HomeSurface(props: AppProps): React.ReactElement {
	const run = props.runs[0] ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	return (
		<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col xl:flex-row">
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
				className="flex w-full min-w-0 flex-col gap-4 p-4 pt-0 lg:p-6 lg:pt-0 xl:w-96 xl:shrink-0 xl:overflow-y-auto xl:border-l xl:pt-6"
			>
				<RunCard
					catalog={localeCatalog.runInspector}
					footer={
						<a className={TEXT_LINK_CLASS} href="/runs">
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
				title={catalog.latestRunTitle}
			/>
			{run === null ? null : <RunReport catalog={catalog} run={run} />}
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
			<RunActivity
				catalog={localeCatalog.runsOperational}
				events={props.events}
				locale={props.locale}
				run={run}
			/>
			<WorkspaceNoticesPanel
				catalog={localeCatalog.runsOperational}
				workspaceNotices={props.workspaceNotices}
			/>
			<PreviousRunsPanel
				catalog={localeCatalog.runsOperational}
				locale={props.locale}
				runs={props.runs}
			/>
		</SurfaceColumn>
	);
}

const DRAFT_LABEL: Record<IssueReviewDraft['state'], string> = {
	draft: 'draft',
	approved: 'approved',
	stale: 'stale',
};

function draftChanged(draft: IssueReviewDraft, scope: string, command: string): boolean {
	return scope !== draft.scope || command !== draft.verificationCommand;
}

/** The editable contract of one draft: its revision, its approval, and its abandonment. */
function IssueReviewForm({
	draft,
	pending,
	onReviewIssue,
	onApproveIssue,
	onAbandonIssue,
}: Pick<AppProps, 'pending' | 'onReviewIssue' | 'onApproveIssue' | 'onAbandonIssue'> & {
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
			<div><Badge variant={draft.state === 'approved' ? 'success' : draft.state === 'stale' ? 'warning' : 'outline'}>{DRAFT_LABEL[draft.state]}</Badge></div>
			<label className="flex flex-col gap-1 text-sm" htmlFor="review-scope">
				<span className="font-medium">Scope and expected outcome</span>
				<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="review-scope" onChange={(event) => setScope((event.currentTarget as unknown as { value: string }).value)} required value={scope} />
			</label>
			<label className="flex flex-col gap-1 text-sm" htmlFor="review-command">
				<span className="font-medium">Verification command</span>
				<input className={cn(FIELD_CLASS, 'font-mono')} id="review-command" onChange={(event) => setVerificationCommand((event.currentTarget as unknown as { value: string }).value)} required value={verificationCommand} />
			</label>
			{draft.evidence === undefined || draft.evidence.length === 0 ? null : (
				<div className="flex flex-col gap-2 text-sm">
					<span className="font-medium">Evidence checked in the run workspace</span>
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
			<button className={BUTTON_CLASS} disabled={pending || !dirty} type="submit">Save revision</button>
			<label className="flex items-start gap-2 text-sm">
				<input checked={confirmed} disabled={pending || dirty} onChange={(event) => setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>I confirm the persisted scope and verificationCommand.</span>
			</label>
			<button
				className={PRIMARY_BUTTON_CLASS}
				disabled={pending || dirty || !confirmed}
				onClick={() => { setConfirmed(false); onApproveIssue(draft.id); }}
				type="button"
			>Approve</button>
			<label className="flex flex-col gap-1 text-sm" htmlFor="abandon-reason">
				<span className="font-medium">Reason for abandonment</span>
				<textarea className={cn(FIELD_CLASS, 'min-h-20')} id="abandon-reason" onChange={(event) => setAbandonReason((event.currentTarget as unknown as { value: string }).value)} value={abandonReason} />
			</label>
			<label className="flex items-start gap-2 text-sm">
				<input checked={abandonConfirmed} disabled={pending || abandonReason.trim().length === 0} onChange={(event) => setAbandonConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>I confirm abandoning {draft.id} for this reason.</span>
			</label>
			<button
				className={BUTTON_CLASS}
				disabled={pending || abandonReason.trim().length === 0 || !abandonConfirmed}
				onClick={() => {
					setAbandonConfirmed(false);
					onAbandonIssue(draft.id, abandonReason.trim());
				}}
				type="button"
			>Abandon</button>
		</form>
	);
}

function IssueReviewPanel({
	drafts,
	pending,
	runs,
	onReviewIssue,
	onApproveIssue,
	onAbandonIssue,
}: Pick<
	AppProps,
	'drafts' | 'pending' | 'runs' | 'onReviewIssue' | 'onApproveIssue' | 'onAbandonIssue'
>): React.ReactElement {
	const [selectedId, setSelectedId] = useState<string | null>(drafts[0]?.id ?? null);
	const selected = drafts.find((draft) => draft.id === selectedId) ?? null;
	// The run owns the issue file while it is in flight: revising, approving or
	// abandoning it would write on main what the ship closes on the run's branch.
	const ownedByRun = selected !== null && activeRunIssueId(runs) === selected.id;

	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>Review and approve</CardTitle>
				<CardDescription>{countLabel(drafts.length, 'open and specified issue')}.</CardDescription>
				<CardAction><Badge variant="secondary">{drafts.length}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				<label className="flex flex-col gap-1 text-sm" htmlFor="review-issue">
					<span className="font-medium">Draft</span>
					<select
						className={FIELD_CLASS}
						id="review-issue"
						onChange={(event) =>
							setSelectedId((event.currentTarget as unknown as { value: string }).value || null)}
						value={selectedId ?? ''}
					>
						<option value="">Select a draft</option>
						{drafts.map((draft) => (
							<option key={draft.id} value={draft.id}>{draft.id} — {draft.title}</option>
						))}
					</select>
				</label>
				{selected === null || !ownedByRun ? null : (
					<p className="text-muted-foreground text-sm">
						{selected.id} is being executed by a run. The issue file belongs to it until the
						 run ends, so review, approval and abandonment return only after that.
					</p>
				)}
				{selected === null || ownedByRun ? null : (
					<IssueReviewForm
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

function diagnosticStatusLabel(status: DiagnosticFindingView['status']): string {
	if (status === 'promoted') return 'Promoted';
	if (status === 'dismissed') return 'Dismissed';
	if (status === 'cleared') return 'Did not recur';
	return 'Pending';
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
	scan,
}: Pick<DiagnosticsView, 'scan'>): React.ReactElement | null {
	if (scan === null) return null;
	return (
		<div className="flex flex-col gap-1 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={diagnosticScanVariant(scan.state)}>{scan.state}</Badge>
				{scan.sourceSha === null ? null : <code className="text-xs">{scan.sourceSha.slice(0, 12)}</code>}
				{scan.state === 'completed' && !scan.coverageComplete ? <Badge variant="warning">partial</Badge> : null}
			</div>
			{scan.error === null ? null : <p className="text-destructive-foreground">{scan.error}</p>}
		</div>
	);
}

function DiagnosticFindingCard({
	finding,
	pending,
	onDismiss,
	onPromote,
}: {
	finding: DiagnosticFindingView;
	pending: boolean;
	onDismiss: AppProps['onDismissDiagnosticFinding'];
	onPromote: AppProps['onPromoteDiagnosticFinding'];
}): React.ReactElement {
	return (
		<details className="rounded-md border border-border p-3 text-sm">
			<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
				<Badge variant={diagnosticSeverityVariant(finding.severity)}>{finding.severity}</Badge>
				<span className="font-medium">{finding.rule}</span>
				<code className="break-all text-xs text-muted-foreground">{diagnosticFindingLocation(finding)}</code>
				{finding.occurrenceCount > 1 ? <Badge variant="outline">×{finding.occurrenceCount}</Badge> : null}
			</summary>
			<div className="mt-4 flex flex-col gap-4">
				<p className="whitespace-pre-wrap break-words text-muted-foreground">{finding.evidence}</p>
				<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
					<span>tool {finding.toolVersion}</span>
					<code>{finding.sourceSha.slice(0, 12)}</code>
				</div>
				<ActionButton enabled={!pending} label="Dismiss" onClick={() => onDismiss(finding.id)} />
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
						<span className="font-medium">Title</span>
						<input className={FIELD_CLASS} defaultValue={`${finding.rule} in ${finding.file}`.slice(0, 120)} name="diagnosticTitle" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">Scope and expected outcome</span>
						<textarea className={cn(FIELD_CLASS, 'min-h-24')} name="diagnosticScope" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">Verification command</span>
						<input className={cn(FIELD_CLASS, 'font-mono')} name="diagnosticVerificationCommand" placeholder="bun test" required />
					</label>
					<button className={BUTTON_CLASS} disabled={pending} type="submit">Promote</button>
				</form>
			</div>
		</details>
	);
}

function PendingDiagnosticFindings({
	findings,
	pending,
	onDismiss,
	onPromote,
}: {
	findings: readonly DiagnosticFindingView[];
	pending: boolean;
	onDismiss: AppProps['onDismissDiagnosticFinding'];
	onPromote: AppProps['onPromoteDiagnosticFinding'];
}): React.ReactElement {
	if (findings.length === 0) {
		return <p className="text-muted-foreground text-sm">No pending findings.</p>;
	}
	return (
		<ul className="flex flex-col gap-3">
			{findings.map((finding) => (
				<li key={finding.id}>
					<DiagnosticFindingCard finding={finding} onDismiss={onDismiss} onPromote={onPromote} pending={pending} />
				</li>
			))}
		</ul>
	);
}

function ResolvedDiagnosticFindings({
	findings,
	omittedCount,
}: {
	findings: readonly DiagnosticFindingView[];
	omittedCount: number;
}): React.ReactElement {
	return (
		<details className="text-sm">
			<summary className="cursor-pointer text-muted-foreground">Resolved ({findings.length})</summary>
			<ul className="mt-3 flex flex-col gap-2">
				{findings.map((finding) => (
					<li className="flex flex-wrap items-center gap-2" key={finding.id}>
						<Badge variant="secondary">{diagnosticStatusLabel(finding.status)}</Badge>
						<span>{finding.rule}</span>
						<code className="break-all text-xs text-muted-foreground">{diagnosticFindingLocation(finding)}</code>
						{finding.promotedIssueId === null ? null : <Badge variant="info">{finding.promotedIssueId}</Badge>}
					</li>
				))}
			</ul>
			{omittedCount > 0 ? <p className="mt-2 text-muted-foreground">+{omittedCount} not shown.</p> : null}
		</details>
	);
}

function DiagnosticOutcomeSummary({
	stats,
}: Pick<DiagnosticsView, 'stats'>): React.ReactElement {
	if (stats.total === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				There is not enough history yet to measure this analyzer's usefulness.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1 text-sm">
			<p>
				Local history: {stats.promoted} promoted, {stats.dismissed} dismissed,{' '}
				{stats.cleared} that did not recur and {stats.pending} pending.
			</p>
			{stats.recurring === 0 ? null : (
				<p className="text-muted-foreground">{countLabel(stats.recurring, 'finding')} recurred in another scan.</p>
			)}
			<p className="text-muted-foreground text-xs">
				Dismissal does not mean false positive; that can only be measured when the operator
				explicitly classifies the reason.
			</p>
		</div>
	);
}

/**
 * One optional, advisory analyzer at a time. The summary stays compact; raw
 * evidence and issue promotion live behind per-finding disclosure.
 */
function DiagnosticsPanel({
	diagnostics,
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
>): React.ReactElement {
	const scan = diagnostics.scan;
	const active = scan?.state === 'queued' || scan?.state === 'running';
	const analyzer = diagnostics.analyzers[0];
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>Gateship Diagnostics</CardTitle>
				<CardDescription>
					{active ? 'Analyzing an isolated checkout…' : `${countLabel(diagnostics.findings.length, 'pending finding')}.`}
				</CardDescription>
				<CardAction><Badge variant={active ? 'info' : 'secondary'}>{active ? 'running' : diagnostics.findings.length}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				<div className="flex flex-col gap-2 text-sm">
					<p className="text-muted-foreground">
						Advisory: never fixes, approves or blocks shipping. The first run downloads the
						pinned analyzer only into Gateship's local state.
					</p>
					{analyzer === undefined ? null : (
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="outline">{analyzer.label}</Badge>
							<code className="text-xs">v{analyzer.version}</code>
							<span className="text-muted-foreground">{analyzer.description}</span>
						</div>
					)}
				</div>
				<DiagnosticScanSummary scan={scan} />
				<div className="flex flex-wrap gap-2">
					{!active && analyzer !== undefined ? (
						<ActionButton
							enabled={!pending}
							label="Run now"
							onClick={() => onStartDiagnostic(analyzer.id)}
						/>
					) : null}
					{active && scan !== null ? (
						<ActionButton
							enabled={!pending}
							label="Cancel diagnostic"
							onClick={() => onCancelDiagnostic(scan.id)}
						/>
					) : null}
				</div>
				{diagnostics.workspaceNotices.map((notice) => (
					<p className="text-warning-foreground text-sm" key={notice}>{notice}</p>
				))}
				<DiagnosticOutcomeSummary stats={diagnostics.stats} />
				<Separator />
				<PendingDiagnosticFindings
					findings={diagnostics.findings}
					onDismiss={onDismissDiagnosticFinding}
					onPromote={onPromoteDiagnosticFinding}
					pending={pending}
				/>
				<ResolvedDiagnosticFindings
					findings={diagnostics.resolvedFindings}
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
	proposals,
	pending,
	onDismissProposal,
	onPromoteProposal,
}: Pick<
	AppProps,
	'proposals' | 'pending' | 'onDismissProposal' | 'onPromoteProposal'
>): React.ReactElement {
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>Derived proposals</CardTitle>
				<CardDescription>{countLabel(proposals.length, 'pending proposal')}.</CardDescription>
				<CardAction><Badge variant="secondary">{proposals.length}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				{proposals.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No pending proposals. A run records out-of-scope discoveries here.
					</p>
				) : (
					<ul className="flex flex-col gap-6">
						{proposals.map((proposal) => (
							<li className="flex min-w-0 flex-col gap-3 text-sm" key={proposal.id}>
								<div className="flex flex-col gap-1">
									<span className="break-words font-medium">{proposal.title}</span>
									<p className="whitespace-pre-wrap break-words text-muted-foreground">
										{proposal.evidence}
									</p>
									<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
										<Badge variant="outline">{proposal.sourceIssueId}</Badge>
										<code className="break-all text-xs">{proposal.sourceRunId}</code>
									</div>
								</div>
								<ActionButton
									enabled={!pending}
									label="Dismiss"
									onClick={() => onDismissProposal(proposal.id)}
								/>
								<form
									className="flex flex-col gap-3"
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
										<span className="font-medium">Title</span>
										<input
											className={FIELD_CLASS}
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
										<span className="font-medium">Scope and expected outcome</span>
										<textarea
											className={cn(FIELD_CLASS, 'min-h-24')}
											id={`proposal-scope-${proposal.id}`}
											name="proposalScope"
											required
										/>
									</label>
									<label
										className="flex flex-col gap-1"
										htmlFor={`proposal-command-${proposal.id}`}
									>
										<span className="font-medium">Verification command</span>
										<input
											className={cn(FIELD_CLASS, 'font-mono')}
											id={`proposal-command-${proposal.id}`}
											name="proposalVerificationCommand"
											placeholder="bun test"
											required
										/>
									</label>
									<button className={BUTTON_CLASS} disabled={pending} type="submit">
										Promote
									</button>
								</form>
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
	resolvedProposals,
	resolvedProposalsOmittedCount,
}: Pick<AppProps, 'resolvedProposals' | 'resolvedProposalsOmittedCount'>): React.ReactElement {
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>Resolved proposals</CardTitle>
				<CardDescription>{countLabel(resolvedProposals.length, 'resolved proposal')}.</CardDescription>
				<CardAction><Badge variant="secondary">{resolvedProposals.length}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">read-only</Badge>
					<span className="text-muted-foreground text-sm">
						Dismissal and promotion cannot be undone here.
					</span>
				</div>
				<Separator />
				{resolvedProposals.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No resolved proposals yet.
					</p>
				) : (
					<ul className="flex flex-col gap-4">
						{resolvedProposals.map((proposal) => (
							<li className="flex min-w-0 flex-col gap-2 text-sm" key={proposal.id}>
								<div className="flex flex-wrap items-center gap-2">
									<span className="break-words font-medium">{proposal.title}</span>
									{proposal.status === 'promoted' ? (
										<Badge variant="success">Promoted</Badge>
									) : (
										<Badge variant="secondary">Dismissed</Badge>
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
											became <Badge variant="info">{proposal.promotedIssueId}</Badge>
										</span>
									) : null}
								</div>
							</li>
						))}
					</ul>
				)}
				{resolvedProposalsOmittedCount > 0 ? (
					<p className="text-muted-foreground text-sm">
						+{countLabel(resolvedProposalsOmittedCount, 'resolved proposal')} not shown.
					</p>
				) : null}
			</CardPanel>
		</CardDisclosure>
	);
}

function WorkSurface(props: AppProps): React.ReactElement {
	const actions = actionsFor(props.runs[0] ?? null, props.selectedIssueId !== null);
	return (
		<SurfaceColumn label="Work" status={props.status}>
			<BacklogPanel
				backlog={props.backlog}
				canStart={actions.start && !props.pending}
				onSelectIssue={props.onSelectIssue}
				onStart={props.onStart}
				selectedIssueId={props.selectedIssueId}
			/>
			<DiagnosticsPanel
				diagnostics={props.diagnostics}
				onCancelDiagnostic={props.onCancelDiagnostic}
				onDismissDiagnosticFinding={props.onDismissDiagnosticFinding}
				onPromoteDiagnosticFinding={props.onPromoteDiagnosticFinding}
				onStartDiagnostic={props.onStartDiagnostic}
				pending={props.pending}
			/>
			<IssueReviewPanel drafts={props.drafts} onAbandonIssue={props.onAbandonIssue} onApproveIssue={props.onApproveIssue} onReviewIssue={props.onReviewIssue} pending={props.pending} runs={props.runs} />
			<ProposalsPanel
				onDismissProposal={props.onDismissProposal}
				onPromoteProposal={props.onPromoteProposal}
				pending={props.pending}
				proposals={props.proposals}
			/>
			<ResolvedProposalsPanel
				resolvedProposals={props.resolvedProposals}
				resolvedProposalsOmittedCount={props.resolvedProposalsOmittedCount}
			/>
			<IssueSpecifyPanel
				ideas={props.ideas}
				onSpecifyIssue={props.onSpecifyIssue}
				pending={props.pending}
			/>
			<IssueIntakePanel onCreateIssue={props.onCreateIssue} pending={props.pending} />
		</SurfaceColumn>
	);
}

function ProjectPanel({ project }: Pick<AppProps, 'project'>): React.ReactElement {
	const ready = project.state === 'ready';
	return (
		<ContextPanel
			description="The process operates one local project at a time; this binding is derived from Git, not hidden configuration."
			open
			title="Project"
		>
			<div className="flex flex-col gap-3 text-sm">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={ready ? 'success' : project.state === 'checking' ? 'secondary' : 'warning'}>
						{ready ? 'ready' : project.state === 'checking' ? 'checking' : 'attention'}
					</Badge>
					<span className="font-medium">{project.name === '' ? 'Local project' : project.name}</span>
				</div>
				{ready ? (
					<dl className="grid gap-2 sm:grid-cols-[8rem_1fr]">
						<dt className="text-muted-foreground">Repository</dt>
						<dd><code className="break-all">{project.repository}</code></dd>
						<dt className="text-muted-foreground">Run source</dt>
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
}: Pick<
	AppProps,
	'operatorProfile' | 'pending' | 'suggestedTimezone' | 'onSaveOperatorProfile'
>): React.ReactElement {
	const initialTimezone = operatorProfile.timezone || suggestedTimezone;
	return (
		<ContextPanel
			description="Human identity and timezone used as non-authoritative conversation context."
			open
			title="Operator"
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
					<span className="font-medium">Name</span>
					<input
						className={FIELD_CLASS}
						defaultValue={operatorProfile.name}
						id="operator-name"
						name="operator-name"
						placeholder="What the orchestrator should call you"
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="operator-timezone">
					<span className="font-medium">Timezone</span>
					<input
						className={FIELD_CLASS}
						defaultValue={initialTimezone}
						id="operator-timezone"
						name="operator-timezone"
						placeholder="America/Sao_Paulo"
					/>
					<span className="text-muted-foreground text-xs">
						IANA identifier. The browser suggestion is saved only when you confirm.
					</span>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Save profile
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
	project,
	status,
}: Pick<AppProps, 'project' | 'status'>): React.ReactElement {
	return (
		<SurfaceColumn label="Set up project" status={status}>
			<Card>
				<CardHeader>
					<CardTitle>Connect a GitHub project</CardTitle>
					<CardDescription>
						Gateship runs inside a local clone and uses origin/main as its deterministic source.
					</CardDescription>
				</CardHeader>
				<CardPanel className="flex flex-col gap-5">
					{project.state === 'checking' ? (
						<p className="text-muted-foreground text-sm">{project.detail}</p>
					) : null}
					{project.state === 'empty' ? (
						<>
							<p className="text-muted-foreground text-sm">{project.detail}</p>
							<section className="flex flex-col gap-2">
								<h3 className="font-medium text-sm">Existing project</h3>
								<p className="text-muted-foreground text-sm">
									Stop this process and start Gateship inside the clone.
								</p>
								<CommandLine>cd /path/to/project && gship</CommandLine>
							</section>
							<Separator />
							<section className="flex flex-col gap-2">
								<h3 className="font-medium text-sm">New project</h3>
								<p className="text-muted-foreground text-sm">
									Create the repository with a main branch, enter the clone and start Gateship.
								</p>
								<CommandLine>gh repo create OWNER/REPO --private --add-readme --clone</CommandLine>
								<CommandLine>cd REPO && gship</CommandLine>
							</section>
						</>
					) : null}
					{project.state === 'needs-attention' ? (
						<>
							<div className="flex flex-col gap-2">
								<Badge variant="warning">incomplete configuration</Badge>
								<p className="text-sm">{project.detail}</p>
							</div>
							<CommandLine>{PROJECT_RECOVERY_COMMAND[project.reason]}</CommandLine>
							<p className="text-muted-foreground text-sm">
								After correcting it, restart Gateship. In a container, update GATESHIP_PROJECT_DIR and recreate the service.
							</p>
						</>
					) : null}
					<p className="text-muted-foreground text-sm">
						Agent and subscription settings remain available under <a className={TEXT_LINK_CLASS} href="/settings">Settings</a>.
					</p>
				</CardPanel>
			</Card>
		</SurfaceColumn>
	);
}

function SettingsSurface(props: AppProps): React.ReactElement {
	return (
		<SurfaceColumn label="Settings" status={props.status}>
			<ProjectPanel project={props.project} />
			<OperatorProfilePanel
				onSaveOperatorProfile={props.onSaveOperatorProfile}
				operatorProfile={props.operatorProfile}
				pending={props.pending}
				suggestedTimezone={props.suggestedTimezone}
			/>
			<ProvidersPanel
				onConnectCodex={props.onConnectCodex}
				onSelectProvider={props.onSelectProvider}
				pending={props.pending}
				providers={props.providers}
				selectedProvider={props.selectedProvider}
			/>
			<ModelSettingsPanel
				modelSettings={props.modelSettings}
				onSaveModelSettings={props.onSaveModelSettings}
				pending={props.pending}
			/>
			<ChainRunsPanel
				chainRuns={props.chainRuns}
				onSetChainRuns={props.onSetChainRuns}
				pending={props.pending}
			/>
			<SelfUpdatePanel
				onSetSelfUpdate={props.onSetSelfUpdate}
				pending={props.pending}
				selfUpdate={props.selfUpdate}
			/>
			<DiagnosticSchedulePanel
				diagnostics={props.diagnostics}
				onSaveDiagnosticSchedule={props.onSaveDiagnosticSchedule}
				pending={props.pending}
			/>
			<NotificationsPanel
				notificationChannels={props.notificationChannels}
				notificationPermission={props.notificationPermission}
				onEnableNotifications={props.onEnableNotifications}
				onSendNotificationTest={props.onSendNotificationTest}
				pending={props.pending}
			/>
			<ProjectBriefPanel
				brief={props.brief}
				onSaveBrief={props.onSaveBrief}
				pending={props.pending}
			/>
			<HandoffPanel handoff={props.handoff} />
		</SurfaceColumn>
	);
}

export function App(props: AppProps): React.ReactElement {
	// The array arrives newest first, so the operable run is its head and the
	// history below it is the same array, read once.
	const run = props.runs[0] ?? null;
	const projectBlocksSurface = props.project.state !== 'ready' && props.route !== '/settings';
	const localeCatalog = LOCALE_CATALOG[props.locale];
	return (
		<div className="flex min-h-screen w-full flex-col lg:flex-row xl:h-screen xl:overflow-hidden">
			<a
				className="fixed top-0 left-4 z-50 -translate-y-full rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm outline-none focus:translate-y-4 focus-visible:ring-2 focus-visible:ring-ring"
				href={`#${MAIN_CONTENT_ID}`}
			>
				{localeCatalog.shell.skipLinkLabel}
			</a>
			<ShellSidebar
				chainRuns={props.chainRuns}
				gitIdentity={props.gitIdentity}
				locale={props.locale}
				runInspectorCatalog={localeCatalog.runInspector}
				route={props.route}
				run={run}
				staleService={props.staleService}
				version={props.version}
				workspaceNotices={props.workspaceNotices}
			/>
			{projectBlocksSurface ? <OnboardingSurface project={props.project} status={props.status} /> : null}
			{!projectBlocksSurface && props.route === '/runs' ? <RunsSurface {...props} /> : null}
			{!projectBlocksSurface && props.route === '/work' ? <WorkSurface {...props} /> : null}
			{props.route === '/settings' ? <SettingsSurface {...props} /> : null}
			{!projectBlocksSurface && props.route === '/' ? <HomeSurface {...props} /> : null}
		</div>
	);
}
