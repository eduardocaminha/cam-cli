import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
	GitWorkspaceManager,
	RuntimeWorkspaceError,
	type WorkspaceInstallRunner,
} from '../../src/runtime/git-workspace.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function recordingInstall(calls: Array<{ cwd: string; args: string[] }>): WorkspaceInstallRunner {
	return (cwd, args) => {
		calls.push({ cwd, args });
		return { exitCode: 0, stdout: '', stderr: '' };
	};
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function gitExit(cwd: string, args: string[]): number {
	return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).status ?? 1;
}

function seedRepository(): string {
	const root = createTestTmpdir('gship-workspace-');
	mkdirSync(join(root, '.gateship', 'issues'), { recursive: true });
	writeFileSync(join(root, '.gitignore'), '.gship/\n');
	writeFileSync(
		join(root, '.gateship', 'issues', 'CAM-0576.json'),
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
		const installs: Array<{ cwd: string; args: string[] }> = [];
		const manager = new GitWorkspaceManager(root, undefined, recordingInstall(installs));

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

	test('installs locked dependencies in the isolated workspace before returning', () => {
		const root = seedRepository();
		const calls: Array<{ cwd: string; args: string[]; hostNodeModules: boolean }> = [];
		const manager = new GitWorkspaceManager(root, undefined, (cwd, args) => {
			calls.push({ cwd, args, hostNodeModules: existsSync(join(root, 'node_modules')) });
			mkdirSync(join(cwd, 'node_modules'), { recursive: true });
			return { exitCode: 0, stdout: '', stderr: '' };
		});

		const workspacePath = manager.prepare({
			runId: 'run-12345678-aaaa',
			issueId: 'CAM-578',
		});

		expect(calls).toEqual([
			{
				cwd: workspacePath,
				args: ['install', '--frozen-lockfile'],
				hostNodeModules: false,
			},
		]);
		expect(existsSync(join(workspacePath, 'node_modules'))).toBe(true);
		expect(existsSync(join(root, 'node_modules'))).toBe(false);
		expect(git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
	});

	test('reports the install failure detail', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, () => ({
			exitCode: 1,
			stdout: '',
			stderr: 'lockfile had changes, but lockfile is frozen',
		}));

		expect(() => manager.prepare({
			runId: 'run-12345678-bbbb',
			issueId: 'CAM-578',
		})).toThrow(
			new RuntimeWorkspaceError(
				'cannot install workspace dependencies: lockfile had changes, but lockfile is frozen',
			),
		);
		expect(existsSync(join(root, '.gship', 'worktrees', 'run-12345678-bbbb'))).toBe(false);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', 'refs/heads/gship/cam-578-run-1234']))
			.toBe(1);
	});

	test('reports the start failure detail', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, () => {
			throw new Error('spawn bun ENOENT');
		});

		expect(() => manager.prepare({
			runId: 'run-12345678-cccc',
			issueId: 'CAM-578',
		})).toThrow(
			new RuntimeWorkspaceError('cannot start workspace install: spawn bun ENOENT'),
		);
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

	test('releases the exact clean workspace, local branch and stale tracking ref', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingInstall([]));
		const input = { runId: 'run-12345678-dddd', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		git(root, [
			'update-ref',
			`refs/remotes/origin/${branch}`,
			git(workspacePath, ['rev-parse', 'HEAD']),
		]);

		expect(manager.release({ ...input, workspacePath })).toEqual({
			outcome: 'released',
			branch,
		});
		expect(existsSync(workspacePath)).toBe(false);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]))
			.toBe(1);
		expect(manager.release({ ...input, workspacePath })).toEqual({
			outcome: 'already-released',
			branch,
		});
	});

	test('preserves a dirty workspace and reports it for operator inspection', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingInstall([]));
		const input = { runId: 'run-87654321-aaaa', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		writeFileSync(join(workspacePath, 'operator-notes.txt'), 'keep me\n');

		expect(manager.release({ ...input, workspacePath })).toEqual({
			outcome: 'preserved',
			branch: 'gship/cam-578-run-8765',
			detail: 'workspace has local changes',
		});
		expect(existsSync(workspacePath)).toBe(true);
		expect(manager.inspect([{ ...input, workspacePath, state: 'done' }])).toContainEqual({
			kind: 'dirty',
			runId: input.runId,
			workspacePath,
			branch: 'gship/cam-578-run-8765',
			detail: 'finished workspace has local changes',
		});
	});

	test('never releases a path that does not match the run-owned location', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingInstall([]));

		expect(manager.release({
			runId: 'run-12345678-eeee',
			issueId: 'CAM-578',
			workspacePath: root,
		})).toEqual({
			outcome: 'preserved',
			branch: 'gship/cam-578-run-1234',
			detail: 'workspace path does not belong to run run-12345678-eeee',
		});
		expect(git(root, ['branch', '--show-current'])).toBe('main');
	});

	test('surfaces an unowned managed worktree without deleting it', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingInstall([]));
		const workspacePath = manager.prepare({
			runId: 'run-orphan00-aaaa',
			issueId: 'CAM-578',
		});

		expect(manager.inspect([])).toContainEqual({
			kind: 'orphan',
			runId: null,
			workspacePath,
			branch: 'gship/cam-578-run-orph',
			detail: 'workspace is not owned by a persisted run',
		});
		expect(existsSync(workspacePath)).toBe(true);
	});
});
