// webui/src/main.tsx
//
// The only impure module of the client: it owns the local state, mounts the
// pure screen, and subscribes to the server's event stream. There is no
// general polling loop -- /api/events pushes run transitions. The one bounded
// exception polls only while an external diagnostic process is active.
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
	type ChatMessageView,
	cancelDiagnostic,
	commandRun,
	createIssue,
	type DiagnosticsView,
	dismissDiagnosticFinding,
	dismissProposal,
	EVENTS_PATH,
	emptyDiagnostics,
	emptyModelSettings,
	emptyNotificationChannels,
	emptySelfUpdate,
	fetchBacklog,
	fetchBrief,
	fetchChainRuns,
	fetchChat,
	fetchDiagnostics,
	fetchModelSettings,
	fetchNotificationChannels,
	fetchOperatorProfile,
	fetchProjectStatus,
	fetchProposals,
	fetchProviders,
	fetchResolvedProposals,
	fetchRunEvents,
	fetchRuns,
	fetchSelfUpdate,
	type GitIdentityView,
	type IssueReviewDraft,
	type ModelSettingsView,
	type NotificationChannelsView,
	type OperatorProfileView,
	type ProjectBriefView,
	type ProjectStatusView,
	type ProposalView,
	type ProviderStatusView,
	promoteDiagnosticFinding,
	promoteProposal,
	removeResendCredential,
	type ResolvedProposalView,
	type RunAction,
	type SelfUpdateView,
	type StaleServiceView,
	saveBrief,
	saveChainRuns,
	saveDiagnosticSchedule,
	saveModelSettings,
	saveOperatorProfile,
	saveResendSettings,
	saveSelfUpdate,
	selectProvider,
	sendChat,
	sendNotificationTest,
	specifyIssue,
	startCodexLogin,
	startDiagnostic,
	startRun,
	type WorkspaceNoticeView,
} from './client.ts';
import {
	applyLocalePreference,
	LOCALE_STORAGE_KEY,
	type Locale,
	readLocalePreference,
} from './locale.ts';
import {
	type BrowserNotificationPermission,
	browserNotificationPermission,
	notifyRunEvent,
	requestBrowserNotificationPermission,
} from './notifications.ts';
import {
	invalidatesSnapshot,
	type PlannableIssue,
	type RunEventView,
	type RunView,
} from './run-view.ts';
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
	detail: 'Checking the local project…',
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
	diagnostics: DiagnosticsView;
	selfUpdate: SelfUpdateView;
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
	const [diagnostics, setDiagnostics] = useState<DiagnosticsView>(emptyDiagnostics);
	const [selfUpdate, setSelfUpdate] = useState<SelfUpdateView>(emptySelfUpdate);
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
			fetchDiagnostics(),
			fetchSelfUpdate(),
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
				diagnosticsSnapshot,
				selfUpdateSnapshot,
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
				setDiagnostics(diagnosticsSnapshot);
				setSelfUpdate(selfUpdateSnapshot);
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
					? 'Local notifications enabled.'
					: 'The browser did not authorize notifications.');
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
				setStatus('Invalid activity event.');
			}
		});
		return () => source.close();
	}, [refresh]);

	useEffect(() => {
		const state = diagnostics.scan?.state;
		if (state !== 'queued' && state !== 'running') return;
		const interval = setInterval(() => {
			void fetchDiagnostics()
				.then(setDiagnostics)
				.catch((error: unknown) => setStatus(String(error)));
		}, 1_500);
		return () => clearInterval(interval);
	}, [diagnostics.scan?.state]);

	// Release checks and the restart helper do not emit run events. A small
	// read-only poll keeps Settings current across detection, handoff, rollback,
	// and the automatic EventSource reconnect after a successful restart.
	useEffect(() => {
		const interval = setInterval(() => {
			void fetchSelfUpdate()
				.then(setSelfUpdate)
				.catch((error: unknown) => setStatus(String(error)));
		}, selfUpdate.applying ? 1_500 : 30_000);
		return () => clearInterval(interval);
	}, [selfUpdate.applying]);

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
		diagnostics,
		selfUpdate,
		version,
		status,
		pending,
		enableNotifications,
		send,
	};
}

function Screen({ initialLocale }: { initialLocale: Locale }): ReactElement {
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
		diagnostics,
		selfUpdate,
		version,
		status,
		pending,
		enableNotifications,
		send,
	} = useOperationalRun();
	const run = runs[0] ?? null;
	const [locale, setLocale] = useState(initialLocale);
	const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
	const selectLocale = (selectedLocale: Locale) => {
		applyLocalePreference(
			selectedLocale,
			(value) => { document.documentElement.lang = value; },
			(key, value) => { window.localStorage.setItem(key, value); },
		);
		setLocale(selectedLocale);
	};
	const command = (action: RunAction) => () => {
		if (run !== null) send(() => commandRun(run.id, action));
	};

	return (
		<App
			backlog={backlog}
			chainRuns={chainRuns}
			diagnostics={diagnostics}
			drafts={drafts}
			brief={brief}
			chatMessages={chatMessages}
			events={events}
			gitIdentity={gitIdentity}
			handoff={handoff}
			ideas={ideas}
			locale={locale}
			notificationChannels={notificationChannels}
			notificationPermission={notificationPermission}
			onAbandon={command('abandon')}
			onCancel={command('cancel')}
			onCreateIssue={(draft) => {
				send(() => createIssue(draft).then((created) => {
					setSelectedIssueId(created.id);
					return `${created.id} created and selected.`;
				}));
			}}
			onDismissProposal={(proposalId) => send(() => dismissProposal(proposalId))}
			onCancelDiagnostic={(scanId) => send(() => cancelDiagnostic(scanId))}
			onDismissDiagnosticFinding={(findingId) =>
				send(() => dismissDiagnosticFinding(findingId))}
			onPromoteDiagnosticFinding={(findingId, draft) => {
				send(() => promoteDiagnosticFinding(findingId, draft).then((created) =>
					`${created.id} created from the diagnostic.`));
			}}
			onStartDiagnostic={(analyzer) => send(() => startDiagnostic(analyzer))}
			onPromoteProposal={(proposalId, draft) => {
				// The created issue is a draft to review, not the next run: it is
				// filed unapproved, so it is not selected to start either.
				send(() => promoteProposal(proposalId, draft).then((created) =>
					`${created.id} created from the proposal.`));
			}}
			onSendMessage={(message) => send(() => sendChat(message))}
			onConnectCodex={() => {
				const loginWindow = window.open('about:blank', 'gateship-codex-login');
				send(() => startCodexLogin().then((authUrl) => {
					if (loginWindow === null) window.location.assign(authUrl);
					else loginWindow.location.assign(authUrl);
					return 'Codex login opened in the browser.';
				}));
			}}
			onEnableNotifications={enableNotifications}
			onRemoveResendCredential={() => send(removeResendCredential)}
			onSaveResendSettings={(input) => send(() => saveResendSettings(input))}
			onSendNotificationTest={(channelId) => send(() => sendNotificationTest(channelId))}
			onResume={(operatorGuidance) => {
				if (run !== null) send(() => commandRun(run.id, 'resume', operatorGuidance));
			}}
			onSaveBrief={(draft) => send(() => saveBrief(draft))}
			onSaveDiagnosticSchedule={(enabled, cadence) =>
				send(() => saveDiagnosticSchedule(enabled, cadence))}
			onSaveModelSettings={(draft) => send(() => saveModelSettings(draft))}
			onSetChainRuns={(enabled) => send(() => saveChainRuns(enabled))}
			onSelectIssue={setSelectedIssueId}
			onSelectLocale={selectLocale}
			onSelectProvider={(providerId) => send(() => selectProvider(providerId))}
			onShip={command('ship')}
			onSpecifyIssue={(issueId, draft) => {
				send(() => specifyIssue(issueId, draft).then((specified) => {
					setSelectedIssueId(specified.id);
					return `${specified.id} specified and selected.`;
				}));
			}}
			onApproveIssue={(issueId) => send(() => approveIssue(issueId).then(() => `${issueId} approved.`))}
			onAbandonIssue={(issueId, reason) => {
				send(() => abandonIssue(issueId, reason).then(() => `${issueId} abandoned.`));
			}}
			onReviewIssue={(issueId, draft) => {
				send(() => specifyIssue(issueId, draft).then(() => `${issueId} revised.`));
			}}
			onStart={() => {
				if (selectedIssueId !== null) send(() => startRun(selectedIssueId));
			}}
			modelSettings={modelSettings}
			selfUpdate={selfUpdate}
			onSetSelfUpdate={(enabled) => send(() => saveSelfUpdate(enabled))}
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

const locale = readLocalePreference(() => window.localStorage.getItem(LOCALE_STORAGE_KEY));
document.documentElement.lang = locale;

createRoot(rootElement).render(
	<StrictMode>
		<Screen initialLocale={locale} />
	</StrictMode>,
);
