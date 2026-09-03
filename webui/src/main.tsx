// webui/src/main.tsx
//
// The only impure module of the client: it owns the local state, mounts the
// pure screen, and subscribes to the server's event stream. There is no
// general polling loop -- /api/events pushes run transitions. The one bounded
// exception polls only while an external diagnostic process is active.
//
// Same-scope links update browser history without rebuilding the document, so
// the operational snapshot and its event subscription remain intact.

import { type ReactElement, StrictMode, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { createRoot } from 'react-dom/client';
import { App, projectIdOf, routeOf } from './App.tsx';
import {
	abandonIssue,
	type AgentDefaultsView,
	type AgentSettingSource,
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
	fetchAgentDefaults,
	fetchBacklog,
	fetchBrief,
	fetchChainRuns,
	fetchChat,
	fetchDiagnostics,
	fetchExecutorHandoff,
	fetchModelSettingsSnapshot,
	fetchNotificationChannels,
	fetchOperatorProfile,
	fetchOverview,
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
	type ProjectOperationalOverviewView,
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
	resetModelSettings,
	resetSelectedProvider,
	type SelfUpdateView,
	type StaleServiceView,
	saveAgentDefaults,
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
import { clientNavigationTarget } from './navigation.ts';
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

async function fetchDiagnosticsForScope(scope: string | null): Promise<DiagnosticsView> {
	if (scope === null) return fetchDiagnostics(null);
	const status = await fetchProjectStatus(scope);
	return status.state === 'ready' ? fetchDiagnostics(scope) : emptyDiagnostics();
}

function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	} catch {
		return '';
	}
}

function useOperationalRun(scope: string | null, pathname: string): {
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
	providerSource: AgentSettingSource;
	notificationPermission: BrowserNotificationPermission;
	brief: ProjectBriefView;
	handoff: ProjectBriefView;
	modelSettings: ModelSettingsView;
	modelSettingsSource: AgentSettingSource;
	agentDefaults: AgentDefaultsView;
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
	overview: ProjectOperationalOverviewView | null;
	overviewLoading: boolean;
	overviewError: string | null;
	snapshotLoading: boolean;
	snapshotError: string | null;
	snapshotScope: string | null | undefined;
	snapshotErrorScope: string | null | undefined;
	retryInitialSnapshot: () => void;
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
	const [providerSource, setProviderSource] = useState<AgentSettingSource>('provider-default');
	const [notificationPermission, setNotificationPermission] = useState(
		browserNotificationPermission,
	);
	const [brief, setBrief] = useState<ProjectBriefView>(EMPTY_BRIEF);
	const [handoff, setHandoff] = useState<ProjectBriefView>(EMPTY_BRIEF);
	const [modelSettings, setModelSettings] = useState<ModelSettingsView>(emptyModelSettings);
	const [modelSettingsSource, setModelSettingsSource] = useState<AgentSettingSource>('provider-default');
	const [agentDefaults, setAgentDefaults] = useState<AgentDefaultsView>({
		provider: 'claude', modelSettings: emptyModelSettings(),
	});
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
	const [overview, setOverview] = useState<ProjectOperationalOverviewView | null>(null);
	const [overviewLoading, setOverviewLoading] = useState(routeOf(pathname) === '/overview');
	const [overviewError, setOverviewError] = useState<string | null>(null);
	const [snapshotLoading, setSnapshotLoading] = useState(true);
	const [snapshotError, setSnapshotError] = useState<string | null>(null);
	const refreshedScope = useRef<string | null | undefined>(undefined);
	const activeScope = useRef<string | null>(scope);
	const [snapshotScope, setSnapshotScope] = useState<string | null | undefined>(undefined);
	const [snapshotErrorScope, setSnapshotErrorScope] = useState<string | null | undefined>(undefined);
	const snapshotRequest = useRef(0);
	activeScope.current = scope;

	const refresh = useCallback((request?: number) => {
		const currentRequest = (): boolean =>
			activeScope.current === scope
			&& (request === undefined || request === snapshotRequest.current);
		return Promise.all([
			fetchRuns(scope),
			fetchBacklog(scope),
			fetchProviders(scope),
			fetchChat(scope),
			fetchBrief(scope),
			fetchProposals(scope),
			fetchResolvedProposals(scope),
			fetchModelSettingsSnapshot(scope),
			fetchAgentDefaults(),
			fetchChainRuns(scope),
			fetchExecutorHandoff(scope),
			fetchNotificationChannels(),
			fetchProjectStatus(scope),
			fetchProjects(),
			fetchOperatorProfile(),
			fetchDiagnosticsForScope(scope),
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
				agentDefaultsSnapshot,
				chainRunsSnapshot,
				executorHandoffSnapshot,
				notificationChannelsSnapshot,
				projectSnapshot,
				projectsSnapshot,
				operatorProfileSnapshot,
				diagnosticsSnapshot,
				selfUpdateSnapshot,
			]) => {
				if (!currentRequest()) return false as const;
				const latest = runSnapshot[0] ?? null;
				const history = latest === null
					? []
					: await fetchRunEvents(scope, latest.id);
				if (!currentRequest()) return false as const;
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
				setProviderSource(providerSnapshot.source);
				setChatMessages(chatSnapshot);
				setBrief(briefSnapshot.brief);
				setHandoff(briefSnapshot.handoff);
				setModelSettings(modelSnapshot.settings);
				setModelSettingsSource(modelSnapshot.source);
				setAgentDefaults(agentDefaultsSnapshot);
				setChainRuns(chainRunsSnapshot);
				setExecutorHandoff(executorHandoffSnapshot);
				setNotificationChannels(notificationChannelsSnapshot);
				setProject(projectSnapshot);
				setProjects(projectsSnapshot);
				setOperatorProfile(operatorProfileSnapshot);
				setDiagnostics(diagnosticsSnapshot);
				setSelfUpdate(selfUpdateSnapshot);
				setEvents(history);
				return true as const;
			})
			.catch((error: unknown) => {
				if (!currentRequest()) return false as const;
				const detail = String(error);
				setStatus(detail);
				return detail;
			});
	}, [scope]);

	const loadInitialSnapshot = useCallback(() => {
		const request = ++snapshotRequest.current;
		setSnapshotLoading(true);
		setSnapshotError(null);
		setSnapshotErrorScope(undefined);
		void refresh(request).then((loaded) => {
			if (request !== snapshotRequest.current || activeScope.current !== scope) return;
			setSnapshotLoading(false);
			if (loaded === true) setSnapshotScope(scope);
			else if (loaded !== false) {
				setSnapshotErrorScope(scope);
				setSnapshotError(loaded);
			}
		});
	}, [refresh, scope]);

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
		if (refreshedScope.current === scope) return;
		refreshedScope.current = scope;
		loadInitialSnapshot();
	}, [loadInitialSnapshot, scope]);

	useEffect(() => {
		if (routeOf(pathname) !== '/overview') {
			setOverviewLoading(false);
			return;
		}
		const controller = new AbortController();
		let first = true;
		let disposed = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const commit = (value: ProjectOperationalOverviewView): void => {
			if (!disposed) { setOverview(value); setOverviewError(null); }
		};
		const report = (error: unknown): void => {
			if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) setOverviewError(String(error));
		};
		const finish = (): void => {
			if (!disposed) {
				first = false;
				setOverviewLoading(false);
				timeout = setTimeout(() => { void read(); }, 15_000);
			}
		};
		const read = async (): Promise<void> => {
			if (disposed) return;
			if (first) setOverviewLoading(true);
			try {
				commit(await fetchOverview(controller.signal));
			} catch (error: unknown) {
				report(error);
			} finally {
				finish();
			}
		};
		void read();
		return () => {
			disposed = true;
			controller.abort();
			if (timeout !== undefined) clearTimeout(timeout);
		};
	}, [pathname]);

	// One subscription, bound to the project this document is about. A selection
	// the registry does not report ready has no runtime to stream, and opening it
	// would only make EventSource reconnect against a typed refusal, so the
	// document reads that project's snapshot alone until the registry says
	// otherwise. The boot project is the exception the service already makes: its
	// runtime exists from boot, so it streams while it is still in onboarding,
	// exactly as it did before this document named it. Without a selection --
	// the overview -- the boot stream is kept.
	const subscribable = scope === null
		|| projects.some((candidate) =>
			candidate.id === scope
			&& (candidate.current || candidate.readiness === 'ready'));
	const streamPath = subscribable ? eventsPathOf(scope) : null;

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
			void fetchDiagnosticsForScope(scope)
				.then(setDiagnostics)
				.catch((error: unknown) => setStatus(String(error)));
		}, 1_500);
		return () => clearInterval(interval);
	}, [diagnostics.scan?.state, scope]);

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
		providerSource,
		notificationPermission,
		brief,
		handoff,
		modelSettings,
		modelSettingsSource,
		agentDefaults,
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
		overview,
		overviewLoading,
		overviewError,
		snapshotLoading,
		snapshotError,
		snapshotScope,
		snapshotErrorScope,
		retryInitialSnapshot: loadInitialSnapshot,
		pending,
		claudeCredentialError,
		connectClaude,
		clearClaudeCredentialError,
		enableNotifications,
		send,
	};
}

function Screen({ initialLocale }: { initialLocale: Locale }): ReactElement {
	const [pathname, setPathname] = useState(window.location.pathname);
	const [surfacePathname, setSurfacePathname] = useState(window.location.pathname);
	const [, startRouteTransition] = useTransition();
	const scope = projectIdOf(pathname);
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
		providerSource,
		notificationPermission,
		brief,
		handoff,
		modelSettings,
		modelSettingsSource,
		agentDefaults,
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
		overview,
		overviewLoading,
		overviewError,
		snapshotLoading,
		snapshotError,
		snapshotScope,
		snapshotErrorScope,
		retryInitialSnapshot,
		pending,
		claudeCredentialError,
		connectClaude,
		clearClaudeCredentialError,
		enableNotifications,
		send,
	} = useOperationalRun(scope, pathname);
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
		if (run !== null) send(() => commandRun(scope, run.id, action));
	};

	const setRoute = useCallback((destination: string): void => {
		setPathname(destination);
		startRouteTransition(() => setSurfacePathname(destination));
	}, [startRouteTransition]);

	useEffect(() => {
		const onPopState = () => setRoute(window.location.pathname);
		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
	}, [setRoute]);

	const navigate = useCallback((destination: string): void => {
		window.history.pushState(null, '', destination);
		setRoute(destination);
	}, [setRoute]);

	useEffect(() => {
		const onClick = (event: MouseEvent): void => {
			const element = event.target instanceof Element ? event.target.closest('a[href]') : null;
			if (!(element instanceof HTMLAnchorElement)) return;
			const destination = clientNavigationTarget({
				currentUrl: window.location.href,
				href: element.href,
				defaultPrevented: event.defaultPrevented,
				button: event.button,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey,
				target: element.target,
				download: element.hasAttribute('download'),
			});
			if (destination === null) return;
			event.preventDefault();
			navigate(destination);
		};
		document.addEventListener('click', onClick);
		return () => document.removeEventListener('click', onClick);
	}, [navigate]);

	const currentScopeFailed = snapshotError !== null && snapshotErrorScope === scope;
	const operationalBoundary = snapshotLoading || (snapshotScope !== scope && !currentScopeFailed)
		? { state: 'loading' as const }
		: !currentScopeFailed ? undefined : {
			state: 'failure' as const,
			detail: snapshotError,
			onRetry: retryInitialSnapshot,
		};

	return (
		<App
			operationalBoundary={operationalBoundary}
			onNavigate={navigate}
			surfaceRoute={routeOf(surfacePathname)}
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
			overview={overview}
			 overviewLoading={overviewLoading}
			overviewError={overviewError}
			notificationChannels={notificationChannels}
			notificationPermission={notificationPermission}
			onAbandon={command('abandon')}
			onCancel={command('cancel')}
			// Intake, specification, approval, abandon and start all name the same
			// project the screen is reading (GSHIP-712), so no Work action falls
			// back to the boot runtime while another project is selected.
			onCreateIssue={(draft) => {
				send(() => createIssue(scope, draft).then((created) => {
					setSelectedIssueId(created.id);
					return `${created.id} created and selected.`;
				}));
			}}
			onDismissProposal={(proposalId) => send(() => dismissProposal(proposalId, scope))}
			onCancelDiagnostic={(scanId) => send(() => cancelDiagnostic(scanId, scope))}
			onDismissDiagnosticFinding={(findingId) =>
				send(() => dismissDiagnosticFinding(findingId, scope))}
			onPromoteDiagnosticFinding={(findingId, draft) => {
				send(() => promoteDiagnosticFinding(findingId, draft, scope).then((created) =>
					`${created.id} created from the diagnostic.`));
			}}
			onStartDiagnostic={(analyzer) => send(() => startDiagnostic(analyzer, scope))}
			onPromoteProposal={(proposalId, draft) => {
				// The created issue is a draft to review, not the next run: it is
				// filed unapproved, so it is not selected to start either.
				send(() => promoteProposal(proposalId, draft, scope).then((created) =>
					`${created.id} created from the proposal.`));
			}}
			onSendMessage={(message) => send(() => sendChat(message, scope))}
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
					send(() => commandRun(scope, run.id, 'resume', operatorGuidance));
				}
			}}
			onSaveBrief={(draft) => send(() => saveBrief(draft, scope))}
			onSaveDiagnosticSchedule={(enabled, cadence) =>
				send(() => saveDiagnosticSchedule(enabled, cadence, scope))}
			onSaveModelSettings={(draft) => send(() => saveModelSettings(draft, scope))}
			onResetModelSettings={() => send(() => resetModelSettings(scope))}
			onSaveAgentDefaults={(draft) => send(() => saveAgentDefaults(draft))}
			onSetChainRuns={(enabled) => send(() => saveChainRuns(enabled, scope))}
			onSetExecutorHandoff={(enabled) => send(() => saveExecutorHandoff(enabled, scope))}
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
			onSelectProvider={(providerId) => send(() => selectProvider(providerId, scope))}
			onResetProvider={() => send(() => resetSelectedProvider(scope))}
			onShip={command('ship')}
			onSpecifyIssue={(issueId, draft) => {
				send(() => specifyIssue(scope, issueId, draft).then((specified) => {
					setSelectedIssueId(specified.id);
					return `${specified.id} specified and selected.`;
				}));
			}}
			onApproveIssue={(issueId) =>
				send(() => approveIssue(scope, issueId).then(() => `${issueId} approved.`))}
			onAbandonIssue={(issueId, reason) => {
				send(() =>
					abandonIssue(scope, issueId, reason).then(() => `${issueId} abandoned.`));
			}}
			onReviewIssue={(issueId, draft) => {
				send(() => specifyIssue(scope, issueId, draft).then(() => `${issueId} revised.`));
			}}
			onStart={() => {
				if (selectedIssueId !== null) send(() => startRun(scope, selectedIssueId));
			}}
			modelSettings={modelSettings}
			modelSettingsSource={modelSettingsSource}
			agentDefaults={agentDefaults}
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
			route={routeOf(pathname)}
			runs={runs}
			selectedIssueId={selectedIssueId}
			selectedProvider={selectedProvider}
			providerSource={providerSource}
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

// Theme follows the system until the operator chooses: the sidebar toggle
// stores an explicit 'light' | 'dark' under this key, and a stored choice
// always beats the OS preference. The stylesheet's dark tokens hang off a
// `.dark` class, the one switching mechanism this screen uses.
const THEME_STORAGE_KEY = 'gship-theme';
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const applyScheme = (): void => {
	const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
	const dark = stored === null ? darkScheme.matches : stored === 'dark';
	document.documentElement.classList.toggle('dark', dark);
};
applyScheme();
// The content measure mirrors the theme mechanism: ShellControls stores an
// explicit choice, and the surfaces read it through one root class.
if (window.localStorage.getItem('gship-width') === 'wide') {
	document.documentElement.classList.add('gship-wide');
}
darkScheme.addEventListener('change', () => {
	// Theme swaps repaint everything at once; transitions are suppressed for
	// the swap so colors cut over instead of cross-fading out of sync.
	document.documentElement.setAttribute('data-theme-switching', '');
	applyScheme();
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			document.documentElement.removeAttribute('data-theme-switching');
		});
	});
});

createRoot(rootElement).render(
	<StrictMode>
		<Screen initialLocale={locale} />
	</StrictMode>,
);
