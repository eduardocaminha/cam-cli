import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
import { IssueIntakeError } from '../../src/runtime/issue-intake.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

describe('operator issue intake API', () => {
	test('creates a validated issue only for a trusted same-origin request', async () => {
		const received: unknown[] = [];
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-intake-api-'),
			runRuntime: runtime,
			issueIntake: (input) => {
				received.push(input);
				return { id: 'CAM-700', title: 'Intake web', sha: 'abc1234' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const body = {
			title: '  Intake web  ',
			scope: '  Criar uma tarefa sem planner.  ',
			verificationCommand: '  bun test test/web/issue-intake-api.test.ts  ',
		};

		try {
			const forbidden = await fetch(`${origin}/api/issues`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(forbidden.status).toBe(403);
			expect(received).toEqual([]);

			const response = await fetch(`${origin}/api/issues`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(201);
			expect(await response.json()).toMatchObject({
				ok: true,
				issue: { id: 'CAM-700', title: 'Intake web' },
			});
			expect(received).toEqual([{
				title: 'Intake web',
				scope: 'Criar uma tarefa sem planner.',
				verificationCommand: 'bun test test/web/issue-intake-api.test.ts',
			}]);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects an incomplete contract before calling the writer', async () => {
		let calls = 0;
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-intake-invalid-'),
			runRuntime: runtime,
			issueIntake: () => {
				calls += 1;
				return { id: 'CAM-1', title: 'unreachable', sha: 'abc1234' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const response = await fetch(`${origin}/api/issues`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ title: '', scope: 'scope', verificationCommand: 'bun test' }),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: 'invalid-request' });
			expect(calls).toBe(0);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('promotes an existing idea through the same trusted operator contract', async () => {
		const received: unknown[] = [];
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-specify-api-'),
			runRuntime: runtime,
			issueSpecifier: (id, input) => {
				received.push({ id, input });
				return { id, title: 'Ideia antiga', sha: 'abc1234' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const response = await fetch(`${origin}/api/issues/CAM-42/spec`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ scope: '  Escopo direto.  ', verificationCommand: '  bun test  ' }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				issue: { id: 'CAM-42', title: 'Ideia antiga' },
			});
			expect(received).toEqual([{
				id: 'CAM-42',
				input: { scope: 'Escopo direto.', verificationCommand: 'bun test' },
			}]);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	// GSHIP-613: the same intake writes the promoted proposal, and only a filed
	// issue settles it. Nothing here approves or starts anything.
	test('promotes a pending proposal into an unapproved issue and settles it once', async () => {
		const received: unknown[] = [];
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({ cwd: '/project', store });
		store.createRun({
			id: 'run-1',
			issueId: 'CAM-50',
			sessionId: 'session-1',
			workspacePath: '/workspaces/run-1',
			createdAt: '2026-08-16T22:00:00.000Z',
		});
		store.recordProposals({
			runId: 'run-1',
			issueId: 'CAM-50',
			proposals: [{ title: 'Cobrir o retry do shipper', evidence: 'Sem teste no caminho de erro.' }],
			createdAt: '2026-08-16T22:10:00.000Z',
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-promote-api-'),
			runRuntime: runtime,
			issueIntake: (input, options) => {
				received.push({ input, options });
				return { id: 'CAM-950', title: 'Cobrir o retry do shipper', sha: 'abc1234' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const body = {
			title: '  Cobrir o retry do shipper  ',
			scope: '  Adicionar o teste que falta.  ',
			verificationCommand: '  bun test test/runtime/run-ship.test.ts  ',
		};
		try {
			const forbidden = await fetch(`${origin}/api/proposals/run-1-proposal-1/promote`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(forbidden.status).toBe(403);
			expect(received).toEqual([]);

			const listed = await fetch(`${origin}/api/proposals`);
			expect(await listed.json()).toMatchObject({
				proposals: [{
					id: 'run-1-proposal-1',
					status: 'pending',
					title: 'Cobrir o retry do shipper',
					evidence: 'Sem teste no caminho de erro.',
					sourceRunId: 'run-1',
					sourceIssueId: 'CAM-50',
				}],
			});

			const response = await fetch(`${origin}/api/proposals/run-1-proposal-1/promote`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				issue: { id: 'CAM-950' },
				proposal: { id: 'run-1-proposal-1', status: 'promoted', promotedIssueId: 'CAM-950' },
			});
			// The operator's contract reached the intake, and it was never approved.
			expect(received).toEqual([{
				input: {
					title: 'Cobrir o retry do shipper',
					scope: 'Adicionar o teste que falta.',
					verificationCommand: 'bun test test/runtime/run-ship.test.ts',
				},
				options: { approve: false },
			}]);
			expect(runtime.listRuns()).toHaveLength(1);

			// A settled proposal leaves the inbox and files nothing on a second try.
			expect(await (await fetch(`${origin}/api/proposals`)).json()).toEqual({ proposals: [] });
			const again = await fetch(`${origin}/api/proposals/run-1-proposal-1/promote`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(again.status).toBe(409);
			expect(await again.json()).toMatchObject({ code: 'proposal-not-pending' });
			expect(received).toHaveLength(1);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('a failing intake leaves the proposal pending, and dismissing needs no issue', async () => {
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({ cwd: '/project', store });
		store.createRun({
			id: 'run-2',
			issueId: 'CAM-51',
			sessionId: 'session-2',
			workspacePath: '/workspaces/run-2',
			createdAt: '2026-08-16T22:00:00.000Z',
		});
		store.recordProposals({
			runId: 'run-2',
			issueId: 'CAM-51',
			proposals: [
				{ title: 'Ideia que falha ao publicar', evidence: 'Vista na rodada de correção.' },
				{ title: 'Ideia descartável', evidence: 'Já resolvida em outro lugar.' },
			],
			createdAt: '2026-08-16T22:10:00.000Z',
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-promote-failure-'),
			runRuntime: runtime,
			issueIntake: () => {
				throw new IssueIntakeError(
					'publish-conflict',
					'O backlog avançou durante três tentativas; tente criar a tarefa novamente.',
					409,
				);
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const failed = await fetch(`${origin}/api/proposals/run-2-proposal-1/promote`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Publicar', scope: 'Escopo.', verificationCommand: 'bun test' }),
			});
			expect(failed.status).toBe(409);
			expect(await failed.json()).toMatchObject({ code: 'publish-conflict' });
			expect(store.getProposal('run-2-proposal-1')?.status).toBe('pending');

			// An incomplete contract is refused before the proposal is even read.
			const invalid = await fetch(`${origin}/api/proposals/run-2-proposal-1/promote`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Sem comando', scope: 'Escopo.', verificationCommand: '' }),
			});
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({ code: 'invalid-request' });

			const unknown = await fetch(`${origin}/api/proposals/run-2-proposal-9/promote`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Fantasma', scope: 'Escopo.', verificationCommand: 'bun test' }),
			});
			expect(unknown.status).toBe(404);
			expect(await unknown.json()).toMatchObject({ code: 'proposal-not-found' });

			const forbidden = await fetch(`${origin}/api/proposals/run-2-proposal-2/dismiss`, {
				method: 'POST',
			});
			expect(forbidden.status).toBe(403);
			expect(store.getProposal('run-2-proposal-2')?.status).toBe('pending');

			const dismissed = await fetch(`${origin}/api/proposals/run-2-proposal-2/dismiss`, {
				method: 'POST',
				headers: { origin },
			});
			expect(dismissed.status).toBe(200);
			expect(await dismissed.json()).toMatchObject({
				ok: true,
				proposal: { id: 'run-2-proposal-2', status: 'dismissed', promotedIssueId: null },
			});

			const repeated = await fetch(`${origin}/api/proposals/run-2-proposal-2/dismiss`, {
				method: 'POST',
				headers: { origin },
			});
			expect(repeated.status).toBe(409);
			expect(await repeated.json()).toMatchObject({ code: 'proposal-not-pending' });

			// The still-pending proposal is the only one left in the inbox.
			expect(await (await fetch(`${origin}/api/proposals`)).json()).toMatchObject({
				proposals: [{ id: 'run-2-proposal-1' }],
			});
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('approves only through the trusted same-origin endpoint', async () => {
		const received: string[] = [];
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-approve-api-'),
			runRuntime: runtime,
			issueApprover: (id) => {
				received.push(id);
				return { id, title: 'Draft', sha: 'approved-sha' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const forbidden = await fetch(`${origin}/api/issues/CAM-42/approve`, { method: 'POST' });
			expect(forbidden.status).toBe(403);
			expect(received).toEqual([]);
			const response = await fetch(`${origin}/api/issues/CAM-42/approve`, {
				method: 'POST', headers: { origin },
			});
			expect(response.status).toBe(200);
			expect(received).toEqual(['CAM-42']);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});
});
