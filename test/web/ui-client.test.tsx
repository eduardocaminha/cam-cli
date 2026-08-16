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
	EVENTS_PATH,
	fetchLatestRun,
	fetchPlannable,
	RUNS_PATH,
	ISSUES_PATH,
	SNAPSHOT_PATH,
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
			onCancel={() => {}}
			onCreateIssue={() => {}}
			onResume={() => {}}
			onSelectIssue={() => {}}
			onShip={() => {}}
			onStart={() => {}}
			pending={false}
			run={null}
			selectedIssueId={null}
			status={null}
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

describe('operational screen', () => {
	test('idle: offers the plannable backlog and no run panel controls', () => {
		const html = render();

		expect(html).toContain('CAM-900');
		expect(html).toContain('primeira issue plannable');
		expect(html).toContain('Nenhum run registrado ainda.');
		expect(html).toContain('ocioso');
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);
		expect(html).not.toContain('Retomar');
	});

	test('idle with a selected issue: start becomes reachable', () => {
		const html = render({ selectedIssueId: 'CAM-901' });

		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(true);
		expect(html).toContain('aria-pressed="true"');
	});

	test('working: shows the phase and offers only cancel', () => {
		const html = render({ run: runIn('working') });

		expect(html).toContain('Fase working');
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(true);
		expect(buttonIsEnabled(html, 'Retomar')).toBe(false);
		expect(buttonIsEnabled(html, 'Shipar')).toBe(false);
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);
	});

	test('waiting-user: offers resume and keeps the phase on the spine', () => {
		const html = render({ run: runIn('waiting-user'), selectedIssueId: 'CAM-900' });

		expect(html).toContain('Fase working');
		expect(html).toContain('waiting-user');
		expect(buttonIsEnabled(html, 'Retomar')).toBe(true);
		// A live run blocks a second start even with an issue selected.
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(false);
	});

	test('ready-to-ship: offers ship alongside cancel', () => {
		const html = render({ run: runIn('ready-to-ship') });

		expect(html).toContain('Fase ready-to-ship');
		expect(buttonIsEnabled(html, 'Shipar')).toBe(true);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(true);
		expect(buttonIsEnabled(html, 'Retomar')).toBe(false);
	});

	test('done: shows the summary, closes the commands and reopens start', () => {
		const html = render({
			run: runIn('done', { summary: 'PR #123 mergeado.' }),
			selectedIssueId: 'CAM-900',
		});

		expect(html).toContain('PR #123 mergeado.');
		expect(html).toContain('100%');
		expect(buttonIsEnabled(html, 'Iniciar run')).toBe(true);
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(false);
		expect(buttonIsEnabled(html, 'Shipar')).toBe(false);
	});

	test('failed: shows the error instead of a summary', () => {
		const html = render({ run: runIn('failed', { error: 'oracle reprovou a story 2' }) });

		expect(html).toContain('oracle reprovou a story 2');
		expect(html).toContain('failed');
		expect(buttonIsEnabled(html, 'Cancelar')).toBe(false);
	});

	test('a command in flight holds every button', () => {
		const html = render({ run: runIn('ready-to-ship'), pending: true, selectedIssueId: 'CAM-900' });

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
});

describe('screen derivations', () => {
	test('progress advances monotonically along the run spine', () => {
		const spine: RunState[] = ['queued', 'working', 'verify', 'review', 'ready-to-ship', 'done'];
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

	test('a refused command surfaces the server message instead of a generic failure', async () => {
		await withRecordedFetch({ ok: false, message: 'Run not found.' }, 404, async () => {
			expect(await commandRun('run-x', 'ship')).toBe('Run not found.');
		});
	});

	test('reads take the newest run and tolerate a cycle-in-progress snapshot', async () => {
		await withRecordedFetch({ runs: [runIn('working'), runIn('done')] }, 200, async () => {
			expect(await fetchLatestRun()).toMatchObject({ state: 'working' });
		});
		await withRecordedFetch({ runs: [] }, 200, async () => {
			expect(await fetchLatestRun()).toBeNull();
		});
		// No idleState key at all: a cycle is running, so nothing is plannable.
		await withRecordedFetch({ phase: 'implementing' }, 200, async () => {
			expect(await fetchPlannable()).toEqual([]);
		});
		await withRecordedFetch({ idleState: { backlog: { plannable: BACKLOG } } }, 200, async () => {
			expect(await fetchPlannable()).toEqual(BACKLOG);
		});
	});

	test('a failed read is reported as a transport error, not as empty data', async () => {
		await withRecordedFetch({}, 500, async () => {
			await expect(fetchLatestRun()).rejects.toThrow('Runs respondeu 500');
			await expect(fetchPlannable()).rejects.toThrow('Snapshot respondeu 500');
		});
	});
});
