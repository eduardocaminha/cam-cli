// webui/src/main.tsx
//
// The only impure module of the client: it owns the local state, mounts the
// pure screen, and subscribes to the server's event stream. There is no
// general polling loop -- /api/events pushes run transitions. The one bounded
// exception polls only while an external diagnostic process is active.
//
// Which surface to show, and which project it is about, are read from the
// browser path once, at mount: every link in the shell is a real navigation, so
// the document -- and with it the event subscription -- is rebuilt whenever the
// path changes and there is no navigation state to keep.

import { type ReactElement, StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, projectIdOf, routeOf } from './App.tsx';
import {
	abandonIssue,
	approveIssue,
	type ChainRunsView,
	type ChatMessageView,
	cancelDiagnostic,
	commandRun,
	connectClaudeCredential,
	createIssue,
	createProject,
	type DiagnosticsView,
	describeClaudeCredentialConfirmation,
	disconnectClaudeCredential,
	dismissDiagnosticFinding,
	dismissProposal,
	type ExecutorHandoffSettingView,
	emptyDiagnostics,
	emptyModelSettings,
	emptyNotificationChannels,
	emptySelfUpdate,
	eventsPathOf,
	fetchBacklog,
	fetchBrief,
	fetchChainRuns,
	fetchChat,
	fetchDiagnostics,
	fetchExecutorHandoff,
	fetchModelSettings,
	fetchNotificationChannels,
	fetchOperatorProfile,
	fetchProjectStatus,
	fetchProjects,
	fetchProposals,
	fetchProviders,
	fetchResolvedProposals,
	fetchRunEvents,
	fetchRuns,
	fetchSelfUpdate,
	type GitIdentityView,
	type IssueReviewDraft,
	importProject,
	type ModelSettingsView,
	type NotificationChannelsView,
	type OperatorProfileView,
	type ProjectBriefView,
	type ProjectStatusView,
	type ProposalView,
	type ProviderStatusView,
	promoteDiagnosticFinding,
	promoteProposal,
	type RegisteredProjectView,
	type ResolvedProposalView,
	type RunAction,
	registerProject,
	removeResendCredential,
	type SelfUpdateView,
	type StaleServiceView,
	saveBrief,
	saveChainRuns,
	saveDiagnosticSchedule,
	saveExecutorHandoff,
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
	unregisterProject,
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

/** Off by default, same as a fresh install that never toggled it (GSHIP-722). */
const EMPTY_EXECUTOR_HANDOFF: ExecutorHandoffSettingView = { enabled: false };

const CHECKING_PROJECT: ProjectStatusView = {
	state: 'checking',
	name: '',
	detail: 'Checking the local project…',
};

const EMPTY_OPERATOR_PROFILE: OperatorProfileView = { name: '', timezone: '' };

/**
 * The selected project, derived from the browser path alone (GSHIP-707): no
 * localStorage, no hidden state, and nothing to reconcile when the operator
 * navigates, since that rebuilds this module. `null` on the overview and on the
 * legacy paths the service redirects, which keeps the boot project's routes.
 */
const SELECTED_PROJECT_ID = projectIdOf(window.location.pathname);

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
	executorHandoff: ExecutorHandoffSettingView;
	notificationChannels: NotificationChannelsView;
	project: ProjectStatusView;
	projects: RegisteredProjectView[];
	operatorProfile: OperatorProfileView;
	diagnostics: DiagnosticsView;
	selfUpdate: SelfUpdateView;
	version: string;
	status: string | null;
	pending: boolean;
	claudeCredentialError: string | null;
	connectClaude: (token: string) => Promise<boolean>;
	clearClaudeCredentialError: () => void;
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
	const [executorHandoff, setExecutorHandoff] = useState<ExecutorHandoffSettingView>(EMPTY_EXECUTOR_HANDOFF);
	const [notificationChannels, setNotificationChannels] = useState<NotificationChannelsView>(
		emptyNotificationChannels,
	);
	const [project, setProject] = useState<ProjectStatusView>(CHECKING_PROJECT);
	const [projects, setProjects] = useState<RegisteredProjectView[]>([]);
	const [operatorProfile, setOperatorProfile] = useState<OperatorProfileView>(
		EMPTY_OPERATOR_PROFILE,
	);
	const [diagnostics, setDiagnostics] = useState<DiagnosticsView>(emptyDiagnostics);
	const [selfUpdate, setSelfUpdate] = useState<SelfUpdateView>(emptySelfUpdate);
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// GSHIP-705: a refused dedicated credential belongs beside the field the
	// operator must correct, not only in the shared status line, and the typed
	// token must survive it -- `claude setup-token` prints the token once.
	const [claudeCredentialError, setClaudeCredentialError] = useState<string | null>(null);
	const [version, setVersion] = useState('');

	const refresh = useCallback(() => {
		void Promise.all([
			fetchRuns(SELECTED_PROJECT_ID),
			fetchBacklog(SELECTED_PROJECT_ID),
			fetchProviders(SELECTED_PROJECT_ID),
			fetchChat(SELECTED_PROJECT_ID),
			fetchBrief(SELECTED_PROJECT_ID),
			fetchProposals(),
			fetchResolvedProposals(),
			fetchModelSettings(SELECTED_PROJECT_ID),
			fetchChainRuns(SELECTED_PROJECT_ID),
			fetchExecutorHandoff(SELECTED_PROJECT_ID),
			fetchNotificationChannels(),
			fetchProjectStatus(SELECTED_PROJECT_ID),
			fetchProjects(),
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
				executorHandoffSnapshot,
				notificationChannelsSnapshot,
				projectSnapshot,
				projectsSnapshot,
				operatorProfileSnapshot,
				diagnosticsSnapshot,
				selfUpdateSnapshot,
			]) => {
				const latest = runSnapshot[0] ?? null;
				const history = latest === null
					? []
					: await fetchRunEvents(SELECTED_PROJECT_ID, latest.id);
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
				setExecutorHandoff(executorHandoffSnapshot);
				setNotificationChannels(notificationChannelsSnapshot);
				setProject(projectSnapshot);
				setProjects(projectsSnapshot);
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

	/**
	 * Connect, reconnect and rotate, resolved rather than fired and forgotten
	 * (GSHIP-705): the form keeps the typed token when the service refuses it,
	 * so it has to learn which outcome happened, and the refusal itself goes
	 * beside the field instead of only into the shared status line.
	 */
	const connectClaude = useCallback((token: string) => {
		setClaudeCredentialError(null);
		setPending(true);
		return connectClaudeCredential(token)
			.then((confirmation) => {
				setStatus(describeClaudeCredentialConfirmation(confirmation));
				return true;
			})
			.catch((error: unknown) => {
				setClaudeCredentialError(error instanceof Error ? error.message : String(error));
				return false;
			})
			.finally(() => {
				setPending(false);
				refresh();
			});
	}, [refresh]);

	const clearClaudeCredentialError = useCallback(() => setClaudeCredentialError(null), []);

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
	}, [refresh]);

	// One subscription, bound to the project this document is about. A selection
	// the registry does not report ready has no runtime to stream, and opening it
	// would only make EventSource reconnect against a typed refusal, so the
	// document reads that project's snapshot alone until the registry says
	// otherwise. The boot project is the exception the service already makes: its
	// runtime exists from boot, so it streams while it is still in onboarding,
	// exactly as it did before this document named it. Without a selection --
	// the overview -- the boot stream is kept.
	const subscribable = SELECTED_PROJECT_ID === null
		|| projects.some((candidate) =>
			candidate.id === SELECTED_PROJECT_ID
			&& (candidate.current || candidate.readiness === 'ready'));
	const streamPath = subscribable ? eventsPathOf(SELECTED_PROJECT_ID) : null;

	useEffect(() => {
		if (streamPath === null) return;
		const source = new EventSource(streamPath);
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
	}, [refresh, streamPath]);

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
		executorHandoff,
		notificationChannels,
		project,
		projects,
		operatorProfile,
		diagnostics,
		selfUpdate,
		version,
		status,
		pending,
		claudeCredentialError,
		connectClaude,
		clearClaudeCredentialError,
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
		executorHandoff,
		notificationChannels,
		project,
		projects,
		operatorProfile,
		diagnostics,
		selfUpdate,
		version,
		status,
		pending,
		claudeCredentialError,
		connectClaude,
		clearClaudeCredentialError,
		enableNotifications,
		send,
	} = useOperationalRun();
	const run = runs[0] ?? null;
	const [locale, setLocale] = useState(initialLocale);
	const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
	const [projectOnboardingPending, setProjectOnboardingPending] =
		useState<'create' | 'import' | null>(null);
	const selectLocale = (selectedLocale: Locale) => {
		applyLocalePreference(
			selectedLocale,
			(value) => { document.documentElement.lang = value; },
			(key, value) => { window.localStorage.setItem(key, value); },
		);
		setLocale(selectedLocale);
	};
	// Every run command names the same project the screen is reading, so resume,
	// cancel, abandon and ship all reach the selected project's runtime.
	const command = (action: RunAction) => () => {
		if (run !== null) send(() => commandRun(SELECTED_PROJECT_ID, run.id, action));
	};

	return (
		<App
			backlog={backlog}
			chainRuns={chainRuns}
			executorHandoff={executorHandoff}
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
			// Intake, specification, approval, abandon and start all name the same
			// project the screen is reading (GSHIP-712), so no Work action falls
			// back to the boot runtime while another project is selected.
			onCreateIssue={(draft) => {
				send(() => createIssue(SELECTED_PROJECT_ID, draft).then((created) => {
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
			onSendMessage={(message) => send(() => sendChat(message, SELECTED_PROJECT_ID))}
			onConnectCodex={() => {
				const loginWindow = window.open('about:blank', 'gateship-codex-login');
				send(() => startCodexLogin().then((authUrl) => {
					if (loginWindow === null) window.location.assign(authUrl);
					else loginWindow.location.assign(authUrl);
					return 'Codex login opened in the browser.';
				}));
			}}
			claudeCredentialError={claudeCredentialError}
			onConnectClaudeCredential={connectClaude}
			onDismissClaudeCredentialError={clearClaudeCredentialError}
			onDisconnectClaudeCredential={() => {
				clearClaudeCredentialError();
				send(disconnectClaudeCredential);
			}}
			onEnableNotifications={enableNotifications}
			onRemoveResendCredential={() => send(removeResendCredential)}
			onSaveResendSettings={(input) => send(() => saveResendSettings(input))}
			onSendNotificationTest={(channelId) => send(() => sendNotificationTest(channelId))}
			onResume={(operatorGuidance) => {
				if (run !== null) {
					send(() => commandRun(SELECTED_PROJECT_ID, run.id, 'resume', operatorGuidance));
				}
			}}
			onSaveBrief={(draft) => send(() => saveBrief(draft, SELECTED_PROJECT_ID))}
			onSaveDiagnosticSchedule={(enabled, cadence) =>
				send(() => saveDiagnosticSchedule(enabled, cadence))}
			onSaveModelSettings={(draft) => send(() => saveModelSettings(draft, SELECTED_PROJECT_ID))}
			onSetChainRuns={(enabled) => send(() => saveChainRuns(enabled, SELECTED_PROJECT_ID))}
			onSetExecutorHandoff={(enabled) => send(() => saveExecutorHandoff(enabled, SELECTED_PROJECT_ID))}
			// GSHIP-718: importing clones into a checkout Gateship manages and
			// registers it, so success navigates the same way a fresh registration
			// does -- straight to the imported project's own URL.
			onImportProject={(repository) => {
				setProjectOnboardingPending('import');
				send(() => importProject(repository)
					.then((imported) => {
						window.location.assign(`/projects/${encodeURIComponent(imported.id)}`);
						return `${imported.name} imported.`;
					})
					.finally(() => setProjectOnboardingPending(null)));
			}}
			onCreateProject={(input) => {
				setProjectOnboardingPending('create');
				send(() => createProject(input)
					.then((created) => {
						window.location.assign(`/projects/${encodeURIComponent(created.id)}`);
						return `${created.name} created.`;
					})
					.finally(() => setProjectOnboardingPending(null)));
			}}
			// GSHIP-716: registering a checkout only adds it to the registry. The
			// list and the sidebar stay the selection surface, so success goes
			// straight to the newly registered project's own URL.
			onRegisterProject={(root) => {
				send(() => registerProject(root).then((registered) => {
					window.location.assign(`/projects/${encodeURIComponent(registered.id)}`);
					return `${registered.name} registered.`;
				}));
			}}
			// GSHIP-717: removing a project only drops its registration. The
			// overview is the surface that still exists afterwards, and loading it
			// rebuilds the project navigation from the registry.
			onUnregisterProject={(projectId) => {
				send(() => unregisterProject(projectId).then((removed) => {
					window.location.assign('/overview');
					return `${removed.name} removed from Gateship. Its files stay on disk.`;
				}));
			}}
			onSelectIssue={setSelectedIssueId}
			onSelectLocale={selectLocale}
			onSelectProvider={(providerId) => send(() => selectProvider(providerId, SELECTED_PROJECT_ID))}
			onShip={command('ship')}
			onSpecifyIssue={(issueId, draft) => {
				send(() => specifyIssue(SELECTED_PROJECT_ID, issueId, draft).then((specified) => {
					setSelectedIssueId(specified.id);
					return `${specified.id} specified and selected.`;
				}));
			}}
			onApproveIssue={(issueId) =>
				send(() => approveIssue(SELECTED_PROJECT_ID, issueId).then(() => `${issueId} approved.`))}
			onAbandonIssue={(issueId, reason) => {
				send(() =>
					abandonIssue(SELECTED_PROJECT_ID, issueId, reason).then(() => `${issueId} abandoned.`));
			}}
			onReviewIssue={(issueId, draft) => {
				send(() => specifyIssue(SELECTED_PROJECT_ID, issueId, draft).then(() => `${issueId} revised.`));
			}}
			onStart={() => {
				if (selectedIssueId !== null) send(() => startRun(SELECTED_PROJECT_ID, selectedIssueId));
			}}
			modelSettings={modelSettings}
			selfUpdate={selfUpdate}
			onSetSelfUpdate={(enabled) => send(() => saveSelfUpdate(enabled))}
			onSaveOperatorProfile={(profile) => send(() => saveOperatorProfile(profile))}
			pending={pending}
			projectOnboardingPending={projectOnboardingPending}
			proposals={proposals}
			project={project}
			projects={projects}
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
