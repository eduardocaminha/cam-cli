import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	buildClaudeCliArgv,
	buildClaudeReadOnlyArgv,
	buildWorkPrompt,
	ClaudeCliExecutor,
	EXECUTION_RESULT_SCHEMA,
	parseExecutionResult,
} from '../../src/runtime/claude-cli-executor.ts';
import { projectAssistantActivity } from '../../src/runtime/claude-cli-process.ts';
import type { ModelSlot } from '../../src/runtime/model-settings.ts';
import { PROPOSAL_LIMITS } from '../../src/runtime/run-proposal.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'runtime', 'claude-cli-fixture.ts');

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for child process');
		await Bun.sleep(5);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('Claude CLI runtime executor', () => {
	test('projects public text and tool names without persisting reasoning or tool input', () => {
		const activity = projectAssistantActivity({
			message: {
				content: [
					{ type: 'thinking', thinking: 'private reasoning' },
					{ type: 'text', text: 'Vou verificar o arquivo.' },
					{ type: 'tool_use', name: 'Read', input: { file_path: '/secret/path' } },
				],
			},
		});

		expect(activity).toEqual({ text: 'Vou verificar o arquivo.', tools: ['Read'] });
		expect(JSON.stringify(activity)).not.toContain('private reasoning');
		expect(JSON.stringify(activity)).not.toContain('/secret/path');
	});

	test('uses a new session id on first execution and the same id on resume', () => {
		const first = buildClaudeCliArgv({
			command: ['claude'],
			sessionId: 'ABC-123',
			resume: false,
			permissionMode: 'bypassPermissions',
		});
		expect(first).toContain('--session-id');
		expect(first).toContain('abc-123');
		// No inherited customization, without displacing the permission mode.
		expect(first).toContain('--safe-mode');
		expect(first).toContain('bypassPermissions');
		const resumed = buildClaudeCliArgv({
			command: ['claude'],
			sessionId: 'ABC-123',
			resume: true,
			permissionMode: 'bypassPermissions',
		});
		expect(resumed).toContain('--resume');
		expect(resumed).toContain('abc-123');
		expect(resumed).not.toContain('--session-id');
		const structured = buildClaudeCliArgv({
			command: ['claude'],
			sessionId: 'ABC-123',
			resume: false,
			permissionMode: 'bypassPermissions',
			jsonSchema: EXECUTION_RESULT_SCHEMA,
		});
		expect(structured.slice(-2)).toEqual([
			'--json-schema',
			JSON.stringify(EXECUTION_RESULT_SCHEMA),
		]);
	});

	test('read-only turns expose inspection tools and deny mutation', () => {
		const argv = buildClaudeReadOnlyArgv({
			command: ['claude'],
			sessionId: 'ABC-123',
			resume: false,
			permissionMode: 'unused',
		});
		expect(argv).toContain('Read,Grep,Glob');
		expect(argv).toContain('Bash,Edit,Write,NotebookEdit,Agent');
		expect(argv).toContain('--strict-mcp-config');
		expect(argv).toContain('--safe-mode');
		expect(argv).not.toContain('bypassPermissions');
	});

	// GSHIP-617: the operator's per-role choice, pushed as flags only when set.
	test('pushes --model and --effort only when the slot is configured', () => {
		const invocation = {
			command: ['claude'],
			sessionId: 'ABC-123',
			resume: false,
			permissionMode: 'bypassPermissions',
		};
		const bare = buildClaudeCliArgv(invocation);
		expect(bare).not.toContain('--model');
		expect(bare).not.toContain('--effort');

		expect(buildClaudeCliArgv({ ...invocation, model: 'opus', effort: 'xhigh' }).slice(-4))
			.toEqual(['--model', 'opus', '--effort', 'xhigh']);
		// Either half stands alone: the unset one still passes no flag.
		expect(buildClaudeCliArgv({ ...invocation, effort: 'low' }).slice(-2))
			.toEqual(['--effort', 'low']);
		// The read-only orchestrator turn takes the same pair.
		expect(buildClaudeReadOnlyArgv({ ...invocation, model: 'sonnet' }).slice(-2))
			.toEqual(['--model', 'sonnet']);
	});

	test('resolves the slot at every spawn and records the pair on the run', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		let slot: ModelSlot = { model: 'opus', effort: 'xhigh' };
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-24"}',
			// Consulted per spawn, never at construction: this is what lets the
			// operator change the setting without restarting the service.
			resolveModel: () => slot,
		});
		const execute = () => executor.execute({
			runId: 'run-24',
			issueId: 'CAM-24',
			sessionId: 'session-24',
			resume: false,
			cwd: createTestTmpdir('gship-claude-model-'),
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});

		const first = await execute();
		expect(first.summary).toContain('"--model","opus"');
		expect(first.summary).toContain('"--effort","xhigh"');
		expect(events).toContainEqual({
			kind: 'provider.model',
			payload: { model: 'opus', effort: 'xhigh' },
		});

		slot = { effort: 'low' };
		const second = await execute();
		expect(second.summary).not.toContain('--model');
		expect(second.summary).toContain('"--effort","low"');
		expect(events).toContainEqual({ kind: 'provider.model', payload: { effort: 'low' } });
	});

	test('an unconfigured slot spawns and reads exactly as before the setting existed', async () => {
		const events: Array<{ kind: string }> = [];
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-25"}',
			resolveModel: () => ({}),
		});
		const result = await executor.execute({
			runId: 'run-25',
			issueId: 'CAM-25',
			sessionId: 'session-25',
			resume: false,
			cwd: createTestTmpdir('gship-claude-default-model-'),
			signal: new AbortController().signal,
			emit: (kind) => events.push({ kind }),
		});

		expect(result.summary).not.toContain('--model');
		expect(result.summary).not.toContain('--effort');
		expect(events.map((event) => event.kind)).not.toContain('provider.model');
	});

	test('accepts only the two structured executor outcomes', () => {
		expect(parseExecutionResult({ status: 'completed', summary: 'done', proposals: [] })).toEqual({
			outcome: 'completed',
			summary: 'done',
			proposals: [],
		});
		expect(parseExecutionResult({ status: 'waiting-user', summary: 'choose A or B' })).toEqual({
			outcome: 'waiting-user',
			summary: 'choose A or B',
		});
		expect(() => parseExecutionResult({ status: 'unknown', summary: 'no' })).toThrow(
			'invalid structured run status',
		);
	});

	// GSHIP-612: the executor reports out-of-scope ideas instead of building them.
	test('asks for bounded proposals and keeps them out of a paused turn', () => {
		expect(EXECUTION_RESULT_SCHEMA.required).toContain('proposals');
		expect(EXECUTION_RESULT_SCHEMA.properties.proposals.maxItems)
			.toBe(PROPOSAL_LIMITS.maxItems);

		const prompt = buildWorkPrompt('CAM-30', '{"id":"CAM-30"}', false, undefined, undefined);
		expect(prompt).toContain('Keep this issue closed to its scope');
		expect(prompt).toContain('Report such work in proposals instead');

		expect(parseExecutionResult({
			status: 'completed',
			summary: 'done',
			proposals: [
				{ title: '  Extrair o parser  ', evidence: '  Duplicado em dois adaptadores.  ' },
				{ title: '', evidence: 'sem título' },
				{ title: 'Ideia 2', evidence: 'Evidência 2.' },
				{ title: 'Ideia 3', evidence: 'Evidência 3.' },
				{ title: 'Ideia 4', evidence: 'Evidência 4.' },
			],
		})).toEqual({
			outcome: 'completed',
			summary: 'done',
			proposals: [
				{ title: 'Extrair o parser', evidence: 'Duplicado em dois adaptadores.' },
				{ title: 'Ideia 2', evidence: 'Evidência 2.' },
				{ title: 'Ideia 3', evidence: 'Evidência 3.' },
			],
		});
		// A missing or malformed array never fails an otherwise valid result.
		expect(parseExecutionResult({ status: 'completed', summary: 'done' })).toEqual({
			outcome: 'completed',
			summary: 'done',
			proposals: [],
		});
		// This slice captures nothing from a paused turn.
		expect(parseExecutionResult({
			status: 'waiting-user',
			summary: 'choose A or B',
			proposals: [{ title: 'Ideia', evidence: 'Evidência.' }],
		})).toEqual({ outcome: 'waiting-user', summary: 'choose A or B' });
	});

	test('consumes the provider result without a sentinel or report file', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-20"}',
		});
		const result = await executor.execute({
			runId: 'run-20',
			issueId: 'CAM-20',
			sessionId: 'session-20',
			resume: false,
			cwd: createTestTmpdir('gship-claude-executor-'),
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});
		expect(result.outcome).toBe('completed');
		expect(result.summary).toContain('--session-id');
		expect(result.summary).toContain('session-20');
		expect(events).toContainEqual({
			kind: 'provider.activity',
			payload: { text: 'fixture activity', tools: ['Read'] },
		});
		expect(JSON.stringify(events)).not.toContain('/not-persisted');
	});

	test('reports a real waiting-user outcome and includes operator guidance on resume', async () => {
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE, '--fixture-mode=waiting-user'],
			loadIssue: () => '{"id":"CAM-22"}',
		});
		const result = await executor.execute({
			runId: 'run-22',
			issueId: 'CAM-22',
			sessionId: 'session-22',
			resume: true,
			operatorGuidance: 'Use the smaller migration.',
			cwd: createTestTmpdir('gship-claude-waiting-'),
			signal: new AbortController().signal,
			emit: () => {},
		});

		expect(result.outcome).toBe('waiting-user');
		expect(result.summary).toContain('Use the smaller migration.');
	});

	test('carries a proposal from the provider result into the run store', async () => {
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-claude-proposals-'),
			store,
			newId: () => 'run-claude-proposal',
			newSessionId: () => 'session-claude-proposal',
			executor: new ClaudeCliExecutor({
				command: ['bun', FIXTURE, '--fixture-proposal=Extrair o parser de eventos'],
				loadIssue: () => '{"id":"CAM-31"}',
			}),
			verifier: { verify: async () => ({ ok: true }) },
		});
		runtime.startRun('CAM-31');
		await waitFor(() => runtime.getRun('run-claude-proposal')?.state === 'ready-to-ship');

		expect(store.listProposals()).toMatchObject([{
			id: 'run-claude-proposal-proposal-1',
			relationship: 'derived-from',
			status: 'pending',
			sourceRunId: 'run-claude-proposal',
			sourceIssueId: 'CAM-31',
			title: 'Extrair o parser de eventos',
			evidence: 'fixture evidence',
		}]);
		await runtime.stop();
		runtime.close();
	});

	test('kills and awaits the real child process group on cancellation', async () => {
		let childPid = 0;
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE, '--fixture-mode=wait'],
			loadIssue: () => '{"id":"CAM-21"}',
			onSpawn: (pid) => {
				childPid = pid;
			},
			terminationGraceMs: 100,
		});
		const runtime = new RunRuntime({
			cwd: createTestTmpdir('gship-claude-cancel-'),
			store: new RunStore(':memory:'),
			newId: () => 'run-cancel-real',
			newSessionId: () => 'session-cancel-real',
			executor,
			verifier: { verify: async () => ({ ok: true }) },
		});
		const run = runtime.startRun('CAM-21');
		await waitFor(() => childPid > 0 && isProcessAlive(childPid));

		const cancelled = await runtime.cancelRun(run.id);
		expect(cancelled?.state).toBe('interrupted');
		expect(isProcessAlive(childPid)).toBe(false);
		await runtime.stop();
		runtime.close();
	});
});
