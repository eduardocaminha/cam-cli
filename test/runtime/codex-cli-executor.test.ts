import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ProviderCallError } from '../../src/runtime/agent-session.ts';
import { buildWorkPrompt } from '../../src/runtime/claude-cli-executor.ts';
import {
	buildCodexCliArgv,
	buildCodexEnv,
	buildCodexReviewArgv,
	CodexAgentSession,
	CodexCliExecutor,
	probeCodexModel,
} from '../../src/runtime/codex-cli-executor.ts';
import type { ModelSlot } from '../../src/runtime/model-settings.ts';
import { OPERATOR_LANGUAGE_CONTRACT } from '../../src/runtime/operator-language.ts';
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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
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
		// GSHIP-620: without this, a read-only turn started outside a directory
		// Codex already trusts is refused before it ever reaches the model check.
		expect(readOnly).toContain('--skip-git-repo-check');
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
			payload: { model: 'gpt-5-codex', effort: 'high', provider: 'codex' },
		});

		// An unconfigured slot spawns and reads exactly as it did before.
		slot = {};
		const second = await execute();
		expect(second.summary).not.toContain('"-m"');
		expect(second.summary).not.toContain('model_reasoning_effort');
		expect(events).toContainEqual({
			kind: 'provider.model',
			payload: { model: 'provider-default', effort: 'provider-default', provider: 'codex' },
		});
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

	test('classifies a protocol-reported subscription limit', async () => {
		const session = new CodexAgentSession({
			command: ['bun', FIXTURE, '--fixture-mode=usage-limit'],
		});
		let failure: unknown;
		try {
			await session.run({
				sessionId: 'codex-session-limit',
				resume: true,
				cwd: createTestTmpdir('gship-codex-usage-limit-'),
				prompt: 'continue',
				signal: new AbortController().signal,
				emit: () => {},
				eventPrefix: 'provider',
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderCallError);
		expect(failure).toMatchObject({ provider: 'codex', kind: 'usage-limit' });
	});

	test('classifies a silent CLI as unavailable after reaping its process', async () => {
		let childPid = 0;
		const session = new CodexAgentSession({
			command: ['bun', FIXTURE, '--fixture-mode=wait'],
			activityTimeoutMs: 50,
			terminationGraceMs: 100,
			onSpawn: (pid) => { childPid = pid; },
		});
		let failure: unknown;
		try {
			await session.run({
				sessionId: 'codex-session-silent',
				resume: false,
				cwd: createTestTmpdir('gship-codex-silent-'),
				prompt: 'continue',
				signal: new AbortController().signal,
				emit: () => {},
				eventPrefix: 'provider',
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderCallError);
		expect(failure).toMatchObject({ provider: 'codex', kind: 'transport-unavailable' });
		expect((failure as Error).message).toContain('50ms');
		expect(isProcessAlive(childPid)).toBe(false);
	});

	test('keeps an unrecognized turn failure unknown instead of calling it a model refusal', async () => {
		const session = new CodexAgentSession({
			command: ['bun', FIXTURE, '--fixture-mode=failed'],
		});
		let failure: unknown;
		try {
			await session.run({
				sessionId: 'codex-session-unknown',
				resume: true,
				cwd: createTestTmpdir('gship-codex-unknown-failure-'),
				prompt: 'continue',
				signal: new AbortController().signal,
				emit: () => {},
				eventPrefix: 'provider',
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProviderCallError);
		expect(failure).toMatchObject({ provider: 'codex', kind: 'unknown' });
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

	// GSHIP-637: the same operator-decision history GSHIP-630 carried into the
	// Claude reviewer's prompt, shared by buildWorkPrompt and now also reaching
	// the Codex executor's prompt.
	test('forwards the run\'s operator decisions into the prompt the real child receives', async () => {
		const executor = new CodexCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-37"}',
		});
		const decisions = ['Keep the smaller seam.', 'Use fetch, not axios.'];
		const result = await executor.execute({
			runId: 'run-37',
			issueId: 'CAM-37',
			sessionId: 'provisional',
			resume: false,
			operatorDecisions: decisions,
			cwd: createTestTmpdir('gship-codex-decisions-'),
			signal: new AbortController().signal,
			emit: () => {},
		});
		const { input } = JSON.parse(result.summary as string) as { input: string };
		expect(input).toBe(
			buildWorkPrompt('CAM-37', '{"id":"CAM-37"}', false, undefined, undefined, decisions),
		);
		// GSHIP-703: same shared builder, so the real Codex child receives the
		// one operator language contract, not a Codex-specific copy of it.
		expect(input).toContain(OPERATOR_LANGUAGE_CONTRACT.join('\n'));
	});

	test('uses the shared typed internal guidance contract and preserves the approved issue', async () => {
		const executor = new CodexCliExecutor({
			command: ['bun', FIXTURE, '--fixture-mode=waiting-user'],
			loadIssue: () => '{"id":"GSHIP-768"}',
		});
		const result = await executor.execute({
			runId: 'run-768-codex',
			issueId: 'GSHIP-768',
			sessionId: 'session-768-codex',
			resume: true,
			internalGuidance: {
				question: 'A decomposição integral amplia escopo?',
				guidance: 'Continue dentro do contrato aprovado.',
			},
			cwd: createTestTmpdir('gship-codex-internal-guidance-'),
			signal: new AbortController().signal,
			emit: () => {},
		});
		expect(result).toMatchObject({
			outcome: 'waiting-user',
			approvedContract: '{"id":"GSHIP-768"}',
		});
		const summary = JSON.parse(result.summary as string) as { input: string };
		expect(summary.input).toContain('Binding internal guidance:');
		expect(summary.input).toContain('does not represent a human decision or intervention');
		expect(summary.input).toContain('Continue dentro do contrato aprovado.');
	});

	// GSHIP-720: the ephemeral CI diagnosis guidance is role-specific, and both
	// executors share buildWorkPrompt, so the real Codex child receives it too.
	test('forwards the CI correction diagnosis guidance into the prompt the real child receives', async () => {
		const executor = new CodexCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-720"}',
		});
		const ciFeedback = [
			'PR: #581',
			'Head: aaaa',
			'Required check: ci/build',
			'Check URL: https://github.com/acme/repo/actions/runs/7',
		].join('\n');
		const result = await executor.execute({
			runId: 'run-720',
			issueId: 'CAM-720',
			sessionId: 'provisional',
			resume: true,
			ciFeedback,
			cwd: createTestTmpdir('gship-codex-ci-'),
			signal: new AbortController().signal,
			emit: () => {},
		});
		const { input } = JSON.parse(result.summary as string) as { input: string };
		expect(input).toContain('A required CI check failed on the current pull request head.');
		expect(input).toContain('`gh run view <check-url> --log-failed`');
		expect(input).toContain(
			'Do not copy log output into run events, summaries, proposals, metrics or any operator-visible field; keep it in this session only.',
		);
		expect(input).toContain(ciFeedback);
	});

	// GSHIP-620: saving a model choice probes the CLI itself before persisting it.
	describe('probeCodexModel', () => {
		test('accepts a clean read-only turn for the probed model and effort', async () => {
			const result = await probeCodexModel(
				{ model: 'gpt-5-codex', effort: 'high' },
				createTestTmpdir('gship-codex-probe-accept-'),
				{ command: ['bun', FIXTURE] },
			);
			expect(result).toEqual({ outcome: 'accepted' });
		});

		test('reports an explicit CLI refusal with the CLI\'s own message, carrying the probed flags', async () => {
			const result = await probeCodexModel(
				{ model: 'ghost-model', effort: 'high' },
				createTestTmpdir('gship-codex-probe-refuse-'),
				{ command: ['bun', FIXTURE, '--fixture-mode=error'] },
			);
			expect(result.outcome).toBe('refused');
			// The refusal text is echoed by the fixture from the actual argv, so this
			// also proves the probe's read-only argv carried -m and the effort override.
			expect(result.message).toContain('ghost-model');
			expect(result.message).toContain('high');
		});

		test('reports an inconclusive probe on timeout, never a refusal', async () => {
			const result = await probeCodexModel(
				{ model: 'gpt-5-codex' },
				createTestTmpdir('gship-codex-probe-timeout-'),
				{ command: ['bun', FIXTURE, '--fixture-mode=wait'], timeoutMs: 50 },
			);
			expect(result.outcome).toBe('inconclusive');
			expect(result.message).toBeDefined();
		});

		test('reports an inconclusive probe for a generic transport error, never a refusal', async () => {
			// A dead or unreachable process reads the same protocol-level `error`
			// event whether the model was rejected or the CLI just crashed; only a
			// clean turn.failed is trusted as an explicit refusal.
			const result = await probeCodexModel(
				{ model: 'gpt-5-codex' },
				createTestTmpdir('gship-codex-probe-transport-error-'),
				{ command: ['bun', FIXTURE, '--fixture-mode=structured-error-exit'] },
			);
			expect(result.outcome).toBe('inconclusive');
			expect(result.message).toContain('structured fixture diagnostic');
		});
	});
});
