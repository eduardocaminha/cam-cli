import { describe, expect, test } from 'bun:test';

import {
	buildOrchestratorContext,
	type OrchestratorRuntime,
	startWebServer,
} from '../../src/commands/web.ts';
import { ProviderCallError } from '../../src/runtime/agent-session.ts';
import type {
	OrchestratorCommand,
	OrchestratorTurnResult,
} from '../../src/runtime/conversational-orchestrator.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import type {
	OrchestratorHandoff,
	OrchestratorMessage,
	ProjectBrief,
	RunRecord,
} from '../../src/runtime/run-store.ts';
import { PROJECT_BRIEF_LIMITS, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const RUN_FIXTURE: RunRecord = {
	id: 'run-fixture-1',
	issueId: 'CAM-77',
	sessionId: 'session-fixture-1',
	providerId: 'claude',
	workspacePath: '/workspace',
	state: 'working',
	fixRounds: 0,
	createdAt: '2026-08-16T03:00:00.000Z',
	updatedAt: '2026-08-16T03:00:00.000Z',
	summary: null,
	error: null,
};

/** Conversation stub that answers every turn with one predetermined command. */
class FakeOrchestrator implements OrchestratorRuntime {
	readonly messages: OrchestratorMessage[] = [];
	readonly turns: string[] = [];

	constructor(
		readonly execute: (command: OrchestratorCommand) => Promise<string>,
		readonly command: OrchestratorCommand = { type: 'none' },
	) {}

	listMessages(): OrchestratorMessage[] {
		return [...this.messages];
	}

	async turn(text: string): Promise<OrchestratorTurnResult> {
		this.turns.push(text);
		const operator = {
			seq: this.messages.length + 1,
			providerId: 'claude' as const,
			role: 'operator' as const,
			text,
			createdAt: '2026-08-16T03:00:00.000Z',
		};
		const assistant = {
			seq: this.messages.length + 2,
			providerId: 'claude' as const,
			role: 'orchestrator' as const,
			text: 'Investiguei sem alterar o projeto.',
			createdAt: '2026-08-16T03:00:01.000Z',
		};
		this.messages.push(operator, assistant);
		if (this.command.type === 'none') {
			return { assistant, command: this.command, commandResult: null };
		}
		const commandResult = {
			seq: this.messages.length + 1,
			providerId: 'claude' as const,
			role: 'system' as const,
			text: await this.execute(this.command),
			createdAt: '2026-08-16T03:00:02.000Z',
		};
		this.messages.push(commandResult);
		return { assistant, command: this.command, commandResult };
	}

	async stop(): Promise<void> {}
}

describe('orchestrator web API', () => {
	test('returns a typed provider limit instead of a generic orchestrator failure', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-provider-limit-'),
			store: new RunStore(':memory:'),
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-provider-limit-cwd-'),
			runRuntime: runtime,
			orchestrator: () => ({
				listMessages: () => [],
				turn: async () => {
					throw new ProviderCallError(
						'claude',
						'usage-limit',
						'Claude usage limit reached.',
						{ retryAt: '2026-08-20T12:10:00.000Z' },
					);
				},
				stop: async () => {},
			}),
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const response = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ message: 'Continue.' }),
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				ok: false,
				code: 'provider-usage-limit',
				provider: 'claude',
				kind: 'usage-limit',
				retryAt: '2026-08-20T12:10:00.000Z',
			});
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	});

	test('persists the public conversation and protects the write by origin', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-api-'),
			store: new RunStore(':memory:'),
		});
		let orchestrator: FakeOrchestrator | undefined;
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-api-cwd-'),
			runRuntime: runtime,
			orchestrator: (execute) => {
				orchestrator = new FakeOrchestrator(execute);
				return orchestrator;
			},
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const forbidden = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Não deveria entrar.' }),
			});
			expect(forbidden.status).toBe(403);
			expect(orchestrator?.turns).toEqual([]);

			const posted = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: base,
				},
				body: JSON.stringify({ message: 'Investigue o core.' }),
			});
			expect(posted.status).toBe(200);
			expect(orchestrator?.turns).toEqual(['Investigue o core.']);

			const read = await fetch(`${base}/api/chat`);
			const payload = await read.json() as { messages: OrchestratorMessage[] };
			expect(payload.messages.map((message) => message.role)).toEqual([
				'operator',
				'orchestrator',
			]);
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	});

	test('create_and_start_issue publishes the issue and starts the run in one turn', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-create-start-'),
			store: new RunStore(':memory:'),
		});
		const created: Array<{ input: unknown; options: unknown }> = [];
		const started: string[] = [];
		runtime.startRun = (issueId: string) => {
			started.push(issueId);
			return { ...RUN_FIXTURE, issueId };
		};
		const command = {
			type: 'create_and_start_issue' as const,
			title: 'Publicar e iniciar em uma conversa',
			scope: 'Um comando tipado que registra a tarefa e começa a run.',
			verificationCommand: 'bun test test/web/orchestrator-api.test.ts',
		};
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-create-start-cwd-'),
			runRuntime: runtime,
			issueIntake: (input, options) => {
				created.push({ input, options });
				return { id: 'CAM-77', title: command.title, sha: 'create-start-sha' };
			},
			orchestrator: (execute) => new FakeOrchestrator(execute, command),
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const posted = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ message: 'Registre e comece agora.' }),
			});
			expect(posted.status).toBe(200);
			expect(created).toEqual([{ input: command, options: { approve: true } }]);
			expect(started).toEqual(['CAM-77']);

			const payload = await posted.json() as { turn: OrchestratorTurnResult };
			expect(payload.turn.commandResult?.text).toBe(
				'CAM-77 criada no backlog e run run-fixture-1 iniciada.',
			);
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	});

	test('create_issue publishes without approval', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-create-'),
			store: new RunStore(':memory:'),
		});
		const calls: Array<{ input: unknown; options: unknown }> = [];
		const command = {
			type: 'create_issue' as const,
			title: 'Somente publicar',
			scope: 'Registrar sem iniciar.',
			verificationCommand: 'bun test',
		};
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-create-cwd-'),
			runRuntime: runtime,
			issueIntake: (input, options) => {
				calls.push({ input, options });
				return { id: 'CAM-76', title: command.title, sha: 'create-sha' };
			},
			orchestrator: (execute) => new FakeOrchestrator(execute, command),
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const posted = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ message: 'Apenas registre.' }),
			});
			expect(posted.status).toBe(200);
			expect(calls).toEqual([{ input: command, options: undefined }]);
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	});

	test('approve_issue calls only the approver and does not start a run', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-approve-'), store: new RunStore(':memory:'),
		});
		const approved: string[] = [];
		let starts = 0;
		runtime.startRun = () => { starts += 1; throw new Error('must not start'); };
		const command = { type: 'approve_issue' as const, issueId: 'CAM-42' };
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-approve-cwd-'),
			runRuntime: runtime,
			issueApprover: (id) => {
				approved.push(id);
				return { id, title: 'Draft', sha: 'approved-sha' };
			},
			orchestrator: (execute) => new FakeOrchestrator(execute, command),
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const posted = await fetch(`${base}/api/chat`, {
				method: 'POST', headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ message: 'Aprove o draft.' }),
			});
			expect(posted.status).toBe(200);
			expect(approved).toEqual(['CAM-42']);
			expect(starts).toBe(0);
		} finally {
			await handle.stop(); await runtime.stop(); runtime.close();
		}
	});

	test('a failing start keeps the published id instead of a generic refusal', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-partial-'),
			store: new RunStore(':memory:'),
		});
		const created: unknown[] = [];
		let starts = 0;
		runtime.startRun = () => {
			starts += 1;
			throw new Error('run run-9 is still working; resume or finish it first');
		};
		const command = {
			type: 'create_and_start_issue' as const,
			title: 'Publicar e iniciar em uma conversa',
			scope: 'Um comando tipado que registra a tarefa e começa a run.',
			verificationCommand: 'bun test test/web/orchestrator-api.test.ts',
		};
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-partial-cwd-'),
			runRuntime: runtime,
			issueIntake: (input) => {
				created.push(input);
				return { id: 'CAM-78', title: command.title, sha: 'partial-sha' };
			},
			orchestrator: (execute) => new FakeOrchestrator(execute, command),
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const posted = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ message: 'Registre e comece agora.' }),
			});
			expect(posted.status).toBe(200);
			expect(created).toHaveLength(1);
			expect(starts).toBe(1);

			const payload = await posted.json() as { turn: OrchestratorTurnResult };
			const text = payload.turn.commandResult?.text ?? '';
			expect(text).toContain('CAM-78');
			expect(text).toContain('run run-9 is still working');
			expect(text).toContain('start_run com CAM-78');
			expect(text).not.toContain('Comando recusado');
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	});

	test('an abandon_issue turn reaches the injected abandoner and confirms it to the operator', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-abandon-'),
			store: new RunStore(':memory:'),
		});
		const abandoned: { id: string; input: unknown }[] = [];
		const command = {
			type: 'abandon_issue' as const,
			issueId: 'CAM-9',
			reason: 'O recurso saiu do produto na fatia anterior.',
		};
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-abandon-cwd-'),
			runRuntime: runtime,
			issueAbandoner: (id, input) => {
				abandoned.push({ id, input });
				return { id, title: 'fixture 9', sha: 'abandon-sha' };
			},
			orchestrator: (execute) => new FakeOrchestrator(execute, command),
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const posted = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ message: 'Abandone a CAM-9, ela perdeu o motivo.' }),
			});
			expect(posted.status).toBe(200);
			expect(abandoned).toEqual([{ id: 'CAM-9', input: command }]);

			const payload = await posted.json() as { turn: OrchestratorTurnResult };
			expect(payload.turn.commandResult?.text).toBe('CAM-9 abandonada no backlog.');
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	});
});

describe('project brief web API', () => {
	const BRIEF: ProjectBrief = {
		objective: 'Manter a intenção do produto sob controle do operador.',
		decisions: ['O brief é distinto do handoff automático.'],
		constraints: ['Somente o PUT altera o brief.'],
		openItems: ['Construir o editor web na fatia 2.'],
	};

	/** One server over a real store: the routes must reach durable state. */
	const withServer = async (
		body: (base: string, runtime: RunRuntime) => Promise<void>,
	): Promise<void> => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-brief-api-'),
			store: new RunStore(':memory:'),
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-brief-api-cwd-'),
			runRuntime: runtime,
			orchestrator: (execute) => new FakeOrchestrator(execute),
		});
		try {
			await body(`http://${handle.hostname}:${handle.port}`, runtime);
		} finally {
			await handle.stop();
			await runtime.stop();
			runtime.close();
		}
	};

	const HANDOFF: OrchestratorHandoff = {
		objective: 'Entregar o editor web do brief.',
		decisions: ['O handoff é escrito por turnos do orquestrador.'],
		constraints: ['A UI apenas lê o handoff.'],
		openItems: ['Renderizar os dois painéis em Ajustes.'],
	};

	const EMPTY = { objective: '', decisions: [], constraints: [], openItems: [] };

	test('GET reads the persisted brief and handoff without an Origin header', async () => {
		await withServer(async (base, runtime) => {
			const empty = await fetch(`${base}/api/brief`);
			expect(empty.status).toBe(200);
			expect(await empty.json()).toEqual({ brief: EMPTY, handoff: EMPTY });

			runtime.setProjectBrief(BRIEF);
			runtime.setOrchestratorHandoff(HANDOFF);
			const read = await fetch(`${base}/api/brief`);
			expect(read.status).toBe(200);
			// Both records travel on the one read, and the handoff is the durable
			// one the orchestrator turns wrote, not a copy of the brief.
			expect(await read.json()).toEqual({ brief: BRIEF, handoff: HANDOFF });
			expect(runtime.getOrchestratorHandoff()).toEqual(HANDOFF);
		});
	});

	test('the route offers no way to write the handoff', async () => {
		await withServer(async (base, runtime) => {
			runtime.setOrchestratorHandoff(HANDOFF);

			// The only write the route has takes a brief; a handoff sent along with
			// it is not a second record to store, and never reaches the durable one.
			const written = await fetch(`${base}/api/brief`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({
					...BRIEF,
					handoff: { ...EMPTY, objective: 'Reescrito pela UI.' },
				}),
			});
			expect(written.status).toBe(200);
			expect(await written.json()).toEqual({ ok: true, brief: BRIEF });
			expect(runtime.getOrchestratorHandoff()).toEqual(HANDOFF);

			for (const method of ['POST', 'PATCH', 'DELETE']) {
				const refused = await fetch(`${base}/api/brief`, {
					method,
					headers: { 'content-type': 'application/json', origin: base },
					body: JSON.stringify(HANDOFF),
				});
				expect(refused.ok).toBe(false);
			}
			expect(runtime.getOrchestratorHandoff()).toEqual(HANDOFF);
		});
	});

	test('a valid PUT stores the brief and answers with what was stored', async () => {
		await withServer(async (base, runtime) => {
			const written = await fetch(`${base}/api/brief`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ ...BRIEF, openItems: ['  ', ...BRIEF.openItems] }),
			});
			expect(written.status).toBe(200);
			expect(await written.json()).toEqual({ ok: true, brief: BRIEF });
			expect(runtime.getProjectBrief()).toEqual(BRIEF);
		});
	});

	test('an invalid PUT answers 400 and stores nothing', async () => {
		await withServer(async (base, runtime) => {
			runtime.setProjectBrief(BRIEF);
			const invalid: unknown[] = [
				'não é um objeto',
				{ ...BRIEF, objective: 42 },
				{ ...BRIEF, decisions: 'uma decisão solta' },
				{ ...BRIEF, constraints: [7] },
				{ ...BRIEF, objective: 'o'.repeat(PROJECT_BRIEF_LIMITS.objective + 1) },
				{
					...BRIEF,
					decisions: Array.from(
						{ length: PROJECT_BRIEF_LIMITS.listItems + 1 },
						(_, index) => `decisão ${index}`,
					),
				},
				{ ...BRIEF, openItems: ['i'.repeat(PROJECT_BRIEF_LIMITS.itemLength + 1)] },
			];
			for (const payload of invalid) {
				const rejected = await fetch(`${base}/api/brief`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json', origin: base },
					body: JSON.stringify(payload),
				});
				expect(rejected.status).toBe(400);
				const answer = await rejected.json() as { ok: boolean; code: string; message: string };
				expect(answer.ok).toBe(false);
				expect(answer.code).toBe('invalid-request');
				expect(answer.message.length).toBeGreaterThan(0);
			}
			expect(runtime.getProjectBrief()).toEqual(BRIEF);
		});
	});

	test('a cross-origin PUT is refused by the origin guard', async () => {
		await withServer(async (base, runtime) => {
			for (const origin of ['http://evil.example', undefined]) {
				const refused = await fetch(`${base}/api/brief`, {
					method: 'PUT',
					headers: {
						'content-type': 'application/json',
						...(origin === undefined ? {} : { origin }),
					},
					body: JSON.stringify(BRIEF),
				});
				expect(refused.status).toBe(403);
				expect(await refused.json()).toMatchObject({ ok: false, code: 'forbidden-origin' });
			}
			expect(runtime.getProjectBrief()).toEqual({
				objective: '',
				decisions: [],
				constraints: [],
				openItems: [],
			});
		});
	});
});

// GSHIP-635: pending proposals ride along in the orchestrator context as
// read-only science -- the operator's inbox stays the only place a proposal
// is dismissed or promoted.
describe('orchestrator context pending proposals', () => {
	function storeWithRun(id: string, issueId: string): RunStore {
		const store = new RunStore(':memory:');
		store.createRun({
			id,
			issueId,
			sessionId: `session-${id}`,
			workspacePath: `/workspaces/${id}`,
			createdAt: '2026-08-18T12:00:00.000Z',
		});
		return store;
	}

	test('with no pending proposals the context matches today\'s snapshot', () => {
		const cwd = createTestTmpdir('gship-orchestrator-context-idle-');
		const runtime = new RunRuntime({ cwd, store: new RunStore(':memory:') });
		runtime.setOperatorProfile({ name: 'Eduardo', timezone: 'America/Sao_Paulo' });
		const context = buildOrchestratorContext(cwd, runtime) as Record<string, unknown>;

		expect(Object.keys(context)).toEqual([
			'provider',
			'operatorProfile',
			'backlog',
			'runs',
			'workspaceNotices',
		]);
		expect(context.provider).toBe(runtime.getSelectedProvider());
		expect(context.operatorProfile).toEqual({
			name: 'Eduardo',
			timezone: 'America/Sao_Paulo',
		});
		expect(context.runs).toEqual(runtime.listRuns(10));
		expect(context.workspaceNotices).toEqual(runtime.listWorkspaceNotices());
		expect(context.pendingProposals).toBeUndefined();
	});

	test('pending proposals ride along, read through the same listPendingProposals the inbox uses', () => {
		const cwd = createTestTmpdir('gship-orchestrator-context-proposals-');
		const store = storeWithRun('run-proposals-1', 'CAM-10');
		const runtime = new RunRuntime({ cwd, store });
		store.recordProposals({
			runId: 'run-proposals-1',
			issueId: 'CAM-10',
			proposals: [
				{ title: 'Extrair o parser de eventos', evidence: 'Duplicado em dois adaptadores.' },
				{ title: 'Cobrir o caminho de erro do shipper', evidence: 'Sem teste para retry.' },
			],
			createdAt: '2026-08-18T12:05:00.000Z',
		});
		expect(runtime.listPendingProposals().map((proposal) => proposal.title)).toEqual([
			'Extrair o parser de eventos',
			'Cobrir o caminho de erro do shipper',
		]);

		const context = buildOrchestratorContext(cwd, runtime) as Record<string, unknown>;
		expect(context.pendingProposals).toEqual({
			pending: [
				{
					id: 'run-proposals-1-proposal-1',
					title: 'Extrair o parser de eventos',
					evidence: 'Duplicado em dois adaptadores.',
					sourceIssueId: 'CAM-10',
					sourceRunId: 'run-proposals-1',
					createdAt: '2026-08-18T12:05:00.000Z',
				},
				{
					id: 'run-proposals-1-proposal-2',
					title: 'Cobrir o caminho de erro do shipper',
					evidence: 'Sem teste para retry.',
					sourceIssueId: 'CAM-10',
					sourceRunId: 'run-proposals-1',
					createdAt: '2026-08-18T12:05:00.000Z',
				},
			],
			omittedCount: 0,
		});
	});

	test('truncates the window to the most recent proposals and reports how many were left out', () => {
		const cwd = createTestTmpdir('gship-orchestrator-context-truncate-');
		const store = storeWithRun('run-proposals-2', 'CAM-11');
		const runtime = new RunRuntime({ cwd, store });
		// recordProposals caps each call at PROPOSAL_LIMITS.maxItems (3), so three
		// calls on the same run accumulate eight pending proposals in total.
		store.recordProposals({
			runId: 'run-proposals-2', issueId: 'CAM-11', createdAt: '2026-08-18T12:10:00.000Z',
			proposals: [1, 2, 3].map((n) => ({ title: `Ideia ${n}`, evidence: `Evidência ${n}.` })),
		});
		store.recordProposals({
			runId: 'run-proposals-2', issueId: 'CAM-11', createdAt: '2026-08-18T12:11:00.000Z',
			proposals: [4, 5, 6].map((n) => ({ title: `Ideia ${n}`, evidence: `Evidência ${n}.` })),
		});
		store.recordProposals({
			runId: 'run-proposals-2', issueId: 'CAM-11', createdAt: '2026-08-18T12:12:00.000Z',
			proposals: [7, 8].map((n) => ({ title: `Ideia ${n}`, evidence: `Evidência ${n}.` })),
		});
		expect(runtime.listPendingProposals()).toHaveLength(8);

		const context = buildOrchestratorContext(cwd, runtime) as Record<string, unknown>;
		const pendingProposals = context.pendingProposals as { pending: { title: string }[]; omittedCount: number };
		expect(pendingProposals.pending.map((proposal) => proposal.title)).toEqual([
			'Ideia 4', 'Ideia 5', 'Ideia 6', 'Ideia 7', 'Ideia 8',
		]);
		expect(pendingProposals.omittedCount).toBe(3);
	});

	test('truncates a long evidence string to the explicit context limit instead of the full stored text', () => {
		const cwd = createTestTmpdir('gship-orchestrator-context-evidence-');
		const store = storeWithRun('run-proposals-3', 'CAM-12');
		const runtime = new RunRuntime({ cwd, store });
		const fullEvidence = 'e'.repeat(500);
		store.recordProposals({
			runId: 'run-proposals-3',
			issueId: 'CAM-12',
			proposals: [{ title: 'Ideia com evidência longa', evidence: fullEvidence }],
			createdAt: '2026-08-18T12:15:00.000Z',
		});

		const context = buildOrchestratorContext(cwd, runtime) as Record<string, unknown>;
		const pendingProposals = context.pendingProposals as { pending: { evidence: string }[] };
		const evidence = pendingProposals.pending[0]?.evidence ?? '';
		expect(evidence).not.toBe(fullEvidence);
		expect(evidence.length).toBeLessThan(fullEvidence.length);
		expect(evidence.startsWith('e'.repeat(200))).toBe(true);
	});
});
