// webui/src/App.tsx
//
// The whole operational screen, as a pure function of its props: an app shell
// whose primary surface is the conversation with the orchestrator, with the run
// it commands beside it and every secondary panel one in-page anchor away. No
// fetching, no timers and no state live here, so every branch is reachable by
// static rendering (ADR-0067) -- including the ones a collapsed panel hides,
// because disclosure is native <details> and never a mounted/unmounted branch.

import type React from 'react';
import { cn } from '../vendor/coss/lib/utils.ts';
import { Badge } from '../vendor/coss/ui/badge.tsx';
import {
	Card,
	CardAction,
	CardDescription,
	CardHeader,
	CardPanel,
	CardTitle,
} from '../vendor/coss/ui/card.tsx';
import {
	Progress,
	ProgressIndicator,
	ProgressLabel,
	ProgressTrack,
	ProgressValue,
} from '../vendor/coss/ui/progress.tsx';
import { Separator } from '../vendor/coss/ui/separator.tsx';
import type {
	ChatMessageView,
	OperatorIssueDraft,
	OperatorSpecDraft,
	ProviderStatusView,
	WorkspaceNoticeView,
} from './client.ts';
import {
	actionsFor,
	type PlannableIssue,
	phaseOf,
	progressOf,
	type RunEventView,
	type RunView,
	toneOf,
} from './run-view.ts';
import type { BrowserNotificationPermission } from './notifications.ts';

export interface AppProps {
	backlog: readonly PlannableIssue[];
	ideas: readonly PlannableIssue[];
	events: readonly RunEventView[];
	workspaceNotices: readonly WorkspaceNoticeView[];
	providers: readonly ProviderStatusView[];
	chatMessages: readonly ChatMessageView[];
	selectedProvider: ProviderStatusView['id'];
	notificationPermission: BrowserNotificationPermission;
	/** Newest first, exactly as /api/runs returned it. */
	runs: readonly RunView[];
	selectedIssueId: string | null;
	/** Binary serving this screen, read-only; empty renders nothing. */
	version: string;
	/** Last command outcome, or the last transport error. */
	status: string | null;
	/** A command is in flight; every button is held until it answers. */
	pending: boolean;
	onSelectIssue: (issueId: string) => void;
	onCreateIssue: (input: OperatorIssueDraft) => void;
	onSpecifyIssue: (issueId: string, input: OperatorSpecDraft) => void;
	onStart: () => void;
	onResume: (operatorGuidance?: string) => void;
	onCancel: () => void;
	onShip: () => void;
	onConnectCodex: () => void;
	onEnableNotifications: () => void;
	onSelectProvider: (providerId: ProviderStatusView['id']) => void;
	onSendMessage: (message: string) => void;
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
 * A secondary panel of the shell: the same card, disclosed natively so the
 * screen can carry everything the operator may need without the conversation
 * losing the viewport. The whole panel stays in the markup when it is closed,
 * which is what keeps it readable by static rendering and by find-in-page.
 */
function ContextPanel({
	id,
	title,
	description,
	open = false,
	children,
}: {
	id: string;
	title: string;
	description: string;
	open?: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Card className="group" id={id} render={<details open={open} />}>
			<CardHeader
				className="cursor-pointer list-none [&::-webkit-details-marker]:hidden"
				render={<summary />}
			>
				<CardTitle render={<h2 />}>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
				<CardAction render={<span aria-hidden="true" />}>
					<span className="text-muted-foreground text-xs group-open:hidden">abrir</span>
					<span className="hidden text-muted-foreground text-xs group-open:inline">fechar</span>
				</CardAction>
			</CardHeader>
			<CardPanel>{children}</CardPanel>
		</Card>
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
			id="atividade"
			open
			title="Atividade"
		>
			<ol className="flex max-h-80 flex-col gap-3 overflow-auto">
				{visible.map((event) => {
					const detail = eventDetail(event);
					return (
						<li className="border-border border-l-2 pl-3 text-sm" key={event.seq}>
							<div className="flex items-baseline justify-between gap-3">
								<code>{event.kind}</code>
								<time className="text-muted-foreground">{event.createdAt.slice(11, 19)}</time>
							</div>
							{detail === null ? null : (
								<p className="mt-1 whitespace-pre-wrap text-muted-foreground">{detail}</p>
							)}
						</li>
					);
				})}
			</ol>
		</ContextPanel>
	);
}

function RunProgress({ run }: { run: RunView }): React.ReactElement {
	const percent = Math.round(progressOf(run.state) * 100);
	return (
		<Progress value={percent}>
			<div className="flex items-baseline justify-between">
				<ProgressLabel>Fase {phaseOf(run.state)}</ProgressLabel>
				<ProgressValue />
			</div>
			<ProgressTrack>
				<ProgressIndicator />
			</ProgressTrack>
		</Progress>
	);
}

function RunOutcome({ run }: { run: RunView }): React.ReactElement | null {
	if (run.error !== null) {
		return (
			<p className="rounded-md bg-destructive/8 p-3 text-destructive-foreground text-sm">
				{run.error}
			</p>
		);
	}
	// While the run waits, its summary IS the question, and the conversation
	// column asks it: repeating it here would say the same thing twice.
	if (run.summary !== null && run.state !== 'waiting-user') {
		return <p className="text-muted-foreground text-sm">{run.summary}</p>;
	}
	return null;
}

function RunPanel({
	run,
	pending,
	onResume,
	onCancel,
	onShip,
}: Pick<AppProps, 'pending' | 'onResume' | 'onCancel' | 'onShip'> & {
	run: RunView | null;
}): React.ReactElement {
	// Only `start` depends on a backlog selection, and this panel never offers it.
	const actions = actionsFor(run, false);
	return (
		<Card id="run">
			<CardHeader>
				<CardTitle render={<h2 />}>Último run</CardTitle>
				<CardDescription>
					{run === null ? 'Nenhum run registrado ainda.' : `${run.issueId} · ${run.id}`}
				</CardDescription>
				{run !== null ? <Badge variant={toneOf(run.state)}>{run.state}</Badge> : null}
			</CardHeader>
			{run === null ? null : (
				<CardPanel className="flex flex-col gap-4">
					<RunProgress run={run} />
					<RunOutcome run={run} />
					<div className="flex flex-wrap gap-2">
						{run.state === 'waiting-user' ? null : (
							<ActionButton enabled={actions.resume && !pending} label="Retomar" onClick={onResume} />
						)}
						<ActionButton enabled={actions.cancel && !pending} label="Cancelar" onClick={onCancel} />
						<ActionButton enabled={actions.ship && !pending} label="Shipar" onClick={onShip} />
					</div>
				</CardPanel>
			)}
		</Card>
	);
}

/** How much history the operator needs to place the current run in a session. */
const PREVIOUS_RUNS_SHOWN = 4;

/**
 * The runs before the one the panel above commands, read-only: there is no
 * selection and no command here, only what an operator returning to the screen
 * needs to know about what already ran.
 */
function PreviousRunsPanel({ runs }: Pick<AppProps, 'runs'>): React.ReactElement | null {
	const previous = runs.slice(1, 1 + PREVIOUS_RUNS_SHOWN);
	if (previous.length === 0) return null;
	return (
		<ContextPanel
			description={`${previous.length} run(s) antes do último, do mais recente ao mais antigo.`}
			id="historico"
			title="Runs anteriores"
		>
			<ul className="flex flex-col gap-2">
				{previous.map((run) => (
					<li className="flex items-baseline justify-between gap-3 text-sm" key={run.id}>
						<span className="font-medium">{run.issueId}</span>
						<Badge variant={toneOf(run.state)}>{run.state}</Badge>
						<time className="text-muted-foreground">
							{run.updatedAt.slice(0, 16).replace('T', ' ')}
						</time>
					</li>
				))}
			</ul>
		</ContextPanel>
	);
}

function WorkspaceNoticesPanel({
	workspaceNotices,
}: Pick<AppProps, 'workspaceNotices'>): React.ReactElement | null {
	if (workspaceNotices.length === 0) return null;
	return (
		<ContextPanel
			description={`${workspaceNotices.length} recurso(s) local(is) precisam de inspeção.`}
			id="workspaces"
			open
			title="Workspaces preservados"
		>
			<ul className="flex flex-col gap-3">
				{workspaceNotices.map((notice) => (
					<li
						className="flex flex-col gap-1 text-sm"
						key={`${notice.kind}-${notice.runId}-${notice.workspacePath}-${notice.branch}`}
					>
						<div className="flex items-center gap-2">
							<Badge variant="outline">{notice.kind}</Badge>
							{notice.runId === null ? null : <code>{notice.runId}</code>}
						</div>
						<code className="break-all text-muted-foreground">
							{notice.workspacePath ?? notice.branch}
						</code>
						<p className="text-muted-foreground">{notice.detail}</p>
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
			<div>
				<p className="flex items-center gap-2 font-medium">
					{provider.label}
					{provider.id === selectedProvider ? <Badge variant="secondary">em uso</Badge> : null}
				</p>
				<p className="text-muted-foreground">{providerDescription(provider)}</p>
			</div>
			{provider.id === 'codex' && !provider.subscription && provider.installed ? (
				<ActionButton enabled={!pending} label="Conectar ChatGPT" onClick={onConnectCodex} />
			) : null}
			{provider.id === 'claude' && !provider.subscription && provider.installed ? (
				<code className="text-muted-foreground">claude auth login</code>
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
			id="agentes"
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
			id="notificacoes"
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

function ChatLog({ chatMessages }: Pick<AppProps, 'chatMessages'>): React.ReactElement {
	if (chatMessages.length === 0) {
		return (
			<p className="flex min-h-24 flex-1 items-center justify-center text-center text-muted-foreground text-sm">
				Descreva o objetivo, peça uma investigação ou dê um comando em linguagem natural.
			</p>
		);
	}
	return (
		<ol className="flex max-h-[60vh] min-h-0 flex-1 flex-col gap-3 overflow-auto xl:max-h-none">
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
						<span>{message.providerId}</span>
					</div>
					<p className="whitespace-pre-wrap">{message.text}</p>
				</li>
			))}
		</ol>
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
				<p className="whitespace-pre-wrap text-muted-foreground text-sm">{run.summary}</p>
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
		<main className="flex min-h-0 w-full flex-1 flex-col p-4 lg:p-6" id="conversa">
			<Card className="flex min-h-0 flex-1 flex-col">
				<CardHeader>
					<CardTitle render={<h2 />}>Conversa com o orquestrador</CardTitle>
					<CardDescription>
						Ele pode investigar o projeto; ações passam pelo runtime determinístico.
					</CardDescription>
				</CardHeader>
				<CardPanel className="flex min-h-0 flex-1 flex-col gap-4">
					<ChatLog chatMessages={chatMessages} />
					<OperatorAnswer onResume={onResume} pending={pending} run={run} />
					{status === null ? null : (
						<output aria-live="polite" className="text-muted-foreground text-sm">
							{status}
						</output>
					)}
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
							className={FIELD_CLASS}
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
			id="backlog"
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
									'w-full rounded-md px-3 py-2 text-left text-sm outline-none',
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
			id="nova-tarefa"
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
			id="ideias"
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
 * Where the shell can take the operator, in the order the panels appear. A link
 * exists only while its panel does, so navigation never points at nothing --
 * and it is plain in-page anchoring, with no router and no navigation state.
 */
function shellSections(props: AppProps): readonly { id: string; label: string }[] {
	return [
		{ id: 'conversa', label: 'Conversa', shown: true },
		{ id: 'run', label: 'Run atual', shown: true },
		{ id: 'atividade', label: 'Atividade', shown: props.runs.length > 0 },
		{ id: 'notificacoes', label: 'Notificações', shown: true },
		{ id: 'agentes', label: 'Agentes', shown: true },
		{ id: 'workspaces', label: 'Workspaces', shown: props.workspaceNotices.length > 0 },
		{ id: 'historico', label: 'Histórico', shown: props.runs.length > 1 },
		{ id: 'backlog', label: 'Backlog', shown: true },
		{ id: 'ideias', label: 'Ideias', shown: props.ideas.length > 0 },
		{ id: 'nova-tarefa', label: 'Tarefas', shown: true },
	].filter((section) => section.shown);
}

function ShellSidebar({
	run,
	version,
	sections,
}: {
	run: RunView | null;
	version: string;
	sections: readonly { id: string; label: string }[];
}): React.ReactElement {
	return (
		<header className="flex shrink-0 flex-col gap-4 border-sidebar-border border-b bg-sidebar p-4 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:self-start lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-6">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-baseline gap-2">
					<h1 className="font-heading font-semibold text-xl">gateship</h1>
					{version === '' ? null : (
						<span className="font-mono text-muted-foreground text-xs">v{version}</span>
					)}
				</div>
				<Badge variant={run === null ? 'outline' : toneOf(run.state)}>
					{run === null ? 'ocioso' : run.state}
				</Badge>
			</div>
			<Separator />
			<nav aria-label="Painéis do operador">
				<ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible">
					{sections.map((section) => (
						<li key={section.id}>
							<a className={NAV_LINK_CLASS} href={`#${section.id}`}>
								{section.label}
							</a>
						</li>
					))}
				</ul>
			</nav>
		</header>
	);
}

export function App(props: AppProps): React.ReactElement {
	const { backlog, runs, selectedIssueId, status, pending, version } = props;
	// The array arrives newest first, so the operable run is its head and the
	// history below it is the same array, read once.
	const run = runs[0] ?? null;
	const actions = actionsFor(run, selectedIssueId !== null);
	return (
		<div className="flex min-h-screen w-full flex-col lg:flex-row xl:h-screen xl:overflow-hidden">
			<ShellSidebar run={run} sections={shellSections(props)} version={version} />
			<div className="flex min-h-0 w-full flex-1 flex-col xl:flex-row">
				<ConversationColumn
					chatMessages={props.chatMessages}
					onResume={props.onResume}
					onSendMessage={props.onSendMessage}
					pending={pending}
					run={run}
					status={status}
				/>
				<aside
					aria-label="Contexto operacional"
					className="flex w-full flex-col gap-4 p-4 pt-0 lg:p-6 lg:pt-0 xl:w-96 xl:shrink-0 xl:overflow-y-auto xl:border-l xl:pt-6"
				>
					<RunPanel
						onCancel={props.onCancel}
						onResume={props.onResume}
						onShip={props.onShip}
						pending={pending}
						run={run}
					/>
					<RunActivity events={props.events} run={run} />
					<NotificationsPanel
						notificationPermission={props.notificationPermission}
						onEnableNotifications={props.onEnableNotifications}
					/>
					<ProvidersPanel
						onConnectCodex={props.onConnectCodex}
						onSelectProvider={props.onSelectProvider}
						pending={pending}
						providers={props.providers}
						selectedProvider={props.selectedProvider}
					/>
					<WorkspaceNoticesPanel workspaceNotices={props.workspaceNotices} />
					<PreviousRunsPanel runs={runs} />
					<BacklogPanel
						backlog={backlog}
						canStart={actions.start && !pending}
						onSelectIssue={props.onSelectIssue}
						onStart={props.onStart}
						selectedIssueId={selectedIssueId}
					/>
					<IssueSpecifyPanel
						ideas={props.ideas}
						onSpecifyIssue={props.onSpecifyIssue}
						pending={pending}
					/>
					<IssueIntakePanel onCreateIssue={props.onCreateIssue} pending={pending} />
				</aside>
			</div>
		</div>
	);
}
