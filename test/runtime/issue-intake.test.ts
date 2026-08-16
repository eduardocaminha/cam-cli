import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	createOperatorIssue,
	IssueIntakeError,
	specifyOperatorIssue,
} from '../../src/runtime/issue-intake.ts';
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
				? { spec: { acceptanceCriteria: ['works'], scope: 'fixture', gotchas: [], domainTerms: [] } }
				: {}),
		}, null, 2)}\n`,
	);
}

function seedFixture(): { root: string; seed: string; remote: string; local: string } {
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
	identify(local);
	return { root, seed, remote, local };
}

describe('remote-main operator issue intake', () => {
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
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(staleMain);
		expect(git(fixture.local, ['status', '--porcelain', '--untracked-files=all'])).toBe(dirtyBefore);
		expect(git(fixture.local, ['rev-parse', RUNTIME_SOURCE_REF]))
			.toBe(git(fixture.remote, ['rev-parse', 'main']));
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
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(staleMain);
		expect(git(fixture.local, ['status', '--porcelain', '--untracked-files=all'])).toBe(dirtyBefore);
	});
});
