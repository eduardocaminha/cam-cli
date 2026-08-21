// test/web/run-review.test.ts
//
// CAM-577 acceptance criterion 3: the production composition of `gship web`
// connects the real reviewer, and the review events reach the browser over the
// existing SSE stream, out of the existing durable store. No second poller, no
// tmux, no parallel state.

import { describe, expect, test } from 'bun:test';

import { createDefaultRunRuntimeOptions, startWebServer } from '../../src/commands/web.ts';
import { AgentExecutorRouter } from '../../src/runtime/agent-executor-router.ts';
import { AgentReviewerRouter } from '../../src/runtime/agent-reviewer-router.ts';
import { AgentCycleQuestionResolver } from '../../src/runtime/agent-cycle-question-resolver.ts';
import { GitIssueVerifier } from '../../src/runtime/git-runtime.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

async function readStream(body: ReadableStream<Uint8Array>, until: string): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	try {
		for (let read = 0; read < 64; read += 1) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
			if (text.includes(until)) break;
		}
	} finally {
		await reader.cancel();
	}
	return text;
}

describe('web composition of the independent reviewer', () => {
	test('the production runtime is composed with the real reviewer', () => {
		const options = createDefaultRunRuntimeOptions(
			createTestTmpdir('gship-web-review-'),
			undefined,
			'revision-production',
		);
		try {
			expect(options.executor).toBeInstanceOf(AgentExecutorRouter);
			expect(options.verifier).toBeInstanceOf(GitIssueVerifier);
			expect(options.reviewer).toBeInstanceOf(AgentReviewerRouter);
			expect(options.cycleQuestionResolver).toBeInstanceOf(AgentCycleQuestionResolver);
			expect(options.workflowRevision).toBe('revision-production');
		} finally {
			options.store.close();
		}
	});

	test('review start, verdict and fix-limit events are persisted and streamed over SSE', async () => {
		const runtime = new RunRuntime({
			cwd: '/project',
			store: new RunStore(':memory:'),
			newId: () => 'run-web-review',
			newSessionId: () => 'session-web-review',
			executor: { execute: async () => ({ outcome: 'completed', summary: 'change written' }) },
			verifier: { verify: async () => ({ ok: true }) },
			reviewer: {
				review: async () => ({ verdict: 'findings', detail: 'src/a.ts: unhandled null' }),
			},
		});
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-web-review-sse-'),
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;

		try {
			const started = await fetch(`${origin}/api/runs`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ issueId: 'CAM-577' }),
			});
			expect(started.status).toBe(202);

			const deadline = Date.now() + 2_000;
			while (runtime.getRun('run-web-review')?.state !== 'waiting-user') {
				if (Date.now() >= deadline) throw new Error('timed out waiting for waiting-user');
				await Bun.sleep(5);
			}

			// Replay from the durable store: the same stream a reconnecting browser gets.
			const stream = await fetch(`${origin}/api/events?after=0`);
			expect(stream.headers.get('content-type')).toContain('text/event-stream');
			expect(stream.body).not.toBeNull();
			const text = await readStream(stream.body as ReadableStream<Uint8Array>, 'run.review-fix-limit');
			expect(text).toContain('"kind":"run.review-started"');
			expect(text).toContain('"kind":"run.review-fix-requested"');
			expect(text).toContain('"kind":"run.review-fix-limit"');
			expect(text).toContain('src/a.ts: unhandled null');

			const runs = await (await fetch(`${origin}/api/runs`)).json() as {
				runs: Array<{ state: string; fixRounds: number }>;
			};
			expect(runs.runs[0]).toMatchObject({ state: 'waiting-user', fixRounds: 1 });
		} finally {
			await handle.stop();
			runtime.close();
		}
	});
});
