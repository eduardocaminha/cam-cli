import { expect, test } from 'bun:test';

import { AgentExecutorRouter } from '../../src/runtime/agent-executor-router.ts';
import type { RuntimeExecutionInput, RuntimeExecutor } from '../../src/runtime/run-runtime.ts';

function input(providerId: 'claude' | 'codex'): RuntimeExecutionInput {
	return {
		runId: 'run-1',
		issueId: 'CAM-1',
		sessionId: 'session-1',
		providerId,
		resume: false,
		cwd: '/worktree',
		signal: new AbortController().signal,
		emit: () => {},
	};
}

test('executor router follows the provider persisted on each run', async () => {
	const calls: string[] = [];
	const executor = (name: string): RuntimeExecutor => ({
		execute: async () => {
			calls.push(name);
			return { outcome: 'completed' };
		},
	});
	const router = new AgentExecutorRouter({
		claude: executor('claude'),
		codex: executor('codex'),
	});

	await router.execute(input('codex'));
	await router.execute(input('claude'));
	expect(calls).toEqual(['codex', 'claude']);
});
