import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	abandonOperatorIssue,
	approveOperatorIssue,
	createOperatorIssue,
	IssueIntakeError,
	specifyOperatorIssue,
} from '../../src/runtime/issue-intake.ts';
import type { GitIdentityResult } from '../../src/runtime/git-identity.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import { RUNTIME_SOURCE_REF } from '../../src/runtime/source-ref.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
	const stdout = new TextDecoder().decode(result.stdout).trim();
	const stderr = new TextDecoder().decode(result.stderr).trim();
	if (result.exitCode !== 0) throw new Error(stderr || stdout);
	return stdout;
}

function identify(cwd: string): void {
	git(cwd, ['config', 'user.name', 'Gateship Test']);
	git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

function writeIssue(cwd: string, number: number, stage: 'idea' | 'specified' = 'specified'): void {
	const directory = join(cwd, '.gateship', 'issues');
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `CAM-${String(number).padStart(4, '0')}.json`),
		`${JSON.stringify({
			id: `CAM-${number}`,
			title: `fixture ${number}`,
			stage,
			status: 'open',
			blockedBy: [],
			createdAt: '2026-08-15T00:00:00.000Z',
			updatedAt: '2026-08-15T00:00:00.000Z',
			...(stage === 'specified'
				? { spec: { verify: ['works'], scope: 'fixture' } }
				: {}),
		}, null, 2)}\n`,
	);
}

/**
 * `identifyLocal: false` leaves the runtime clone with no committer identity
 * at all -- neither local nor global -- so a `git commit` inside it fails
 * with "Author identity unknown" unless something derives one first
 * (GSHIP-654). The seed repo still identifies itself either way: that commit
 * is unrelated setup a fresh clone never inherits local config from.
 */
function seedFixture(
	options: { identifyLocal?: boolean } = {},
): { root: string; seed: string; remote: string; local: string } {
	const root = createTestTmpdir('gship-issue-intake-');
	const seed = join(root, 'seed');
	mkdirSync(seed, { recursive: true });
	git(seed, ['init', '-q', '-b', 'main']);
	identify(seed);
	writeIssue(seed, 1);
	writeIssue(seed, 2, 'idea');
	git(seed, ['add', '.']);
	git(seed, ['commit', '-q', '-m', 'seed']);

	const remote = join(root, 'remote.git');
	git(root, ['clone', '-q', '--bare', seed, remote]);
	const local = join(root, 'local');
	git(root, ['clone', '-q', remote, local]);
	if (options.identifyLocal ?? true) identify(local);
	return { root, seed, remote, local };
}

describe('remote-main operator issue intake', () => {
	test('records approval for the exact published spec when requested', () => {
		const fixture = seedFixture();
		createOperatorIssue(fixture.local, {
			title: 'Approved intake',
			scope: 'Ship the approved contract.',
			verificationCommand: 'bun test',
		}, { approve: true }, () => '2026-08-16T02:00:00.000Z');
		const issue = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/GSHIP-0003.json']),
		) as { spec: Parameters<typeof fingerprintSpec>[0]; approval: Record<string, string> };
		expect(issue.approval).toEqual({
			fingerprint: fingerprintSpec(issue.spec),
			approvedAt: '2026-08-16T02:00:00.000Z',
		});
	});

	test('files a specified issue from the fresh remote base without moving local main', () => {
		const fixture = seedFixture();
		const staleMain = git(fixture.local, ['rev-parse', 'refs/heads/main']);
		writeFileSync(join(fixture.local, 'operator-notes.txt'), 'keep me\n');
		const dirtyBefore = git(fixture.local, ['status', '--porcelain', '--untracked-files=all']);

		// The remote advances beyond both refs held by the runtime clone.
		writeIssue(fixture.seed, 7);
		git(fixture.seed, ['add', '.']);
		git(fixture.seed, ['commit', '-q', '-m', 'remote backlog advance']);
		git(fixture.seed, ['push', '-q', fixture.remote, 'main']);

		const created = createOperatorIssue(
			fixture.local,
			{
				title: 'Intake direto',
				scope: 'O formulário cria uma tarefa executável sem planner.',
				verificationCommand: 'bun test test/runtime/issue-intake.test.ts',
			},
			{},
			() => '2026-08-16T03:00:00.000Z',
		);

		expect(created).toMatchObject({ id: 'GSHIP-8', title: 'Intake direto' });
		const content = git(fixture.remote, ['show', 'main:.gateship/issues/GSHIP-0008.json']);
		const issue = JSON.parse(content) as Record<string, unknown>;
		expect(issue).toMatchObject({
			id: 'GSHIP-8',
			stage: 'specified',
			status: 'open',
			specSource: 'operator',
			description: 'O formulário cria uma tarefa executável sem planner.',
		});
		expect(issue['spec']).toMatchObject({
			scope: 'O formulário cria uma tarefa executável sem planner.',
			verify: ['bun test test/runtime/issue-intake.test.ts'],
		});
		expect(issue['approval']).toBeUndefined();
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(staleMain);
		expect(git(fixture.local, ['status', '--porcelain', '--untracked-files=all'])).toBe(dirtyBefore);
		expect(git(fixture.local, ['rev-parse', RUNTIME_SOURCE_REF]))
			.toBe(git(fixture.remote, ['rev-parse', 'main']));
	});

	// GSHIP-629: the intake persists the executable premise exactly as sent,
	// and never runs it -- an evidence command that would leave a detectable
	// side effect must not fire during intake.
	test('accepts and persists evidence without ever running the recorded command', () => {
		const fixture = seedFixture();

		const created = createOperatorIssue(fixture.local, {
			title: 'Intake com evidência',
			scope: 'O intake registra a evidência sem executá-la.',
			verificationCommand: 'bun test',
			evidence: [
				{ command: 'touch should-not-execute.txt', output: 'irrelevant' },
				{ command: 'wc -l README.md', output: '10 README.md' },
			],
		}, {}, () => '2026-08-16T08:00:00.000Z');

		expect(existsSync(join(fixture.local, 'should-not-execute.txt'))).toBe(false);
		expect(created).toMatchObject({ id: 'GSHIP-3', title: 'Intake com evidência' });
		const content = git(fixture.remote, ['show', 'main:.gateship/issues/GSHIP-0003.json']);
		const issue = JSON.parse(content) as Record<string, unknown>;
		expect(issue['spec']).toMatchObject({
			evidence: [
				{ command: 'touch should-not-execute.txt', output: 'irrelevant' },
				{ command: 'wc -l README.md', output: '10 README.md' },
			],
		});
	});

	test('rejects evidence past the item or size limit before touching the remote', () => {
		const fixture = seedFixture();
		const publishedBefore = git(fixture.remote, ['rev-parse', 'main']);

		try {
			createOperatorIssue(fixture.local, {
				title: 'Evidência demais',
				scope: 'Excede o limite de itens.',
				verificationCommand: 'bun test',
				evidence: [
					{ command: 'a', output: '1' },
					{ command: 'b', output: '2' },
					{ command: 'c', output: '3' },
					{ command: 'd', output: '4' },
				],
			});
			throw new Error('expected createOperatorIssue to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(IssueIntakeError);
			expect(error).toMatchObject({ code: 'invalid-request', status: 400 });
		}
		expect(git(fixture.remote, ['rev-parse', 'main'])).toBe(publishedBefore);
	});

	test('a specified draft revised without resending evidence loses it, same as any other spec replacement', () => {
		const fixture = seedFixture();
		specifyOperatorIssue(fixture.local, 'CAM-1', {
			scope: 'Contrato com evidência.',
			verificationCommand: 'bun test',
			evidence: [{ command: 'true', output: 'ok' }],
		}, () => '2026-08-16T09:00:00.000Z');
		let issue = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0001.json']),
		) as Record<string, unknown>;
		expect(issue['spec']).toMatchObject({ evidence: [{ command: 'true', output: 'ok' }] });

		specifyOperatorIssue(fixture.local, 'CAM-1', {
			scope: 'Contrato revisado sem reenviar evidência.',
			verificationCommand: 'bun test',
		}, () => '2026-08-16T09:01:00.000Z');
		issue = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0001.json']),
		) as Record<string, unknown>;
		expect((issue['spec'] as Record<string, unknown>)['evidence']).toBeUndefined();
	});

	test('fails closed when the runtime source cannot be fetched', () => {
		const fixture = seedFixture();
		git(fixture.local, ['remote', 'set-url', 'origin', join(fixture.root, 'missing.git')]);

		try {
			createOperatorIssue(fixture.local, {
				title: 'Never published',
				scope: 'Remote must be reachable.',
				verificationCommand: 'bun test',
			});
			throw new Error('expected createOperatorIssue to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(IssueIntakeError);
			expect(error).toMatchObject({ code: 'source-unavailable', status: 503 });
		}
	});

	test('promotes an existing idea on fresh remote main without moving local main', () => {
		const fixture = seedFixture();
		const staleMain = git(fixture.local, ['rev-parse', 'refs/heads/main']);
		writeFileSync(join(fixture.local, 'operator-notes.txt'), 'keep me\n');
		const dirtyBefore = git(fixture.local, ['status', '--porcelain', '--untracked-files=all']);

		const specified = specifyOperatorIssue(
			fixture.local,
			'CAM-2',
			{
				scope: 'A ideia fica executável sem planner.',
				verificationCommand: 'bun test test/runtime/issue-intake.test.ts',
			},
			() => '2026-08-16T04:00:00.000Z',
		);

		expect(specified).toMatchObject({ id: 'CAM-2', title: 'fixture 2' });
		const content = git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0002.json']);
		const issue = JSON.parse(content) as Record<string, unknown>;
		expect(issue).toMatchObject({
			id: 'CAM-2',
			stage: 'specified',
			specSource: 'operator',
			updatedAt: '2026-08-16T04:00:00.000Z',
		});
		expect(issue['spec']).toMatchObject({
			scope: 'A ideia fica executável sem planner.',
			verify: ['bun test test/runtime/issue-intake.test.ts'],
		});
		expect(issue['approval']).toBeUndefined();
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(staleMain);
		expect(git(fixture.local, ['status', '--porcelain', '--untracked-files=all'])).toBe(dirtyBefore);
	});

	test('revises a specified draft, always invalidates approval, and can reapprove it', () => {
		const fixture = seedFixture();
		const input = { scope: 'Contrato revisado.', verificationCommand: 'bun test focused' };

		specifyOperatorIssue(fixture.local, 'CAM-1', input, () => '2026-08-16T06:00:00.000Z');
		approveOperatorIssue(fixture.local, 'CAM-1', () => '2026-08-16T06:01:00.000Z');
		specifyOperatorIssue(fixture.local, 'CAM-1', input, () => '2026-08-16T06:02:00.000Z');
		let issue = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0001.json']),
		) as Record<string, unknown>;
		expect(issue['approval']).toBeUndefined();
		expect(issue['updatedAt']).toBe('2026-08-16T06:02:00.000Z');

		approveOperatorIssue(fixture.local, 'CAM-1', () => '2026-08-16T06:03:00.000Z');
		issue = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0001.json']),
		) as Record<string, unknown>;
		expect(issue['approval']).toEqual({
			fingerprint: fingerprintSpec(issue['spec'] as Parameters<typeof fingerprintSpec>[0]),
			approvedAt: '2026-08-16T06:03:00.000Z',
		});
	});

	// GSHIP-614: the second approval of the same published contract is the same
	// decision, so it must not publish a commit that a run in flight would then
	// have to merge around.
	test('approving the published contract again publishes nothing and keeps approvedAt', () => {
		const fixture = seedFixture();
		specifyOperatorIssue(
			fixture.local,
			'CAM-1',
			{ scope: 'Contrato aprovado.', verificationCommand: 'bun test focused' },
			() => '2026-08-16T07:00:00.000Z',
		);
		const first = approveOperatorIssue(fixture.local, 'CAM-1', () => '2026-08-16T07:01:00.000Z');
		const publishedAfterApproval = git(fixture.remote, ['rev-parse', 'main']);

		const again = approveOperatorIssue(fixture.local, 'CAM-1', () => '2026-08-16T07:02:00.000Z');

		expect(again).toMatchObject({ id: 'CAM-1', title: 'fixture 1' });
		expect(git(fixture.remote, ['rev-parse', 'main'])).toBe(publishedAfterApproval);
		expect(again.sha).toBe(first.sha);
		const issue = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0001.json']),
		) as Record<string, unknown>;
		expect(issue['approval']).toEqual({
			fingerprint: fingerprintSpec(issue['spec'] as Parameters<typeof fingerprintSpec>[0]),
			approvedAt: '2026-08-16T07:01:00.000Z',
		});
		expect(issue['updatedAt']).toBe('2026-08-16T07:01:00.000Z');
	});

	test('abandons an open issue keeping every other field as published', () => {
		const fixture = seedFixture();
		const staleMain = git(fixture.local, ['rev-parse', 'refs/heads/main']);
		writeFileSync(join(fixture.local, 'operator-notes.txt'), 'keep me\n');
		const dirtyBefore = git(fixture.local, ['status', '--porcelain', '--untracked-files=all']);
		const before = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0001.json']),
		) as Record<string, unknown>;

		// The remote advances beyond both refs held by the runtime clone, so the
		// abandon must publish from the freshly fetched base.
		writeIssue(fixture.seed, 7);
		git(fixture.seed, ['add', '.']);
		git(fixture.seed, ['commit', '-q', '-m', 'remote backlog advance']);
		git(fixture.seed, ['push', '-q', fixture.remote, 'main']);

		const abandoned = abandonOperatorIssue(
			fixture.local,
			'CAM-1',
			{ reason: 'O recurso saiu do produto; não há mais o que entregar.' },
			() => '2026-08-16T05:00:00.000Z',
		);

		expect(abandoned).toMatchObject({ id: 'CAM-1', title: 'fixture 1' });
		const after = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0001.json']),
		) as Record<string, unknown>;
		expect(after).toEqual({
			...before,
			status: 'abandoned',
			updatedAt: '2026-08-16T05:00:00.000Z',
			abandonedReason: 'O recurso saiu do produto; não há mais o que entregar.',
		});
		// The remote advance stayed in the published history.
		expect(git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0007.json'])).toContain('CAM-7');
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(staleMain);
		expect(git(fixture.local, ['status', '--porcelain', '--untracked-files=all'])).toBe(dirtyBefore);
		expect(git(fixture.local, ['rev-parse', RUNTIME_SOURCE_REF]))
			.toBe(git(fixture.remote, ['rev-parse', 'main']));
	});

	test('rejects an unknown issue and an issue that is no longer open', () => {
		const fixture = seedFixture();

		try {
			abandonOperatorIssue(fixture.local, 'CAM-404', { reason: 'Não existe.' });
			throw new Error('expected abandonOperatorIssue to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(IssueIntakeError);
			expect(error).toMatchObject({ code: 'issue-not-found', status: 404 });
		}

		abandonOperatorIssue(
			fixture.local,
			'CAM-2',
			{ reason: 'A ideia foi absorvida por outra tarefa.' },
			() => '2026-08-16T06:00:00.000Z',
		);
		const idea = JSON.parse(
			git(fixture.remote, ['show', 'main:.gateship/issues/CAM-0002.json']),
		) as Record<string, unknown>;
		expect(idea).toMatchObject({ stage: 'idea', status: 'abandoned' });

		try {
			abandonOperatorIssue(fixture.local, 'CAM-2', { reason: 'De novo.' });
			throw new Error('expected abandonOperatorIssue to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(IssueIntakeError);
			expect(error).toMatchObject({ code: 'issue-not-eligible', status: 409 });
		}
	});

	test('requires a concrete justification before touching the remote', () => {
		const fixture = seedFixture();
		const publishedBefore = git(fixture.remote, ['rev-parse', 'main']);

		try {
			abandonOperatorIssue(fixture.local, 'CAM-1', { reason: '   ' });
			throw new Error('expected abandonOperatorIssue to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(IssueIntakeError);
			expect(error).toMatchObject({ code: 'invalid-request', status: 400 });
		}
		expect(git(fixture.remote, ['rev-parse', 'main'])).toBe(publishedBefore);
	});
});

// A fresh container's volume has no git author identity until something
// derives one; issue intake is one of the two paths that commit (the other
// is GithubShipper's own ship, covered in github-shipper.test.ts). Both must
// derive it themselves, right on the commit path, before their own first
// write -- never by depending on the operator-facing snapshot in
// src/commands/web.ts having been read first, which is a display of the same
// outcome and not a trigger for it (GSHIP-654).
describe('git author identity on the commit path (GSHIP-654)', () => {
	test('a missing identity is derived on the very first commit attempt, with no snapshot ever read', () => {
		// No identify(fixture.local): this clone starts with no committer
		// identity at all, local or global, so this commit only succeeds if
		// something derives one before git ever runs it. The real
		// ensureGitIdentity's own --global/GIT_CONFIG_GLOBAL write is unit-
		// tested directly and hermetically in git-identity.test.ts; the fake
		// here writes local config instead purely so this test needs no real
		// environment variable and never risks the real person's own
		// ~/.gitconfig -- what it proves is the wiring: that this call happens,
		// and that its effect is what the commit below actually uses.
		const fixture = seedFixture({ identifyLocal: false });
		let calls = 0;
		const ensureIdentity = (): GitIdentityResult => {
			calls += 1;
			git(fixture.local, ['config', 'user.name', 'Derived Operator']);
			git(fixture.local, ['config', 'user.email', '777+derived-operator@users.noreply.github.com']);
			return {
				outcome: 'derived',
				name: 'Derived Operator',
				email: '777+derived-operator@users.noreply.github.com',
			};
		};

		// No startWebServer, no /api/snapshot, no HTTP request anywhere in this
		// test -- the entire derive-and-use happens on the commit path alone.
		const issue = createOperatorIssue(
			fixture.local,
			{
				title: 'First intake, no identity yet',
				scope: 'Prove derivation happens before the first commit, not after a snapshot.',
				verificationCommand: 'true',
			},
			{},
			() => '2026-08-19T00:00:00.000Z',
			ensureIdentity,
		);

		expect(calls).toBe(1);
		expect(issue.id).toBe('GSHIP-3');
		const author = git(fixture.remote, ['log', '-1', '--format=%an <%ae>', 'main']);
		expect(author).toBe('Derived Operator <777+derived-operator@users.noreply.github.com>');
	});

	test('a persistently missing identity fails clearly before any worktree is touched, not with a raw git error', () => {
		const fixture = seedFixture({ identifyLocal: false });
		const publishedBefore = git(fixture.remote, ['rev-parse', 'main']);
		const ensureIdentity = (): GitIdentityResult => ({
			outcome: 'missing',
			detail: 'gh is not authenticated yet (fixture)',
		});

		try {
			createOperatorIssue(
				fixture.local,
				{
					title: 'Should never publish',
					scope: 'A missing identity must refuse before any write.',
					verificationCommand: 'true',
				},
				{},
				() => '2026-08-19T00:00:00.000Z',
				ensureIdentity,
			);
			throw new Error('expected createOperatorIssue to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(IssueIntakeError);
			expect(error).toMatchObject({ code: 'source-unavailable', status: 503 });
			// Gateship's own diagnostic, not git's opaque "Author identity
			// unknown; *** Please tell me who you are." stderr.
			expect((error as IssueIntakeError).message).toContain('gh is not authenticated yet (fixture)');
			expect((error as IssueIntakeError).message).not.toContain('Please tell me who you are');
		}
		// Nothing published: the refusal happened before the commit, not after
		// a failed one.
		expect(git(fixture.remote, ['rev-parse', 'main'])).toBe(publishedBefore);
	});
});
