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
	approveIssue,
	BRIEF_PATH,
	commandRun,
	createIssue,
	CHAT_PATH,
	dismissProposal,
	EVENTS_PATH,
	fetchBacklog,
	fetchBrief,
	fetchChat,
	fetchProposals,
	fetchProviders,
	fetchRunEvents,
	fetchRuns,
	type ProjectBriefView,
	MODEL_SETTINGS_PATH,
	type ModelSettingsView,
	promoteProposal,
	PROPOSALS_PATH,
	RUNS_PATH,
	ISSUES_PATH,
	PROVIDERS_PATH,
	saveBrief,
	fetchModelSettings,
	saveModelSettings,
	emptyModelSettings,
	selectProvider,
	sendChat,
	SNAPSHOT_PATH,
	specifyIssue,
	startCodexLogin,
	startRun,
} from '../../webui/src/client.ts';
import { isAtLiveEdge, LIVE_EDGE_TOLERANCE_PX } from '../../webui/src/live-edge.ts';
import {
	actionsFor,
	attentionOf,
	invalidatesSnapshot,
	progressOf,
	type RunEventView,
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

function runIn(state: RunState, overrides: Partial<RunView> = {}): RunView {
	return {
		id: 'run-1',
		issueId: 'CAM-900',
		state,
		summary: null,
		error: null,
		updatedAt: '2026-08-16T00:00:00.000Z',
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

const EMPTY_BRIEF: ProjectBriefView = {
	objective: '',
	decisions: [],
	constraints: [],
	openItems: [],
};

function renderAt(route: OperatorRoute, overrides: Partial<AppProps> = {}): string {
	return renderToStaticMarkup(
		<App
			backlog={BACKLOG}
			drafts={[]}
			brief={EMPTY_BRIEF}
			chatMessages={[]}
			events={[]}
			handoff={EMPTY_BRIEF}
			ideas={[]}
			modelSettings={EMPTY_MODEL_SETTINGS}
			notificationPermission="default"
			onAbandon={() => {}}
			onCancel={() => {}}
			onConnectCodex={() => {}}
			onCreateIssue={() => {}}
			onApproveIssue={() => {}}
			onDismissProposal={() => {}}
			onEnableNotifications={() => {}}
			onPromoteProposal={() => {}}
			onResume={() => {}}
			onSaveBrief={() => {}}
			onSaveModelSettings={() => {}}
			onSelectIssue={() => {}}
			onSelectProvider={() => {}}
			onSendMessage={() => {}}
			onShip={() => {}}
			onSpecifyIssue={() => {}}
			onReviewIssue={() => {}}
			onStart={() => {}}
			pending={false}
			proposals={[]}
			providers={[]}
			route={route}
			runs={[]}
			selectedIssueId={null}
			selectedProvider="claude"
			status={null}
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
		expect(html).toContain('name="message"');
		expect(html).toContain('Investigue o core.');
		expect(html).toContain('Retomei o contexto e encontrei o loop.');
		expect(html).toContain('codex');
		expect(html).toContain('claude');
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
		expect(card).not.toContain('fingerprint');
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
		expect(owned).not.toContain('type="checkbox"');

		// Another draft is untouched by that run, and a settled run returns the
		// controls to the issue it was executing.
		const other = panel(
			workPage({ drafts: [{ ...draft, id: 'CAM-901' }], runs: [runIn('working')] }),
			'Revisar e aprovar',
		);
		expect(hasButton(other, 'Aprovar')).toBe(true);
		const settled = panel(workPage({ drafts: [draft], runs: [runIn('done')] }), 'Revisar e aprovar');
		expect(hasButton(settled, 'Aprovar')).toBe(true);
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

	test('local notifications show the browser permission state without a secret field', () => {
		expect(buttonIsEnabled(settingsPage(), 'Ativar notificações')).toBe(true);

		const granted = settingsPage({ notificationPermission: 'granted' });
		expect(granted).toContain('Ativas neste navegador.');
		expect(buttonIsEnabled(granted, 'Notificações ativas')).toBe(false);
		expect(granted).not.toContain('API key');
		expect(settingsPage({ notificationPermission: 'denied' })).toContain('Notificações bloqueadas');
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

	// GSHIP-617: the three roles are configurable per provider, and the screen
	// suggests known values without restricting them.
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

		// Known values are suggested by a datalist, so the field still accepts
		// anything the CLI might learn about later.
		expect(models).toContain('<datalist id="claude-model-options"');
		expect(models).toContain('<datalist id="codex-effort-options"');
		expect(models).toContain('list="claude-effort-options"');
		expect(models).not.toContain('<select');
		expect(buttonIsEnabled(html, 'Salvar modelos')).toBe(true);
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

	test('the technical run state stays on the run card and never reaches the header', () => {
		const html = runsPage({ runs: [runIn('failed')] });

		expect(shellHeader(html)).toContain('Precisa de você');
		expect(shellHeader(html)).not.toContain('failed');
		expect(html).toContain('>failed<');
	});

	test('a preserved workspace asks for the operator whatever the run is doing', () => {
		expect(shellHeader(runsPage({ runs: [runIn('done')], workspaceNotices: NOTICES })))
			.toContain('Precisa de você');
		expect(shellHeader(runsPage({ runs: [runIn('working')], workspaceNotices: NOTICES })))
			.toContain('Precisa de você');
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
		const needsYou: RunState[] = ['waiting-user', 'failed', 'interrupted', 'ready-to-ship'];
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

	test('an interrupted run is resumable and a terminal one is not', () => {
		expect(actionsFor(runIn('interrupted'), false).resume).toBe(true);
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
		expect(RUNS_PATH).toBe('/api/runs');
		expect(EVENTS_PATH).toBe('/api/events');
		expect(ISSUES_PATH).toBe('/api/issues');
		expect(PROVIDERS_PATH).toBe('/api/providers');
		expect(CHAT_PATH).toBe('/api/chat');
		expect(BRIEF_PATH).toBe('/api/brief');
		expect(PROPOSALS_PATH).toBe('/api/proposals');
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
				version: '0.292.0',
			});
		});
	});

	test('a failed read is reported as a transport error, not as empty data', async () => {
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchRuns()).rejects.toThrow('Runs respondeu 500');
			await expect(fetchBacklog()).rejects.toThrow('Snapshot respondeu 500');
		});
	});
});
