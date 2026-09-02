import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { ProviderCallError } from '../../src/runtime/agent-session.ts';
import {
	buildClaudeCliArgv,
	buildClaudeReadOnlyArgv,
	buildWorkPrompt,
	ClaudeAgentSession,
	ClaudeCliExecutor,
	EXECUTION_RESULT_SCHEMA,
	parseExecutionResult,
	probeClaudeModel,
} from '../../src/runtime/claude-cli-executor.ts';
import { projectAssistantActivity } from '../../src/runtime/claude-cli-process.ts';
import type { ModelSlot } from '../../src/runtime/model-settings.ts';
import { OPERATOR_LANGUAGE_CONTRACT } from '../../src/runtime/operator-language.ts';
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

	test('preserves a structured subscription limit and its reset time', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const session = new ClaudeAgentSession({
			command: ['bun', FIXTURE, '--fixture-mode=usage-limit'],
		});
		let failure: unknown;
		try {
			await session.run({
				sessionId: 'session-limit',
				resume: true,
				cwd: createTestTmpdir('gship-claude-usage-limit-'),
				prompt: 'continue',
				signal: new AbortController().signal,
				emit: (kind, payload) => events.push({
					kind,
					...(payload === undefined ? {} : { payload }),
				}),
				eventPrefix: 'provider',
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderCallError);
		expect(failure).toMatchObject({
			provider: 'claude',
			kind: 'usage-limit',
			retryAt: '2027-01-15T08:00:00.000Z',
		});
		expect(events).toContainEqual({
			kind: 'provider.rate-limit',
			payload: {
				status: 'rejected',
				limit: 'five_hour',
				retryAt: '2027-01-15T08:00:00.000Z',
			},
		});
	});

	test('ignores an invalid provider reset timestamp without losing the limit', async () => {
		const session = new ClaudeAgentSession({
			command: ['bun', FIXTURE, '--fixture-mode=usage-limit-invalid-reset'],
		});
		let failure: unknown;
		try {
			await session.run({
				sessionId: 'session-invalid-reset',
				resume: true,
				cwd: createTestTmpdir('gship-claude-invalid-reset-'),
				prompt: 'continue',
				signal: new AbortController().signal,
				emit: () => {},
				eventPrefix: 'provider',
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderCallError);
		expect(failure).toMatchObject({ provider: 'claude', kind: 'usage-limit' });
		expect((failure as ProviderCallError).retryAt).toBeUndefined();
	});

	test('classifies a silent CLI as unavailable after reaping its process', async () => {
		let childPid = 0;
		const session = new ClaudeAgentSession({
			command: ['bun', FIXTURE, '--fixture-mode=wait'],
			activityTimeoutMs: 50,
			terminationGraceMs: 100,
			onSpawn: (pid) => { childPid = pid; },
		});
		let failure: unknown;
		try {
			await session.run({
				sessionId: 'session-silent',
				resume: false,
				cwd: createTestTmpdir('gship-claude-silent-'),
				prompt: 'continue',
				signal: new AbortController().signal,
				emit: () => {},
				eventPrefix: 'provider',
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderCallError);
		expect(failure).toMatchObject({ provider: 'claude', kind: 'transport-unavailable' });
		expect((failure as Error).message).toContain('50ms');
		expect(isProcessAlive(childPid)).toBe(false);
	});

	// GSHIP-664: the structured `utilization` fraction a real invocation reports
	// is normalized into a 0-100 usedPercent on the same rate-limit event,
	// without ever calling Claude a second time to ask for it.
	test('normalizes a reported utilization fraction into a used percentage', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const session = new ClaudeAgentSession({
			command: ['bun', FIXTURE, '--fixture-usage=0.42'],
		});
		await session.run({
			sessionId: 'session-usage-reported',
			resume: false,
			cwd: createTestTmpdir('gship-claude-usage-reported-'),
			prompt: 'continue',
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({
				kind,
				...(payload === undefined ? {} : { payload }),
			}),
			eventPrefix: 'provider',
		});

		expect(events).toContainEqual({
			kind: 'provider.rate-limit',
			payload: {
				status: 'allowed_warning',
				limit: 'seven_day',
				retryAt: '2027-01-15T08:00:00.000Z',
				usedPercent: 42,
			},
		});
	});

	test('drops a malformed utilization without losing the rest of the observation', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const session = new ClaudeAgentSession({
			command: ['bun', FIXTURE, '--fixture-usage=malformed'],
		});
		await session.run({
			sessionId: 'session-usage-malformed',
			resume: false,
			cwd: createTestTmpdir('gship-claude-usage-malformed-'),
			prompt: 'continue',
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({
				kind,
				...(payload === undefined ? {} : { payload }),
			}),
			eventPrefix: 'provider',
		});

		expect(events).toContainEqual({
			kind: 'provider.rate-limit',
			payload: {
				status: 'allowed_warning',
				limit: 'seven_day',
				retryAt: '2027-01-15T08:00:00.000Z',
			},
		});
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
			payload: { model: 'opus', effort: 'xhigh', provider: 'claude' },
		});

		slot = { effort: 'low' };
		const second = await execute();
		expect(second.summary).not.toContain('--model');
		expect(second.summary).toContain('"--effort","low"');
		expect(events).toContainEqual({
			kind: 'provider.model', payload: { model: 'provider-default', effort: 'low', provider: 'claude' },
		});
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
		expect(events.map((event) => event.kind)).toContain('provider.model');
	});

	test('accepts only the two structured executor outcomes', () => {
		expect(parseExecutionResult({ status: 'completed', summary: 'done', proposals: [], reconciliation: { outcome: 'unchanged', summary: 'same contract' } })).toEqual({
			outcome: 'completed',
			summary: 'done',
			proposals: [],
			reconciliation: { outcome: 'unchanged', summary: 'same contract' },
		});
		expect(parseExecutionResult({ status: 'waiting-user', summary: 'choose A or B', reconciliation: { outcome: 'contract-change-required', summary: 'contract changed' } })).toEqual({
			outcome: 'waiting-user',
			summary: 'choose A or B',
			reconciliation: { outcome: 'contract-change-required', summary: 'contract changed' },
		});
		expect(() => parseExecutionResult({ status: 'unknown', summary: 'no' })).toThrow(
			'invalid structured run status',
		);
	});

	// GSHIP-612: the executor reports out-of-scope ideas instead of building them.
	// GSHIP-703: the executor prompt is the one both providers send, so the
	// language contract reaching it here reaches the Codex executor too; the
	// Codex side asserts the same bytes over a real child.
	test('carries the shared operator language contract on every turn shape', () => {
		const contract = OPERATOR_LANGUAGE_CONTRACT.join('\n');
		expect(buildWorkPrompt('CAM-703', '{"id":"CAM-703"}', false, undefined, undefined))
			.toContain(contract);
		expect(buildWorkPrompt(
			'CAM-703',
			'{"id":"CAM-703"}',
			true,
			'1. src/a.ts: quebra o contrato',
			'Responda em português.',
			['Manter o seam menor.'],
			'verify failed',
		)).toContain(contract);
	});

	// GSHIP-708: the contract names the Issue record as the source of the
	// operator's language, so every turn shape has to deliver the two
	// together. A resume turn carrying review findings, operator guidance,
	// decisions and a failed verify log is the longest prompt the executor
	// ever sees, and the contract still ends up directly above the record.
	test('keeps the contract directly above the issue record in every turn shape', () => {
		const contract = OPERATOR_LANGUAGE_CONTRACT.join('\n');
		const tail = `${contract}\n\nIssue record:\n{"id":"CAM-708"}`;
		expect(buildWorkPrompt('CAM-708', '{"id":"CAM-708"}', false, undefined, undefined))
			.toEndWith(tail);
		expect(buildWorkPrompt('CAM-708', '{"id":"CAM-708"}', true, undefined, undefined))
			.toEndWith(tail);
		expect(buildWorkPrompt(
			'CAM-708',
			'{"id":"CAM-708"}',
			true,
			'1. src/a.ts: quebra o contrato',
			'Responda em português.',
			['Manter o seam menor.'],
			'verify failed',
		)).toEndWith(tail);
	});

	// The variable sections a resume turn adds sit above the contract, not
	// between it and the record: that ordering is the whole point of GSHIP-708.
	test('orders the variable sections ahead of the contract and the record', () => {
		const prompt = buildWorkPrompt(
			'CAM-708',
			'{"id":"CAM-708"}',
			true,
			'1. src/a.ts: quebra o contrato',
			'Responda em português.',
			['Manter o seam menor.'],
			'verify failed',
		);
		for (const section of [
			'Decisions the operator has already made in this run',
			'The operator answered your previous request',
			'Review findings:',
			'Full verification output:',
		]) {
			expect(prompt.indexOf(section)).toBeGreaterThan(-1);
			expect(prompt.indexOf(section)).toBeLessThan(prompt.indexOf(OPERATOR_LANGUAGE_CONTRACT[0]));
		}
		expect(prompt.indexOf(OPERATOR_LANGUAGE_CONTRACT[0]))
			.toBeLessThan(prompt.indexOf('Issue record:'));
	});

	// The contract has to say where the operator's language comes from, and
	// that its own English is not the answer; without both lines the executor
	// is back to the ambiguity GSHIP-703 left behind.
	test('names the issue record as the language source and excludes its own language', () => {
		const contract = OPERATOR_LANGUAGE_CONTRACT.join('\n');
		expect(contract).toContain("the natural language of this run's Issue record");
		expect(contract).toContain('including its title, description and approved spec');
		expect(contract).toContain('When a turn carries no Issue record');
		expect(contract).toContain('The language of these workflow instructions never participates');
		expect(contract).toContain('textual progress');
	});

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
			reconciliation: { outcome: 'adapted', summary: 'mechanical drift only' },
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
			reconciliation: { outcome: 'adapted', summary: 'mechanical drift only' },
			proposals: [
				{ title: 'Extrair o parser', evidence: 'Duplicado em dois adaptadores.' },
				{ title: 'Ideia 2', evidence: 'Evidência 2.' },
				{ title: 'Ideia 3', evidence: 'Evidência 3.' },
			],
		});
		// A missing or malformed array never fails an otherwise valid result.
		expect(parseExecutionResult({ status: 'completed', summary: 'done', reconciliation: { outcome: 'unchanged', summary: 'same contract' } })).toEqual({
			outcome: 'completed',
			summary: 'done',
			reconciliation: { outcome: 'unchanged', summary: 'same contract' },
			proposals: [],
		});
		// This slice captures nothing from a paused turn.
		expect(parseExecutionResult({
			status: 'waiting-user',
			summary: 'choose A or B',
			reconciliation: { outcome: 'contract-change-required', summary: 'contract changed' },
			proposals: [{ title: 'Ideia', evidence: 'Evidência.' }],
		})).toEqual({ outcome: 'waiting-user', summary: 'choose A or B', reconciliation: { outcome: 'contract-change-required', summary: 'contract changed' } });
		expect(() => parseExecutionResult({
			status: 'completed',
			summary: 'done',
			proposals: [],
			reconciliation: { outcome: 'contract-change-required', summary: 'needs approval' },
		})).toThrow('invalid structured run status');
		expect(() => parseExecutionResult({
			status: 'waiting-user',
			summary: 'choose',
			reconciliation: { outcome: 'unchanged', summary: 'same contract' },
		})).toThrow('invalid structured run status');
	});

	// GSHIP-623: the cost and usage the CLI already reports on the result event,
	// attached to the model/effort pair GSHIP-617 resolved for the same spawn.
	test('emits the reported cost and per-model usage on a completed invocation', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE, '--fixture-cost=full'],
			loadIssue: () => '{"id":"CAM-32"}',
			resolveModel: () => ({ model: 'opus', effort: 'high' }),
		});
		await executor.execute({
			runId: 'run-32',
			issueId: 'CAM-32',
			sessionId: 'session-32',
			resume: false,
			cwd: createTestTmpdir('gship-claude-usage-'),
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});

		expect(events).toContainEqual({
			kind: 'provider.usage',
			payload: {
				model: 'opus',
				effort: 'high',
				totalCostUsd: 0.1234,
				usage: {
					inputTokens: 1000,
					outputTokens: 200,
					cacheCreationInputTokens: 50,
					cacheReadInputTokens: 25,
					thinkingTokens: 40,
				},
				modelUsage: [{
					model: 'claude-opus-4-6',
					inputTokens: 1000,
					outputTokens: 200,
					cacheReadInputTokens: 25,
					cacheCreationInputTokens: 50,
					costUsd: 0.1234,
				}],
			},
		});
	});

	// The CLI's own silence on cost must never read as a free invocation.
	test('omits the usage event entirely when the CLI reports no cost', async () => {
		const events: Array<{ kind: string }> = [];
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-33"}',
		});
		await executor.execute({
			runId: 'run-33',
			issueId: 'CAM-33',
			sessionId: 'session-33',
			resume: false,
			cwd: createTestTmpdir('gship-claude-no-usage-'),
			signal: new AbortController().signal,
			emit: (kind) => events.push({ kind }),
		});

		expect(events.map((event) => event.kind)).not.toContain('provider.usage');
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

	// GSHIP-704: the dedicated Claude subscription token reaches the real
	// executor child, riding alongside CLAUDE_CONFIG_DIR -- CLAUDE_CONFIG_DIR
	// also carries session/`--resume` state, so it is never displaced; the
	// same boundary `buildClaudeEnv` enforces, now proven end to end through a
	// real spawned process instead of only through the pure env-builder.
	test('carries the dedicated credential to the real executor child, alongside CLAUDE_CONFIG_DIR', async () => {
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-704"}',
			sourceEnv: { ...process.env, CLAUDE_CONFIG_DIR: '/operator/claude' },
			resolveClaudeCredential: () => 'sk-ant-oat01-executor-secret',
		});
		const result = await executor.execute({
			runId: 'run-704',
			issueId: 'CAM-704',
			sessionId: 'session-704',
			resume: false,
			cwd: createTestTmpdir('gship-claude-credential-executor-'),
			signal: new AbortController().signal,
			emit: () => {},
		});
		const { env } = JSON.parse(result.summary as string) as { env: Record<string, string | null> };
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-executor-secret');
		expect(env.CLAUDE_CONFIG_DIR).toBe('/operator/claude');
	});

	test('an unconfigured credential leaves CLAUDE_CONFIG_DIR reaching the child exactly as before this issue', async () => {
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-705"}',
			sourceEnv: { ...process.env, CLAUDE_CONFIG_DIR: '/operator/claude' },
		});
		const result = await executor.execute({
			runId: 'run-705',
			issueId: 'CAM-705',
			sessionId: 'session-705',
			resume: false,
			cwd: createTestTmpdir('gship-claude-no-credential-executor-'),
			signal: new AbortController().signal,
			emit: () => {},
		});
		const { env } = JSON.parse(result.summary as string) as { env: Record<string, string | null> };
		expect(env.CLAUDE_CONFIG_DIR).toBe('/operator/claude');
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeFalsy();
	});

	// GSHIP-627: only the raw stream kinds declare activity; the turn's own
	// bookkeeping kinds declare nothing and default to decision downstream.
	test('declares activity only for the streamed system and assistant events', async () => {
		const events: Array<{ kind: string; eventClass?: string }> = [];
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-34"}',
		});
		await executor.execute({
			runId: 'run-34',
			issueId: 'CAM-34',
			sessionId: 'session-34',
			resume: false,
			cwd: createTestTmpdir('gship-claude-event-class-'),
			signal: new AbortController().signal,
			emit: (kind, _payload, eventClass) => events.push({
				kind,
				...(eventClass === undefined ? {} : { eventClass }),
			}),
		});

		expect(events).toContainEqual({ kind: 'provider.system', eventClass: 'activity' });
		expect(events).toContainEqual({ kind: 'provider.activity', eventClass: 'activity' });
		expect(events.find((event) => event.kind === 'provider.result')?.eventClass).toBeUndefined();
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
		expect(result).toMatchObject({ approvedContract: '{"id":"CAM-22"}' });
	});

	test('labels internal orchestrator guidance as binding and non-human', async () => {
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"GSHIP-768"}',
		});
		const result = await executor.execute({
			runId: 'run-768-claude',
			issueId: 'GSHIP-768',
			sessionId: 'session-768-claude',
			resume: true,
			internalGuidance: {
				question: 'A decomposição integral amplia escopo?',
				guidance: 'Continue; a decomposição já está exigida pelo contrato aprovado.',
			},
			cwd: createTestTmpdir('gship-claude-internal-guidance-'),
			signal: new AbortController().signal,
			emit: () => {},
		});
		const { input } = JSON.parse(result.summary as string) as { input: string };
		const stdinMessage = JSON.parse(input.trim()) as { message: { content: string } };
		expect(stdinMessage.message.content).toContain('Binding internal guidance:');
		expect(stdinMessage.message.content).toContain('already covered by the operator-approved issue contract');
		expect(stdinMessage.message.content).toContain('does not represent a human decision or intervention');
		expect(stdinMessage.message.content).toContain('Continue; a decomposição já está exigida');
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
		const run = await runtime.startRun('CAM-21');
		await waitFor(() => childPid > 0 && isProcessAlive(childPid));

		const cancelled = await runtime.cancelRun(run.id);
		expect(cancelled?.state).toBe('interrupted');
		expect(isProcessAlive(childPid)).toBe(false);
		await runtime.stop();
		runtime.close();
	});

	// GSHIP-637: the same run.operator-guidance history GSHIP-630 carried into
	// the review prompt, now also reaching the executor's own prompt.
	test('forwards the run\'s operator decisions into the prompt the real child receives', async () => {
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-37"}',
		});
		const decisions = ['Keep the smaller seam.', 'Use fetch, not axios.'];
		const result = await executor.execute({
			runId: 'run-37',
			issueId: 'CAM-37',
			sessionId: 'session-37',
			resume: false,
			operatorDecisions: decisions,
			cwd: createTestTmpdir('gship-claude-decisions-'),
			signal: new AbortController().signal,
			emit: () => {},
		});
		const { input } = JSON.parse(result.summary as string) as { input: string };
		const stdinMessage = JSON.parse(input.trim()) as { message: { content: string } };
		expect(stdinMessage.message.content).toBe(
			buildWorkPrompt('CAM-37', '{"id":"CAM-37"}', false, undefined, undefined, decisions),
		);
	});

	// GSHIP-620: saving a model choice probes the CLI itself before persisting it.
	describe('probeClaudeModel', () => {
		test('accepts a clean read-only turn for the probed model and effort', async () => {
			const result = await probeClaudeModel(
				{ model: 'opus', effort: 'xhigh' },
				createTestTmpdir('gship-claude-probe-accept-'),
				{ command: ['bun', FIXTURE] },
			);
			expect(result).toEqual({ outcome: 'accepted' });
		});

		test('reports an explicit CLI refusal with the CLI\'s own message, carrying the probed flags', async () => {
			const result = await probeClaudeModel(
				{ model: 'ghost-model', effort: 'xhigh' },
				createTestTmpdir('gship-claude-probe-refuse-'),
				{ command: ['bun', FIXTURE, '--fixture-mode=error'] },
			);
			expect(result.outcome).toBe('refused');
			// The refusal text is echoed by the fixture from the actual argv, so this
			// also proves the probe's read-only argv carried --model and --effort.
			expect(result.message).toContain('ghost-model');
			expect(result.message).toContain('xhigh');
		});

		test('reports an inconclusive probe on timeout, never a refusal', async () => {
			const result = await probeClaudeModel(
				{ model: 'opus' },
				createTestTmpdir('gship-claude-probe-timeout-'),
				{ command: ['bun', FIXTURE, '--fixture-mode=wait'], timeoutMs: 50 },
			);
			expect(result.outcome).toBe('inconclusive');
			expect(result.message).toBeDefined();
		});
	});
});

// GSHIP-637: the same operator-decision block GSHIP-630 established for the
// reviewer's prompt, now also built into the executor's.
describe('buildWorkPrompt operator decisions (GSHIP-637)', () => {
	const issueId = 'CAM-637';
	const issue = '{"id":"CAM-637"}';

	// With no decisions -- every run's first turn -- the prompt is exactly the
	// role instructions plus the shared language contract (GSHIP-703) and the
	// issue record, with no decision block at all.
	test('with no decisions, the prompt is the base instructions and nothing else', () => {
		const prompt = buildWorkPrompt(issueId, issue, false, undefined, undefined, []);
		expect(prompt).toBe([
			`Implement Gateship issue ${issueId}.`,
			'Inspect the current working tree before editing and keep the change limited to this issue.',
			'Do not commit, push, merge, ship, or edit issue/runtime control state; the Gateship service owns lifecycle.',
			"Run only the smallest relevant checks while editing, then run the human-approved issue verification command once before completion; do not add `bun run check:all`, the full test suite, or other broad gates unless that exact command is already in the human-approved verification, because the service runs the project's `verify` script once after a clean review at the ship boundary.",
			'Return status completed when the issue work is ready for verification.',
			'Return status waiting-user only when a concrete operator decision is required; summarize the exact question and options.',
			'Keep this issue closed to its scope: work you discover outside it is not part of this run and must not be implemented here.',
			`Report such work in proposals instead, at most ${PROPOSAL_LIMITS.maxItems} items, each with a short title and the concrete evidence you saw while implementing. Return an empty array when nothing outside the scope came up.`,
			'The fresh worktree and the current main are the sources of truth. Before editing, compare the current code with the approved contract below.',
			'Adapt autonomously only files, seams, dependencies and mechanical details changed by earlier deliveries. Never ask the operator about purely technical drift.',
			'Report reconciliation as unchanged when the approved contract still maps directly to the current code, adapted when only that technical drift was incorporated, or contract-change-required when the objective, observable acceptance, risk, exclusions, evidence or verify commands must change.',
			'Use status completed only with reconciliation outcome unchanged or adapted. Use status waiting-user only with contract-change-required, and summarize the exact decision required.',
			'',
			...OPERATOR_LANGUAGE_CONTRACT,
			'',
			'Issue record:',
			issue,
		].join('\n'));
	});

	// The decisions argument this issue adds defaults to none, so every
	// existing call site that never passes it keeps behaving exactly as before.
	test('omitting the decisions argument leaves the prompt unchanged', () => {
		expect(buildWorkPrompt(issueId, issue, false, undefined, undefined)).toBe(
			buildWorkPrompt(issueId, issue, false, undefined, undefined, []),
		);
	});

	test('one decision is presented as a labeled, binding block', () => {
		const prompt = buildWorkPrompt(issueId, issue, false, undefined, undefined, ['Keep the smaller seam.']);
		expect(prompt).toContain('Decisions the operator has already made in this run');
		expect(prompt).toContain('binding, not suggestions');
		expect(prompt).toContain('1. Keep the smaller seam.');
		// The block sits after the scope instructions and before the issue record.
		expect(prompt.indexOf('Keep this issue closed to its scope'))
			.toBeLessThan(prompt.indexOf('Decisions the operator'));
		expect(prompt.indexOf('Decisions the operator')).toBeLessThan(prompt.indexOf('Issue record:'));
	});

	test('multiple decisions render numbered in the order given', () => {
		const prompt = buildWorkPrompt(issueId, issue, false, undefined, undefined, ['First.', 'Second.', 'Third.']);
		const first = prompt.indexOf('1. First.');
		const second = prompt.indexOf('2. Second.');
		const third = prompt.indexOf('3. Third.');
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(first);
		expect(third).toBeGreaterThan(second);
	});

	// The current turn's answer must stay clearly the current request, not one
	// more item folded into the history block above it.
	test('the latest operator response stays distinguishable from the decisions history', () => {
		const prompt = buildWorkPrompt(
			issueId,
			issue,
			true,
			undefined,
			'Use the smaller migration.',
			['Keep the smaller seam.', 'Use fetch, not axios.'],
		);
		expect(prompt).toContain('1. Keep the smaller seam.');
		expect(prompt).toContain('2. Use fetch, not axios.');
		expect(prompt).toContain(
			'The operator answered your previous request. Treat this as the decision for the current turn:',
		);
		expect(prompt).toContain('Use the smaller migration.');
		// The history block comes first, then the current turn's own answer.
		expect(prompt.indexOf('Decisions the operator')).toBeLessThan(
			prompt.indexOf('The operator answered your previous request'),
		);
		expect(prompt.indexOf('2. Use fetch, not axios.')).toBeLessThan(
			prompt.indexOf('Use the smaller migration.'),
		);
		// The current answer is never itself numbered into the history list.
		expect(prompt).not.toContain('3. Use the smaller migration.');
	});
});

// GSHIP-720: the CI evidence the runtime persists is shared verbatim by the
// executor and the read-only reviewer, so the ephemeral diagnosis command
// cannot live in it. It belongs to the executors' own prompt section, which
// buildWorkPrompt builds for both the Claude and the Codex executor.
describe('buildWorkPrompt CI correction guidance (GSHIP-720)', () => {
	const issueId = 'CAM-720';
	const issue = '{"id":"CAM-720"}';
	const ciFeedback = [
		'PR: #581',
		'Head: aaaa',
		'Required check: ci/build',
		'Check URL: https://github.com/acme/repo/actions/runs/7',
	].join('\n');

	function ciPrompt(): string {
		return buildWorkPrompt(issueId, issue, true, undefined, undefined, [], undefined, ciFeedback);
	}

	test('a CI correction round tells the executor how to read the failed log ephemerally', () => {
		const prompt = ciPrompt();
		expect(prompt).toContain('A required CI check failed on the current pull request head.');
		expect(prompt).toContain('`gh run view <check-url> --log-failed`');
		expect(prompt).toContain('Check URL: https://github.com/acme/repo/actions/runs/7');
	});

	test('the guidance forbids copying log output into any durable or operator-visible field', () => {
		const prompt = ciPrompt();
		expect(prompt).toContain(
			'Do not copy log output into run events, summaries, proposals, metrics or any operator-visible field; keep it in this session only.',
		);
	});

	// The guidance is attached to the CI round, not to the role: a run with no
	// failed check must not be told to go looking at CI logs at all.
	test('without CI feedback the prompt carries no diagnosis guidance', () => {
		const prompt = buildWorkPrompt(issueId, issue, false, undefined, undefined, []);
		expect(prompt).not.toContain('--log-failed');
		expect(prompt).not.toContain('A required CI check failed');
	});
});

describe('buildWorkPrompt issue verification correction guidance (GSHIP-756)', () => {
	test('presents the approved verification failure as a mechanical scoped correction', () => {
		const prompt = buildWorkPrompt(
			'GSHIP-756', '{"id":"GSHIP-756"}', true, undefined, undefined, [], undefined, undefined, undefined,
			'bun test: expected 0 failures',
		);
		expect(prompt).toContain('A human-approved issue verification command failed after your change.');
		expect(prompt).toContain('Apply only the mechanical correction needed for this approved command; do not widen the issue scope.');
		expect(prompt).toContain('Issue verification failure:\nbun test: expected 0 failures');
		expect(prompt).not.toContain('Review findings:');
		expect(prompt).not.toContain('Full verification output:');
	});
});

describe('buildWorkPrompt executor handoff (GSHIP-722)', () => {
	const issueId = 'CAM-722';
	const issue = '{"id":"CAM-722"}';

	function handoffPrompt(): string {
		return buildWorkPrompt(issueId, issue, false, undefined, undefined, [], undefined, undefined, {
			fromProvider: 'claude',
			reason: 'usage-limit',
			status: 'M src/a.ts',
			diff: 'diff --git a/src/a.ts b/src/a.ts',
		});
	}

	test('a handoff opens with taking over rather than a blind initial prompt or a resume', () => {
		const prompt = handoffPrompt();
		expect(prompt).toContain(`Take over execution of Gateship issue ${issueId} in a new session.`);
		expect(prompt).not.toContain(`Implement Gateship issue ${issueId}.`);
		expect(prompt).not.toContain('Continue the existing Gateship work session');
	});

	test('a handoff carries the origin, reason and the current diff and status', () => {
		const prompt = handoffPrompt();
		expect(prompt).toContain('This work transferred to you from claude after it reported usage-limit.');
		expect(prompt).toContain('Working tree status at handoff:');
		expect(prompt).toContain('M src/a.ts');
		expect(prompt).toContain('Diff against HEAD at handoff:');
		expect(prompt).toContain('diff --git a/src/a.ts b/src/a.ts');
	});

	test('a resumed turn never carries a handoff opening, even with one supplied', () => {
		const prompt = buildWorkPrompt(issueId, issue, true, undefined, undefined, [], undefined, undefined, {
			fromProvider: 'claude',
			reason: 'usage-limit',
			status: '',
			diff: '',
		});
		expect(prompt).toContain('Continue the existing Gateship work session');
		expect(prompt).not.toContain('Take over execution');
	});

	test('without a handoff the prompt carries no takeover section', () => {
		const prompt = buildWorkPrompt(issueId, issue, false, undefined, undefined, []);
		expect(prompt).not.toContain('This work transferred to you from');
		expect(prompt).not.toContain('Working tree status at handoff:');
	});
});
