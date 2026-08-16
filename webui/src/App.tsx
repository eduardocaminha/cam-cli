// webui/src/App.tsx
//
// The whole operational screen, as a pure function of its props: pick an
// issue, watch the run, and reach the four commands the runtime accepts. No
// fetching, no timers and no state live here, so every branch is reachable by
// static rendering (ADR-0067).

import type React from 'react';
import { cn } from '../vendor/coss/lib/utils.ts';
import { Badge } from '../vendor/coss/ui/badge.tsx';
import {
	Card,
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

export interface AppProps {
	backlog: readonly PlannableIssue[];
	ideas: readonly PlannableIssue[];
	events: readonly RunEventView[];
	workspaceNotices: readonly WorkspaceNoticeView[];
	providers: readonly ProviderStatusView[];
	chatMessages: readonly ChatMessageView[];
	selectedProvider: ProviderStatusView['id'];
	/** Newest first, exactly as /api/runs returned it. */
	runs: readonly RunView[];
	selectedIssueId: string | null;
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
	onSelectProvider: (providerId: ProviderStatusView['id']) => void;
	onSendMessage: (message: string) => void;
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

function RunActivity({
	run,
	events,
}: Pick<AppProps, 'events'> & { run: RunView | null }): React.ReactElement | null {
	if (run === null) return null;
	const visible = events
		.filter((event) => event.runId === run.id && isOperational(event))
		.slice(-30);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Atividade</CardTitle>
				<CardDescription>{visible.length} evento(s) recente(s) deste run.</CardDescription>
			</CardHeader>
			<CardPanel>
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
			</CardPanel>
		</Card>
	);
}

const BUTTON_CLASS =
	'inline-flex h-9 items-center justify-center rounded-md border px-3 font-medium text-sm ' +
	'transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
	'disabled:pointer-events-none disabled:opacity-50';

const FIELD_CLASS =
	'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ' +
	'placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

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
	if (run.summary !== null) {
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
	const waitingForAnswer = run?.state === 'waiting-user';
	return (
		<Card>
			<CardHeader>
				<CardTitle>Último run</CardTitle>
				<CardDescription>
					{run === null ? 'Nenhum run registrado ainda.' : `${run.issueId} · ${run.id}`}
				</CardDescription>
				{run !== null ? <Badge variant={toneOf(run.state)}>{run.state}</Badge> : null}
			</CardHeader>
			{run === null ? null : (
				<CardPanel className="flex flex-col gap-4">
					<RunProgress run={run} />
					<RunOutcome run={run} />
					{waitingForAnswer ? (
						<form
							className="flex flex-col gap-2"
							key={run.updatedAt}
							onSubmit={(event) => {
								event.preventDefault();
								const form = event.currentTarget as unknown as {
									elements: { namedItem: (name: string) => { value?: unknown } | null };
								};
								const value = form.elements.namedItem('operatorGuidance')?.value;
								if (typeof value === 'string') onResume(value);
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
							<button className={BUTTON_CLASS} disabled={pending} type="submit">
								Responder e retomar
							</button>
						</form>
					) : null}
					<div className="flex flex-wrap gap-2">
						{waitingForAnswer ? null : (
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
		<Card>
			<CardHeader>
				<CardTitle>Runs anteriores</CardTitle>
				<CardDescription>
					{previous.length} run(s) antes do último, do mais recente ao mais antigo.
				</CardDescription>
			</CardHeader>
			<CardPanel>
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
			</CardPanel>
		</Card>
	);
}

function WorkspaceNoticesPanel({
	workspaceNotices,
}: Pick<AppProps, 'workspaceNotices'>): React.ReactElement | null {
	if (workspaceNotices.length === 0) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Workspaces preservados</CardTitle>
				<CardDescription>
					{workspaceNotices.length} recurso(s) local(is) precisam de inspeção.
				</CardDescription>
			</CardHeader>
			<CardPanel>
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
			</CardPanel>
		</Card>
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
		<Card>
			<CardHeader>
				<CardTitle>Agentes locais</CardTitle>
				<CardDescription>
					Gateship usa a assinatura dos clientes instalados e nunca recebe tokens.
				</CardDescription>
			</CardHeader>
			<CardPanel>
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
			</CardPanel>
		</Card>
	);
}

function ConversationPanel({
	chatMessages,
	pending,
	onSendMessage,
}: Pick<AppProps, 'chatMessages' | 'pending' | 'onSendMessage'>): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Conversa com o orquestrador</CardTitle>
				<CardDescription>
					Ele pode investigar o projeto; ações passam pelo runtime determinístico.
				</CardDescription>
			</CardHeader>
			<CardPanel className="flex flex-col gap-4">
				{chatMessages.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						Descreva o objetivo, peça uma investigação ou dê um comando em linguagem natural.
					</p>
				) : (
					<ol className="flex max-h-96 flex-col gap-3 overflow-auto">
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
				)}
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						const form = event.currentTarget as unknown as {
							elements: { namedItem: (name: string) => { value?: unknown } | null };
							reset: () => void;
						};
						const value = form.elements.namedItem('message')?.value;
						if (typeof value === 'string' && value.trim().length > 0) {
							onSendMessage(value.trim());
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
					<button className={BUTTON_CLASS} disabled={pending} type="submit">
						Enviar
					</button>
				</form>
			</CardPanel>
		</Card>
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
		<Card>
			<CardHeader>
				<CardTitle>Backlog plannable</CardTitle>
				<CardDescription>{backlog.length} issue(s) admissível(is) agora.</CardDescription>
			</CardHeader>
			<CardPanel className="flex flex-col gap-3">
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
			</CardPanel>
		</Card>
	);
}

function IssueIntakePanel({
	pending,
	onCreateIssue,
}: Pick<AppProps, 'pending' | 'onCreateIssue'>): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Nova tarefa</CardTitle>
				<CardDescription>
					Vai direto ao backlog executável; o comando será o gate determinístico.
				</CardDescription>
			</CardHeader>
			<CardPanel>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						const fields = (event.currentTarget as unknown as {
							elements: { namedItem: (name: string) => { value?: unknown } | null };
						}).elements;
						const value = (name: string): string => {
							const field = fields.namedItem(name);
							return field?.value === undefined ? '' : String(field.value).trim();
						};
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
			</CardPanel>
		</Card>
	);
}

function IssueSpecifyPanel({
	ideas,
	pending,
	onSpecifyIssue,
}: Pick<AppProps, 'ideas' | 'pending' | 'onSpecifyIssue'>): React.ReactElement | null {
	if (ideas.length === 0) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Especificar ideia existente</CardTitle>
				<CardDescription>
					Promove a ideia com o mesmo contrato direto, sem planner intermediário.
				</CardDescription>
			</CardHeader>
			<CardPanel>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						const fields = (event.currentTarget as unknown as {
							elements: { namedItem: (name: string) => { value?: unknown } | null };
						}).elements;
						const value = (name: string): string => {
							const field = fields.namedItem(name);
							return field?.value === undefined ? '' : String(field.value).trim();
						};
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
			</CardPanel>
		</Card>
	);
}

export function App(props: AppProps): React.ReactElement {
	const { backlog, runs, selectedIssueId, status, pending } = props;
	// The array arrives newest first, so the operable run is its head and the
	// history below it is the same array, read once.
	const run = runs[0] ?? null;
	const actions = actionsFor(run, selectedIssueId !== null);
	return (
		<main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
			<header className="flex items-center justify-between">
				<h1 className="font-heading font-semibold text-2xl">gateship</h1>
				<Badge variant={run === null ? 'outline' : toneOf(run.state)}>
					{run === null ? 'ocioso' : run.state}
				</Badge>
			</header>
			<Separator />
			<ConversationPanel
				chatMessages={props.chatMessages}
				onSendMessage={props.onSendMessage}
				pending={pending}
			/>
			<RunPanel
				onCancel={props.onCancel}
				onResume={props.onResume}
				onShip={props.onShip}
				pending={pending}
				run={run}
			/>
			<RunActivity events={props.events} run={run} />
			<PreviousRunsPanel runs={runs} />
			<WorkspaceNoticesPanel workspaceNotices={props.workspaceNotices} />
			<ProvidersPanel
				onConnectCodex={props.onConnectCodex}
				onSelectProvider={props.onSelectProvider}
				pending={pending}
				providers={props.providers}
				selectedProvider={props.selectedProvider}
			/>
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
			{status === null ? null : (
				<output aria-live="polite" className="text-muted-foreground text-sm">
					{status}
				</output>
			)}
		</main>
	);
}
