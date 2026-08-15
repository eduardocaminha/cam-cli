import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
	GitWorkspaceManager,
	RuntimeWorkspaceError,
} from '../../src/runtime/git-workspace.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function git(cwd: string, args: string[]): string {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function seedRepository(): string {
	const root = createTestTmpdir('gship-workspace-');
	mkdirSync(join(root, 'scripts', 'cam', 'issues'), { recursive: true });
	writeFileSync(join(root, '.gitignore'), '.gship/\n');
	writeFileSync(
		join(root, 'scripts', 'cam', 'issues', 'CAM-0576.json'),
		JSON.stringify({ id: 'CAM-576', title: 'workspace fixture' }),
	);
	git(root, ['init', '-b', 'main']);
	git(root, ['config', 'user.name', 'Gateship Test']);
	git(root, ['config', 'user.email', 'test@example.invalid']);
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'seed']);
	return root;
}

describe('git workspace manager', () => {
	test('creates an isolated run branch without switching or cleaning the host checkout', () => {
		const root = seedRepository();
		writeFileSync(join(root, 'operator-notes.txt'), 'keep me\n');
		const beforeStatus = git(root, ['status', '--porcelain', '--untracked-files=all']);
		const manager = new GitWorkspaceManager(root);

		const workspacePath = manager.prepare({
			runId: 'run-12345678-aaaa',
			issueId: 'CAM-576',
		});

		expect(workspacePath).toBe(join(root, '.gship', 'worktrees', 'run-12345678-aaaa'));
		expect(git(root, ['branch', '--show-current'])).toBe('main');
		expect(git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe(beforeStatus);
		expect(git(workspacePath, ['branch', '--show-current'])).toBe(
			'gship/cam-576-run-1234',
		);
		expect(git(workspacePath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
		expect(git(workspacePath, ['rev-parse', 'HEAD'])).toBe(git(root, ['rev-parse', 'main']));
	});

	test('fails before mutation when main cannot be resolved', () => {
		const calls: string[][] = [];
		const manager = new GitWorkspaceManager('/project', (_cwd, args) => {
			calls.push(args);
			return { exitCode: 1, stdout: '', stderr: 'missing main' };
		});
		expect(() => manager.prepare({
			runId: 'run-1',
			issueId: 'CAM-1',
		})).toThrow(RuntimeWorkspaceError);
		expect(calls).toEqual([['rev-parse', '--verify', 'main']]);
	});
});
