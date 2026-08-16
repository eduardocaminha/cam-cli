import { describe, expect, test } from 'bun:test';

import {
	type OrchestratorRuntime,
	startWebServer,
} from '../../src/commands/web.ts';
import type { OrchestratorTurnResult } from '../../src/runtime/conversational-orchestrator.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import type { OrchestratorMessage } from '../../src/runtime/run-store.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

class FakeOrchestrator implements OrchestratorRuntime {
	readonly messages: OrchestratorMessage[] = [];
	readonly turns: string[] = [];

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
		return { assistant, command: { type: 'none' }, commandResult: null };
	}

	async stop(): Promise<void> {}
}

describe('orchestrator web API', () => {
	test('persists the public conversation and protects the write by origin', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-chat-api-'),
			store: new RunStore(':memory:'),
		});
		const orchestrator = new FakeOrchestrator();
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-chat-api-cwd-'),
			runRuntime: runtime,
			orchestrator,
		});
		const base = `http://${handle.hostname}:${handle.port}`;
		try {
			const forbidden = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Não deveria entrar.' }),
			});
			expect(forbidden.status).toBe(403);
			expect(orchestrator.turns).toEqual([]);

			const posted = await fetch(`${base}/api/chat`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: base,
				},
				body: JSON.stringify({ message: 'Investigue o core.' }),
			});
			expect(posted.status).toBe(200);
			expect(orchestrator.turns).toEqual(['Investigue o core.']);

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
});
