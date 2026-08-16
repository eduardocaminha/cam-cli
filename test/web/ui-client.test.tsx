// test/web/ui-client.test.tsx
//
// The operational screen, executed once per state it can be in, through
// renderToStaticMarkup and no DOM harness (ADR-0067). What is asserted is the
// screen's decisions -- which phase it shows, which outcome text it shows, and
// which of the four commands it offers -- never the component source text.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { App, type AppProps } from '../../webui/src/App.tsx';
import {
	commandRun,
	createIssue,
	CHAT_PATH,
	EVENTS_PATH,
	fetchBacklog,
	fetchChat,
	fetchProviders,
	fetchRunEvents,
	fetchRuns,
	RUNS_PATH,
	ISSUES_PATH,
	PROVIDERS_PATH,
	selectProvider,
	sendChat,
	SNAPSHOT_PATH,
	specifyIssue,
	startCodexLogin,
	startRun,
} from '../../webui/src/client.ts';
import { actionsFor, progressOf, type RunState, type RunView } from '../../webui/src/run-view.ts';

const BACKLOG = [
	{ id: 'CAM-900', title: 'primeira issue plannable' },
	{ id: 'CAM-901', title: 'segunda issue plannable' },
];

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

function render(overrides: Partial<AppProps> = {}): string {
	return renderToStaticMarkup(
		<App
			backlog={BACKLOG}
			chatMessages={[]}
			events={[]}
			ideas={[]}
			notificationPermission="default"
			onCancel={() => {}}
			onConnectCodex={() => {}}
			onCreateIssue={() => {}}
			onEnableNotifications={() => {}}
			onResume={() => {}}
			onSelectIssue={() => {}}
			onSelectProvider={() => {}}
			onSendMessage={() => {}}
			onShip={() => {}}
			onSpecifyIssue={() => {}}
			onStart={() => {}}
			pending={false}
			providers={[]}
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
 * Whether the contextual panel carrying `title` is disclosed. The panel is
 * found by its heading -- a navigation link can repeat the words, a heading
 * cannot -- and read back to the disclosure that owns it.
 */
function panelIsOpen(html: string, title: string): boolean {
	const index = html.indexOf(`>${title}</h2>`);
	if (index < 0) throw new Error(`panel ${title} is not on the screen`);
	const opening = html.lastIndexOf('<details', index);
	if (opening < 0) throw new Error(`panel ${title} is not a disclosure`);
	return html.slice(opening, index).includes('open=""');
}

/** The history card alone, cut before the backlog panel that follows it. */
function historyCard(html: string): string {
	const start = html.indexOf('Runs anteriores');
	if (start < 0) throw new Error('the history card is not on the screen');
	return html.slice(start, html.indexOf('Backlog plannable'));
}

describe('operational screen', () => {
	test('idle: offers the plannable backlog and no run panel controls', () => {
		const html = render();

		expect(html).toContain('CAM-900');
		expect(html).toContain('primeira issue plannable');
		expect(html).toContain('Nenhum run registrado ainda.');
		expect(html).toContain('ocioso');
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);
		expect(html).not.toContain('Retomar');
		expect(html).toContain('Conversa com o orquestrador');
		expect(html).toContain('name="message"');
		expect(buttonIsEnabled(html, 'Ativar notificações')).toBe(true);
		// No version reported: the header shows the title alone.
		expect(html).not.toMatch(/v\d+\.\d+\.\d+/);
		expect(render({ version: '0.292.0' })).toContain('>v0.292.0<');
	});

	test('local notifications show the browser permission state without a secret field', () => {
		const html = render({ notificationPermission: 'granted' });

		expect(html).toContain('Ativas neste navegador.');
		expect(buttonIsEnabled(html, 'Notificações ativas')).toBe(false);
		expect(html).not.toContain('API key');
		expect(render({ notificationPermission: 'denied' })).toContain('Notificações bloqueadas');
	});

	test('idle with a selected issue: start becomes reachable', () => {
		const html = render({ selectedIssueId: 'CAM-901' });

		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(true);
		expect(html).toContain('aria-pressed="true"');
	});

	test('conversation renders the durable cross-provider handoff', () => {
		const html = render({
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

		expect(html).toContain('Investigue o core.');
		expect(html).toContain('Retomei o contexto e encontrei o loop.');
		expect(html).toContain('codex');
		expect(html).toContain('claude');
	});

	test('working: shows the phase and offers only cancel', () => {
		const html = render({ runs: [runIn('working')] });

		expect(html).toContain('Fase working');
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(true);
		expect(buttonIsEnabled(html, 'Retomar')).toBe(false);
		expect(buttonIsEnabled(html, 'Shipar')).toBe(false);
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);
	});

	test('waiting-user: asks for an answer before resuming on the same spine', () => {
		const html = render({
			runs: [runIn('waiting-user', { summary: 'Escolha o seam de migração.' })],
			selectedIssueId: 'CAM-900',
		});

		expect(html).toContain('Fase working');
		expect(html).toContain('waiting-user');
		expect(html).toContain('Escolha o seam de migração.');
		expect(html).toContain('name="operatorGuidance"');
		expect(buttonIsEnabled(html, 'Responder e retomar')).toBe(true);
		// A live run blocks a second start even with an issue selected.
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);
	});

	test('ready-to-ship: offers ship as the retry, alongside cancel', () => {
		const html = render({ runs: [runIn('ready-to-ship')] });

		expect(html).toContain('Fase ready-to-ship');
		expect(buttonIsEnabled(html, 'Shipar')).toBe(true);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(true);
		expect(buttonIsEnabled(html, 'Retomar')).toBe(false);
	});

	test('shipping: shows the phase the service is in and holds the ship command', () => {
		const html = render({ runs: [runIn('shipping')] });

		expect(html).toContain('Fase shipping');
		// The run is already shipping itself: the button is only the retry.
		expect(buttonIsEnabled(html, 'Shipar')).toBe(false);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(true);
		expect(buttonIsEnabled(html, 'Retomar')).toBe(false);
	});

	test('done: shows the summary, closes the commands and reopens start', () => {
		const html = render({
			runs: [runIn('done', { summary: 'PR #123 mergeado.' })],
			selectedIssueId: 'CAM-900',
		});

		expect(html).toContain('PR #123 mergeado.');
		expect(html).toContain('100%');
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(true);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(false);
		expect(buttonIsEnabled(html, 'Shipar')).toBe(false);
	});

	test('failed: shows the error instead of a summary', () => {
		const html = render({ runs: [runIn('failed', { error: 'oracle reprovou a story 2' })] });

		expect(html).toContain('oracle reprovou a story 2');
		expect(html).toContain('failed');
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(false);
	});

	test('a command in flight holds every button', () => {
		const html = render({
			pending: true,
			runs: [runIn('ready-to-ship')],
			selectedIssueId: 'CAM-900',
		});

		expect(buttonIsEnabled(html, 'Shipar')).toBe(false);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(false);
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);
		expect(buttonIsEnabled(html, 'Criar tarefa')).toBe(false);
	});

	test('idle screen exposes the minimal operator contract', () => {
		const html = render();

		expect(html).toContain('Nova tarefa');
		expect(html).toContain('name="title"');
		expect(html).toContain('name="scope"');
		expect(html).toContain('name="verificationCommand"');
		expect(buttonIsEnabled(html, 'Criar tarefa')).toBe(true);
	});

	test('idle with ideas offers direct specification without a planner', () => {
		const html = render({ ideas: [{ id: 'CAM-42', title: 'ideia antiga' }] });

		expect(html).toContain('Especificar ideia existente');
		expect(html).toContain('CAM-42 — ideia antiga');
		expect(html).toContain('name="ideaScope"');
		expect(html).toContain('name="ideaVerificationCommand"');
		expect(buttonIsEnabled(html, 'Especificar ideia')).toBe(true);
	});

	test('surfaces preserved workspaces without offering destructive cleanup', () => {
		const html = render({
			workspaceNotices: [{
				kind: 'dirty',
				runId: null,
				workspacePath: '/project/.gship/worktrees/orphan',
				branch: 'gship/cam-1-orphan',
				detail: 'workspace is not owned by a persisted run',
			}],
		});

		expect(html).toContain('Workspaces preservados');
		expect(html).toContain('/project/.gship/worktrees/orphan');
		expect(html).toContain('workspace is not owned by a persisted run');
		expect(html).not.toContain('Apagar workspace');
	});

	test('a run shows persisted public activity and tool names', () => {
		const html = render({
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

		expect(html).toContain('Atividade');
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
		const html = render({
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
		const html = render({
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

	test('a single run has no history card to show', () => {
		const html = render({ runs: [runIn('working')] });

		expect(html).not.toContain('Runs anteriores');
	});

	test('previous runs are listed read-only, newest first and without the last run', () => {
		const html = render({
			runs: [
				runIn('working', { id: 'run-3', issueId: 'CAM-803' }),
				runIn('done', { id: 'run-2', issueId: 'CAM-802', updatedAt: '2026-08-15T18:30:00.000Z' }),
				runIn('failed', { id: 'run-1', issueId: 'CAM-801', updatedAt: '2026-08-14T09:05:00.000Z' }),
			],
		});
		const card = historyCard(html);

		expect(html).toContain('Runs anteriores');
		expect(card).toContain('2 run(s) antes do último');
		expect(card).toContain('CAM-802');
		expect(card).toContain('2026-08-15 18:30');
		expect(card).toContain('CAM-801');
		expect(card).toContain('2026-08-14 09:05');
		expect(card).toContain('failed');
		// The run the panel above commands is not repeated in the history.
		expect(card).not.toContain('CAM-803');
		expect(card.indexOf('CAM-802')).toBeLessThan(card.indexOf('CAM-801'));
		// Read-only: history rows carry no command and no selection.
		expect(card).not.toContain('<button');
		expect(card).not.toContain('aria-pressed');
	});

	test('history stops at four entries however long the list is', () => {
		const html = render({
			runs: Array.from({ length: 9 }, (_, index) =>
				runIn('done', { id: `run-${index}`, issueId: `CAM-8${index}0` })),
		});
		const card = historyCard(html);

		expect(card).toContain('4 run(s) antes do último');
		for (const issueId of ['CAM-810', 'CAM-820', 'CAM-830', 'CAM-840']) {
			expect(card).toContain(issueId);
		}
		for (const issueId of ['CAM-800', 'CAM-850', 'CAM-880']) {
			expect(card).not.toContain(issueId);
		}
	});
});

describe('operator shell', () => {
	test('navigation offers the panels the screen is carrying, and only those', () => {
		const idle = render();

		expect(idle).toContain('href="#conversa"');
		expect(idle).toContain('href="#run"');
		expect(idle).toContain('href="#backlog"');
		// No run, no ideas, no notices and no history: no link pointing at nothing.
		expect(idle).not.toContain('href="#atividade"');
		expect(idle).not.toContain('href="#ideias"');
		expect(idle).not.toContain('href="#workspaces"');
		expect(idle).not.toContain('href="#historico"');

		const loaded = render({
			ideas: [{ id: 'CAM-42', title: 'ideia antiga' }],
			runs: [runIn('working'), runIn('done', { id: 'run-0' })],
			workspaceNotices: [{
				kind: 'dirty',
				runId: null,
				workspacePath: '/project/.gship/worktrees/orphan',
				branch: 'gship/cam-1-orphan',
				detail: 'workspace is not owned by a persisted run',
			}],
		});

		expect(loaded).toContain('href="#atividade"');
		expect(loaded).toContain('href="#ideias"');
		expect(loaded).toContain('href="#workspaces"');
		expect(loaded).toContain('href="#historico"');
	});

	test('a collapsed panel is disclosed, never dropped from the document', () => {
		const html = render({
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', plan: 'max', login: 'external' },
			],
			runs: [runIn('working'), runIn('done', { id: 'run-0', issueId: 'CAM-801' })],
		});

		// What the operator acts on now is open; the rest is one click away.
		expect(panelIsOpen(html, 'Backlog plannable')).toBe(true);
		expect(panelIsOpen(html, 'Atividade')).toBe(true);
		expect(panelIsOpen(html, 'Agentes locais')).toBe(false);
		expect(panelIsOpen(html, 'Runs anteriores')).toBe(false);
		// Collapsed is a rendering state, not a missing branch: the content is here.
		expect(html).toContain('Assinatura conectada · max');
		expect(html).toContain('CAM-801');
	});

	test('the run asks for its decision on the conversation surface, once', () => {
		const html = render({
			runs: [runIn('waiting-user', { summary: 'Escolha o seam de migração.' })],
		});

		expect(html.indexOf('name="operatorGuidance"')).toBeLessThan(html.indexOf('Último run'));
		expect(html.split('Escolha o seam de migração.')).toHaveLength(2);
		// Resuming is the answer itself while the run waits, never a bare command.
		expect(html).not.toContain('>Retomar<');
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

	test('an interrupted run is resumable and a terminal one is not', () => {
		expect(actionsFor(runIn('interrupted'), false).resume).toBe(true);
		expect(actionsFor(runIn('failed'), true)).toMatchObject({ start: true, resume: false });
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

	test('shows subscription state without any credential field', () => {
		const html = render({
			providers: [
				{ id: 'claude', installed: true, subscription: true, label: 'Claude Code', plan: 'max', login: 'external' },
				{ id: 'codex', installed: true, subscription: false, label: 'Codex', login: 'web' },
			],
		});
		expect(html).toContain('Claude Code');
		expect(html).toContain('Assinatura conectada · max');
		expect(buttonIsEnabled(html, 'Conectar ChatGPT')).toBe(true);
		expect(html).not.toMatch(/api key|oauth token/i);
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
			await commandRun('run-1', 'cancel');
			await commandRun('run-1', 'ship');
		});

		expect(calls.map((call) => call.url)).toEqual([
			'/api/runs/run-1/resume',
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
