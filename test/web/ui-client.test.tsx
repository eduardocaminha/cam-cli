// test/web/ui-client.test.tsx
//
// The operator screen, executed once per state it can be in, through
// renderToStaticMarkup and no DOM harness (ADR-0067). What is asserted is the
// screen's decisions -- which surface carries which task, which phase it shows,
// which outcome text it shows, and which of the four commands it offers --
// never the component source text.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { App, type AppProps, type OperatorRoute, routeOf } from '../../webui/src/App.tsx';
import {
	abandonIssue,
	aggregateChatTurnCosts,
	approveIssue,
	BRIEF_PATH,
	type ChainPauseReason,
	type ChainPauseView,
	type ChainRunsView,
	CHAIN_RUNS_PATH,
	commandRun,
	createIssue,
	CHAT_PATH,
	cancelDiagnostic,
	dismissProposal,
	dismissDiagnosticFinding,
	DIAGNOSTIC_FINDINGS_PATH,
	DIAGNOSTICS_PATH,
	emptyDiagnostics,
	emptyNotificationChannels,
	EVENTS_PATH,
	fetchBacklog,
	fetchBrief,
	fetchChainRuns,
	fetchChat,
	fetchDiagnostics,
	fetchNotificationChannels,
	fetchOperatorProfile,
	fetchProposals,
	fetchProjectStatus,
	fetchProviders,
	fetchResolvedProposals,
	fetchRunEvents,
	fetchRuns,
	type NotificationChannelsView,
	NOTIFICATIONS_PATH,
	type OperatorProfileView,
	OPERATOR_PROFILE_PATH,
	type ProjectBriefView,
	type ProjectStatusView,
	PROJECT_PATH,
	MODEL_SETTINGS_PATH,
	type ModelSettingsView,
	promoteProposal,
	promoteDiagnosticFinding,
	PROPOSALS_PATH,
	RESOLVED_PROPOSALS_PATH,
	type ResolvedProposalView,
	RUNS_PATH,
	ISSUES_PATH,
	PROVIDERS_PATH,
	saveBrief,
	saveChainRuns,
	fetchModelSettings,
	saveModelSettings,
	saveOperatorProfile,
	sendNotificationTest,
	emptyModelSettings,
	selectProvider,
	sendChat,
	SNAPSHOT_PATH,
	specifyIssue,
	startCodexLogin,
	startDiagnostic,
	startRun,
} from '../../webui/src/client.ts';
import { isAtLiveEdge, LIVE_EDGE_TOLERANCE_PX } from '../../webui/src/live-edge.ts';
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
			modelSettings={EMPTY_MODEL_SETTINGS}
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
			onSaveModelSettings={() => {}}
			onSetChainRuns={() => {}}
			onSelectIssue={() => {}}
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
 * finds that row's own "Enviar teste" button -- with two channels (GSHIP-653)
 * the label is no longer unique across the whole panel, only within a row.
 */
function channelRow(html: string, label: string): string {
	const start = html.indexOf(label);
	if (start < 0) throw new Error(`channel row ${label} is not on the screen`);
	return html.slice(start);
}

describe('project onboarding', () => {
	test('an empty cwd replaces operational surfaces with two honest setup paths', () => {
		const project: ProjectStatusView = {
			state: 'empty',
			name: 'workspace',
			detail: 'Esta pasta ainda não contém um projeto Git.',
		};
		for (const route of ['/', '/runs', '/work'] as const) {
			const html = renderAt(route, { project });
			expect(html).toContain('Conecte um projeto GitHub');
			expect(html).toContain('Projeto existente');
			expect(html).toContain('Projeto novo');
			expect(html).toContain('cd /caminho/do/projeto &amp;&amp; gship');
			expect(html).toContain('gh repo create OWNER/REPO --private --add-readme --clone');
			expect(html).not.toContain('Conversa com o orquestrador');
			expect(html).not.toContain('Backlog plannable');
			expect(html).not.toContain('Último run');
		}
	});

	test('a precise prerequisite failure shows its recovery command', () => {
		const html = home({
			project: {
				state: 'needs-attention',
				name: 'product',
				reason: 'origin-main-missing',
				detail: 'A referência local origin/main ainda não existe.',
			},
		});
		expect(html).toContain('A referência local origin/main ainda não existe.');
		expect(html).toContain('git fetch origin main');
		expect(html).toContain('GATESHIP_PROJECT_DIR');
	});

	test('settings stay available and identify the derived ready project', () => {
		const ready = settingsPage();
		expect(ready).toContain('acme/gateship');
		expect(ready).toContain('origin/main');
		expect(ready).toContain('Agentes locais');

		const blocked = settingsPage({
			project: {
				state: 'needs-attention',
				name: 'product',
				reason: 'origin-missing',
				detail: 'O repositório não tem um remote chamado origin.',
			},
		});
		expect(blocked).toContain('O repositório não tem um remote chamado origin.');
		expect(blocked).toContain('Agentes locais');
		expect(blocked).not.toContain('Conecte um projeto GitHub');
	});
});

describe('conversation surface', () => {
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
		expect(html).not.toContain('Atividade');
		expect(html).not.toContain('Runs anteriores');
		expect(html).not.toContain('Workspaces preservados');
		expect(html).not.toContain('Backlog plannable');
		expect(html).not.toContain('Nova tarefa');
		expect(html).not.toContain('Especificar ideia');
		expect(html).not.toContain('Agentes locais');
		expect(html).not.toContain('Notificações locais');
	});

	test('the inspector offers the commands the run admits, and renders no others', () => {
		const idle = home();
		expect(idle).toContain('Nenhum run registrado ainda.');
		expect(idle).toContain('Ocioso');
		expect(hasButton(idle, 'Cancelar')).toBe(false);
		expect(hasButton(idle, 'Shipar')).toBe(false);
		expect(hasButton(idle, 'Retomar')).toBe(false);

		const working = home({ runs: [runIn('working')] });
		expect(working).toContain('Fase working');
		expect(buttonIsEnabled(working, 'Cancelar')).toBe(true);
		expect(hasButton(working, 'Shipar')).toBe(false);
		expect(hasButton(working, 'Retomar')).toBe(false);

		const readyToShip = home({ runs: [runIn('ready-to-ship')] });
		expect(buttonIsEnabled(readyToShip, 'Shipar')).toBe(true);
		expect(buttonIsEnabled(readyToShip, 'Cancelar')).toBe(true);

		const interrupted = home({ runs: [runIn('interrupted')] });
		expect(buttonIsEnabled(interrupted, 'Retomar')).toBe(true);
		// The interrupted run is the only one that can be ended without resuming.
		expect(buttonIsEnabled(interrupted, 'Abandonar')).toBe(true);
		expect(hasButton(working, 'Abandonar')).toBe(false);
		expect(hasButton(readyToShip, 'Abandonar')).toBe(false);

		const cancelled = home({ runs: [runIn('cancelled')] });
		expect(cancelled).toContain('cancelled');
		expect(cancelled).toContain('Ocioso');
		expect(hasButton(cancelled, 'Abandonar')).toBe(false);
		expect(hasButton(cancelled, 'Retomar')).toBe(false);
		expect(hasButton(cancelled, 'Cancelar')).toBe(false);
		expect(hasButton(cancelled, 'Shipar')).toBe(false);
	});

	test('a command in flight holds the commands that are offered', () => {
		const html = home({ pending: true, runs: [runIn('ready-to-ship')] });

		expect(buttonIsEnabled(html, 'Shipar')).toBe(false);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(false);
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

		expect(html).toContain('Conversa com o orquestrador');
		expect(html).toContain('for="orchestrator-message"');
		expect(html).toContain('>Mensagem para o orquestrador</label>');
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
		expect(html).toContain('Custo esperado acumulado');
		expect(html).toContain('2 turno(s)');
		expect(html).toContain('US$');
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
		expect(home({ chatMessages })).not.toContain('Custo esperado acumulado');
	});

	test('the run asks for its decision on the conversation surface, once', () => {
		const html = home({
			runs: [runIn('waiting-user', { summary: 'Escolha o seam de migração.' })],
		});

		expect(html).toContain('waiting-user');
		expect(html).toContain('name="operatorGuidance"');
		expect(buttonIsEnabled(html, 'Responder e retomar')).toBe(true);
		expect(html.split('Escolha o seam de migração.')).toHaveLength(2);
		// Resuming is the answer itself while the run waits, never a bare command.
		expect(hasButton(html, 'Retomar')).toBe(false);
	});

	test('a transport error is announced where the command was issued', () => {
		expect(home({ status: 'Falha ao ler /api/runs' })).toContain('Falha ao ler /api/runs');
		expect(workPage({ status: 'CAM-902 criada e selecionada.' }))
			.toContain('CAM-902 criada e selecionada.');
	});
});

describe('runs surface', () => {
	test('the detail card shows the phase and the commands the state admits', () => {
		expect(runsPage()).toContain('Nenhum run registrado ainda.');

		const working = runsPage({ runs: [runIn('working')] });
		expect(working).toContain('CAM-900');
		expect(working).toContain('Fase working');
		expect(buttonIsEnabled(working, 'Cancelar')).toBe(true);
		expect(hasButton(working, 'Shipar')).toBe(false);

		// The run is already shipping itself: the command is only the retry.
		const shipping = runsPage({ runs: [runIn('shipping')] });
		expect(shipping).toContain('Fase shipping');
		expect(hasButton(shipping, 'Shipar')).toBe(false);
		expect(buttonIsEnabled(shipping, 'Cancelar')).toBe(true);

		const done = runsPage({ runs: [runIn('done')] });
		expect(done).toContain('100%');
		expect(hasButton(done, 'Cancelar')).toBe(false);
		expect(hasButton(done, 'Shipar')).toBe(false);
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

		expect(html).toContain('Claude Code em espera');
		expect(html).toContain('Limite da assinatura atingido');
		expect(html).toContain('Claude five hour usage limit reached.');
		expect(html).toContain('dateTime="2026-08-20T12:10:00.000Z"');
		expect(buttonIsEnabled(html, 'Retomar')).toBe(true);
	});

	test('the full report and the run id are one disclosure, closed by default', () => {
		const html = runsPage({ runs: [runIn('done', { summary: 'PR #123 mergeado.' })] });

		expect(panelIsOpen(html, 'Resumo e diagnóstico')).toBe(false);
		// Closed is a rendering state, not a missing branch.
		expect(panel(html, 'Resumo e diagnóstico')).toContain('PR #123 mergeado.');
		expect(panel(html, 'Resumo e diagnóstico')).toContain('run-1');

		const failed = runsPage({ runs: [runIn('failed', { error: 'oracle reprovou a story 2' })] });
		expect(failed).toContain('failed');
		expect(panel(failed, 'Resumo e diagnóstico')).toContain('oracle reprovou a story 2');

		// The question a waiting run is asking belongs to the report as well.
		const waiting = runsPage({ runs: [runIn('waiting-user', { summary: 'Escolha o seam.' })] });
		expect(panel(waiting, 'Resumo e diagnóstico')).toContain('Escolha o seam.');

		// Nothing to report: no empty disclosure.
		expect(runsPage({ runs: [runIn('working')] })).not.toContain('Resumo e diagnóstico');
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
		expect(withCost).toContain('Custo esperado');
		expect(withCost).toContain('US$');

		// No usage event ever reported a cost for this run: the card says nothing
		// about cost rather than showing a fabricated zero.
		const withoutCost = runsPage({ runs: [runIn('done')] });
		expect(withoutCost).not.toContain('Custo esperado');
	});

	// GSHIP-659: the card shows where the run's correction rounds came from,
	// beside the cost it already shows -- no new screen, no chart. A round the
	// server could not attribute is only named when it happened.
	test('the card shows the round origins beside the cost, an indeterminate count only when it happened', () => {
		const attributed = runsPage({
			runs: [runIn('done', { roundOrigins: { executor: 2, decision: 1, indeterminate: 0 } })],
		});
		expect(attributed).toContain('Rounds de correção');
		expect(attributed).toContain('2 do executor');
		expect(attributed).toContain('1 de decisão do operador');
		expect(attributed).not.toContain('indeterminado');

		const withIndeterminate = runsPage({
			runs: [runIn('done', { roundOrigins: { executor: 0, decision: 0, indeterminate: 1 } })],
		});
		expect(withIndeterminate).toContain('1 indeterminado(s)');

		// No correction round happened at all: nothing to report, not a
		// fabricated zero line.
		const withoutRounds = runsPage({ runs: [runIn('done')] });
		expect(withoutRounds).not.toContain('Rounds de correção');
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

		const breakdown = panel(html, 'Custo por papel e modelo');
		expect(breakdown).toContain('Executor');
		expect(breakdown).toContain('claude-opus-4-6');
		expect(breakdown).toContain('1100 entrada');
		expect(breakdown).toContain('210 saída');
		expect(breakdown).toContain('Revisor');
		expect(breakdown).toContain('claude-sonnet-4-6');
		// Honesty requirement: shown as an equivalent, and explicit that it is
		// never the amount the subscription actually charged.
		expect(breakdown).toContain('Custo esperado equivalente ao uso via API');
		expect(breakdown).toContain('Nunca é o valor cobrado da assinatura');

		// No breakdown at all: no empty disclosure, same pattern as the report.
		expect(runsPage({ runs: [runIn('working')] })).not.toContain('Custo por papel e modelo');
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

		const breakdown = panel(html, 'Custo por papel e modelo');
		expect(breakdown).toContain('Executor (xhigh)');
		expect(breakdown).toContain('35704 thinking');
		// The effort and thinking sit on the role heading, not beside the model.
		expect(breakdown).not.toContain('claude-opus-4-6 (xhigh)');

		const reviewerLine = breakdown.slice(breakdown.indexOf('Revisor'));
		expect(reviewerLine).not.toContain('(');
		expect(reviewerLine).not.toContain('thinking');
	});

	// GSHIP-628: the same expected-cost total the individual cards show, but
	// summed across exactly the runs this screen already lists -- current run
	// plus history -- with the count of runs it covers, so it can never be read
	// as the whole project's total or as an amount actually charged.
	test('shows an aggregated total across exactly the listed runs, with the run count', () => {
		const runs = [
			runIn('done', { id: 'run-3', cost: { totalCostUsd: 0.1, breakdown: [], roles: [] } }),
			runIn('done', { id: 'run-2', cost: { totalCostUsd: 0.05, breakdown: [], roles: [] } }),
			runIn('done', { id: 'run-1', cost: EMPTY_RUN_COST }),
		];
		const aggregate = aggregateRunCosts(runs);
		expect(aggregate.totalCostUsd).toBeCloseTo(0.15, 6);
		expect(aggregate.runCount).toBe(3);

		const html = runsPage({ runs });
		expect(html).toContain('Custo esperado agregado');
		expect(html).toContain('3 run(s)');
		expect(html).toContain('US$');
	});

	// GSHIP-628: no run in the list ever reported a cost, so there is nothing to
	// aggregate -- the total is absent, not a fabricated zero across zero runs.
	test('shows no aggregated total when none of the listed runs have a cost', () => {
		const runs = [runIn('done', { id: 'run-2' }), runIn('failed', { id: 'run-1' })];
		expect(aggregateRunCosts(runs)).toEqual({ totalCostUsd: null, runCount: 2 });
		expect(runsPage({ runs })).not.toContain('Custo esperado agregado');
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

		expect(panelIsOpen(html, 'Atividade')).toBe(true);
		expect(html).toContain('provider.activity');
		expect(html).toContain('Vou ajustar o parser.');
		expect(html).toContain('Ferramentas: Read, Edit');
		expect(html).toContain('03:04:05');
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
		expect(html).toContain('1 evento(s) recente(s)');
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

		expect(html).toContain('Ferramentas: Grep');
		expect(html).toContain('subtype: init');
		expect(html).toContain('2 evento(s) recente(s)');
	});

	test('surfaces preserved workspaces without offering destructive cleanup', () => {
		const html = runsPage({ workspaceNotices: NOTICES });

		expect(html).toContain('Workspaces preservados');
		expect(html).toContain('/project/.gship/worktrees/orphan');
		expect(html).toContain('workspace is not owned by a persisted run');
		expect(html).not.toContain('Apagar workspace');
	});

	test('a single run has no history card to show', () => {
		expect(runsPage({ runs: [runIn('working')] })).not.toContain('Runs anteriores');
	});

	test('previous runs are listed read-only, newest first and without the last run', () => {
		const html = runsPage({
			runs: [
				runIn('working', { id: 'run-3', issueId: 'CAM-803' }),
				runIn('done', { id: 'run-2', issueId: 'CAM-802', updatedAt: '2026-08-15T18:30:00.000Z' }),
				runIn('failed', { id: 'run-1', issueId: 'CAM-801', updatedAt: '2026-08-14T09:05:00.000Z' }),
			],
		});
		const card = panel(html, 'Runs anteriores');

		expect(panelIsOpen(html, 'Runs anteriores')).toBe(false);
		expect(card).toContain('2 run(s) antes do último');
		expect(card).toContain('CAM-802');
		expect(card).toContain('2026-08-15 18:30');
		expect(card).toContain('CAM-801');
		expect(card).toContain('2026-08-14 09:05');
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
		const card = panel(html, 'Runs anteriores');

		const row802 = card.slice(card.indexOf('CAM-802'), card.indexOf('CAM-801'));
		expect(row802).toContain('Custo esperado');
		expect(row802).toContain('US$');

		const row801 = card.slice(card.indexOf('CAM-801'));
		expect(row801).not.toContain('Custo esperado');
	});

	test('history stops at four entries however long the list is', () => {
		const card = panel(
			runsPage({
				runs: Array.from({ length: 9 }, (_, index) =>
					runIn('done', { id: `run-${index}`, issueId: `CAM-8${index}0` })),
			}),
			'Runs anteriores',
		);

		expect(card).toContain('4 run(s) antes do último');
		for (const issueId of ['CAM-810', 'CAM-820', 'CAM-830', 'CAM-840']) {
			expect(card).toContain(issueId);
		}
		for (const issueId of ['CAM-800', 'CAM-850', 'CAM-880']) {
			expect(card).not.toContain(issueId);
		}
	});
});

describe('work surface', () => {
	test('reviews specified drafts in a closed disclosure and requires persisted confirmation', () => {
		const html = workPage({ drafts: [{
			id: 'CAM-42',
			title: 'Draft revisável',
			scope: 'Escopo persistido',
			verificationCommand: 'bun test focused',
			state: 'stale',
		}] });
		const card = panel(html, 'Revisar e aprovar');

		expect(card).not.toContain('open=""');
		expect(card).toContain('CAM-42 — Draft revisável');
		expect(card).toContain('Escopo persistido');
		expect(card).toContain('bun test focused');
		expect(card).toContain('type="checkbox"');
		expect(buttonIsEnabled(card, 'Salvar revisão')).toBe(false);
		expect(buttonIsEnabled(card, 'Aprovar')).toBe(false);
		// Abandoning needs a justification before its own confirmation unlocks.
		expect(card).toContain('Motivo do abandono');
		expect(buttonIsEnabled(card, 'Abandonar')).toBe(false);
		expect(card).not.toContain('fingerprint');
		// GSHIP-629: absent from every already-filed issue, so nothing renders.
		expect(card).not.toContain('Evidência checada no workspace da run');
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
		const card = panel(html, 'Revisar e aprovar');

		expect(card).toContain('Evidência checada no workspace da run');
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
		const owned = panel(workPage({ drafts: [draft], runs: [runIn('working')] }), 'Revisar e aprovar');

		expect(owned).toContain('CAM-900 — Draft em execução');
		expect(owned).toContain('CAM-900 está sendo executada por uma run.');
		expect(hasButton(owned, 'Salvar revisão')).toBe(false);
		expect(hasButton(owned, 'Aprovar')).toBe(false);
		expect(hasButton(owned, 'Abandonar')).toBe(false);
		expect(owned).not.toContain('type="checkbox"');

		// Another draft is untouched by that run, and a settled run returns the
		// controls to the issue it was executing.
		const other = panel(
			workPage({ drafts: [{ ...draft, id: 'CAM-901' }], runs: [runIn('working')] }),
			'Revisar e aprovar',
		);
		expect(hasButton(other, 'Aprovar')).toBe(true);
		expect(hasButton(other, 'Abandonar')).toBe(true);
		const settled = panel(workPage({ drafts: [draft], runs: [runIn('done')] }), 'Revisar e aprovar');
		expect(hasButton(settled, 'Aprovar')).toBe(true);
		expect(hasButton(settled, 'Abandonar')).toBe(true);
		expect(settled).not.toContain('está sendo executada por uma run');
	});

	test('offers the plannable backlog and holds start until an issue is chosen', () => {
		const html = workPage();

		expect(html).toContain('CAM-900');
		expect(html).toContain('primeira issue plannable');
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);

		const selected = workPage({ selectedIssueId: 'CAM-901' });
		expect(buttonIsEnabled(selected, 'Iniciar run')).toBe(true);
		expect(selected).toContain('aria-pressed="true"');

		// A live run blocks a second start even with an issue selected.
		const live = workPage({ runs: [runIn('waiting-user')], selectedIssueId: 'CAM-900' });
		expect(buttonIsEnabled(live, 'Iniciar run')).toBe(false);
		// A settled one reopens it.
		const settled = workPage({ runs: [runIn('done')], selectedIssueId: 'CAM-900' });
		expect(buttonIsEnabled(settled, 'Iniciar run')).toBe(true);
	});

	test('exposes the minimal operator contract for a new task', () => {
		const html = workPage();

		expect(html).toContain('Nova tarefa');
		expect(html).toContain('name="title"');
		expect(html).toContain('name="scope"');
		expect(html).toContain('name="verificationCommand"');
		expect(buttonIsEnabled(html, 'Criar tarefa')).toBe(true);
		expect(buttonIsEnabled(workPage({ pending: true }), 'Criar tarefa')).toBe(false);
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
			workspaceNotices: [],
		};
		const html = workPage({ diagnostics });

		expect(panelIsOpen(html, 'Gateship Diagnostics')).toBe(false);
		expect(html).toContain('Consultivo: nunca corrige, aprova ou bloqueia ship.');
		expect(html).toContain('no-transition-all');
		expect(html).toContain('webui/src/App.tsx:42');
		expect(html).toContain('Avoid animating every CSS property.');
		expect(buttonIsEnabled(html, 'Executar agora')).toBe(true);
		expect(buttonIsEnabled(html, 'Descartar')).toBe(true);
		expect(buttonIsEnabled(html, 'Promover')).toBe(true);
		expect(html).toContain('Resolvidos (1)');
		expect(html).toContain('GSHIP-900');
		expect(html).toContain('+3 não exibido(s).');
		expect(html).not.toContain('Pontuação');

		const active = workPage({
			diagnostics: {
				...diagnostics,
				scan: { ...diagnostics.scan!, state: 'running' },
			},
		});
		expect(hasButton(active, 'Executar agora')).toBe(false);
		expect(buttonIsEnabled(active, 'Cancelar diagnóstico')).toBe(true);
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
		const card = panel(html, 'Propostas derivadas');

		expect(card).not.toContain('open=""');
		expect(card).toContain('1 proposta(s) pendente(s).');
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
		expect(buttonIsEnabled(card, 'Descartar')).toBe(true);
		expect(buttonIsEnabled(card, 'Promover')).toBe(true);
		// Promoting files a draft: this card never approves and never starts a run.
		expect(hasButton(card, 'Aprovar')).toBe(false);
		expect(hasButton(card, 'Iniciar run')).toBe(false);
	});

	test('an empty inbox still renders the card, and a command in flight holds both decisions', () => {
		const empty = panel(workPage(), 'Propostas derivadas');
		expect(empty).toContain('0 proposta(s) pendente(s).');
		expect(empty).toContain('Nenhuma proposta pendente.');

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
			'Propostas derivadas',
		);
		expect(buttonIsEnabled(held, 'Descartar')).toBe(false);
		expect(buttonIsEnabled(held, 'Promover')).toBe(false);
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
		const card = panel(html, 'Propostas resolvidas');

		expect(card).toContain('1 proposta(s) resolvida(s).');
		expect(card).toContain('Extrair o parser de eventos');
		expect(card).toContain('Promovida');
		expect(card).toContain('CAM-951');
		expect(card).not.toContain('Descartada');
		// It is read-only: no decision is offered here, ever.
		expect(hasButton(card, 'Descartar')).toBe(false);
		expect(hasButton(card, 'Promover')).toBe(false);
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
		}), 'Propostas resolvidas');

		expect(card).toContain('Ideia descartada');
		expect(card).toContain('Descartada');
		expect(card).not.toContain('Promovida');
	});

	test('an empty or truncated resolved history renders as such, never in silence', () => {
		const empty = panel(workPage(), 'Propostas resolvidas');
		expect(empty).toContain('0 proposta(s) resolvida(s).');
		expect(empty).toContain('Nenhuma proposta resolvida ainda.');
		expect(empty).not.toContain('não exibida(s)');

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
			'Propostas resolvidas',
		);
		expect(truncated).toContain('+5 proposta(s) resolvida(s) não exibida(s).');
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
		const pendingCard = panel(html, 'Propostas derivadas');
		expect(pendingCard).toContain('1 proposta(s) pendente(s).');
		expect(pendingCard).toContain('Proposta pendente');
		expect(pendingCard).not.toContain('Proposta promovida');

		const resolvedCard = panel(html, 'Propostas resolvidas');
		expect(resolvedCard).toContain('Proposta promovida');
		expect(resolvedCard).not.toContain('Proposta pendente');
	});

	test('ideas are specified directly, without a planner, and only when there are any', () => {
		const html = workPage({ ideas: [{ id: 'CAM-42', title: 'ideia antiga' }] });

		expect(html).toContain('Especificar ideia existente');
		expect(html).toContain('CAM-42 — ideia antiga');
		expect(html).toContain('name="ideaScope"');
		expect(html).toContain('name="ideaVerificationCommand"');
		expect(buttonIsEnabled(html, 'Especificar ideia')).toBe(true);
		expect(workPage()).not.toContain('Especificar ideia existente');
	});
});

describe('settings surface', () => {
	test('edits the operator identity and suggests browser timezone without silently saving it', () => {
		const empty = panel(settingsPage(), 'Operador');
		expect(empty).toContain('name="operator-name"');
		expect(empty).toContain('name="operator-timezone"');
		expect(empty).toContain('value="America/Sao_Paulo"');
		expect(empty).toContain('só é salva quando você confirma');
		expect(buttonIsEnabled(empty, 'Salvar perfil')).toBe(true);

		const stored = panel(settingsPage({
			operatorProfile: { name: 'Eduardo', timezone: 'Europe/Lisbon' },
		}), 'Operador');
		expect(stored).toContain('value="Eduardo"');
		expect(stored).toContain('value="Europe/Lisbon"');
		expect(stored).not.toContain('value="America/Sao_Paulo"');
		expect(buttonIsEnabled(settingsPage({ pending: true }), 'Salvar perfil')).toBe(false);
	});

	test('shows subscription state without any credential field', () => {
		const html = settingsPage({
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', plan: 'max', login: 'external' },
				{ id: 'codex', installed: true, subscription: false, label: 'Codex', login: 'web' },
			],
		});

		expect(html).toContain('Agentes locais');
		expect(html).toContain('Claude Code');
		expect(html).toContain('Assinatura conectada · max');
		expect(html).toContain('em uso');
		expect(buttonIsEnabled(html, 'Conectar ChatGPT')).toBe(true);
		expect(html).not.toMatch(/api key|oauth token/i);
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

		expect(html).toContain('Assinatura conectada, mas indisponível agora');
		expect(html).toContain('Limite da assinatura atingido');
		expect(html).toContain('Indisponível agora: Autenticação necessária');
	});

	test('local notifications show the browser permission state without a secret field', () => {
		expect(buttonIsEnabled(settingsPage(), 'Ativar notificações')).toBe(true);

		const granted = settingsPage({ notificationPermission: 'granted' });
		expect(granted).toContain('Ativas neste navegador.');
		expect(buttonIsEnabled(granted, 'Notificações ativas')).toBe(false);
		expect(granted).not.toContain('API key');
		expect(settingsPage({ notificationPermission: 'denied' })).toContain('Notificações bloqueadas');
	});

	// GSHIP-652: the remote ntfy channel shows only whether it is configured,
	// a real test-send action, and setup instructions -- never the secret,
	// which the read-only `configured` boolean makes structurally impossible.
	test('the ntfy channel shows its configured state, a test action, and setup instructions, never a secret', () => {
		const unconfigured = panel(settingsPage(), 'Notificações locais');
		expect(unconfigured).toContain('ntfy: não configurado');
		expect(buttonIsEnabled(unconfigured, 'Enviar teste')).toBe(false);
		expect(unconfigured).toContain('.gship/ntfy-url');
		expect(unconfigured).toContain('permissão 600');
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
			'Notificações locais',
		);
		expect(configured).toContain('ntfy: configurado');
		expect(buttonIsEnabled(configured, 'Enviar teste')).toBe(true);
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
					resend: { configured: false, missing: ['chave de API', 'destinatário'] },
				},
			}),
			'Notificações locais',
		);
		expect(partial).toContain('email (Resend): não configurado (falta: chave de API, destinatário)');
		expect(buttonIsEnabled(channelRow(partial, 'email (Resend)'), 'Enviar teste')).toBe(false);
		expect(partial).toContain('.gship/resend-api-key');
		expect(partial).toContain('permissão 600');
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
			'Notificações locais',
		);
		expect(configured).toContain('email (Resend): configurado');
		expect(configured).not.toContain('falta:');
		expect(buttonIsEnabled(channelRow(configured, 'email (Resend)'), 'Enviar teste')).toBe(true);
	});

	test('the remote channel test action is held while a command is in flight, like every other', () => {
		const html = panel(
			settingsPage({
				notificationChannels: { ...EMPTY_NOTIFICATION_CHANNELS, ntfy: { configured: true, missing: [] } },
				pending: true,
			}),
			'Notificações locais',
		);
		expect(buttonIsEnabled(html, 'Enviar teste')).toBe(false);
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
		const handoff = panel(html, 'Handoff automático');

		// Two panels, each naming whose context it carries.
		expect(brief).toContain('Contexto humano autoritativo');
		expect(handoff).toContain('Estado de sessão observado e gerado pelo orquestrador');
		expect(handoff).toContain('Pode estar desatualizado; o brief acima prevalece.');

		// The form opens already filled with what the server holds, lists one per line.
		expect(brief).toContain('name="objective"');
		expect(brief).toContain('Manter a intenção do produto sob controle do operador.');
		for (const name of ['decisions', 'constraints', 'openItems']) {
			expect(brief).toContain(`name="${name}"`);
		}
		expect(brief).toContain('O brief é distinto do handoff.\nSó o operador o escreve.');
		expect(brief).toContain('Nenhuma rota nova.');
		expect(brief).toContain('Editar o brief pela web.');
		expect(buttonIsEnabled(html, 'Salvar brief')).toBe(true);

		// The orchestrator's record is printed whole, with nothing to type into.
		expect(handoff).toContain('Implementar a fatia 2 do estágio 2.');
		expect(handoff).toContain('A leitura devolve os dois registros.');
		expect(handoff).toContain('A UI apenas lê este registro.');
		expect(handoff).toContain('Regenerar o bundle.');
		expect(handoff).toContain('somente leitura');
		for (const control of ['<form', '<input', '<textarea', '<select', '<button']) {
			expect(handoff).not.toContain(control);
		}
		// The two records stay distinct: neither panel repeats the other's content.
		expect(handoff).not.toContain('Manter a intenção do produto');
		expect(brief).not.toContain('Implementar a fatia 2 do estágio 2.');
	});

	test('the brief save is held while a command is in flight, like every other', () => {
		expect(buttonIsEnabled(settingsPage({ pending: true }), 'Salvar brief')).toBe(false);
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
		const models = panel(html, 'Modelo e effort por papel');

		for (const role of ['Orquestrador', 'Executor', 'Revisor']) {
			expect(models).toContain(`${role} — modelo`);
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
		expect(models).toContain('padrão do CLI');
		expect(models).toContain('Vazio mantém o padrão do CLI.');

		expect(models).not.toContain('<select');
		expect(buttonIsEnabled(html, 'Salvar modelos')).toBe(true);
	});

	// GSHIP-619: Gateship cannot track vendor releases, so it stopped shipping a
	// list of its own and points at each vendor's page instead.
	test('every model field is free text, with no embedded suggestion list', () => {
		const models = panel(settingsPage(), 'Modelo e effort por papel');

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
		expect(models).toContain('recusado pelo próprio CLI');
	});

	test('each provider links to its own model documentation, in a new tab', () => {
		const models = panel(settingsPage(), 'Modelo e effort por papel');
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
			expect(models).toContain(`Modelos de ${label} na documentação oficial`);
		}
	});

	test('the model save is held while a command is in flight, like every other', () => {
		expect(buttonIsEnabled(settingsPage({ pending: true }), 'Salvar modelos')).toBe(false);
	});

	test('an empty brief and an empty handoff still render both panels', () => {
		const html = settingsPage();

		expect(panel(html, 'Project brief')).toContain('Um item por linha');
		expect(buttonIsEnabled(html, 'Salvar brief')).toBe(true);
		expect(panel(html, 'Handoff automático')).toContain('Nada registrado ainda.');
	});

	// GSHIP-638: off by default, and no pause reason to show while it never ran.
	test('the chain switch is off by default and shows no pause reason', () => {
		const chainRuns = panel(settingsPage(), 'Encadeamento automático');

		expect(chainRuns).not.toContain('checked=""');
		expect(chainRuns).not.toContain('Fila parada');
	});

	test('the chain switch reflects the stored setting and is held while a command is in flight', () => {
		const on = panel(settingsPage({ chainRuns: { enabled: true, pause: null } }), 'Encadeamento automático');
		expect(on).toContain('checked=""');

		const checkbox = elementWith(settingsPage({ pending: true }), 'type="checkbox"');
		expect(checkbox).toContain('disabled=""');
	});

	// GSHIP-650: a stopped queue asks for attention in the shell header now,
	// never buried as a secondary line next to the toggle that turned it on.
	test('a stopped queue is never reported inside the chaining switch\'s own panel', () => {
		const pause = { reason: 'no-admissible-issue' as ChainPauseReason, createdAt: '2026-08-18T00:00:00.000Z' };
		const chainRuns = panel(
			settingsPage({ chainRuns: { enabled: false, pause } }),
			'Encadeamento automático',
		);
		expect(chainRuns).not.toContain('Fila parada');
	});
});

describe('operator shell', () => {
	test('navigation is four real paths, with the active one marked', () => {
		for (const route of SURFACE_PATHS) {
			const html = renderAt(route);
			const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
			const active = openingTags(nav).find((tag) => tag.includes(`href="${route}"`));

			for (const path of SURFACE_PATHS) expect(nav).toContain(`href="${path}"`);
			expect(active).toContain('aria-current="page"');
			expect(nav.split('aria-current="page"')).toHaveLength(2);
			// Plain links to served paths: no in-page anchor navigation is left.
			expect(html).not.toContain('href="#');
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
		expect(shellHeader(home())).toContain('Ocioso');
		expect(shellHeader(runsPage({ runs: [runIn('working')] }))).toContain('Trabalhando');
		// No version reported: the header shows the title alone.
		expect(home()).not.toMatch(/v\d+\.\d+\.\d+/);
		expect(home({ version: '0.292.0' })).toContain('>v0.292.0<');
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
		expect(html).toContain('>Precisa de você<');
		expect(html).toContain('>v0.292.0<');
	});

	test('the technical run state stays on the run card and never reaches the header', () => {
		const html = runsPage({ runs: [runIn('failed')] });

		expect(shellHeader(html)).toContain('Precisa de você');
		expect(shellHeader(html)).not.toContain('failed');
		expect(html).toContain('>failed<');
	});

	test('a service older than origin/main is reported wherever the operator is', () => {
		const staleService = {
			bootSha: '1'.repeat(40),
			currentSha: '2'.repeat(40),
			detail: 'Reinicie o serviço para aplicar o que entrou depois do boot.',
		};

		// The ordinary case says nothing at all, on any surface.
		for (const route of SURFACE_PATHS) {
			expect(shellHeader(renderAt(route))).not.toContain('Reinicie o serviço');
		}
		// While it lasts it is on every surface, with both shas, and it stays:
		// there is no button to acknowledge it away.
		for (const route of SURFACE_PATHS) {
			const header = shellHeader(renderAt(route, { staleService }));

			expect(header).toContain('Reinicie o serviço');
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
			detail: 'Reinicie o serviço para aplicar o que entrou depois do boot.',
		};
		const html = runsPage({ runs: [runIn('ready-to-ship')], staleService });

		expect(shellHeader(html)).toContain('Reinicie o serviço');
		// The human state is the run's own, and every command it admits is offered.
		expect(shellHeader(html)).toContain('Precisa de você');
		expect(buttonIsEnabled(html, 'Shipar')).toBe(true);
		expect(buttonIsEnabled(
			workPage({ staleService, selectedIssueId: 'CAM-900' }),
			'Iniciar run',
		)).toBe(true);
	});

	test('a missing git identity is reported wherever the operator is (GSHIP-654)', () => {
		const gitIdentity = { detail: 'no git author identity is configured' };

		// The ordinary case says nothing at all, on any surface.
		for (const route of SURFACE_PATHS) {
			expect(shellHeader(renderAt(route))).not.toContain('Identidade de git ausente');
		}
		// While it lasts it is on every surface, with the detail, and it stays:
		// there is no button to acknowledge it away.
		for (const route of SURFACE_PATHS) {
			const header = shellHeader(renderAt(route, { gitIdentity }));

			expect(header).toContain('Identidade de git ausente');
			expect(header).toContain(gitIdentity.detail);
			expect(hasButton(header, 'Dispensar')).toBe(false);
		}
	});

	test('a missing git identity reports, and holds no operator command back', () => {
		const gitIdentity = { detail: 'no git author identity is configured' };
		const html = runsPage({ runs: [runIn('ready-to-ship')], gitIdentity });

		expect(shellHeader(html)).toContain('Identidade de git ausente');
		// The human state is the run's own, and every command it admits is offered.
		expect(shellHeader(html)).toContain('Precisa de você');
		expect(buttonIsEnabled(html, 'Shipar')).toBe(true);
	});

	test('a preserved workspace asks for the operator whatever the run is doing', () => {
		expect(shellHeader(runsPage({ runs: [runIn('done')], workspaceNotices: NOTICES })))
			.toContain('Precisa de você');
		expect(shellHeader(runsPage({ runs: [runIn('working')], workspaceNotices: NOTICES })))
			.toContain('Precisa de você');
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
			expect(header).toContain('Precisa de você');
			expect(header).toContain('Fila parada');
			expect(header).toContain('GSHIP-647');
			expect(header).toContain('Corrigir a divergência de evidência');
			expect(header).toContain('a run anterior não terminou em done.');
		}
		// The ordinary case says nothing at all.
		expect(shellHeader(home())).not.toContain('Fila parada');
	});

	// A pause the read could not resolve a run for still asks for attention,
	// but by its reason alone -- never a fabricated issue name. Excludes
	// chain-disabled: that reason is covered separately below, since it never
	// escalates.
	test('a stopped chain queue with no resolvable issue is still reported by its reason alone', () => {
		const labels: Record<Exclude<ChainPauseReason, 'chain-disabled'>, string> = {
			'previous-run-not-done': 'a run anterior não terminou em done.',
			'no-admissible-issue': 'nenhuma issue admissível no backlog agora.',
			'run-active': 'uma run ainda está ativa.',
			'chain-start-failed': 'a tentativa de iniciar a próxima run falhou.',
		};
		for (const [reason, label] of Object.entries(labels)) {
			const pause = { reason: reason as ChainPauseReason, createdAt: '2026-08-18T00:00:00.000Z' };
			const header = shellHeader(settingsPage({ chainRuns: { enabled: true, pause } }));
			expect(header).toContain('Precisa de você');
			expect(header).toContain(`Fila parada`);
			expect(header).toContain(label);
			expect(header).not.toContain('GSHIP');
		}
	});

	// GSHIP-650 review: chaining is off by default (GSHIP-638), so
	// chain-disabled is every default install's steady state, not a stopped
	// queue -- escalating it would read "Precisa de você" with a warning
	// callout forever, on every surface, for an install that never turned
	// chaining on.
	test('the switch simply being off never escalates the header or shows the callout', () => {
		const pause: ChainPauseView = { reason: 'chain-disabled', createdAt: '2026-08-18T00:00:00.000Z' };
		const header = shellHeader(settingsPage({ chainRuns: { enabled: false, pause } }));

		expect(header).toContain('Ocioso');
		expect(header).not.toContain('Precisa de você');
		expect(header).not.toContain('Fila parada');
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
		expect(on).toContain('Precisa de você');
		expect(on).toContain('Fila parada');

		const off = shellHeader(settingsPage({ chainRuns: { enabled: false, pause } }));
		expect(off).toContain('Ocioso');
		expect(off).not.toContain('Precisa de você');
		expect(off).not.toContain('Fila parada');
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
				detail: `Reinicie o serviço: origin/main saiu de ${HASH}.`,
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
			expect(region).toContain('aria-label="Transcrição da conversa"');
			expect(region).toContain('tabindex="0"');
			expect(region).toContain('overflow-y-auto');
			expect(html.split('role="log"')).toHaveLength(2);
		}
		// The empty state is inside the region, so the region never moves.
		expect(empty.indexOf('role="log"')).toBeLessThan(empty.indexOf('Descreva o objetivo'));
		expect(loaded.indexOf('role="log"')).toBeLessThan(loaded.indexOf('Pronto.'));
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

		for (const state of needsYou) expect(attentionOf(runIn(state), false)).toBe('Precisa de você');
		for (const state of busy) expect(attentionOf(runIn(state), false)).toBe('Trabalhando');
		expect(attentionOf(runIn('done'), false)).toBe('Ocioso');
		expect(attentionOf(runIn('cancelled'), false)).toBe('Ocioso');
		expect(attentionOf(null, false)).toBe('Ocioso');
	});

	test('a preserved workspace decides before the run state does', () => {
		expect(attentionOf(runIn('done'), NOTICES)).toBe('Precisa de você');
		expect(attentionOf(runIn('working'), NOTICES)).toBe('Precisa de você');
		expect(attentionOf(null, NOTICES)).toBe('Precisa de você');
		expect(attentionOf(runIn('done'), [])).toBe('Ocioso');
		expect(attentionOf(runIn('working'), true)).toBe('Precisa de você');
	});

	// GSHIP-650: a stopped chain queue decides before the run state does, the
	// same way a preserved workspace already does -- otherwise a queue paused
	// after a `done` run reads as idle, hiding exactly the state it named.
	test('a stopped chain queue decides before the run state does', () => {
		expect(attentionOf(runIn('done'), false, true)).toBe('Precisa de você');
		expect(attentionOf(runIn('cancelled'), false, true)).toBe('Precisa de você');
		expect(attentionOf(runIn('done'), false, false)).toBe('Ocioso');
		expect(attentionOf(runIn('done'), false)).toBe('Ocioso');
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
		expect(NOTIFICATIONS_PATH).toBe('/api/notifications');
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
			expect(await saveOperatorProfile(profile)).toBe('Perfil do operador atualizado.');
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
				detail: 'O serviço não informou um estado de projeto válido.',
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
			expect(await dismissProposal('run-1-proposal-1')).toBe('Proposta descartada.');
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
			{ ok: false, code: 'proposal-not-pending', message: 'Proposta run-1-proposal-1 já está promoted.' },
			409,
			async () => {
				expect(await dismissProposal('run-1-proposal-1'))
					.toBe('Proposta run-1-proposal-1 já está promoted.');
				await expect(promoteProposal('run-1-proposal-1', {
					title: 'Título',
					scope: 'Escopo.',
					verificationCommand: 'bun test',
				})).rejects.toThrow('Proposta run-1-proposal-1 já está promoted.');
			},
		);
	});

	test('the brief and the handoff arrive on one read, and only the brief is written', async () => {
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
			expect(await saveBrief(brief)).toBe('Project brief atualizado.');
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
			expect(await saveModelSettings(settings)).toBe('Modelos por papel atualizados.');
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
			message: 'Modelo de claude/executor não pode conter espaço em branco.',
		}, 400, async () => {
			expect(await saveModelSettings(settings))
				.toBe('Modelo de claude/executor não pode conter espaço em branco.');
		});
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchModelSettings()).rejects.toThrow('Modelos respondeu 500');
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
			expect(await saveModelSettings(EMPTY_MODEL_SETTINGS)).toBe('Modelos por papel atualizados.');
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
			expect(await saveChainRuns(true)).toBe('Encadeamento automático ativado.');
			expect(calls).toEqual([{
				url: CHAIN_RUNS_PATH,
				method: 'PUT',
				body: JSON.stringify({ enabled: true }),
			}]);
		});
		await withRecordedFetch({ ok: true, enabled: false, pause: null }, 200, async () => {
			expect(await saveChainRuns(false)).toBe('Encadeamento automático desativado.');
		});
		await withRecordedFetch({
			ok: false,
			code: 'invalid-request',
			message: '"enabled" deve ser um booleano.',
		}, 400, async () => {
			expect(await saveChainRuns(true)).toBe('"enabled" deve ser um booleano.');
		});
	});

	test('a refused brief surfaces the server validation message', async () => {
		await withRecordedFetch({
			ok: false,
			code: 'invalid-request',
			message: 'Objetivo aceita no máximo 2000 caracteres.',
		}, 400, async () => {
			expect(await saveBrief({ ...EMPTY_BRIEF, objective: 'o'.repeat(2001) }))
				.toBe('Objetivo aceita no máximo 2000 caracteres.');
		});
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchBrief()).rejects.toThrow('Brief respondeu 500');
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
			expect(await sendChat('Continue.')).toBe('Resposta do orquestrador recebida.');
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
			expect(await approveIssue('CAM-42')).toBe('Run atualizada.');
			expect(calls).toEqual([{ url: '/api/issues/CAM-42/approve', method: 'POST', body: null }]);
		});
	});

	test('abandoning an issue uses the same trusted origin route with its justification', async () => {
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await abandonIssue('CAM-42', 'Não faz mais sentido.')).toBe('Run atualizada.');
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
			expect(await selectProvider('codex')).toBe('Run atualizada.');
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
			{ channels: { ntfy: { configured: true }, resend: { configured: false, missing: ['chave de API'] } } },
			200,
			async (calls) => {
				expect(await fetchNotificationChannels()).toEqual({
					ntfy: { configured: true, missing: [] },
					resend: { configured: false, missing: ['chave de API'] },
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
			{ ok: false, code: 'not-configured', message: 'Canal ntfy não está configurado.' },
			409,
			async () => {
				expect(await sendNotificationTest('ntfy'))
					.toBe('Canal ntfy não está configurado.');
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
			expect(await startRun('CAM-900')).toBe('Run atualizada.');
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
			detail: 'Reinicie o serviço para aplicar o que entrou depois do boot.',
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
			expect(await startDiagnostic('react')).toContain('checkout isolado');
			expect(calls).toEqual([{
				url: DIAGNOSTICS_PATH,
				method: 'POST',
				body: JSON.stringify({ analyzer: 'react' }),
			}]);
		});
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await cancelDiagnostic('scan / 1')).toBe('Diagnóstico cancelado.');
			expect(calls[0]?.url).toBe(`${DIAGNOSTICS_PATH}/scan%20%2F%201/cancel`);
		});
		await withRecordedFetch({ ok: true }, 200, async (calls) => {
			expect(await dismissDiagnosticFinding('finding / 1')).toContain('descartado');
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
	});

	test('a failed read is reported as a transport error, not as empty data', async () => {
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchRuns()).rejects.toThrow('Runs respondeu 500');
			await expect(fetchBacklog()).rejects.toThrow('Snapshot respondeu 500');
		});
	});
});
