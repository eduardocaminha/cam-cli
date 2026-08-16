// webui/src/main.tsx
//
// The only impure module of the client: it owns the local state, mounts the
// pure screen, and subscribes to the server's event stream. There is no
// polling loop -- /api/events pushes every run transition, and the two GET
// routes are re-read only when an event or a command says something changed.

import { type ReactElement, StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import {
	commandRun,
	createIssue,
	EVENTS_PATH,
	fetchBacklog,
	fetchRunEvents,
	fetchRuns,
	type RunAction,
	specifyIssue,
	startRun,
} from './client.ts';
import type { PlannableIssue, RunEventView, RunView } from './run-view.ts';
import './index.css';

function useOperationalRun(): {
	backlog: PlannableIssue[];
	ideas: PlannableIssue[];
	runs: RunView[];
	events: RunEventView[];
	status: string | null;
	pending: boolean;
	send: (command: () => Promise<string>) => void;
} {
	const [backlog, setBacklog] = useState<PlannableIssue[]>([]);
	const [ideas, setIdeas] = useState<PlannableIssue[]>([]);
	const [runs, setRuns] = useState<RunView[]>([]);
	const [events, setEvents] = useState<RunEventView[]>([]);
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const refresh = useCallback(() => {
		void Promise.all([fetchRuns(), fetchBacklog()])
			.then(async ([runSnapshot, backlogSnapshot]) => {
				const latest = runSnapshot[0] ?? null;
				const history = latest === null ? [] : await fetchRunEvents(latest.id);
				setRuns(runSnapshot);
				setBacklog(backlogSnapshot.plannable);
				setIdeas(backlogSnapshot.ideas);
				setEvents(history);
			})
			.catch((error: unknown) => setStatus(String(error)));
	}, []);

	const send = useCallback(
		(command: () => Promise<string>) => {
			setPending(true);
			void command()
				.then(setStatus)
				.catch((error: unknown) => setStatus(String(error)))
				.finally(() => {
					setPending(false);
					refresh();
				});
		},
		[refresh],
	);

	useEffect(() => {
		refresh();
		const source = new EventSource(EVENTS_PATH);
		source.addEventListener('run-event', (message) => {
			try {
				const data = (message as unknown as { data: string }).data;
				const event = JSON.parse(data) as RunEventView;
				setEvents((current) => {
					const merged = new Map(current.map((item) => [item.seq, item]));
					merged.set(event.seq, event);
					return [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-200);
				});
				if (event.fromState !== event.toState || event.kind === 'run.created') refresh();
			} catch {
				setStatus('Evento de atividade inválido.');
			}
		});
		return () => source.close();
	}, [refresh]);

	return { backlog, ideas, runs, events, status, pending, send };
}

function Screen(): ReactElement {
	const { backlog, ideas, runs, events, status, pending, send } = useOperationalRun();
	const run = runs[0] ?? null;
	const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
	const command = (action: RunAction) => () => {
		if (run !== null) send(() => commandRun(run.id, action));
	};

	return (
		<App
			backlog={backlog}
			events={events}
			ideas={ideas}
			onCancel={command('cancel')}
			onCreateIssue={(draft) => {
				send(() => createIssue(draft).then((created) => {
					setSelectedIssueId(created.id);
					return `${created.id} criada e selecionada.`;
				}));
			}}
			onResume={(operatorGuidance) => {
				if (run !== null) send(() => commandRun(run.id, 'resume', operatorGuidance));
			}}
			onSelectIssue={setSelectedIssueId}
			onShip={command('ship')}
			onSpecifyIssue={(issueId, draft) => {
				send(() => specifyIssue(issueId, draft).then((specified) => {
					setSelectedIssueId(specified.id);
					return `${specified.id} especificada e selecionada.`;
				}));
			}}
			onStart={() => {
				if (selectedIssueId !== null) send(() => startRun(selectedIssueId));
			}}
			pending={pending}
			runs={runs}
			selectedIssueId={selectedIssueId}
			status={status}
		/>
	);
}

const rootElement = document.getElementById('root');

if (!rootElement) {
	throw new Error('Missing #root element');
}

createRoot(rootElement).render(
	<StrictMode>
		<Screen />
	</StrictMode>,
);
