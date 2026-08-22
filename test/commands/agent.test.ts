import { describe, expect, test } from 'bun:test';

import {
	AGENT_DEFAULT_PAGE_MAX_OUTPUT_BYTES,
	AGENT_MAX_OUTPUT_BYTES,
	executeAgent,
	parseAgentArgs,
} from '../../src/commands/agent.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import { startWebServer } from '../../src/commands/web.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { type ProjectBrief, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const jsonResponse = (body: unknown, status = 200): Response => Response.json(body, { status });
const PROJECT_ID = 'project-1';

describe('canonical agent CLI', () => {
	test('parses call input and an explicit local service URL', () => {
		expect(parseAgentArgs([
			'call', 'issues.get', '--input', '{"issueId":"GSHIP-690"}', '--url=http://localhost:7788',
		])).toEqual({
			command: 'call',
			operation: 'issues.get',
			input: { issueId: 'GSHIP-690' },
			url: 'http://localhost:7788',
		});
		expect(() => parseAgentArgs(['call', 'status.get', '--url', 'https://example.com']))
			.toThrow('must target');
		expect(() => parseAgentArgs(['call', 'status.get', '--input', '[]']))
			.toThrow('one JSON object');
	});

	test('prints a short stable guide without contacting or starting a service', async () => {
		let calls = 0;
		const result = await executeAgent(['guide'], async () => {
			calls += 1;
			return jsonResponse({});
		});
		expect(result.exitCode).toBe(0);
		expect(calls).toBe(0);
		expect(result.output).toMatchObject({ ok: true, version: 'v1' });
		const guide = result.output['guide'];
		expect(typeof guide).toBe('string');
		expect(String(guide).length).toBeLessThan(800);
		expect(guide).toContain('Never edit .gship directly');
		expect(guide).toContain('Never invent operator approval');
	});

	test('discovers operation names and formats only on demand', async () => {
		const result = await executeAgent(['operations']);
		const operations = result.output['operations'] as Array<{ name: string; input: string }>;
		expect(operations.map(({ name }) => name)).toEqual([
			'project.inspect', 'projects.list', 'projects.status', 'status.get', 'backlog.list', 'issues.list', 'issues.get',
			'runs.list', 'runs.get', 'runs.events', 'issues.create', 'issues.specify', 'issues.approve',
			'issues.abandon', 'brief.get', 'brief.update', 'runs.start', 'runs.respond',
			'runs.cancel', 'runs.abandon', 'runs.ship',
		]);
		expect(operations.find(({ name }) => name === 'issues.approve')?.input)
			.toContain('fingerprint');
		for (const operation of operations.filter(({ name }) =>
			!['project.inspect', 'projects.list', 'projects.status'].includes(name))) {
			expect(operation.input).toContain('projectId');
		}
	});

	test('requires projectId for every project lifecycle call', async () => {
		const result = await executeAgent([
			'call', 'issues.get', '--input', '{"issueId":"GSHIP-698"}',
		]);
		expect(result).toMatchObject({
			exitCode: 1,
			output: { ok: false, code: 'invalid-input', message: expect.stringContaining('projectId') },
		});
	});

	test('reads one registered project status by id without accepting locations', async () => {
		let requested = '';
		const result = await executeAgent([
			'call', 'projects.status', '--input', '{"projectId":"project / 1","root":"/ignored"}',
		], async (url, init) => {
			requested = String(url);
			expect(init?.method).toBe('GET');
			return jsonResponse({ project: { id: 'project / 1' }, root: { state: 'available' } });
		});
		expect(requested).toBe('http://127.0.0.1:7777/api/projects/project%20%2F%201/status');
		expect(result.output).toMatchObject({
			ok: true,
			operation: 'projects.status',
			result: { project: { id: 'project / 1' }, root: { state: 'available' } },
		});
	});

	test('lists projects through the compact read-only operation', async () => {
		let requested = '';
		const result = await executeAgent(['call', 'projects.list'], async (url, init) => {
			requested = String(url);
			expect(init?.method).toBe('GET');
			return jsonResponse({ projects: [{
				id: 'project-1', name: 'gateship', root: '/workspace', stateDir: '/state',
				readiness: 'ready', repository: 'gateship-dev/gateship', current: true,
			}] });
		});
		expect(requested).toBe('http://127.0.0.1:7777/api/projects');
		expect(result.output).toMatchObject({
			ok: true,
			result: { projects: [{ id: 'project-1', current: true }] },
		});
	});

	test('keeps default discovery pages compact and reserves detail for get operations', async () => {
		const detail = 'd'.repeat(5_000);
		// A NUL costs six bytes once JSON-escaped. Saturating every retained string
		// proves the page budget itself instead of relying on the large fields that
		// list projection removes altogether.
		const retained = '\0'.repeat(5_000);
		const blockers = Array.from({ length: 20 }, (_, index) => `GSHIP-BLOCKER-${index}`);
		const spec = { scope: detail, verify: [detail], evidence: [{ command: 'inspect', output: detail }] };
		const issues = Array.from({ length: 20 }, (_, index) => ({
			id: `${index}${retained}`,
			title: retained,
			stage: retained,
			status: retained,
			blockedBy: index === 0 ? blockers : [],
			updatedAt: retained,
			description: detail,
			spec,
			approval: { fingerprint: fingerprintSpec(spec), approvedAt: '2026-08-22T10:00:00.000Z' },
		}));
		const runs = Array.from({ length: 20 }, (_, index) => ({
			id: `${index}${retained}`,
			issueId: retained,
			state: retained,
			providerId: retained,
			fixRounds: index,
			updatedAt: retained,
			summary: retained,
			workspacePath: detail,
			sessionId: detail,
			cost: { breakdown: [{ model: detail }], roles: { executor: detail } },
			roundOrigins: { rounds: [detail] },
			pullRequest: { url: retained, ciStatus: retained, prNumber: index },
		}));

		const listedIssues = await executeAgent(
			['call', 'issues.list', '--input', `{"projectId":"${PROJECT_ID}"}`],
			async () => jsonResponse({ issues }),
		);
		const listedRuns = await executeAgent(
			['call', 'runs.list', '--input', `{"projectId":"${PROJECT_ID}"}`],
			async () => jsonResponse({ runs }),
		);
		for (const result of [listedIssues, listedRuns]) {
			expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThan(AGENT_DEFAULT_PAGE_MAX_OUTPUT_BYTES);
		}
		const issueItem = ((listedIssues.output['result'] as { issues: Record<string, unknown>[] }).issues[0])!;
		expect(Object.keys(issueItem)).toEqual([
			'id', 'title', 'stage', 'status', 'blockedBy', 'updatedAt', 'approved',
		]);
		expect(issueItem).not.toHaveProperty('description');
		expect(issueItem).not.toHaveProperty('spec');
		expect(issueItem).not.toHaveProperty('approval');
		expect(issueItem['blockedBy']).toEqual(blockers);
		const runItem = ((listedRuns.output['result'] as { runs: Record<string, unknown>[] }).runs[0])!;
		expect(Object.keys(runItem)).toEqual([
			'id', 'issueId', 'state', 'providerId', 'fixRounds', 'updatedAt', 'summary', 'pullRequest',
		]);
		expect(runItem).not.toHaveProperty('workspacePath');
		expect(runItem).not.toHaveProperty('sessionId');
		expect(runItem).not.toHaveProperty('cost');

		const detailedIssue = {
			...issues[1],
			id: 'GSHIP-1',
			title: 'Issue detail',
			stage: 'specified',
			status: 'open',
			blockedBy: [],
			updatedAt: '2026-08-22T10:00:00.000Z',
		};
		const detailedRun = {
			...runs[1],
			id: 'run-1',
			issueId: 'GSHIP-1',
			state: 'done',
			providerId: 'codex',
			updatedAt: '2026-08-22T10:00:00.000Z',
			summary: detail,
			pullRequest: { url: 'https://example.com/1', ciStatus: 'success' },
		};
		const issueDetail = await executeAgent(
			['call', 'issues.get', '--input', `{"projectId":"${PROJECT_ID}","issueId":"GSHIP-1"}`],
			async () => jsonResponse({ issue: detailedIssue, fingerprint: fingerprintSpec(spec) }),
		);
		const runDetail = await executeAgent(
			['call', 'runs.get', '--input', `{"projectId":"${PROJECT_ID}","runId":"run-1"}`],
			async () => jsonResponse({ run: detailedRun }),
		);
		expect(issueDetail.output['result']).toHaveProperty('issue.spec');
		expect(issueDetail.output['result']).toHaveProperty('issue.spec.evidence');
		expect(issueDetail.output['result']).toHaveProperty('fingerprint');
		expect(runDetail.output['result']).toHaveProperty('run.workspacePath');
		expect(Buffer.byteLength(JSON.stringify(runDetail.output))).toBeLessThanOrEqual(AGENT_MAX_OUTPUT_BYTES);
	});

	test('preserves more than one hundred blockers instead of silently clamping them', async () => {
		const blockers = Array.from({ length: 125 }, (_, index) => `GSHIP-${1_000 + index}`);
		const result = await executeAgent([
			'call', 'issues.list', '--input', `{"projectId":"${PROJECT_ID}"}`,
		], async () => jsonResponse({
			issues: [{
				id: 'GSHIP-691',
				title: 'Compact agent output',
				stage: 'specified',
				status: 'open',
				blockedBy: blockers,
				updatedAt: '2026-08-22T10:00:00.000Z',
			}],
		}));
		const issue = ((result.output['result'] as { issues: Array<{ blockedBy: string[] }> }).issues[0])!;
		expect(issue.blockedBy).toEqual(blockers);
	});

	test('refuses oversized issue pages without returning partial blockers', async () => {
		const issueWith = (blockedBy: string[]) => ({
			issues: [{
				id: 'GSHIP-691',
				title: 'Compact agent output',
				stage: 'specified',
				status: 'open',
				blockedBy,
				updatedAt: '2026-08-22T10:00:00.000Z',
			}],
		});
		const overDefaultBudget = Array.from(
			{ length: 40 },
			(_, index) => `GSHIP-${index}-${'b'.repeat(400)}`,
		);
		const defaultPage = await executeAgent(
			['call', 'issues.list', '--input', `{"projectId":"${PROJECT_ID}"}`],
			async () => jsonResponse(issueWith(overDefaultBudget)),
		);
		expect(defaultPage).toMatchObject({
			exitCode: 1,
			output: { ok: false, code: 'output-too-large', message: expect.stringContaining('smaller explicit "limit"') },
		});
		expect(defaultPage.output).not.toHaveProperty('result');
		expect(Buffer.byteLength(JSON.stringify(defaultPage.output))).toBeLessThan(AGENT_DEFAULT_PAGE_MAX_OUTPUT_BYTES);

		const explicitPage = await executeAgent(
			['call', 'issues.list', '--input', `{"projectId":"${PROJECT_ID}","limit":1}`],
			async () => jsonResponse(issueWith(overDefaultBudget)),
		);
		expect(explicitPage.exitCode).toBe(0);
		const complete = ((explicitPage.output['result'] as { issues: Array<{ blockedBy: string[] }> }).issues[0])!;
		expect(complete.blockedBy).toEqual(overDefaultBudget);

		const overGlobalBudget = Array.from(
			{ length: 100 },
			(_, index) => `GSHIP-${index}-${'b'.repeat(1_000)}`,
		);
		const globalLimit = await executeAgent(
			['call', 'issues.list', '--input', `{"projectId":"${PROJECT_ID}","limit":1}`],
			async () => jsonResponse(issueWith(overGlobalBudget)),
		);
		expect(globalLimit).toMatchObject({ exitCode: 1, output: { ok: false, code: 'output-too-large' } });
		expect(globalLimit.output).not.toHaveProperty('result');
		expect(Buffer.byteLength(JSON.stringify(globalLimit.output))).toBeLessThanOrEqual(AGENT_MAX_OUTPUT_BYTES);
	});

	test('projects status to backlog counts, discovery rows, active run and attention only', async () => {
		const detail = 's'.repeat(5_000);
		const calls: string[] = [];
		const result = await executeAgent([
			'call', 'status.get', '--input', `{"projectId":"${PROJECT_ID}"}`,
		], async (url) => {
			calls.push(String(url));
			if (String(url).endsWith('/runs')) {
				return jsonResponse({ runs: [{
					id: 'run-active', issueId: 'GSHIP-691', state: 'waiting-user', providerId: 'codex',
					fixRounds: 0, updatedAt: '2026-08-22T10:00:00.000Z', summary: detail,
					workspacePath: detail, sessionId: detail,
				}] });
			}
			return jsonResponse({
				version: '0.321.0',
				idleState: { backlog: {
					counts: { idea: 1, specified: 2, planned: 3 },
					plannable: [{ id: 'GSHIP-691', title: 'Compact output', scope: detail, evidence: detail }],
					drafts: [{ id: 'GSHIP-691', scope: detail, evidence: detail, spec: detail }],
				} },
				workspaceNotices: [{ kind: 'dirty', runId: 'run-old', detail, workspacePath: detail }],
			});
		});
		expect(calls).toEqual([
			`http://127.0.0.1:7777/api/projects/${PROJECT_ID}/snapshot`,
			`http://127.0.0.1:7777/api/projects/${PROJECT_ID}/runs`,
		]);
		expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThan(12 * 1024);
		const status = result.output['result'] as Record<string, unknown>;
		expect(status).toMatchObject({
			version: '0.321.0',
			backlog: { counts: { idea: 1, specified: 2, planned: 3 }, plannable: [{ id: 'GSHIP-691', title: 'Compact output' }] },
			activeRun: { id: 'run-active', issueId: 'GSHIP-691', state: 'waiting-user' },
			attentionRequests: [{ kind: 'run', runId: 'run-active' }, { kind: 'dirty', runId: 'run-old' }],
		});
		expect(JSON.stringify(status)).not.toContain('workspacePath');
		expect(JSON.stringify(status)).not.toContain('drafts');
		expect(JSON.stringify(status)).not.toContain('evidence');
		expect(JSON.stringify(status)).not.toContain('scope');
	});

	test('calls read-only operations and pages list results', async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const result = await executeAgent([
			'call', 'runs.list', '--input', `{"projectId":"${PROJECT_ID}","offset":1,"limit":1}`,
			'--url', 'http://127.0.0.1:7788',
		], async (url, init) => {
			requests.push({ url: String(url), init });
			return jsonResponse({ runs: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] });
		});
		expect(requests[0]?.url).toBe(`http://127.0.0.1:7788/api/projects/${PROJECT_ID}/runs`);
		expect(requests[0]?.init?.method).toBe('GET');
		expect(result.output).toMatchObject({
			ok: true,
			result: { runs: [{ id: 'two' }], page: { offset: 1, limit: 1, returned: 1, total: 3 } },
		});
	});

	test('routes every mutation class with JSON and agent-cli provenance', async () => {
		const cases: Array<[string, Record<string, unknown>, string, string]> = [
			['issues.create', { projectId: PROJECT_ID, title: 'T', scope: 'S', verificationCommand: 'bun test' }, 'POST', `/api/projects/${PROJECT_ID}/issues`],
			['issues.specify', { projectId: PROJECT_ID, issueId: 'GSHIP-1', scope: 'S', verificationCommand: 'bun test' }, 'POST', `/api/projects/${PROJECT_ID}/issues/GSHIP-1/spec`],
			['issues.approve', { projectId: PROJECT_ID, issueId: 'GSHIP-1', fingerprint: 'abc', authorization: 'Operator approves.' }, 'POST', `/api/projects/${PROJECT_ID}/issues/GSHIP-1/approve`],
			['issues.abandon', { projectId: PROJECT_ID, issueId: 'GSHIP-1', reason: 'No longer needed.' }, 'POST', `/api/projects/${PROJECT_ID}/issues/GSHIP-1/abandon`],
			['brief.update', { projectId: PROJECT_ID, objective: 'O', decisions: [], constraints: [], openItems: [], authorization: 'Operator authorizes.' }, 'PUT', `/api/projects/${PROJECT_ID}/brief`],
			['runs.start', { projectId: PROJECT_ID, issueId: 'GSHIP-1' }, 'POST', `/api/projects/${PROJECT_ID}/runs`],
			['runs.respond', { projectId: PROJECT_ID, runId: 'run-1', message: 'Proceed.' }, 'POST', `/api/projects/${PROJECT_ID}/runs/run-1/resume`],
			['runs.cancel', { projectId: PROJECT_ID, runId: 'run-1' }, 'POST', `/api/projects/${PROJECT_ID}/runs/run-1/cancel`],
			['runs.abandon', { projectId: PROJECT_ID, runId: 'run-1' }, 'POST', `/api/projects/${PROJECT_ID}/runs/run-1/abandon`],
			['runs.ship', { projectId: PROJECT_ID, runId: 'run-1' }, 'POST', `/api/projects/${PROJECT_ID}/runs/run-1/ship`],
		];
		for (const [operation, input, method, path] of cases) {
			let captured: { url: string; init?: RequestInit } | undefined;
			const result = await executeAgent(
				['call', operation, '--input', JSON.stringify(input)],
				async (url, init) => {
					captured = { url: String(url), init };
					return jsonResponse({ ok: true });
				},
			);
			expect(result.exitCode).toBe(0);
			expect(captured?.url).toBe(`http://127.0.0.1:7777${path}`);
			expect(captured?.init?.method).toBe(method);
			expect(new Headers(captured?.init?.headers).get('x-gateship-command-source')).toBe('agent-cli');
			if (operation === 'brief.update') {
				expect(new Headers(captured?.init?.headers).get('x-gateship-operator-authorization')).toBe('Operator authorizes.');
				expect(JSON.parse(String(captured?.init?.body))).not.toHaveProperty('authorization');
			}
			expect(JSON.parse(String(captured?.init?.body))).not.toHaveProperty('projectId');
		}
	});

	test('the service requires explicit authorization before an agent updates the brief', async () => {
		let brief: ProjectBrief = { objective: '', decisions: [], constraints: [], openItems: [] };
		const runtime = new RunRuntime({ cwd: '/project', store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-agent-brief-'),
			runRuntime: runtime,
			projectBrief: { get: () => brief, set: (next) => { brief = next; } },
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const projects = await fetch(`${origin}/api/projects`).then((response) => response.json()) as {
				projects: Array<{ id: string; current: boolean }>;
			};
			const projectId = projects.projects.find((project) => project.current)!.id;
			const forbidden = await fetch(`${origin}/api/brief`, {
				method: 'PUT',
				headers: {
					origin,
					'content-type': 'application/json',
					'x-gateship-command-source': 'agent-cli',
				},
				body: JSON.stringify(brief),
			});
			expect(forbidden.status).toBe(403);
			expect(await forbidden.json()).toMatchObject({ code: 'authorization-required' });

			const updated = await executeAgent([
				'call', 'brief.update', '--url', origin,
				'--input', JSON.stringify({
					projectId,
					objective: 'Ship safely.',
					decisions: [],
					constraints: [],
					openItems: [],
					authorization: 'The operator explicitly authorizes this brief.',
				}),
			]);
			expect(updated.exitCode).toBe(0);
			expect(brief.objective).toBe('Ship safely.');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('propagates HTTP refusals and unavailable services as JSON errors', async () => {
		const refused = await executeAgent(['call', 'runs.start', '--input', `{"projectId":"${PROJECT_ID}","issueId":"GSHIP-1"}`],
			async () => jsonResponse({ ok: false, code: 'run-preflight-failed', message: 'Not approved.' }, 409));
		expect(refused).toMatchObject({
			exitCode: 1,
			output: { ok: false, code: 'run-preflight-failed', message: 'Not approved.', httpStatus: 409 },
		});
		const unavailable = await executeAgent(['call', 'status.get', '--input', `{"projectId":"${PROJECT_ID}"}`], async () => {
			throw new Error('ECONNREFUSED');
		});
		expect(unavailable).toMatchObject({
			exitCode: 1,
			output: { ok: false, code: 'service-unavailable' },
		});
	});

	test('always limits the single JSON output object', async () => {
		const result = await executeAgent(['call', 'issues.get', '--input', `{"projectId":"${PROJECT_ID}","issueId":"GSHIP-1"}`],
			async () => jsonResponse({ detail: 'x'.repeat(AGENT_MAX_OUTPUT_BYTES * 2) }));
		expect(result.output).not.toBeArray();
		expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(AGENT_MAX_OUTPUT_BYTES);
		expect((result.output['result'] as { detail: string }).detail.endsWith('…')).toBe(true);
	});
});
