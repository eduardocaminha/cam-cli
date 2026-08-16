import { describe, expect, test } from 'bun:test';

import type {
	AgentSession,
	AgentSessionInput,
} from '../../src/runtime/agent-session.ts';
import {
	ConversationalOrchestrator,
	parseOrchestratorResponse,
} from '../../src/runtime/conversational-orchestrator.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

class FakeSession implements AgentSession {
	readonly provider;
	readonly inputs: AgentSessionInput[] = [];
	#outputs: unknown[];

	constructor(provider: 'claude' | 'codex', outputs: unknown[]) {
		this.provider = provider;
		this.#outputs = outputs;
	}

	async run(input: AgentSessionInput): Promise<{ summary: string; structuredOutput: unknown }> {
		this.inputs.push(input);
		if (this.provider === 'codex') input.onSessionId?.('codex-thread-1');
		const structuredOutput = this.#outputs.shift();
		return { summary: JSON.stringify(structuredOutput), structuredOutput };
	}
}

describe('conversational orchestrator', () => {
	test('persists handoff and delegates one typed command from a read-only turn', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-orchestrator-runtime-'),
			store: new RunStore(':memory:'),
		});
		runtime.selectProvider('codex');
		const codex = new FakeSession('codex', [{
			message: 'CAM-42 está pronta; vou iniciar o run.',
			command: { type: 'start_run', issueId: 'CAM-42' },
		}, {
			message: 'O run continua sob controle do serviço.',
			command: { type: 'none' },
		}]);
		const claude = new FakeSession('claude', []);
		const commands: unknown[] = [];
		const orchestrator = new ConversationalOrchestrator({
			cwd: '/project',
			persistence: runtime,
			sessions: { claude, codex },
			context: () => ({ plannable: ['CAM-42'] }),
			execute: (command) => {
				commands.push(command);
				return 'Run CAM-42 iniciada.';
			},
			newSessionId: () => 'provisional-session',
		});

		const first = await orchestrator.turn('Pode começar a CAM-42?');
		expect(first.command).toEqual({ type: 'start_run', issueId: 'CAM-42' });
		expect(commands).toEqual([{ type: 'start_run', issueId: 'CAM-42' }]);
		expect(codex.inputs[0]).toMatchObject({
			access: 'read-only',
			resume: false,
			sessionId: 'provisional-session',
		});
		expect(runtime.getOrchestratorSession('codex')).toBe('codex-thread-1');
		expect(runtime.listOrchestratorMessages().map((message) => message.role)).toEqual([
			'operator',
			'orchestrator',
			'system',
		]);

		await orchestrator.turn('E agora?');
		expect(codex.inputs[1]).toMatchObject({ resume: true, sessionId: 'codex-thread-1' });
		expect(codex.inputs[1]?.prompt).toContain('Run CAM-42 iniciada.');
		expect(codex.inputs[1]?.prompt).toContain(
			'A run in state done was already shipped and its branch is already merged: never request ship_run for it',
		);
		await orchestrator.stop();
		await runtime.stop();
		runtime.close();
	});

	test('provider switch starts a native session but carries the durable transcript', async () => {
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-orchestrator-handoff-'),
			store: new RunStore(':memory:'),
		});
		const codex = new FakeSession('codex', [{
			message: 'A investigação encontrou o ponto de entrada.',
			command: { type: 'none' },
		}]);
		const claude = new FakeSession('claude', [{
			message: 'Retomei o contexto e posso continuar.',
			command: { type: 'none' },
		}]);
		const orchestrator = new ConversationalOrchestrator({
			cwd: '/project',
			persistence: runtime,
			sessions: { claude, codex },
			context: () => ({}),
			execute: () => '',
			newSessionId: () => 'new-session',
		});

		runtime.selectProvider('codex');
		await orchestrator.turn('Investigue o fluxo atual.');
		runtime.selectProvider('claude');
		await orchestrator.turn('Continue de onde paramos.');

		expect(claude.inputs[0]).toMatchObject({ resume: false, sessionId: 'new-session' });
		expect(claude.inputs[0]?.prompt).toContain('A investigação encontrou o ponto de entrada.');
		expect(runtime.getOrchestratorSession('claude')).toBe('new-session');
		await runtime.stop();
		runtime.close();
	});

	test('rejects incomplete commands before the deterministic executor', () => {
		expect(() => parseOrchestratorResponse({
			message: 'Vou criar.',
			command: { type: 'create_issue', title: 'Sem contrato' },
		})).toThrow('scope');
		expect(parseOrchestratorResponse({
			message: 'Só uma explicação.',
			command: { type: 'none' },
		})).toEqual({
			message: 'Só uma explicação.',
			command: { type: 'none' },
		});
	});

	test('abandon_issue only parses with an issue and a concrete justification', () => {
		expect(parseOrchestratorResponse({
			message: 'A tarefa perdeu o motivo de existir.',
			command: {
				type: 'abandon_issue',
				issueId: 'CAM-42',
				reason: 'O recurso saiu do produto na fatia anterior.',
			},
		})).toEqual({
			message: 'A tarefa perdeu o motivo de existir.',
			command: {
				type: 'abandon_issue',
				issueId: 'CAM-42',
				reason: 'O recurso saiu do produto na fatia anterior.',
			},
		});
		expect(() => parseOrchestratorResponse({
			message: 'Vou abandonar.',
			command: { type: 'abandon_issue', issueId: 'CAM-42' },
		})).toThrow('reason');
		expect(() => parseOrchestratorResponse({
			message: 'Vou abandonar.',
			command: { type: 'abandon_issue', issueId: 'CAM-42', reason: '   ' },
		})).toThrow('reason');
		expect(() => parseOrchestratorResponse({
			message: 'Vou abandonar.',
			command: { type: 'abandon_issue', reason: 'Sem tarefa.' },
		})).toThrow('issueId');
	});
});
