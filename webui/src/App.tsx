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

import React, { useState } from 'react';
import {
	aggregateChatTurnCosts,
	type ChainPauseReason,
	type ChainRunsView,
	type ChatMessageView,
	type CreateProjectInput,
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
	type RegisteredProjectView,
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
	type OnboardingCatalog,
	type ProjectsCatalog,
	type RunInspectorCatalog,
	type RunsOperationalCatalog,
	type RunsWorkflowCatalog,
	type SettingsCatalog,
	type ShellCatalog,
	type WorkCatalog,
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

/** Project selection and surface both come from this URL, never hidden state. */
export type OperatorRoute = '/overview' | `/projects/${string}` | '/' | '/runs' | '/work' | '/settings';

const MAIN_CONTENT_ID = 'main-content';

function formatCount(count: number, locale: Locale): string {
	return new Intl.NumberFormat(locale).format(count);
}

type ProjectSurface = 'conversation' | 'runs' | 'work' | 'settings';

const SURFACES: readonly { suffix: string; label: keyof ShellCatalog['routeLabels']; surface: ProjectSurface }[] = [
	{ suffix: '', label: 'conversation', surface: 'conversation' },
	{ suffix: '/runs', label: 'runs', surface: 'runs' },
	{ suffix: '/work', label: 'work', surface: 'work' },
	{ suffix: '/settings', label: 'settings', surface: 'settings' },
];

/**
 * Which surface a browser path names. Anything the server does not serve --
 * which the shell's own links can never produce -- reads as the home surface,
 * so the screen has no unreachable state.
 */
export function routeOf(pathname: string): OperatorRoute {
	const normalized = pathname.replace(/\/+$/, '');
	const path = normalized === '' ? '/' : normalized;
	if (path === '/overview') return path;
	if (path === '/' || path === '/runs' || path === '/work' || path === '/settings') return path;
	if (/^\/projects\/[^/]+(?:\/(?:runs|work|settings))?$/.test(path)) {
		return path as `/projects/${string}`;
	}
	return '/overview';
}

interface RouteSelection {
	projectId: string | null;
	surface: ProjectSurface | 'overview';
}

/**
 * The project this document is about, read from the browser path alone
 * (GSHIP-707) so the transport can address the scoped routes before anything
 * is fetched. `null` is the absence of a selection -- the overview, and the
 * legacy paths the service redirects -- which keeps the boot project's own
 * unscoped routes.
 */
export function projectIdOf(pathname: string): string | null {
	return routeSelection(routeOf(pathname), null).projectId;
}

function routeSelection(route: OperatorRoute, currentId: string | null): RouteSelection {
	if (route === '/overview') return { projectId: null, surface: 'overview' };
	const legacy = route === '/' ? 'conversation' : route.slice(1);
	if (route === '/' || route === '/runs' || route === '/work' || route === '/settings') {
		return { projectId: currentId, surface: legacy as ProjectSurface };
	}
	const match = /^\/projects\/([^/]+)(?:\/(runs|work|settings))?$/.exec(route);
	if (match === null) return { projectId: null, surface: 'overview' };
	let projectId = match[1] ?? '';
	try { projectId = decodeURIComponent(projectId); } catch { /* unmatched id stays unavailable */ }
	return { projectId, surface: (match[2] ?? 'conversation') as ProjectSurface };
}

export interface AppProps {
	/** Which of the four surfaces this document is showing. */
	route: OperatorRoute;
	/** The explicit locale shared by every cataloged surface. */
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
	/** Read-only global registry used by URL-backed project navigation. */
	projects: readonly RegisteredProjectView[];
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
	projectOnboardingPending: 'create' | 'import' | null;
	onSelectIssue: (issueId: string) => void;
	onSelectLocale: (locale: Locale) => void;
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
	/**
	 * Connect, reconnect and rotate the dedicated Claude credential
	 * (GSHIP-704) all share this one call. It resolves `true` only once the
	 * service validated and persisted the token; on `false` the typed token
	 * and its confirmation stay exactly where the operator left them
	 * (GSHIP-705), so a refused paste can be corrected in place instead of
	 * being retyped from a token the CLI printed once.
	 */
	onConnectClaudeCredential: (token: string) => Promise<boolean>;
	/** The last refusal from that call, rendered beside the field it belongs to. `null` while nothing was refused. */
	claudeCredentialError: string | null;
	/** Abandons a refused attempt: the operator gave up on this token, so the refusal stops holding the form open. */
	onDismissClaudeCredentialError: () => void;
	onDisconnectClaudeCredential: () => void;
	onEnableNotifications: () => void;
	onSendNotificationTest: (channelId: NotificationChannelId) => void;
	onSaveResendSettings: (input: { from: string; to: string; apiKey: string }) => void;
	onRemoveResendCredential: () => void;
	onSelectProvider: (providerId: ProviderStatusView['id']) => void;
	onSendMessage: (message: string) => void;
	onSaveBrief: (brief: ProjectBriefView) => void;
	onSaveModelSettings: (settings: ModelSettingsView) => void;
	onSaveOperatorProfile: (profile: OperatorProfileView) => void;
	onSetChainRuns: (enabled: boolean) => void;
	onSetSelfUpdate: (enabled: boolean) => void;
	/**
	 * Import a GitHub repository into a checkout Gateship manages, by
	 * owner/repo or an https://github.com/owner/repo URL.
	 */
	onImportProject: (repository: string) => void;
	onCreateProject: (input: CreateProjectInput) => void;
	/**
	 * Register a checkout that already exists on disk, by absolute path
	 * (GSHIP-716). Selection stays with the list and the sidebar; this only
	 * adds a project to them.
	 */
	onRegisterProject: (root: string) => void;
	/**
	 * Drop a project's registration (GSHIP-717). Offered for a selected project
	 * this process does not serve, and it removes nothing but the registry row:
	 * the checkout and everything it owns stay on disk.
	 */
	onUnregisterProject: (projectId: string) => void;
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
}: Pick<AppProps, 'pending' | 'onResume' | 'onAbandon' | 'onCancel' | 'onShip'> & {
	catalog: RunInspectorCatalog;
	locale: Locale;
	run: RunView;
}): React.ReactElement {
	return (
		<>
			<RunProgress catalog={catalog} run={run} />
			<PullRequestDelivery catalog={catalog} run={run} />
			<ProviderWaitCallout catalog={catalog} locale={locale} wait={run.providerWait} />
			{run.cost.totalCostUsd === null ? null : (
				<p className="text-muted-foreground text-sm">
					{catalog.expectedCost(formatCostUsd(run.cost.totalCostUsd, locale))}
				</p>
			)}
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

function PreviousRunRow({
	locale,
	run,
	runInspector,
}: {
	locale: Locale;
	run: RunView;
	runInspector: RunInspectorCatalog;
}): React.ReactElement {
	const delivery = run.pullRequest;
	return (
		<li className="flex items-baseline justify-between gap-3 text-sm">
			<span className="min-w-0 break-all font-medium">{run.issueId}</span>
			{delivery === null ? null : (
				<a className={TEXT_LINK_CLASS} href={delivery.url} rel="noreferrer" target="_blank">
					{runInspector.pullRequestLabel(delivery.prNumber)}
				</a>
			)}
			{delivery !== null && run.state === 'done' ? <Badge variant="merged">Merged</Badge> : null}
			<Badge variant={toneOf(run.state)}>{runInspector.stateLabels[run.state]}</Badge>
			{delivery === null ? null : (
				<Badge variant={ciBadgeVariant(delivery.ciStatus)}>
					{runInspector.ciLabels[delivery.ciStatus]}
				</Badge>
			)}
			{run.cost.totalCostUsd === null ? null : (
				<span className="shrink-0 text-muted-foreground">
					{runInspector.expectedCost(formatCostUsd(run.cost.totalCostUsd, locale))}
				</span>
			)}
			<time className="shrink-0 text-muted-foreground">
				{formatRunTimestamp(run.updatedAt, locale)}
			</time>
		</li>
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
	return (
		<ContextPanel
			description={catalog.previousRuns.description(previous.length)}
			title={catalog.previousRuns.title}
		>
			<ul className="flex flex-col gap-2">
				{previous.map((run) => (
					<PreviousRunRow key={run.id} locale={locale} run={run} runInspector={runInspector} />
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
			{error === null ? null : <span className="text-destructive text-xs" role="alert">{error}</span>}
			<div className="flex flex-wrap gap-2">
				{provider.installed ? (
					<button className={BUTTON_CLASS} onClick={onRotate} type="button">{text.rotate}</button>
				) : null}
				{error === null ? null : (
					<button className={BUTTON_CLASS} onClick={onDismissError} type="button">{text.cancel}</button>
				)}
				<button
					className={BUTTON_CLASS}
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
						<input
							autoComplete="off"
							className={FIELD_CLASS}
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
							className={PRIMARY_BUTTON_CLASS}
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
				<ClaudeCredentialSection
					catalog={catalog}
					error={claudeCredentialError}
					onConnectClaudeCredential={onConnectClaudeCredential}
					onDisconnectClaudeCredential={onDisconnectClaudeCredential}
					onDismissError={onDismissClaudeCredentialError}
					pending={pending}
					provider={provider}
				/>
			) : null}
			{provider.id === 'claude' && provider.login !== 'dedicated' && provider.installed ? (
				<p className="text-muted-foreground text-xs">
					{catalog.providers.claudeCredential.advancedTitle}: <code className="break-all">claude auth login</code>
				</p>
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
				<input
					className={cn(FIELD_CLASS, 'font-mono')}
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
				<input
					className={cn(FIELD_CLASS, 'font-mono')}
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
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
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

function DiagnosticSchedulePanel({
	diagnostics,
	pending,
	onSaveDiagnosticSchedule,
	catalog,
	locale,
}: Pick<
	AppProps,
	'diagnostics' | 'pending' | 'onSaveDiagnosticSchedule'
> & { catalog: SettingsCatalog; locale: Locale }): React.ReactElement {
	const { schedule } = diagnostics;
	return (
		<ContextPanel
			actionLabels={catalog.disclosure}
			description={catalog.diagnostics.description}
			title={catalog.diagnostics.title}
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
					<span className="font-medium">{catalog.diagnostics.label}</span>
				</label>
				<label className="flex max-w-sm flex-col gap-1 text-sm" htmlFor="diagnostic-schedule-cadence">
					<span className="font-medium">{catalog.diagnostics.cadence}</span>
					<select
						className={FIELD_CLASS}
						defaultValue={schedule.cadence}
						disabled={pending}
						id="diagnostic-schedule-cadence"
						name="diagnostic-schedule-cadence"
					>
						<option value="daily">{catalog.diagnostics.cadenceLabels.daily}</option>
						<option value="weekly">{catalog.diagnostics.cadenceLabels.weekly}</option>
					</select>
				</label>
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Badge variant="outline">{schedule.analyzer}</Badge>
					{!schedule.enabled ? (
						<span className="text-muted-foreground">{catalog.diagnostics.disabled}</span>
					) : schedule.overdue ? (
						<Badge variant="warning">{catalog.diagnostics.overdue}</Badge>
					) : (
						<span className="text-muted-foreground">
							{catalog.diagnostics.nextRun(schedule.nextRunAt === null ? catalog.diagnostics.calculating : formatUsageTime(schedule.nextRunAt, locale))}
						</span>
					)}
				</div>
				<p className="text-muted-foreground text-xs">
					{catalog.diagnostics.guidance}
				</p>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					{catalog.diagnostics.save}
				</button>
			</form>
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
	const values: Readonly<Record<string, string>> = { ...NOTIFICATION_INSTRUCTION_VALUES, file: channelId === 'resend' ? '.gship/resend-api-key' : '.gship/ntfy-url' };
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
					<input
						className={FIELD_CLASS}
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
				<input
					autoComplete="new-password"
					className={FIELD_CLASS}
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
				<button className={PRIMARY_BUTTON_CLASS} disabled={pending} type="submit">
					{catalog.notifications.saveResend}
				</button>
				<button
					className={BUTTON_CLASS}
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
function ChatLog({
	chatMessages,
	catalog,
}: Pick<AppProps, 'chatMessages'> & { catalog: ConversationCatalog }): React.ReactElement {
	const liveEdge = useLiveEdge(chatMessages.at(-1)?.seq ?? null);
	return (
		<section
			{...liveEdge}
			aria-label={catalog.transcriptLabel}
			className="max-h-[60vh] min-h-24 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring xl:max-h-none"
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
				<ActionButton enabled={canStart} label={catalog.start} onClick={onStart} />
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
					<input className={FIELD_CLASS} id="issue-title" name="title" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-scope">
					<span className="font-medium">{catalog.form.scope}</span>
					<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="issue-scope" name="scope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-command">
					<span className="font-medium">{catalog.form.verificationCommand}</span>
					<input
						className={cn(FIELD_CLASS, 'font-mono')}
						id="issue-command"
						name="verificationCommand"
						placeholder={catalog.form.verificationPlaceholder}
						required
					/>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
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
					<select className={FIELD_CLASS} id="idea-id" name="ideaId" required>
						{ideas.map((idea) => (
							<option key={idea.id} value={idea.id}>{idea.id} — {idea.title}</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-scope">
					<span className="font-medium">{catalog.form.scope}</span>
					<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="idea-scope" name="ideaScope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-command">
					<span className="font-medium">{catalog.form.verificationCommand}</span>
					<input
						className={cn(FIELD_CLASS, 'font-mono')}
						id="idea-command"
						name="ideaVerificationCommand"
						placeholder={catalog.form.verificationPlaceholder}
						required
					/>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
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
						<span className="font-medium">{catalog.brief.fieldLabels[field.name]}</span>
						<textarea
							className={cn(FIELD_CLASS, 'min-h-20')}
							defaultValue={brief[field.name].join('\n')}
							id={`brief-${field.name}`}
							name={field.name}
							placeholder={catalog.brief.linePlaceholder}
						/>
					</label>
				))}
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
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
		<section
			aria-label={complete ? 'Completed run queue' : 'Stopped run queue'}
			className={complete
				? 'flex flex-col gap-1 rounded-md bg-success/8 p-3 text-success-foreground dark:bg-success/16'
				: 'flex flex-col gap-1 rounded-md bg-warning/8 p-3 text-warning-foreground dark:bg-warning/16'}
		>
			<span className="font-medium text-sm">{complete ? 'Queue complete' : 'Queue stopped'}</span>
			<p className="break-words text-xs">{named}</p>
		</section>
	);
}

function humanVersionOf(version: string): string {
	const buildMetadata = version.indexOf('+');
	return buildMetadata === -1 ? version : version.slice(0, buildMetadata);
}

function ShellSidebar({
	chainRuns,
	gitIdentity,
	locale,
	onSelectLocale,
	runInspectorCatalog,
	route,
	projects,
	run,
	staleService,
	version,
	workspaceNotices,
}: Pick<AppProps, 'chainRuns' | 'gitIdentity' | 'locale' | 'onSelectLocale' | 'projects' | 'staleService' | 'workspaceNotices'> & {
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
	const catalog = LOCALE_CATALOG[locale].shell;
	const currentId = projects.find((project) => project.current)?.id ?? null;
	const selection = routeSelection(route, currentId);
	const selected = projects.find((project) => project.id === selection.projectId) ?? null;
	// Run state, preserved workspaces and the two callouts all describe the
	// selected project, whose own scoped snapshot is what this document loaded
	// (GSHIP-707). A queue pause is the one exception: run chaining is the boot
	// runtime's switch, so it is only ever stated for the current project.
	const operational = selected !== null && (selected.current || selected.readiness === 'ready');
	const queuePause = selected?.current === true ? visibleQueuePause(chainRuns) : null;
	const stoppedQueue = queuePause !== null && queuePause.reason !== 'no-admissible-issue';
	const attention = attentionOf(operational ? run : null, operational ? workspaceNotices : [], stoppedQueue);
	const humanVersion = humanVersionOf(version);
	return (
		<header className="flex shrink-0 flex-col gap-4 border-sidebar-border border-b bg-sidebar p-4 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:self-start lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-6">
			<div className="flex flex-col items-start gap-3">
				<div className="flex flex-col gap-1">
					<h1>
						<GateshipLockup className="block aspect-[15635/3035] h-7 w-auto" />
					</h1>
					{version === '' ? null : (
						<span className="font-mono text-muted-foreground text-xs">v{humanVersion}</span>
					)}
				</div>
				{operational ? <Badge variant={attentionToneOf(attention)}>
					{runInspectorCatalog.attentionLabels[attention]}
				</Badge> : null}
			</div>
			<nav aria-label={catalog.projectNavigationLabel}>
				<ul className="flex flex-col gap-1">
					<li>
						<a
							aria-current={selection.surface === 'overview' ? 'page' : undefined}
							className={cn(NAV_LINK_CLASS, selection.surface === 'overview' && 'bg-sidebar-accent text-sidebar-accent-foreground')}
							href="/overview"
						>
							{catalog.allProjectsLabel}
						</a>
					</li>
					{projects.map((project) => (
						<li key={project.id}>
							<a
								aria-current={selection.projectId === project.id && selection.surface === 'conversation' ? 'page' : undefined}
								className={cn(NAV_LINK_CLASS, selection.projectId === project.id && 'bg-sidebar-accent text-sidebar-accent-foreground')}
								href={`/projects/${encodeURIComponent(project.id)}`}
							>
								{project.name}
							</a>
						</li>
					))}
				</ul>
			</nav>
			<ChainPauseCallout pause={queuePause} />
			{operational ? <StaleServiceCallout staleService={staleService} /> : null}
			{operational ? <GitIdentityCallout gitIdentity={gitIdentity} /> : null}
			<Separator />
			{selection.projectId === null ? null : <nav aria-label={catalog.operatorNavigationLabel}>
				<ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible">
					{SURFACES.map((surface) => (
						<li key={surface.surface}>
							<a
								aria-current={surface.surface === selection.surface ? 'page' : undefined}
								className={cn(
									NAV_LINK_CLASS,
									surface.surface === selection.surface && 'bg-sidebar-accent text-sidebar-accent-foreground',
								)}
								href={`/projects/${encodeURIComponent(selection.projectId ?? '')}${surface.suffix}`}
							>
								{catalog.routeLabels[surface.label]}
							</a>
						</li>
					))}
				</ul>
			</nav>}
			<label className="flex flex-col gap-1 text-sidebar-foreground text-xs lg:mt-auto" htmlFor="gateship-locale">
				<span className="font-medium">{catalog.languageLabel}</span>
				<select
					className="w-full rounded-md border border-sidebar-border bg-sidebar-accent px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
					id="gateship-locale"
					onChange={(event) => onSelectLocale((event.currentTarget as unknown as { value: Locale }).value)}
					value={locale}
				>
					<option value="en-US">English (US)</option>
					<option value="pt-BR">Português (Brasil)</option>
				</select>
			</label>
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
						<input
							className={FIELD_CLASS}
							id="project-root"
							name="project-root"
							placeholder={catalog.register.rootPlaceholder}
						/>
						<span className="text-muted-foreground text-xs">{catalog.register.rootGuidance}</span>
						<span className="text-muted-foreground text-xs">{catalog.register.containerGuidance}</span>
					</label>
					<button className={BUTTON_CLASS} disabled={pending} type="submit">
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
						<input
							className={FIELD_CLASS}
							id="project-import-repository"
							name="project-import-repository"
							placeholder={catalog.import.repositoryPlaceholder}
						/>
						<span className="text-muted-foreground text-xs">{catalog.import.destinationGuidance}</span>
						<span className="text-muted-foreground text-xs">{catalog.import.credentialGuidance}</span>
					</label>
					<button className={BUTTON_CLASS} disabled={pending} type="submit">
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
						<input
							className={FIELD_CLASS}
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
						<input
							className={FIELD_CLASS}
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
						<select
							className={FIELD_CLASS}
							id="project-create-visibility"
							name="project-create-visibility"
							onChange={(event) => {
								setVisibility((event.currentTarget as unknown as {
									value: 'private' | 'public';
								}).value);
								setConfirmed(false);
							}}
							value={visibility}
						>
							<option value="private">{catalog.create.privateLabel}</option>
							<option value="public">{catalog.create.publicLabel}</option>
						</select>
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
					<button className={BUTTON_CLASS} disabled={pending || !confirmed || namedRepository === ''} type="submit">
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
					className={BUTTON_CLASS}
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

function OverviewSurface(props: AppProps): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].projects;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<div>
				<h2 className="font-semibold text-xl">{catalog.title}</h2>
				<p className="text-muted-foreground text-sm">{catalog.description}</p>
			</div>
			<ul className="grid gap-3">
				{props.projects.map((project) => (
					<li key={project.id}>
						<Card>
							<CardHeader>
								<div className="flex flex-wrap items-center gap-2">
									<CardTitle><a className={TEXT_LINK_CLASS} href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</a></CardTitle>
									{project.current ? <Badge variant="info">{catalog.currentBadge}</Badge> : null}
								</div>
								<CardDescription>{project.repository ?? catalog.repositoryUnknown}</CardDescription>
							</CardHeader>
							<CardPanel>
								<p className="text-sm"><span className="font-medium">{catalog.readinessLabel}:</span> {catalog.readiness[project.readiness]}</p>
							</CardPanel>
						</Card>
					</li>
				))}
			</ul>
			<CreateProjectPanel
				catalog={catalog}
				onCreateProject={props.onCreateProject}
				pending={props.pending}
				projectOnboardingPending={props.projectOnboardingPending}
			/>
			<div className="grid gap-3 md:grid-cols-2">
				<ImportProjectPanel
					catalog={catalog}
					onImportProject={props.onImportProject}
					pending={props.pending}
					projectOnboardingPending={props.projectOnboardingPending}
				/>
				<RegisterProjectPanel
					catalog={catalog}
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
						<a className={TEXT_LINK_CLASS} href={`/projects/${encodeURIComponent(props.projects.find((project) => project.current)?.id ?? '')}/runs`}>
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
				<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="review-scope" onChange={(event) => setScope((event.currentTarget as unknown as { value: string }).value)} required value={scope} />
			</label>
			<label className="flex flex-col gap-1 text-sm" htmlFor="review-command">
				<span className="font-medium">{catalog.form.verificationCommand}</span>
				<input className={cn(FIELD_CLASS, 'font-mono')} id="review-command" onChange={(event) => setVerificationCommand((event.currentTarget as unknown as { value: string }).value)} required value={verificationCommand} />
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
			<button className={BUTTON_CLASS} disabled={pending || !dirty} type="submit">{catalog.review.saveRevision}</button>
			<label className="flex items-start gap-2 text-sm">
				<input checked={confirmed} disabled={pending || dirty} onChange={(event) => setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>{catalog.review.confirmPersisted}</span>
			</label>
			<button
				className={PRIMARY_BUTTON_CLASS}
				disabled={pending || dirty || !confirmed}
				onClick={() => { setConfirmed(false); onApproveIssue(draft.id); }}
				type="button"
			>{catalog.review.approve}</button>
			<label className="flex flex-col gap-1 text-sm" htmlFor="abandon-reason">
				<span className="font-medium">{catalog.review.abandonReason}</span>
				<textarea className={cn(FIELD_CLASS, 'min-h-20')} id="abandon-reason" onChange={(event) => setAbandonReason((event.currentTarget as unknown as { value: string }).value)} value={abandonReason} />
			</label>
			<label className="flex items-start gap-2 text-sm">
				<input checked={abandonConfirmed} disabled={pending || abandonReason.trim().length === 0} onChange={(event) => setAbandonConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>{catalog.review.confirmAbandon(draft.id)}</span>
			</label>
			<button
				className={BUTTON_CLASS}
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
					<select
						className={FIELD_CLASS}
						id="review-issue"
						onChange={(event) =>
							setSelectedId((event.currentTarget as unknown as { value: string }).value || null)}
						value={selectedId ?? ''}
					>
						<option value="">{catalog.review.selectDraft}</option>
						{drafts.map((draft) => (
							<option key={draft.id} value={draft.id}>{draft.id} — {draft.title}</option>
						))}
					</select>
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
		<details className="rounded-md border border-border p-3 text-sm">
			<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
				<Badge variant={diagnosticSeverityVariant(finding.severity)}>{catalog.diagnostics.severityLabels[finding.severity]}</Badge>
				<span className="font-medium">{finding.rule}</span>
				<code className="break-all text-xs text-muted-foreground">{diagnosticFindingLocation(finding)}</code>
				{finding.occurrenceCount > 1 ? <Badge variant="outline">{catalog.diagnostics.occurrences(formatCount(finding.occurrenceCount, locale))}</Badge> : null}
			</summary>
			<div className="mt-4 flex flex-col gap-4">
				<p className="whitespace-pre-wrap break-words text-muted-foreground">{finding.evidence}</p>
				<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
					<span>{catalog.diagnostics.toolVersion(finding.toolVersion)}</span>
					<code>{finding.sourceSha.slice(0, 12)}</code>
				</div>
				<ActionButton enabled={!pending} label={catalog.diagnostics.dismiss} onClick={() => onDismiss(finding.id)} />
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
						<input className={FIELD_CLASS} defaultValue={catalog.diagnostics.defaultIssueTitle(finding.rule, finding.file).slice(0, 120)} name="diagnosticTitle" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.scope}</span>
						<textarea className={cn(FIELD_CLASS, 'min-h-24')} name="diagnosticScope" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.verificationCommand}</span>
						<input className={cn(FIELD_CLASS, 'font-mono')} name="diagnosticVerificationCommand" placeholder={catalog.form.verificationPlaceholder} required />
					</label>
					<button className={BUTTON_CLASS} disabled={pending} type="submit">{catalog.form.promote}</button>
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
		return <p className="text-muted-foreground text-sm">{catalog.diagnostics.noPending}</p>;
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
					<p className="text-muted-foreground text-sm">
						{catalog.proposals.emptyPending}
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
									label={catalog.proposals.dismiss}
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
										<span className="font-medium">{catalog.form.title}</span>
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
										<span className="font-medium">{catalog.form.scope}</span>
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
										<span className="font-medium">{catalog.form.verificationCommand}</span>
										<input
											className={cn(FIELD_CLASS, 'font-mono')}
											id={`proposal-command-${proposal.id}`}
											name="proposalVerificationCommand"
											placeholder={catalog.form.verificationPlaceholder}
											required
										/>
									</label>
									<button className={BUTTON_CLASS} disabled={pending} type="submit">
										{catalog.form.promote}
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
					<p className="text-muted-foreground text-sm">
						{catalog.proposals.emptyResolved}
					</p>
				) : (
					<ul className="flex flex-col gap-4">
						{resolvedProposals.map((proposal) => (
							<li className="flex min-w-0 flex-col gap-2 text-sm" key={proposal.id}>
								<div className="flex flex-wrap items-center gap-2">
									<span className="break-words font-medium">{proposal.title}</span>
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
 * Work is two things stacked in one column (GSHIP-712). Above the separator is
 * the project-scoped core -- approved backlog, drafts to review or approve,
 * ideas to specify and intake -- every panel of which reads and commands the
 * project the browser path names. Below it are the extras that still belong to
 * the boot runtime alone: diagnostics, and the proposal inbox with its resolved
 * history. `bootRuntimeExtras` is false for any other project, so those extras
 * are absent rather than showing the boot project's data under another name.
 */
function WorkSurface({
	bootRuntimeExtras,
	...props
}: AppProps & { bootRuntimeExtras: boolean }): React.ReactElement {
	const actions = actionsFor(props.runs[0] ?? null, props.selectedIssueId !== null);
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const catalog = localeCatalog.work;
	return (
		<SurfaceColumn label={localeCatalog.shell.routeLabels.work} status={props.status}>
			<BacklogPanel
				backlog={props.backlog}
				canStart={actions.start && !props.pending}
				catalog={catalog.backlog}
				locale={props.locale}
				onSelectIssue={props.onSelectIssue}
				onStart={props.onStart}
				selectedIssueId={props.selectedIssueId}
			/>
			<IssueReviewPanel catalog={catalog} drafts={props.drafts} locale={props.locale} onAbandonIssue={props.onAbandonIssue} onApproveIssue={props.onApproveIssue} onReviewIssue={props.onReviewIssue} pending={props.pending} runs={props.runs} />
			<IssueSpecifyPanel
				catalog={catalog}
				ideas={props.ideas}
				onSpecifyIssue={props.onSpecifyIssue}
				pending={props.pending}
			/>
			<IssueIntakePanel catalog={catalog} onCreateIssue={props.onCreateIssue} pending={props.pending} />
			{bootRuntimeExtras ? (
				<>
					<Separator />
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
				</>
			) : null}
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
					<input
						className={FIELD_CLASS}
						defaultValue={operatorProfile.name}
						id="operator-name"
						name="operator-name"
						placeholder={catalog.operator.namePlaceholder}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="operator-timezone">
					<span className="font-medium">{catalog.operator.timezone}</span>
					<input
						className={FIELD_CLASS}
						defaultValue={initialTimezone}
						id="operator-timezone"
						name="operator-timezone"
						placeholder={catalog.operator.timezonePlaceholder}
					/>
					<span className="text-muted-foreground text-xs">
						{catalog.operator.timezoneGuidance}
					</span>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					{catalog.operator.save}
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

function SettingsSurface(props: AppProps): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].settings;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<ProjectPanel catalog={catalog} project={props.project} />
			<OperatorProfilePanel
				catalog={catalog}
				onSaveOperatorProfile={props.onSaveOperatorProfile}
				operatorProfile={props.operatorProfile}
				pending={props.pending}
				suggestedTimezone={props.suggestedTimezone}
			/>
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
			<ChainRunsPanel
				catalog={catalog}
				chainRuns={props.chainRuns}
				onSetChainRuns={props.onSetChainRuns}
				pending={props.pending}
			/>
			<SelfUpdatePanel
				catalog={catalog}
				locale={props.locale}
				onSetSelfUpdate={props.onSetSelfUpdate}
				pending={props.pending}
				selfUpdate={props.selfUpdate}
			/>
			<DiagnosticSchedulePanel
				catalog={catalog}
				diagnostics={props.diagnostics}
				locale={props.locale}
				onSaveDiagnosticSchedule={props.onSaveDiagnosticSchedule}
				pending={props.pending}
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
			<ProjectBriefPanel
				brief={props.brief}
				catalog={catalog}
				onSaveBrief={props.onSaveBrief}
				pending={props.pending}
			/>
			<HandoffPanel catalog={catalog} handoff={props.handoff} />
		</SurfaceColumn>
	);
}

/**
 * GSHIP-707, GSHIP-712: runs and work are operational for any registered ready
 * project, reading and commanding that project's own runtime. Conversation and
 * settings still belong to the boot project alone, and a project the registry
 * does not report ready keeps the same typed answer it always had.
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
		if (surface === 'runs') return <RunsSurface {...props} />;
		if (surface === 'work') return <WorkSurface {...props} bootRuntimeExtras={false} />;
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
	if (selection.surface === 'overview') return <OverviewSurface {...props} />;
	if (selectedProject === null) {
		return (
			<SurfaceColumn label={localeCatalog.projects.notFoundTitle} status={props.status}>
				<h2 className="font-semibold text-xl">{localeCatalog.projects.notFoundTitle}</h2>
				<p className="text-muted-foreground text-sm">{localeCatalog.projects.notFoundDescription}</p>
			</SurfaceColumn>
		);
	}
	if (!selectedProject.current) {
		return (
			<NonCurrentProjectSurface
				props={props}
				selectedProject={selectedProject}
				surface={selection.surface}
			/>
		);
	}
	if (props.project.state !== 'ready' && selection.surface !== 'settings') {
		return (
			<OnboardingSurface
				catalog={localeCatalog.onboarding}
				project={props.project}
				settingsHref={`/projects/${encodeURIComponent(selectedProject.id)}/settings`}
				status={props.status}
			/>
		);
	}
	if (selection.surface === 'runs') return <RunsSurface {...props} />;
	if (selection.surface === 'work') return <WorkSurface {...props} bootRuntimeExtras />;
	if (selection.surface === 'settings') return <SettingsSurface {...props} />;
	return <HomeSurface {...props} />;
}

export function App(props: AppProps): React.ReactElement {
	// The array arrives newest first, so the operable run is its head and the
	// history below it is the same array, read once.
	const run = props.runs[0] ?? null;
	const currentProject = props.projects.find((project) => project.current) ?? null;
	const selection = routeSelection(props.route, currentProject?.id ?? null);
	const selectedProject = props.projects.find((project) => project.id === selection.projectId) ?? null;
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
				onSelectLocale={props.onSelectLocale}
				projects={props.projects}
				runInspectorCatalog={localeCatalog.runInspector}
				route={props.route}
				run={run}
				staleService={props.staleService}
				version={props.version}
				workspaceNotices={props.workspaceNotices}
			/>
			<SelectedRouteSurface props={props} selectedProject={selectedProject} selection={selection} />
		</div>
	);
}
