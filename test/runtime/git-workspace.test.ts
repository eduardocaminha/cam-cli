import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	GitWorkspaceManager,
	RuntimeWorkspaceError,
	type WorkspacePrepareRunner,
} from '../../src/runtime/git-workspace.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function recordingPrepare(calls: Array<{ cwd: string; args: string[] }>): WorkspacePrepareRunner {
	return (cwd, command) => {
		calls.push({ cwd, args: [command] });
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

/** Bare `origin` remote a release should push branch deletes to. */
function seedRemote(root: string): string {
	const remote = createTestTmpdir('gship-workspace-remote-');
	spawnSync('git', ['init', '--bare', '-q', remote]);
	git(root, ['remote', 'add', 'origin', remote]);
	return remote;
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
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare(installs));

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

	test('places managed worktrees in an explicit state directory without touching project .gship', () => {
		const root = seedRepository();
		const stateDir = createTestTmpdir('gship-external-workspace-state-');
		const manager = new GitWorkspaceManager(
			root,
			undefined,
			recordingPrepare([]),
			'main',
			stateDir,
		);

		const workspacePath = manager.prepare({
			runId: 'run-external-state',
			issueId: 'GSHIP-693',
		});

		expect(workspacePath).toBe(join(stateDir, 'worktrees', 'run-external-state'));
		expect(existsSync(join(root, '.gship'))).toBe(false);
		expect(git(workspacePath, ['rev-parse', '--show-toplevel'])).toBe(workspacePath);
	});

	test('installs locked dependencies in the isolated workspace before returning', () => {
		const root = seedRepository();
		const calls: Array<{ cwd: string; args: string[]; hostNodeModules: boolean }> = [];
		const manager = new GitWorkspaceManager(root, undefined, (cwd, command) => {
			calls.push({ cwd, args: [command], hostNodeModules: existsSync(join(root, 'node_modules')) });
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
				args: ['bun install --frozen-lockfile'],
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
				'cannot prepare workspace: preparation command failed: lockfile had changes, but lockfile is frozen',
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
			new RuntimeWorkspaceError('cannot prepare workspace: spawn bun ENOENT'),
		);
	});

	test('runs project-owned preparation in order and honors an explicit empty list', () => {
		const root = seedRepository();
		writeFileSync(join(root, '.gateship', 'project.json'), JSON.stringify({
			version: 1,
			prepare: ['npm ci', 'python3 -m venv .venv'],
			verify: ['npm test'],
		}));
		git(root, ['add', '.gateship/project.json']);
		git(root, ['commit', '-m', 'declare project preparation']);
		const calls: Array<{ cwd: string; args: string[] }> = [];
		new GitWorkspaceManager(root, undefined, recordingPrepare(calls)).prepare({
			runId: 'run-project-prepare',
			issueId: 'CAM-578',
		});
		expect(calls.map((call) => call.args[0])).toEqual(['npm ci', 'python3 -m venv .venv']);

		const emptyRoot = seedRepository();
		writeFileSync(join(emptyRoot, '.gateship', 'project.json'), JSON.stringify({
			version: 1,
			prepare: [],
			verify: ['true'],
		}));
		git(emptyRoot, ['add', '.gateship/project.json']);
		git(emptyRoot, ['commit', '-m', 'skip project preparation']);
		const emptyCalls: Array<{ cwd: string; args: string[] }> = [];
		new GitWorkspaceManager(emptyRoot, undefined, recordingPrepare(emptyCalls)).prepare({
			runId: 'run-empty-prepare',
			issueId: 'CAM-578',
		});
		expect(emptyCalls).toEqual([]);
	});

	test('fails closed and cleans up when the project manifest is invalid', () => {
		const root = seedRepository();
		writeFileSync(join(root, '.gateship', 'project.json'), JSON.stringify({
			version: 1,
			prepare: [''],
			verify: ['bun test'],
		}));
		git(root, ['add', '.gateship/project.json']);
		git(root, ['commit', '-m', 'invalid project preparation']);

		expect(() => new GitWorkspaceManager(root, undefined, recordingPrepare([])).prepare({
			runId: 'run-invalid-prepare',
			issueId: 'CAM-578',
		})).toThrow('project verification manifest has invalid preparation commands');
		expect(existsSync(join(root, '.gship', 'worktrees', 'run-invalid-prepare'))).toBe(false);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', 'refs/heads/gship/cam-578-run-inva']))
			.toBe(1);
	});

	test('gives preparation commands only the project command environment', () => {
		const root = seedRepository();
		writeFileSync(join(root, '.gateship', 'project.json'), JSON.stringify({
			version: 1,
			prepare: [
				'bun -e "if (!process.env.PATH || process.env.GSHIP_WEB_DIR) process.exit(1)"',
			],
			verify: ['bun test'],
		}));
		git(root, ['add', '.gateship/project.json']);
		git(root, ['commit', '-m', 'check preparation environment']);
		const previous = process.env.GSHIP_WEB_DIR;
		process.env.GSHIP_WEB_DIR = '/private/service/ui';
		try {
			expect(() => new GitWorkspaceManager(root).prepare({
				runId: 'run-prepare-env',
				issueId: 'CAM-578',
			})).not.toThrow();
		} finally {
			if (previous === undefined) delete process.env.GSHIP_WEB_DIR;
			else process.env.GSHIP_WEB_DIR = previous;
		}
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
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
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

	// GSHIP-658: the local worktree, local branch and stale tracking ref were
	// already dropped; a safe release must also push the delete so the branch
	// stops existing on GitHub instead of merely disappearing from the local
	// listing.
	test('pushes a delete for the published remote branch on a safe release', () => {
		const root = seedRepository();
		const remote = seedRemote(root);
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-3333', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		git(root, ['push', 'origin', branch]);
		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(0);

		expect(manager.release({ ...input, workspacePath })).toEqual({ outcome: 'released', branch });

		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
	});

	test('leaves the published remote branch alone when the release is preserved', () => {
		const root = seedRepository();
		const remote = seedRemote(root);
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-4444', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		git(root, ['push', 'origin', branch]);
		writeFileSync(join(workspacePath, 'operator-notes.txt'), 'keep me\n');

		expect(manager.release({ ...input, workspacePath })).toEqual({
			outcome: 'preserved',
			branch,
			detail: 'workspace has local changes',
		});

		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(0);
	});

	test('reports a failed remote branch delete as a warning without preserving the release', () => {
		const root = seedRepository();
		const remote = seedRemote(root);
		const manager = new GitWorkspaceManager(root, (cwd, args) => {
			if (args[0] === 'push' && args.includes('--delete')) {
				return { exitCode: 1, stdout: '', stderr: 'remote: hook declined the delete' };
			}
			const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
			return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
		}, recordingPrepare([]));
		const input = { runId: 'run-12345678-5555', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		git(root, ['push', 'origin', branch]);

		expect(manager.release({ ...input, workspacePath })).toEqual({
			outcome: 'released',
			branch,
			remoteWarning: 'cannot delete remote branch: remote: hook declined the delete',
		});
		expect(existsSync(workspacePath)).toBe(false);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(0);
	});

	// GSHIP-658: the missing-from-base gate now also guards the abandon path,
	// not just failed -- previously only failed required it, so an abandoned
	// run with its own commit could lose both the local branch (force-deleted)
	// and, once the remote delete shipped, its only other copy.
	test('preserves both the local and the remote branch when it carries a commit missing from the base ref', () => {
		const root = seedRepository();
		const remote = seedRemote(root);
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-8888', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		writeFileSync(join(workspacePath, 'attempt.txt'), 'partial work\n');
		git(workspacePath, ['add', 'attempt.txt']);
		git(workspacePath, ['commit', '-m', 'attempt before the run ended']);
		git(root, ['push', 'origin', branch]);

		expect(manager.release({ ...input, workspacePath, requireUpstream: true })).toEqual({
			outcome: 'preserved',
			branch,
			detail: 'branch has a commit missing from main',
		});

		expect(existsSync(workspacePath)).toBe(true);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(0);
		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(0);
	});

	test('releases both the local and the remote branch when it has no commit missing from the base ref', () => {
		const root = seedRepository();
		const remote = seedRemote(root);
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-9999', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		git(root, ['push', 'origin', branch]);

		expect(manager.release({ ...input, workspacePath, requireUpstream: true })).toEqual({
			outcome: 'released',
			branch,
		});

		expect(existsSync(workspacePath)).toBe(false);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
	});

	// GSHIP-658: `ship` merges with `--squash` (github-shipper.ts), which lands
	// a brand-new commit on the base ref, so a merged branch's own commits are
	// never reachable from it even though the work landed there -- the merge
	// itself is that path's proof, not commit reachability. The merge path
	// never sets `requireUpstream` (run-runtime.ts), and this proves the
	// release still fully proceeds on both sides regardless of the branch
	// carrying what `#branchMissingFromBase` would otherwise call a missing
	// commit.
	test('releases and deletes the remote branch on a merge, even though it carries a commit missing from the base ref', () => {
		const root = seedRepository();
		const remote = seedRemote(root);
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-ccdd', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		writeFileSync(join(workspacePath, 'attempt.txt'), 'shipped work\n');
		git(workspacePath, ['add', 'attempt.txt']);
		git(workspacePath, ['commit', '-m', 'squash-merged content, never reachable from main by this sha']);
		git(root, ['push', 'origin', branch]);

		expect(manager.release({ ...input, workspacePath })).toEqual({ outcome: 'released', branch });

		expect(existsSync(workspacePath)).toBe(false);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
	});

	// GSHIP-658: a remote-delete failure must survive the call instead of going
	// silently unretried forever once the local side is already released --
	// `retryRemoteDelete` is the caller's durable record that a retry is owed.
	test('retries the remote branch delete when asked, even though nothing is left to release locally', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-aaab', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';

		// No `origin` yet, so this first release only settles the local side.
		expect(manager.release({ ...input, workspacePath })).toEqual({ outcome: 'released', branch });

		// Standing in for a branch a previous, failed remote delete left behind:
		// published only now, discovered on a later retry.
		const remote = seedRemote(root);
		git(root, ['push', 'origin', `main:refs/heads/${branch}`]);
		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(0);

		expect(manager.release({ ...input, workspacePath, retryRemoteDelete: true })).toEqual({
			outcome: 'released',
			branch,
		});

		expect(gitExit(remote, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
	});

	test('never touches origin on a repeat release with no retry requested', () => {
		const root = seedRepository();
		seedRemote(root);
		const networkCalls: string[][] = [];
		const manager = new GitWorkspaceManager(root, (cwd, args) => {
			if (args[0] === 'push' || args[0] === 'ls-remote') networkCalls.push(args);
			const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
			return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
		}, recordingPrepare([]));
		const input = { runId: 'run-12345678-bbbc', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		git(root, ['push', 'origin', branch]);

		expect(manager.release({ ...input, workspacePath })).toEqual({ outcome: 'released', branch });
		expect(networkCalls.length).toBeGreaterThan(0);
		networkCalls.length = 0;

		expect(manager.release({ ...input, workspacePath })).toEqual({
			outcome: 'already-released',
			branch,
		});
		expect(networkCalls).toEqual([]);
	});

	// GSHIP-621: a failed run's release adds one more gate the merged path does
	// not need -- the branch itself must carry no commit missing from the base
	// ref, so a commit made just before the failure is not thrown away with it.
	test('releases a failed run workspace whose branch has no commit missing from the base ref', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-ffff', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';

		expect(manager.release({ ...input, workspacePath, requireUpstream: true })).toEqual({
			outcome: 'released',
			branch,
		});
		expect(existsSync(workspacePath)).toBe(false);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(1);
	});

	test('preserves a failed run workspace whose branch has a commit missing from the base ref', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-1111', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		const branch = 'gship/cam-578-run-1234';
		writeFileSync(join(workspacePath, 'attempt.txt'), 'partial work\n');
		git(workspacePath, ['add', 'attempt.txt']);
		git(workspacePath, ['commit', '-m', 'attempt before the failure']);

		expect(manager.release({ ...input, workspacePath, requireUpstream: true })).toEqual({
			outcome: 'preserved',
			branch,
			detail: 'branch has a commit missing from main',
		});
		expect(existsSync(workspacePath)).toBe(true);
		expect(gitExit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).toBe(0);
		expect(manager.inspect([{ ...input, workspacePath, state: 'failed' }])).toContainEqual({
			kind: 'failed-run',
			runId: input.runId,
			workspacePath,
			branch,
			detail: 'failed run workspace was preserved for inspection',
		});
	});

	test('preserves a dirty failed run workspace instead of releasing it', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
		const input = { runId: 'run-12345678-2222', issueId: 'CAM-578' };
		const workspacePath = manager.prepare(input);
		writeFileSync(join(workspacePath, 'operator-notes.txt'), 'keep me\n');

		expect(manager.release({ ...input, workspacePath, requireUpstream: true })).toEqual({
			outcome: 'preserved',
			branch: 'gship/cam-578-run-1234',
			detail: 'workspace has local changes',
		});
		expect(existsSync(workspacePath)).toBe(true);
	});

	test('preserves a dirty workspace and reports it for operator inspection', () => {
		const root = seedRepository();
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
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
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));

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
		const manager = new GitWorkspaceManager(root, undefined, recordingPrepare([]));
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
