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
	abandonIssue,
	approveIssue,
	type ChainRunsView,
	commandRun,
	createIssue,
	dismissProposal,
	emptyNotificationChannels,
	EVENTS_PATH,
	fetchBacklog,
	fetchBrief,
	fetchChainRuns,
	fetchChat,
	fetchModelSettings,
	fetchNotificationChannels,
	fetchOperatorProfile,
	fetchProposals,
	fetchProjectStatus,
	fetchProviders,
	fetchResolvedProposals,
	fetchRunEvents,
	fetchRuns,
	type GitIdentityView,
	type NotificationChannelsView,
	type OperatorProfileView,
	promoteProposal,
	type RunAction,
	type ChatMessageView,
	type IssueReviewDraft,
	emptyModelSettings,
	type ModelSettingsView,
	type ProjectBriefView,
	type ProjectStatusView,
	type ProposalView,
	type ProviderStatusView,
	type ResolvedProposalView,
	saveBrief,
	saveChainRuns,
	saveModelSettings,
	saveOperatorProfile,
	sendChat,
	sendNotificationTest,
	selectProvider,
	specifyIssue,
	startCodexLogin,
	startRun,
	type StaleServiceView,
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

/** Off by default, same as a fresh install that never toggled it (GSHIP-638). */
const EMPTY_CHAIN_RUNS: ChainRunsView = { enabled: false, pause: null };

const CHECKING_PROJECT: ProjectStatusView = {
	state: 'checking',
	name: '',
	detail: 'Verificando o projeto local…',
};

const EMPTY_OPERATOR_PROFILE: OperatorProfileView = { name: '', timezone: '' };

function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	} catch {
		return '';
	}
}

function useOperationalRun(): {
	backlog: PlannableIssue[];
	ideas: PlannableIssue[];
	drafts: IssueReviewDraft[];
	proposals: ProposalView[];
	resolvedProposals: ResolvedProposalView[];
	resolvedProposalsOmittedCount: number;
	runs: RunView[];
	events: RunEventView[];
	workspaceNotices: WorkspaceNoticeView[];
	staleService: StaleServiceView | null;
	gitIdentity: GitIdentityView | null;
	chatMessages: ChatMessageView[];
	providers: ProviderStatusView[];
	selectedProvider: ProviderStatusView['id'];
	notificationPermission: BrowserNotificationPermission;
	brief: ProjectBriefView;
	handoff: ProjectBriefView;
	modelSettings: ModelSettingsView;
	chainRuns: ChainRunsView;
	notificationChannels: NotificationChannelsView;
	project: ProjectStatusView;
	operatorProfile: OperatorProfileView;
	version: string;
	status: string | null;
	pending: boolean;
	enableNotifications: () => void;
	send: (command: () => Promise<string>) => void;
} {
	const [backlog, setBacklog] = useState<PlannableIssue[]>([]);
	const [ideas, setIdeas] = useState<PlannableIssue[]>([]);
	const [drafts, setDrafts] = useState<IssueReviewDraft[]>([]);
	const [proposals, setProposals] = useState<ProposalView[]>([]);
	const [resolvedProposals, setResolvedProposals] = useState<ResolvedProposalView[]>([]);
	const [resolvedProposalsOmittedCount, setResolvedProposalsOmittedCount] = useState(0);
	const [runs, setRuns] = useState<RunView[]>([]);
	const [events, setEvents] = useState<RunEventView[]>([]);
	const [workspaceNotices, setWorkspaceNotices] = useState<WorkspaceNoticeView[]>([]);
	const [staleService, setStaleService] = useState<StaleServiceView | null>(null);
	const [gitIdentity, setGitIdentity] = useState<GitIdentityView | null>(null);
	const [chatMessages, setChatMessages] = useState<ChatMessageView[]>([]);
	const [providers, setProviders] = useState<ProviderStatusView[]>([]);
	const [selectedProvider, setSelectedProvider] = useState<ProviderStatusView['id']>('claude');
	const [notificationPermission, setNotificationPermission] = useState(
		browserNotificationPermission,
	);
	const [brief, setBrief] = useState<ProjectBriefView>(EMPTY_BRIEF);
	const [handoff, setHandoff] = useState<ProjectBriefView>(EMPTY_BRIEF);
	const [modelSettings, setModelSettings] = useState<ModelSettingsView>(emptyModelSettings);
	const [chainRuns, setChainRuns] = useState<ChainRunsView>(EMPTY_CHAIN_RUNS);
	const [notificationChannels, setNotificationChannels] = useState<NotificationChannelsView>(
		emptyNotificationChannels,
	);
	const [project, setProject] = useState<ProjectStatusView>(CHECKING_PROJECT);
	const [operatorProfile, setOperatorProfile] = useState<OperatorProfileView>(
		EMPTY_OPERATOR_PROFILE,
	);
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [version, setVersion] = useState('');

	const refresh = useCallback(() => {
		void Promise.all([
			fetchRuns(),
			fetchBacklog(),
			fetchProviders(),
			fetchChat(),
			fetchBrief(),
			fetchProposals(),
			fetchResolvedProposals(),
			fetchModelSettings(),
			fetchChainRuns(),
			fetchNotificationChannels(),
			fetchProjectStatus(),
			fetchOperatorProfile(),
		])
			.then(async ([
				runSnapshot,
				backlogSnapshot,
				providerSnapshot,
				chatSnapshot,
				briefSnapshot,
				proposalSnapshot,
				resolvedProposalSnapshot,
				modelSnapshot,
				chainRunsSnapshot,
				notificationChannelsSnapshot,
				projectSnapshot,
				operatorProfileSnapshot,
			]) => {
				const latest = runSnapshot[0] ?? null;
				const history = latest === null ? [] : await fetchRunEvents(latest.id);
				setRuns(runSnapshot);
				setBacklog(backlogSnapshot.plannable);
				setIdeas(backlogSnapshot.ideas);
				setDrafts(backlogSnapshot.drafts);
				setProposals(proposalSnapshot);
				setResolvedProposals(resolvedProposalSnapshot.proposals);
				setResolvedProposalsOmittedCount(resolvedProposalSnapshot.omittedCount);
				setWorkspaceNotices(backlogSnapshot.workspaceNotices);
				setStaleService(backlogSnapshot.staleService);
				setGitIdentity(backlogSnapshot.gitIdentity);
				setVersion(backlogSnapshot.version);
				setProviders(providerSnapshot.providers);
				setSelectedProvider(providerSnapshot.selected);
				setChatMessages(chatSnapshot);
				setBrief(briefSnapshot.brief);
				setHandoff(briefSnapshot.handoff);
				setModelSettings(modelSnapshot);
				setChainRuns(chainRunsSnapshot);
				setNotificationChannels(notificationChannelsSnapshot);
				setProject(projectSnapshot);
				setOperatorProfile(operatorProfileSnapshot);
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
		drafts,
		proposals,
		resolvedProposals,
		resolvedProposalsOmittedCount,
		runs,
		events,
		workspaceNotices,
		staleService,
		gitIdentity,
		chatMessages,
		providers,
		selectedProvider,
		notificationPermission,
		brief,
		handoff,
		modelSettings,
		chainRuns,
		notificationChannels,
		project,
		operatorProfile,
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
		drafts,
		proposals,
		resolvedProposals,
		resolvedProposalsOmittedCount,
		runs,
		events,
		workspaceNotices,
		staleService,
		gitIdentity,
		chatMessages,
		providers,
		selectedProvider,
		notificationPermission,
		brief,
		handoff,
		modelSettings,
		chainRuns,
		notificationChannels,
		project,
		operatorProfile,
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
			chainRuns={chainRuns}
			drafts={drafts}
			brief={brief}
			chatMessages={chatMessages}
			events={events}
			gitIdentity={gitIdentity}
			handoff={handoff}
			ideas={ideas}
			notificationChannels={notificationChannels}
			notificationPermission={notificationPermission}
			onAbandon={command('abandon')}
			onCancel={command('cancel')}
			onCreateIssue={(draft) => {
				send(() => createIssue(draft).then((created) => {
					setSelectedIssueId(created.id);
					return `${created.id} criada e selecionada.`;
				}));
			}}
			onDismissProposal={(proposalId) => send(() => dismissProposal(proposalId))}
			onPromoteProposal={(proposalId, draft) => {
				// The created issue is a draft to review, not the next run: it is
				// filed unapproved, so it is not selected to start either.
				send(() => promoteProposal(proposalId, draft).then((created) =>
					`${created.id} criada a partir da proposta.`));
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
			onSendNotificationTest={(channelId) => send(() => sendNotificationTest(channelId))}
			onResume={(operatorGuidance) => {
				if (run !== null) send(() => commandRun(run.id, 'resume', operatorGuidance));
			}}
			onSaveBrief={(draft) => send(() => saveBrief(draft))}
			onSaveModelSettings={(draft) => send(() => saveModelSettings(draft))}
			onSetChainRuns={(enabled) => send(() => saveChainRuns(enabled))}
			onSelectIssue={setSelectedIssueId}
			onSelectProvider={(providerId) => send(() => selectProvider(providerId))}
			onShip={command('ship')}
			onSpecifyIssue={(issueId, draft) => {
				send(() => specifyIssue(issueId, draft).then((specified) => {
					setSelectedIssueId(specified.id);
					return `${specified.id} especificada e selecionada.`;
				}));
			}}
			onApproveIssue={(issueId) => send(() => approveIssue(issueId).then(() => `${issueId} aprovada.`))}
			onAbandonIssue={(issueId, reason) => {
				send(() => abandonIssue(issueId, reason).then(() => `${issueId} abandonada.`));
			}}
			onReviewIssue={(issueId, draft) => {
				send(() => specifyIssue(issueId, draft).then(() => `${issueId} revisada.`));
			}}
			onStart={() => {
				if (selectedIssueId !== null) send(() => startRun(selectedIssueId));
			}}
			modelSettings={modelSettings}
			onSaveOperatorProfile={(profile) => send(() => saveOperatorProfile(profile))}
			pending={pending}
			proposals={proposals}
			project={project}
			operatorProfile={operatorProfile}
			providers={providers}
			resolvedProposals={resolvedProposals}
			resolvedProposalsOmittedCount={resolvedProposalsOmittedCount}
			route={routeOf(window.location.pathname)}
			runs={runs}
			selectedIssueId={selectedIssueId}
			selectedProvider={selectedProvider}
			staleService={staleService}
			status={status}
			suggestedTimezone={browserTimeZone()}
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
