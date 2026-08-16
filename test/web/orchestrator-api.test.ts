import { describe, expect, test } from 'bun:test';

import {
	type OrchestratorRuntime,
	startWebServer,
} from '../../src/commands/web.ts';
import type {
	OrchestratorCommand,
	OrchestratorTurnResult,
} from '../../src/runtime/conversational-orchestrator.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import type { OrchestratorMessage } from '../../src/runtime/run-store.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

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
