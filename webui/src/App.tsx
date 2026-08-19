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

import React, { useEffect, useState } from 'react';
import { Badge } from './components/ui/badge.tsx';
import { GateshipLockup } from './components/gateship-logo.tsx';
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
import {
	aggregateChatTurnCosts,
	type ChainPauseReason,
	type ChainRunsView,
	type ChatMessageView,
	emptyModelSettings,
	type IssueReviewDraft,
	MODEL_PROVIDER_IDS,
	MODEL_ROLE_NAMES,
	type ModelRoleName,
	type ModelSettingsView,
	type ModelSlotView,
	type OperatorIssueDraft,
	type OperatorSpecDraft,
	type ProjectBriefView,
	type ProposalView,
	type ProviderStatusView,
	type StaleServiceView,
	type WorkspaceNoticeView,
} from './client.ts';
import { useLiveEdge } from './live-edge.ts';
import {
	actionsFor,
	activeRunIssueId,
	aggregateRunCosts,
	attentionOf,
	attentionToneOf,
	type PlannableIssue,
	phaseOf,
	progressOf,
	type RunCostRole,
	type RunCostRoleUsage,
	type RunEventView,
	type RunView,
	toneOf,
} from './run-view.ts';
import type { BrowserNotificationPermission } from './notifications.ts';

/** The four paths the server answers with this document, and nothing else. */
export type OperatorRoute = '/' | '/runs' | '/work' | '/settings';

const SURFACES: readonly { path: OperatorRoute; label: string }[] = [
	{ path: '/', label: 'Conversa' },
	{ path: '/runs', label: 'Runs' },
	{ path: '/work', label: 'Trabalho' },
	{ path: '/settings', label: 'Ajustes' },
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
	backlog: readonly PlannableIssue[];
	ideas: readonly PlannableIssue[];
	drafts: readonly IssueReviewDraft[];
	/** Ideas captured by executed runs, still awaiting an operator decision. */
	proposals: readonly ProposalView[];
	events: readonly RunEventView[];
	workspaceNotices: readonly WorkspaceNoticeView[];
	providers: readonly ProviderStatusView[];
	chatMessages: readonly ChatMessageView[];
	/** The operator's own context, editable here and nowhere else. */
	brief: ProjectBriefView;
	/** What the orchestrator recorded about the session; read-only. */
	handoff: ProjectBriefView;
	/** Model and effort per (provider, role); empty text keeps the CLI default. */
	modelSettings: ModelSettingsView;
	/** Off by default: autonomy never turns itself on (GSHIP-638). */
	chainRuns: ChainRunsView;
	selectedProvider: ProviderStatusView['id'];
	notificationPermission: BrowserNotificationPermission;
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
	/** Last command outcome, or the last transport error. */
	status: string | null;
	/** A command is in flight; every button is held until it answers. */
	pending: boolean;
	onSelectIssue: (issueId: string) => void;
	onCreateIssue: (input: OperatorIssueDraft) => void;
	onSpecifyIssue: (issueId: string, input: OperatorSpecDraft) => void;
	onReviewIssue: (issueId: string, input: OperatorSpecDraft) => void;
	onApproveIssue: (issueId: string) => void;
	onDismissProposal: (proposalId: string) => void;
	onPromoteProposal: (proposalId: string, input: OperatorIssueDraft) => void;
	onStart: () => void;
	onResume: (operatorGuidance?: string) => void;
	onAbandon: () => void;
	onCancel: () => void;
	onShip: () => void;
	onConnectCodex: () => void;
	onEnableNotifications: () => void;
	onSelectProvider: (providerId: ProviderStatusView['id']) => void;
	onSendMessage: (message: string) => void;
	onSaveBrief: (brief: ProjectBriefView) => void;
	onSaveModelSettings: (settings: ModelSettingsView) => void;
	onSetChainRuns: (enabled: boolean) => void;
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

function eventDetail(event: RunEventView): string | null {
	const details: string[] = [];
	const text = event.payload['text'];
	if (typeof text === 'string' && text.trim().length > 0) details.push(text);
	const tools = event.payload['tools'];
	if (Array.isArray(tools) && tools.every((tool) => typeof tool === 'string')) {
		details.push(`Ferramentas: ${tools.join(', ')}`);
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
const COST_FORMAT = new Intl.NumberFormat('pt-BR', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});

function formatCostUsd(value: number): string {
	return COST_FORMAT.format(value);
}

const COST_ROLE_LABEL: Record<RunView['cost']['breakdown'][number]['role'], string> = {
	executor: 'Executor',
	reviewer: 'Revisor',
};

/** Compact token-count line for one breakdown entry; omits a count the CLI never reported. */
function formatTokenCounts(entry: RunView['cost']['breakdown'][number]): string | null {
	const parts: string[] = [];
	if (entry.inputTokens !== undefined) parts.push(`${entry.inputTokens} entrada`);
	if (entry.outputTokens !== undefined) parts.push(`${entry.outputTokens} saída`);
	if (entry.cacheReadInputTokens !== undefined) parts.push(`${entry.cacheReadInputTokens} cache lida`);
	if (entry.cacheCreationInputTokens !== undefined) parts.push(`${entry.cacheCreationInputTokens} cache criada`);
	return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The role heading's own line: effort beside the role name, thinking tokens
 * after it -- both properties of the invocation, not of any one model below
 * it (GSHIP-628) -- omitted individually when that role's invocations never
 * reported them, and the whole role label falls back to its bare name when
 * neither did.
 */
function formatRoleUsage(role: RunCostRole, usage: RunCostRoleUsage | undefined): string {
	const label = COST_ROLE_LABEL[role];
	const suffix = usage?.effort === undefined ? '' : ` (${usage.effort})`;
	const thinking = usage?.thinkingTokens === undefined ? '' : ` · ${usage.thinkingTokens} thinking`;
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
					<span className="text-muted-foreground text-xs group-open:hidden">abrir</span>
					<span className="hidden text-muted-foreground text-xs group-open:inline">fechar</span>
				</CardAction>
			</CardSummary>
			<CardPanel>{children}</CardPanel>
		</CardDisclosure>
	);
}

function RunActivity({
	run,
	events,
}: Pick<AppProps, 'events'> & { run: RunView | null }): React.ReactElement | null {
	if (run === null) return null;
	const visible = events
		.filter((event) => event.runId === run.id && isOperational(event))
		.slice(-30);
	return (
		<ContextPanel
			description={`${visible.length} evento(s) recente(s) deste run.`}
			open
			title="Atividade"
		>
			<ol className="flex max-h-80 flex-col gap-3 overflow-x-hidden overflow-y-auto">
				{visible.map((event) => {
					const detail = eventDetail(event);
					return (
						<li className="min-w-0 border-border border-l-2 pl-3 text-sm" key={event.seq}>
							<div className="flex items-baseline justify-between gap-3">
								<code className="min-w-0 break-all">{event.kind}</code>
								<time className="shrink-0 text-muted-foreground">
									{event.createdAt.slice(11, 19)}
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

function RunProgress({ run }: { run: RunView }): React.ReactElement {
	return (
		<Progress label={`Fase ${phaseOf(run.state)}`} value={Math.round(progressOf(run.state) * 100)} />
	);
}

/**
 * The commands the run admits right now, and only those: a command the runtime
 * would refuse is not rendered as a dead button. `pending` still holds the ones
 * that are offered, so a command in flight cannot be issued twice.
 */
function RunCommands({
	run,
	pending,
	onResume,
	onAbandon,
	onCancel,
	onShip,
}: Pick<AppProps, 'pending' | 'onResume' | 'onAbandon' | 'onCancel' | 'onShip'> & {
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
			label: 'Retomar',
			shown: actions.resume && run?.state !== 'waiting-user',
			onClick: () => onResume(),
		},
		// The other way out of an interrupted run: end it here, without reopening
		// the provider session, so the next issue is no longer blocked by it.
		{ label: 'Abandonar', shown: actions.abandon, onClick: onAbandon },
		{ label: 'Cancelar', shown: actions.cancel, onClick: onCancel },
		{ label: 'Shipar', shown: actions.ship, onClick: onShip },
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
	run,
	title,
	footer,
	pending,
	onResume,
	onAbandon,
	onCancel,
	onShip,
}: Pick<AppProps, 'pending' | 'onResume' | 'onAbandon' | 'onCancel' | 'onShip'> & {
	run: RunView | null;
	title: string;
	footer?: React.ReactNode;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription className="break-all">
					{run === null ? 'Nenhum run registrado ainda.' : run.issueId}
				</CardDescription>
				{run === null ? null : <Badge variant={toneOf(run.state)}>{run.state}</Badge>}
			</CardHeader>
			{run === null && footer === undefined ? null : (
				<CardPanel className="flex flex-col gap-4">
					{run === null ? null : <RunProgress run={run} />}
					{run === null || run.cost.totalCostUsd === null ? null : (
						<p className="text-muted-foreground text-sm">
							Custo esperado: {formatCostUsd(run.cost.totalCostUsd)}
						</p>
					)}
					<RunCommands
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
function RunReport({ run }: { run: RunView }): React.ReactElement | null {
	if (run.summary === null && run.error === null) return null;
	return (
		<ContextPanel
			description="Relato completo do runtime e o identificador técnico do run."
			title="Resumo e diagnóstico"
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
function RunCostPanel({ run }: { run: RunView }): React.ReactElement | null {
	if (run.cost.breakdown.length === 0) return null;
	const roles: RunCostRole[] = [];
	for (const entry of run.cost.breakdown) {
		if (!roles.includes(entry.role)) roles.push(entry.role);
	}
	return (
		<ContextPanel
			description="Custo esperado equivalente ao uso via API, por papel e por modelo. Nunca é o valor cobrado da assinatura."
			title="Custo por papel e modelo"
		>
			<ul className="flex flex-col gap-4">
				{roles.map((role) => {
					const usage = run.cost.roles.find((entry) => entry.role === role);
					return (
						<li className="flex flex-col gap-2" key={role}>
							<p className="text-sm font-medium">{formatRoleUsage(role, usage)}</p>
							<ul className="flex flex-col gap-3 pl-3">
								{run.cost.breakdown.filter((entry) => entry.role === role).map((entry) => {
									const tokens = formatTokenCounts(entry);
									return (
										<li className="flex flex-col gap-1 text-sm" key={`${entry.role}-${entry.model}`}>
											<div className="flex items-baseline justify-between gap-3">
												<span className="min-w-0 break-all">{entry.model}</span>
												<span className="shrink-0 text-muted-foreground">
													{formatCostUsd(entry.costUsd)}
												</span>
											</div>
											{tokens === null ? null : (
												<span className="text-muted-foreground text-xs">{tokens} tokens</span>
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
 * needs to know about what already ran.
 */
function PreviousRunsPanel({ runs }: Pick<AppProps, 'runs'>): React.ReactElement | null {
	const previous = runs.slice(1, 1 + PREVIOUS_RUNS_SHOWN);
	if (previous.length === 0) return null;
	return (
		<ContextPanel
			description={`${previous.length} run(s) antes do último, do mais recente ao mais antigo.`}
			title="Runs anteriores"
		>
			<ul className="flex flex-col gap-2">
				{previous.map((run) => (
					<li className="flex items-baseline justify-between gap-3 text-sm" key={run.id}>
						<span className="min-w-0 break-all font-medium">{run.issueId}</span>
						<Badge variant={toneOf(run.state)}>{run.state}</Badge>
						{run.cost.totalCostUsd === null ? null : (
							<span className="shrink-0 text-muted-foreground">
								Custo esperado: {formatCostUsd(run.cost.totalCostUsd)}
							</span>
						)}
						<time className="shrink-0 text-muted-foreground">
							{run.updatedAt.slice(0, 16).replace('T', ' ')}
						</time>
					</li>
				))}
			</ul>
		</ContextPanel>
	);
}

/**
 * The expected cost across exactly the runs this screen shows -- the current
 * run's card plus the history panel below it, no more and no less (GSHIP-628).
 * Never labeled as a project total or a billed amount, and the run count says
 * plainly which runs it covers so it is never mistaken for a wider "session".
 * Hidden entirely when none of those runs ever reported a cost, the same
 * absence-over-zero rule a single run's own card already follows.
 */
function RunsCostSummary({ runs }: Pick<AppProps, 'runs'>): React.ReactElement | null {
	const aggregate = aggregateRunCosts(runs.slice(0, 1 + PREVIOUS_RUNS_SHOWN));
	if (aggregate.totalCostUsd === null) return null;
	return (
		<p className="text-muted-foreground text-sm">
			Custo esperado agregado de {aggregate.runCount} run(s) (os já listados acima):{' '}
			{formatCostUsd(aggregate.totalCostUsd)}. Equivalente ao uso via API, nunca o total do projeto
			nem o valor cobrado da assinatura.
		</p>
	);
}

function WorkspaceNoticesPanel({
	workspaceNotices,
}: Pick<AppProps, 'workspaceNotices'>): React.ReactElement | null {
	if (workspaceNotices.length === 0) return null;
	return (
		<ContextPanel
			description={`${workspaceNotices.length} recurso(s) local(is) precisam de inspeção.`}
			open
			title="Workspaces preservados"
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
	if (provider.subscription) {
		return `Assinatura conectada${provider.plan === undefined ? '' : ` · ${provider.plan}`}`;
	}
	return provider.installed ? 'Instalado, sem assinatura conectada' : 'Cliente não encontrado';
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
					{provider.id === selectedProvider ? <Badge variant="secondary">em uso</Badge> : null}
				</p>
				<p className="break-words text-muted-foreground">{providerDescription(provider)}</p>
			</div>
			{provider.id === 'codex' && !provider.subscription && provider.installed ? (
				<ActionButton enabled={!pending} label="Conectar ChatGPT" onClick={onConnectCodex} />
			) : null}
			{provider.id === 'claude' && !provider.subscription && provider.installed ? (
				<code className="break-all text-muted-foreground">claude auth login</code>
			) : null}
			{provider.subscription && provider.id !== selectedProvider ? (
				<ActionButton
					enabled={!pending}
					label={`Usar ${provider.label}`}
					onClick={() => onSelectProvider(provider.id)}
				/>
			) : null}
		</li>
	);
}

function ProvidersPanel(props: ProviderPanelProps): React.ReactElement {
	return (
		<ContextPanel
			description="Gateship usa a assinatura dos clientes instalados e nunca recebe tokens."
			open
			title="Agentes locais"
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
	orchestrator: 'Orquestrador',
	executor: 'Executor',
	reviewer: 'Revisor',
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
				<span className="font-medium">{MODEL_ROLE_LABELS[role]} — modelo</span>
				<input
					className={cn(FIELD_CLASS, 'font-mono')}
					defaultValue={slot.model}
					id={`${providerId}-${role}-model`}
					name={`${providerId}-${role}-model`}
					placeholder="padrão do CLI"
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
					placeholder="padrão do CLI"
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
				Modelos de {MODEL_PROVIDER_LABELS[providerId]} na documentação oficial
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
				'Vale para o próximo agente iniciado, sem reiniciar o serviço. ' +
				'Vazio mantém o padrão do CLI. O campo é livre: um valor inválido é recusado ' +
				'pelo próprio CLI, com o erro dele, e não pelo Gateship.'
			}
			open
			title="Modelo e effort por papel"
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
					Salvar modelos
				</button>
			</form>
		</ContextPanel>
	);
}

/** One line per reason the queue is not advancing on its own (GSHIP-638). */
const CHAIN_PAUSE_LABELS: Readonly<Record<ChainPauseReason, string>> = {
	'chain-disabled': 'o interruptor está desligado.',
	'previous-run-not-done': 'a run anterior não terminou em done.',
	'no-admissible-issue': 'nenhuma issue admissível no backlog agora.',
	'run-active': 'uma run ainda está ativa.',
	'chain-start-failed': 'a tentativa de iniciar a próxima run falhou.',
};

/**
 * The switch that lets the runtime start the next admissible issue by itself
 * once a run ends in `done` (GSHIP-638). It creates no new authority: it only
 * starts what the operator already approved, and it never approves, reviews
 * or promotes anything on its own. Off by default, because autonomy never
 * turns itself on.
 */
function ChainRunsPanel({
	chainRuns,
	pending,
	onSetChainRuns,
}: Pick<AppProps, 'chainRuns' | 'pending' | 'onSetChainRuns'>): React.ReactElement {
	return (
		<ContextPanel
			description="Ao terminar uma run em done, inicia sozinho a próxima issue já aprovada, na ordem do id."
			open
			title="Encadeamento automático"
		>
			<div className="flex flex-col gap-3">
				<label className="flex items-center gap-2 text-sm">
					<input
						checked={chainRuns.enabled}
						disabled={pending}
						onChange={(event) =>
							onSetChainRuns((event.currentTarget as unknown as { checked: boolean }).checked)}
						type="checkbox"
					/>
					<span className="font-medium">Encadear runs aprovadas automaticamente</span>
				</label>
				{chainRuns.pause === null ? null : (
					<p className="text-muted-foreground text-sm">
						Fila parada: {CHAIN_PAUSE_LABELS[chainRuns.pause.reason]}
					</p>
				)}
			</div>
		</ContextPanel>
	);
}

function NotificationsPanel({
	notificationPermission,
	onEnableNotifications,
}: Pick<AppProps, 'notificationPermission' | 'onEnableNotifications'>): React.ReactElement {
	const active = notificationPermission === 'granted';
	const unavailable = notificationPermission === 'unsupported';
	const denied = notificationPermission === 'denied';
	const actionLabel = active
		? 'Notificações ativas'
		: denied
			? 'Notificações bloqueadas'
			: unavailable
				? 'Notificações indisponíveis'
				: 'Ativar notificações';
	return (
		<ContextPanel
			description="O navegador avisa quando um run precisa de você ou termina, sem conta ou token."
			open
			title="Notificações locais"
		>
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">
					{active ? 'Ativas neste navegador.' : null}
					{denied ? 'Bloqueadas nas permissões deste navegador.' : null}
					{unavailable ? 'Indisponíveis neste navegador.' : null}
					{notificationPermission === 'default' ? 'Permissão ainda não solicitada.' : null}
				</p>
				<ActionButton
					enabled={notificationPermission === 'default'}
					label={actionLabel}
					onClick={onEnableNotifications}
				/>
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
function ChatLog({ chatMessages }: Pick<AppProps, 'chatMessages'>): React.ReactElement {
	const liveEdge = useLiveEdge(chatMessages.at(-1)?.seq ?? null);
	return (
		<section
			aria-label="Transcrição da conversa"
			className="max-h-[60vh] min-h-24 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring xl:max-h-none"
			onScroll={liveEdge.onScroll}
			ref={liveEdge.ref}
			role="log"
			tabIndex={0}
		>
			{chatMessages.length === 0 ? (
				<p className="flex min-h-24 items-center justify-center text-center text-muted-foreground text-sm">
					Descreva o objetivo, peça uma investigação ou dê um comando em linguagem natural.
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
								<span>{message.role === 'operator' ? 'você' : message.role}</span>
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
function ChatCostSummary({ chatMessages }: Pick<AppProps, 'chatMessages'>): React.ReactElement | null {
	const aggregate = aggregateChatTurnCosts(chatMessages);
	if (aggregate.totalCostUsd === null) return null;
	return (
		<p className="text-muted-foreground text-sm">
			Custo esperado acumulado de {aggregate.turnCount} turno(s) do orquestrador:{' '}
			{formatCostUsd(aggregate.totalCostUsd)}. Equivalente ao uso via API, nunca o valor cobrado da
			assinatura.
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
}: Pick<AppProps, 'pending' | 'onResume'> & { run: RunView | null }): React.ReactElement | null {
	if (run === null || run.state !== 'waiting-user') return null;
	return (
		<section className="flex flex-col gap-2 rounded-md border border-warning/32 bg-warning/8 p-3">
			<p className="font-medium text-sm">O run está esperando sua decisão.</p>
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
					Sua resposta
				</label>
				<textarea
					className={FIELD_CLASS}
					disabled={pending}
					id="operator-guidance"
					name="operatorGuidance"
					placeholder="Decisão ou orientação para o agente"
					required
					rows={3}
				/>
				<button className={PRIMARY_BUTTON_CLASS} disabled={pending} type="submit">
					Responder e retomar
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
function ConversationColumn({
	run,
	chatMessages,
	status,
	pending,
	onResume,
	onSendMessage,
}: Pick<AppProps, 'chatMessages' | 'status' | 'pending' | 'onResume' | 'onSendMessage'> & {
	run: RunView | null;
}): React.ReactElement {
	return (
		<main className="flex min-h-0 w-full min-w-0 flex-1 flex-col p-4 lg:p-6">
			<Card className="flex min-h-0 flex-1 flex-col">
				<CardHeader>
					<CardTitle>Conversa com o orquestrador</CardTitle>
					<CardDescription>
						Ele pode investigar o projeto; ações passam pelo runtime determinístico.
					</CardDescription>
				</CardHeader>
				<CardPanel className="flex min-h-0 flex-1 flex-col gap-4">
					<ChatLog chatMessages={chatMessages} />
					<ChatCostSummary chatMessages={chatMessages} />
					<OperatorAnswer onResume={onResume} pending={pending} run={run} />
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
						<input
							className={cn(FIELD_CLASS, 'min-w-0')}
							disabled={pending}
							name="message"
							placeholder="O que você quer fazer agora?"
							required
						/>
						<button className={PRIMARY_BUTTON_CLASS} disabled={pending} type="submit">
							Enviar
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
			description={`${backlog.length} issue(s) admissível(is) agora.`}
			open
			title="Backlog plannable"
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
				<ActionButton enabled={canStart} label="Iniciar run" onClick={onStart} />
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
			description="Vai direto ao backlog executável; o comando será o gate determinístico."
			title="Nova tarefa"
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
					<span className="font-medium">Título</span>
					<input className={FIELD_CLASS} id="issue-title" name="title" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-scope">
					<span className="font-medium">Escopo e resultado esperado</span>
					<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="issue-scope" name="scope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="issue-command">
					<span className="font-medium">Comando de verificação</span>
					<input
						className={cn(FIELD_CLASS, 'font-mono')}
						id="issue-command"
						name="verificationCommand"
						placeholder="bun test"
						required
					/>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Criar tarefa
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
			description="Promove a ideia com o mesmo contrato direto, sem planner intermediário."
			title="Especificar ideia existente"
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
					<span className="font-medium">Ideia</span>
					<select className={FIELD_CLASS} id="idea-id" name="ideaId" required>
						{ideas.map((idea) => (
							<option key={idea.id} value={idea.id}>{idea.id} — {idea.title}</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-scope">
					<span className="font-medium">Escopo e resultado esperado</span>
					<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="idea-scope" name="ideaScope" required />
				</label>
				<label className="flex flex-col gap-1 text-sm" htmlFor="idea-command">
					<span className="font-medium">Comando de verificação</span>
					<input
						className={cn(FIELD_CLASS, 'font-mono')}
						id="idea-command"
						name="ideaVerificationCommand"
						placeholder="bun test"
						required
					/>
				</label>
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Especificar ideia
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
	{ name: 'decisions', label: 'Decisões' },
	{ name: 'constraints', label: 'Restrições' },
	{ name: 'openItems', label: 'Itens em aberto' },
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
			description="Contexto humano autoritativo, mantido por você. O orquestrador lê e nunca escreve."
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
					<span className="font-medium">Objetivo</span>
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
							placeholder="Um item por linha"
						/>
					</label>
				))}
				<button className={BUTTON_CLASS} disabled={pending} type="submit">
					Salvar brief
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
			description="Estado de sessão observado e gerado pelo orquestrador. Pode estar desatualizado; o brief acima prevalece."
			title="Handoff automático"
		>
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">somente leitura</Badge>
					<span className="text-muted-foreground text-sm">
						Reescrito a cada turno do orquestrador.
					</span>
				</div>
				<Separator />
				<div className="flex flex-col gap-1 text-sm">
					<span className="font-medium">Objetivo</span>
					<p className="whitespace-pre-wrap break-words text-muted-foreground">
						{handoff.objective === '' ? 'Nada registrado ainda.' : handoff.objective}
					</p>
				</div>
				{BRIEF_LISTS.map((field) => (
					<div className="flex flex-col gap-1 text-sm" key={field.name}>
						<span className="font-medium">{field.label}</span>
						{handoff[field.name].length === 0 ? (
							<p className="text-muted-foreground">Nada registrado ainda.</p>
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
			aria-label="Serviço desatualizado"
			className="flex flex-col gap-1 rounded-md bg-warning/8 p-3 text-warning-foreground dark:bg-warning/16"
		>
			<span className="font-medium text-sm">Reinicie o serviço</span>
			<p className="break-words text-xs">{staleService.detail}</p>
			<code className="break-all text-xs">boot {staleService.bootSha}</code>
			<code className="break-all text-xs">origin/main {staleService.currentSha}</code>
		</section>
	);
}

function ShellSidebar({
	route,
	run,
	staleService,
	version,
	workspaceNotices,
}: Pick<AppProps, 'staleService' | 'workspaceNotices'> & {
	route: OperatorRoute;
	run: RunView | null;
	version: string;
}): React.ReactElement {
	// The header answers one question -- is Gateship waiting on the operator --
	// so it carries the human state alone. The run's own state stays on the card.
	const attention = attentionOf(run, workspaceNotices);
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
				<Badge variant={attentionToneOf(attention)}>{attention}</Badge>
			</div>
			<StaleServiceCallout staleService={staleService} />
			<Separator />
			<nav aria-label="Superfícies do operador">
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
								{surface.label}
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
		>
			<StatusOutput status={status} />
			{children}
		</main>
	);
}

function HomeSurface(props: AppProps): React.ReactElement {
	const run = props.runs[0] ?? null;
	return (
		<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col xl:flex-row">
			<ConversationColumn
				chatMessages={props.chatMessages}
				onResume={props.onResume}
				onSendMessage={props.onSendMessage}
				pending={props.pending}
				run={run}
				status={props.status}
			/>
			<aside
				aria-label="Inspetor da execução"
				className="flex w-full min-w-0 flex-col gap-4 p-4 pt-0 lg:p-6 lg:pt-0 xl:w-96 xl:shrink-0 xl:overflow-y-auto xl:border-l xl:pt-6"
			>
				<RunCard
					footer={
						<a className={TEXT_LINK_CLASS} href="/runs">
							Ver detalhes da execução
						</a>
					}
					onAbandon={props.onAbandon}
					onCancel={props.onCancel}
					onResume={props.onResume}
					onShip={props.onShip}
					pending={props.pending}
					run={run}
					title="Execução atual"
				/>
			</aside>
		</div>
	);
}

function RunsSurface(props: AppProps): React.ReactElement {
	const run = props.runs[0] ?? null;
	return (
		<SurfaceColumn label="Execuções" status={props.status}>
			<RunCard
				onAbandon={props.onAbandon}
				onCancel={props.onCancel}
				onResume={props.onResume}
				onShip={props.onShip}
				pending={props.pending}
				run={run}
				title="Último run"
			/>
			{run === null ? null : <RunReport run={run} />}
			{run === null ? null : <RunCostPanel run={run} />}
			<RunActivity events={props.events} run={run} />
			<WorkspaceNoticesPanel workspaceNotices={props.workspaceNotices} />
			<PreviousRunsPanel runs={props.runs} />
			<RunsCostSummary runs={props.runs} />
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

/** The editable contract of one draft: its revision, and its approval. */
function IssueReviewForm({
	draft,
	pending,
	onReviewIssue,
	onApproveIssue,
}: Pick<AppProps, 'pending' | 'onReviewIssue' | 'onApproveIssue'> & {
	draft: IssueReviewDraft;
}): React.ReactElement {
	const [scope, setScope] = useState(draft.scope);
	const [verificationCommand, setVerificationCommand] = useState(draft.verificationCommand);
	const [confirmed, setConfirmed] = useState(false);

	useEffect(() => {
		setScope(draft.scope);
		setVerificationCommand(draft.verificationCommand);
		setConfirmed(false);
	}, [draft.id, draft.scope, draft.verificationCommand]);

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
				<span className="font-medium">Escopo e resultado esperado</span>
				<textarea className={cn(FIELD_CLASS, 'min-h-24')} id="review-scope" onChange={(event) => setScope((event.currentTarget as unknown as { value: string }).value)} required value={scope} />
			</label>
			<label className="flex flex-col gap-1 text-sm" htmlFor="review-command">
				<span className="font-medium">Comando de verificação</span>
				<input className={cn(FIELD_CLASS, 'font-mono')} id="review-command" onChange={(event) => setVerificationCommand((event.currentTarget as unknown as { value: string }).value)} required value={verificationCommand} />
			</label>
			{draft.evidence === undefined || draft.evidence.length === 0 ? null : (
				<div className="flex flex-col gap-2 text-sm">
					<span className="font-medium">Evidência checada no workspace da run</span>
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
			<button className={BUTTON_CLASS} disabled={pending || !dirty} type="submit">Salvar revisão</button>
			<label className="flex items-start gap-2 text-sm">
				<input checked={confirmed} disabled={pending || dirty} onChange={(event) => setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>Confirmo o scope e o verificationCommand persistidos.</span>
			</label>
			<button
				className={PRIMARY_BUTTON_CLASS}
				disabled={pending || dirty || !confirmed}
				onClick={() => { setConfirmed(false); onApproveIssue(draft.id); }}
				type="button"
			>Aprovar</button>
		</form>
	);
}

function IssueReviewPanel({
	drafts,
	pending,
	runs,
	onReviewIssue,
	onApproveIssue,
}: Pick<
	AppProps,
	'drafts' | 'pending' | 'runs' | 'onReviewIssue' | 'onApproveIssue'
>): React.ReactElement {
	const [selectedId, setSelectedId] = useState<string | null>(drafts[0]?.id ?? null);
	const selected = drafts.find((draft) => draft.id === selectedId) ?? null;
	// The run owns the issue file while it is in flight: revising, approving or
	// abandoning it would write on main what the ship closes on the run's branch.
	const ownedByRun = selected !== null && activeRunIssueId(runs) === selected.id;

	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>Revisar e aprovar</CardTitle>
				<CardDescription>{drafts.length} issue(s) open + specified.</CardDescription>
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
						<option value="">Selecione um draft</option>
						{drafts.map((draft) => (
							<option key={draft.id} value={draft.id}>{draft.id} — {draft.title}</option>
						))}
					</select>
				</label>
				{selected === null || !ownedByRun ? null : (
					<p className="text-muted-foreground text-sm">
						{selected.id} está sendo executada por uma run. O arquivo da issue pertence a ela
						até a run terminar, então revisar, aprovar e abandonar só voltam depois disso.
					</p>
				)}
				{selected === null || ownedByRun ? null : (
					<IssueReviewForm
						draft={selected}
						onApproveIssue={onApproveIssue}
						onReviewIssue={onReviewIssue}
						pending={pending}
					/>
				)}
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
				<CardTitle>Propostas derivadas</CardTitle>
				<CardDescription>{proposals.length} proposta(s) pendente(s).</CardDescription>
				<CardAction><Badge variant="secondary">{proposals.length}</Badge></CardAction>
			</CardSummary>
			<CardPanel className="flex flex-col gap-4">
				{proposals.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						Nenhuma proposta pendente. Um run registra aqui o que encontrou fora do escopo.
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
									label="Descartar"
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
										<span className="font-medium">Título</span>
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
										<span className="font-medium">Escopo e resultado esperado</span>
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
										<span className="font-medium">Comando de verificação</span>
										<input
											className={cn(FIELD_CLASS, 'font-mono')}
											id={`proposal-command-${proposal.id}`}
											name="proposalVerificationCommand"
											placeholder="bun test"
											required
										/>
									</label>
									<button className={BUTTON_CLASS} disabled={pending} type="submit">
										Promover
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

function WorkSurface(props: AppProps): React.ReactElement {
	const actions = actionsFor(props.runs[0] ?? null, props.selectedIssueId !== null);
	return (
		<SurfaceColumn label="Trabalho" status={props.status}>
			<BacklogPanel
				backlog={props.backlog}
				canStart={actions.start && !props.pending}
				onSelectIssue={props.onSelectIssue}
				onStart={props.onStart}
				selectedIssueId={props.selectedIssueId}
			/>
			<IssueReviewPanel drafts={props.drafts} onApproveIssue={props.onApproveIssue} onReviewIssue={props.onReviewIssue} pending={props.pending} runs={props.runs} />
			<ProposalsPanel
				onDismissProposal={props.onDismissProposal}
				onPromoteProposal={props.onPromoteProposal}
				pending={props.pending}
				proposals={props.proposals}
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

function SettingsSurface(props: AppProps): React.ReactElement {
	return (
		<SurfaceColumn label="Ajustes" status={props.status}>
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
			<NotificationsPanel
				notificationPermission={props.notificationPermission}
				onEnableNotifications={props.onEnableNotifications}
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
	return (
		<div className="flex min-h-screen w-full flex-col lg:flex-row xl:h-screen xl:overflow-hidden">
			<ShellSidebar
				route={props.route}
				run={run}
				staleService={props.staleService}
				version={props.version}
				workspaceNotices={props.workspaceNotices}
			/>
			{props.route === '/runs' ? <RunsSurface {...props} /> : null}
			{props.route === '/work' ? <WorkSurface {...props} /> : null}
			{props.route === '/settings' ? <SettingsSurface {...props} /> : null}
			{props.route === '/' ? <HomeSurface {...props} /> : null}
		</div>
	);
}
