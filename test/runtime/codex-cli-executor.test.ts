import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
	buildCodexCliArgv,
	buildCodexEnv,
	buildCodexReviewArgv,
	CodexAgentSession,
	CodexCliExecutor,
} from '../../src/runtime/codex-cli-executor.ts';
import type { ModelSlot } from '../../src/runtime/model-settings.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'runtime', 'codex-cli-fixture.ts');

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for run');
		await Bun.sleep(5);
	}
}

describe('Codex CLI runtime executor', () => {
	test('builds new and resumed subscription-backed exec turns', () => {
		const first = buildCodexCliArgv({
			command: ['codex'],
			sessionId: 'provisional',
			resume: false,
			outputSchemaPath: '/tmp/schema.json',
		});
		expect(first).toEqual([
			'codex',
			'exec',
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			'--ignore-user-config',
			'--output-schema',
			'/tmp/schema.json',
			'-',
		]);

		const resumed = buildCodexCliArgv({
			command: ['codex'],
			sessionId: 'thread-1',
			resume: true,
		});
		expect(resumed).toContain('resume');
		expect(resumed.slice(-2)).toEqual(['thread-1', '-']);

		const readOnly = buildCodexCliArgv({
			command: ['codex'],
			sessionId: 'thread-2',
			resume: true,
			readOnly: true,
		});
		expect(readOnly).toContain('--ignore-user-config');
		expect(readOnly).toContain('sandbox_mode="read-only"');
		expect(readOnly).not.toContain('--dangerously-bypass-approvals-and-sandbox');
	});

	// GSHIP-617: Codex takes the same pair as `-m` and a reasoning-effort override.
	test('pushes -m and the effort override only when the slot is configured', () => {
		const invocation = { command: ['codex'], sessionId: 'provisional', resume: false };
		expect(buildCodexCliArgv(invocation)).not.toContain('-m');
		expect(JSON.stringify(buildCodexCliArgv(invocation))).not.toContain('model_reasoning_effort');

		expect(buildCodexCliArgv({ ...invocation, model: 'gpt-5-codex', effort: 'high' })).toEqual([
			'codex',
			'exec',
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			'--ignore-user-config',
			'-m',
			'gpt-5-codex',
			'-c',
			'model_reasoning_effort="high"',
			'-',
		]);
		// Either half stands alone, and a review turn takes the same pair.
		expect(buildCodexCliArgv({ ...invocation, effort: 'minimal' })).toContain(
			'model_reasoning_effort="minimal"',
		);
		expect(buildCodexReviewArgv({ command: ['codex'], model: 'gpt-5' })).toContain('-m');
	});

	test('resolves the slot at every spawn and records the pair on the run', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		let slot: ModelSlot = { model: 'gpt-5-codex', effort: 'high' };
		const executor = new CodexCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-24"}',
			// Consulted per spawn, never at construction.
			resolveModel: () => slot,
		});
		const execute = () => executor.execute({
			runId: 'run-24',
			issueId: 'CAM-24',
			sessionId: 'provisional',
			resume: false,
			cwd: createTestTmpdir('gship-codex-model-'),
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});

		const first = await execute();
		expect(first.summary).toContain('"-m","gpt-5-codex"');
		expect(first.summary).toContain('model_reasoning_effort=\\"high\\"');
		expect(events).toContainEqual({
			kind: 'provider.model',
			payload: { model: 'gpt-5-codex', effort: 'high' },
		});

		// An unconfigured slot spawns and reads exactly as it did before.
		slot = {};
		const second = await execute();
		expect(second.summary).not.toContain('"-m"');
		expect(second.summary).not.toContain('model_reasoning_effort');
		expect(events.filter((event) => event.kind === 'provider.model')).toHaveLength(1);
	});

	test('allows only runtime paths and the operator Codex home', () => {
		expect(buildCodexEnv({
			PATH: '/usr/bin',
			OPENAI_API_KEY: 'secret',
			CODEX_API_KEY: 'secret',
			CODEX_ACCESS_TOKEN: 'secret',
			RESEND_API_KEY: 'secret',
			CODEX_HOME: '/operator/codex',
		})).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/operator/codex' });
	});

	test('preserves a structured failure diagnostic when Codex exits nonzero', async () => {
		const session = new CodexAgentSession({
			command: ['bun', FIXTURE, '--fixture-mode=structured-error-exit'],
		});
		await expect(session.run({
			sessionId: 'provisional',
			resume: false,
			cwd: createTestTmpdir('gship-codex-structured-error-'),
			prompt: 'fail after a structured diagnostic',
			signal: new AbortController().signal,
			emit: () => {},
			eventPrefix: 'provider',
		})).rejects.toThrow('structured fixture diagnostic');
	});

	test('binds the provider thread, projects activity, and removes the temporary schema', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		let providerSession = '';
		const executor = new CodexCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-20"}',
		});
		const result = await executor.execute({
			runId: 'run-20',
			issueId: 'CAM-20',
			sessionId: 'provisional',
			resume: false,
			cwd: createTestTmpdir('gship-codex-executor-'),
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
			setSessionId: (sessionId) => { providerSession = sessionId; },
		});

		expect(providerSession).toBe('codex-session-1');
		expect(result.outcome).toBe('completed');
		const summary = JSON.parse(result.summary ?? '{}') as { argv?: string[] };
		const schemaIndex = summary.argv?.indexOf('--output-schema') ?? -1;
		const schemaPath = summary.argv?.[schemaIndex + 1];
		expect(schemaPath).toBeDefined();
		expect(existsSync(schemaPath ?? '')).toBe(false);
		expect(events).toContainEqual({
			kind: 'provider.activity',
			payload: { tools: ['command_execution'] },
		});
		expect(JSON.stringify(events)).not.toContain('/not-persisted');
	});

	// GSHIP-612: both providers answer the same structured contract, so a Codex
	// result reaches the same durable proposal record.
	test('captures a proposal from the shared structured result', async () => {
		const executor = new CodexCliExecutor({
			command: ['bun', FIXTURE, '--fixture-proposal=Cobrir o caminho de erro do shipper'],
			loadIssue: () => '{"id":"CAM-30"}',
		});
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-codex-proposals-'),
			store,
			newId: () => 'run-codex-proposal',
			newSessionId: () => 'provisional',
			executor,
			verifier: { verify: async () => ({ ok: true }) },
		});
		runtime.startRun('CAM-30');
		await waitFor(() => runtime.getRun('run-codex-proposal')?.state === 'ready-to-ship');

		expect(store.listProposals()).toMatchObject([{
			id: 'run-codex-proposal-proposal-1',
			relationship: 'derived-from',
			status: 'pending',
			sourceRunId: 'run-codex-proposal',
			sourceIssueId: 'CAM-30',
			title: 'Cobrir o caminho de erro do shipper',
			evidence: 'fixture evidence',
		}]);
		expect(runtime.listRunEvents('run-codex-proposal').map((event) => event.kind)).toContain(
			'run.proposals-captured',
		);
		await runtime.stop();
		runtime.close();
	});

	test('persists a provider-assigned thread id before verification', async () => {
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-codex-runtime-'),
			store,
			newId: () => 'run-codex',
			newSessionId: () => 'provisional',
			executor: new CodexCliExecutor({
				command: ['bun', FIXTURE],
				loadIssue: () => '{"id":"CAM-20"}',
			}),
			verifier: { verify: async () => ({ ok: true }) },
		});
		runtime.startRun('CAM-20');
		await waitFor(() => runtime.getRun('run-codex')?.state === 'ready-to-ship');

		expect(runtime.getRun('run-codex')?.sessionId).toBe('codex-session-1');
		expect(runtime.listRunEvents('run-codex').map((event) => event.kind)).toContain(
			'provider.session',
		);
		await runtime.stop();
		runtime.close();
	});
});
