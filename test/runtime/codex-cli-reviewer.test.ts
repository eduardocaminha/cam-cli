import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { buildReviewPrompt, collectChange } from '../../src/runtime/claude-cli-reviewer.ts';
import { CodexCliReviewer } from '../../src/runtime/codex-cli-reviewer.ts';
import { buildCodexReviewArgv } from '../../src/runtime/codex-cli-executor.ts';
import type { ModelSlot } from '../../src/runtime/model-settings.ts';
import type { RuntimeExecutionInput } from '../../src/runtime/run-runtime.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'runtime', 'codex-cli-fixture.ts');

function input(): RuntimeExecutionInput {
	return {
		runId: 'run-review',
		issueId: 'CAM-1',
		sessionId: 'implementer-session',
		providerId: 'codex',
		resume: false,
		cwd: createTestTmpdir('gship-codex-review-'),
		signal: new AbortController().signal,
		emit: () => {},
	};
}

describe('independent Codex reviewer', () => {
	test('uses a fresh structured exec review with read-only access', () => {
		const argv = buildCodexReviewArgv({ command: ['codex'] });
		expect(argv).toContain('exec');
		expect(argv).not.toContain('review');
		expect(argv).not.toContain('--uncommitted');
		expect(argv).toContain('--ignore-user-config');
		expect(argv).toContain('sandbox_mode="read-only"');
		expect(argv).toContain('approval_policy="never"');
		expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(argv).not.toContain('resume');
		expect(argv.at(-1)).toBe('-');
	});

	// GSHIP-617: the Codex reviewer carries its own slot, resolved per review.
	// The argv shape itself is asserted in codex-cli-executor.test.ts, over the
	// review builder both roles share.
	test('records the slot resolved for each review, and nothing when unset', async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		let slot: ModelSlot = { model: 'gpt-5-codex', effort: 'high' };
		const reviewer = new CodexCliReviewer({
			command: ['bun', FIXTURE, '--fixture-mode=review'],
			loadIssue: () => '{"id":"CAM-1"}',
			runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
			resolveModel: () => slot,
		});
		const review = () => reviewer.review({
			...input(),
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});

		expect(await review()).toEqual({ verdict: 'clean' });
		expect(events).toContainEqual({
			kind: 'review.model',
			payload: { model: 'gpt-5-codex', effort: 'high' },
		});

		slot = { effort: 'minimal' };
		expect(await review()).toEqual({ verdict: 'clean' });
		expect(events).toContainEqual({ kind: 'review.model', payload: { effort: 'minimal' } });

		const bare = new CodexCliReviewer({
			command: ['bun', FIXTURE, '--fixture-mode=review'],
			loadIssue: () => '{"id":"CAM-1"}',
			runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
		});
		const bareEvents: string[] = [];
		expect(await bare.review({ ...input(), emit: (kind) => bareEvents.push(kind) }))
			.toEqual({ verdict: 'clean' });
		expect(bareEvents).not.toContain('review.model');
	});

	test('returns clean and findings verdicts from fresh fixture sessions', async () => {
		const clean = new CodexCliReviewer({
			command: ['bun', FIXTURE, '--fixture-mode=review'],
			loadIssue: () => '{"id":"CAM-1"}',
			runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
		});
		expect(await clean.review(input())).toEqual({ verdict: 'clean' });

		const findings = new CodexCliReviewer({
			command: ['bun', FIXTURE, '--fixture-mode=review', '--fixture-verdict=FINDINGS'],
			loadIssue: () => '{"id":"CAM-1"}',
			runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
		});
		expect(await findings.review(input())).toEqual({
			verdict: 'findings',
			detail: '1. src/reviewed.ts: fixture finding',
		});
	});

	// GSHIP-630: buildReviewPrompt is shared by both providers, so the same
	// operator decisions produce the same labeled block for either one -- this
	// reviewer is proven here, the Claude reviewer in claude-cli-reviewer.test.ts.
	test('forwards the run\'s operator decisions into the prompt, same block as the Claude reviewer', async () => {
		let capturedPrompt = '';
		const decisions = ['Keep the smaller seam.', 'Use fetch, not axios.'];
		const reviewer = new CodexCliReviewer({
			session: {
				provider: 'codex',
				run: async (sessionInput) => {
					capturedPrompt = sessionInput.prompt;
					return { summary: '', structuredOutput: { verdict: 'CLEAN', findings: [] } };
				},
			},
			loadIssue: () => '{"id":"CAM-1"}',
			runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
		});

		expect(await reviewer.review({ ...input(), operatorDecisions: decisions }))
			.toEqual({ verdict: 'clean' });

		const change = collectChange(() => ({ exitCode: 0, stdout: '', stderr: '' }), 'ignored');
		expect(capturedPrompt).toBe(buildReviewPrompt('CAM-1', '{"id":"CAM-1"}', change, decisions));
	});
});
