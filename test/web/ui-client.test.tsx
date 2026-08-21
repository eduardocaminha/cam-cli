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
	type AppProps,
	ConversationColumn,
	type OperatorRoute,
	routeOf,
} from '../../webui/src/App.tsx';
import {
	abandonIssue,
	aggregateChatTurnCosts,
	approveIssue,
	BRIEF_PATH,
	CHAIN_RUNS_PATH,
	CHAT_PATH,
	type ChainPauseReason,
	type ChainPauseView,
	type ChainRunsView,
	cancelDiagnostic,
	commandRun,
	createIssue,
	DIAGNOSTIC_FINDINGS_PATH,
	DIAGNOSTIC_SCHEDULE_PATH,
	DIAGNOSTICS_PATH,
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
	ISSUES_PATH,
	MODEL_SETTINGS_PATH,
	type ModelSettingsView,
	NOTIFICATIONS_PATH,
	type NotificationChannelsView,
	OPERATOR_PROFILE_PATH,
	type OperatorProfileView,
	PROJECT_PATH,
	PROPOSALS_PATH,
	PROVIDERS_PATH,
	type ProjectBriefView,
	type ProjectStatusView,
	type ProviderStatusView,
	promoteDiagnosticFinding,
	promoteProposal,
	RESOLVED_PROPOSALS_PATH,
	type ResolvedProposalView,
	RUNS_PATH,
	SNAPSHOT_PATH,
	saveBrief,
	saveChainRuns,
	saveDiagnosticSchedule,
	saveModelSettings,
	saveOperatorProfile,
	saveSelfUpdate,
	selectProvider,
	sendChat,
	sendNotificationTest,
	specifyIssue,
	startCodexLogin,
	startDiagnostic,
	startRun,
	UPDATE_PATH,
} from '../../webui/src/client.ts';
import {
	createLiveEdgeController,
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

const SURFACE_PATHS: readonly OperatorRoute[] = ['/', '/runs', '/work', '/settings'];

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

const EMPTY_OPERATOR_PROFILE: OperatorProfileView = { name: '', timezone: '' };

function renderAt(route: OperatorRoute, overrides: Partial<AppProps> = {}): string {
	return renderToStaticMarkup(
		<App
			backlog={BACKLOG}
			chainRuns={EMPTY_CHAIN_RUNS}
			diagnostics={emptyDiagnostics()}
			drafts={[]}
			brief={EMPTY_BRIEF}
			chatMessages={[]}
			events={[]}
			gitIdentity={null}
			handoff={EMPTY_BRIEF}
			ideas={[]}
			locale={DEFAULT_LOCALE}
			modelSettings={EMPTY_MODEL_SETTINGS}
			selfUpdate={emptySelfUpdate()}
			notificationChannels={EMPTY_NOTIFICATION_CHANNELS}
			notificationPermission="default"
			onSaveOperatorProfile={() => {}}
			onAbandon={() => {}}
			onCancel={() => {}}
			onConnectCodex={() => {}}
			onCreateIssue={() => {}}
			onApproveIssue={() => {}}
			onAbandonIssue={() => {}}
			onDismissProposal={() => {}}
			onDismissDiagnosticFinding={() => {}}
			onEnableNotifications={() => {}}
			onSendNotificationTest={() => {}}
			onPromoteProposal={() => {}}
			onPromoteDiagnosticFinding={() => {}}
			onResume={() => {}}
			onSaveBrief={() => {}}
			onSaveDiagnosticSchedule={() => {}}
			onSaveModelSettings={() => {}}
			onSetChainRuns={() => {}}
			onSetSelfUpdate={() => {}}
			onSelectIssue={() => {}}
			onSelectLocale={() => {}}
			onSelectProvider={() => {}}
			onSendMessage={() => {}}
			onShip={() => {}}
			onSpecifyIssue={() => {}}
			onReviewIssue={() => {}}
			onStart={() => {}}
			onStartDiagnostic={() => {}}
			onCancelDiagnostic={() => {}}
			pending={false}
			proposals={[]}
			project={READY_PROJECT}
			operatorProfile={EMPTY_OPERATOR_PROFILE}
			providers={[]}
			resolvedProposals={[]}
			resolvedProposalsOmittedCount={0}
			route={route}
			runs={[]}
			selectedIssueId={null}
			selectedProvider="claude"
			staleService={null}
			status={null}
			suggestedTimezone="America/Sao_Paulo"
			version=""
			workspaceNotices={[]}
			{...overrides}
		/>,
	);
}

const home = (overrides: Partial<AppProps> = {}): string => renderAt('/', overrides);
const runsPage = (overrides: Partial<AppProps> = {}): string => renderAt('/runs', overrides);
const workPage = (overrides: Partial<AppProps> = {}): string => renderAt('/work', overrides);
const settingsPage = (overrides: Partial<AppProps> = {}): string => renderAt('/settings', overrides);

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
				expect(html).toContain(`href="/settings">${expected.settingsLabel}</a>`);
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
					expect(html).toContain(`href="/settings">${expected.settingsLabel}</a>`);
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
			expect(empty).toContain(`aria-label="${expected.transcript}"`);
			expect(empty).toContain(expected.empty);
			expect(empty).toContain(expected.title);
			expect(empty).toContain(expected.description);

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
		expect(html).toContain('href="/runs"');
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

		expect(html).toContain('Conversation with the orchestrator');
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
		}
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
		expect(html).toContain(`Custo esperado: ${formattedCost}`);
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
		expect(card).not.toContain('Evidence checked in the run workspace');
	});

	// GSHIP-629: the spec's executable premise is shown beside the scope and the
	// verification command it sits next to, read-only -- this panel edits the
	// scope and the command, never the recorded evidence.
	test('shows the evidence checked in the run workspace beside the scope and the verification command', () => {
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

		expect(card).toContain('Evidence checked in the run workspace');
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
			notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, ntfy: { configured: true, missing: [] } },
			handoff: EMPTY_BRIEF,
		};
		const english = settingsPage({ ...overrides, locale: 'en-US' });
		const portuguese = settingsPage({ ...overrides, locale: 'pt-BR' });

		for (const [html, labels] of [
			[english, ['Settings', 'Project', 'Operator', 'Local agents', 'Model and effort by role', 'Automatic run chaining', 'Gateship updates', 'Diagnostic schedule', 'Notifications', 'Project brief', 'Automatic handoff', 'Save profile', 'Save models', 'Save schedule', 'Save brief', 'Disabled.', 'Nothing recorded yet.', 'open', 'close']],
			[portuguese, ['Ajustes', 'Projeto', 'Operador', 'Agentes locais', 'Modelo e esforço por função', 'Encadeamento automático de execuções', 'Atualizações do Gateship', 'Agenda de diagnósticos', 'Notificações', 'Brief do projeto', 'Handoff automático', 'Salvar perfil', 'Salvar modelos', 'Salvar agenda', 'Salvar brief', 'Desativada.', 'Nada registrado ainda.', 'abrir', 'fechar']],
		] as const) {
			for (const label of labels) expect(html).toContain(label);
			for (const factual of ['acme/gateship', 'origin/main', 'Eduardo', 'America/Sao_Paulo', 'Codex factual', 'team-plan', 'gpt-factual', 'xhigh', 'react', 'Objetivo escrito pelo operador.', 'Keep authored text.']) {
				expect(html).toContain(factual);
			}
		}
		expect(english).toContain('78% used');
		expect(portuguese).toContain('78% usados');
		expect(english).toContain('2,000 reset credit(s) available');
		expect(portuguese).toContain('2.000 créditos de reinício disponíveis');
		const observed = new Date('2026-08-20T09:05:00.000Z');
		expect(english).toContain(observed.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }));
		expect(portuguese).toContain(observed.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }));
		expect(english).toContain('ntfy: configured');
		expect(portuguese).toContain('ntfy: configurado');
		expect(buttonIsEnabled(english, 'Send test')).toBe(true);
		expect(buttonIsEnabled(portuguese, 'Enviar teste')).toBe(true);
		expect(portuguese).not.toContain('Settings');
	});

	test('edits the operator identity and suggests browser timezone without silently saving it', () => {
		const empty = panel(settingsPage(), 'Operator');
		expect(empty).toContain('name="operator-name"');
		expect(empty).toContain('name="operator-timezone"');
		expect(empty).toContain('value="America/Sao_Paulo"');
		expect(empty).toContain('is saved only when you confirm');
		expect(buttonIsEnabled(empty, 'Save profile')).toBe(true);

		const stored = panel(settingsPage({
			operatorProfile: { name: 'Eduardo', timezone: 'Europe/Lisbon' },
		}), 'Operator');
		expect(stored).toContain('value="Eduardo"');
		expect(stored).toContain('value="Europe/Lisbon"');
		expect(stored).not.toContain('value="America/Sao_Paulo"');
		expect(buttonIsEnabled(settingsPage({ pending: true }), 'Save profile')).toBe(false);
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
		expect(providers).not.toMatch(/api key|oauth token/i);
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
		expect(buttonIsEnabled(settingsPage(), 'Enable notifications')).toBe(true);

		const granted = settingsPage({ notificationPermission: 'granted' });
		expect(granted).toContain('Active in this browser.');
		expect(buttonIsEnabled(granted, 'Notifications active')).toBe(false);
		expect(granted).not.toContain('type="password"');
		expect(settingsPage({ notificationPermission: 'denied' })).toContain('Notifications blocked');
	});

	// GSHIP-652: the remote ntfy channel shows only whether it is configured,
	// a real test-send action, and setup instructions -- never the secret,
	// which the read-only `configured` boolean makes structurally impossible.
	test('the ntfy channel shows its configured state, a test action, and setup instructions, never a secret', () => {
		const unconfigured = panel(settingsPage(), 'Notifications');
		expect(unconfigured).toContain('ntfy: not configured');
		expect(buttonIsEnabled(unconfigured, 'Send test')).toBe(false);
		expect(unconfigured).toContain('.gship/ntfy-url');
		expect(unconfigured).toContain('mode 600');
		expect(unconfigured).toContain('GATESHIP_NTFY_URL');
		const docLink = openingTags(unconfigured).find((tag) => tag.includes('docs.ntfy.sh'));
		expect(docLink).toBeDefined();
		expect(docLink).toContain('<a');
		expect(docLink).toContain('target="_blank"');
		expect(docLink).toContain('rel="noreferrer noopener"');

		const configured = panel(
			settingsPage({
				notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, ntfy: { configured: true, missing: [] } },
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
			settingsPage({
				notificationChannels: {
					...EMPTY_NOTIFICATION_CHANNELS,
					resend: { configured: false, missing: ['API key', 'recipient'] },
				},
			}),
			'Notifications',
		);
		expect(partial).toContain('email (Resend): not configured (missing: API key, recipient)');
		expect(buttonIsEnabled(channelRow(partial, 'email (Resend)'), 'Send test')).toBe(false);
		expect(partial).toContain('.gship/resend-api-key');
		expect(partial).toContain('mode 600');
		expect(partial).toContain('GATESHIP_RESEND_API_KEY');
		expect(partial).toContain('GATESHIP_RESEND_FROM');
		expect(partial).toContain('GATESHIP_RESEND_TO');

		const apiKeysLink = openingTags(partial).find((tag) => tag.includes('resend.com/api-keys'));
		const domainsLink = openingTags(partial).find((tag) => tag.includes('resend.com/domains'));
		expect(apiKeysLink).toBeDefined();
		expect(domainsLink).toBeDefined();
		expect(apiKeysLink).toContain('target="_blank"');
		expect(domainsLink).toContain('rel="noreferrer noopener"');

		const configured = panel(
			settingsPage({
				notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, resend: { configured: true, missing: [] } },
			}),
			'Notifications',
		);
		expect(configured).toContain('email (Resend): configured');
		expect(configured).not.toContain('falta:');
		expect(buttonIsEnabled(channelRow(configured, 'email (Resend)'), 'Send test')).toBe(true);
	});

	test('the remote channel test action is held while a command is in flight, like every other', () => {
		const html = panel(
			settingsPage({
				notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, ntfy: { configured: true, missing: [] } },
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

	test('native self update is off by default with one fixed daily policy', () => {
		const updates = panel(settingsPage({
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
		const updates = panel(settingsPage({
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

	test('the diagnostic schedule is bounded, off by default and closed by default', () => {
		const html = settingsPage();
		const schedule = panel(html, 'Diagnostic schedule');

		expect(panelIsOpen(html, 'Diagnostic schedule')).toBe(false);
		expect(schedule).toContain('at most one overdue diagnostic');
		expect(schedule).toContain('name="diagnostic-schedule-enabled"');
		expect(schedule).not.toContain('checked=""');
		expect(schedule).toContain('<option value="weekly" selected="">Weekly</option>');
		expect(schedule).toContain('Missed periods do not create catch-up runs.');
		expect(schedule).not.toMatch(/cron/i);
		expect(buttonIsEnabled(schedule, 'Save schedule')).toBe(true);
	});

	test('the diagnostic schedule shows its due state and holds every control during a command', () => {
		const diagnostics = emptyDiagnostics();
		diagnostics.schedule = {
			enabled: true,
			analyzer: 'react',
			cadence: 'daily',
			lastScanAt: '2026-08-19T12:00:00.000Z',
			nextRunAt: '2026-08-20T12:00:00.000Z',
			overdue: true,
		};
		const due = panel(settingsPage({ diagnostics }), 'Diagnostic schedule');
		expect(due).toContain('checked=""');
		expect(due).toContain('<option value="daily" selected="">Daily</option>');
		expect(due).toContain('overdue');

		const held = panel(settingsPage({ diagnostics, pending: true }), 'Diagnostic schedule');
		expect(elementWith(held, 'name="diagnostic-schedule-enabled"')).toContain('disabled=""');
		expect(elementWith(held, 'name="diagnostic-schedule-cadence"')).toContain('disabled=""');
		expect(buttonIsEnabled(held, 'Save schedule')).toBe(false);
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

describe('operator shell', () => {
	test('the persistent language control renders both self-named choices and marks the locale on every surface', () => {
		for (const locale of ['en-US', 'pt-BR'] as const) {
			for (const route of SURFACE_PATHS) {
				const header = shellHeader(renderAt(route, { locale }));
				const select = header.slice(header.indexOf('<select'), header.indexOf('</select>'));

				expect(header).toContain(locale === 'en-US' ? '>Language</span>' : '>Idioma</span>');
				expect(select).toContain('id="gateship-locale"');
				expect(select).toContain('<option value="en-US"');
				expect(select).toContain('>English (US)</option>');
				expect(select).toContain('<option value="pt-BR"');
				expect(select).toContain('>Português (Brasil)</option>');
				expect(select).toContain(`<option value="${locale}" selected="">`);
			}
		}
	});

	test('the language control remains available while onboarding blocks the route surface', () => {
		const project: ProjectStatusView = { state: 'empty', name: 'workspace', detail: 'not ready' };
		for (const route of ['/', '/runs', '/work'] as const) {
			const html = renderAt(route, { project });
			expect(html).toContain('Connect a GitHub project');
			expect(shellHeader(html)).toContain('id="gateship-locale"');
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

	test('navigation is four real paths, with the active one marked', () => {
		for (const route of SURFACE_PATHS) {
			const html = renderAt(route);
			const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
			const active = openingTags(nav).find((tag) => tag.includes(`href="${route}"`));

			expect(nav).toContain('aria-label="Operator surfaces"');
			for (const label of ['Conversation', 'Runs', 'Work', 'Settings']) {
				expect(nav).toContain(`>${label}</a>`);
			}
			for (const path of SURFACE_PATHS) expect(nav).toContain(`href="${path}"`);
			expect(active).toContain('aria-current="page"');
			expect(nav.split('aria-current="page"')).toHaveLength(2);
			// Navigation itself stays on served paths. The shell-level skip link is
			// the one deliberate in-page anchor.
			expect(nav).not.toContain('href="#');
		}
	});

	test('an explicit pt-BR locale translates the shell, shared inspector and operational runs panels', () => {
		const html = runsPage({ locale: 'pt-BR' });
		const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));

		expect(nav).toContain('aria-label="Superfícies do operador"');
		for (const label of ['Conversa', 'Runs', 'Trabalho', 'Ajustes']) {
			expect(nav).toContain(`>${label}</a>`);
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

	test('an unserved path reads as the conversation surface', () => {
		expect(routeOf('/')).toBe('/');
		expect(routeOf('/runs')).toBe('/runs');
		expect(routeOf('/runs/')).toBe('/runs');
		expect(routeOf('/work')).toBe('/work');
		expect(routeOf('/settings')).toBe('/settings');
		expect(routeOf('/runs/run-1')).toBe('/');
		expect(routeOf('/qualquer-coisa')).toBe('/');
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
		// The badge moved off the title's row, so its longest label is never
		// squeezed for space.
		expect(html).toContain('>Needs you<');
		expect(html).toContain('>v0.292.0<');
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
	// chain-disabled: that reason is covered separately below, since it never
	// escalates.
	test('a stopped chain queue with no resolvable issue is still reported by its reason alone', () => {
		const labels: Record<Exclude<ChainPauseReason, 'chain-disabled'>, string> = {
			'previous-run-not-done': 'the previous run did not finish in done.',
			'no-admissible-issue': 'there are no admissible issues in the backlog right now.',
			'run-active': 'a run is still active.',
			'chain-start-failed': 'the attempt to start the next run failed.',
		};
		for (const [reason, label] of Object.entries(labels)) {
			const pause = { reason: reason as ChainPauseReason, createdAt: '2026-08-18T00:00:00.000Z' };
			const header = shellHeader(settingsPage({ chainRuns: { enabled: true, pause } }));
			expect(header).toContain('Needs you');
			expect(header).toContain(`Queue stopped`);
			expect(header).toContain(label);
			expect(header).not.toContain('GSHIP');
		}
	});

	// GSHIP-650 review: chaining is off by default (GSHIP-638), so
	// chain-disabled is every default install's steady state, not a stopped
	// queue -- escalating it would read "Needs you" with a warning
	// callout forever, on every surface, for an install that never turned
	// chaining on.
	test('the switch simply being off never escalates the header or shows the callout', () => {
		const pause: ChainPauseView = { reason: 'chain-disabled', createdAt: '2026-08-18T00:00:00.000Z' };
		const header = shellHeader(settingsPage({ chainRuns: { enabled: false, pause } }));

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

		const on = shellHeader(settingsPage({ chainRuns: { enabled: true, pause } }));
		expect(on).toContain('Needs you');
		expect(on).toContain('Queue stopped');

		const off = shellHeader(settingsPage({ chainRuns: { enabled: false, pause } }));
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

	test('no surface scrolls horizontally except the shell navigation', () => {
		for (const route of SURFACE_PATHS) {
			const html = renderLongContent(route);
			const horizontal = openingTags(html).filter((tag) => tag.includes('overflow-x-auto'));

			expect(horizontal).toHaveLength(1);
			expect(html.indexOf('overflow-x-auto')).toBeGreaterThan(html.indexOf('<nav'));
			expect(html.indexOf('overflow-x-auto')).toBeLessThan(html.indexOf('</nav>'));
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
				expect(await createIssue(draft)).toEqual({ id: 'CAM-902', title: draft.title });
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
				expect(await specifyIssue('CAM-42', draft)).toEqual({
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
				await specifyIssue('CAM-42', draft);
				expect(calls).toEqual([{ url: '/api/issues/CAM-42/spec', method: 'POST', body: JSON.stringify(draft) }]);
			},
		);
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await approveIssue('CAM-42')).toBe('Run updated.');
			expect(calls).toEqual([{ url: '/api/issues/CAM-42/approve', method: 'POST', body: null }]);
		});
	});

	test('abandoning an issue uses the same trusted origin route with its justification', async () => {
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await abandonIssue('CAM-42', 'Não faz mais sentido.')).toBe('Run updated.');
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
			expect(await fetchRunEvents('run-1')).toEqual(events);
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
			expect(await fetchProviders()).toEqual({ providers, selected: 'claude' });
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
					ntfy: { configured: true, missing: [] },
					resend: { configured: false, missing: ['API key'] },
				});
				expect(calls).toEqual([{ url: NOTIFICATIONS_PATH, method: 'GET', body: null }]);
			},
		);
		// A payload missing a channel, or a field, reads as not configured.
		await withRecordedFetch({}, 200, async () => {
			expect(await fetchNotificationChannels()).toEqual({
				ntfy: { configured: false, missing: [] },
				resend: { configured: false, missing: [] },
			});
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
	});

	test('start posts the issue id to the runs route', async () => {
		const calls = await withRecordedFetch({ ok: true }, 202, async () => {
			expect(await startRun('CAM-900')).toBe('Run updated.');
		});

		expect(calls).toEqual([
			{ url: '/api/runs', method: 'POST', body: JSON.stringify({ issueId: 'CAM-900' }) },
		]);
	});

	test('each command posts to its own run-scoped route', async () => {
		const calls = await withRecordedFetch({ ok: true }, 202, async () => {
			await commandRun('run-1', 'resume');
			await commandRun('run-1', 'abandon');
			await commandRun('run-1', 'cancel');
			await commandRun('run-1', 'ship');
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
			await commandRun('run-1', 'resume', 'Use the smaller seam.');
		});

		expect(calls).toEqual([{
			url: '/api/runs/run-1/resume',
			method: 'POST',
			body: JSON.stringify({ message: 'Use the smaller seam.' }),
		}]);
	});

	test('a refused command surfaces the server message instead of a generic failure', async () => {
		await withRecordedFetch({ ok: false, message: 'Run not found.' }, 404, async () => {
			expect(await commandRun('run-x', 'ship')).toBe('Run not found.');
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
			expect(await fetchRuns()).toEqual(history);
			expect(calls).toEqual([{ url: RUNS_PATH, method: 'GET', body: null }]);
		});
		await withRecordedFetch({ runs: [] }, 200, async () => {
			expect(await fetchRuns()).toEqual([]);
		});
		// No idleState key at all: a cycle is running, so nothing is plannable.
		await withRecordedFetch({ phase: 'implementing' }, 200, async () => {
				expect(await fetchBacklog()).toEqual({
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
				expect(await fetchBacklog()).toEqual({
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
			expect((await fetchBacklog()).staleService).toEqual(staleService);
			expect(calls).toEqual([{ url: SNAPSHOT_PATH, method: 'GET', body: null }]);
		});
		// The absent field is the ordinary case, and a notice missing a sha is not
		// a divergence the screen is willing to announce.
		await withRecordedFetch({ workspaceNotices: [] }, 200, async () => {
			expect((await fetchBacklog()).staleService).toBeNull();
		});
		await withRecordedFetch({ staleService: { bootSha: '1'.repeat(40) } }, 200, async () => {
			expect((await fetchBacklog()).staleService).toBeNull();
		});
	});

	test('the missing git identity notice is read from its own snapshot field (GSHIP-654)', async () => {
		const gitIdentity = { detail: 'no git author identity is configured' };
		await withRecordedFetch({ gitIdentity }, 200, async (calls) => {
			expect((await fetchBacklog()).gitIdentity).toEqual(gitIdentity);
			expect(calls).toEqual([{ url: SNAPSHOT_PATH, method: 'GET', body: null }]);
		});
		// The absent field is the ordinary case: an identity is configured.
		await withRecordedFetch({ workspaceNotices: [] }, 200, async () => {
			expect((await fetchBacklog()).gitIdentity).toBeNull();
		});
		// A notice missing its detail is not one the screen is willing to show.
		await withRecordedFetch({ gitIdentity: {} }, 200, async () => {
			expect((await fetchBacklog()).gitIdentity).toBeNull();
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
			expect(await saveDiagnosticSchedule(true, 'daily')).toContain('overdue diagnostic started');
			expect(calls).toEqual([{
				url: DIAGNOSTIC_SCHEDULE_PATH,
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
			await expect(fetchRuns()).rejects.toThrow('Runs responded with 500');
			await expect(fetchBacklog()).rejects.toThrow('Snapshot responded with 500');
		});
	});
});
