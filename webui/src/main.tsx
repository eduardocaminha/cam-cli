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
	fetchLatestRun,
	fetchPlannable,
	type RunAction,
	startRun,
} from './client.ts';
import type { PlannableIssue, RunView } from './run-view.ts';
import './index.css';

function useOperationalRun(): {
	backlog: PlannableIssue[];
	run: RunView | null;
	status: string | null;
	pending: boolean;
	send: (command: () => Promise<string>) => void;
} {
	const [backlog, setBacklog] = useState<PlannableIssue[]>([]);
	const [run, setRun] = useState<RunView | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const refresh = useCallback(() => {
		void Promise.all([fetchLatestRun(), fetchPlannable()])
			.then(([latest, plannable]) => {
				setRun(latest);
				setBacklog(plannable);
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
		const events = new EventSource(EVENTS_PATH);
		events.addEventListener('run-event', refresh);
		return () => events.close();
	}, [refresh]);

	return { backlog, run, status, pending, send };
}

function Screen(): ReactElement {
	const { backlog, run, status, pending, send } = useOperationalRun();
	const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
	const command = (action: RunAction) => () => {
		if (run !== null) send(() => commandRun(run.id, action));
	};

	return (
		<App
			backlog={backlog}
			onCancel={command('cancel')}
			onCreateIssue={(draft) => {
				send(() => createIssue(draft).then((created) => {
					setSelectedIssueId(created.id);
					return `${created.id} criada e selecionada.`;
				}));
			}}
			onResume={command('resume')}
			onSelectIssue={setSelectedIssueId}
			onShip={command('ship')}
			onStart={() => {
				if (selectedIssueId !== null) send(() => startRun(selectedIssueId));
			}}
			pending={pending}
			run={run}
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
