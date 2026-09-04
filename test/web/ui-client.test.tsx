// test/web/ui-client.test.tsx
//
// The operator screen, executed once per state it can be in, through
// renderToStaticMarkup and no DOM harness (ADR-0067). What is asserted is the
// screen's decisions -- which surface carries which task, which phase it shows,
// which outcome text it shows, and which of the four commands it offers --
// never the component source text.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	App,
	handleProjectShortcut,
	type AppProps,
	ConversationColumn,
	type OperatorRoute,
	routeOf,
} from '../../webui/src/App.tsx';
import { PanelToggleGlyph, ShellRail, type PanelKeyEvent } from '../../webui/src/screens/shell.tsx';
import {
	abandonIssue,
	aggregateChatTurnCosts,
	approveIssue,
	AGENT_DEFAULTS_PATH,
	BRIEF_PATH,
	CHAIN_RUNS_PATH,
	CHAT_PATH,
	type ChainPauseReason,
	type ChainPauseView,
	type ChainRunsView,
	cancelDiagnostic,
	commandRun,
	connectClaudeCredential,
	createIssue,
	createProject,
	DIAGNOSTIC_FINDINGS_PATH,
	DIAGNOSTIC_SCHEDULE_PATH,
	DIAGNOSTICS_PATH,
	describeClaudeCredentialConfirmation,
	dismissDiagnosticFinding,
	dismissProposal,
	EVENTS_PATH,
	EXECUTOR_HANDOFF_PATH,
	type ExecutorHandoffSettingView,
	emptyDiagnostics,
	fetchAgentDefaults,
	emptyModelSettings,
	emptyNotificationChannels,
	emptySelfUpdate,
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
	ISSUES_PATH,
	importProject,
	MODEL_SETTINGS_PATH,
	type ModelSettingsView,
	NOTIFICATIONS_PATH,
	type NotificationChannelsView,
	OPERATOR_PROFILE_PATH,
	type OperatorProfileView,
	PROJECT_PATH,
	PROJECTS_PATH,
	PROPOSALS_PATH,
	PROVIDERS_PATH,
	type ProjectBriefView,
	type ProjectStatusView,
	type ProviderStatusView,
	promoteDiagnosticFinding,
	promoteProposal,
	RESOLVED_PROPOSALS_PATH,
	type RegisteredProjectView,
	type ResolvedProposalView,
	RUNS_PATH,
	registerProject,
	removeResendCredential,
	resetModelSettings,
	resetSelectedProvider,
	SNAPSHOT_PATH,
	saveBrief,
	saveAgentDefaults,
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
	UPDATE_PATH,
	unregisterProject,
} from '../../webui/src/client.ts';
import {
	createLiveEdgeController,
	canReturnToLiveEdge,
	isAtLiveEdge,
	LIVE_EDGE_TOLERANCE_PX,
	liveEdgeSession,
} from '../../webui/src/live-edge.ts';
import {
	applyLocalePreference,
	DEFAULT_LOCALE,
	LOCALE_CATALOG,
	type Locale,
	readLocalePreference,
} from '../../webui/src/locale.ts';
import { clientNavigationTarget } from '../../webui/src/navigation.ts';
import { InitialOperationalFailure, InitialOperationalLoading } from '../../webui/src/initial-loading.tsx';
import {
	createOperationalRefreshCoalescer,
	createOperationalSnapshotCycle,
	beginOperationalReads,
	beginOperationalRefresh,
	pendingOperationalReads,
	preserveGlobalOperationalLoaded,
	readOperationalPart,
	settleOperationalRead,
} from '../../webui/src/operational-snapshot.ts';
import {
	actionsFor,
	aggregateRunCosts,
	attentionOf,
	invalidatesSnapshot,
	progressOf,
	type RunCostView,
	type RunEventView,
	type RunRoundOriginsView,
	type RunState,
	type RunView,
	summarizeWorkflow,
	summarizeWorkflowCohorts,
} from '../../webui/src/run-view.ts';

const BACKLOG = [
	{ id: 'CAM-900', title: 'primeira issue plannable' },
	{ id: 'CAM-901', title: 'segunda issue plannable' },
];

const SURFACE_PATHS: readonly OperatorRoute[] = [
	'/projects/project-current',
	'/projects/project-current/runs',
	'/projects/project-current/work',
	'/projects/project-current/settings',
];

const NOTICES: AppProps['workspaceNotices'] = [{
	kind: 'dirty',
	runId: null,
	workspacePath: '/project/.gship/worktrees/orphan',
	branch: 'gship/cam-1-orphan',
	detail: 'workspace is not owned by a persisted run',
}];

const EMPTY_RUN_COST: RunCostView = { totalCostUsd: null, breakdown: [], roles: [] };
const EMPTY_ROUND_ORIGINS: RunRoundOriginsView = { executor: 0, decision: 0, indeterminate: 0 };

function runIn(state: RunState, overrides: Partial<RunView> = {}): RunView {
	return {
		id: 'run-1',
		issueId: 'CAM-900',
		state,
		summary: null,
		error: null,
		updatedAt: '2026-08-16T00:00:00.000Z',
		cost: EMPTY_RUN_COST,
		roundOrigins: EMPTY_ROUND_ORIGINS,
		providerWait: null,
		pullRequest: null,
		executorHandoff: null,
		...overrides,
	};
}

function evaluation(
	workflowRevision: string,
	outcome: NonNullable<RunView['evaluation']>['outcome'],
	overrides: Partial<NonNullable<RunView['evaluation']>> = {},
): NonNullable<RunView['evaluation']> {
	return {
		workflowRevision,
		provider: 'claude',
		outcome,
		wallTimeMs: 10 * 60_000,
		attentionRequests: 0,
		operatorInterventions: 0,
		providerHolds: 0,
		resolvedCycleQuestions: 0,
		roles: [],
		...overrides,
	};
}

function eventIn(fromState: RunState, toState: RunState, kind: string): RunEventView {
	return {
		seq: 1,
		runId: 'run-1',
		kind,
		fromState,
		toState,
		payload: {},
		createdAt: '2026-08-16T00:00:00.000Z',
	};
}

const EMPTY_MODEL_SETTINGS: ModelSettingsView = emptyModelSettings();

const EMPTY_CHAIN_RUNS: ChainRunsView = { enabled: false, pause: null };

const EMPTY_EXECUTOR_HANDOFF: ExecutorHandoffSettingView = { enabled: false };

const EMPTY_NOTIFICATION_CHANNELS: NotificationChannelsView = emptyNotificationChannels();

const EMPTY_BRIEF: ProjectBriefView = {
	objective: '',
	decisions: [],
	constraints: [],
	openItems: [],
};

const READY_PROJECT: ProjectStatusView = {
	state: 'ready',
	name: 'gateship',
	repository: 'acme/gateship',
	remoteUrl: 'git@github.com:acme/gateship.git',
	sourceRef: 'origin/main',
};

const CURRENT_PROJECT: RegisteredProjectView = {
	id: 'project-current',
	name: 'gateship',
	root: '/project',
	stateDir: '/project/.gship',
	readiness: 'ready',
	repository: 'acme/gateship',
	current: true,
};

const OTHER_PROJECT: RegisteredProjectView = {
	id: 'project-other',
	name: 'other-product',
	root: '/other-product',
	stateDir: '/other-product/.gship',
	readiness: 'ready',
	repository: 'acme/other-product',
	current: false,
};

const EMPTY_OPERATOR_PROFILE: OperatorProfileView = { name: '', timezone: '' };

describe('operational snapshot reads', () => {
	test('keeps the project identity core explicit when its read fails', async () => {
		await expect(readOperationalPart(async () => { throw new Error('Project responded with 500'); })).resolves.toEqual({
			state: 'unavailable', detail: 'Error: Project responded with 500',
		});
	});

	test('keeps successful secondary data when another secondary read is unavailable', async () => {
		const [runs, backlog] = await Promise.all([
			readOperationalPart(async () => [runIn('working')]),
			readOperationalPart(async () => { throw new Error('Snapshot responded with 500'); }),
		]);
		expect(runs).toMatchObject({ state: 'available', value: [expect.objectContaining({ id: 'run-1' })] });
		expect(backlog).toEqual({ state: 'unavailable', detail: 'Error: Snapshot responded with 500' });
	});

	test('a refresh failure leaves previously committed data available', async () => {
		let revealed = await readOperationalPart(async () => ['CAM-900']);
		const refresh = await readOperationalPart(async () => { throw new Error('Snapshot responded with 500'); });
		if (refresh.state === 'available') revealed = refresh;
		expect(revealed).toEqual({ state: 'available', value: ['CAM-900'] });
	});

	test('the latest core read settles an initial snapshot superseded by a refresh', () => {
		const cycle = createOperationalSnapshotCycle('project-current');
		const initial = cycle.begin('project-current', true);
		const refresh = cycle.begin('project-current', false);
		expect(cycle.finishCore(initial, 'project-current')).toBe(false);
		expect(cycle.loading()).toBe(true);
		expect(cycle.finishCore(refresh, 'project-current')).toBe(true);
		expect(cycle.loading()).toBe(false);
		const priorScope = cycle.begin('project-current', true);
		cycle.changeScope('project-new');
		expect(cycle.finishCore(priorScope, 'project-current')).toBe(false);
		expect(cycle.loading()).toBe(true);
		const currentScope = cycle.begin('project-new', true);
		const staleRefresh = cycle.begin('project-current', false);
		expect(cycle.isCurrent(staleRefresh, 'project-current')).toBe(false);
		expect(cycle.isCurrent(currentScope, 'project-new')).toBe(true);
		expect(cycle.finishCore(currentScope, 'project-new')).toBe(true);
		expect(cycle.loading()).toBe(false);
		const originalProject = cycle.begin('project-new', true);
		cycle.changeScope('project-other');
		cycle.changeScope('project-new');
		expect(cycle.isCurrent(originalProject, 'project-new')).toBe(false);
		const returnedProject = cycle.begin('project-new', true);
		expect(cycle.isCurrent(returnedProject, 'project-new')).toBe(true);
		expect(cycle.finishCore(returnedProject, 'project-new')).toBe(true);
	});

	test('coalesces events while the complete read battery is in flight', async () => {
		let refreshes = 0;
		let scheduled: (() => void) | undefined;
		let resolveCore: (() => void) | undefined;
		let resolveSecondary: (() => void) | undefined;
		const refresh = createOperationalRefreshCoalescer(
			() => {
				refreshes += 1;
				return Promise.all([
					new Promise<void>((resolve) => { resolveCore = resolve; }),
					new Promise<void>((resolve) => { resolveSecondary = resolve; }),
				]);
			},
			(callback) => { scheduled = callback; },
		);
		refresh.queue(); refresh.queue(); refresh.queue();
		expect(scheduled).toBeDefined();
		scheduled?.();
		expect(refreshes).toBe(1);
		refresh.queue(); refresh.queue();
		resolveCore?.();
		await Promise.resolve();
		expect(refreshes).toBe(1);
		resolveSecondary?.();
		await Promise.resolve(); await Promise.resolve();
		expect(scheduled).toBeDefined();
		scheduled?.();
		expect(refreshes).toBe(2);
		resolveCore?.(); resolveSecondary?.();
	});

	test('keeps a secondary surface pending after the core has completed', () => {
		const html = workPage({ operationalPending: { Snapshot: true } });
		expect(pendingOperationalReads().Snapshot).toBe(true);
		expect(html).toContain('Loading Snapshot');
		expect(html).not.toContain('No admissible issues right now.');
	});

	test('a same-scope retry clears failure and restores pending until its read resolves', async () => {
		let state = beginOperationalReads({});
		state = settleOperationalRead(state, 'Snapshot', { state: 'unavailable', detail: 'Snapshot responded with 500' });
		let resolveRetry: ((value: typeof BACKLOG) => void) | undefined;
		state = beginOperationalRefresh(state, false);
		const retry = readOperationalPart(() => new Promise<typeof BACKLOG>((resolve) => { resolveRetry = resolve; }))
			.then((result) => { state = settleOperationalRead(state, 'Snapshot', result); });
		expect(state.failures.Snapshot).toBeUndefined();
		expect(state.pending.Snapshot).toBe(true);
		resolveRetry?.(BACKLOG);
		await retry;
		expect(state).toMatchObject({ loaded: { Snapshot: true }, failures: {}, pending: {} });
	});

	test('a Runs failure settles its dependent Run activity without leaving it pending', () => {
		let state = beginOperationalReads({});
		const failure = { state: 'unavailable' as const, detail: 'Runs responded with 500' };
		state = settleOperationalRead(state, 'Runs', failure);
		state = settleOperationalRead(state, 'Run activity', failure);
		expect(state.pending.Runs).toBeUndefined();
		expect(state.pending['Run activity']).toBeUndefined();
		expect(state.failures).toEqual({ Runs: failure.detail, 'Run activity': failure.detail });
	const html = runsPage({ operationalFailures: state.failures });
	expect(html).toContain('Runs is unavailable.');
	expect(html).not.toContain('Loading Run activity');
	});

	test('keeps revealed global resources loaded when a scope change refreshes them', () => {
		expect(preserveGlobalOperationalLoaded({
			Runs: true,
			Snapshot: true,
			'Agent defaults': true,
			Notifications: true,
			'Operator profile': true,
			'Self update': true,
		})).toEqual({
			'Agent defaults': true,
			Notifications: true,
			'Operator profile': true,
			'Self update': true,
		});
	});

	test('a failed secondary read replaces its dependent empty surface with explicit unavailability', () => {
		const runs = runsPage({ operationalFailures: { Runs: 'Runs responded with 500' } });
		expect(runs).toContain('Runs is unavailable.');
		expect(runs).toContain('Runs responded with 500');
		expect(runs).not.toContain('No runs yet');

		const work = workPage({ operationalFailures: { Snapshot: 'Snapshot responded with 500' } });
		expect(work).toContain('Snapshot is unavailable.');
		expect(work).toContain('Snapshot responded with 500');
		expect(work).not.toContain('Executable backlog');
		expect(work).toContain('New issue');
	});

	test('keeps secondary failures on their dependent route and preserves successful Work suggestions', () => {
		const settings = settingsPage({ operationalFailures: { Runs: 'Runs responded with 500' } });
		const overview = renderAt('/overview', { operationalFailures: { Runs: 'Runs responded with 500' } });
		expect(settings).not.toContain('Runs is unavailable.');
		expect(overview).not.toContain('Runs is unavailable.');

		const work = workPage({
			operationalFailures: { Snapshot: 'Snapshot responded with 500' },
			proposals: [PROPOSAL],
		});
		expect(work).toContain(PROPOSAL.title);
		expect(work).not.toContain('Executable backlog');
	});

	test('keeps revealed data visible when a critical refresh fails and offers retry', () => {
		const html = runsPage({
			runs: [runIn('working')],
			operationalRefreshFailure: { detail: 'Project responded with 500', onRetry: () => {} },
		});
		expect(html).toContain('Operational data could not be refreshed.');
		expect(html).toContain('Project responded with 500');
		expect(html).toContain('Try again');
		expect(html).toContain('Phase working');
	});

	test('keeps all Snapshot-dependent Work panels visible after a failed refresh', () => {
		const work = workPage({
			operationalFailures: { Snapshot: 'Snapshot responded with 500' },
			operationalLoaded: { Snapshot: true },
			drafts: [{ ...DRAFT, id: 'draft-1' }],
			ideas: [{ ...BACKLOG[0], id: 'idea-1', title: 'Revealed idea' }],
		});
		expect(work).toContain('Snapshot is unavailable.');
		expect(work).toContain('Executable backlog');
		expect(work).toContain('Review and approve');
		expect(work).toContain('Revealed idea');
	});

	test('keeps runs visible when only run activity is unavailable', () => {
		const runs = runsPage({
			runs: [runIn('working')],
			operationalFailures: { 'Run activity': 'Run activity responded with 500' },
		});
		expect(runs).toContain('Run activity is unavailable.');
		expect(runs).toContain('Phase working');
		expect(runs).not.toContain('Runs is unavailable.');
	});

	test('keeps revealed runs visible when their refresh is unavailable', () => {
		const runs = runsPage({
			runs: [runIn('working', { issueId: 'CAM-REVEALED' })],
			operationalFailures: { Runs: 'Runs responded with 500' },
			operationalLoaded: { Runs: true },
		});
		expect(runs).toContain('Runs is unavailable.');
		expect(runs).toContain('Phase working');
		expect(runs).toContain('CAM-REVEALED');
	});

	test('names a failed Snapshot at workspace notices without hiding revealed notices', () => {
		const initial = runsPage({ operationalFailures: { Snapshot: 'Snapshot responded with 500' } });
		expect(initial).toContain('Snapshot is unavailable.');
		expect(initial).not.toContain(NOTICES[0]?.detail ?? '');

		const refresh = runsPage({
			workspaceNotices: NOTICES,
			operationalFailures: { Snapshot: 'Snapshot responded with 500' },
			operationalLoaded: { Snapshot: true },
		});
		expect(refresh).toContain('Snapshot is unavailable.');
		expect(refresh).toContain(NOTICES[0]?.detail ?? '');
	});

	test('keeps Snapshot workspace notices visible when Runs is initially unavailable', () => {
		const runs = runsPage({
			workspaceNotices: NOTICES,
			operationalFailures: { Runs: 'Runs responded with 500' },
			operationalLoaded: { Snapshot: true },
		});
		expect(runs).toContain('Runs is unavailable.');
		expect(runs).toContain(NOTICES[0]?.detail ?? '');
	});

	test('keeps Work snapshot data visible but disables unsafe actions when Runs is initially unavailable', () => {
		const work = workPage({
			backlog: BACKLOG,
			drafts: [DRAFT],
			selectedIssueId: BACKLOG[0]?.id ?? null,
			operationalFailures: { Runs: 'Runs responded with 500' },
		});
		expect(work).toContain('Runs is unavailable.');
		expect(work).toContain(BACKLOG[0]?.title ?? '');
		expect(work).toContain('Review and approve');
		for (const action of ['Start run', 'Save revision', 'Approve', 'Abandon']) {
			expect(work).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${action}</button>`));
		}
	});

	test('keeps revealed Work runs and actions during a Runs refresh failure', () => {
		const work = workPage({
			backlog: BACKLOG,
			drafts: [DRAFT],
			selectedIssueId: BACKLOG[0]?.id ?? null,
			runs: [runIn('done')],
			operationalFailures: { Runs: 'Runs responded with 500' },
			operationalLoaded: { Runs: true },
		});
		expect(work).toContain('Runs is unavailable.');
		expect(work).toContain(BACKLOG[0]?.title ?? '');
		expect(work).toMatch(/<button(?![^>]*disabled="")[^>]*>Start run<\/button>/);
	});

	test('localizes global read failures and preserves revealed settings on refresh', () => {
		const settings = globalSettingsPage({
			operatorProfile: { name: 'Eduardo', timezone: 'America/Sao_Paulo' },
			operationalFailures: {
				'Agent defaults': 'Agent defaults responded with 500',
				Notifications: 'Notifications responded with 500',
				'Operator profile': 'Operator profile responded with 500',
				'Self update': 'Self update responded with 500',
			},
			operationalLoaded: {
				'Agent defaults': true,
				Notifications: true,
				'Operator profile': true,
				'Self update': true,
			},
		});
		for (const resource of ['Agent defaults', 'Notifications', 'Operator profile', 'Self update']) {
			expect(settings).toContain(`${resource} is unavailable.`);
		}
		expect(settings).toContain('Eduardo');
	});
});

// GSHIP-712: one representative value per Work panel, so a surface rendered for
// another project can be asserted on what it shows and on what it leaves out.
const DRAFT = {
	id: 'CAM-940',
	title: 'draft para revisar',
	scope: 'Escopo persistido',
	verificationCommand: 'bun test focused',
	state: 'stale' as const,
};

const PROPOSAL = {
	id: 'proposal-boot',
	title: 'proposta do boot',
	evidence: 'Evidência do boot.',
	sourceRunId: 'run-boot',
	sourceIssueId: 'CAM-50',
};

const DIAGNOSTICS_WITH_FINDING: AppProps['diagnostics'] = {
	...emptyDiagnostics(),
	findings: [{
		id: 'diagnostic-boot',
		analyzer: 'analyzer-factual',
		rule: 'regra-autoral',
		severity: 'warning',
		file: 'src/arquivo-autoral.tsx',
		evidence: 'Evidência do operador sem tradução.',
		toolVersion: '0.9.12',
		sourceSha: 'b'.repeat(40),
		status: 'pending',
		promotedIssueId: null,
		occurrenceCount: 1,
		firstSeenAt: '2026-08-20T12:00:00.000Z',
		lastSeenAt: '2026-08-20T12:00:00.000Z',
		updatedAt: '2026-08-20T12:00:00.000Z',
	}],
	stats: { total: 1, pending: 1, dismissed: 0, promoted: 0, cleared: 0, recurring: 0 },
};

function renderAt(route: OperatorRoute, overrides: Partial<AppProps> = {}): string {
	return renderToStaticMarkup(
		<App
			backlog={BACKLOG}
			chainRuns={EMPTY_CHAIN_RUNS}
			executorHandoff={EMPTY_EXECUTOR_HANDOFF}
			diagnostics={emptyDiagnostics()}
			agentDefaults={{ provider: 'claude', modelSettings: EMPTY_MODEL_SETTINGS }}
			drafts={[]}
			brief={EMPTY_BRIEF}
			chatMessages={[]}
			events={[]}
			gitIdentity={null}
			handoff={EMPTY_BRIEF}
			ideas={[]}
			locale={DEFAULT_LOCALE}
			modelSettings={EMPTY_MODEL_SETTINGS}
			modelSettingsSource="provider-default"
			selfUpdate={emptySelfUpdate()}
			notificationChannels={EMPTY_NOTIFICATION_CHANNELS}
			notificationPermission="default"
			onSaveOperatorProfile={() => {}}
			onAbandon={() => {}}
			onCancel={() => {}}
			onConnectCodex={() => {}}
			claudeCredentialError={null}
			onConnectClaudeCredential={() => Promise.resolve(true)}
			onDismissClaudeCredentialError={() => {}}
			onDisconnectClaudeCredential={() => {}}
			onCreateIssue={() => {}}
			onApproveIssue={() => {}}
			onAbandonIssue={() => {}}
			onDismissProposal={() => {}}
			onDismissDiagnosticFinding={() => {}}
			onEnableNotifications={() => {}}
			onRemoveResendCredential={() => {}}
			onSaveResendSettings={() => {}}
			onSendNotificationTest={() => {}}
			onPromoteProposal={() => {}}
			onPromoteDiagnosticFinding={() => {}}
			onImportProject={() => {}}
			onCreateProject={() => {}}
			onRegisterProject={() => {}}
			onUnregisterProject={() => {}}
			onResume={() => {}}
			onSaveBrief={() => {}}
			onSaveDiagnosticSchedule={() => {}}
			onSaveModelSettings={() => {}}
			onResetModelSettings={() => {}}
			onSaveAgentDefaults={() => {}}
			onSetChainRuns={() => {}}
			onSetExecutorHandoff={() => {}}
			onSetSelfUpdate={() => {}}
			onSelectIssue={() => {}}
			onSelectLocale={() => {}}
			onSelectProvider={() => {}}
			onResetProvider={() => {}}
			onSendMessage={() => {}}
			onShip={() => {}}
			onSpecifyIssue={() => {}}
			onReviewIssue={() => {}}
			onStart={() => {}}
			onStartDiagnostic={() => {}}
			onCancelDiagnostic={() => {}}
			pending={false}
			projectOnboardingPending={null}
			proposals={[]}
			project={READY_PROJECT}
			projects={[CURRENT_PROJECT]}
			operatorProfile={EMPTY_OPERATOR_PROFILE}
			providers={[]}
			resolvedProposals={[]}
			resolvedProposalsOmittedCount={0}
			route={route}
			runs={[]}
			selectedIssueId={null}
			selectedProvider="claude"
			providerSource="provider-default"
			staleService={null}
			status={null}
			suggestedTimezone="America/Sao_Paulo"
			version=""
			workspaceNotices={[]}
			{...overrides}
		/>,
	);
}

const home = (overrides: Partial<AppProps> = {}): string => renderAt('/projects/project-current', overrides);
const runsPage = (overrides: Partial<AppProps> = {}): string => renderAt('/projects/project-current/runs', overrides);
const workPage = (overrides: Partial<AppProps> = {}): string => renderAt('/projects/project-current/work', overrides);
const settingsPage = (overrides: Partial<AppProps> = {}): string => renderAt('/projects/project-current/settings', overrides);
const globalSettingsPage = (overrides: Partial<AppProps> = {}): string => renderAt('/settings', overrides);

function conversationAt(
	locale: Locale,
	overrides: Partial<{
		chatMessages: AppProps['chatMessages'];
		pending: boolean;
		run: RunView | null;
		status: string | null;
	}> = {},
): string {
	return renderToStaticMarkup(
		<ConversationColumn
			catalog={LOCALE_CATALOG[locale].conversation}
			chatMessages={overrides.chatMessages ?? []}
			locale={locale}
			onResume={() => {}}
			onSendMessage={() => {}}
			pending={overrides.pending ?? false}
			run={overrides.run ?? null}
			status={overrides.status ?? null}
		/>,
	);
}

/** Whether a command is offered at all, by the label only that button carries. */
function hasButton(html: string, label: string): boolean {
	return html.includes(`>${label}<`);
}

/**
 * Labels are unique on the screen, so a button is found by its label and read
 * back to its own opening tag. The attribute is matched as `disabled=""`, the
 * form React emits, because the class list also carries `disabled:` variants.
 */
function buttonIsEnabled(html: string, label: string): boolean {
	const index = html.indexOf(`>${label}<`);
	if (index < 0) throw new Error(`button ${label} is not on the screen`);
	const opening = html.lastIndexOf('<button', index);
	return !html.slice(opening, index).includes('disabled=""');
}

/**
 * Whether the panel carrying `title` is disclosed. The panel is found by its
 * heading -- a navigation link can repeat the words, a heading cannot -- and
 * read back to the disclosure that owns it.
 */
function panelIsOpen(html: string, title: string): boolean {
	const index = html.indexOf(`>${title}</h2>`);
	if (index < 0) throw new Error(`panel ${title} is not on the screen`);
	const opening = html.lastIndexOf('<details', index);
	if (opening < 0) throw new Error(`panel ${title} is not a disclosure`);
	return html.slice(opening, index).includes('open=""');
}

/** Every opening tag the render emitted, attributes included, in order. */
function openingTags(html: string): readonly string[] {
	return [...html.matchAll(/<[a-z][a-z0-9]*(?:\s[^>]*)?>/g)].map((match) => match[0]);
}

/** The opening tag of the first element carrying `attribute`, with its value. */
function elementWith(html: string, attribute: string): string {
	const tag = openingTags(html).find((opening) => opening.includes(attribute));
	if (tag === undefined) throw new Error(`no element carries ${attribute}`);
	return tag;
}

/** The shell header alone, which only the human state is allowed to reach. */
function shellHeader(html: string): string {
	return html.slice(html.indexOf('<header'), html.indexOf('</header>'));
}

/** One disclosed panel alone, cut at the disclosure that carries it. */
function panel(html: string, title: string): string {
	const start = html.indexOf(`>${title}</h2>`);
	if (start < 0) throw new Error(`panel ${title} is not on the screen`);
	const end = html.indexOf('</details>', start);
	return html.slice(start, end < 0 ? undefined : end);
}

/**
 * One notification channel's own row, cut at its label so `buttonIsEnabled`
 * finds that row's own "Send test" button -- with two channels (GSHIP-653)
 * the label is no longer unique across the whole panel, only within a row.
 */
function channelRow(html: string, label: string): string {
	const start = html.indexOf(label);
	if (start < 0) throw new Error(`channel row ${label} is not on the screen`);
	return html.slice(start);
}

function expectContainsAll(html: string, values: readonly string[]): void {
	for (const value of values) expect(html).toContain(value);
}

function expectNotContainsAll(html: string, values: readonly string[]): void {
	for (const value of values) expect(html).not.toContain(value);
}

describe('project onboarding', () => {
	const cases = [
		{
			locale: 'en-US',
			title: 'Set up project',
			cardTitle: 'Connect a GitHub project',
			description: 'Gateship runs inside a local clone and uses origin/main as its deterministic source.',
			existingTitle: 'Existing project',
			existingGuidance: 'Stop this process and start Gateship inside the clone.',
			newTitle: 'New project',
			newGuidance: 'Create the repository with a main branch, enter the clone and start Gateship.',
			incompleteBadge: 'incomplete configuration',
			recoveryGuidance: 'After correcting it, restart Gateship. In a container, update GATESHIP_PROJECT_DIR and recreate the service.',
			settingsGuidance: 'Agent and subscription settings remain available under ',
			settingsLabel: 'Settings',
			settingsAgents: 'Local agents',
		},
		{
			locale: 'pt-BR',
			title: 'Configurar projeto',
			cardTitle: 'Conectar um projeto do GitHub',
			description: 'O Gateship é executado dentro de um clone local e usa origin/main como sua origem determinística.',
			existingTitle: 'Projeto existente',
			existingGuidance: 'Pare este processo e inicie o Gateship dentro do clone.',
			newTitle: 'Novo projeto',
			newGuidance: 'Crie o repositório com uma branch main, entre no clone e inicie o Gateship.',
			incompleteBadge: 'configuração incompleta',
			recoveryGuidance: 'Depois de corrigir, reinicie o Gateship. Em um contêiner, atualize GATESHIP_PROJECT_DIR e recrie o serviço.',
			settingsGuidance: 'Os ajustes de agentes e assinaturas continuam disponíveis em ',
			settingsLabel: 'Ajustes',
			settingsAgents: 'Agentes locais',
		},
	] as const satisfies readonly ({ locale: Locale } & Record<string, string>)[];

	test('an empty cwd renders both setup paths in both locales across every blocked route', () => {
		const project: ProjectStatusView = {
			state: 'empty',
			name: 'workspace',
			detail: 'Runtime detail: /workspace is not a Git project.',
		};
		for (const expected of cases) {
			for (const route of ['/', '/runs', '/work'] as const) {
				const html = renderAt(route, { locale: expected.locale, project });
				expect(html).toContain(expected.title);
				expect(html).toContain(expected.cardTitle);
				expect(html).toContain(expected.description);
				expect(html).toContain(expected.existingTitle);
				expect(html).toContain(expected.existingGuidance);
				expect(html).toContain(expected.newTitle);
				expect(html).toContain(expected.newGuidance);
				expect(html).toContain(project.detail);
				expect(html).toContain('cd /path/to/project &amp;&amp; gship');
				expect(html).toContain('gh repo create OWNER/REPO --private --add-readme --clone');
				expect(html).toContain('cd REPO &amp;&amp; gship');
				expect(html).toContain(expected.settingsGuidance);
				expect(html).toContain(`href="/projects/project-current/settings">${expected.settingsLabel}</a>`);
				expect(html).not.toContain('Conversation with the orchestrator');
				expect(html).not.toContain('Backlog plannable');
				expect(html).not.toContain('Latest run');
			}
		}
	});

	test('each prerequisite failure preserves its detail and recovery command in both locales', () => {
		const failures = [
			{ reason: 'not-repository', detail: 'Runtime detail: /project is not a repository.', command: 'cd /path/to/project &amp;&amp; gship' },
			{ reason: 'origin-missing', detail: 'Runtime detail: origin is missing.', command: 'git remote add origin git@github.com:OWNER/REPO.git &amp;&amp; git fetch origin main' },
			{ reason: 'github-origin-required', detail: 'Runtime detail: origin is not on GitHub.', command: 'git remote set-url origin git@github.com:OWNER/REPO.git' },
			{ reason: 'origin-main-missing', detail: 'Runtime detail: origin/main is missing.', command: 'git fetch origin main' },
		] as const satisfies readonly {
			reason: Extract<ProjectStatusView, { state: 'needs-attention' }>['reason'];
			detail: string;
			command: string;
		}[];

		for (const expected of cases) {
			for (const route of ['/', '/runs', '/work'] as const) {
				for (const failure of failures) {
					const { command, ...projectFailure } = failure;
					const html = renderAt(route, {
						locale: expected.locale,
						project: { state: 'needs-attention', name: 'product', ...projectFailure },
					});
					expect(html).toContain(expected.title);
					expect(html).toContain(expected.cardTitle);
					expect(html).toContain(expected.description);
					expect(html).toContain(expected.incompleteBadge);
					expect(html).toContain(failure.detail);
					expect(html).toContain(command);
					expect(html).toContain(expected.recoveryGuidance);
					expect(html).toContain(expected.settingsGuidance);
					expect(html).toContain(`href="/projects/project-current/settings">${expected.settingsLabel}</a>`);
				}
			}
		}
	});

	test('settings stay available and identify the derived ready project', () => {
		for (const expected of cases) {
			const ready = settingsPage({ locale: expected.locale });
			expect(ready).toContain('acme/gateship');
			expect(ready).toContain('origin/main');
			expect(ready).toContain(expected.settingsAgents);

			const detail = 'Runtime detail: the repository does not have an origin remote.';
			const blocked = settingsPage({
				locale: expected.locale,
				project: {
					state: 'needs-attention',
					name: 'product',
					reason: 'origin-missing',
					detail,
				},
			});
			expect(blocked).toContain(detail);
			expect(blocked).toContain(expected.settingsAgents);
			expect(blocked).not.toContain(expected.cardTitle);
		}
	});

	test('a ready project continues to exclude onboarding', () => {
		for (const expected of cases) {
			for (const route of ['/', '/runs', '/work'] as const) {
				expect(renderAt(route, { locale: expected.locale })).not.toContain(expected.cardTitle);
			}
		}
	});
});

describe('conversation surface', () => {
	test('the typed conversation catalog renders the complete owned surface in both locales', () => {
		const cases = [
			{
				locale: 'en-US',
				transcript: 'Conversation transcript',
				empty: 'Describe the goal, ask for an investigation or give a command in natural language.',
				title: 'Conversation with the orchestrator',
				description: 'It can investigate the project; actions go through the deterministic runtime.',
				operator: 'you',
				orchestrator: 'orchestrator',
				cost: 'Expected cumulative cost for 1 orchestrator turn: $0.08.',
				waiting: 'The run is waiting for your decision.',
				responseLabel: 'Your response',
				responsePlaceholder: 'Decision or guidance for the agent',
				responseButton: 'Respond and resume',
				composerLabel: 'Message for the orchestrator',
				composerPlaceholder: 'What do you want to do now?',
				composerButton: 'Send',
			},
			{
				locale: 'pt-BR',
				transcript: 'Transcrição da conversa',
				empty: 'Descreva o objetivo, peça uma investigação ou dê um comando em linguagem natural.',
				title: 'Conversa com o orquestrador',
				description: 'Ele pode investigar o projeto; as ações passam pelo runtime determinístico.',
				operator: 'você',
				orchestrator: 'orquestrador',
				cost: 'Custo cumulativo esperado para 1 turno do orquestrador: US$',
				waiting: 'A execução está aguardando sua decisão.',
				responseLabel: 'Sua resposta',
				responsePlaceholder: 'Decisão ou orientação para o agente',
				responseButton: 'Responder e retomar',
				composerLabel: 'Mensagem para o orquestrador',
				composerPlaceholder: 'O que você quer fazer agora?',
				composerButton: 'Enviar',
			},
		] as const satisfies readonly ({ locale: Locale } & Record<string, string>)[];

		for (const expected of cases) {
			const empty = conversationAt(expected.locale);
			const conversationMain = openingTags(empty).find((tag) => tag.startsWith('<main'));
			expect(conversationMain).toContain(`aria-label="${expected.title}"`);
			expect(empty).toContain(`aria-label="${expected.transcript}"`);
			expect(empty).toContain(expected.empty);
			expect(empty).not.toContain('data-slot="card-frame-header"');
			expect(empty).not.toContain('data-slot="card-frame-title"');
			expect(empty).not.toContain(expected.description);

			const populated = conversationAt(expected.locale, {
				chatMessages: [
					{
						seq: 1,
						providerId: 'codex',
						role: 'operator',
						text: 'Preserve esta mensagem.',
						createdAt: '2026-08-21T10:00:00.000Z',
					},
					{
						seq: 2,
						providerId: 'claude',
						role: 'orchestrator',
						text: 'Keep this message unchanged.',
						createdAt: '2026-08-21T10:01:00.000Z',
						usage: { model: 'claude-opus-4-6', effort: 'high', totalCostUsd: 0.08 },
					},
				],
				run: runIn('waiting-user', { summary: 'Durable run summary.' }),
			});
			expect(populated).toContain(`>${expected.operator}</span>`);
			expect(populated).toContain(`>${expected.orchestrator}</span>`);
			expect(populated).toContain('Preserve esta mensagem.');
			expect(populated).toContain('Keep this message unchanged.');
			expect(populated).toContain('codex');
			expect(populated).toContain('claude');
			expect(populated).toContain(expected.cost);
			if (expected.locale === 'pt-BR') expect(populated).toContain('0,08');
			expect(populated).toContain(expected.waiting);
			expect(populated).toContain(`>${expected.responseLabel}</label>`);
			expect(elementWith(populated, 'name="operatorGuidance"'))
				.toContain(`placeholder="${expected.responsePlaceholder}"`);
			expect(hasButton(populated, expected.responseButton)).toBe(true);
			expect(populated).toContain(`>${expected.composerLabel}</label>`);
			expect(elementWith(populated, 'name="message"'))
				.toContain(`placeholder="${expected.composerPlaceholder}"`);
			expect(hasButton(populated, expected.composerButton)).toBe(true);
		}
	});

	test('the lateral is the compact inspector and nothing else', () => {
		const html = home({
			events: [{
				seq: 1,
				runId: 'run-1',
				kind: 'provider.activity',
				fromState: 'working',
				toState: 'working',
				payload: { text: 'Vou ajustar o parser.' },
				createdAt: '2026-08-16T03:04:05.000Z',
			}],
			ideas: [{ id: 'CAM-42', title: 'ideia antiga' }],
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', plan: 'max', login: 'external' },
			],
			runs: [
				runIn('done', { summary: 'Relatório longo do runtime.' }),
				runIn('failed', { id: 'run-0', issueId: 'CAM-801' }),
			],
			workspaceNotices: [{
				kind: 'dirty',
				runId: null,
				workspacePath: '/project/.gship/worktrees/orphan',
				branch: 'gship/cam-1-orphan',
				detail: 'workspace is not owned by a persisted run',
			}],
		});

		// What the inspector is for: the issue, the state, the progress, the way on.
		expect(html).toContain('CAM-900');
		expect(html).toContain('done');
		expect(html).toContain('100%');
		expect(html).toContain('href="/projects/project-current/runs"');
		// Telemetry, configuration, history and planning are other surfaces.
		expect(html).not.toContain('run-1');
		expect(html).not.toContain('Relatório longo do runtime.');
		expect(html).not.toContain('Activity');
		expect(html).not.toContain('Runs anteriores');
		expect(html).not.toContain('Preserved workspaces');
		expect(html).not.toContain('Backlog plannable');
		expect(html).not.toContain('New issue');
		expect(html).not.toContain('Specify idea');
		expect(html).not.toContain('Local agents');
		expect(html).not.toContain('Notifications');
	});

	test('the inspector offers the commands the run admits, and renders no others', () => {
		const idle = home();
		expect(idle).toContain('No runs recorded yet.');
		expect(idle).toContain('Idle');
		expect(hasButton(idle, 'Cancel')).toBe(false);
		expect(hasButton(idle, 'Ship')).toBe(false);
		expect(hasButton(idle, 'Resume')).toBe(false);

		const working = home({ runs: [runIn('working')] });
		expect(working).toContain('Phase working');
		expect(buttonIsEnabled(working, 'Cancel')).toBe(true);
		expect(hasButton(working, 'Ship')).toBe(false);
		expect(hasButton(working, 'Resume')).toBe(false);

		const readyToShip = home({ runs: [runIn('ready-to-ship')] });
		expect(buttonIsEnabled(readyToShip, 'Ship')).toBe(true);
		expect(buttonIsEnabled(readyToShip, 'Cancel')).toBe(true);

		const interrupted = home({ runs: [runIn('interrupted')] });
		expect(buttonIsEnabled(interrupted, 'Resume')).toBe(true);
		// The interrupted run is the only one that can be ended without resuming.
		expect(buttonIsEnabled(interrupted, 'Abandon')).toBe(true);
		expect(hasButton(working, 'Abandon')).toBe(false);
		expect(hasButton(readyToShip, 'Abandon')).toBe(false);

		const cancelled = home({ runs: [runIn('cancelled')] });
		expect(cancelled).toContain('cancelled');
		expect(cancelled).toContain('Idle');
		expect(hasButton(cancelled, 'Abandon')).toBe(false);
		expect(hasButton(cancelled, 'Resume')).toBe(false);
		expect(hasButton(cancelled, 'Cancel')).toBe(false);
		expect(hasButton(cancelled, 'Ship')).toBe(false);
	});

	test('a command in flight holds the commands that are offered', () => {
		const html = home({ pending: true, runs: [runIn('ready-to-ship')] });

		expect(buttonIsEnabled(html, 'Ship')).toBe(false);
		expect(buttonIsEnabled(html, 'Cancel')).toBe(false);
	});

	test('conversation renders the durable cross-provider handoff', () => {
		const html = home({
			chatMessages: [
				{
					seq: 1,
					providerId: 'codex',
					role: 'operator',
					text: 'Investigue o core.',
					createdAt: '2026-08-16T03:00:00.000Z',
				},
				{
					seq: 2,
					providerId: 'claude',
					role: 'orchestrator',
					text: 'Retomei o contexto e encontrei o loop.',
					createdAt: '2026-08-16T03:01:00.000Z',
				},
			],
		});

		expect(openingTags(html).find((tag) => tag.startsWith('<main')))
			.toContain('aria-label="Conversation with the orchestrator"');
		expect(html).toContain('for="orchestrator-message"');
		expect(html).toContain('>Message for the orchestrator</label>');
		expect(html).toContain('name="message"');
		expect(html).toContain('Investigue o core.');
		expect(html).toContain('Retomei o contexto e encontrei o loop.');
		expect(html).toContain('codex');
		expect(html).toContain('claude');
	});

	// GSHIP-634: the orchestrator's own turns were invisible next to the
	// executor and reviewer, which already show an expected-cost total (GSHIP-
	// 623/628) -- this is the same label and honesty rules, applied to the
	// conversation surface, and it covers exactly the turns that reported usage.
	test('shows the accumulated expected cost of the orchestrator turns that reported usage, with the turn count', () => {
		const chatMessages: AppProps['chatMessages'] = [
			{
				seq: 1,
				providerId: 'claude',
				role: 'operator',
				text: 'Qual é o objetivo desta fatia?',
				createdAt: '2026-08-18T03:00:00.000Z',
			},
			{
				seq: 2,
				providerId: 'claude',
				role: 'orchestrator',
				text: 'Investiguei o core.',
				createdAt: '2026-08-18T03:00:05.000Z',
				usage: { model: 'claude-opus-4-6', effort: 'high', totalCostUsd: 0.08 },
			},
			{
				seq: 3,
				providerId: 'claude',
				role: 'operator',
				text: 'E agora?',
				createdAt: '2026-08-18T03:01:00.000Z',
			},
			{
				seq: 4,
				providerId: 'claude',
				role: 'orchestrator',
				text: 'Segui em frente.',
				createdAt: '2026-08-18T03:01:05.000Z',
				usage: { model: 'claude-opus-4-6', effort: 'high', totalCostUsd: 0.05 },
			},
		];
		const aggregate = aggregateChatTurnCosts(chatMessages);
		expect(aggregate.totalCostUsd).toBeCloseTo(0.13, 6);
		expect(aggregate.turnCount).toBe(2);

		const html = home({ chatMessages });
		expect(html).toContain('Expected cumulative cost');
		expect(html).toContain('2 orchestrator turns');
		expect(html).toContain('$');
	});

	// A turn that never reported usage stays entirely out of the total and the
	// count -- never a fabricated zero, the same rule GSHIP-623 established.
	test('shows no accumulated turn cost when no orchestrator turn ever reported usage', () => {
		const chatMessages: AppProps['chatMessages'] = [
			{
				seq: 1,
				providerId: 'claude',
				role: 'operator',
				text: 'Investigue o core.',
				createdAt: '2026-08-18T03:00:00.000Z',
			},
			{
				seq: 2,
				providerId: 'claude',
				role: 'orchestrator',
				text: 'Sem custo reportado pelo CLI.',
				createdAt: '2026-08-18T03:00:05.000Z',
			},
		];
		expect(aggregateChatTurnCosts(chatMessages)).toEqual({ totalCostUsd: null, turnCount: 0 });
		expect(home({ chatMessages })).not.toContain('Expected cumulative cost');
	});

	test('the run asks for its decision on the conversation surface, once', () => {
		const html = home({
			runs: [runIn('waiting-user', { summary: 'Escolha o seam de migração.' })],
		});

		expect(html).toContain('waiting-user');
		expect(html).toContain('name="operatorGuidance"');
		expect(buttonIsEnabled(html, 'Respond and resume')).toBe(true);
		expect(html.split('Escolha o seam de migração.')).toHaveLength(2);
		// Resuming is the answer itself while the run waits, never a bare command.
		expect(hasButton(html, 'Resume')).toBe(false);
	});

	test('a transport error is announced where the command was issued', () => {
		expect(home({ status: 'Falha ao ler /api/runs' })).toContain('Falha ao ler /api/runs');
		expect(workPage({ status: 'CAM-902 criada e selecionada.' }))
			.toContain('CAM-902 criada e selecionada.');
	});
});

describe('runs surface', () => {
	test('the detail card shows the phase and the commands the state admits', () => {
		expect(runsPage()).toContain('No runs recorded yet.');

		const working = runsPage({ runs: [runIn('working')] });
		expect(working).toContain('CAM-900');
		expect(working).toContain('Phase working');
		expect(buttonIsEnabled(working, 'Cancel')).toBe(true);
		expect(hasButton(working, 'Ship')).toBe(false);

		// The run is already shipping itself: the command is only the retry.
		const shipping = runsPage({ runs: [runIn('shipping')] });
		expect(shipping).toContain('Phase shipping');
		expect(hasButton(shipping, 'Ship')).toBe(false);
		expect(buttonIsEnabled(shipping, 'Cancel')).toBe(true);

		const done = runsPage({ runs: [runIn('done')] });
		expect(done).toContain('100%');
		expect(hasButton(done, 'Cancel')).toBe(false);
		expect(hasButton(done, 'Ship')).toBe(false);
	});

	test('the current-run card and runs surface link the pull request and show compact CI state', () => {
		const run = runIn('shipping', {
			ciCorrection: {
				prNumber: 685,
				headSha: 'abc123',
				check: {
					name: 'required/verify',
					url: 'https://github.com/gateship-dev/gateship/actions/runs/720',
				},
			},
			pullRequest: {
				prNumber: 685,
				url: 'https://github.com/gateship-dev/gateship/pull/685',
				ciStatus: 'failed',
				failedChecks: [{
					name: 'verify',
					url: 'https://github.com/gateship-dev/gateship/actions/runs/685',
				}],
			},
		});
		for (const html of [home({ runs: [run] }), runsPage({ runs: [run] })]) {
			expect(html).toContain('href="https://github.com/gateship-dev/gateship/pull/685"');
			expect(html).toContain('PR #685');
			expect(html).toContain('CI failed');
			expect(html).toContain('href="https://github.com/gateship-dev/gateship/actions/runs/685"');
			expect(html).toContain('verify');
			expect(html).toContain('href="https://github.com/gateship-dev/gateship/actions/runs/720"');
			expect(html).toContain('CI correction: required/verify');
			expect(html).not.toContain('>Merged<');
		}
	});

	test('a confirmed pull request is marked merged only for a done run, in detail and history', () => {
		const pullRequest: NonNullable<RunView['pullRequest']> = {
			prNumber: 692,
			url: 'https://github.com/gateship-dev/gateship/pull/692',
			ciStatus: 'passed',
			failedChecks: [],
		};
		const current = runIn('done', { pullRequest });
		const previous = runIn('done', { id: 'run-previous', issueId: 'CAM-899', pullRequest });

		expect(runsPage({ runs: [current] })).toContain('>Merged<');
		expect(runsPage({ runs: [current, previous] }).match(/>Merged</g)).toHaveLength(2);
		expect(runsPage({ runs: [runIn('shipping', { pullRequest })] })).not.toContain('>Merged<');
	});

	test('a provider hold shows its cause, reset time and retry without losing the run', () => {
		const html = runsPage({
			runs: [runIn('waiting-provider', {
				providerWait: {
					provider: 'claude',
					kind: 'usage-limit',
					message: 'Claude five hour usage limit reached.',
					phase: 'working',
					retryAt: '2026-08-20T12:10:00.000Z',
				},
			})],
		});

		expect(html).toContain('Claude Code on hold');
		expect(html).toContain('Subscription usage limit reached');
		expect(html).toContain('Claude five hour usage limit reached.');
		expect(html).toContain('dateTime="2026-08-20T12:10:00.000Z"');
		expect(buttonIsEnabled(html, 'Resume')).toBe(true);
	});

	// GSHIP-722: the executor handoff is disclosed regardless of the run's
	// current state -- shown here on a run already back to working on the
	// alternate provider, well past the hold that triggered the transfer.
	test('an executor handoff shows its origin, destination and reason', () => {
		const html = runsPage({
			runs: [runIn('working', {
				executorHandoff: {
					from: 'claude',
					to: 'codex',
					reason: 'usage-limit',
					message: 'Claude usage limit reached.',
					outcome: 'completed',
					createdAt: '2026-08-20T12:10:00.000Z',
				},
			})],
		});

		expect(html).toContain('Executor handed off from Claude Code to Codex');
		expect(html).toContain('Reason: Subscription usage limit reached');
	});

	test('a run with no executor handoff shows no handoff disclosure', () => {
		const html = runsPage({ runs: [runIn('working')] });
		expect(html).not.toContain('Executor handed off');
	});

	// GSHIP-722 review: a refused attempt never transferred anything -- the run
	// stayed on Claude, its own origin -- so the disclosure must say the
	// attempt was refused, never that a handoff to Codex happened.
	test('a refused executor handoff discloses the refusal, not a transfer that did not happen', () => {
		const html = runsPage({
			runs: [runIn('waiting-provider', {
				executorHandoff: {
					from: 'claude',
					to: 'codex',
					reason: 'usage-limit',
					message: 'Claude usage limit reached.',
					outcome: 'refused',
					createdAt: '2026-08-20T12:10:00.000Z',
				},
			})],
		});

		expect(html).toContain('Executor handoff to Codex was refused; the run stayed on Claude Code');
		expect(html).not.toContain('Executor handed off from Claude Code to Codex');
	});

	test('an explicit pt-BR locale translates the shared run inspector and preserves runtime text', () => {
		const retryAt = '2026-08-20T12:10:00.000Z';
		const formattedRetryAt = new Date(retryAt).toLocaleString('pt-BR', {
			dateStyle: 'short',
			timeStyle: 'short',
		});
		const formattedCost = new Intl.NumberFormat('pt-BR', {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 4,
		}).format(0.1534);
		const waitingRun = runIn('waiting-provider', {
			summary: 'Resumo escrito pelo runtime para CAM-900.',
			cost: { totalCostUsd: 0.1534, breakdown: [], roles: [] },
			roundOrigins: { executor: 1, decision: 2, indeterminate: 1 },
			providerWait: {
				provider: 'claude',
				kind: 'usage-limit',
				message: 'Claude five hour usage limit reached.',
				phase: 'working',
				retryAt,
			},
		});
		const html = runsPage({ locale: 'pt-BR', runs: [waitingRun] });

		expect(html).toContain('Execução mais recente');
		expect(html).toContain('CAM-900');
		expect(html).toContain('>aguardando provedor<');
		expect(html).toContain('Fase em andamento');
		expect(shellHeader(html)).toContain('Precisa de você');
		expect(html).toContain('Claude Code em espera');
		expect(html).toContain('Limite de uso da assinatura atingido');
		expect(html).toContain('Claude five hour usage limit reached.');
		expect(html).toContain(`dateTime="${retryAt}"`);
		expect(html).toContain(formattedRetryAt);
		// The cost lives in the stat row on /runs: value and label are paired
		// by the stat, no longer one sentence.
		expect(html).toContain(`>${formattedCost}</p>`);
		expect(html).toContain('Custo esperado');
		expect(html).toContain('Rodadas de correção: 1 do executor, 2 de decisões do operador');
		expect(html).toContain('1 indeterminada');
		expect(buttonIsEnabled(html, 'Retomar')).toBe(true);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(true);
		expect(panel(html, 'Resumo e diagnósticos')).toContain(
			'O relatório completo do runtime e o identificador técnico da execução.',
		);
		expect(panel(html, 'Resumo e diagnósticos')).toContain('Resumo escrito pelo runtime para CAM-900.');
		expect(panel(html, 'Resumo e diagnósticos')).toContain('run-1');

		const interrupted = runsPage({ locale: 'pt-BR', runs: [runIn('interrupted')] });
		expect(buttonIsEnabled(interrupted, 'Retomar')).toBe(true);
		expect(buttonIsEnabled(interrupted, 'Abandonar')).toBe(true);
		const ready = runsPage({ locale: 'pt-BR', runs: [runIn('ready-to-ship')] });
		expect(buttonIsEnabled(ready, 'Enviar')).toBe(true);
		expect(buttonIsEnabled(ready, 'Cancelar')).toBe(true);

		const current = home({ locale: 'pt-BR', runs: [waitingRun] });
		expect(current).toContain('aria-label="Inspetor da execução"');
		expect(current).toContain('Execução atual');
		expect(current).toContain('Ver detalhes da execução');
		expect(shellHeader(home({ locale: 'pt-BR', runs: [runIn('working')] })))
			.toContain('Trabalhando');
		expect(shellHeader(home({ locale: 'pt-BR' }))).toContain('Ocioso');
	});

	test('an explicit pt-BR locale translates all operational run panels and preserves authored values', () => {
		const activityAt = '2026-08-16T03:04:05.000Z';
		const previousAt = '2026-08-15T18:30:00.000Z';
		const formattedActivityAt = new Date(activityAt).toLocaleTimeString('pt-BR', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
			timeZone: 'UTC',
		});
		const formattedPreviousAt = new Date(previousAt).toLocaleString('pt-BR', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
			timeZone: 'UTC',
		});
		const formattedCost = new Intl.NumberFormat('pt-BR', {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 4,
		}).format(0.1534);
		const html = runsPage({
			locale: 'pt-BR',
			runs: [
				runIn('working', {
					id: 'run-current-authored',
					issueId: 'GSHIP-AUTHORED-CURRENT',
					cost: {
						totalCostUsd: 0.2,
						breakdown: [{
							role: 'executor',
							model: 'model/Authored-V1',
							costUsd: 0.1534,
							inputTokens: 1100,
							outputTokens: 210,
							cacheReadInputTokens: 320,
							cacheCreationInputTokens: 45,
						}, {
							role: 'reviewer',
							model: 'reviewer/Authored-V2',
							costUsd: 0.0466,
						}],
						roles: [{ role: 'executor', effort: 'xhigh-authored', thinkingTokens: 35704 }],
					},
				}),
				runIn('failed', {
					id: 'run-previous-authored',
					issueId: 'GSHIP-AUTHORED-PREVIOUS',
					updatedAt: previousAt,
					cost: { totalCostUsd: 0.1534, breakdown: [], roles: [] },
				}),
			],
			events: [{
				seq: 91,
				runId: 'run-current-authored',
				kind: 'provider.authored-kind',
				fromState: 'working',
				toState: 'working',
				payload: {
					text: 'Texto do operador permanece verbatim.',
					tools: ['RawTool-A', 'RawTool-B'],
					findings: 'finding authored exactly',
					error: 'error authored exactly',
				},
				createdAt: activityAt,
			}],
			workspaceNotices: [{
				kind: 'dirty',
				runId: 'run-notice-authored',
				workspacePath: '/raw/workspace/authored',
				branch: 'raw/branch-not-shown',
				detail: 'detail authored exactly',
			}, {
				kind: 'orphan',
				runId: null,
				workspacePath: null,
				branch: 'raw/branch/authored',
				detail: 'second detail authored exactly',
			}],
		});

		const cost = panel(html, 'Custo por função e modelo');
		expect(html).toContain('GSHIP-AUTHORED-CURRENT');
		expect(cost).toContain('Custo esperado do uso equivalente à API');
		expect(cost).toContain('Executor (esforço xhigh-authored) · 35704 de raciocínio');
		expect(cost).toContain('Revisor');
		expect(cost).toContain('1100 entrada · 210 saída · 320 cache lido · 45 cache criado tokens');
		expect(cost).toContain('model/Authored-V1');
		expect(cost).toContain('reviewer/Authored-V2');
		expect(cost).toContain(formattedCost);

		const activity = panel(html, 'Atividade');
		expect(activity).toContain('1 evento recente desta execução.');
		expect(activity).toContain('provider.authored-kind');
		expect(activity).toContain('Texto do operador permanece verbatim.');
		expect(activity).toContain('Ferramentas: RawTool-A, RawTool-B');
		expect(activity).toContain('finding authored exactly');
		expect(activity).toContain('error authored exactly');
		expect(activity).toContain(formattedActivityAt);

		const workspaces = panel(html, 'Workspaces preservados');
		expect(workspaces).toContain('2 recursos locais precisam de inspeção.');
		for (const raw of [
			'dirty',
			'run-notice-authored',
			'/raw/workspace/authored',
			'detail authored exactly',
			'orphan',
			'raw/branch/authored',
			'second detail authored exactly',
		]) expect(workspaces).toContain(raw);

		const previous = panel(html, 'Execuções anteriores');
		expect(previous).toContain('1 execução antes da mais recente, da mais nova para a mais antiga.');
		expect(previous).toContain('GSHIP-AUTHORED-PREVIOUS');
		expect(previous).toContain('>falhou<');
		expect(previous).toContain(`Custo esperado: ${formattedCost}`);
		expect(previous).toContain(formattedPreviousAt);
	});

	test('the full report and the run id are one disclosure, closed by default', () => {
		const html = runsPage({ runs: [runIn('done', { summary: 'PR #123 mergeado.' })] });

		expect(panelIsOpen(html, 'Summary and diagnostics')).toBe(false);
		// Closed is a rendering state, not a missing branch.
		expect(panel(html, 'Summary and diagnostics')).toContain('PR #123 mergeado.');
		expect(panel(html, 'Summary and diagnostics')).toContain('run-1');

		const failed = runsPage({ runs: [runIn('failed', { error: 'oracle reprovou a story 2' })] });
		expect(failed).toContain('failed');
		expect(panel(failed, 'Summary and diagnostics')).toContain('oracle reprovou a story 2');

		// The question a waiting run is asking belongs to the report as well.
		const waiting = runsPage({ runs: [runIn('waiting-user', { summary: 'Escolha o seam.' })] });
		expect(panel(waiting, 'Summary and diagnostics')).toContain('Escolha o seam.');

		// Nothing to report: no empty disclosure.
		expect(runsPage({ runs: [runIn('working')] })).not.toContain('Summary and diagnostics');
	});

	// GSHIP-623: the card shows the total the server already derived, always
	// labeled as the expected cost -- the operator pays a subscription, not the
	// API -- and never as zero when the CLI simply never reported one.
	test('the card shows the derived total, labeled as expected cost, only once it exists', () => {
		const withCost = runsPage({
			runs: [runIn('done', {
				cost: {
					totalCostUsd: 0.1534,
					breakdown: [{ role: 'executor', model: 'claude-opus-4-6', costUsd: 0.1534 }],
					roles: [],
				},
			})],
		});
		expect(withCost).toContain('Expected cost');
		expect(withCost).toContain('$');

		// No usage event ever reported a cost for this run: the card says nothing
		// about cost rather than showing a fabricated zero.
		const withoutCost = runsPage({ runs: [runIn('done')] });
		expect(withoutCost).not.toContain('Expected cost');
	});

	// GSHIP-659: the card shows where the run's correction rounds came from,
	// beside the cost it already shows -- no new screen, no chart. A round the
	// server could not attribute is only named when it happened.
	test('the card shows the round origins beside the cost, an indeterminate count only when it happened', () => {
		const attributed = runsPage({
			runs: [runIn('done', { roundOrigins: { executor: 2, decision: 1, indeterminate: 0 } })],
		});
		expect(attributed).toContain('Correction rounds');
		expect(attributed).toContain('2 from the executor');
		expect(attributed).toContain('1 from an operator decision');
		expect(attributed).not.toContain('indeterminate');

		const withIndeterminate = runsPage({
			runs: [runIn('done', { roundOrigins: { executor: 0, decision: 0, indeterminate: 1 } })],
		});
		expect(withIndeterminate).toContain('Correction round:');
		expect(withIndeterminate).toContain('1 with indeterminate origin');

		// No correction round happened at all: nothing to report, not a
		// fabricated zero line.
		const withoutRounds = runsPage({ runs: [runIn('done')] });
		expect(withoutRounds).not.toContain('Correction rounds');
	});

	test('the detail breaks the total down by role and model, with the token counts each reported', () => {
		const html = runsPage({
			runs: [runIn('done', {
				cost: {
					totalCostUsd: 0.19,
					breakdown: [
						{
							role: 'executor',
							model: 'claude-opus-4-6',
							costUsd: 0.16,
							inputTokens: 1100,
							outputTokens: 210,
						},
						{ role: 'reviewer', model: 'claude-sonnet-4-6', costUsd: 0.03 },
					],
					roles: [],
				},
			})],
		});

		const breakdown = panel(html, 'Cost by role and model');
		expect(breakdown).toContain('Executor');
		expect(breakdown).toContain('claude-opus-4-6');
		expect(breakdown).toContain('1100 input');
		expect(breakdown).toContain('210 output');
		expect(breakdown).toContain('Reviewer');
		expect(breakdown).toContain('claude-sonnet-4-6');
		// Honesty requirement: shown as an equivalent, and explicit that it is
		// never the amount the subscription actually charged.
		expect(breakdown).toContain('Expected API-equivalent usage cost');
		expect(breakdown).toContain('Never the amount charged to the subscription');

		// No breakdown at all: no empty disclosure, same pattern as the report.
		expect(runsPage({ runs: [runIn('working')] })).not.toContain('Cost by role and model');
	});

	// GSHIP-628: effort and thinking are properties of the invocation, not of
	// any one model in it, so they sit on the role heading above its model
	// rows -- never on a model row itself -- and only when that role's
	// invocations actually reported them, never a fabricated value.
	test('the breakdown shows effort and thinking on the role heading, never on a model row', () => {
		const html = runsPage({
			runs: [runIn('done', {
				cost: {
					totalCostUsd: 0.2,
					breakdown: [
						{
							role: 'executor',
							model: 'claude-opus-4-6',
							costUsd: 0.18,
							inputTokens: 1000,
							outputTokens: 200,
						},
						// The reviewer's invocations never reported an effort or a
						// thinking count: absence stays absent, never a fabricated zero.
						{ role: 'reviewer', model: 'claude-sonnet-4-6', costUsd: 0.02, inputTokens: 300 },
					],
					roles: [{ role: 'executor', effort: 'xhigh', thinkingTokens: 35704 }],
				},
			})],
		});

		const breakdown = panel(html, 'Cost by role and model');
		expect(breakdown).toContain('Executor (xhigh)');
		expect(breakdown).toContain('35704 thinking');
		// The effort and thinking sit on the role heading, not beside the model.
		expect(breakdown).not.toContain('claude-opus-4-6 (xhigh)');

		const reviewerLine = breakdown.slice(breakdown.indexOf('Revisor'));
		expect(reviewerLine).not.toContain('(');
		expect(reviewerLine).not.toContain('thinking');
	});

	test('summarizes raw outcomes, correction origins and known cost without a score', () => {
		const runs = [
			runIn('done', {
				id: 'run-3',
				cost: { totalCostUsd: 0.1, breakdown: [], roles: [] },
				roundOrigins: { executor: 1, decision: 0, orchestrator: 1, indeterminate: 0 },
				evaluation: evaluation('revision-current', 'shipped', { resolvedCycleQuestions: 1 }),
			}),
			runIn('failed', {
				id: 'run-2',
				cost: { totalCostUsd: 0.05, breakdown: [], roles: [] },
				roundOrigins: { executor: 0, decision: 2, indeterminate: 0 },
			}),
			runIn('cancelled', { id: 'run-1', cost: EMPTY_RUN_COST }),
		];
		const aggregate = aggregateRunCosts(runs);
		expect(aggregate.totalCostUsd).toBeCloseTo(0.15, 6);
		expect(aggregate.runCount).toBe(3);
		expect(summarizeWorkflow(runs)).toMatchObject({
			outcomes: { done: 1, failed: 1, cancelled: 1, active: 0 },
			corrections: { executor: 1, decision: 2, indeterminate: 0, runCount: 2 },
			cost: { reportedRunCount: 2, runCount: 3 },
		});

		const summary = panel(runsPage({ runs }), 'Workflow signals');
		expect(summary).toContain('Local window of the latest 3 runs');
		expect(summary).toContain('1 completed');
		expect(summary).toContain('4 rounds across 2 runs');
		expect(summary).toContain('1 orchestrator-resolved');
		expect(summary).toContain('1 response across 1 run');
		expect(summary).toContain('2 after human decisions');
		expect(summary).toContain('$');
		expect(summary).not.toContain('Score');
	});

	// GSHIP-720: a CI correction is a correction round like any other. A run
	// whose only round came from CI reports it in the card, in the workflow
	// totals and in the cohort totals, instead of reading as a run that was
	// never corrected.
	test('counts a CI-only correction in the card, the workflow totals and the cohort totals', () => {
		const runs = [runIn('done', {
			id: 'run-ci',
			roundOrigins: { executor: 0, ci: 1, decision: 0, indeterminate: 0 },
			evaluation: evaluation('revision-ci', 'shipped'),
		})];
		expect(summarizeWorkflow(runs)).toMatchObject({
			corrections: { executor: 0, ci: 1, decision: 0, indeterminate: 0, runCount: 1 },
		});

		const html = runsPage({ runs });
		expect(html).toContain('Correction round:');
		expect(html).toContain('1 from CI correction');

		const summary = panel(html, 'Workflow signals');
		expect(summary).toContain('1 round across 1 run');
		expect(summary).toContain('1 from CI correction');

		// The cohort reports the same single round: its total is not a
		// per-origin sum that silently drops the CI one.
		expect(summarizeWorkflowCohorts(runs)[0]).toMatchObject({
			corrections: { executor: 0, ci: 1, decision: 0, indeterminate: 0, runCount: 1 },
		});
		expect(panel(html, 'Replayable benchmarks')).toContain('1 round across 1 run');
	});

	test('keeps absent provider cost explicit instead of fabricating zero', () => {
		const runs = [runIn('done', { id: 'run-2' }), runIn('failed', { id: 'run-1' })];
		expect(aggregateRunCosts(runs)).toEqual({ totalCostUsd: null, runCount: 2 });
		expect(panel(runsPage({ runs }), 'Workflow signals'))
			.toContain('No provider reported cost in this window.');
	});

	test('replays adjacent workflow revisions as separate factual cohorts, never one score', () => {
		const currentRoles = [{
			role: 'executor' as const,
			models: ['claude-sonnet-5'],
			efforts: ['xhigh'],
		}];
		const runs = [
			runIn('done', {
				id: 'run-b2',
				cost: { totalCostUsd: 0.1, breakdown: [], roles: [] },
				roundOrigins: { executor: 1, decision: 0, indeterminate: 0 },
					evaluation: evaluation('revision-b', 'shipped', {
					wallTimeMs: 12 * 60_000,
					attentionRequests: 1,
					operatorInterventions: 1,
					resolvedCycleQuestions: 2,
					roles: currentRoles,
				}),
			}),
			runIn('failed', {
				id: 'run-b1',
				roundOrigins: { executor: 0, decision: 1, indeterminate: 0 },
				evaluation: evaluation('revision-b', 'failed', {
					wallTimeMs: 18 * 60_000,
					attentionRequests: 2,
					operatorInterventions: 1,
					providerHolds: 1,
					roles: currentRoles,
				}),
			}),
			runIn('done', {
				id: 'run-a1',
				cost: { totalCostUsd: 0.2, breakdown: [], roles: [] },
				evaluation: evaluation('revision-a', 'shipped', {
					wallTimeMs: 30 * 60_000,
					attentionRequests: 3,
					operatorInterventions: 2,
					providerHolds: 1,
					roles: [{ role: 'executor', models: ['claude-opus-5'], efforts: ['high'] }],
				}),
			}),
			runIn('done', { id: 'legacy-run' }),
		];

		const cohorts = summarizeWorkflowCohorts(runs);
		expect(cohorts).toHaveLength(2);
		expect(cohorts[0]).toMatchObject({
			revision: 'revision-b',
			terminalRunCount: 2,
			outcomes: { shipped: 1, failed: 1, cancelled: 0 },
			attention: { requests: 3, interventions: 2, runCount: 2 },
			cycleResponses: { count: 2, runCount: 1 },
			providerHolds: { count: 1, runCount: 1 },
			corrections: { executor: 1, decision: 1, indeterminate: 0, runCount: 2 },
			medianWallTimeMs: 15 * 60_000,
			cost: { reportedRunCount: 1, runCount: 2 },
			configurations: [{ provider: 'claude', runCount: 2 }],
		});

		const benchmark = panel(runsPage({ runs }), 'Replayable benchmarks');
		expect(panelIsOpen(runsPage({ runs }), 'Replayable benchmarks')).toBe(false);
		expect(benchmark).toContain('Latest cohort');
		expect(benchmark).toContain('Previous baseline');
		expect(benchmark).toContain('revision-b');
		expect(benchmark).toContain('revision-a');
		expect(benchmark).toContain('3 requests across 2 runs');
		expect(benchmark).toContain('2 responses across 1 run');
		expect(benchmark).toContain('claude-sonnet-5 (xhigh)');
		expect(benchmark).toContain('There is no composite score');

		expect(panel(runsPage({ runs: [runIn('done')] }), 'Replayable benchmarks'))
			.toContain('predate revision tracking');
	});

	test('an explicit pt-BR locale translates both analytical panels and preserves workflow facts', () => {
		const roles = [
			{ role: 'executor' as const, models: ['modelo-executor-v9'], efforts: ['xhigh'] },
			{ role: 'reviewer' as const, models: ['modelo-revisor-v4'], efforts: ['low'] },
		];
		const runs = [
			runIn('working', {
				id: 'run-incompleta',
				evaluation: evaluation('revisao-crua-77', 'incomplete', {
					provider: 'codex',
					roles,
					wallTimeMs: null,
				}),
			}),
			runIn('done', {
				id: 'run-terminal-2',
				cost: { totalCostUsd: 0.1, breakdown: [], roles: [] },
				roundOrigins: { executor: 0, decision: 1, indeterminate: 0 },
				evaluation: evaluation('revisao-crua-77', 'shipped', {
					provider: 'codex',
					wallTimeMs: 3 * 60 * 60_000,
					attentionRequests: 1,
					operatorInterventions: 2,
					providerHolds: 1,
					roles,
				}),
			}),
			runIn('failed', {
				id: 'run-terminal-1',
				cost: { totalCostUsd: 0.0534, breakdown: [], roles: [] },
				evaluation: evaluation('revisao-crua-77', 'failed', {
					provider: 'codex',
					wallTimeMs: 90 * 60_000,
					roles,
				}),
			}),
		];
		const formattedCost = new Intl.NumberFormat('pt-BR', {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 4,
		}).format(0.1534);
		const html = runsPage({ locale: 'pt-BR', runs });
		const signals = panel(html, 'Sinais do fluxo de trabalho');
		const benchmarks = panel(html, 'Benchmarks reproduzíveis');

		expect(signals).toContain('3 execuções mais recentes');
		expect(signals).toContain('sem pontuação composta');
		expect(signals).toContain('1 rodada em 1 execução');
		expect(signals).toContain('1 após uma decisão humana');
		expect(signals).toContain(formattedCost);
		expect(signals).toContain('Custo esperado do uso equivalente à API por função e modelo');
		expect(benchmarks).toContain('Coorte mais recente');
		expect(benchmarks).toContain('2 execuções · 1 execução ainda incompleta');
		expect(benchmarks).toContain('1 solicitação em 1 execução · 2 respostas');
		expect(benchmarks).toContain('1 rodada em 1 execução');
		expect(benchmarks).toContain('2,3 h da criação ao estado terminal');
		expect(benchmarks).toContain(formattedCost);
		expect(benchmarks).toContain('A comparação começa quando outra revisão');
		expect(benchmarks).toContain('Não há pontuação composta nem aprovação automática');
		expect(benchmarks).toContain('revisao-crua-77');
		expect(benchmarks).toContain('codex');
		expect(benchmarks).toContain('Executor: modelo-executor-v9 (xhigh)');
		expect(benchmarks).toContain('Revisor: modelo-revisor-v4 (low)');
	});

	test('a run shows persisted public activity and tool names', () => {
		const html = runsPage({
			runs: [runIn('working')],
			events: [
				{
					seq: 1,
					runId: 'run-1',
					kind: 'provider.activity',
					fromState: 'working',
					toState: 'working',
					payload: { text: 'Vou ajustar o parser.', tools: ['Read', 'Edit'] },
					createdAt: '2026-08-16T03:04:05.000Z',
				},
			],
		});

		expect(panelIsOpen(html, 'Activity')).toBe(true);
		expect(html).toContain('provider.activity');
		expect(html).toContain('Vou ajustar o parser.');
		expect(html).toContain('Tools: Read, Edit');
		expect(html).toContain('03:04:05');
	});

	test('cycle responses keep authored guidance and carry localized orchestrator labels', () => {
		const event: AppProps['events'][number] = {
			seq: 1,
			runId: 'run-1',
			kind: 'run.cycle-response',
			fromState: 'review',
			toState: 'review',
			payload: {
				questionId: 'question-1',
				outcome: 'continue',
				guidance: 'Keep Authored_GUIDANCE verbatim.',
				provider: 'claude',
				model: 'raw-model-v9',
				effort: 'xhigh',
			},
			createdAt: '2026-08-16T03:04:05.000Z',
		};
		const english = runsPage({ runs: [runIn('review')], events: [event] });
		const portuguese = runsPage({ locale: 'pt-BR', runs: [runIn('review')], events: [event] });

		expect(english).toContain('Orchestrator answer to the review cycle');
		expect(portuguese).toContain('Resposta do orquestrador ao ciclo de revisão');
		for (const html of [english, portuguese]) {
			expect(html).toContain('Keep Authored_GUIDANCE verbatim.');
			expect(html).toContain('raw-model-v9');
			expect(html).toContain('xhigh');
		}
	});

	test('provider noise never pushes a cycle event out of the activity window', () => {
		const noise: AppProps['events'] = Array.from({ length: 40 }, (_, index) => ({
			seq: index + 2,
			runId: 'run-1',
			kind: index % 2 === 0 ? 'provider.system' : 'provider.activity',
			fromState: 'working' as const,
			toState: 'working' as const,
			payload: index % 2 === 0 ? { subtype: 'thinking_tokens' } : {},
			createdAt: '2026-08-16T03:05:00.000Z',
		}));
		const html = runsPage({
			runs: [runIn('working')],
			events: [
				{
					seq: 1,
					runId: 'run-1',
					kind: 'verify.command.started',
					fromState: 'working',
					toState: 'verify',
					payload: { command: 'bun run check:all' },
					createdAt: '2026-08-16T03:04:05.000Z',
				},
				...noise,
			],
		});

		expect(html).toContain('verify.command.started');
		expect(html).toContain('bun run check:all');
		expect(html).not.toContain('thinking_tokens');
		expect(html).toContain('1 recent event');
	});

	test('activity with public detail survives alongside the noise it is buried in', () => {
		const html = runsPage({
			runs: [runIn('working')],
			events: [
				{
					seq: 1,
					runId: 'run-1',
					kind: 'provider.activity',
					fromState: 'working',
					toState: 'working',
					payload: {},
					createdAt: '2026-08-16T03:04:05.000Z',
				},
				{
					seq: 2,
					runId: 'run-1',
					kind: 'provider.activity',
					fromState: 'working',
					toState: 'working',
					payload: { tools: ['Grep'] },
					createdAt: '2026-08-16T03:04:06.000Z',
				},
				{
					seq: 3,
					runId: 'run-1',
					kind: 'provider.system',
					fromState: 'working',
					toState: 'working',
					payload: { subtype: 'init' },
					createdAt: '2026-08-16T03:04:07.000Z',
				},
			],
		});

		expect(html).toContain('Tools: Grep');
		expect(html).toContain('subtype: init');
		expect(html).toContain('2 recent events');
	});

	test('surfaces preserved workspaces without offering destructive cleanup', () => {
		const html = runsPage({ workspaceNotices: NOTICES });

		expect(html).toContain('Preserved workspaces');
		expect(html).toContain('/project/.gship/worktrees/orphan');
		expect(html).toContain('workspace is not owned by a persisted run');
		expect(html).not.toContain('Apagar workspace');
	});

	test('a single run has no history card to show', () => {
		expect(runsPage({ runs: [runIn('working')] })).not.toContain('Previous runs');
	});

	test('previous runs are listed read-only, newest first and without the last run', () => {
		const html = runsPage({
			runs: [
				runIn('working', { id: 'run-3', issueId: 'CAM-803' }),
				runIn('done', { id: 'run-2', issueId: 'CAM-802', updatedAt: '2026-08-15T18:30:00.000Z' }),
				runIn('failed', { id: 'run-1', issueId: 'CAM-801', updatedAt: '2026-08-14T09:05:00.000Z' }),
			],
		});
		const card = panel(html, 'Previous runs');
		const firstTimestamp = new Date('2026-08-15T18:30:00.000Z').toLocaleString('en-US', {
			year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
			hourCycle: 'h23', timeZone: 'UTC',
		});
		const secondTimestamp = new Date('2026-08-14T09:05:00.000Z').toLocaleString('en-US', {
			year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
			hourCycle: 'h23', timeZone: 'UTC',
		});

		expect(panelIsOpen(html, 'Previous runs')).toBe(false);
		expect(card).toContain('2 runs before the latest');
		expect(card).toContain('CAM-802');
		expect(card).toContain(firstTimestamp);
		expect(card).toContain('CAM-801');
		expect(card).toContain(secondTimestamp);
		expect(card).toContain('failed');
		// The run the card above commands is not repeated in the history.
		expect(card).not.toContain('CAM-803');
		expect(card.indexOf('CAM-802')).toBeLessThan(card.indexOf('CAM-801'));
		// Read-only: history rows carry no command and no selection.
		expect(card).not.toContain('<button');
		expect(card).not.toContain('aria-pressed');
	});

	// GSHIP-639: each history row carries its own expected cost so Sonnet and
	// another choice can be compared without opening either run, labeled with
	// the same honesty rule GSHIP-623 established -- expected cost equivalent
	// to API usage, never an amount billed -- and a run whose CLI never
	// reported one shows no number at all, never a fabricated zero.
	test('each history row shows its own run cost, labeled as expected cost, or none at all', () => {
		const html = runsPage({
			runs: [
				runIn('working', { id: 'run-3', issueId: 'CAM-803' }),
				runIn('done', {
					id: 'run-2',
					issueId: 'CAM-802',
					cost: { totalCostUsd: 0.1534, breakdown: [], roles: [] },
				}),
				runIn('failed', { id: 'run-1', issueId: 'CAM-801', cost: EMPTY_RUN_COST }),
			],
		});
		const card = panel(html, 'Previous runs');

		const row802 = card.slice(card.indexOf('CAM-802'), card.indexOf('CAM-801'));
		expect(row802).toContain('Expected cost');
		expect(row802).toContain('$');

		const row801 = card.slice(card.indexOf('CAM-801'));
		expect(row801).not.toContain('Expected cost');
	});

	test('history stops at four entries however long the list is', () => {
		const card = panel(
			runsPage({
				runs: Array.from({ length: 9 }, (_, index) =>
					runIn('done', { id: `run-${index}`, issueId: `CAM-8${index}0` })),
			}),
			'Previous runs',
		);

		expect(card).toContain('4 runs before the latest');
		for (const issueId of ['CAM-810', 'CAM-820', 'CAM-830', 'CAM-840']) {
			expect(card).toContain(issueId);
		}
		for (const issueId of ['CAM-800', 'CAM-850', 'CAM-880']) {
			expect(card).not.toContain(issueId);
		}
	});
});

describe('work surface', () => {
	test('the typed work catalog renders representative empty and actionable states in both locales', () => {
		const timestamp = '2026-08-20T12:00:00.000Z';
		const finding = {
			id: 'diagnostic-authored',
			analyzer: 'analyzer-factual',
			rule: 'regra-autoral',
			severity: 'warning' as const,
			file: 'src/arquivo-autoral.tsx',
			evidence: 'Evidência do operador sem tradução.',
			toolVersion: '0.9.12',
			sourceSha: 'b'.repeat(40),
			status: 'pending' as const,
			promotedIssueId: null,
			occurrenceCount: 2,
			firstSeenAt: timestamp,
			lastSeenAt: timestamp,
			updatedAt: timestamp,
		};
		const diagnostics: AppProps['diagnostics'] = {
			...emptyDiagnostics(),
			analyzers: [{
				id: 'analyzer-factual',
				label: 'Analyzer Factual',
				version: '0.9.12',
				description: 'Descrição factual do analyzer.',
			}],
			findings: [finding],
			resolvedFindings: [{
				...finding,
				id: 'diagnostic-resolved',
				status: 'promoted',
				promotedIssueId: 'GSHIP-999',
			}],
			resolvedFindingsOmittedCount: 1_234,
			stats: { total: 2, pending: 1, dismissed: 0, promoted: 1, cleared: 0, recurring: 1 },
		};
		const authored = [
			'GSHIP-AUTHORED',
			'Título autoral sem tradução',
			'Escopo autoral sem tradução',
			'bun test --filter autoral',
			'Evidência proposta sem tradução.',
			'Evidência do operador sem tradução.',
			'regra-autoral',
			'src/arquivo-autoral.tsx',
			'Analyzer Factual',
			'Descrição factual do analyzer.',
			'GSHIP-999',
		];
		const cases = [
			{
				locale: 'en-US',
				empty: ['Executable backlog', '2 admissible issues right now.', 'No pending findings.', '0 open and specified issues.', 'No pending proposals.', 'No resolved proposals yet.', 'New issue'],
				actionable: [
					'Start run', 'Gateship Diagnostics', '1 pending finding.', 'Advisory: never fixes, approves or blocks shipping.',
					'warning', 'tool 0.9.12', 'Dismiss', 'Promote', 'regra-autoral in src/arquivo-autoral.tsx',
					'Resolved (1)', 'Promoted', '+1,234 not shown.', 'Local history: 1 promoted, 0 dismissed, 0 that did not recur and 1 pending.',
					'1 finding recurred in another scan.', 'Dismissal does not mean false positive', 'Review and approve',
					'1 open and specified issue.', 'stale', 'Scope and expected outcome', 'Verification command',
					'Save revision', 'I confirm the persisted scope and verificationCommand.', 'Approve', 'Reason for abandonment',
					'Abandon', 'Derived proposals', '1 pending proposal.', 'Title', 'Resolved proposals', 'read-only',
					'Dismissal and promotion cannot be undone here.', 'became', 'Specify existing idea', 'Idea', 'Specify idea',
					'New issue', 'Create issue',
				],
				analyzerDescription: 'Errors, security, performance and accessibility in React projects.',
			},
			{
				locale: 'pt-BR',
				empty: ['Backlog executável', '2 issues admissíveis agora.', 'Nenhum achado pendente.', '0 issues abertas e especificadas.', 'Nenhuma proposta pendente.', 'Nenhuma proposta resolvida ainda.', 'Nova issue'],
				actionable: [
					'Iniciar execução', 'Diagnósticos do Gateship', '1 achado pendente.', 'Consultivo: nunca corrige, aprova nem bloqueia o envio.',
					'aviso', 'ferramenta 0.9.12', 'Descartar', 'Promover', 'regra-autoral em src/arquivo-autoral.tsx',
					'Resolvidos (1)', 'Promovido', '+1.234 não exibidos.', 'Histórico local: 1 promovidos, 0 descartados, 0 que não voltaram a ocorrer e 1 pendentes.',
					'1 achado voltou a ocorrer em outra análise.', 'Descartar não significa falso positivo', 'Revisar e aprovar',
					'1 issue aberta e especificada.', 'desatualizada', 'Escopo e resultado esperado', 'Comando de verificação',
					'Salvar revisão', 'Confirmo o escopo e o verificationCommand persistidos.', 'Aprovar', 'Motivo do abandono',
					'Abandonar', 'Propostas derivadas', '1 proposta pendente.', 'Título', 'Propostas resolvidas', 'somente leitura',
					'O descarte e a promoção não podem ser desfeitos aqui.', 'virou', 'Especificar ideia existente', 'Ideia', 'Especificar ideia',
					'Nova issue', 'Criar issue',
				],
				analyzerDescription: 'Erros, segurança, desempenho e acessibilidade em projetos React.',
			},
		] as const satisfies readonly { locale: Locale; empty: readonly string[]; actionable: readonly string[]; analyzerDescription: string }[];

		for (const expected of cases) {
			const empty = workPage({ locale: expected.locale });
			for (const label of expected.empty) expect(empty).toContain(label);
			const knownAnalyzer = workPage({
				locale: expected.locale,
				diagnostics: {
					...emptyDiagnostics(),
					analyzers: [{ id: 'react', label: 'React Doctor', version: '0.9.12', description: 'server baseline' }],
				},
			});
			expect(knownAnalyzer).toContain(expected.analyzerDescription);
			expect(knownAnalyzer).toContain('React Doctor');

			const populated = workPage({
				locale: expected.locale,
				diagnostics,
				drafts: [{
					id: 'GSHIP-AUTHORED',
					title: 'Título autoral sem tradução',
					scope: 'Escopo autoral sem tradução',
					verificationCommand: 'bun test --filter autoral',
					state: 'stale',
				}],
				ideas: [{ id: 'GSHIP-IDEA', title: 'Título autoral sem tradução' }],
				proposals: [{
					id: 'proposal-authored',
					title: 'Título autoral sem tradução',
					evidence: 'Evidência proposta sem tradução.',
					sourceRunId: 'run-factual',
					sourceIssueId: 'GSHIP-AUTHORED',
				}],
				resolvedProposals: [{
					id: 'proposal-resolved',
					title: 'Título autoral sem tradução',
					evidence: 'Evidência proposta sem tradução.',
					sourceRunId: 'run-factual',
					sourceIssueId: 'GSHIP-AUTHORED',
					status: 'promoted',
					promotedIssueId: 'GSHIP-999',
				}],
				resolvedProposalsOmittedCount: 1_234,
				selectedIssueId: 'CAM-900',
			});
			for (const label of expected.actionable) expect(populated).toContain(label);
			for (const value of authored) expect(populated).toContain(value);
		}
	});

	test('empty Work content stays compact and offers no inert run action', () => {
		const html = workPage({ backlog: [] });
		const emptyBacklog = elementWith(html, 'data-state="empty"');
		const compactStates = openingTags(html).filter((tag) => tag.includes('data-density="compact"'));

		expect(emptyBacklog).toContain('data-slot="card-frame"');
		expect(html).toContain('0 admissible issues right now.');
		expect(hasButton(html, 'Start run')).toBe(false);
		expect(compactStates).toHaveLength(3);
		for (const state of compactStates) {
			expect(state).not.toContain('min-h-24');
			expect(state).not.toContain('p-6');
		}
	});

	test('reviews specified drafts in a closed disclosure and requires persisted confirmation', () => {
		const html = workPage({ drafts: [{
			id: 'CAM-42',
			title: 'Draft revisável',
			scope: 'Escopo persistido',
			verificationCommand: 'bun test focused',
			state: 'stale',
		}] });
		const card = panel(html, 'Review and approve');

		expect(card).not.toContain('open=""');
		expect(card).toContain('CAM-42 — Draft revisável');
		expect(card).toContain('Escopo persistido');
		expect(card).toContain('bun test focused');
		expect(card).toContain('type="checkbox"');
		expect(buttonIsEnabled(card, 'Save revision')).toBe(false);
		expect(buttonIsEnabled(card, 'Approve')).toBe(false);
		// Abandoning needs a justification before its own confirmation unlocks.
		expect(card).toContain('Reason for abandonment');
		expect(buttonIsEnabled(card, 'Abandon')).toBe(false);
		expect(card).not.toContain('fingerprint');
		// GSHIP-629: absent from every already-filed issue, so nothing renders.
		expect(card).not.toContain('Evidence captured when specified');
	});

	// GSHIP-629: the spec's executable premise is shown beside the scope and the
	// verification command it sits next to, read-only -- this panel edits the
	// scope and the command, never the recorded evidence.
	test('shows the evidence captured when specified beside the scope and verification command', () => {
		const html = workPage({ drafts: [{
			id: 'CAM-42',
			title: 'Draft revisável',
			scope: 'Escopo persistido',
			verificationCommand: 'bun test focused',
			evidence: [
				{ command: 'wc -l src/domain-models.ts', output: '3 src/domain-models.ts' },
				{ command: 'git log --oneline -1', output: 'abc1234 seed' },
			],
			state: 'stale',
		}] });
		const card = panel(html, 'Review and approve');

		expect(card).toContain('Evidence captured when specified');
		expect(card).toContain('wc -l src/domain-models.ts');
		expect(card).toContain('3 src/domain-models.ts');
		expect(card).toContain('git log --oneline -1');
		expect(card).toContain('abc1234 seed');
		// Read-only: no input carries the evidence text.
		expect(card).not.toContain('name="evidence"');
	});

	// GSHIP-614: while a run owns the issue file, the screen explains that
	// instead of offering a control whose write would break the ship.
	test('a draft executed by a run offers no revision, approval or abandon', () => {
		const draft = {
			id: 'CAM-900',
			title: 'Draft em execução',
			scope: 'Escopo persistido',
			verificationCommand: 'bun test focused',
			state: 'approved' as const,
		};
		const owned = panel(workPage({ drafts: [draft], runs: [runIn('working')] }), 'Review and approve');

		expect(owned).toContain('CAM-900 — Draft em execução');
		expect(owned).toContain('CAM-900 is being executed by a run.');
		expect(hasButton(owned, 'Save revision')).toBe(false);
		expect(hasButton(owned, 'Approve')).toBe(false);
		expect(hasButton(owned, 'Abandon')).toBe(false);
		expect(owned).not.toContain('type="checkbox"');

		// Another draft is untouched by that run, and a settled run returns the
		// controls to the issue it was executing.
		const other = panel(
			workPage({ drafts: [{ ...draft, id: 'CAM-901' }], runs: [runIn('working')] }),
			'Review and approve',
		);
		expect(hasButton(other, 'Approve')).toBe(true);
		expect(hasButton(other, 'Abandon')).toBe(true);
		const settled = panel(workPage({ drafts: [draft], runs: [runIn('done')] }), 'Review and approve');
		expect(hasButton(settled, 'Approve')).toBe(true);
		expect(hasButton(settled, 'Abandon')).toBe(true);
		expect(settled).not.toContain('is being executed by a run');
	});

	test('offers the plannable backlog and holds start until an issue is chosen', () => {
		const html = workPage();

		expect(html).toContain('CAM-900');
		expect(html).toContain('primeira issue plannable');
		expect(buttonIsEnabled(html, 'Start run')).toBe(false);

		const selected = workPage({ selectedIssueId: 'CAM-901' });
		expect(buttonIsEnabled(selected, 'Start run')).toBe(true);
		expect(selected).toContain('aria-pressed="true"');

		// A live run blocks a second start even with an issue selected.
		const live = workPage({ runs: [runIn('waiting-user')], selectedIssueId: 'CAM-900' });
		expect(buttonIsEnabled(live, 'Start run')).toBe(false);
		// A settled one reopens it.
		const settled = workPage({ runs: [runIn('done')], selectedIssueId: 'CAM-900' });
		expect(buttonIsEnabled(settled, 'Start run')).toBe(true);
	});

	test('exposes the minimal operator contract for a new task', () => {
		const html = workPage();

		expect(html).toContain('New issue');
		expect(html).toContain('name="title"');
		expect(html).toContain('name="scope"');
		expect(html).toContain('name="verificationCommand"');
		expect(buttonIsEnabled(html, 'Create issue')).toBe(true);
		expect(buttonIsEnabled(workPage({ pending: true }), 'Create issue')).toBe(false);
	});

	test('keeps diagnostics advisory, compact and human-settled on the work surface', () => {
		const timestamp = '2026-08-20T12:00:00.000Z';
		const finding = {
			id: 'diagnostic-1',
			analyzer: 'react',
			rule: 'no-transition-all',
			severity: 'warning' as const,
			file: 'webui/src/App.tsx',
			evidence: 'Avoid animating every CSS property.',
			line: 42,
			toolVersion: '0.9.12',
			sourceSha: 'a'.repeat(40),
			status: 'pending' as const,
			promotedIssueId: null,
			occurrenceCount: 2,
			firstSeenAt: timestamp,
			lastSeenAt: timestamp,
			updatedAt: timestamp,
		};
		const diagnostics: AppProps['diagnostics'] = {
			analyzers: [{
				id: 'react',
				label: 'React',
				version: '0.9.12',
				description: 'Erros e problemas em projetos React.',
			}],
			scan: {
				id: 'scan-1',
				analyzer: 'react',
				analyzerVersion: '0.9.12',
				sourceSha: 'a'.repeat(40),
				state: 'completed',
				coverageComplete: true,
				findingCount: 1,
				error: null,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
			findings: [finding],
			resolvedFindings: [{
				...finding,
				id: 'diagnostic-2',
				rule: 'old-rule',
				status: 'promoted',
				promotedIssueId: 'GSHIP-900',
			}],
			resolvedFindingsOmittedCount: 3,
			stats: {
				total: 5,
				pending: 1,
				dismissed: 1,
				promoted: 1,
				cleared: 2,
				recurring: 1,
			},
			schedule: {
				enabled: false,
				analyzer: 'react',
				cadence: 'weekly',
				lastScanAt: timestamp,
				nextRunAt: null,
				overdue: false,
			},
			workspaceNotices: [],
		};
		const html = workPage({ diagnostics });

		expect(panelIsOpen(html, 'Gateship Diagnostics')).toBe(false);
		expect(html).toContain('Advisory: never fixes, approves or blocks shipping.');
		expect(html).toContain('no-transition-all');
		expect(html).toContain('webui/src/App.tsx:42');
		expect(html).toContain('Avoid animating every CSS property.');
		expect(buttonIsEnabled(html, 'Run now')).toBe(true);
		expect(buttonIsEnabled(html, 'Dismiss')).toBe(true);
		expect(buttonIsEnabled(html, 'Promote')).toBe(true);
		expect(html).toContain('Resolved (1)');
		expect(html).toContain('GSHIP-900');
		expect(html).toContain('+3 not shown.');
		expect(html).toContain('Local history: 1 promoted, 1 dismissed');
		expect(html).toContain('Dismissal does not mean false positive');
		expect(html).not.toContain('Pontuação');

		const active = workPage({
			diagnostics: {
				...diagnostics,
				scan: { ...diagnostics.scan!, state: 'running' },
			},
		});
		expect(hasButton(active, 'Run now')).toBe(false);
		expect(buttonIsEnabled(active, 'Cancel diagnostic')).toBe(true);
	});

	// GSHIP-613: the third card of /work, disclosed like the drafts one.
	test('pending proposals are read as evidence and decided, never edited', () => {
		const html = workPage({ proposals: [{
			id: 'run-1-proposal-1',
			title: 'Cobrir o retry do shipper',
			evidence: 'Sem teste no caminho de erro.',
			sourceRunId: 'run-1',
			sourceIssueId: 'CAM-50',
		}] });
		const card = panel(html, 'Derived proposals');

		expect(card).not.toContain('open=""');
		expect(card).toContain('1 pending proposal.');
		expect(card).toContain('Cobrir o retry do shipper');
		// The evidence and its provenance are printed, and no field can change them.
		expect(card).toContain('Sem teste no caminho de erro.');
		expect(card).toContain('CAM-50');
		expect(card).toContain('run-1');
		expect(card).not.toContain('name="evidence"');
		// Promotion is the operator's own contract, pre-filled with the title only.
		expect(card).toContain('value="Cobrir o retry do shipper"');
		expect(card).toContain('name="proposalScope"');
		expect(card).toContain('name="proposalVerificationCommand"');
		expect(buttonIsEnabled(card, 'Dismiss')).toBe(true);
		expect(buttonIsEnabled(card, 'Promote')).toBe(true);
		// Promoting files a draft: this card never approves and never starts a run.
		expect(hasButton(card, 'Approve')).toBe(false);
		expect(hasButton(card, 'Start run')).toBe(false);
	});

	test('an empty inbox still renders the card, and a command in flight holds both decisions', () => {
		const empty = panel(workPage(), 'Derived proposals');
		expect(empty).toContain('0 pending proposals.');
		expect(empty).toContain('No pending proposals.');

		const held = panel(
			workPage({
				pending: true,
				proposals: [{
					id: 'run-1-proposal-1',
					title: 'Proposta pendente',
					evidence: 'Evidência capturada.',
					sourceRunId: 'run-1',
					sourceIssueId: 'CAM-50',
				}],
			}),
			'Derived proposals',
		);
		expect(buttonIsEnabled(held, 'Dismiss')).toBe(false);
		expect(buttonIsEnabled(held, 'Promote')).toBe(false);
	});

	// GSHIP-643: a settled proposal is visible, read-only, and distinguishes a
	// promoted one -- which shows the issue it became -- from a dismissed one.
	test('a promoted proposal is shown resolved, carrying the issue it became', () => {
		const html = workPage({
			resolvedProposals: [{
				id: 'run-1-proposal-2',
				title: 'Extrair o parser de eventos',
				evidence: 'Duplicado em dois adaptadores.',
				sourceRunId: 'run-1',
				sourceIssueId: 'CAM-50',
				status: 'promoted',
				promotedIssueId: 'CAM-951',
			}],
		});
		const card = panel(html, 'Resolved proposals');

		expect(card).toContain('1 resolved proposal.');
		expect(card).toContain('Extrair o parser de eventos');
		expect(card).toContain('Promoted');
		expect(card).toContain('CAM-951');
		expect(card).not.toContain('Dismissed');
		// It is read-only: no decision is offered here, ever.
		expect(hasButton(card, 'Dismiss')).toBe(false);
		expect(hasButton(card, 'Promote')).toBe(false);
	});

	test('a dismissed proposal is shown resolved, carrying no issue', () => {
		const card = panel(workPage({
			resolvedProposals: [{
				id: 'run-1-proposal-3',
				title: 'Ideia descartada',
				evidence: 'Já coberto em outro lugar.',
				sourceRunId: 'run-1',
				sourceIssueId: 'CAM-50',
				status: 'dismissed',
				promotedIssueId: null,
			}],
		}), 'Resolved proposals');

		expect(card).toContain('Ideia descartada');
		expect(card).toContain('Dismissed');
		expect(card).not.toContain('Promoted');
	});

	test('an empty or truncated resolved history renders as such, never in silence', () => {
		const empty = panel(workPage(), 'Resolved proposals');
		expect(empty).toContain('0 resolved proposals.');
		expect(empty).toContain('No resolved proposals yet.');
		expect(empty).not.toContain('not shown');

		const truncated = panel(
			workPage({
				resolvedProposals: [{
					id: 'run-1-proposal-4',
					title: 'Mais uma ideia',
					evidence: 'Evidência.',
					sourceRunId: 'run-1',
					sourceIssueId: 'CAM-50',
					status: 'dismissed',
					promotedIssueId: null,
				}],
				resolvedProposalsOmittedCount: 5,
			}),
			'Resolved proposals',
		);
		expect(truncated).toContain('+5 resolved proposals not shown.');
	});

	test('a resolved proposal never appears in, or shrinks, the pending inbox', () => {
		const html = workPage({
			proposals: [{
				id: 'run-1-proposal-1',
				title: 'Proposta pendente',
				evidence: 'Evidência capturada.',
				sourceRunId: 'run-1',
				sourceIssueId: 'CAM-50',
			}],
			resolvedProposals: [{
				id: 'run-1-proposal-2',
				title: 'Proposta promovida',
				evidence: 'Evidência resolvida.',
				sourceRunId: 'run-1',
				sourceIssueId: 'CAM-50',
				status: 'promoted',
				promotedIssueId: 'CAM-951',
			}],
		});
		const pendingCard = panel(html, 'Derived proposals');
		expect(pendingCard).toContain('1 pending proposal.');
		expect(pendingCard).toContain('Proposta pendente');
		expect(pendingCard).not.toContain('Proposta promovida');

		const resolvedCard = panel(html, 'Resolved proposals');
		expect(resolvedCard).toContain('Proposta promovida');
		expect(resolvedCard).not.toContain('Proposta pendente');
	});

	test('ideas are specified directly, without a planner, and only when there are any', () => {
		const html = workPage({ ideas: [{ id: 'CAM-42', title: 'ideia antiga' }] });

		expect(html).toContain('Specify existing idea');
		expect(html).toContain('CAM-42 — ideia antiga');
		expect(html).toContain('name="ideaScope"');
		expect(html).toContain('name="ideaVerificationCommand"');
		expect(buttonIsEnabled(html, 'Specify idea')).toBe(true);
		expect(workPage()).not.toContain('Specify existing idea');
	});
});

describe('settings surface', () => {
	test('the typed settings catalog renders representative actionable and empty states in both locales', () => {
		const diagnostics = emptyDiagnostics();
		diagnostics.schedule = {
			enabled: false,
			analyzer: 'react',
			cadence: 'daily',
			lastScanAt: null,
			nextRunAt: null,
			overdue: false,
		};
		const overrides: Partial<AppProps> = {
			brief: { objective: 'Objetivo escrito pelo operador.', decisions: ['Keep authored text.'], constraints: [], openItems: [] },
			diagnostics,
			modelSettings: {
				...EMPTY_MODEL_SETTINGS,
				codex: { ...EMPTY_MODEL_SETTINGS.codex, executor: { model: 'gpt-factual', effort: 'xhigh' } },
			},
			operatorProfile: { name: 'Eduardo', timezone: 'America/Sao_Paulo' },
			providers: [{
				id: 'codex',
				installed: true,
				subscription: true,
				label: 'Codex factual',
				login: 'web',
				plan: 'team-plan',
				usage: { windows: [{ window: 'seven_day', usedPercent: 78.4, observedAt: '2026-08-20T09:05:00.000Z' }], resetCreditCount: 2_000 },
			}],
			notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, ntfy: { ...EMPTY_NOTIFICATION_CHANNELS.ntfy, configured: true } },
			handoff: EMPTY_BRIEF,
		};
		const english = settingsPage({ ...overrides, locale: 'en-US' });
		const portuguese = settingsPage({ ...overrides, locale: 'pt-BR' });
		const globalEnglish = globalSettingsPage({ ...overrides, locale: 'en-US' });
		const globalPortuguese = globalSettingsPage({ ...overrides, locale: 'pt-BR' });

		for (const [html, labels] of [
			[english, ['Settings', 'Project', 'Local agents', 'Model and effort by role', 'Automatic run chaining', 'Executor handoff between providers', 'Diagnostic schedule', 'Project brief', 'Automatic handoff', 'open', 'close']],
			[portuguese, ['Ajustes', 'Projeto', 'Agentes locais', 'Modelo e esforço por função', 'Encadeamento automático de execuções', 'Transferência de executor entre provedores', 'Agenda de diagnósticos', 'Brief do projeto', 'Handoff automático', 'abrir', 'fechar']],
		] as const) {
			expectContainsAll(html, labels);
			expectContainsAll(html, ['acme/gateship', 'origin/main', 'Codex factual', 'team-plan', 'gpt-factual', 'xhigh', 'Objetivo escrito pelo operador.', 'Keep authored text.']);
		}
		for (const [html, labels] of [
			[globalEnglish, ['Settings', 'Agent defaults', 'Operator', 'Gateship updates', 'Notifications', 'Save profile']],
			[globalPortuguese, ['Ajustes', 'Padrões dos agentes', 'Operador', 'Atualizações do Gateship', 'Notificações', 'Salvar perfil']],
		] as const) {
			expectContainsAll(html, labels);
			expectContainsAll(html, ['Eduardo', 'America/Sao_Paulo']);
			expectNotContainsAll(html, ['Project runtime', 'Local agents', 'Automatic run chaining', 'Automatic handoff', 'Project brief']);
		}
		for (const html of [english, portuguese]) {
			expectNotContainsAll(html, ['Operator profile', 'Notifications', 'Gateship updates']);
		}
		expect(english).toContain('78% used');
		expect(portuguese).toContain('78% usados');
		expect(english).toContain('2,000 reset credit(s) available');
		expect(portuguese).toContain('2.000 créditos de reinício disponíveis');
		const observed = new Date('2026-08-20T09:05:00.000Z');
		expect(english).toContain(observed.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }));
		expect(portuguese).toContain(observed.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }));
		expect(globalEnglish).toContain('ntfy: configured');
		expect(globalPortuguese).toContain('ntfy: configurado');
		expect(buttonIsEnabled(globalEnglish, 'Send test')).toBe(true);
		expect(buttonIsEnabled(globalPortuguese, 'Enviar teste')).toBe(true);
		expect(portuguese).not.toContain('Settings');
	});

	test('edits the operator identity and suggests browser timezone without silently saving it', () => {
		const empty = panel(globalSettingsPage(), 'Operator');
		expect(empty).toContain('name="operator-name"');
		expect(empty).toContain('name="operator-timezone"');
		expect(empty).toContain('value="America/Sao_Paulo"');
		expect(empty).toContain('is saved only when you confirm');
		expect(buttonIsEnabled(empty, 'Save profile')).toBe(true);

		const stored = panel(globalSettingsPage({
			operatorProfile: { name: 'Eduardo', timezone: 'Europe/Lisbon' },
		}), 'Operator');
		expect(stored).toContain('value="Eduardo"');
		expect(stored).toContain('value="Europe/Lisbon"');
		expect(stored).not.toContain('value="America/Sao_Paulo"');
		expect(buttonIsEnabled(globalSettingsPage({ pending: true }), 'Save profile')).toBe(false);
	});

	test('shows subscription state without any credential field', () => {
		const html = settingsPage({
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', plan: 'max', login: 'external' },
				{ id: 'codex', installed: true, subscription: false, label: 'Codex', login: 'web' },
			],
		});
		const providers = panel(html, 'Local agents');

		expect(providers).toContain('Claude Code');
		expect(providers).toContain('Subscription connected · max');
		expect(providers).toContain('in use');
		expect(buttonIsEnabled(providers, 'Connect ChatGPT')).toBe(true);
		expect(providers).toContain('Platform billing');
		expect(providers).not.toContain('name="api-key"');
	});

	// GSHIP-704: the universal onboarding for a dedicated Claude subscription,
	// isolated from Claude Desktop's or the terminal's own OAuth/Keychain
	// login, offered from Ajustes > Providers.
	test('offers to connect a dedicated Claude credential when none is configured, with external login kept as an advanced fallback', () => {
		const html = settingsPage({
			providers: [
				{ id: 'claude', installed: true, subscription: false, label: 'Claude Code', login: 'external' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		});
		const providers = panel(html, 'Local agents');

		expect(providers).toContain('external login');
		expect(providers).toContain('claude setup-token');
		expect(providers).toContain('name="claude-credential-token"');
		expect(providers).toContain('type="password"');
		expect(providers).toContain('name="claude-credential-confirm"');
		expect(providers).toContain('type="checkbox"');
		// Write-only, exactly like the Resend key field: never a prefilled value.
		expect(providers).toContain('value=""');
		// Never persisted before the operator confirms, so the button starts disabled.
		expect(buttonIsEnabled(providers, 'Connect')).toBe(false);
		// The dedicated token remains available only as the advanced alternative.
		expect(providers).toContain('Advanced: use a dedicated setup token instead');
		expect(providers).toContain('claude auth login --claudeai');
		expect(providers).toContain('inside that container');
	});

	test('does not offer the setup-token command or field when the Claude CLI is not installed', () => {
		const providers = panel(settingsPage({
			providers: [
				{ id: 'claude', installed: false, subscription: false, label: 'Claude Code', login: 'external' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('Claude CLI not found');
		expect(providers).not.toContain('claude setup-token');
		expect(providers).not.toContain('name="claude-credential-token"');
		// Nothing installed to fall back to locally either.
		expect(providers).not.toContain('claude auth login');
	});

	test('shows the dedicated credential as connected, offering rotate and disconnect instead of the bare form', () => {
		const providers = panel(settingsPage({
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', plan: 'max', login: 'dedicated' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('dedicated credential');
		expect(providers).toContain('Dedicated subscription connected.');
		expect(providers).toContain('Usage windows appear here only when the Claude CLI reports them during calls.');
		expect(buttonIsEnabled(providers, 'Rotate')).toBe(true);
		expect(buttonIsEnabled(providers, 'Disconnect')).toBe(true);
		// Rotating is a click away; the token form is not open by default.
		expect(providers).not.toContain('name="claude-credential-token"');
		// A connected dedicated credential is not what the advanced fallback is for.
		expect(providers).not.toContain('Advanced: sign in locally instead');
	});

	// GSHIP-704: `installed: false` with `login: 'dedicated'` is a real status
	// (claudeStatus reports it on an ENOENT read while a credential is
	// configured), and Rotate used to open a token form gated on
	// `provider.installed`, stranding the operator with no form, no Cancel and
	// no visible Disconnect until a page reload. Disconnect must always stay
	// reachable from the connected card.
	test('never strands a connected operator behind Rotate when the Claude CLI is absent', () => {
		const providers = panel(settingsPage({
			providers: [
				{ id: 'claude', installed: false, subscription: false, label: 'Claude Code', login: 'dedicated' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('Dedicated credential needs reconnecting.');
		expect(hasButton(providers, 'Rotate')).toBe(false);
		expect(buttonIsEnabled(providers, 'Disconnect')).toBe(true);
	});

	// GSHIP-705: one missing `claude` binary produces both halves of this state
	// at once -- the ENOENT fails the validation closed, and the status read
	// right after it reports installed:false while the configured credential
	// keeps login:'dedicated'. The refusal is now App-level state, so unlike
	// the old component-local rotating flag it survives leaving Ajustes and
	// coming back: if it hid Disconnect, nothing short of a reload would free
	// the operator.
	test('keeps Disconnect and the refusal visible when a refusal arrives with the Claude CLI absent', () => {
		const providers = panel(settingsPage({
			claudeCredentialError: 'spawn claude ENOENT',
			providers: [
				{ id: 'claude', installed: false, subscription: false, label: 'Claude Code', login: 'dedicated' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(buttonIsEnabled(providers, 'Disconnect')).toBe(true);
		expect(hasButton(providers, 'Rotate')).toBe(false);
		expect(providers).toContain('spawn claude ENOENT');
		expect(providers).toContain('role="alert"');
	});

	test('fails closed: a dedicated credential that no longer authenticates asks to reconnect, never falling back to external login silently', () => {
		const providers = panel(settingsPage({
			providers: [
				{ id: 'claude', installed: true, subscription: false, label: 'Claude Code', login: 'dedicated' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('Dedicated credential needs reconnecting.');
		expect(providers).not.toContain('Dedicated subscription connected.');
		expect(buttonIsEnabled(providers, 'Rotate')).toBe(true);
	});

	// GSHIP-705: `claude setup-token` prints the token once. Clearing the field
	// on a refusal would cost the operator the credential itself, so the form
	// keeps what was typed and carries the service's own refusal beside it.
	test('keeps the token form open and shows a refusal beside the field it belongs to', () => {
		const providers = panel(settingsPage({
			claudeCredentialError: 'Claude refused this token for inference.',
			providers: [
				{ id: 'claude', installed: true, subscription: false, label: 'Claude Code', login: 'external' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('name="claude-credential-token"');
		expect(providers).toContain('Claude refused this token for inference.');
		expect(providers).toContain('role="alert"');
	});

	// A refused rotation must not collapse back to the connected card: that
	// would hide both the refusal and the token the operator still has to fix.
	test('a refused rotation stays on the form instead of reporting the old credential as connected', () => {
		const providers = panel(settingsPage({
			claudeCredentialError: 'OAuth token revoked.',
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', login: 'dedicated' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('name="claude-credential-token"');
		expect(providers).toContain('OAuth token revoked.');
		expect(hasButton(providers, 'Rotate')).toBe(true);
	});

	// GSHIP-705: the token is limited to inference, so the screen may not
	// promise an email, organization or plan as the sign that it worked.
	test('says what the check proves, without promising identity a setup token cannot expose', () => {
		const providers = panel(settingsPage({
			providers: [
				{ id: 'claude', installed: true, subscription: false, label: 'Claude Code', login: 'external' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('one minimal Claude call, without tools');
		expect(providers).toContain('limited to inference');
	});

	// GSHIP-704: CLAUDE_CODE_OAUTH_TOKEN always wins over the file, so a
	// Settings write here would create or remove a file with no effect on
	// what actually authenticates. Ajustes must treat this as read-only --
	// no Connect, Rotate or Disconnect -- and explain that changing it
	// requires editing the service's own configuration and restarting.
	test('treats an environment-managed credential as read-only: no connect, rotate or disconnect', () => {
		const providers = panel(settingsPage({
			providers: [
				{
					id: 'claude', installed: true, subscription: true, label: 'Claude Code', login: 'dedicated',
					credential: { envManaged: true },
				},
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('Dedicated subscription connected.');
		expect(providers).toContain('CLAUDE_CODE_OAUTH_TOKEN');
		expect(providers).toContain('restart Gateship');
		expect(hasButton(providers, 'Connect')).toBe(false);
		expect(hasButton(providers, 'Rotate')).toBe(false);
		expect(hasButton(providers, 'Disconnect')).toBe(false);
		expect(providers).not.toContain('name="claude-credential-token"');
	});

	test('an environment-managed credential that no longer authenticates still offers no action, only the guidance to restart', () => {
		const providers = panel(settingsPage({
			providers: [
				{
					id: 'claude', installed: true, subscription: false, label: 'Claude Code', login: 'dedicated',
					credential: { envManaged: true },
				},
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(providers).toContain('Dedicated credential needs reconnecting.');
		expect(providers).toContain('CLAUDE_CODE_OAUTH_TOKEN');
		expect(hasButton(providers, 'Rotate')).toBe(false);
		expect(hasButton(providers, 'Disconnect')).toBe(false);
	});

	test('disables connect and disconnect while a command is in flight', () => {
		const providers = panel(settingsPage({
			pending: true,
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', login: 'dedicated' },
				{ id: 'codex', installed: false, subscription: false, label: 'Codex', login: 'web' },
			],
		}), 'Local agents');

		expect(buttonIsEnabled(providers, 'Disconnect')).toBe(false);
	});

	test('distinguishes a connected subscription from an observed provider hold', () => {
		const html = settingsPage({
			providers: [
				{
					id: 'claude',
					installed: true,
					subscription: true,
					label: 'Claude Code',
					plan: 'max',
					login: 'external',
					availability: {
						provider: 'claude',
						kind: 'usage-limit',
						message: 'Claude usage limit reached.',
						phase: 'working',
						retryAt: '2026-08-20T12:10:00.000Z',
					},
				},
				{
					id: 'codex',
					installed: true,
					subscription: false,
					label: 'Codex',
					login: 'web',
					availability: {
						provider: 'codex',
						kind: 'auth-required',
						message: 'Sign in required.',
						phase: 'working',
					},
				},
			],
		});

		expect(html).toContain('Subscription connected, but currently unavailable');
		expect(html).toContain('Subscription usage limit reached');
		expect(html).toContain('Currently unavailable: Authentication required');
	});

	// GSHIP-664: compact progressive detail -- each piece renders only when the
	// source actually reported it, never a fabricated zero standing in for it.
	test('renders reported usage as compact progressive detail, and nothing when unavailable', () => {
		const html = settingsPage({
			providers: [
				{
					id: 'claude',
					installed: true,
					subscription: true,
					label: 'Claude Code',
					plan: 'max',
					login: 'external',
					usage: {
						windows: [
							{
								window: 'seven_day',
								status: 'allowed_warning',
								usedPercent: 78.4,
								observedAt: '2026-08-20T09:05:00.000Z',
								resetsAt: '2026-08-27T09:05:00.000Z',
							},
							{
								// No percentage or reset time reported for this window yet.
								window: 'five_hour',
								status: 'allowed',
								observedAt: '2026-08-20T09:05:00.000Z',
							},
						],
					},
				},
				{
					id: 'codex',
					installed: true,
					subscription: false,
					label: 'Codex',
					login: 'web',
				},
			],
		});
		const providers = panel(html, 'Local agents');

		expect(providers).toContain('7 day');
		expect(providers).toContain('78% used');
		expect(providers).toContain('dateTime="2026-08-27T09:05:00.000Z"');
		expect(providers).toContain('dateTime="2026-08-20T09:05:00.000Z"');
		expect(providers).toContain('5 hour');
		// Codex reported nothing: no usage section for its row at all.
		expect(providers).not.toContain('reset credit');
		expect(providers).not.toContain('Spend limit');
		expect(providers).not.toContain('Credits:');
	});

	test('renders credit summary, spend-limit summary and reset-credit count for Codex', () => {
		const html = settingsPage({
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', login: 'external' },
				{
					id: 'codex',
					installed: true,
					subscription: true,
					label: 'Codex',
					login: 'web',
					usage: {
						windows: [{
							window: 'primary',
							usedPercent: 21,
							windowMinutes: 10_080,
							observedAt: '2026-08-21T09:00:00.000Z',
							resetsAt: '2026-08-27T14:38:18.000Z',
						}],
						credits: { hasCredits: true, unlimited: false, balance: '$5.00' },
						spendLimit: { limit: '$100.00', used: '$42.00', remainingPercent: 58, resetsAt: '2026-08-27T14:38:18.000Z' },
						resetCreditCount: 2,
					},
				},
			],
		});
		const providers = panel(html, 'Local agents');

		expect(providers).toContain('7 day');
		expect(providers).toContain('21% used');
		expect(providers).toContain('Credits: $5.00');
		expect(providers).toContain('Spend limit: $42.00 of $100.00');
		expect(providers).toContain('58% remaining');
		expect(providers).toContain('2 reset credit(s) available');
	});

	test('preserves decimal spend-limit facts while formatting them for each locale', () => {
		const provider: ProviderStatusView = {
			id: 'codex',
			installed: true,
			subscription: true,
			label: 'Codex',
			login: 'web',
			usage: {
				windows: [],
				spendLimit: { limit: '$100.00', used: '$87.50', remainingPercent: 12.5 },
			},
		};
		expect(settingsPage({ locale: 'en-US', providers: [provider] }))
			.toContain('Spend limit: $87.50 of $100.00 (12.5% remaining)');
		expect(settingsPage({ locale: 'pt-BR', providers: [provider] }))
			.toContain('Limite de gastos: $87.50 de $100.00 (12,5% restantes)');
	});

	test('local notifications show the browser permission state without a secret field', () => {
		expect(buttonIsEnabled(globalSettingsPage(), 'Enable notifications')).toBe(true);

		const granted = globalSettingsPage({ notificationPermission: 'granted' });
		expect(granted).toContain('Active in this browser.');
		expect(buttonIsEnabled(granted, 'Notifications active')).toBe(false);
		const localNotificationRow = granted.slice(
			granted.indexOf('Active in this browser.'),
			granted.indexOf('ntfy:'),
		);
		expect(localNotificationRow).not.toContain('type="password"');
		expect(globalSettingsPage({ notificationPermission: 'denied' })).toContain('Notifications blocked');
	});

	// GSHIP-652: the remote ntfy channel shows only whether it is configured,
	// a real test-send action, and setup instructions -- never the secret,
	// which the read-only `configured` boolean makes structurally impossible.
	test('the ntfy channel shows its configured state, a test action, and setup instructions, never a secret', () => {
		const unconfigured = panel(globalSettingsPage(), 'Notifications');
		expect(unconfigured).toContain('ntfy: not configured');
		expect(buttonIsEnabled(unconfigured, 'Send test')).toBe(false);
		expect(unconfigured).toContain('GATESHIP_HOME/.gship/ntfy-url');
		expect(unconfigured).not.toContain('at the project root');
		expect(unconfigured).toContain('mode 600');
		expect(unconfigured).toContain('GATESHIP_NTFY_URL');
		const portuguese = panel(globalSettingsPage({ locale: 'pt-BR' }), 'Notificações');
		expect(portuguese).toContain('GATESHIP_HOME/.gship/ntfy-url');
		expect(portuguese).not.toContain('na raiz do projeto');
		const docLink = openingTags(unconfigured).find((tag) => tag.includes('docs.ntfy.sh'));
		expect(docLink).toBeDefined();
		expect(docLink).toContain('<a');
		expect(docLink).toContain('target="_blank"');
		expect(docLink).toContain('rel="noreferrer noopener"');

		const configured = panel(
			globalSettingsPage({
				notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, ntfy: { ...EMPTY_NOTIFICATION_CHANNELS.ntfy, configured: true } },
			}),
			'Notifications',
		);
		expect(configured).toContain('ntfy: configured');
		expect(buttonIsEnabled(configured, 'Send test')).toBe(true);
	});

	// GSHIP-653: Resend needs three values, not one -- a partial configuration
	// is off, and the panel names exactly which values are still missing, by
	// name, never a value itself. Both the API-key and domain-verification
	// pages are linked, since DNS verification happens outside Gateship, which
	// is the part an operator following this panel actually gets stuck on.
	test('the Resend channel names which values are missing, shows setup instructions and both doc links, never a secret', () => {
		const partial = panel(
			globalSettingsPage({
				notificationChannels: {
					...EMPTY_NOTIFICATION_CHANNELS,
					resend: { ...EMPTY_NOTIFICATION_CHANNELS.resend, missing: ['API key', 'recipient'] },
				},
			}),
			'Notifications',
		);
		expect(partial).toContain('email (Resend): not configured (missing: API key, recipient)');
		expect(buttonIsEnabled(channelRow(partial, 'email (Resend)'), 'Send test')).toBe(false);
		expect(partial).toContain('GATESHIP_HOME/.gship/resend-api-key');
		expect(partial).not.toContain('to .gship/resend-api-key');
		expect(partial).toContain('mode 600');
		expect(partial).toContain('GATESHIP_RESEND_API_KEY');
		expect(partial).toContain('GATESHIP_RESEND_FROM');
		expect(partial).toContain('GATESHIP_RESEND_TO');
		expect(partial).toContain('Sender');
		expect(partial).toContain('Recipient');
		expect(partial).toContain('Replacement API key (optional)');
		expect(partial).toContain('Save Resend settings');
		expect(partial).toContain('Remove credential');
		const keyInput = openingTags(partial).find((tag) => tag.includes('name="resend-api-key"'));
		expect(keyInput).toContain('type="password"');
		expect(keyInput).not.toContain('value=');

		const apiKeysLink = openingTags(partial).find((tag) => tag.includes('resend.com/api-keys'));
		const domainsLink = openingTags(partial).find((tag) => tag.includes('resend.com/domains'));
		expect(apiKeysLink).toBeDefined();
		expect(domainsLink).toBeDefined();
		expect(apiKeysLink).toContain('target="_blank"');
		expect(domainsLink).toContain('rel="noreferrer noopener"');

		const configured = panel(
			globalSettingsPage({
				notificationChannels: {
					...EMPTY_NOTIFICATION_CHANNELS,
					resend: {
						...EMPTY_NOTIFICATION_CHANNELS.resend,
						configured: true,
						from: 'Gateship <ops@example.com>',
						to: 'operator@example.com',
						fileCredentialExists: true,
					},
				},
			}),
			'Notifications',
		);
		expect(configured).toContain('email (Resend): configured');
		expect(configured).not.toContain('falta:');
		expect(buttonIsEnabled(channelRow(configured, 'email (Resend)'), 'Send test')).toBe(true);
		expect(configured).not.toContain('resend-secret');
		expect(buttonIsEnabled(configured, 'Remove credential')).toBe(true);

		const portuguese = panel(globalSettingsPage({ locale: 'pt-BR' }), 'Notificações');
		expect(portuguese).toContain('Remetente');
		expect(portuguese).toContain('Destinatário');
		expect(portuguese).toContain('Chave de API substituta (opcional)');
		expect(portuguese).toContain('Salvar configurações do Resend');
		expect(portuguese).toContain('Remover credencial');
		const portuguesePartial = panel(globalSettingsPage({
			locale: 'pt-BR',
			notificationChannels: {
				...EMPTY_NOTIFICATION_CHANNELS,
				resend: { ...EMPTY_NOTIFICATION_CHANNELS.resend, missing: ['API key', 'recipient'] },
			},
		}), 'Notificações');
		expect(portuguesePartial).toContain('GATESHIP_HOME/.gship/resend-api-key');
		expect(portuguesePartial).not.toContain('em .gship/resend-api-key');
	});

	test('the remote channel test action is held while a command is in flight, like every other', () => {
		const html = panel(
			globalSettingsPage({
				notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, ntfy: { ...EMPTY_NOTIFICATION_CHANNELS.ntfy, configured: true } },
				pending: true,
			}),
			'Notifications',
		);
		expect(buttonIsEnabled(html, 'Send test')).toBe(false);
	});

	test('the brief is edited here and the automatic handoff sits beside it, read-only', () => {
		const html = settingsPage({
			brief: {
				objective: 'Manter a intenção do produto sob controle do operador.',
				decisions: ['O brief é distinto do handoff.', 'Só o operador o escreve.'],
				constraints: ['Nenhuma rota nova.'],
				openItems: ['Editar o brief pela web.'],
			},
			handoff: {
				objective: 'Implementar a fatia 2 do estágio 2.',
				decisions: ['A leitura devolve os dois registros.'],
				constraints: ['A UI apenas lê este registro.'],
				openItems: ['Regenerar o bundle.'],
			},
		});
		const brief = panel(html, 'Project brief');
		const handoff = panel(html, 'Automatic handoff');

		// Two panels, each naming whose context it carries.
		expect(brief).toContain('Authoritative human context');
		expect(brief).toContain('explicitly confirm a conversational update');
		expect(brief).toContain('a successful write clears the automatic handoff');
		expect(handoff).toContain('Session state observed and generated by the orchestrator');
		expect(handoff).toContain('A brief write clears it; a later parsed turn may rebuild it.');
		expect(handoff).toContain('Rewritten after each successfully parsed orchestrator turn.');

		const portuguese = settingsPage({
			locale: 'pt-BR',
			brief: { objective: '', decisions: [], constraints: [], openItems: [] },
			handoff: { objective: '', decisions: [], constraints: [], openItems: [] },
		});
		expect(panel(portuguese, 'Brief do projeto'))
			.toContain('confirme explicitamente uma atualização na conversa');
		expect(panel(portuguese, 'Handoff automático'))
			.toContain('um turno posterior analisado com sucesso pode recriá-lo');

		// The form opens already filled with what the server holds, lists one per line.
		expect(brief).toContain('name="objective"');
		expect(brief).toContain('Manter a intenção do produto sob controle do operador.');
		for (const name of ['decisions', 'constraints', 'openItems']) {
			expect(brief).toContain(`name="${name}"`);
		}
		expect(brief).toContain('O brief é distinto do handoff.\nSó o operador o escreve.');
		expect(brief).toContain('Nenhuma rota nova.');
		expect(brief).toContain('Editar o brief pela web.');
		expect(buttonIsEnabled(html, 'Save brief')).toBe(true);

		// The orchestrator's record is printed whole, with nothing to type into.
		expect(handoff).toContain('Implementar a fatia 2 do estágio 2.');
		expect(handoff).toContain('A leitura devolve os dois registros.');
		expect(handoff).toContain('A UI apenas lê este registro.');
		expect(handoff).toContain('Regenerar o bundle.');
		expect(handoff).toContain('read-only');
		for (const control of ['<form', '<input', '<textarea', '<select', '<button']) {
			expect(handoff).not.toContain(control);
		}
		// The two records stay distinct: neither panel repeats the other's content.
		expect(handoff).not.toContain('Manter a intenção do produto');
		expect(brief).not.toContain('Implementar a fatia 2 do estágio 2.');
	});

	test('the brief save is held while a command is in flight, like every other', () => {
		expect(buttonIsEnabled(settingsPage({ pending: true }), 'Save brief')).toBe(false);
	});

	// GSHIP-617: the three roles are configurable per provider.
	test('offers a model and an effort field for the three roles of each provider', () => {
		const html = settingsPage({
			modelSettings: {
				claude: {
					orchestrator: { model: 'sonnet', effort: '' },
					executor: { model: 'opus', effort: 'xhigh' },
					reviewer: { model: '', effort: 'high' },
				},
				codex: {
					orchestrator: { model: '', effort: '' },
					executor: { model: 'gpt-5-codex', effort: 'high' },
					reviewer: { model: '', effort: '' },
				},
			},
		});
		const models = panel(html, 'Model and effort by role');

		for (const role of ['Orchestrator', 'Executor', 'Reviewer']) {
			expect(models).toContain(`${role} — model`);
			expect(models).toContain(`${role} — effort`);
		}
		for (const provider of ['claude', 'codex']) {
			for (const role of ['orchestrator', 'executor', 'reviewer']) {
				expect(models).toContain(`name="${provider}-${role}-model"`);
				expect(models).toContain(`name="${provider}-${role}-effort"`);
			}
		}

		// The form opens filled with what the server holds; an unset slot shows the
		// CLI default instead of inventing a value.
		expect(models).toContain('value="opus"');
		expect(models).toContain('value="xhigh"');
		expect(models).toContain('value="gpt-5-codex"');
		expect(models).toContain('CLI default');
		expect(models).toContain('An empty field keeps the CLI default.');

		expect(models).not.toContain('<select');
		expect(buttonIsEnabled(html, 'Save models')).toBe(true);
	});

	// GSHIP-619: Gateship cannot track vendor releases, so it stopped shipping a
	// list of its own and points at each vendor's page instead.
	test('every model field is free text, with no embedded suggestion list', () => {
		const models = panel(settingsPage(), 'Model and effort by role');

		// No datalist survives, and nothing points at one.
		expect(models).not.toContain('<datalist');
		expect(models).not.toContain('list="');
		for (const provider of ['claude', 'codex']) {
			for (const role of ['orchestrator', 'executor', 'reviewer']) {
				for (const field of ['model', 'effort']) {
					const input = openingTags(models).find((tag) =>
						tag.includes(`name="${provider}-${role}-${field}"`),
					);
					expect(input).toBeDefined();
					expect(input).toContain('<input');
					expect(input).not.toContain('list=');
					expect(input).not.toContain('pattern=');
				}
			}
		}

		// The screen says who refuses an unknown value, so nobody blames Gateship.
		expect(models).toContain('the CLI itself rejects');
	});

	test('each provider links to its own model documentation, in a new tab', () => {
		const models = panel(settingsPage(), 'Model and effort by role');
		const docs: Readonly<Record<string, string>> = {
			Claude: 'https://platform.claude.com/docs/en/about-claude/models/overview',
			Codex: 'https://learn.chatgpt.com/docs/models',
		};

		for (const [label, href] of Object.entries(docs)) {
			const link = openingTags(models).find((tag) => tag.includes(`href="${href}"`));

			expect(link).toBeDefined();
			expect(link).toContain('<a');
			expect(link).toContain('target="_blank"');
			expect(link).toContain('rel="noreferrer noopener"');
			expect(models).toContain(`${label} models in the official documentation`);
		}
	});

	test('the model save is held while a command is in flight, like every other', () => {
		expect(buttonIsEnabled(settingsPage({ pending: true }), 'Save models')).toBe(false);
	});

	test('edits global agent defaults with the existing six free-text model slots', () => {
		const defaults = panel(globalSettingsPage({
			agentDefaults: {
				provider: 'codex',
				modelSettings: {
					...EMPTY_MODEL_SETTINGS,
					codex: { ...EMPTY_MODEL_SETTINGS.codex, executor: { model: 'gpt-5-codex', effort: 'high' } },
				},
			},
		}), 'Agent defaults');
		expect(defaults).toContain('name="agent-default-provider"');
		expect(defaults).toContain('name="agent-default-provider" value="codex"');
		expect(defaults).toContain('name="codex-executor-model"');
		expect(defaults).toContain('value="gpt-5-codex"');
		expect(buttonIsEnabled(defaults, 'Save agent defaults')).toBe(true);
		expect(buttonIsEnabled(globalSettingsPage({ pending: true }), 'Save agent defaults')).toBe(false);
	});

	test('shows effective inherited settings separately from project overrides and offers matching resets', () => {
		const inherited = settingsPage({ providerSource: 'global', modelSettingsSource: 'global' });
		expect(panel(inherited, 'Local agents')).toContain('Inherited from global defaults.');
		expect(panel(inherited, 'Model and effort by role')).toContain('Inherited from global defaults.');
		expect(inherited).not.toContain('Reset provider to global default');
		expect(inherited).not.toContain('Reset models to global defaults');

		const override = settingsPage({ providerSource: 'project', modelSettingsSource: 'project' });
		expect(panel(override, 'Local agents')).toContain('Customized for this project.');
		expect(buttonIsEnabled(override, 'Reset provider to global default')).toBe(true);
		expect(panel(override, 'Model and effort by role')).toContain('Customized for this project.');
		expect(buttonIsEnabled(override, 'Reset models to global defaults')).toBe(true);
	});

	test('an empty brief and an empty handoff still render both panels', () => {
		const html = settingsPage();

		expect(panel(html, 'Project brief')).toContain('One item per line');
		expect(buttonIsEnabled(html, 'Save brief')).toBe(true);
		expect(panel(html, 'Automatic handoff')).toContain('Nothing recorded yet.');
	});

	// GSHIP-638: off by default, and no pause reason to show while it never ran.
	test('the chain switch is off by default and shows no pause reason', () => {
		const chainRuns = panel(settingsPage(), 'Automatic run chaining');

		expect(chainRuns).not.toContain('checked=""');
		expect(chainRuns).not.toContain('Queue stopped');
	});

	test('the chain switch reflects the stored setting and is held while a command is in flight', () => {
		const on = panel(settingsPage({ chainRuns: { enabled: true, pause: null } }), 'Automatic run chaining');
		expect(on).toContain('checked=""');

		const checkbox = elementWith(settingsPage({ pending: true }), 'type="checkbox"');
		expect(checkbox).toContain('disabled=""');
	});

	// GSHIP-722: off by default, same as chain runs.
	test('the executor handoff switch is off by default', () => {
		const executorHandoff = panel(settingsPage(), 'Executor handoff between providers');
		expect(executorHandoff).not.toContain('checked=""');
	});

	test('the executor handoff switch reflects the stored setting', () => {
		const on = panel(
			settingsPage({ executorHandoff: { enabled: true } }),
			'Executor handoff between providers',
		);
		expect(on).toContain('checked=""');
	});

	test('native self update is off by default with one fixed daily policy', () => {
		const updates = panel(globalSettingsPage({
			selfUpdate: {
				...emptySelfUpdate(),
				availability: { kind: 'native' },
				currentVersion: '1.0.0',
			},
		}), 'Gateship updates');
		expect(updates).not.toContain('checked=""');
		expect(updates).toContain('Fixed cadence: daily');
		expect(updates).not.toMatch(/weekly|cron/i);
	});

	test('container apply is disabled and a rollback remains explicit', () => {
		const updates = panel(globalSettingsPage({
			selfUpdate: {
				...emptySelfUpdate(),
				enabled: true,
				availability: { kind: 'container', reason: 'A host must replace this container.' },
				result: {
					status: 'rollback',
					at: '2026-08-21T12:00:00.000Z',
					previousVersion: '1.0.0',
					targetVersion: '2.0.0',
					reason: 'Candidate failed. The previous version was restored and verified.',
				},
			},
		}), 'Gateship updates');
		expect(elementWith(updates, 'type="checkbox"')).toContain('disabled=""');
		expect(updates).toContain('A host must replace this container.');
		expect(updates).toContain('rollback');
		expect(updates).toContain('1.0.0 → 2.0.0');
	});

	test('the diagnostic schedule is not shown on the global settings route', () => {
		expect(globalSettingsPage()).not.toContain('Diagnostic schedule');
	});

	test('the diagnostic schedule is not shown on the global settings route', () => {
		expect(globalSettingsPage({ diagnostics: emptyDiagnostics() })).not.toContain('Diagnostic schedule');
	});

	// GSHIP-650: a stopped queue asks for attention in the shell header now,
	// never buried as a secondary line next to the toggle that turned it on.
	test('a stopped queue is never reported inside the chaining switch\'s own panel', () => {
		const pause = { reason: 'no-admissible-issue' as ChainPauseReason, createdAt: '2026-08-18T00:00:00.000Z' };
		const chainRuns = panel(
			settingsPage({ chainRuns: { enabled: false, pause } }),
			'Automatic run chaining',
		);
		expect(chainRuns).not.toContain('Queue stopped');
	});
});

function assertOverviewLoadingAndError(locale: 'en-US' | 'pt-BR'): void {
	const loading = renderAt('/overview', { locale, projects: [CURRENT_PROJECT], overview: null, overviewLoading: true });
	const error = renderAt('/overview', { locale, projects: [CURRENT_PROJECT], overview: null, overviewError: 'network failure' });
	expect(loading).toContain(locale === 'en-US' ? 'Loading operational overview' : 'Carregando visão operacional');
	expect(loading).not.toContain(locale === 'en-US' ? 'No active run' : 'Nenhuma run ativa');
	expect(error).toContain(locale === 'en-US' ? 'The operational overview could not be loaded' : 'Não foi possível carregar a visão operacional');
	expect(error).toContain(CURRENT_PROJECT.name);
	expect(error).toContain(locale === 'en-US' ? 'Readiness' : 'Prontidão');
	expect(error).not.toContain(locale === 'en-US' ? 'No outcome in this window' : 'Nenhum resultado nesta janela');
	expect(error).not.toContain('Provider');
	expect(error).not.toContain('Backlog');
}

function assertOverviewAvailability(locale: 'en-US' | 'pt-BR'): void {
	const history = { window: '7d' as const, totalRuns: 1, runsWithKnownCost: 0, knownCostUsd: null, runsByOutcome: { shipped: 1, failed: 0, cancelled: 0, incomplete: 0 }, activeRuns: 1, daily: [], configurations: [] };
	const overviewFor = (database: NonNullable<AppProps['overview']>['projects'][number]['database'], historical: NonNullable<AppProps['overview']>['projects'][number]['overview']['overview']) => ({
		window: '7d' as const, overview: history,
		summary: { totalProjects: 1, readyProjects: 1, unavailableProjects: 0, nonTerminalRuns: 1, backlog: { idea: 0, specified: 0, planned: 0 } },
		projects: [{ project: CURRENT_PROJECT, root: { state: 'available' as const }, backlog: { state: 'available' as const, counts: { idea: 0, specified: 0, planned: 0 } }, database, overview: { overview: historical }, activeRun: { id: 'run-factual', issueId: 'CAM-900', state: 'working', providerId: 'claude' as const, createdAt: '', updatedAt: '' }, latestRun: null, latestRunOutcome: null, recentRuns: [] }],
	});
	const databaseUnavailable = renderAt('/overview', { locale, projects: [CURRENT_PROJECT], overview: overviewFor({ state: 'unavailable', path: '/state/runtime.sqlite', reason: 'read failed' }, history) });
	expect(databaseUnavailable).toContain(locale === 'en-US' ? 'Operational data is unavailable.' : 'Dados operacionais indisponíveis.');
	expect(databaseUnavailable).not.toContain(locale === 'en-US' ? 'No active run' : 'Nenhuma run ativa');
	expect(databaseUnavailable).toContain(locale === 'en-US' ? 'Readiness' : 'Prontidão');
	const historyUnavailable = renderAt('/overview', { locale, projects: [CURRENT_PROJECT], overview: overviewFor({ state: 'available', path: '/state/runtime.sqlite' }, null) });
	expect(historyUnavailable).toContain(locale === 'en-US' ? 'Historical data is unavailable.' : 'Dados históricos indisponíveis.');
	expect(historyUnavailable).not.toContain(locale === 'en-US' ? 'No outcome in this window' : 'Nenhum resultado nesta janela');
}

describe('operator shell', () => {
	test('known internal destinations use history across surfaces and projects', () => {
		const base = {
			currentUrl: 'http://gateship.test/projects/project-current/runs',
			defaultPrevented: false,
			button: 0,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			target: '',
			download: false,
		};

		expect(clientNavigationTarget({ ...base, href: '/projects/project-current/work' }))
			.toBe('/projects/project-current/work');
		expect(clientNavigationTarget({ ...base, href: '/settings', currentUrl: 'http://gateship.test/overview' }))
			.toBe('/settings');
		expect(clientNavigationTarget({ ...base, href: '/projects/project-other' })).toBe('/projects/project-other');
		expect(clientNavigationTarget({ ...base, href: '/overview' })).toBe('/overview');
	});

	test('special links keep normal browser navigation behavior', () => {
		const base = {
			currentUrl: 'http://gateship.test/projects/project-current',
			href: '/projects/project-current/runs',
			defaultPrevented: false,
			button: 0,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			target: '',
			download: false,
		};
		for (const intent of [
			{ ...base, href: 'https://example.com/runs' },
			{ ...base, href: '/projects/project-current/runs#latest' },
			{ ...base, target: '_blank' },
			{ ...base, download: true },
			{ ...base, button: 1 },
			{ ...base, ctrlKey: true },
			{ ...base, metaKey: true },
			{ ...base, shiftKey: true },
			{ ...base, altKey: true },
			{ ...base, defaultPrevented: true },
		]) expect(clientNavigationTarget(intent)).toBeNull();
	});

	test('the initial loading render is localized and never infers an empty project state', () => {
		for (const [locale, label] of [['en-US', 'Loading operational data…'], ['pt-BR', 'Carregando dados operacionais…']] as const) {
			const html = renderToStaticMarkup(<InitialOperationalLoading locale={locale} />);
			expect(html).toContain('aria-busy="true"');
			expect(html).toContain('role="status"');
			expect(html).toContain(label);
			expect(html).not.toContain('Project not registered');
			expect(html).not.toContain('>0<');
			expect(html).not.toContain('No active run');
		}
	});

	test('a cross-project boundary selects its destination and hides stale scope data while loading', () => {
		const html = renderAt('/projects/project-other', {
			projects: [CURRENT_PROJECT, OTHER_PROJECT],
			runs: [runIn('working', { issueId: 'CAM-OLD' })],
			surfaceRoute: '/projects/project-current',
			operationalBoundary: { state: 'loading' },
		});

		expect(html).toContain('data-slot="project-switcher"');
		expect(html).toContain('href="/projects/project-other"');
		expect(html).toContain('>other-product</span>');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('Loading operational data…');
		expect(html).not.toContain('CAM-OLD');
		expect(html).not.toContain('Project not registered');
		expect(html).not.toContain('animate-');
	});

	test('a destination snapshot never renders secondary values from the previous scope', () => {
		const html = renderAt('/projects/project-other/work', {
			projects: [{ ...CURRENT_PROJECT, current: false }, { ...OTHER_PROJECT, current: true }],
			surfaceRoute: '/projects/project-other/work',
			backlog: [],
			drafts: [],
			ideas: [],
			proposals: [],
			resolvedProposals: [],
			runs: [],
			chatMessages: [],
			providers: [],
			brief: EMPTY_BRIEF,
			handoff: EMPTY_BRIEF,
			diagnostics: emptyDiagnostics(),
		});
		expect(html).toContain('>other-product</span>');
		for (const previousValue of ['CAM-OLD', BACKLOG[0]?.title ?? '', PROPOSAL.title]) {
			expect(html).not.toContain(previousValue);
		}
	});

	test('the deferred surface replaces the loading boundary after the destination snapshot hydrates', () => {
		const html = renderAt('/projects/project-other/runs', {
			projects: [{ ...CURRENT_PROJECT, current: false }, { ...OTHER_PROJECT, current: true }],
			runs: [runIn('working', { issueId: 'CAM-NEW' })],
			surfaceRoute: '/projects/project-other/runs',
		});

		expect(html).toContain('>other-product</span>');
		expect(html).toContain('CAM-NEW');
		expect(html).not.toContain('Loading operational data…');
	});

	test('the operational failure remains inside the shell with an accessible retry', () => {
		const html = renderAt('/projects/project-current', {
			operationalBoundary: { state: 'failure', detail: 'network failure', onRetry: () => {} },
		});

		expect(html).toContain('data-slot="project-switcher"');
		expect(html).toContain('role="alert"');
		expect(html).toContain('network failure');
		expect(html).toContain('>Try again</button>');
	});

	test('a failed initial read is localized, actionable and never inferred as empty', () => {
		for (const [locale, message, retry] of [
			['en-US', 'Operational data could not be loaded.', 'Try again'],
			['pt-BR', 'Não foi possível carregar os dados operacionais.', 'Tentar novamente'],
		] as const) {
			const html = renderToStaticMarkup(<InitialOperationalFailure detail="network failure" locale={locale} onRetry={() => {}} />);
			expect(html).toContain('role="alert"');
			expect(html).toContain(message);
			expect(html).toContain('network failure');
			expect(html).toContain(`>${retry}</button>`);
			expect(html).not.toContain('Project not registered');
			expect(html).not.toContain('>0<');
		}
	});

	test('overview keeps the global registry as drill-down cards without management forms', () => {
		for (const expected of [
			{ locale: 'en-US' as const, label: 'Control center', current: 'served by this instance', readiness: 'Readiness' },
			{ locale: 'pt-BR' as const, label: 'Central de controle', current: 'servido por esta instância', readiness: 'Prontidão' },
		]) {
			const html = renderAt('/overview', { locale: expected.locale, projects: [CURRENT_PROJECT, OTHER_PROJECT] });
			expect(html).toContain(`aria-label="${expected.label}"`);
			expect(html).not.toContain(`<h2 class="font-semibold text-xl tracking-tight">`);
			expect(html).toContain(`>${expected.current}</span>`);
			expect(html).toContain(`>${expected.readiness}</dt>`);
			expect(html).toContain('acme/gateship');
			expect(html).toContain('acme/other-product');
			expect(html).toContain('href="/overview"');
			expect(html).toContain('href="/projects/project-current"');
			expect(html).toContain('href="/projects/project-other"');
			expect(html).toContain('card-ring-group grid auto-rows-fr gap-6 lg:grid-cols-2 2xl:grid-cols-3');
			expect(html).toMatch(/class="[^"]*h-full[^"]*"/);
			expect(html).not.toContain('name="project-create-repository"');
			expect(html).not.toContain('name="project-import-repository"');
			expect(html).not.toContain('name="project-root"');
		}
	});

	test('overview localizes every latest outcome in pt-BR and keeps absence explicit', () => {
		const outcomes = ['shipped', 'failed', 'cancelled', 'incomplete'] as const;
		const labels = ['enviada', 'falhou', 'cancelada', 'incompleta'];
		for (const [index, outcome] of outcomes.entries()) {
			const html = renderAt('/overview', {
				locale: 'pt-BR',
				projects: [CURRENT_PROJECT],
				overview: {
					window: '7d',
					overview: {
						window: '7d', totalRuns: 1, runsWithKnownCost: 0, knownCostUsd: null,
						runsByOutcome: { shipped: 0, failed: 0, cancelled: 0, incomplete: 1 }, activeRuns: 1,
						daily: [], configurations: [],
					},
					summary: { totalProjects: 1, readyProjects: 1, unavailableProjects: 0, nonTerminalRuns: 0, backlog: { idea: 0, specified: 0, planned: 0 } },
					projects: [{
						project: CURRENT_PROJECT, root: { state: 'available' }, backlog: { state: 'available', counts: { idea: 0, specified: 0, planned: 0 } },
						// The tile needs history for its outcome badge: the legend no
						// longer names outcomes that never happened in the window.
						database: { state: 'available', path: '/state/runtime.sqlite' }, overview: { overview: {
							window: '7d', totalRuns: 1, runsWithKnownCost: 0, knownCostUsd: null,
							runsByOutcome: { shipped: 0, failed: 0, cancelled: 0, incomplete: 1 }, activeRuns: 1,
							daily: [], configurations: [],
						} }, activeRun: null, latestRun: { id: `run-${index}`, issueId: 'CAM-900', state: 'done', providerId: 'claude', createdAt: '', updatedAt: '' }, latestRunOutcome: outcome, recentRuns: [],
					}],
				},
			});
			expect(html).toContain(labels[index]!);
			expect(html).not.toContain(`>${outcome}</p>`);
		}
		const empty = renderAt('/overview', { locale: 'pt-BR', projects: [CURRENT_PROJECT], overview: null });
		expect(empty).not.toContain('Nenhum resultado nesta janela');
		expect(empty).not.toContain('Nenhuma run ativa');
	});

	test('overview loading and error preserve no inferred operational fields in both locales', () => {
		for (const locale of ['en-US', 'pt-BR'] as const) assertOverviewLoadingAndError(locale);
	});

	test('overview derives active projects from activeRun and escalates missing history', () => {
		const entry = (activeRun: NonNullable<AppProps['overview']>['projects'][number]['activeRun'], history: NonNullable<AppProps['overview']>['projects'][number]['overview']['overview']) => ({
			project: CURRENT_PROJECT,
			root: { state: 'available' as const },
			backlog: { state: 'available' as const, counts: { idea: 0, specified: 0, planned: 0 } },
			database: { state: 'available' as const, path: '/state/runtime.sqlite' },
			overview: { overview: history }, activeRun, latestRun: null, latestRunOutcome: null, recentRuns: [],
		});
		const aggregate = (projects: NonNullable<AppProps['overview']>['projects']): NonNullable<AppProps['overview']> => ({
			window: '7d', overview: { window: '7d', totalRuns: 0, runsWithKnownCost: 0, knownCostUsd: null, runsByOutcome: { shipped: 0, failed: 0, cancelled: 0, incomplete: 0 }, activeRuns: 0, daily: [], configurations: [] },
			summary: { totalProjects: projects.length, readyProjects: projects.length, unavailableProjects: 0, nonTerminalRuns: 0, backlog: { idea: 0, specified: 0, planned: 0 } }, projects,
		});
		const history = { window: '7d' as const, totalRuns: 0, runsWithKnownCost: 0, knownCostUsd: null, runsByOutcome: { shipped: 0, failed: 0, cancelled: 0, incomplete: 0 }, activeRuns: 0, daily: [], configurations: [] };
		const noActive = renderAt('/overview', { projects: [CURRENT_PROJECT], overview: aggregate([entry(null, history)]) });
		expect(noActive).toContain('>0</p>');
			const active = renderAt('/overview', { projects: [CURRENT_PROJECT], overview: aggregate([entry({ id: 'run-active', issueId: 'CAM-900', state: 'working', providerId: 'claude', createdAt: '', updatedAt: '' }, history)]) });
		expect(active).toContain('>1</p>');
		const unavailable = renderAt('/overview', { projects: [CURRENT_PROJECT], overview: aggregate([entry(null, null)]) });
		expect(unavailable).toContain('Needs attention');
		expect(unavailable).toContain('Some project data is unavailable.');
	});

	test('overview uses the active run provider instead of historical configuration', () => {
		const history = {
			window: '7d' as const,
			totalRuns: 1,
			runsWithKnownCost: 0,
			knownCostUsd: null,
			runsByOutcome: { shipped: 1, failed: 0, cancelled: 0, incomplete: 0 },
			activeRuns: 1,
			daily: [],
			configurations: [{ provider: 'claude', role: 'executor' }],
		};
		const html = renderAt('/overview', {
			projects: [CURRENT_PROJECT],
			overview: {
				window: '7d',
				overview: history,
				summary: { totalProjects: 1, readyProjects: 1, unavailableProjects: 0, nonTerminalRuns: 1, backlog: { idea: 0, specified: 0, planned: 0 } },
				projects: [{
					project: CURRENT_PROJECT,
					root: { state: 'available' },
					backlog: { state: 'available', counts: { idea: 0, specified: 0, planned: 0 } },
					database: { state: 'available', path: '/state/runtime.sqlite' },
					overview: { overview: history },
					activeRun: { id: 'run-codex', issueId: 'CAM-900', state: 'working', providerId: 'codex', createdAt: '', updatedAt: '' },
					latestRun: null,
					latestRunOutcome: null,
					recentRuns: [],
				}],
			},
		});
		expect(html).toContain('>Provider</dt>');
		expect(html).toMatch(/>Provider<\/dt><dd[^>]*>Codex</);
		expect(html).not.toMatch(/>Provider<\/dt><dd[^>]*>Claude Code</);
	});

	test('overview localizes active run states in pt-BR', () => {
		const states = [
			['working', 'em andamento'],
			['waiting-user', 'aguardando você'],
			['interrupted', 'interrompida'],
		] as const;
		for (const [state, label] of states) {
			const history = {
				window: '7d' as const,
				totalRuns: 0,
				runsWithKnownCost: 0,
				knownCostUsd: null,
				runsByOutcome: { shipped: 0, failed: 0, cancelled: 0, incomplete: 0 },
				activeRuns: 1,
				daily: [],
				configurations: [],
			};
			const html = renderAt('/overview', {
				locale: 'pt-BR',
				projects: [CURRENT_PROJECT],
				overview: {
					window: '7d',
					overview: history,
					summary: { totalProjects: 1, readyProjects: 1, unavailableProjects: 0, nonTerminalRuns: 1, backlog: { idea: 0, specified: 0, planned: 0 } },
					projects: [{
						project: CURRENT_PROJECT,
						root: { state: 'available' },
						backlog: { state: 'available', counts: { idea: 0, specified: 0, planned: 0 } },
						database: { state: 'available', path: '/state/runtime.sqlite' },
						overview: { overview: history },
						activeRun: { id: `run-${state}`, issueId: 'CAM-900', state, providerId: 'claude', createdAt: '', updatedAt: '' },
						latestRun: null,
						latestRunOutcome: null,
						recentRuns: [],
					}],
				},
			});
			// The phase renders as a badge inside its fact row now.
			expect(html).toMatch(new RegExp(`>Fase</dt><dd[^>]*><span[^>]*data-slot="badge"[^>]*>${label}<`));
			expect(html).not.toContain(`>${state}</p>`);
		}
	});

	test('overview keeps database and history availability distinct in both locales', () => {
		for (const locale of ['en-US', 'pt-BR'] as const) assertOverviewAvailability(locale);
	});

	test('overview counts incomplete terminal runs as completed', () => {
		const history = {
			window: '7d' as const,
			totalRuns: 3,
			runsWithKnownCost: 0,
			knownCostUsd: null,
			runsByOutcome: { shipped: 0, failed: 0, cancelled: 0, incomplete: 3 },
			activeRuns: 1,
			daily: [],
			configurations: [],
		};
		const html = renderAt('/overview', {
			projects: [CURRENT_PROJECT],
			overview: {
				window: '7d', overview: history,
				summary: { totalProjects: 1, readyProjects: 1, unavailableProjects: 0, nonTerminalRuns: 1, backlog: { idea: 0, specified: 0, planned: 0 } },
				projects: [{
					project: CURRENT_PROJECT, root: { state: 'available' }, backlog: { state: 'available', counts: { idea: 0, specified: 0, planned: 0 } },
					database: { state: 'available', path: '/state/runtime.sqlite' }, overview: { overview: history },
					activeRun: null, latestRun: null, latestRunOutcome: null, recentRuns: [],
				}],
			},
		});
		// The stat renders label first, value under it; the pairing is the
		// claim, not the type classes.
		expect(html).toMatch(/>Runs completed<\/p><p[^>]*>2<\/p>/s);
	});

	test('overview keeps the activity count without rendering a decorative line chart', () => {
		const history = {
			window: '7d' as const,
			totalRuns: 3,
			runsWithKnownCost: 2,
			knownCostUsd: 1.25,
			runsByOutcome: { shipped: 2, failed: 1, cancelled: 0, incomplete: 0 },
			activeRuns: 1,
			daily: [{
				date: '2026-08-31',
				totalRuns: 3,
				runsByOutcome: { shipped: 2, failed: 1, cancelled: 0, incomplete: 0 },
				runsWithKnownCost: 2,
				knownCostUsd: 1.25,
			}],
			configurations: [],
		};
		const html = renderAt('/overview', {
			projects: [CURRENT_PROJECT],
			overview: {
				window: '7d',
				overview: history,
				summary: { totalProjects: 1, readyProjects: 1, unavailableProjects: 0, nonTerminalRuns: 1, backlog: { idea: 0, specified: 0, planned: 2 } },
				projects: [{
					project: CURRENT_PROJECT,
					root: { state: 'available' },
					backlog: { state: 'available', counts: { idea: 0, specified: 0, planned: 2 } },
					database: { state: 'available', path: '/state/runtime.sqlite' },
					overview: { overview: history },
					activeRun: null,
					latestRun: null,
					latestRunOutcome: null,
					recentRuns: [],
				}],
			},
		});

		expect(html).toMatch(/>Activity<\/p><p[^>]*>3<\/p>/s);
		expect(html).toMatch(/>Runs completed<\/p><p[^>]*>2<\/p>/s);
		expect(html).toContain('card-ring-group grid auto-rows-fr gap-4 sm:grid-cols-2 xl:grid-cols-3');
		expect(html).not.toContain('xl:col-span-2');
		expect(html).toMatch(/class="[^"]*" data-slot="stat"><p[^>]*>Needs attention<\/p>/);
		expect(html).toContain('aria-label="Outcomes"');
		expect(html).toContain('2026-08-31: Activity 3; shipped 2; failed 1; cancelled 0; incomplete 0');
		expect(html).not.toContain('<polyline');
		expect(html).not.toContain('preserveAspectRatio="none"');
	});

	test('project management offers registering an existing checkout by absolute path in both locales', () => {
		for (const expected of [
			{
				locale: 'en-US' as const,
				title: 'Register an existing checkout',
				label: 'Absolute path',
				submit: 'Register project',
				topLevel: 'Gateship registers its real top level',
				docker: 'In Docker the path must exist inside the container',
			},
			{
				locale: 'pt-BR' as const,
				title: 'Registrar um checkout existente',
				label: 'Caminho absoluto',
				submit: 'Registrar projeto',
				topLevel: 'o Gateship registra o top-level real',
				docker: 'No Docker o caminho precisa existir dentro do contêiner',
			},
		]) {
			const html = renderAt('/projects', { locale: expected.locale, projects: [CURRENT_PROJECT] });
			expect(html).toContain(`>${expected.title}</h2>`);
			expect(html).toContain(`>${expected.label}</span>`);
			expect(html).toContain(expected.topLevel);
			expect(html).toContain(expected.docker);
			expect(html).toContain('name="project-root"');
			expect(buttonIsEnabled(html, expected.submit)).toBe(true);
			// No file picker or clone joins path registration.
			expect(html).not.toContain('type="file"');
		}
		// A typed refusal reaches the operator on the surface that asked for it.
		expect(renderAt('/projects', {
			status: 'The origin remote must point to a repository on GitHub.com.',
		})).toContain('The origin remote must point to a repository on GitHub.com.');
		expect(buttonIsEnabled(renderAt('/projects', { pending: true }), 'Register project')).toBe(false);
	});

	test('project management keeps new GitHub creation separate, private by default and confirmation-gated', () => {
		for (const expected of [
			{
				locale: 'en-US' as const,
				title: 'Create a new GitHub repository',
				submit: 'Create repository',
				destination: 'GATESHIP_HOME/projects/owner/repo',
				credential: 'existing GitHub CLI login',
				publicWarning: 'visible to everyone on GitHub',
			},
			{
				locale: 'pt-BR' as const,
				title: 'Criar um repositório novo no GitHub',
				submit: 'Criar repositório',
				destination: 'GATESHIP_HOME/projects/owner/repo',
				credential: 'login existente no GitHub CLI',
				publicWarning: 'visível para qualquer pessoa no GitHub',
			},
		]) {
			const html = renderAt('/projects', { locale: expected.locale });
			expect(html).toContain(`>${expected.title}</h2>`);
			expect(html).toContain(expected.destination);
			expect(html).toContain(expected.credential);
			expect(html).toContain('name="project-create-repository"');
			expect(html).toContain('name="project-create-description"');
			// The visibility control is a popover select: the closed trigger
			// shows the private default; the hidden input serializes it.
			expect(html).toContain(expected.locale === 'en-US' ? '>Private</span>' : '>Privado</span>');
			expect(html).toContain('value="private"');
			expect(html).toContain('name="project-create-confirm"');
			expect(buttonIsEnabled(html, expected.submit)).toBe(false);
			expect(html).not.toContain(expected.publicWarning);
			expect(html).not.toContain('type="password"');
		}
		expect(renderAt('/projects', {
			status: 'The managed checkout was preserved at /managed/acme/product.',
		})).toContain('preserved at /managed/acme/product');
		const creating = renderAt('/projects', {
			pending: true,
			projectOnboardingPending: 'create',
		});
		expect(creating).toContain('Creating the repository and pushing main');
		expect(creating).not.toContain('Cloning the repository');
	});

	// The other onboarding write is a GitHub repository, never a
	// path -- Gateship owns the destination and clones with the operator's
	// existing GitHub login, so no token or credential field is ever offered.
	test('project management offers importing a GitHub repository in both locales', () => {
		for (const expected of [
			{
				locale: 'en-US' as const,
				title: 'Import a GitHub repository',
				label: 'GitHub repository',
				submit: 'Import repository',
				pending: 'Cloning the repository',
				destination: 'Gateship stores the clone under its own managed directory',
				credential: 'uses your existing GitHub login',
			},
			{
				locale: 'pt-BR' as const,
				title: 'Importar um repositório do GitHub',
				label: 'Repositório do GitHub',
				submit: 'Importar repositório',
				pending: 'Clonando o repositório',
				destination: 'O Gateship guarda o clone no seu próprio diretório gerenciado',
				credential: 'usa o seu login do GitHub já existente',
			},
		]) {
			const html = renderAt('/projects', { locale: expected.locale, projects: [CURRENT_PROJECT] });
			expect(html).toContain(`>${expected.title}</h2>`);
			expect(html).toContain(`>${expected.label}</span>`);
			expect(html).toContain(expected.destination);
			expect(html).toContain(expected.credential);
			expect(html).toContain('name="project-import-repository"');
			expect(buttonIsEnabled(html, expected.submit)).toBe(true);
			expect(html).not.toContain('type="password"');
			expect(html).not.toContain(expected.pending);
		}
		const importing = renderAt('/projects', { pending: true, projectOnboardingPending: 'import' });
		expect(buttonIsEnabled(importing, 'Import repository')).toBe(false);
		expect(importing).toContain('Cloning the repository');
		expect(importing).not.toContain('Creating the repository and pushing main');
		// A typed refusal reaches the operator on the surface that asked for it.
		expect(renderAt('/projects', {
			status: 'That repository is already a checkout of a different one.',
		})).toContain('That repository is already a checkout of a different one.');
	});

	test('a ready non-current project has conversation and project-scoped settings', () => {
		const conversation = renderAt('/projects/project-other', {
			projects: [CURRENT_PROJECT, OTHER_PROJECT],
			runs: [runIn('interrupted')],
		});
		expect(openingTags(conversation).find((tag) => tag.startsWith('<main')))
			.toContain('aria-label="Conversation with the orchestrator"');
		expect(conversation).toContain('/projects/project-other/runs');
		expect(conversation).not.toContain('Project runtime not loaded');

		const settings = renderAt('/projects/project-other/settings', {
			projects: [CURRENT_PROJECT, OTHER_PROJECT],
			project: {
				...READY_PROJECT,
				name: 'other-product',
				repository: 'acme/other-product',
				remoteUrl: 'git@github.com:acme/other-product.git',
			},
			runs: [runIn('interrupted')],
		});
		expect(settings).toContain('other-product');
		expect(settings).toContain('acme/other-product');
		expect(settings).toContain('Local agents');
		expect(settings).toContain('Model and effort by role');
		expect(settings).toContain('Automatic run chaining');
		expect(settings).toContain('Executor handoff between providers');
		expect(settings).toContain('Project brief');
		expect(settings).toContain('Automatic handoff');
		expect(settings).not.toContain('CAM-900');
		expect(settings).not.toContain('acme/gateship');
		expect(settings).not.toContain('Operator profile');
	});

	test('ready project settings render only the selected diagnostic schedule snapshot', () => {
		const currentDiagnostics = { ...emptyDiagnostics(), schedule: { ...emptyDiagnostics().schedule, enabled: true, cadence: 'daily' as const, overdue: true } };
		const otherDiagnostics = { ...emptyDiagnostics(), schedule: { ...emptyDiagnostics().schedule, enabled: false, cadence: 'weekly' as const } };
		const current = renderAt('/projects/project-current/settings', { projects: [CURRENT_PROJECT, OTHER_PROJECT], diagnostics: currentDiagnostics });
		const other = renderAt('/projects/project-other/settings', { projects: [CURRENT_PROJECT, OTHER_PROJECT], diagnostics: otherDiagnostics });

		expect(current).toContain('Diagnostic schedule');
		expect(current).toContain('overdue');
		expect(other).toContain('Diagnostic schedule');
		expect(other).toContain('Disabled.');
	});

	test('settings omit the diagnostic schedule until the selected project is ready', () => {
		const html = renderAt('/projects/project-other/settings', {
			projects: [CURRENT_PROJECT, { ...OTHER_PROJECT, readiness: 'empty' as const }],
			project: { state: 'empty', name: 'other', detail: 'not ready' },
		});
		expect(html).toContain('Project runtime not loaded');
		expect(html).not.toContain('Diagnostic schedule');
	});

	// GSHIP-717: removal is offered on the selected non-current project, states
	// that nothing on disk goes, and stays behind an explicit confirmation.
	test('a non-current project offers a confirmed removal that keeps its files, in both locales', () => {
		for (const expected of [
			{
				locale: 'en-US' as const,
				title: 'Remove this project from Gateship',
				description: 'Removal only drops the registration',
				filesRemain: 'Nothing is deleted: the checkout, its .gship state, worktrees, branches, runs, issues and its GitHub repository all stay on disk',
				confirm: 'Remove other-product from the registry and keep every file it has.',
				submit: 'Remove project',
			},
			{
				locale: 'pt-BR' as const,
				title: 'Remover este projeto do Gateship',
				description: 'A remoção só tira o registro',
				filesRemain: 'Nada é apagado: o checkout, o estado em .gship, worktrees, branches, runs, issues e o repositório no GitHub continuam no disco',
				confirm: 'Remover other-product do registro e manter todos os seus arquivos.',
				submit: 'Remover projeto',
			},
		]) {
			const html = renderAt('/projects/project-other/settings', {
				locale: expected.locale,
				projects: [CURRENT_PROJECT, OTHER_PROJECT],
			});
			expect(html).toContain(`>${expected.title}</h2>`);
			expect(html).toContain(expected.description);
			expect(html).toContain(expected.filesRemain);
			expect(html).toContain(`>${expected.confirm}</span>`);
			expect(html).toContain('name="project-unregister-confirm"');
			// The action is offered, and refused until the operator confirms it.
			expect(buttonIsEnabled(html, expected.submit)).toBe(false);
		}
		// A typed refusal reaches the operator on the surface that asked for it.
		expect(renderAt('/projects/project-other/settings', {
			projects: [CURRENT_PROJECT, OTHER_PROJECT],
			status: 'Run run-1 is still working. Finish, cancel or abandon it before removing this project.',
		})).toContain('Finish, cancel or abandon it before removing this project.');
	});

	test('removal is never offered for the project this instance serves', () => {
		for (const route of ['/overview', '/projects/project-current', '/projects/project-current/settings'] as const) {
			const html = renderAt(route, { projects: [CURRENT_PROJECT, OTHER_PROJECT] });
			expect(html).not.toContain('Remove this project from Gateship');
			expect(html).not.toContain('name="project-unregister-confirm"');
		}
	});

	test('runs is operational for a ready non-current project and commands it', () => {
		const html = renderAt('/projects/project-other/runs', {
			projects: [CURRENT_PROJECT, OTHER_PROJECT],
			runs: [runIn('interrupted')],
			workspaceNotices: NOTICES,
		});

		expect(html).not.toContain('Project runtime not loaded');
		expect(html).toContain('CAM-900');
		expect(html).toContain('>Resume<');
		expect(html).toContain('>Abandon<');
		// The route renders runs alone: no work or settings panel leaks into it.
		expect(html).not.toContain('>Start<');
		expect(html).not.toContain('Operator profile');
	});

	// GSHIP-712 and GSHIP-736: work is operational for a registered ready
	// project. Diagnostics remain boot-only, while proposals belong to the
	// selected project and render on every ready project's work surface.
	test('work is operational for a ready non-current project, with its proposals', () => {
		const html = renderAt('/projects/project-other/work', {
			projects: [CURRENT_PROJECT, OTHER_PROJECT],
			drafts: [DRAFT],
			ideas: [{ id: 'CAM-950', title: 'ideia para especificar' }],
			diagnostics: DIAGNOSTICS_WITH_FINDING,
			proposals: [PROPOSAL],
			resolvedProposals: [{ ...PROPOSAL, status: 'dismissed' as const, promotedIssueId: null }],
			resolvedProposalsOmittedCount: 3,
		});

		expect(html).not.toContain('Project runtime not loaded');
		// The project-scoped core, whole: backlog, drafts, ideas and intake.
		expect(html).toContain('Executable backlog');
		expect(html).toContain('CAM-900');
		expect(html).toContain('>Start run<');
		expect(html).toContain('Review and approve');
		expect(html).toContain('CAM-940');
		expect(html).toContain('Specify existing idea');
		expect(html).toContain('CAM-950');
		expect(html).toContain('New issue');
		// Diagnostics and proposal data are both scoped to this selected project.
		expect(html).toContain('Gateship Diagnostics');
		expect(html).toContain('regra-autoral');
		expect(html).toContain('Derived proposals');
		expect(html).toContain('Resolved proposals');
		expect(html).toContain('proposta do boot');
		expect(html).toContain('+3 resolved proposals not shown.');
	});

	test('the current project keeps the same work panels and their behaviour', () => {
		const html = renderAt('/projects/project-current/work', {
			projects: [CURRENT_PROJECT, OTHER_PROJECT],
			drafts: [DRAFT],
			diagnostics: DIAGNOSTICS_WITH_FINDING,
			proposals: [PROPOSAL],
			resolvedProposals: [{ ...PROPOSAL, status: 'dismissed' as const, promotedIssueId: null }],
			resolvedProposalsOmittedCount: 3,
		});

		expect(html).toContain('Executable backlog');
		expect(html).toContain('Review and approve');
		expect(html).toContain('New issue');
		expect(html).toContain('Gateship Diagnostics');
		expect(html).toContain('regra-autoral');
		expect(html).toContain('Derived proposals');
		expect(html).toContain('proposta do boot');
		expect(html).toContain('Resolved proposals');
		expect(html).toContain('+3 resolved proposals not shown.');
	});

	test('a not-ready non-current project keeps the unavailable surface on runs and work', () => {
		for (const suffix of ['/runs', '/work']) {
			const html = renderAt(`/projects/project-other${suffix}` as OperatorRoute, {
				projects: [CURRENT_PROJECT, { ...OTHER_PROJECT, readiness: 'empty' as const }],
				runs: [runIn('interrupted')],
				diagnostics: DIAGNOSTICS_WITH_FINDING,
				proposals: [PROPOSAL],
			});

			expect(html).toContain('Project runtime not loaded');
			expect(html).not.toContain('CAM-900');
			expect(html).not.toContain('>Resume<');
			expect(html).not.toContain('Executable backlog');
			expect(html).not.toContain('Gateship Diagnostics');
			expect(html).not.toContain('proposta do boot');
		}
	});

	test('an unknown project keeps the typed not-found surface', () => {
		for (const suffix of ['/runs', '/work']) {
			const html = renderAt(`/projects/project-missing${suffix}` as OperatorRoute, {
				projects: [CURRENT_PROJECT, OTHER_PROJECT],
				runs: [runIn('interrupted')],
			});

			expect(html).toContain('Project not registered');
			expect(html).not.toContain('CAM-900');
			expect(html).not.toContain('>Resume<');
			expect(html).not.toContain('Executable backlog');
		}
	});

	test('the persistent language control offers the other locale on every surface', () => {
		// The control is a single button in the shell's top-right row: its
		// face and label name the locale it switches TO.
		for (const locale of ['en-US', 'pt-BR'] as const) {
			for (const route of SURFACE_PATHS) {
				const html = renderAt(route, { locale });

				expect(html).toContain('id="gateship-locale"');
				expect(html).toContain(
					`aria-label="${locale === 'en-US' ? 'Português (Brasil)' : 'English (US)'}"`,
				);
				expect(html).toContain(locale === 'en-US' ? '>PT<' : '>EN<');
			}
		}
	});

	test('the language control remains available while onboarding blocks the route surface', () => {
		const project: ProjectStatusView = { state: 'empty', name: 'workspace', detail: 'not ready' };
		for (const route of ['/', '/runs', '/work'] as const) {
			const html = renderAt(route, { project });
			expect(html).toContain('Connect a GitHub project');
			expect(html).toContain('id="gateship-locale"');
		}
	});

	test('only exact supported stored values become locales', () => {
		expect(readLocalePreference(() => 'en-US')).toBe('en-US');
		expect(readLocalePreference(() => 'pt-BR')).toBe('pt-BR');
		for (const stored of [null, 'en-us', 'pt', '']) {
			expect(readLocalePreference(() => stored)).toBe('en-US');
		}
		expect(readLocalePreference(() => { throw new Error('storage unavailable'); })).toBe('en-US');
	});

	test('selection updates the document language before best-effort persistence', () => {
		const effects: string[] = [];
		applyLocalePreference(
			'pt-BR',
			(locale) => { effects.push(`lang:${locale}`); },
			(key, locale) => {
				effects.push(`store:${key}:${locale}`);
				throw new Error('storage unavailable');
			},
		);
		expect(effects).toEqual(['lang:pt-BR', 'store:gateship.locale:pt-BR']);
	});

	test('navigation keeps Control Center global and separates the project switcher only by space', () => {
		for (const route of SURFACE_PATHS) {
			const html = renderAt(route);
			const start = html.indexOf('<nav aria-label="Navigation"');
			const nav = html.slice(start, html.indexOf('</nav>', start));
			const active = openingTags(nav).find((tag) =>
				tag.includes(`href="${route}"`) && tag.includes('aria-current="page"'));
			const switcher = elementWith(html, 'data-slot="project-switcher"');
			const switcherItem = elementWith(html, 'data-slot="project-switcher-item"');
			const projectSurfaceNavigation = elementWith(html, 'data-slot="project-surface-navigation"');
			const globalStart = nav.indexOf('data-slot="global-navigation"');
			const projectStart = nav.indexOf('data-slot="project-navigation"');
			const globalGroup = nav.slice(globalStart, projectStart);
			const switcherStart = html.indexOf('data-slot="project-switcher"');
			const switcherEnd = html.indexOf('</button>', switcherStart);
			const switcherMarkup = html.slice(switcherStart, switcherEnd);

			expect(nav).toContain('aria-label="Navigation"');
			for (const label of ['Control center', 'Conversation', 'Runs', 'Work', 'Settings']) {
				expect(nav).toContain(`>${label}</span>`);
			}
			expect(nav).toContain('flex-wrap');
			expect(nav).not.toContain('overflow-x-auto');
			expect(nav).toContain('href="/overview"');
			for (const path of SURFACE_PATHS) expect(nav).toContain(`href="${path}"`);
			expect(globalGroup).toContain('href="/overview"');
			expect(globalGroup).not.toContain('data-slot="project-switcher"');
			expect(globalGroup).toContain('</ul><div');
			expect(nav).not.toContain('data-slot="navigation-divider"');
			expect(nav).not.toContain('data-slot="project-context-label"');
			expect(projectStart).toBeLessThan(nav.indexOf('data-slot="project-switcher"'));
			expect(elementWith(html, 'data-slot="project-navigation"')).toContain('mt-3');
			expect(elementWith(html, 'data-slot="project-navigation"')).toContain('lg:mt-5');
			expect(projectSurfaceNavigation).toContain('lg:pl-2');
			expect(projectSurfaceNavigation).toContain('lg:mt-1');
			expect(projectSurfaceNavigation).not.toContain('border-l');
			expect(projectSurfaceNavigation).not.toContain('border-sidebar-border');
			expect(projectSurfaceNavigation).not.toContain(' pl-2');
			expect(projectSurfaceNavigation).not.toContain('pt-1');
			expect(nav.indexOf('href="/overview"')).toBeLessThan(nav.indexOf('data-slot="project-switcher"'));
			expect(nav.indexOf('data-slot="project-switcher"')).toBeLessThan(nav.indexOf(`href="${route}"`));
			expect(nav.match(/href="\/overview"/g)).toHaveLength(1);
			expect(switcher).toContain('rounded-md');
			expect(switcher).toContain('px-3');
			expect(switcher).toContain('focus-visible:ring-2');
			expect(switcherItem).toContain('w-full');
			expect(switcherItem).toContain('min-w-0');
			expect(switcherItem).not.toContain('shrink-0');
			expect(switcherMarkup).toContain('w-10');
			expect(switcherMarkup).not.toContain('size-8');
			expect(active).toContain('aria-current="page"');
			expect(nav.split('aria-current="page"')).toHaveLength(3);
			// Navigation itself stays on served paths. The shell-level skip link is
			// the one deliberate in-page anchor.
			expect(nav).not.toContain('href="#');
		}
	});

	test('navigation keeps the localized global settings footer on desktop', () => {
		for (const expected of [
			{ locale: 'en-US' as const, globalSettings: 'Global settings' },
			{ locale: 'pt-BR' as const, globalSettings: 'Ajustes globais' },
		]) {
			const html = renderAt('/projects/project-current', { locale: expected.locale });
			const footerStart = html.indexOf(`<nav aria-label="${expected.globalSettings}"`);
			const footer = html.slice(footerStart, html.indexOf('</nav>', footerStart));

			expect(footer).toContain('hidden');
			expect(footer).toContain('lg:mt-auto');
			expect(footer).toContain('href="/settings"');
			expect(footer).toContain(`>${expected.globalSettings}</span>`);
		}
	});

	test('navigation localizes the global destination and project-management menu action', () => {
		for (const expected of [
			{ locale: 'en-US' as const, overview: 'Control center', manage: 'Manage projects' },
			{ locale: 'pt-BR' as const, overview: 'Central de controle', manage: 'Gerenciar projetos' },
		]) {
			const html = renderAt('/projects/project-current', { locale: expected.locale });
			const start = html.indexOf('<nav aria-label=');
			const nav = html.slice(start, html.indexOf('</nav>', start));

			expect(nav).toContain(`>${expected.overview}</span>`);
			expect(html).toContain(`href="/projects">${expected.manage}</a>`);
		}
	});

	test('project management is a global route with the existing three registry actions', () => {
		const html = renderAt('/projects');
		expect(openingTags(html).find((tag) => tag.startsWith('<main'))).toContain('aria-label="Projects"');
		expect(html).toContain('>Projects</h2>');
		for (const field of ['project-create-repository', 'project-import-repository', 'project-root']) {
			expect(html).toContain(`name="${field}"`);
		}
	});

	test('navigation keeps only the project switcher in its contextual group without a selected project', () => {
		const html = renderAt('/overview', { projects: [] });
		const start = html.indexOf('<nav aria-label="Navigation"');
		const nav = html.slice(start, html.indexOf('</nav>', start));

		expect(nav).toContain('data-slot="project-switcher"');
		expect(nav).not.toContain('data-slot="project-surface-navigation"');
	});

	test('project switcher renders Alt shortcuts in the leading column and marks the selection', () => {
		const projects = Array.from({ length: 10 }, (_, index) => ({
			...CURRENT_PROJECT,
			id: `project-${index + 1}`,
			name: `Project ${index + 1}`,
			current: index === 0,
		}));
		const html = renderAt('/overview', { projects });
		const selectedHtml = renderAt('/projects/project-1', { projects });
		const triggerStart = selectedHtml.indexOf('data-slot="project-switcher"');
		const trigger = selectedHtml.slice(triggerStart, selectedHtml.indexOf('</button>', triggerStart));
		const shortcuts = [...html.matchAll(/<kbd[^>]*>(Alt\+[1-9])<\/kbd>/g)].map((match) => match[1]);

		expect(shortcuts).toEqual(['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9']);
		expect(trigger).toContain('Alt+1');
		expect(selectedHtml).toContain('aria-current="page"');
		expect(html).not.toContain('⌘');
		expect(html).toContain('href="/projects/project-9"');
		expect(html).toContain('href="/projects/project-10"');
		expect(html).not.toContain('Alt+10');
	});

	test('project switcher uses a glyph-sized spacer when its selection does not resolve', () => {
		const emptySelectionHtml = renderAt('/projects/project-missing');
		const emptyTriggerStart = emptySelectionHtml.indexOf('data-slot="project-switcher"');
		const emptyTrigger = emptySelectionHtml.slice(emptyTriggerStart, emptySelectionHtml.indexOf('</button>', emptyTriggerStart));
		const selectedHtml = renderAt('/projects/project-current');
		const selectedTriggerStart = selectedHtml.indexOf('data-slot="project-switcher"');
		const selectedTrigger = selectedHtml.slice(selectedTriggerStart, selectedHtml.indexOf('</button>', selectedTriggerStart));

		expect(emptyTrigger).toContain('>Select a project<');
		expect(emptyTrigger).toContain('aria-hidden="true" class="size-4 shrink-0"');
		expect(emptyTrigger).not.toContain('w-10');
		expect(emptyTrigger).not.toContain('<kbd');
		expect(selectedTrigger).toContain('w-10');
		expect(selectedTrigger).toContain('Alt+1');
	});

	test('project shortcuts navigate with Alt+Digit1 through Alt+Digit9 and reject other combinations', () => {
		const projects = Array.from({ length: 10 }, (_, index) => ({
			...CURRENT_PROJECT,
			id: `project-${index + 1}`,
			current: index === 0,
		}));
		const locations: string[] = [];
		const invoke = (key: string, code: string | undefined, modifiers: Pick<PanelKeyEvent, 'altKey' | 'metaKey' | 'ctrlKey'>): { handled: boolean; prevented: boolean } => {
			let prevented = false;
			const handled = handleProjectShortcut(
				{ key, code, ...modifiers, preventDefault: () => { prevented = true; } },
				projects,
				{ location: { assign: (url) => { locations.push(url); } } },
			);
			return { handled, prevented };
		};

		expect(invoke('&', 'Digit1', { altKey: true, metaKey: false, ctrlKey: false })).toEqual({ handled: true, prevented: true });
		expect(invoke('(', 'Digit9', { altKey: true, metaKey: false, ctrlKey: false })).toEqual({ handled: true, prevented: true });
		expect(locations).toEqual(['/projects/project-1', '/projects/project-9']);
		expect(invoke('1', undefined, { altKey: true, metaKey: false, ctrlKey: false })).toEqual({ handled: true, prevented: true });
		expect(invoke('2', '', { altKey: true, metaKey: false, ctrlKey: false })).toEqual({ handled: true, prevented: true });
		expect(invoke('3', 'Numpad3', { altKey: true, metaKey: false, ctrlKey: false })).toEqual({ handled: false, prevented: false });
		expect(invoke('1', 'Digit1', { altKey: false, metaKey: false, ctrlKey: false })).toEqual({ handled: false, prevented: false });
		expect(invoke('1', 'Digit1', { altKey: true, metaKey: true, ctrlKey: false })).toEqual({ handled: false, prevented: false });
		expect(invoke('9', 'Digit9', { altKey: true, metaKey: false, ctrlKey: true })).toEqual({ handled: false, prevented: false });
		expect(invoke('0', 'Digit0', { altKey: true, metaKey: false, ctrlKey: false })).toEqual({ handled: false, prevented: false });
		let missingPrevented = false;
		expect(handleProjectShortcut(
			{ key: '3', code: 'Digit3', altKey: true, metaKey: false, ctrlKey: false, preventDefault: () => { missingPrevented = true; } },
			projects.slice(0, 2),
			{ location: { assign: (url) => { locations.push(url); } } },
		)).toBe(false);
		expect(missingPrevented).toBe(false);
		expect(locations).toEqual(['/projects/project-1', '/projects/project-9', '/projects/project-1', '/projects/project-2']);
	});

	test('panel toggle glyph thickens only its outer stroke', () => {
		const html = renderToStaticMarkup(<><PanelToggleGlyph side="left" /><PanelToggleGlyph side="right" /></>);
		const glyphs = [...html.matchAll(/<svg[^>]*data-slot="panel-toggle-glyph"[\s\S]*?<\/svg>/g)].map((match) => match[0]);

		expect(glyphs).toHaveLength(2);
		for (const glyph of glyphs) {
			expect(glyph).toContain('stroke-width="2.5"');
			expect(glyph).toContain('fill="currentColor"');
		}
	});

	test('an explicit pt-BR locale translates the shell, shared inspector and operational runs panels', () => {
		const html = runsPage({ locale: 'pt-BR' });
		const start = html.indexOf('<nav aria-label="Navegação"');
		const nav = html.slice(start, html.indexOf('</nav>', start));

		expect(nav).toContain('aria-label="Navegação"');
		for (const label of ['Central de controle', 'Conversa', 'Runs', 'Trabalho', 'Ajustes']) {
			expect(nav).toContain(`>${label}</span>`);
		}
		expect(html).toContain('>Pular para o conteúdo</a>');
		expect(html).toContain('Execução mais recente');
		expect(html).toContain('Nenhuma execução registrada ainda.');

		const withDeepPanel = runsPage({ locale: 'pt-BR', runs: [runIn('done', {
			cost: {
				totalCostUsd: 0.1,
				breakdown: [{ role: 'executor', model: 'claude-opus-4-6', costUsd: 0.1 }],
				roles: [],
			},
		})] });
		expect(withDeepPanel).toContain('Custo por função e modelo');
	});

	test('keyboard navigation starts with one skip link targeting the route main', () => {
		for (const route of SURFACE_PATHS) {
			const html = renderAt(route);
			const tags = openingTags(html);
			const skip = tags.find((tag) => tag.includes('href="#main-content"'));
			const main = tags.filter((tag) => tag.startsWith('<main'));

			expect(skip).toBe(tags.find((tag) => tag.startsWith('<a')));
			expect(html).toContain('>Skip to content</a>');
			expect(main).toHaveLength(1);
			expect(main[0]).toContain('id="main-content"');
			expect(main[0]).toContain('tabindex="-1"');
		}
	});

	test('reads canonical project routes and falls unknown paths back to overview', () => {
		expect(routeOf('/overview')).toBe('/overview');
		expect(routeOf('/projects')).toBe('/projects');
		expect(routeOf('/projects/project-current')).toBe('/projects/project-current');
		expect(routeOf('/projects/project-current/runs/')).toBe('/projects/project-current/runs');
		expect(routeOf('/projects/project-current/work')).toBe('/projects/project-current/work');
		expect(routeOf('/projects/project-current/settings')).toBe('/projects/project-current/settings');
		expect(routeOf('/projects/project-current/unknown')).toBe('/overview');
		expect(routeOf('/qualquer-coisa')).toBe('/overview');
	});

	test('the shell reports one human state and the version it is serving', () => {
		expect(shellHeader(home())).toContain('Idle');
		expect(shellHeader(runsPage({ runs: [runIn('working')] }))).toContain('Working');
		// No version reported: the header shows the title alone.
		expect(home()).not.toMatch(/v\d+\.\d+\.\d+/);
		expect(shellHeader(home())).not.toContain('>v<');
		expect(home({ version: '0.292.0' })).toContain('>v0.292.0<');

		const released = shellHeader(home({ version: '0.302.0+8146b060' }));
		expect(released).toContain('>v0.302.0<');
		expect(released).not.toContain('8146b060');
	});

	test('the header carries the product mark as its accessible title, the badge in full, and the version', () => {
		const html = shellHeader(runsPage({ runs: [runIn('failed')], version: '0.292.0' }));
		const title = html.slice(html.indexOf('<h1'), html.indexOf('</h1>'));

		// The wordmark replaces the text h1, but the h1 itself stays: its
		// accessible name now comes from the mark's own role="img" label.
		expect(title).toContain('role="img"');
		expect(title).toContain('aria-label="Gateship"');
		// The lockup carries no intrinsic size, so the box only holds the art
		// when the viewBox and the reserved ratio agree on the wordmark's canvas.
		expect(title).toContain('viewBox="3250 0 10187 2750"');
		expect(title).toContain('aspect-[10187/2750]');
		// The badge moved off the title's row, so its longest label is never
		// squeezed for space.
		expect(html).toContain('>Needs you<');
		expect(html).toContain('>v0.292.0<');
	});

	test('the sidebar keeps its mark on the collapsed rail axis in both states', () => {
		const rail = renderToStaticMarkup(<ShellRail needsYou />);
		const expanded = shellHeader(home());
		const expandedTitle = expanded.slice(expanded.indexOf('<h1'), expanded.indexOf('</h1>'));

		// 72px rail + half of the content panel's 12px outer spacing makes a 78px
		// corridor. Its centre advances 3px; the mark retains its 1px correction
		// in both shell states. Desktop adds 12px layout spacing, which minus the
		// mark's 4px translation leaves the required 8px visual wordmark gap.
		expect(rail).toContain('lg:w-18');
		expect(rail).toContain('translate-x-px');
		expect(rail).toContain('lg:translate-x-[4px]');
		expect(rail).toContain('bg-attention');
		expect(expandedTitle).toContain('translate-x-px');
		expect(expandedTitle).toContain('lg:translate-x-[4px]');
		expect(expandedTitle).toContain('gap-2');
		expect(expandedTitle).toContain('lg:gap-3');
		expect(expandedTitle).toContain('aspect-[10187/2750]');
	});

	test('the technical run state stays on the run card and never reaches the header', () => {
		const html = runsPage({ runs: [runIn('failed')] });

		expect(shellHeader(html)).toContain('Needs you');
		expect(shellHeader(html)).not.toContain('failed');
		expect(html).toContain('>failed<');
	});

	test('a service older than origin/main is reported wherever the operator is', () => {
		const staleService = {
			bootSha: '1'.repeat(40),
			currentSha: '2'.repeat(40),
			detail: 'Restart the service para aplicar o que entrou depois do boot.',
		};

		// The ordinary case says nothing at all, on any surface.
		for (const route of SURFACE_PATHS) {
			expect(shellHeader(renderAt(route))).not.toContain('Restart the service');
		}
		// While it lasts it is on every surface, with both shas, and it stays:
		// there is no button to acknowledge it away.
		for (const route of SURFACE_PATHS) {
			const header = shellHeader(renderAt(route, { staleService }));

			expect(header).toContain('Restart the service');
			expect(header).toContain(staleService.detail);
			expect(header).toContain(staleService.bootSha);
			expect(header).toContain(staleService.currentSha);
			expect(hasButton(header, 'Dispensar')).toBe(false);
		}
	});

	test('an outdated service reports, and holds no operator command back', () => {
		const staleService = {
			bootSha: '1'.repeat(40),
			currentSha: '2'.repeat(40),
			detail: 'Restart the service para aplicar o que entrou depois do boot.',
		};
		const html = runsPage({ runs: [runIn('ready-to-ship')], staleService });

		expect(shellHeader(html)).toContain('Restart the service');
		// The human state is the run's own, and every command it admits is offered.
		expect(shellHeader(html)).toContain('Needs you');
		expect(buttonIsEnabled(html, 'Ship')).toBe(true);
		expect(buttonIsEnabled(
			workPage({ staleService, selectedIssueId: 'CAM-900' }),
			'Start run',
		)).toBe(true);
	});

	test('a missing git identity is reported wherever the operator is (GSHIP-654)', () => {
		const gitIdentity = { detail: 'no git author identity is configured' };

		// The ordinary case says nothing at all, on any surface.
		for (const route of SURFACE_PATHS) {
			expect(shellHeader(renderAt(route))).not.toContain('Missing Git identity');
		}
		// While it lasts it is on every surface, with the detail, and it stays:
		// there is no button to acknowledge it away.
		for (const route of SURFACE_PATHS) {
			const header = shellHeader(renderAt(route, { gitIdentity }));

			expect(header).toContain('Missing Git identity');
			expect(header).toContain(gitIdentity.detail);
			expect(hasButton(header, 'Dispensar')).toBe(false);
		}
	});

	test('a missing git identity reports, and holds no operator command back', () => {
		const gitIdentity = { detail: 'no git author identity is configured' };
		const html = runsPage({ runs: [runIn('ready-to-ship')], gitIdentity });

		expect(shellHeader(html)).toContain('Missing Git identity');
		// The human state is the run's own, and every command it admits is offered.
		expect(shellHeader(html)).toContain('Needs you');
		expect(buttonIsEnabled(html, 'Ship')).toBe(true);
	});

	test('a preserved workspace asks for the operator whatever the run is doing', () => {
		expect(shellHeader(runsPage({ runs: [runIn('done')], workspaceNotices: NOTICES })))
			.toContain('Needs you');
		expect(shellHeader(runsPage({ runs: [runIn('working')], workspaceNotices: NOTICES })))
			.toContain('Needs you');
	});

	// GSHIP-650: a stopped chain queue asks for the operator too, wherever they
	// are, the same way a preserved workspace already does -- and names the
	// issue that stopped it instead of leaving the operator to go find out.
	test('a stopped chain queue asks for the operator and names the issue that stopped it', () => {
		const pause: ChainPauseView = {
			reason: 'previous-run-not-done',
			createdAt: '2026-08-19T00:00:00.000Z',
			run: { id: 'run-9', issueId: 'GSHIP-647' },
			issue: { id: 'GSHIP-647', title: 'Corrigir a divergência de evidência' },
		};
		for (const route of SURFACE_PATHS) {
			const header = shellHeader(renderAt(route, { chainRuns: { enabled: true, pause } }));
			expect(header).toContain('Needs you');
			expect(header).toContain('Queue stopped');
			expect(header).toContain('GSHIP-647');
			expect(header).toContain('Corrigir a divergência de evidência');
			expect(header).toContain('the previous run did not finish in done.');
		}
		// The ordinary case says nothing at all.
		expect(shellHeader(home())).not.toContain('Queue stopped');
	});

	// A pause the read could not resolve a run for still asks for attention,
	// but by its reason alone -- never a fabricated issue name. Excludes
	// chain-disabled and an exhausted queue are covered separately below, since
	// neither escalates.
	test('a stopped chain queue with no resolvable issue is still reported by its reason alone', () => {
		const labels: Record<Exclude<ChainPauseReason, 'chain-disabled' | 'no-admissible-issue'>, string> = {
			'previous-run-not-done': 'the previous run did not finish in done.',
			'run-active': 'a run is still active.',
			'chain-start-failed': 'the attempt to start the next run failed.',
		};
		for (const [reason, label] of Object.entries(labels)) {
			const pause = { reason: reason as ChainPauseReason, createdAt: '2026-08-18T00:00:00.000Z' };
			const header = shellHeader(renderAt('/projects/project-current/settings', { chainRuns: { enabled: true, pause } }));
			expect(header).toContain('Needs you');
			expect(header).toContain(`Queue stopped`);
			expect(header).toContain(label);
			expect(header).not.toContain('GSHIP');
		}
	});

	test('an exhausted enabled queue reports completion without asking for attention', () => {
		const pause: ChainPauseView = {
			reason: 'no-admissible-issue',
			createdAt: '2026-08-18T00:00:00.000Z',
		};
		const header = shellHeader(home({
			chainRuns: { enabled: true, pause },
			runs: [runIn('done')],
		}));

		expect(header).toContain('Idle');
		expect(header).toContain('Queue complete');
		expect(header).toContain('there is no eligible work left in the backlog.');
		expect(header).not.toContain('Needs you');
		expect(header).not.toContain('Queue stopped');
	});

	// GSHIP-650 review: chaining is off by default (GSHIP-638), so
	// chain-disabled is every default install's steady state, not a stopped
	// queue -- escalating it would read "Needs you" with a warning
	// callout forever, on every surface, for an install that never turned
	// chaining on.
	test('the switch simply being off never escalates the header or shows the callout', () => {
		const pause: ChainPauseView = { reason: 'chain-disabled', createdAt: '2026-08-18T00:00:00.000Z' };
		const header = shellHeader(renderAt('/projects/project-current/settings', { chainRuns: { enabled: false, pause } }));

		expect(header).toContain('Idle');
		expect(header).not.toContain('Needs you');
		expect(header).not.toContain('Queue stopped');
	});

	// GSHIP-650 review: setChainRuns writes the setting alone and emits no
	// event, so a pause recorded before the operator turned the switch off
	// survives the turn-off in storage. Turning the switch off must still clear
	// the shown state -- there is no stopped queue while it is off, whatever
	// the reason recorded.
	test('turning the switch off clears a previously recorded pause from the header', () => {
		const pause: ChainPauseView = {
			reason: 'no-admissible-issue',
			createdAt: '2026-08-18T00:00:00.000Z',
			run: { id: 'run-9', issueId: 'GSHIP-9' },
			issue: { id: 'GSHIP-9', title: 'Última issue encadeada' },
		};

		const on = shellHeader(renderAt('/projects/project-current/settings', { chainRuns: { enabled: true, pause } }));
		expect(on).toContain('Idle');
		expect(on).toContain('Queue complete');

		const off = shellHeader(renderAt('/projects/project-current/settings', { chainRuns: { enabled: false, pause } }));
		expect(off).toContain('Idle');
		expect(off).not.toContain('Needs you');
		expect(off).not.toContain('Queue stopped');
		expect(off).not.toContain('GSHIP-9');
	});
});

describe('conversation transcript', () => {
	const HASH = 'a'.repeat(64);

	/** Every long, unbreakable string the operator can be shown, per surface. */
	function renderLongContent(route: OperatorRoute): string {
		return renderAt(route, {
			backlog: [{ id: `CAM-${HASH}`, title: `issue ${HASH}` }],
			chatMessages: [{
				seq: 1,
				providerId: 'claude',
				role: 'orchestrator',
				text: `Comparei com ${HASH} rodando bun test test/web/ui-client.test.tsx --coverage`,
				createdAt: '2026-08-16T03:00:00.000Z',
			}],
			ideas: [{ id: `CAM-idea-${HASH}`, title: `ideia ${HASH}` }],
			providers: [
				{ id: 'claude', installed: true, subscription: false, label: `Claude ${HASH}`, login: 'external' },
			],
			runs: [
				runIn('working', { id: `run-${HASH}`, summary: `Verificando ${HASH}` }),
				runIn('done', { id: `run-old-${HASH}`, issueId: `CAM-${HASH}` }),
			],
			events: [{
				seq: 1,
				runId: `run-${HASH}`,
				kind: `provider.activity.${HASH}`,
				fromState: 'working',
				toState: 'working',
				payload: { text: `Commit ${HASH}` },
				createdAt: '2026-08-16T03:04:05.000Z',
			}],
			workspaceNotices: [{
				kind: 'dirty',
				runId: `run-${HASH}`,
				workspacePath: `/project/.gship/worktrees/${HASH}`,
				branch: `gship/cam-1-${HASH}`,
				detail: `workspace ${HASH} is not owned by a persisted run`,
			}],
			staleService: {
				bootSha: HASH,
				currentSha: `b${HASH.slice(1)}`,
				detail: `Restart the service: origin/main saiu de ${HASH}.`,
			},
			status: `Falha ao ler /api/runs/run-${HASH}`,
		});
	}

	test('an untouched scroller stays at the live edge, a scrolled-up one does not', () => {
		const geometry = { scrollHeight: 1000, clientHeight: 400 };

		expect(isAtLiveEdge({ ...geometry, scrollTop: 600 })).toBe(true);
		// A fraction of a pixel short of the bottom is still the bottom.
		expect(isAtLiveEdge({ ...geometry, scrollTop: 600 - LIVE_EDGE_TOLERANCE_PX })).toBe(true);
		expect(isAtLiveEdge({ ...geometry, scrollTop: 599 - LIVE_EDGE_TOLERANCE_PX })).toBe(false);
		expect(isAtLiveEdge({ ...geometry, scrollTop: 0 })).toBe(false);
		// Nothing to scroll: the operator is at the edge by definition.
		expect(isAtLiveEdge({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 })).toBe(true);
	});

	test('the return-to-latest control only applies to an overflowing transcript away from its edge', () => {
		expect(canReturnToLiveEdge({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })).toBe(true);
		expect(canReturnToLiveEdge({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(false);
		expect(canReturnToLiveEdge({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 })).toBe(false);
	});

	test('the shared live edge opens at newest, follows arrivals, pauses, and resumes', () => {
		const position = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
		const liveEdge = createLiveEdgeController();

		liveEdge.onArrival(position);
		expect(position.scrollTop).toBe(1000);

		position.scrollHeight = 1200;
		liveEdge.onArrival(position);
		expect(position.scrollTop).toBe(1200);

		position.scrollTop = 500;
		liveEdge.onScroll(position);
		position.scrollHeight = 1400;
		liveEdge.onArrival(position);
		expect(position.scrollTop).toBe(500);

		position.scrollTop = position.scrollHeight - position.clientHeight;
		liveEdge.onScroll(position);
		position.scrollHeight = 1600;
		liveEdge.onArrival(position);
		expect(position.scrollTop).toBe(1600);
	});

	test('a resize away from the live edge pauses the next arrival without a scroll event', () => {
		const position = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
		const liveEdge = createLiveEdgeController();

		liveEdge.onScroll(position);
		position.clientHeight = 200;
		// The ResizeObserver feeds the changed geometry through this same path.
		liveEdge.onScroll(position);
		position.scrollHeight = 1200;
		liveEdge.onArrival(position);

		expect(position.scrollTop).toBe(600);
	});

	test('run activity keeps following after its panel shrinks at the live edge', () => {
		const position = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
		const liveEdge = createLiveEdgeController();

		liveEdge.onScroll(position);
		position.clientHeight = 200;
		// RunActivity does not opt into ResizeObserver, so no controller update runs.
		position.scrollHeight = 1200;
		liveEdge.onArrival(position);

		expect(position.scrollTop).toBe(1200);
	});

	test('a replacement run resets a paused live edge and opens at its newest event', () => {
		const position = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
		let session = liveEdgeSession(null, 'run-1');

		session.controller.onArrival(position);
		position.scrollTop = 100;
		session.controller.onScroll(position);
		position.scrollHeight = 800;
		session = liveEdgeSession(session, 'run-2');
		session.controller.onArrival(position);

		expect(position.scrollTop).toBe(800);
	});

	test('an unmounted run resets before the same run remounts', () => {
		const position = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
		let session = liveEdgeSession(null, 'run-1');

		session.controller.onArrival(position);
		position.scrollTop = 100;
		session.controller.onScroll(position);
		// The null identity has no node, so there is deliberately no arrival.
		session = liveEdgeSession(session, null);
		session = liveEdgeSession(session, 'run-1');
		position.scrollHeight = 1200;
		session.controller.onArrival(position);

		expect(position.scrollTop).toBe(1200);
	});

	test('the transcript is one focusable, announced region in every state', () => {
		const empty = home();
		const loaded = home({
			chatMessages: [{
				seq: 1,
				providerId: 'claude',
				role: 'orchestrator',
				text: 'Pronto.',
				createdAt: '2026-08-16T03:00:00.000Z',
			}],
		});

		for (const html of [empty, loaded]) {
			const region = elementWith(html, 'role="log"');
			expect(region).toContain('aria-label="Conversation transcript"');
			expect(region).toContain('tabindex="0"');
			expect(region).toContain('overflow-y-auto');
			expect(html.split('role="log"')).toHaveLength(2);
		}
		// The empty state is inside the region, so the region never moves.
		expect(empty.indexOf('role="log"')).toBeLessThan(empty.indexOf('Describe the goal'));
		expect(loaded.indexOf('role="log"')).toBeLessThan(loaded.indexOf('Pronto.'));
	});

	test('the run inspector follows the conversation on narrow screens and stays lateral on desktop', () => {
		const html = home();
		const layout = elementWith(html, 'data-slot="conversation-layout"');
		const transcript = elementWith(html, 'role="log"');
		const inspector = elementWith(html, 'data-slot="run-inspector"');
		const card = elementWith(html, 'data-slot="card-frame"');
		const cardPanel = elementWith(html, 'data-slot="card-panel"');
		const main = openingTags(html).find((tag) => tag.startsWith('<main'));

		expect(layout).toContain('flex-col');
		expect(layout).toContain('overflow-y-auto');
		expect(layout).toContain('xl:flex-row');
		expect(layout).toContain('xl:overflow-hidden');
		expect(transcript).toContain('overflow-y-visible');
		expect(transcript).toContain('xl:overflow-y-auto');
		expect(transcript).toContain('min-h-0');
		expect(main).toContain('shrink-0');
		expect(main).toContain('xl:min-h-0');
		expect(card).toContain('xl:min-h-0');
		expect(cardPanel).toContain('min-h-0');
		expect(main).toContain('xl:flex-1');
		expect(inspector).toContain('w-full');
		expect(inspector).toContain('xl:w-96');
		expect(html.indexOf('<main')).toBeLessThan(html.indexOf('data-slot="run-inspector"'));
	});

	test('the shell owns the matched panel controls and removes the inspector column when closed', () => {
		const open = home();
		const sidebar = elementWith(open, 'aria-label="Collapse the sidebar"');
		const inspectorToggle = elementWith(open, 'aria-label="Collapse the run panel"');
		const inspector = elementWith(open, 'data-slot="run-inspector"');
		const glyphs = [...open.matchAll(/<svg[^>]*data-slot="panel-toggle-glyph"[^>]*>/g)].map((match) => match[0]);
		const leftGlyph = glyphs.find((glyph) => glyph.includes('data-side="left"'));
		const rightGlyph = glyphs.find((glyph) => glyph.includes('data-side="right"'));

		expect(sidebar).toContain('border-input');
		expect(sidebar).toContain('size-9');
		expect(inspectorToggle).toContain('border-input');
		expect(inspectorToggle).toContain('size-9');
		expect(leftGlyph).toBeDefined();
		expect(rightGlyph).toBeDefined();
		for (const glyph of [leftGlyph, rightGlyph]) {
			const index = open.indexOf(glyph ?? '');
			const svg = open.slice(index, open.indexOf('</svg>', index));
			expect(svg).toContain('fill="currentColor"');
		}
		expect(open.indexOf('aria-label="Collapse the sidebar"')).toBeLessThan(open.indexOf('aria-label="Collapse the run panel"'));
		expect(elementWith(open, 'aria-label="Wide layout"')).toContain('hidden 2xl:inline-flex');
		expect(inspector).not.toContain('border-l');
		expect(open).not.toContain('xl:border-l');

		const runtime = globalThis as unknown as { localStorage?: { getItem: (key: string) => string | null; setItem: () => void } };
		const previousStorage = runtime.localStorage;
		runtime.localStorage = {
			getItem: (key) => key === 'gship-inspector' ? 'closed' : null,
			setItem: () => {},
		};
		try {
			const closed = home();
			expect(closed).toContain('aria-label="Expand the run panel"');
			expect(closed).not.toContain('data-slot="run-inspector"');
			expect(closed).not.toContain('Current run');
		} finally {
			runtime.localStorage = previousStorage;
		}
	});

	test('conversation and run output use the same focusable live-edge contract', () => {
		const conversation = home({
			chatMessages: [{
				seq: 1,
				providerId: 'claude',
				role: 'orchestrator',
				text: 'Watching the run.',
				createdAt: '2026-08-16T03:00:00.000Z',
			}],
		});
		const activity = runsPage({
			runs: [runIn('working')],
			events: [{
				seq: 2,
				runId: 'run-1',
				kind: 'provider.activity',
				fromState: 'working',
				toState: 'working',
				payload: { text: 'Editing the client.' },
				createdAt: '2026-08-16T03:04:05.000Z',
			}],
		});
		const liveRegions = [conversation, activity].map((html) => elementWith(html, 'role="log"'));

		expect(liveRegions).toHaveLength(2);
		expect(liveRegions.map((tag) => tag.match(/aria-label="([^"]+)"/)?.[1])).toEqual([
			'Conversation transcript',
			'Activity',
		]);
		for (const region of liveRegions) {
			expect(region).toContain('tabindex="0"');
			expect(region).toContain('overflow-y-auto');
		}
	});

	test('long hashes, commands and ids are rendered with a rule that breaks them', () => {
		const surfaces = SURFACE_PATHS.map(renderLongContent);
		const unbreakable = surfaces.flatMap((html) =>
			openingTags(html).filter((tag) =>
				tag.startsWith('<code') || tag.includes('whitespace-pre-wrap')));

		expect(unbreakable.length).toBeGreaterThan(3);
		for (const tag of unbreakable) expect(tag).toMatch(/break-(all|words)/);
		// The content itself is still there, whole.
		expect(renderLongContent('/')).toContain(`Comparei com ${HASH}`);
		expect(renderLongContent('/runs')).toContain(`provider.activity.${HASH}`);
		expect(renderLongContent('/runs')).toContain(`/project/.gship/worktrees/${HASH}`);
		expect(renderLongContent('/work')).toContain(`issue ${HASH}`);
	});

	test('horizontal scrolling is confined to named tab lists and table containers', () => {
		for (const route of SURFACE_PATHS) {
			const html = renderLongContent(route);
			const horizontal = openingTags(html).filter((tag) => tag.includes('overflow-x-auto'));

			// The page body never scrolls sideways: wide content scrolls inside
			// its own container. Tab lists own one deliberate scroller; dense tables
			// keep owning their own horizontal overflow.
			const tables = horizontal.filter((tag) => tag.includes('data-slot="table-container"'));
			const local = horizontal.filter((tag) => !tag.includes('data-slot="table-container"'));
			for (const scroller of local) expect(scroller).toContain('data-slot="tabs-scroll"');
			if (route.endsWith('/work')) expect(local).not.toHaveLength(0);
			const operatorNav = html.indexOf('<nav aria-label="Navigation"');
			const navigation = html.slice(operatorNav, html.indexOf('</nav>', operatorNav));
			expect(navigation).not.toContain('overflow-x-auto');
			expect(horizontal.length).toBe(tables.length + local.length);
		}
	});
});

describe('screen derivations', () => {
	test('progress advances monotonically along the run spine', () => {
		const spine: RunState[] = [
			'queued',
			'working',
			'verify',
			'review',
			'ready-to-ship',
			'shipping',
			'done',
		];
		const values = spine.map(progressOf);

		expect(values[0]).toBe(0);
		expect(values.at(-1)).toBe(1);
		for (let i = 1; i < values.length; i += 1) {
			expect(values[i] ?? 0).toBeGreaterThan(values[i - 1] ?? 0);
		}
	});

	test('every run state reads as one of the three states the operator acts on', () => {
		const needsYou: RunState[] = [
			'waiting-user',
			'waiting-provider',
			'failed',
			'interrupted',
			'ready-to-ship',
		];
		const busy: RunState[] = ['queued', 'working', 'verify', 'review', 'shipping'];

		for (const state of needsYou) expect(attentionOf(runIn(state), false)).toBe('Needs you');
		for (const state of busy) expect(attentionOf(runIn(state), false)).toBe('Working');
		expect(attentionOf(runIn('done'), false)).toBe('Idle');
		expect(attentionOf(runIn('cancelled'), false)).toBe('Idle');
		expect(attentionOf(null, false)).toBe('Idle');
	});

	test('a preserved workspace decides before the run state does', () => {
		expect(attentionOf(runIn('done'), NOTICES)).toBe('Needs you');
		expect(attentionOf(runIn('working'), NOTICES)).toBe('Needs you');
		expect(attentionOf(null, NOTICES)).toBe('Needs you');
		expect(attentionOf(runIn('done'), [])).toBe('Idle');
		expect(attentionOf(runIn('working'), true)).toBe('Needs you');
	});

	// GSHIP-650: a stopped chain queue decides before the run state does, the
	// same way a preserved workspace already does -- otherwise a queue paused
	// after a `done` run reads as idle, hiding exactly the state it named.
	test('a stopped chain queue decides before the run state does', () => {
		expect(attentionOf(runIn('done'), false, true)).toBe('Needs you');
		expect(attentionOf(runIn('cancelled'), false, true)).toBe('Needs you');
		expect(attentionOf(runIn('done'), false, false)).toBe('Idle');
		expect(attentionOf(runIn('done'), false)).toBe('Idle');
	});

	test('an interrupted run is resumable and a terminal one is not', () => {
		expect(actionsFor(runIn('interrupted'), false).resume).toBe(true);
		expect(actionsFor(runIn('waiting-provider'), false).resume).toBe(true);
		expect(actionsFor(runIn('failed'), true)).toMatchObject({ start: true, resume: false });
	});

	test('only an interrupted run can be abandoned, and an abandoned one blocks nothing', () => {
		expect(actionsFor(runIn('interrupted'), true))
			.toMatchObject({ abandon: true, resume: true, start: false, cancel: false });
		for (const state of ['working', 'ready-to-ship', 'waiting-user', 'done', 'failed'] as const) {
			expect(actionsFor(runIn(state), false).abandon).toBe(false);
		}
		// A cancelled run is settled: it offers nothing and holds nothing back.
		expect(actionsFor(runIn('cancelled'), true))
			.toEqual({ start: true, resume: false, abandon: false, cancel: false, ship: false });
	});

	test('a state transition and a created run make the snapshot stale', () => {
		expect(invalidatesSnapshot(eventIn('working', 'verify', 'cycle.completed'))).toBe(true);
		expect(invalidatesSnapshot(eventIn('queued', 'queued', 'run.created'))).toBe(true);
	});

	test('a cleanup warning makes the snapshot stale though it never changes state', () => {
		expect(invalidatesSnapshot(eventIn('done', 'done', 'workspace.cleanup-warning'))).toBe(true);
	});

	test('a proposal capture makes the snapshot stale though it never changes state', () => {
		expect(invalidatesSnapshot(eventIn('working', 'working', 'run.proposals-captured'))).toBe(true);
	});

	test('ordinary activity inside one state leaves the snapshot current', () => {
		expect(invalidatesSnapshot(eventIn('done', 'done', 'activity'))).toBe(false);
	});
});

describe('same-origin transport', () => {
	interface RecordedCall {
		url: string;
		method: string;
		body: string | null;
	}

	/** Records every request the client makes and answers it with `payload`. */
	async function withRecordedFetch(
		payload: unknown,
		status: number,
		body: (calls: RecordedCall[]) => Promise<unknown>,
	): Promise<RecordedCall[]> {
		const calls: RecordedCall[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = ((input: string, init?: RequestInit) => {
			calls.push({
				url: String(input),
				method: init?.method ?? 'GET',
				body: typeof init?.body === 'string' ? init.body : null,
			});
			return Promise.resolve(Response.json(payload, { status }));
		}) as typeof globalThis.fetch;
		try {
			await body(calls);
		} finally {
			globalThis.fetch = real;
		}
		return calls;
	}

	test('reads and writes stay on the routes the server already exposes', () => {
		expect(SNAPSHOT_PATH).toBe('/api/snapshot');
		expect(PROJECT_PATH).toBe('/api/project');
		expect(PROJECTS_PATH).toBe('/api/projects');
		expect(OPERATOR_PROFILE_PATH).toBe('/api/operator-profile');
		expect(RUNS_PATH).toBe('/api/runs');
		expect(EVENTS_PATH).toBe('/api/events');
		expect(ISSUES_PATH).toBe('/api/issues');
		expect(PROVIDERS_PATH).toBe('/api/providers');
		expect(CHAT_PATH).toBe('/api/chat');
		expect(BRIEF_PATH).toBe('/api/brief');
		expect(PROPOSALS_PATH).toBe('/api/proposals');
		expect(RESOLVED_PROPOSALS_PATH).toBe('/api/proposals/resolved');
		expect(CHAIN_RUNS_PATH).toBe('/api/chain-runs');
		expect(DIAGNOSTIC_SCHEDULE_PATH).toBe('/api/diagnostics/schedule');
		expect(NOTIFICATIONS_PATH).toBe('/api/notifications');
		expect(UPDATE_PATH).toBe('/api/update');
	});

	test('reads the global project registry defensively from its same-origin route', async () => {
		await withRecordedFetch({ projects: [CURRENT_PROJECT, { id: false }, OTHER_PROJECT] }, 200, async (calls) => {
			expect(await fetchProjects()).toEqual([CURRENT_PROJECT, OTHER_PROJECT]);
			expect(calls).toEqual([{ url: PROJECTS_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchProjects()).toEqual([]);
		});
	});

	test('registers an existing checkout through the registry route and surfaces its refusal', async () => {
		await withRecordedFetch({ ok: true, project: OTHER_PROJECT }, 200, async (calls) => {
			expect(await registerProject('/other-product/packages/app')).toEqual(OTHER_PROJECT);
			expect(calls).toEqual([{
				url: PROJECTS_PATH,
				method: 'POST',
				body: JSON.stringify({ root: '/other-product/packages/app' }),
			}]);
		});
		await withRecordedFetch(
			{ ok: false, code: 'project-not-ready', message: 'The repository does not have a remote named origin.' },
			409,
			async () => {
				await expect(registerProject('/other-product'))
					.rejects.toThrow('The repository does not have a remote named origin.');
			},
		);
		await withRecordedFetch({ ok: true, project: { id: false } }, 200, async () => {
			await expect(registerProject('/other-product'))
				.rejects.toThrow('unreadable project registration');
		});
	});

	test('imports a GitHub repository through its own route, and keeps its refusal typed', async () => {
		await withRecordedFetch({ ok: true, project: OTHER_PROJECT }, 200, async (calls) => {
			expect(await importProject('acme/other-product')).toEqual(OTHER_PROJECT);
			expect(calls).toEqual([{
				url: `${PROJECTS_PATH}/import`,
				method: 'POST',
				body: JSON.stringify({ repository: 'acme/other-product' }),
			}]);
		});
		await withRecordedFetch(
			{ ok: false, code: 'clone-failed', message: 'Cloning acme/other-product failed: fatal: could not read Username.' },
			502,
			async () => {
				await expect(importProject('acme/other-product'))
					.rejects.toThrow('Cloning acme/other-product failed');
			},
		);
		await withRecordedFetch({ ok: true, project: { id: false } }, 200, async () => {
			await expect(importProject('acme/other-product'))
				.rejects.toThrow('unreadable project import');
		});
	});

	test('creates a GitHub repository through its own route without credential fields', async () => {
		const input = {
			repository: 'acme/other-product',
			visibility: 'public' as const,
			description: 'Other product',
			authorization: 'Create acme/other-product as a public GitHub repository.',
		};
		await withRecordedFetch({ ok: true, project: OTHER_PROJECT }, 200, async (calls) => {
			expect(await createProject(input)).toEqual(OTHER_PROJECT);
			expect(calls).toEqual([{
				url: `${PROJECTS_PATH}/create`,
				method: 'POST',
				body: JSON.stringify(input),
			}]);
		});
		await withRecordedFetch(
			{
				ok: false,
				code: 'partial-create',
				message: 'The managed checkout was preserved at /managed/acme/other-product.',
				repository: 'acme/other-product',
				root: '/managed/acme/other-product',
			},
			502,
			async () => {
				await expect(createProject(input)).rejects.toThrow('preserved at /managed/acme/other-product');
			},
		);
		await withRecordedFetch({ ok: true, project: { id: false } }, 200, async () => {
			await expect(createProject(input)).rejects.toThrow('unreadable project creation');
		});
	});

	test('removes a registration through the same route, and keeps its refusal typed', async () => {
		await withRecordedFetch({ ok: true, project: OTHER_PROJECT }, 200, async (calls) => {
			expect(await unregisterProject('project / other')).toEqual(OTHER_PROJECT);
			expect(calls).toEqual([{
				url: `${PROJECTS_PATH}/project%20%2F%20other`,
				method: 'DELETE',
				body: null,
			}]);
		});
		await withRecordedFetch(
			{ ok: false, code: 'project-has-active-run', message: 'Run run-1 is still working.' },
			409,
			async () => {
				await expect(unregisterProject('project-other'))
					.rejects.toThrow('Run run-1 is still working.');
			},
		);
		await withRecordedFetch({ ok: true, project: { id: false } }, 200, async () => {
			await expect(unregisterProject('project-other'))
				.rejects.toThrow('unreadable project removal');
		});
	});

	test('native update policy reads and writes only its same-origin route', async () => {
		const update = {
			...emptySelfUpdate(),
			availability: { kind: 'native' as const },
			currentVersion: '1.0.0',
		};
		await withRecordedFetch({ update }, 200, async (calls) => {
			expect(await fetchSelfUpdate()).toEqual(update);
			expect(calls).toEqual([{ url: UPDATE_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({ ok: true, update: { ...update, enabled: true } }, 200, async (calls) => {
			expect(await saveSelfUpdate(true)).toBe('Automatic native updates enabled.');
			expect(calls).toEqual([{
				url: UPDATE_PATH,
				method: 'PUT',
				body: JSON.stringify({ enabled: true }),
			}]);
		});
	});

	test('operator profile is read and saved on its own same-origin route', async () => {
		const profile = { name: 'Eduardo', timezone: 'America/Sao_Paulo' };
		await withRecordedFetch({ profile }, 200, async (calls) => {
			expect(await fetchOperatorProfile()).toEqual(profile);
			expect(calls).toEqual([{ url: OPERATOR_PROFILE_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchOperatorProfile()).toEqual(EMPTY_OPERATOR_PROFILE);
		});
		await withRecordedFetch({ ok: true, profile }, 200, async (calls) => {
			expect(await saveOperatorProfile(profile)).toBe('Operator profile updated.');
			expect(calls).toEqual([{
				url: OPERATOR_PROFILE_PATH,
				method: 'PUT',
				body: JSON.stringify(profile),
			}]);
		});
		await withRecordedFetch({ ok: false, message: 'Timezone inválido.' }, 400, async () => {
			await expect(saveOperatorProfile(profile)).rejects.toThrow('Timezone inválido.');
		});
	});

	test('project readiness is read defensively from its same-origin route', async () => {
		const project: ProjectStatusView = {
			state: 'ready',
			name: 'product',
			repository: 'acme/product',
			remoteUrl: 'https://github.com/acme/product.git',
			sourceRef: 'origin/main',
		};
		await withRecordedFetch({ project }, 200, async (calls) => {
			expect(await fetchProjectStatus()).toEqual(project);
			expect(calls).toEqual([{ url: PROJECT_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchProjectStatus()).toEqual({
				state: 'needs-attention',
				name: '',
				reason: 'not-repository',
				detail: 'The service did not report a valid project state.',
			});
		});
	});

	test('the inbox is read and decided on the proposal-scoped routes', async () => {
		const proposals = [{
			id: 'run-1-proposal-1',
			title: 'Cobrir o retry do shipper',
			evidence: 'Sem teste no caminho de erro.',
			sourceRunId: 'run-1',
			sourceIssueId: 'CAM-50',
		}];
		await withRecordedFetch({ proposals }, 200, async (calls) => {
			expect(await fetchProposals()).toEqual(proposals);
			expect(calls).toEqual([{ url: PROPOSALS_PATH, method: 'GET', body: null }]);
		});
		// A payload without the key reads as an empty inbox, never as a hole.
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchProposals()).toEqual([]);
		});
		await withRecordedFetch({ ok: true, proposal: { id: 'run-1-proposal-1' } }, 200, async (calls) => {
			expect(await dismissProposal('run-1-proposal-1')).toBe('Proposal dismissed.');
			expect(calls).toEqual([{
				url: '/api/proposals/run-1-proposal-1/dismiss',
				method: 'POST',
				body: null,
			}]);
		});
		// Promotion posts the operator's contract and answers with the filed issue.
		const draft = {
			title: 'Cobrir o retry do shipper',
			scope: 'Adicionar o teste que falta.',
			verificationCommand: 'bun test',
		};
		await withRecordedFetch(
			{ ok: true, issue: { id: 'CAM-950', title: draft.title } },
			200,
			async (calls) => {
				expect(await promoteProposal('run-1-proposal-1', draft))
					.toEqual({ id: 'CAM-950', title: draft.title });
				expect(calls).toEqual([{
					url: '/api/proposals/run-1-proposal-1/promote',
					method: 'POST',
					body: JSON.stringify(draft),
				}]);
			},
		);
	});

	// GSHIP-643: the resolved history is read on its own route, distinct from
	// the pending inbox above, and never writes anything back.
	test('the resolved history is read on its own route, omitted count included', async () => {
		const resolved: ResolvedProposalView[] = [{
			id: 'run-1-proposal-1',
			title: 'Cobrir o retry do shipper',
			evidence: 'Sem teste no caminho de erro.',
			sourceRunId: 'run-1',
			sourceIssueId: 'CAM-50',
			status: 'promoted',
			promotedIssueId: 'CAM-951',
		}];
		await withRecordedFetch({ proposals: resolved, omittedCount: 3 }, 200, async (calls) => {
			expect(await fetchResolvedProposals()).toEqual({ proposals: resolved, omittedCount: 3 });
			expect(calls).toEqual([{ url: RESOLVED_PROPOSALS_PATH, method: 'GET', body: null }]);
		});
		// A payload missing either key reads as an empty, un-truncated history.
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchResolvedProposals()).toEqual({ proposals: [], omittedCount: 0 });
		});
	});

	test('a refused decision surfaces the server message instead of a generic failure', async () => {
		await withRecordedFetch(
			{ ok: false, code: 'proposal-not-pending', message: 'Proposal run-1-proposal-1 is already promoted.' },
			409,
			async () => {
				expect(await dismissProposal('run-1-proposal-1'))
					.toBe('Proposal run-1-proposal-1 is already promoted.');
				await expect(promoteProposal('run-1-proposal-1', {
					title: 'Título',
					scope: 'Escopo.',
					verificationCommand: 'bun test',
				})).rejects.toThrow('Proposal run-1-proposal-1 is already promoted.');
			},
		);
	});

	test('the records arrive on one read and the client sends only the brief for invalidation', async () => {
		const brief = {
			objective: 'Manter a intenção do produto sob controle do operador.',
			decisions: ['O brief é distinto do handoff.'],
			constraints: ['Nenhuma rota nova.'],
			openItems: ['Editar o brief pela web.'],
		};
		const handoff = {
			objective: 'Implementar a fatia 2 do estágio 2.',
			decisions: ['A leitura devolve os dois registros.'],
			constraints: ['A UI apenas lê este registro.'],
			openItems: ['Regenerar o bundle.'],
		};

		await withRecordedFetch({ brief, handoff }, 200, async (calls) => {
			expect(await fetchBrief()).toEqual({ brief, handoff });
			expect(calls).toEqual([{ url: BRIEF_PATH, method: 'GET', body: null }]);
		});
		// An incomplete payload reads as the empty four fields, never as a hole.
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchBrief()).toEqual({ brief: EMPTY_BRIEF, handoff: EMPTY_BRIEF });
		});
		await withRecordedFetch({ brief: { objective: 'só o objetivo' } }, 200, async () => {
			expect(await fetchBrief()).toEqual({
				brief: { ...EMPTY_BRIEF, objective: 'só o objetivo' },
				handoff: EMPTY_BRIEF,
			});
		});
		// The write carries the brief alone, on the same route, as a PUT.
		await withRecordedFetch({ ok: true, brief }, 200, async (calls) => {
			expect(await saveBrief(brief)).toBe('Project brief updated.');
			expect(calls).toEqual([{
				url: BRIEF_PATH,
				method: 'PUT',
				body: JSON.stringify(brief),
			}]);
		});
	});

	test('the per-role model choice is read and written on one same-origin route', async () => {
		expect(MODEL_SETTINGS_PATH).toBe('/api/model-settings');
		const settings: ModelSettingsView = {
			...EMPTY_MODEL_SETTINGS,
			claude: {
				orchestrator: { model: 'sonnet', effort: '' },
				executor: { model: 'opus', effort: 'xhigh' },
				reviewer: { model: '', effort: 'high' },
			},
		};

		await withRecordedFetch({ settings: { claude: settings.claude } }, 200, async (calls) => {
			// A payload missing a provider or a role reads as unconfigured, never as
			// a hole: the screen shows the CLI default for it.
			expect(await fetchModelSettings()).toEqual(settings);
			expect(calls).toEqual([{ url: MODEL_SETTINGS_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchModelSettings()).toEqual(EMPTY_MODEL_SETTINGS);
		});

		await withRecordedFetch({ ok: true, settings: {} }, 200, async (calls) => {
			expect(await saveModelSettings(settings)).toBe('Models by role updated.');
			expect(calls).toEqual([{
				url: MODEL_SETTINGS_PATH,
				method: 'PUT',
				body: JSON.stringify(settings),
			}]);
		});
		// A refusal surfaces the server's own validation message.
		await withRecordedFetch({
			ok: false,
			code: 'invalid-request',
			message: 'claude/executor model cannot contain whitespace.',
		}, 400, async () => {
			expect(await saveModelSettings(settings))
				.toBe('claude/executor model cannot contain whitespace.');
		});
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchModelSettings()).rejects.toThrow('Models responded with 500');
		});
	});

	test('global defaults and project resets use their existing same-origin routes', async () => {
		const defaults = { provider: 'codex' as const, modelSettings: EMPTY_MODEL_SETTINGS };
		expect(AGENT_DEFAULTS_PATH).toBe('/api/agent-defaults');
		await withRecordedFetch({ defaults: { provider: 'codex' } }, 200, async (calls) => {
			expect(await fetchAgentDefaults()).toEqual(defaults);
			expect(calls).toEqual([{ url: AGENT_DEFAULTS_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({ ok: true, defaults }, 200, async (calls) => {
			expect(await saveAgentDefaults(defaults)).toBe('Agent defaults updated.');
			expect(calls).toEqual([{
				url: AGENT_DEFAULTS_PATH, method: 'PUT', body: JSON.stringify(defaults),
			}]);
		});
		await withRecordedFetch({ ok: true, source: 'global' }, 200, async (calls) => {
			expect(await resetModelSettings('project-current')).toBe('Models reset to global defaults.');
			expect(await resetSelectedProvider('project-current')).toBe('Provider reset to global default.');
			expect(calls).toEqual([
				{ url: '/api/projects/project-current/model-settings', method: 'DELETE', body: null },
				{ url: '/api/projects/project-current/providers/claude/select', method: 'DELETE', body: null },
			]);
		});
	});

	// GSHIP-620: a probed slot's own outcome is folded into the save status,
	// with the CLI's own message when it was refused or stayed inconclusive.
	test('the save status reports a refused or inconclusive slot with the CLI\'s own message', async () => {
		await withRecordedFetch({
			ok: true,
			settings: {},
			probes: {
				claude: { executor: { outcome: 'refused', message: 'model "ghost" was not found' } },
				codex: { reviewer: { outcome: 'inconclusive', message: 'timed out' } },
			},
		}, 200, async () => {
			const status = await saveModelSettings(EMPTY_MODEL_SETTINGS);
			expect(status).toContain('claude/executor');
			expect(status).toContain('model "ghost" was not found');
			expect(status).toContain('codex/reviewer');
			expect(status).toContain('timed out');
		});

		// An accepted slot, or one that was never probed, adds nothing beyond the
		// base confirmation: no news there is the expected outcome.
		await withRecordedFetch({
			ok: true,
			settings: {},
			probes: { claude: { executor: { outcome: 'accepted' } } },
		}, 200, async () => {
			expect(await saveModelSettings(EMPTY_MODEL_SETTINGS)).toBe('Models by role updated.');
		});
	});

	// GSHIP-638: the switch and, when the queue is stopped, the reason of its
	// last pause, read and written on one same-origin route.
	test('the chain switch is read and written on one same-origin route', async () => {
		await withRecordedFetch({ enabled: true, pause: null }, 200, async (calls) => {
			expect(await fetchChainRuns()).toEqual({ enabled: true, pause: null });
			expect(calls).toEqual([{ url: CHAIN_RUNS_PATH, method: 'GET', body: null }]);
		});
		// A payload missing either key reads as off with nothing paused, never as a hole.
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchChainRuns()).toEqual(EMPTY_CHAIN_RUNS);
		});
		const pause: ChainPauseView = { reason: 'no-admissible-issue', createdAt: '2026-08-18T21:00:00.000Z' };
		await withRecordedFetch({ enabled: true, pause }, 200, async () => {
			expect(await fetchChainRuns()).toEqual({ enabled: true, pause });
		});
		// A pause missing a field reads as none: there is nothing coherent to show.
		await withRecordedFetch({ enabled: true, pause: { reason: 'no-admissible-issue' } }, 200, async () => {
			expect(await fetchChainRuns()).toEqual({ enabled: true, pause: null });
		});

		await withRecordedFetch({ ok: true, enabled: true, pause: null }, 200, async (calls) => {
			expect(await saveChainRuns(true)).toBe('Automatic run chaining enabled.');
			expect(calls).toEqual([{
				url: CHAIN_RUNS_PATH,
				method: 'PUT',
				body: JSON.stringify({ enabled: true }),
			}]);
		});
		await withRecordedFetch({ ok: true, enabled: false, pause: null }, 200, async () => {
			expect(await saveChainRuns(false)).toBe('Automatic run chaining disabled.');
		});
		await withRecordedFetch({
			ok: false,
			code: 'invalid-request',
			message: '"enabled" must be a boolean.',
		}, 400, async () => {
			expect(await saveChainRuns(true)).toBe('"enabled" must be a boolean.');
		});
	});

	// GSHIP-722: the executor handoff opt-in, read and written the same way.
	test('the executor handoff switch is read and written on one same-origin route', async () => {
		await withRecordedFetch({ enabled: true }, 200, async (calls) => {
			expect(await fetchExecutorHandoff()).toEqual({ enabled: true });
			expect(calls).toEqual([{ url: EXECUTOR_HANDOFF_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchExecutorHandoff()).toEqual(EMPTY_EXECUTOR_HANDOFF);
		});

		await withRecordedFetch({ ok: true, enabled: true }, 200, async (calls) => {
			expect(await saveExecutorHandoff(true)).toBe('Executor handoff enabled.');
			expect(calls).toEqual([{
				url: EXECUTOR_HANDOFF_PATH,
				method: 'PUT',
				body: JSON.stringify({ enabled: true }),
			}]);
		});
		await withRecordedFetch({ ok: true, enabled: false }, 200, async () => {
			expect(await saveExecutorHandoff(false)).toBe('Executor handoff disabled.');
		});
		await withRecordedFetch({
			ok: false,
			code: 'invalid-request',
			message: '"enabled" must be a boolean.',
		}, 400, async () => {
			expect(await saveExecutorHandoff(true)).toBe('"enabled" must be a boolean.');
		});
	});

	test('a refused brief surfaces the server validation message', async () => {
		await withRecordedFetch({
			ok: false,
			code: 'invalid-request',
			message: 'Objective accepts at most 2000 characters.',
		}, 400, async () => {
			expect(await saveBrief({ ...EMPTY_BRIEF, objective: 'o'.repeat(2001) }))
				.toBe('Objective accepts at most 2000 characters.');
		});
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchBrief()).rejects.toThrow('Brief responded with 500');
		});
	});

	test('reads and sends the orchestrator conversation on one same-origin route', async () => {
		const messages = [{
			seq: 1,
			providerId: 'claude' as const,
			role: 'orchestrator' as const,
			text: 'Pronto.',
			createdAt: '2026-08-16T03:00:00.000Z',
		}];
		await withRecordedFetch({ messages }, 200, async (calls) => {
			expect(await fetchChat()).toEqual(messages);
			expect(calls).toEqual([{ url: CHAT_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({ ok: true, messages }, 200, async (calls) => {
			expect(await sendChat('Continue.')).toBe('Orchestrator response received.');
			expect(calls).toEqual([{
				url: CHAT_PATH,
				method: 'POST',
				body: JSON.stringify({ message: 'Continue.' }),
			}]);
		});
	});

	test('issue intake posts the operator contract and returns the created issue', async () => {
		const draft = {
			title: 'Intake web',
			scope: 'Cria uma tarefa specified.',
			verificationCommand: 'bun test',
		};
		const calls = await withRecordedFetch(
			{ ok: true, issue: { id: 'CAM-902', title: draft.title } },
			201,
			async () => {
				expect(await createIssue(null, draft)).toEqual({ id: 'CAM-902', title: draft.title });
			},
		);

		expect(calls).toEqual([
			{ url: ISSUES_PATH, method: 'POST', body: JSON.stringify(draft) },
		]);
	});

	test('idea specification posts the operator contract to the issue-scoped route', async () => {
		const draft = {
			scope: 'Promove a ideia sem planner.',
			verificationCommand: 'bun test',
		};
		const calls = await withRecordedFetch(
			{ ok: true, issue: { id: 'CAM-42', title: 'ideia antiga' } },
			200,
			async () => {
				expect(await specifyIssue(null, 'CAM-42', draft)).toEqual({
					id: 'CAM-42',
					title: 'ideia antiga',
				});
			},
		);

		expect(calls).toEqual([{
			url: '/api/issues/CAM-42/spec',
			method: 'POST',
			body: JSON.stringify(draft),
		}]);
	});

	test('draft review and approval use only the existing issue-scoped endpoints', async () => {
		const draft = { scope: 'Escopo revisto.', verificationCommand: 'bun test focused' };
		await withRecordedFetch(
			{ ok: true, issue: { id: 'CAM-42', title: 'Draft' } },
			200,
			async (calls) => {
				await specifyIssue(null, 'CAM-42', draft);
				expect(calls).toEqual([{ url: '/api/issues/CAM-42/spec', method: 'POST', body: JSON.stringify(draft) }]);
			},
		);
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await approveIssue(null, 'CAM-42')).toBe('Run updated.');
			expect(calls).toEqual([{ url: '/api/issues/CAM-42/approve', method: 'POST', body: null }]);
		});
	});

	test('abandoning an issue uses the same trusted origin route with its justification', async () => {
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await abandonIssue(null, 'CAM-42', 'Não faz mais sentido.')).toBe('Run updated.');
			expect(calls).toEqual([{
				url: '/api/issues/CAM-42/abandon',
				method: 'POST',
				body: JSON.stringify({ reason: 'Não faz mais sentido.' }),
			}]);
		});
	});

	test('reads persisted activity for one run', async () => {
		const events = [{
			seq: 9,
			runId: 'run-1',
			kind: 'provider.activity',
			fromState: 'working' as const,
			toState: 'working' as const,
			payload: { tools: ['Read'] },
			createdAt: '2026-08-16T03:04:05.000Z',
		}];
		const calls = await withRecordedFetch({ events }, 200, async () => {
			expect(await fetchRunEvents(null, 'run-1')).toEqual(events);
		});

		expect(calls).toEqual([
			{ url: '/api/runs/run-1/events', method: 'GET', body: null },
		]);
	});

	test('reads provider status and starts Codex login on same-origin routes', async () => {
		const providers = [
			{ id: 'codex' as const, installed: true, subscription: false, label: 'Codex', login: 'web' as const },
		];
		await withRecordedFetch({ providers, selected: 'claude' }, 200, async (calls) => {
			expect(await fetchProviders()).toEqual({ providers, selected: 'claude', source: 'provider-default' });
			expect(calls).toEqual([{ url: PROVIDERS_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({
			ok: true,
			login: { loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' },
		}, 200, async (calls) => {
			expect(await startCodexLogin()).toBe('https://chatgpt.com/auth');
			expect(calls).toEqual([{
				url: `${PROVIDERS_PATH}/codex/login`,
				method: 'POST',
				body: null,
			}]);
		});
		await withRecordedFetch({ ok: true, selected: 'codex' }, 200, async (calls) => {
			expect(await selectProvider('codex')).toBe('Run updated.');
			expect(calls).toEqual([{
				url: `${PROVIDERS_PATH}/codex/select`,
				method: 'POST',
				body: null,
			}]);
		});
	});

	// GSHIP-705: the connect call resolves only on what the service actually
	// demonstrated. A token limited to inference reports no identity, and the
	// confirmation says so instead of leaving an empty account to read as one.
	test('confirms a dedicated credential by what was validated, not by an identity it may not have', async () => {
		await withRecordedFetch({ ok: true, validated: 'inference' }, 200, async (calls) => {
			const confirmation = await connectClaudeCredential('sk-ant-oat01-anonymous');
			expect(confirmation).toEqual({});
			expect(describeClaudeCredentialConfirmation(confirmation)).toBe(
				'Dedicated Claude credential validated for inference. '
				+ 'Claude reports no account, organization or plan for this token.',
			);
			expect(calls).toEqual([{
				url: `${PROVIDERS_PATH}/claude/credential`,
				method: 'PUT',
				body: JSON.stringify({ token: 'sk-ant-oat01-anonymous' }),
			}]);
		});
		await withRecordedFetch({
			ok: true,
			validated: 'inference',
			identity: { account: 'alice@example.com', plan: 'max' },
		}, 200, async () => {
			expect(describeClaudeCredentialConfirmation(
				await connectClaudeCredential('sk-ant-oat01-named'),
			)).toBe('Dedicated Claude credential validated for inference: alice@example.com · max.');
		});
	});

	// A refusal carries the service's own words to the field the operator has
	// to correct, and never reports a connection that did not happen.
	test('rejects a refused token with the service\'s own message', async () => {
		await withRecordedFetch({ ok: false, code: 'invalid-token', message: 'OAuth token revoked.' }, 422, async () => {
			await expect(connectClaudeCredential('sk-ant-oat01-revoked')).rejects.toThrow('OAuth token revoked.');
		});
	});

	// GSHIP-652, GSHIP-653: the read is a boolean plus named missing values per
	// channel, and the client's own type (`configured: boolean`, `missing:
	// string[]`) makes it structurally impossible to carry a secret through
	// even if a future server bug tried to include one.
	test('reads notification channel status and fires a real test on its own routes', async () => {
		await withRecordedFetch(
			{ channels: { ntfy: { configured: true }, resend: { configured: false, missing: ['API key'] } } },
			200,
			async (calls) => {
				expect(await fetchNotificationChannels()).toEqual({
					ntfy: { ...EMPTY_NOTIFICATION_CHANNELS.ntfy, configured: true },
					resend: { ...EMPTY_NOTIFICATION_CHANNELS.resend, missing: ['API key'] },
				});
				expect(calls).toEqual([{ url: NOTIFICATIONS_PATH, method: 'GET', body: null }]);
			},
		);
		// A payload missing a channel, or a field, reads as not configured.
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchNotificationChannels()).toEqual(EMPTY_NOTIFICATION_CHANNELS);
		});
		await withRecordedFetch(
			{ ok: true, outcome: 'sent', message: 'Mensagem de teste entregue ao ntfy.' },
			200,
			async (calls) => {
				expect(await sendNotificationTest('ntfy'))
					.toBe('Mensagem de teste entregue ao ntfy.');
				expect(calls).toEqual([{
					url: `${NOTIFICATIONS_PATH}/ntfy/test`,
					method: 'POST',
					body: null,
				}]);
			},
		);
		await withRecordedFetch(
			{ ok: false, code: 'not-configured', message: 'Channel ntfy is not configured.' },
			409,
			async () => {
				expect(await sendNotificationTest('ntfy'))
					.toBe('Channel ntfy is not configured.');
			},
		);
		await withRecordedFetch(
			{ ok: true, outcome: 'sent', message: 'Mensagem de teste entregue por email.' },
			200,
			async (calls) => {
				expect(await sendNotificationTest('resend'))
					.toBe('Mensagem de teste entregue por email.');
				expect(calls).toEqual([{
					url: `${NOTIFICATIONS_PATH}/resend/test`,
					method: 'POST',
					body: null,
				}]);
			},
		);
		await withRecordedFetch({ ok: true, message: 'Resend settings saved.' }, 200, async (calls) => {
			expect(await saveResendSettings({
				from: 'Gateship <ops@example.com>',
				to: 'operator@example.com',
				apiKey: '',
			})).toBe('Resend settings saved.');
			expect(calls).toEqual([{
				url: `${NOTIFICATIONS_PATH}/resend`,
				method: 'PUT',
				body: JSON.stringify({ from: 'Gateship <ops@example.com>', to: 'operator@example.com', apiKey: '' }),
			}]);
		});
		await withRecordedFetch({ ok: true, message: 'File-backed Resend credential removed.' }, 200, async (calls) => {
			expect(await removeResendCredential()).toBe('File-backed Resend credential removed.');
			expect(calls).toEqual([{
				url: `${NOTIFICATIONS_PATH}/resend/credential`,
				method: 'DELETE',
				body: null,
			}]);
		});
	});

	test('start posts the issue id to the runs route', async () => {
		const calls = await withRecordedFetch({ ok: true }, 202, async () => {
			expect(await startRun(null, 'CAM-900')).toBe('Run updated.');
		});

		expect(calls).toEqual([
			{ url: '/api/runs', method: 'POST', body: JSON.stringify({ issueId: 'CAM-900' }) },
		]);
	});

	// GSHIP-712: every Work write derives its route from the selected project,
	// so none of them can reach the boot runtime while another project is named.
	test('every work action addresses the selected project, never the boot routes', async () => {
		const draft = { title: 'Intake escopado', scope: 'Escopo.', verificationCommand: 'bun test' };
		const spec = { scope: 'Escopo revisto.', verificationCommand: 'bun test focused' };
		const calls = await withRecordedFetch(
			{ ok: true, issue: { id: 'CAM-902', title: draft.title } },
			200,
			async () => {
				await createIssue('project other', draft);
				await specifyIssue('project other', 'CAM 42', spec);
				await approveIssue('project other', 'CAM 42');
				await abandonIssue('project other', 'CAM 42', 'Sem sentido.');
				await startRun('project other', 'CAM-900');
			},
		);

		expect(calls).toEqual([
			{ url: '/api/projects/project%20other/issues', method: 'POST', body: JSON.stringify(draft) },
			{ url: '/api/projects/project%20other/issues/CAM%2042/spec', method: 'POST', body: JSON.stringify(spec) },
			{ url: '/api/projects/project%20other/issues/CAM%2042/approve', method: 'POST', body: null },
			{
				url: '/api/projects/project%20other/issues/CAM%2042/abandon',
				method: 'POST',
				body: JSON.stringify({ reason: 'Sem sentido.' }),
			},
			{
				url: '/api/projects/project%20other/runs',
				method: 'POST',
				body: JSON.stringify({ issueId: 'CAM-900' }),
			},
		]);
		for (const call of calls) {
			expect(call.url.startsWith(ISSUES_PATH)).toBe(false);
			expect(call.url.startsWith(RUNS_PATH)).toBe(false);
		}
	});

	test('each command posts to its own run-scoped route', async () => {
		const calls = await withRecordedFetch({ ok: true }, 202, async () => {
			await commandRun(null, 'run-1', 'resume');
			await commandRun(null, 'run-1', 'abandon');
			await commandRun(null, 'run-1', 'cancel');
			await commandRun(null, 'run-1', 'ship');
		});

		expect(calls.map((call) => call.url)).toEqual([
			'/api/runs/run-1/resume',
			'/api/runs/run-1/abandon',
			'/api/runs/run-1/cancel',
			'/api/runs/run-1/ship',
		]);
		expect(calls.every((call) => call.method === 'POST' && call.body === null)).toBe(true);
	});

	test('resume sends operator guidance only when one was supplied', async () => {
		const calls = await withRecordedFetch({ ok: true }, 202, async () => {
			await commandRun(null, 'run-1', 'resume', 'Use the smaller seam.');
		});

		expect(calls).toEqual([{
			url: '/api/runs/run-1/resume',
			method: 'POST',
			body: JSON.stringify({ message: 'Use the smaller seam.' }),
		}]);
	});

	test('a refused command surfaces the server message instead of a generic failure', async () => {
		await withRecordedFetch({ ok: false, message: 'Run not found.' }, 404, async () => {
			expect(await commandRun(null, 'run-x', 'ship')).toBe('Run not found.');
		});
	});

	test('reads keep the whole run list and tolerate a cycle-in-progress snapshot', async () => {
		const history = [
			runIn('working', { id: 'run-3' }),
			runIn('done', { id: 'run-2' }),
			runIn('failed', { id: 'run-1' }),
		];
		// One read per refresh: the newest run and the history come from it.
		await withRecordedFetch({ runs: history }, 200, async (calls) => {
			expect(await fetchRuns(null)).toEqual(history);
			expect(calls).toEqual([{ url: RUNS_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({ runs: [] }, 200, async () => {
			expect(await fetchRuns(null)).toEqual([]);
		});
		// No idleState key at all: a cycle is running, so nothing is plannable.
		await withRecordedFetch({ phase: 'implementing' }, 200, async () => {
				expect(await fetchBacklog(null)).toEqual({
					plannable: [],
					ideas: [],
					drafts: [],
				workspaceNotices: [],
				staleService: null,
				gitIdentity: null,
				version: '',
			});
		});
		await withRecordedFetch({
			idleState: { backlog: { plannable: BACKLOG, byStage: { idea: [BACKLOG[0]!] } } },
			version: '0.292.0',
		}, 200, async () => {
				expect(await fetchBacklog(null)).toEqual({
					plannable: BACKLOG,
					ideas: [BACKLOG[0]!],
					drafts: [],
				workspaceNotices: [],
				staleService: null,
				gitIdentity: null,
				version: '0.292.0',
			});
		});
	});

	test('the outdated-service notice is read from its own snapshot field', async () => {
		const staleService = {
			bootSha: '1'.repeat(40),
			currentSha: '2'.repeat(40),
			detail: 'Restart the service para aplicar o que entrou depois do boot.',
		};
		await withRecordedFetch({ staleService }, 200, async (calls) => {
			expect((await fetchBacklog(null)).staleService).toEqual(staleService);
			expect(calls).toEqual([{ url: SNAPSHOT_PATH, method: 'GET', body: null }]);
		});
		// The absent field is the ordinary case, and a notice missing a sha is not
		// a divergence the screen is willing to announce.
		await withRecordedFetch({ workspaceNotices: [] }, 200, async () => {
			expect((await fetchBacklog(null)).staleService).toBeNull();
		});
		await withRecordedFetch({ staleService: { bootSha: '1'.repeat(40) } }, 200, async () => {
			expect((await fetchBacklog(null)).staleService).toBeNull();
		});
	});

	test('the missing git identity notice is read from its own snapshot field (GSHIP-654)', async () => {
		const gitIdentity = { detail: 'no git author identity is configured' };
		await withRecordedFetch({ gitIdentity }, 200, async (calls) => {
			expect((await fetchBacklog(null)).gitIdentity).toEqual(gitIdentity);
			expect(calls).toEqual([{ url: SNAPSHOT_PATH, method: 'GET', body: null }]);
		});
		// The absent field is the ordinary case: an identity is configured.
		await withRecordedFetch({ workspaceNotices: [] }, 200, async () => {
			expect((await fetchBacklog(null)).gitIdentity).toBeNull();
		});
		// A notice missing its detail is not one the screen is willing to show.
		await withRecordedFetch({ gitIdentity: {} }, 200, async () => {
			expect((await fetchBacklog(null)).gitIdentity).toBeNull();
		});
	});

	test('diagnostics use their own read, execution and human-decision routes', async () => {
		await withRecordedFetch({ analyzers: [{ id: 'react', label: 'React', version: '0.9.12', description: 'React' }] }, 200, async (calls) => {
			expect((await fetchDiagnostics()).analyzers[0]?.id).toBe('react');
			expect(calls).toEqual([{ url: DIAGNOSTICS_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({ ok: true }, 202, async (calls) => {
			expect(await startDiagnostic('react')).toContain('isolated checkout');
			expect(calls).toEqual([{
				url: DIAGNOSTICS_PATH,
				method: 'POST',
				body: JSON.stringify({ analyzer: 'react' }),
			}]);
		});
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await cancelDiagnostic('scan / 1')).toBe('Diagnostic cancelled.');
			expect(calls[0]?.url).toBe(`${DIAGNOSTICS_PATH}/scan%20%2F%201/cancel`);
		});
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await dismissDiagnosticFinding('finding / 1')).toContain('dismissed');
			expect(calls[0]?.url).toBe(`${DIAGNOSTIC_FINDINGS_PATH}/finding%20%2F%201/dismiss`);
		});
		const issueDraft = {
			title: 'Promote diagnostic',
			scope: 'Fix the verified defect.',
			verificationCommand: 'bun test',
		};
		await withRecordedFetch({ issue: { id: 'GSHIP-900', title: issueDraft.title } }, 200, async (calls) => {
			expect((await promoteDiagnosticFinding('finding-2', issueDraft)).id).toBe('GSHIP-900');
			expect(calls).toEqual([{
				url: `${DIAGNOSTIC_FINDINGS_PATH}/finding-2/promote`,
				method: 'POST',
				body: JSON.stringify(issueDraft),
			}]);
		});
		await withRecordedFetch({ ok: true, outcome: 'started' }, 200, async (calls) => {
			expect(await saveDiagnosticSchedule(true, 'daily', 'project current')).toContain('overdue diagnostic started');
			expect(calls).toEqual([{
				url: '/api/projects/project%20current/diagnostics/schedule',
				method: 'PUT',
				body: JSON.stringify({ enabled: true, cadence: 'daily' }),
			}]);
		});
		await withRecordedFetch({ ok: false, message: 'cadência recusada' }, 400, async () => {
			await expect(saveDiagnosticSchedule(true, 'weekly')).rejects.toThrow('cadência recusada');
		});
	});

	test('a failed read is reported as a transport error, not as empty data', async () => {
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchRuns(null)).rejects.toThrow('Runs responded with 500');
			await expect(fetchBacklog(null)).rejects.toThrow('Snapshot responded with 500');
		});
	});
});
