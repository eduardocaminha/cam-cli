import { describe, expect, test } from 'bun:test';

import {
	AGENT_MAX_OUTPUT_BYTES,
	executeAgent,
	parseAgentArgs,
} from '../../src/commands/agent.ts';
import { startWebServer } from '../../src/commands/web.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { type ProjectBrief, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const jsonResponse = (body: unknown, status = 200): Response => Response.json(body, { status });

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
			'project.inspect', 'status.get', 'backlog.list', 'issues.list', 'issues.get',
			'runs.list', 'runs.events', 'issues.create', 'issues.specify', 'issues.approve',
			'issues.abandon', 'brief.get', 'brief.update', 'runs.start', 'runs.respond',
			'runs.cancel', 'runs.abandon', 'runs.ship',
		]);
		expect(operations.find(({ name }) => name === 'issues.approve')?.input)
			.toContain('fingerprint');
	});

	test('calls read-only operations and pages list results', async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const result = await executeAgent([
			'call', 'runs.list', '--input', '{"offset":1,"limit":1}', '--url', 'http://127.0.0.1:7788',
		], async (url, init) => {
			requests.push({ url: String(url), init });
			return jsonResponse({ runs: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] });
		});
		expect(requests[0]?.url).toBe('http://127.0.0.1:7788/api/runs');
		expect(requests[0]?.init?.method).toBe('GET');
		expect(result.output).toMatchObject({
			ok: true,
			result: { runs: [{ id: 'two' }], page: { offset: 1, limit: 1, returned: 1, total: 3 } },
		});
	});

	test('routes every mutation class with JSON and agent-cli provenance', async () => {
		const cases: Array<[string, Record<string, unknown>, string, string]> = [
			['issues.create', { title: 'T', scope: 'S', verificationCommand: 'bun test' }, 'POST', '/api/issues'],
			['issues.specify', { issueId: 'GSHIP-1', scope: 'S', verificationCommand: 'bun test' }, 'POST', '/api/issues/GSHIP-1/spec'],
			['issues.approve', { issueId: 'GSHIP-1', fingerprint: 'abc', authorization: 'Operator approves.' }, 'POST', '/api/issues/GSHIP-1/approve'],
			['issues.abandon', { issueId: 'GSHIP-1', reason: 'No longer needed.' }, 'POST', '/api/issues/GSHIP-1/abandon'],
			['brief.update', { objective: 'O', decisions: [], constraints: [], openItems: [], authorization: 'Operator authorizes.' }, 'PUT', '/api/brief'],
			['runs.start', { issueId: 'GSHIP-1' }, 'POST', '/api/runs'],
			['runs.respond', { runId: 'run-1', message: 'Proceed.' }, 'POST', '/api/runs/run-1/resume'],
			['runs.cancel', { runId: 'run-1' }, 'POST', '/api/runs/run-1/cancel'],
			['runs.abandon', { runId: 'run-1' }, 'POST', '/api/runs/run-1/abandon'],
			['runs.ship', { runId: 'run-1' }, 'POST', '/api/runs/run-1/ship'],
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
		const refused = await executeAgent(['call', 'runs.start', '--input', '{"issueId":"GSHIP-1"}'],
			async () => jsonResponse({ ok: false, code: 'run-preflight-failed', message: 'Not approved.' }, 409));
		expect(refused).toMatchObject({
			exitCode: 1,
			output: { ok: false, code: 'run-preflight-failed', message: 'Not approved.', httpStatus: 409 },
		});
		const unavailable = await executeAgent(['call', 'status.get'], async () => {
			throw new Error('ECONNREFUSED');
		});
		expect(unavailable).toMatchObject({
			exitCode: 1,
			output: { ok: false, code: 'service-unavailable' },
		});
	});

	test('always limits the single JSON output object', async () => {
		const result = await executeAgent(['call', 'status.get'],
			async () => jsonResponse({ detail: 'x'.repeat(AGENT_MAX_OUTPUT_BYTES * 2) }));
		expect(result.output).not.toBeArray();
		expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(AGENT_MAX_OUTPUT_BYTES);
		expect((result.output['result'] as { detail: string }).detail.endsWith('…')).toBe(true);
	});
});
