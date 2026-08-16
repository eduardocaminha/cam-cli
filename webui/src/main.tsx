// webui/src/main.tsx
//
// The only impure module of the client: it owns the local state, mounts the
// pure screen, and subscribes to the server's event stream. There is no
// polling loop -- /api/events pushes every run transition, and the two GET
// routes are re-read only when an event or a command says something changed.
//
// Which surface to show is read from the browser path once, at mount: every
// link in the shell is a real navigation, so the document is rebuilt whenever
// the path changes and there is no navigation state to keep.

import { type ReactElement, StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, routeOf } from './App.tsx';
import {
	commandRun,
	createIssue,
	EVENTS_PATH,
	fetchBacklog,
	fetchBrief,
	fetchChat,
	fetchProviders,
	fetchRunEvents,
	fetchRuns,
	type RunAction,
	type ChatMessageView,
	type ProjectBriefView,
	type ProviderStatusView,
	saveBrief,
	sendChat,
	selectProvider,
	specifyIssue,
	startCodexLogin,
	startRun,
	type WorkspaceNoticeView,
} from './client.ts';
import {
	invalidatesSnapshot,
	type PlannableIssue,
	type RunEventView,
	type RunView,
} from './run-view.ts';
import {
	browserNotificationPermission,
	type BrowserNotificationPermission,
	notifyRunEvent,
	requestBrowserNotificationPermission,
} from './notifications.ts';
import './index.css';

/** What both records read as before the first refresh answers. */
const EMPTY_BRIEF: ProjectBriefView = {
	objective: '',
	decisions: [],
	constraints: [],
	openItems: [],
};

function useOperationalRun(): {
	backlog: PlannableIssue[];
	ideas: PlannableIssue[];
	runs: RunView[];
	events: RunEventView[];
	workspaceNotices: WorkspaceNoticeView[];
	chatMessages: ChatMessageView[];
	providers: ProviderStatusView[];
	selectedProvider: ProviderStatusView['id'];
	notificationPermission: BrowserNotificationPermission;
	brief: ProjectBriefView;
	handoff: ProjectBriefView;
	version: string;
	status: string | null;
	pending: boolean;
	enableNotifications: () => void;
	send: (command: () => Promise<string>) => void;
} {
	const [backlog, setBacklog] = useState<PlannableIssue[]>([]);
	const [ideas, setIdeas] = useState<PlannableIssue[]>([]);
	const [runs, setRuns] = useState<RunView[]>([]);
	const [events, setEvents] = useState<RunEventView[]>([]);
	const [workspaceNotices, setWorkspaceNotices] = useState<WorkspaceNoticeView[]>([]);
	const [chatMessages, setChatMessages] = useState<ChatMessageView[]>([]);
	const [providers, setProviders] = useState<ProviderStatusView[]>([]);
	const [selectedProvider, setSelectedProvider] = useState<ProviderStatusView['id']>('claude');
	const [notificationPermission, setNotificationPermission] = useState(
		browserNotificationPermission,
	);
	const [brief, setBrief] = useState<ProjectBriefView>(EMPTY_BRIEF);
	const [handoff, setHandoff] = useState<ProjectBriefView>(EMPTY_BRIEF);
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [version, setVersion] = useState('');

	const refresh = useCallback(() => {
		void Promise.all([fetchRuns(), fetchBacklog(), fetchProviders(), fetchChat(), fetchBrief()])
			.then(async ([runSnapshot, backlogSnapshot, providerSnapshot, chatSnapshot, briefSnapshot]) => {
				const latest = runSnapshot[0] ?? null;
				const history = latest === null ? [] : await fetchRunEvents(latest.id);
				setRuns(runSnapshot);
				setBacklog(backlogSnapshot.plannable);
				setIdeas(backlogSnapshot.ideas);
				setWorkspaceNotices(backlogSnapshot.workspaceNotices);
				setVersion(backlogSnapshot.version);
				setProviders(providerSnapshot.providers);
				setSelectedProvider(providerSnapshot.selected);
				setChatMessages(chatSnapshot);
				setBrief(briefSnapshot.brief);
				setHandoff(briefSnapshot.handoff);
				setEvents(history);
			})
			.catch((error: unknown) => setStatus(String(error)));
	}, []);

	const send = useCallback((command: () => Promise<string>) => {
		setPending(true);
		void command()
			.then(setStatus)
			.catch((error: unknown) => setStatus(String(error)))
			.finally(() => {
				setPending(false);
				refresh();
			});
	}, [refresh]);

	const enableNotifications = useCallback(() => {
		void requestBrowserNotificationPermission()
			.then((permission) => {
				setNotificationPermission(permission);
				setStatus(permission === 'granted'
					? 'Notificações locais ativadas.'
					: 'Notificações não foram autorizadas pelo navegador.');
			})
			.catch((error: unknown) => setStatus(String(error)));
	}, []);

	useEffect(() => {
		refresh();
		const source = new EventSource(EVENTS_PATH);
		source.addEventListener('run-event', (message) => {
			try {
				const data = (message as unknown as { data: string }).data;
				const event = JSON.parse(data) as RunEventView;
				notifyRunEvent(event);
				setEvents((current) => {
					const merged = new Map(current.map((item) => [item.seq, item]));
					merged.set(event.seq, event);
					return [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-200);
				});
				if (invalidatesSnapshot(event)) refresh();
			} catch {
				setStatus('Evento de atividade inválido.');
			}
		});
		return () => source.close();
	}, [refresh]);

	return {
		backlog,
		ideas,
		runs,
		events,
		workspaceNotices,
		chatMessages,
		providers,
		selectedProvider,
		notificationPermission,
		brief,
		handoff,
		version,
		status,
		pending,
		enableNotifications,
		send,
	};
}

function Screen(): ReactElement {
	const {
		backlog,
		ideas,
		runs,
		events,
		workspaceNotices,
		chatMessages,
		providers,
		selectedProvider,
		notificationPermission,
		brief,
		handoff,
		version,
		status,
		pending,
		enableNotifications,
		send,
	} = useOperationalRun();
	const run = runs[0] ?? null;
	const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
	const command = (action: RunAction) => () => {
		if (run !== null) send(() => commandRun(run.id, action));
	};

	return (
		<App
			backlog={backlog}
			brief={brief}
			chatMessages={chatMessages}
			events={events}
			handoff={handoff}
			ideas={ideas}
			notificationPermission={notificationPermission}
			onCancel={command('cancel')}
			onCreateIssue={(draft) => {
				send(() => createIssue(draft).then((created) => {
					setSelectedIssueId(created.id);
					return `${created.id} criada e selecionada.`;
				}));
			}}
			onSendMessage={(message) => send(() => sendChat(message))}
			onConnectCodex={() => {
				const loginWindow = window.open('about:blank', 'gateship-codex-login');
				send(() => startCodexLogin().then((authUrl) => {
					if (loginWindow === null) window.location.assign(authUrl);
					else loginWindow.location.assign(authUrl);
					return 'Login do Codex aberto no navegador.';
				}));
			}}
			onEnableNotifications={enableNotifications}
			onResume={(operatorGuidance) => {
				if (run !== null) send(() => commandRun(run.id, 'resume', operatorGuidance));
			}}
			onSaveBrief={(draft) => send(() => saveBrief(draft))}
			onSelectIssue={setSelectedIssueId}
			onSelectProvider={(providerId) => send(() => selectProvider(providerId))}
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
			providers={providers}
			route={routeOf(window.location.pathname)}
			runs={runs}
			selectedIssueId={selectedIssueId}
			selectedProvider={selectedProvider}
			status={status}
			version={version}
			workspaceNotices={workspaceNotices}
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
