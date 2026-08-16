import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	buildClaudeCliArgv,
	ClaudeCliExecutor,
} from '../../src/runtime/claude-cli-executor.ts';
import { projectAssistantActivity } from '../../src/runtime/claude-cli-process.ts';
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
		const resumed = buildClaudeCliArgv({
			command: ['claude'],
			sessionId: 'ABC-123',
			resume: true,
			permissionMode: 'bypassPermissions',
		});
		expect(resumed).toContain('--resume');
		expect(resumed).toContain('abc-123');
		expect(resumed).not.toContain('--session-id');
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

	test('kills and awaits the real child process group on cancellation', async () => {
		let childPid = 0;
		const executor = new ClaudeCliExecutor({
			command: ['bun', FIXTURE],
			loadIssue: () => '{"id":"CAM-21"}',
			sourceEnv: { ...process.env, GSHIP_FIXTURE_MODE: 'wait' },
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
