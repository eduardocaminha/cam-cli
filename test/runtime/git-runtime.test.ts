import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
	createGitRuntimePreflight,
	defaultRunGit,
	GitEvidenceChecker,
	GitFullVerifier,
	GitIssueVerifier,
	type GitCommandRunner,
	runVerificationCommand,
	VERIFICATION_COMMAND_TIMEOUT_MS,
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

	test('runs every verify command in order and emits command lifecycle events', async () => {
		const commands: string[] = [];
		const timeouts: Array<number | undefined> = [];
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const verifier = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithVerification(['bun test one', 'test -f output.txt']),
			runCommand: async ({ command, timeoutMs }) => {
				commands.push(command);
				timeouts.push(timeoutMs);
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});

		const result = await verifier.verify({
			...verificationInput,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});

		expect(result).toEqual({ ok: true });
		expect(commands).toEqual(['bun test one', 'test -f output.txt']);
		expect(timeouts).toEqual([undefined, undefined]);
		expect(events.map((event) => event.kind)).toEqual([
			'verify.command.started',
			'verify.command.completed',
			'verify.command.started',
			'verify.command.completed',
		]);
	});

	test('fails closed when the issue has no verification commands', async () => {
		const missing = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => JSON.stringify({ spec: { scope: 'no verify' } }),
		});
		expect(await missing.verify(verificationInput)).toMatchObject({
			ok: false,
			detail: 'issue has no verification commands',
		});
	});

	test('caps command diagnostics on a failed verification command', async () => {
		const failed = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithVerification(['false']),
			runCommand: async () => ({ exitCode: 7, stdout: 'x'.repeat(3_000), stderr: '' }),
		});
		const failedResult = await failed.verify(verificationInput);
		expect(failedResult.ok).toBe(false);
		expect(failedResult.detail).toEndWith('x'.repeat(2_000));
		expect(failedResult.detail?.length).toBeLessThan(2_100);
	});

	test('cancels and awaits a real verify subprocess group', async () => {
		const controller = new AbortController();
		const verifier = new GitIssueVerifier({
			runGit: gitRunner({ status: ' M src/a.ts' }),
			loadIssue: () => issueWithVerification([
				"trap 'exit 0' TERM; while :; do sleep 0.1; done",
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

	test('the shared verification runner times out and terminates its subprocess group', async () => {
		const result = await runVerificationCommand({
			cwd: process.cwd(),
			command: "trap 'exit 0' TERM; while :; do sleep 0.1; done",
			signal: new AbortController().signal,
			timeoutMs: 20,
		}, 50);
		expect(result).toMatchObject({ exitCode: 124, timedOut: true });
		expect(result.stderr).toContain('timed out after 20ms');
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
		const timeouts: Array<number | undefined> = [];
		const checker = new GitEvidenceChecker({
			loadIssueFromWorkspace: () => issueWithEvidence([{ command: 'echo hi', output: 'hi' }]),
			runCommand: async ({ cwd, command, timeoutMs }) => {
				commands.push(command);
				cwds.push(cwd);
				timeouts.push(timeoutMs);
				return { exitCode: 0, stdout: 'hi\n', stderr: '' };
			},
		});

		expect(await checker.check(verificationInput)).toEqual({ ok: true });
		expect(commands).toEqual(['echo hi']);
		expect(cwds).toEqual([verificationInput.cwd]);
		expect(timeouts).toEqual([VERIFICATION_COMMAND_TIMEOUT_MS]);
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

// GSHIP-649: the project's own full verification manifest, read straight from
// the run's own workspace `package.json` -- never a hardcoded command of its
// own -- and run through the same cancellable, timeout-bound path
// GitIssueVerifier and GitEvidenceChecker already use.
describe('GitFullVerifier', () => {
	function writePackageJson(dir: string, content: string): void {
		writeFileSync(join(dir, 'package.json'), content);
	}

	function neverRunCommand(): never {
		throw new Error('must not run any command when the project declares no verify script');
	}

	test('skips without running any command when package.json is missing', async () => {
		const dir = createTestTmpdir('gship-full-verify-no-file-');
		const verifier = new GitFullVerifier({ runCommand: () => neverRunCommand() });
		expect(await verifier.verify({ ...verificationInput, cwd: dir })).toEqual({ ok: true, skipped: true });
	});

	test('skips without running any command when package.json is invalid JSON', async () => {
		const dir = createTestTmpdir('gship-full-verify-bad-json-');
		writePackageJson(dir, '{ not valid json');
		const verifier = new GitFullVerifier({ runCommand: () => neverRunCommand() });
		expect(await verifier.verify({ ...verificationInput, cwd: dir })).toEqual({ ok: true, skipped: true });
	});

	test('skips without running any command when package.json declares no verify script', async () => {
		const cases: Array<[string, unknown]> = [
			['no scripts field at all', { name: 'x' }],
			['scripts present but no verify key', { scripts: { test: 'bun test' } }],
			['verify present but not a string', { scripts: { verify: ['bun', 'run', 'check:all'] } }],
			['scripts is not an object', { scripts: 'bun run check:all' }],
		];
		for (const [label, content] of cases) {
			const dir = createTestTmpdir('gship-full-verify-skip-');
			writePackageJson(dir, JSON.stringify(content));
			const verifier = new GitFullVerifier({
				runCommand: () => { throw new Error(`must not run any command: ${label}`); },
			});
			expect(await verifier.verify({ ...verificationInput, cwd: dir }))
				.toEqual({ ok: true, skipped: true });
		}
	});

	test('runs bun run verify and emits command lifecycle events when a script is declared', async () => {
		const dir = createTestTmpdir('gship-full-verify-clean-');
		writePackageJson(dir, JSON.stringify({ scripts: { verify: 'bun run check:all' } }));
		const commands: Array<{ cwd: string; command: string; timeoutMs: number | undefined }> = [];
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		const verifier = new GitFullVerifier({
			runCommand: async ({ cwd, command, timeoutMs }) => {
				commands.push({ cwd, command, timeoutMs });
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});

		const result = await verifier.verify({
			...verificationInput,
			cwd: dir,
			emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
		});

		expect(result).toEqual({ ok: true });
		// The command is always `bun run verify`, never the script's own content
		// (`bun run check:all` above): the slice never hardcodes or inlines what
		// the project declared, it only asks bun to resolve the script by name.
		expect(commands).toEqual([{ cwd: dir, command: 'bun run verify', timeoutMs: undefined }]);
		expect(events).toEqual([
			{ kind: 'full-verify.command.started' },
			{ kind: 'full-verify.command.completed', payload: { exitCode: 0 } },
		]);
	});

	test('fails with a prefixed detail carrying the command output when the exit code is not zero', async () => {
		const dir = createTestTmpdir('gship-full-verify-failed-');
		writePackageJson(dir, JSON.stringify({ scripts: { verify: 'bun run check:all' } }));
		const events: string[] = [];
		const verifier = new GitFullVerifier({
			runCommand: async () => ({
				exitCode: 1,
				stdout: 'stale bundle\n',
				stderr: 'error: dist/ out of date\n',
			}),
		});

		const result = await verifier.verify({
			...verificationInput,
			cwd: dir,
			emit: (kind) => events.push(kind),
		});

		expect(result.ok).toBe(false);
		expect(result.detail).toStartWith('full verification failed:');
		expect(result.detail).toContain('stale bundle');
		expect(result.detail).toContain('error: dist/ out of date');
		// The command still ran to completion and reported its exit code, even
		// though the overall result is a failure.
		expect(events).toEqual(['full-verify.command.started', 'full-verify.command.completed']);
	});

	test('caps command diagnostics on a failed full verification, same as the issue verifier', async () => {
		const dir = createTestTmpdir('gship-full-verify-capped-');
		writePackageJson(dir, JSON.stringify({ scripts: { verify: 'bun run check:all' } }));
		const verifier = new GitFullVerifier({
			runCommand: async () => ({ exitCode: 1, stdout: 'x'.repeat(3_000), stderr: '' }),
		});

		const result = await verifier.verify({ ...verificationInput, cwd: dir });
		expect(result.ok).toBe(false);
		expect(result.detail).toEndWith('x'.repeat(2_000));
		expect(result.detail?.length).toBeLessThan(2_100);
	});

	test('cancels and awaits a real full-verify subprocess group', async () => {
		const dir = createTestTmpdir('gship-full-verify-cancel-');
		writePackageJson(dir, JSON.stringify({
			scripts: { verify: "trap 'exit 0' TERM; while :; do sleep 0.1; done" },
		}));
		const controller = new AbortController();
		const verifier = new GitFullVerifier({ terminationGraceMs: 50 });
		const pending = verifier.verify({
			...verificationInput,
			cwd: dir,
			signal: controller.signal,
		});
		await Bun.sleep(30);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});
