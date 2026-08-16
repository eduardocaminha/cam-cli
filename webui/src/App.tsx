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
import type { OperatorIssueDraft, OperatorSpecDraft } from './client.ts';
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
	run: RunView | null;
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

function RunActivity({ run, events }: Pick<AppProps, 'run' | 'events'>): React.ReactElement | null {
	if (run === null) return null;
	const visible = events.filter((event) => event.runId === run.id).slice(-30);
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
}: Pick<AppProps, 'run' | 'pending' | 'onResume' | 'onCancel' | 'onShip'>): React.ReactElement {
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
	const { backlog, run, selectedIssueId, status, pending } = props;
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
			<RunPanel
				onCancel={props.onCancel}
				onResume={props.onResume}
				onShip={props.onShip}
				pending={pending}
				run={run}
			/>
			<RunActivity events={props.events} run={run} />
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
