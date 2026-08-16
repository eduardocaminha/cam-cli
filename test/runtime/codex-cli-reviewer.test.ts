import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { CodexCliReviewer } from '../../src/runtime/codex-cli-reviewer.ts';
import { buildCodexReviewArgv } from '../../src/runtime/codex-cli-executor.ts';
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
	test('uses the built-in uncommitted review without user config or write bypass', () => {
		const argv = buildCodexReviewArgv({ command: ['codex'] });
		expect(argv).toContain('review');
		expect(argv).toContain('--uncommitted');
		expect(argv).toContain('--ignore-user-config');
		expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(argv).not.toContain('resume');
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
});
