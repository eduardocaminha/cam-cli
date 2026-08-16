import { describe, expect, test } from 'bun:test';

import {
	createGitRuntimePreflight,
	GitIssueVerifier,
	type GitCommandRunner,
} from '../../src/runtime/git-runtime.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';

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

function issueWithCriteria(criteria: string[]): string {
	return JSON.stringify({ spec: { acceptanceCriteria: criteria } });
}

function issueWithVerification(commands: string[]): string {
	return JSON.stringify({ spec: { scope: 'Expected outcome.', verify: commands } });
}

describe('git runtime boundary', () => {
	test('requires a real issue and source ref without constraining the host checkout', () => {
		const spec = { scope: 'Approved outcome.', verify: ['bun test'] };
		const valid = createGitRuntimePreflight('/project', {
			runGit: gitRunner({ branch: 'main', status: '?? operator-notes.txt' }),
			issueExists: () => true,
			loadIssue: () => JSON.stringify({
				spec,
				approval: { fingerprint: fingerprintSpec(spec), approvedAt: '2026-08-16T00:00:00Z' },
			}),
		});
		expect(() => valid('CAM-1')).not.toThrow();

		const missingIssue = createGitRuntimePreflight('/project', {
			runGit: gitRunner({}),
			issueExists: () => false,
		});
		expect(() => missingIssue('CAM-404')).toThrow('issue not found on origin/main');

		const missingSource = createGitRuntimePreflight('/project', {
			runGit: (_cwd, args) => args[0] === 'fetch'
				? { exitCode: 0, stdout: '', stderr: '' }
				: { exitCode: 1, stdout: '', stderr: 'missing origin/main' },
			issueExists: () => true,
		});
		expect(() => missingSource('CAM-1')).toThrow('cannot resolve origin/main');

		const unapproved = createGitRuntimePreflight('/project', {
			runGit: gitRunner({}), issueExists: () => true,
			loadIssue: () => JSON.stringify({ spec }),
		});
		expect(() => unapproved('CAM-2')).toThrow('CAM-2 has no approval');

		const stale = createGitRuntimePreflight('/project', {
			runGit: gitRunner({}), issueExists: () => true,
			loadIssue: () => JSON.stringify({ spec: { ...spec, scope: 'Changed.' }, approval: {
				fingerprint: fingerprintSpec(spec), approvedAt: '2026-08-16T00:00:00Z',
			} }),
		});
		expect(() => stale('CAM-3')).toThrow('CAM-3 has stale approval');
	});

	test('verifies diff integrity and requires an actual working-tree change', async () => {
		const valid = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithVerification(['true']),
			runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		});
		expect(await valid.verify(verificationInput)).toEqual({ ok: true });

		const unchanged = new GitIssueVerifier({ runGit: gitRunner({ status: '' }) });
		expect(await unchanged.verify(verificationInput)).toMatchObject({
			ok: false,
			detail: 'executor completed without a working-tree change',
		});

		const invalidDiff = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts', diffExit: 1 }),
		});
		expect(await invalidDiff.verify(verificationInput)).toMatchObject({
			ok: false,
			detail: expect.stringContaining('git diff check failed'),
		});
	});

	test('runs every legacy issue oracle in order and emits command lifecycle events', async () => {
		const commands: string[] = [];
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const verifier = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithCriteria([
				'first [oracle: named-command bun test one]',
				'second [oracle: file-assert test -f output.txt]',
			]),
			runCommand: async ({ command }) => {
				commands.push(command);
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});

		const result = await verifier.verify({
			...verificationInput,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});

		expect(result).toEqual({ ok: true });
		expect(commands).toEqual(['bun test one', 'test -f output.txt']);
		expect(events.map((event) => event.kind)).toEqual([
			'verify.command.started',
			'verify.command.completed',
			'verify.command.started',
			'verify.command.completed',
		]);
	});

	test('fails closed for missing or unsupported oracles and limits command diagnostics', async () => {
		const missing = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithCriteria(['no directive']),
		});
		expect(await missing.verify(verificationInput)).toMatchObject({
			ok: false,
			detail: 'legacy acceptance criterion 1 has no runnable command',
		});

		const unsupported = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithCriteria(['visual [oracle: reviewer-judgment]']),
		});
		expect(await unsupported.verify(verificationInput)).toMatchObject({
			ok: false,
			detail: 'legacy acceptance criterion 1 uses unsupported oracle reviewer-judgment',
		});

		const failed = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithCriteria(['fails [oracle: false]']),
			runCommand: async () => ({ exitCode: 7, stdout: 'x'.repeat(3_000), stderr: '' }),
		});
		const failedResult = await failed.verify(verificationInput);
		expect(failedResult.ok).toBe(false);
		expect(failedResult.detail).toEndWith('x'.repeat(2_000));
		expect(failedResult.detail?.length).toBeLessThan(2_100);
	});

	test('cancels and awaits a real oracle subprocess group', async () => {
		const controller = new AbortController();
		const verifier = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithCriteria([
				"wait [oracle: trap 'exit 0' TERM; while :; do sleep 0.1; done]",
			]),
			terminationGraceMs: 50,
		});
		const pending = verifier.verify({
			...verificationInput,
			cwd: process.cwd(),
			signal: controller.signal,
		});
		await Bun.sleep(30);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});
