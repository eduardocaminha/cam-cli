import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
import { IssueIntakeError } from '../../src/runtime/issue-intake.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
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

	test('creates one approved issue only through the explicit authorized endpoint', async () => {
		const received: Array<{ input: unknown; options: unknown }> = [];
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-approved-intake-api-'),
			runRuntime: runtime,
			issueIntake: (input, options) => {
				received.push({ input, options });
				return { id: 'CAM-701', title: 'Approved intake', sha: 'abc1234' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const contract = {
			title: '  Approved intake  ',
			scope: '  Publicar uma única versão aprovada.  ',
			verificationCommand: '  bun test test/web/issue-intake-api.test.ts  ',
		};
		try {
			const missing = await fetch(`${origin}/api/issues/create-approved`, {
				method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(contract),
			});
			expect(missing.status).toBe(403);
			expect(await missing.json()).toMatchObject({ code: 'authorization-required' });
			expect(received).toEqual([]);

			const created = await fetch(`${origin}/api/issues/create-approved`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ ...contract, authorization: 'A operadora aprova este contrato.' }),
			});
			expect(created.status).toBe(201);
			expect(await created.json()).toMatchObject({ ok: true, issue: { id: 'CAM-701' } });
			expect(received).toEqual([{
				input: {
					title: 'Approved intake',
					scope: 'Publicar uma única versão aprovada.',
					verificationCommand: 'bun test test/web/issue-intake-api.test.ts',
				},
				options: { approve: true },
			}]);
			expect(runtime.listRuns()).toEqual([]);
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

	// GSHIP-614: the issue file belongs to the run while it is in flight, so the
	// routes that rewrite it on main refuse instead of guaranteeing a conflict
	// when the run ships.
	test('refuses to revise, approve or abandon an issue a non-terminal run owns', async () => {
		const specified: string[] = [];
		const approved: string[] = [];
		const abandoned: string[] = [];
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({ cwd: '/project', store });
		store.createRun({
			id: 'run-1',
			issueId: 'CAM-42',
			sessionId: 'session-1',
			workspacePath: '/workspaces/run-1',
			createdAt: '2026-08-16T22:00:00.000Z',
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-issue-owned-'),
			runRuntime: runtime,
			issueSpecifier: (id) => {
				specified.push(id);
				return { id, title: 'Draft', sha: 'specified-sha' };
			},
			issueApprover: (id) => {
				approved.push(id);
				return { id, title: 'Draft', sha: 'approved-sha' };
			},
			issueAbandoner: (id) => {
				abandoned.push(id);
				return { id, title: 'Draft', sha: 'abandoned-sha' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const spec = { scope: 'Escopo revisado.', verificationCommand: 'bun test' };
		try {
			const revise = await fetch(`${origin}/api/issues/CAM-42/spec`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify(spec),
			});
			expect(revise.status).toBe(409);
			expect(await revise.json()).toMatchObject({ ok: false, code: 'issue-run-active' });

			const approve = await fetch(`${origin}/api/issues/CAM-42/approve`, {
				method: 'POST', headers: { origin },
			});
			expect(approve.status).toBe(409);
			expect(await approve.json()).toMatchObject({ ok: false, code: 'issue-run-active' });

			const abandon = await fetch(`${origin}/api/issues/CAM-42/abandon`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ reason: 'Não faz mais sentido.' }),
			});
			expect(abandon.status).toBe(409);
			expect(await abandon.json()).toMatchObject({ ok: false, code: 'issue-run-active' });

			// Nothing reached git, and another issue is untouched by this run.
			expect(specified).toEqual([]);
			expect(approved).toEqual([]);
			expect(abandoned).toEqual([]);
			const other = await fetch(`${origin}/api/issues/CAM-43/approve`, {
				method: 'POST', headers: { origin },
			});
			expect(other.status).toBe(200);
			expect(approved).toEqual(['CAM-43']);

			// A settled run owns nothing, so the same issue is writable again.
			store.transition({
				runId: 'run-1',
				toState: 'interrupted',
				kind: 'run.cancelled',
				createdAt: '2026-08-16T22:10:00.000Z',
			});
			const stillOwned = await fetch(`${origin}/api/issues/CAM-42/approve`, {
				method: 'POST', headers: { origin },
			});
			expect(stillOwned.status).toBe(409);

			store.transition({
				runId: 'run-1',
				toState: 'cancelled',
				kind: 'run.abandoned',
				createdAt: '2026-08-16T22:20:00.000Z',
			});
			const released = await fetch(`${origin}/api/issues/CAM-42/abandon`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ reason: 'Não faz mais sentido.' }),
			});
			expect(released.status).toBe(200);
			expect(abandoned).toEqual(['CAM-42']);
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

	test('agent approval requires explicit authorization and the current fingerprint', async () => {
		const received: string[] = [];
		const spec = { scope: 'Implement the bounded change.', verify: ['bun test'] };
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-agent-approve-api-'),
			runRuntime: runtime,
			issueReader: (id) => ({
				id,
				title: 'Agent approval',
				stage: 'specified',
				status: 'open',
				blockedBy: [],
				createdAt: '2026-08-22T00:00:00.000Z',
				updatedAt: '2026-08-22T00:00:00.000Z',
				spec,
			}),
			issueApprover: (id) => {
				received.push(id);
				return { id, title: 'Agent approval', sha: 'approved-sha' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const headers = {
			origin,
			'content-type': 'application/json',
			'x-gateship-command-source': 'agent-cli',
		};
		try {
			const read = await fetch(`${origin}/api/issues/GSHIP-690`);
			expect(read.status).toBe(200);
			expect(await read.json()).toMatchObject({
				issue: { id: 'GSHIP-690', spec },
				fingerprint: fingerprintSpec(spec),
			});

			const missing = await fetch(`${origin}/api/issues/GSHIP-690/approve`, {
				method: 'POST', headers, body: JSON.stringify({ fingerprint: fingerprintSpec(spec) }),
			});
			expect(missing.status).toBe(403);
			expect(await missing.json()).toMatchObject({ code: 'authorization-required' });

			const stale = await fetch(`${origin}/api/issues/GSHIP-690/approve`, {
				method: 'POST', headers, body: JSON.stringify({ fingerprint: 'stale', authorization: 'I approve this issue.' }),
			});
			expect(stale.status).toBe(409);
			expect(await stale.json()).toMatchObject({ code: 'fingerprint-mismatch' });

			const approved = await fetch(`${origin}/api/issues/GSHIP-690/approve`, {
				method: 'POST', headers,
				body: JSON.stringify({ fingerprint: fingerprintSpec(spec), authorization: 'I approve this issue.' }),
			});
			expect(approved.status).toBe(200);
			expect(received).toEqual(['GSHIP-690']);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('abandons an open issue with a justification, only through the trusted origin', async () => {
		const received: unknown[] = [];
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-abandon-api-'),
			runRuntime: runtime,
			issueAbandoner: (id, input) => {
				received.push({ id, input });
				return { id, title: 'Draft', sha: 'abandoned-sha' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const body = { reason: '  Não é mais necessário.  ' };
		try {
			const forbidden = await fetch(`${origin}/api/issues/CAM-42/abandon`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(forbidden.status).toBe(403);
			expect(received).toEqual([]);

			const response = await fetch(`${origin}/api/issues/CAM-42/abandon`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				issue: { id: 'CAM-42', title: 'Draft' },
			});
			expect(received).toEqual([{
				id: 'CAM-42',
				input: { reason: 'Não é mais necessário.' },
			}]);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects an empty justification before calling the abandon writer', async () => {
		let calls = 0;
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-abandon-invalid-'),
			runRuntime: runtime,
			issueAbandoner: (id) => {
				calls += 1;
				return { id, title: 'unreachable', sha: 'abc1234' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const response = await fetch(`${origin}/api/issues/CAM-42/abandon`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ reason: '   ' }),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: 'invalid-request' });
			expect(calls).toBe(0);
		} finally {
			await handle.stop();
			runtime.close();
		}
	});
});
