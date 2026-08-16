// webui/src/App.tsx
//
// The whole operational screen, as a pure function of its props: pick an
// issue, watch the run, and reach the four commands the runtime accepts. No
// fetching, no timers and no state live here, so every branch is reachable by
// static rendering (ADR-0067).

import type React from 'react';
import {
	Card,
	CardDescription,
	CardHeader,
	CardPanel,
	CardTitle,
} from '../vendor/coss/ui/card.tsx';
import { Badge } from '../vendor/coss/ui/badge.tsx';
import {
	Progress,
	ProgressIndicator,
	ProgressLabel,
	ProgressTrack,
	ProgressValue,
} from '../vendor/coss/ui/progress.tsx';
import { Separator } from '../vendor/coss/ui/separator.tsx';
import { cn } from '../vendor/coss/lib/utils.ts';
import type { OperatorIssueDraft } from './client.ts';
import {
	actionsFor,
	phaseOf,
	progressOf,
	type PlannableIssue,
	type RunView,
	toneOf,
} from './run-view.ts';

export interface AppProps {
	backlog: readonly PlannableIssue[];
	run: RunView | null;
	selectedIssueId: string | null;
	/** Last command outcome, or the last transport error. */
	status: string | null;
	/** A command is in flight; every button is held until it answers. */
	pending: boolean;
	onSelectIssue: (issueId: string) => void;
	onCreateIssue: (input: OperatorIssueDraft) => void;
	onStart: () => void;
	onResume: () => void;
	onCancel: () => void;
	onShip: () => void;
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
					<div className="flex flex-wrap gap-2">
						<ActionButton enabled={actions.resume && !pending} label="Retomar" onClick={onResume} />
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
			<BacklogPanel
				backlog={backlog}
				canStart={actions.start && !pending}
				onSelectIssue={props.onSelectIssue}
				onStart={props.onStart}
				selectedIssueId={selectedIssueId}
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
