import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
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
});
