import { describe, expect, test } from 'bun:test';

import {
	createGitRuntimePreflight,
	defaultRunGit,
	GitEvidenceChecker,
	GitIssueVerifier,
	type GitCommandRunner,
} from '../../src/runtime/git-runtime.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

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

// GSHIP-629: the spec's executable premise. Checked by GitEvidenceChecker in
// the run's own workspace, after workspace.prepare and before the executor
// ever runs (run-runtime.ts) -- never by the preflight above, which runs
// before that workspace exists (the very first test in this file already
// covers a spec with no evidence field starting normally, unaffected).
describe('GitEvidenceChecker', () => {
	function issueWithEvidence(evidence: Array<{ command: string; output: string }>): string {
		const spec = { scope: 'Outcome backed by evidence.', verify: ['bun test'], evidence };
		return JSON.stringify({ spec });
	}

	test('a spec without evidence passes without running any command', async () => {
		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => JSON.stringify({ spec: { scope: 'x', verify: ['bun test'] } }),
			runCommand: async () => {
				throw new Error('must not run any command when the spec has no evidence');
			},
		});
		expect(await checker.check(verificationInput)).toEqual({ ok: true });
	});

	test('matching evidence passes, running each command in the input cwd', async () => {
		const commands: string[] = [];
		const cwds: string[] = [];
		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => issueWithEvidence([{ command: 'echo hi', output: 'hi' }]),
			runCommand: async ({ cwd, command }) => {
				commands.push(command);
				cwds.push(cwd);
				return { exitCode: 0, stdout: 'hi\n', stderr: '' };
			},
		});

		expect(await checker.check(verificationInput)).toEqual({ ok: true });
		expect(commands).toEqual(['echo hi']);
		expect(cwds).toEqual([verificationInput.cwd]);
	});

	test('diverging evidence fails, showing the command and both outputs', async () => {
		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => issueWithEvidence([{ command: 'wc -l file.txt', output: '3 file.txt' }]),
			runCommand: async () => ({ exitCode: 0, stdout: '5 file.txt\n', stderr: '' }),
		});

		const result = await checker.check(verificationInput);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('wc -l file.txt');
		expect(result.detail).toContain('3 file.txt');
		expect(result.detail).toContain('5 file.txt');
	});

	test('an evidence command that fails to run is treated as divergence', async () => {
		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => issueWithEvidence([{ command: 'nonexistent-tool', output: 'irrelevant' }]),
			runCommand: async () => ({ exitCode: 127, stdout: '', stderr: 'command not found' }),
		});

		const result = await checker.check(verificationInput);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('evidence diverged');
	});

	// A command run against a repository that moved can print far more than the
	// 600 chars recorded at specify time; the refusal detail must not embed an
	// unbounded amount of it, same as the legacy verify diagnostic.
	test('caps the observed output shown in the divergence detail', async () => {
		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => issueWithEvidence([{ command: 'cat huge-file', output: 'short recorded output' }]),
			runCommand: async () => ({ exitCode: 0, stdout: 'x'.repeat(3_000), stderr: '' }),
		});

		const result = await checker.check(verificationInput);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('short recorded output');
		expect(result.detail).toContain('x'.repeat(2_000));
		expect(result.detail).not.toContain('x'.repeat(2_001));
		expect(result.detail?.length).toBeLessThan(2_200);
	});

	// GSHIP-629 (review): the checker runs in the workspace the run already
	// has -- it must never cut a worktree of its own, additional or otherwise.
	test('never registers a git worktree of its own', async () => {
		const repo = createTestTmpdir('gship-evidence-check-');
		defaultRunGit(repo, ['init', '-q']);
		const before = defaultRunGit(repo, ['worktree', 'list']).stdout;

		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => issueWithEvidence([{ command: 'echo hi', output: 'hi' }]),
			runCommand: async () => ({ exitCode: 0, stdout: 'hi\n', stderr: '' }),
		});
		await checker.check({ ...verificationInput, cwd: repo });

		expect(defaultRunGit(repo, ['worktree', 'list']).stdout).toBe(before);
	});

	// GSHIP-629 (review): an evidence command runs through the same
	// cancellable, timeout-bound path GitIssueVerifier already uses, so a
	// command that hangs is terminated by the run's own abort instead of
	// blocking the service.
	test('a hanging evidence command is terminated by the run signal instead of hanging the process', async () => {
		const controller = new AbortController();
		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => issueWithEvidence([
				{ command: "trap 'exit 0' TERM; while :; do sleep 0.1; done", output: 'never observed' },
			]),
			terminationGraceMs: 50,
		});
		const pending = checker.check({
			...verificationInput,
			cwd: process.cwd(),
			signal: controller.signal,
		});
		await Bun.sleep(30);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});
