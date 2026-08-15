import { describe, expect, test } from 'bun:test';

import {
	createGitRuntimePreflight,
	GitWorkingTreeVerifier,
	type GitCommandRunner,
} from '../../src/runtime/git-runtime.ts';

function gitRunner(values: { branch?: string; status?: string; diffExit?: number }): GitCommandRunner {
	return (_cwd, args) => {
		if (args[0] === 'branch') {
			return { exitCode: 0, stdout: `${values.branch ?? 'codex/work'}\n`, stderr: '' };
		}
		if (args[0] === 'status') {
			return { exitCode: 0, stdout: values.status ?? '', stderr: '' };
		}
		return { exitCode: values.diffExit ?? 0, stdout: '', stderr: 'bad diff' };
	};
}

const verificationInput = {
	runId: 'run-1',
	issueId: 'CAM-1',
	sessionId: 'session-1',
	resume: false,
	cwd: '/project',
	signal: new AbortController().signal,
	emit: () => {},
};

describe('git runtime boundary', () => {
	test('accepts only a clean non-main branch with a real issue', () => {
		const valid = createGitRuntimePreflight('/project', {
			runGit: gitRunner({ branch: 'codex/CAM-1' }),
			issueExists: () => true,
		});
		expect(() => valid('CAM-1')).not.toThrow();

		const main = createGitRuntimePreflight('/project', {
			runGit: gitRunner({ branch: 'main' }),
			issueExists: () => true,
		});
		expect(() => main('CAM-1')).toThrow('non-main branch');

		const dirty = createGitRuntimePreflight('/project', {
			runGit: gitRunner({ status: ' M src/a.ts' }),
			issueExists: () => true,
		});
		expect(() => dirty('CAM-1')).toThrow('clean working tree');
	});

	test('verifies diff integrity and requires an actual working-tree change', async () => {
		const valid = new GitWorkingTreeVerifier({ runGit: gitRunner({ status: ' M src/a.ts' }) });
		expect(await valid.verify(verificationInput)).toEqual({ ok: true });

		const unchanged = new GitWorkingTreeVerifier({ runGit: gitRunner({ status: '' }) });
		expect(await unchanged.verify(verificationInput)).toMatchObject({
			ok: false,
			detail: 'executor completed without a working-tree change',
		});

		const invalidDiff = new GitWorkingTreeVerifier({
			runGit: gitRunner({ status: ' M src/a.ts', diffExit: 1 }),
		});
		expect(await invalidDiff.verify(verificationInput)).toMatchObject({
			ok: false,
			detail: expect.stringContaining('git diff check failed'),
		});
	});
});
