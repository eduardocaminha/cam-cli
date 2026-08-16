import { expect, test } from 'bun:test';

import { AgentReviewerRouter } from '../../src/runtime/agent-reviewer-router.ts';
import type { RuntimeExecutionInput, RuntimeReviewer } from '../../src/runtime/run-runtime.ts';

test('reviewer router follows the provider persisted on the run', async () => {
	const calls: string[] = [];
	const reviewer = (name: string): RuntimeReviewer => ({
		review: async () => {
			calls.push(name);
			return { verdict: 'clean' };
		},
	});
	const router = new AgentReviewerRouter({
		claude: reviewer('claude'),
		codex: reviewer('codex'),
	});
	const input = {
		runId: 'run-1',
		issueId: 'CAM-1',
		sessionId: 'session-1',
		providerId: 'codex',
		resume: false,
		cwd: '/worktree',
		signal: new AbortController().signal,
		emit: () => {},
	} satisfies RuntimeExecutionInput;

	await router.review(input);
	expect(calls).toEqual(['codex']);
});
