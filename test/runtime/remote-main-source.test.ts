// test/runtime/remote-main-source.test.ts
//
// CAM-580 acceptance criterion 1: the web runtime's Git source is the
// remote-tracking origin/main, refreshed before a run is accepted.
//
// The fixture is a real repository pair -- a bare remote and a clone whose
// local main is deliberately left behind -- because the whole point of the
// criterion is which ref moves and which one does not. A double would prove
// nothing about `refs/heads/main` staying put.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getIssueOnMain } from '../../src/commands/issue-get.ts';
import { readBacklogFromMain } from '../../src/issues/backlog.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import { createGitRuntimePreflight, RuntimePreflightError } from '../../src/runtime/git-runtime.ts';
import {
	GitWorkspaceManager,
	type WorkspacePrepareRunner,
} from '../../src/runtime/git-workspace.ts';
import { RUNTIME_SOURCE_REF } from '../../src/runtime/source-ref.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

/** Install is the one step of prepare() that is not git; never shell out to bun. */
const noopInstall: WorkspacePrepareRunner = () => ({ exitCode: 0, stdout: '', stderr: '' });

function git(cwd: string, args: string[]): string {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function identify(cwd: string): void {
	git(cwd, ['config', 'user.name', 'Gateship Test']);
	git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

function writeIssue(cwd: string, file: string, id: string, stage: string): void {
	mkdirSync(join(cwd, '.gateship', 'issues'), { recursive: true });
	const spec = { scope: 'test', verify: ['true'] };
	writeFileSync(
		join(cwd, '.gateship', 'issues', file),
		`${JSON.stringify({
			id,
			title: `${id} fixture`,
			stage,
			status: 'open',
			blockedBy: [],
			createdAt: '2026-08-15T00:00:00Z',
			updatedAt: '2026-08-15T00:00:00Z',
			spec,
			approval: {
				fingerprint: fingerprintSpec(spec),
				approvedAt: '2026-08-15T00:00:00Z',
			},
		}, null, 2)}\n`,
	);
}

interface Fixture {
	root: string;
	remote: string;
	local: string;
	/** Commit the clone's local main is pinned at, and must stay pinned at. */
	staleMain: string;
	/** Commit the remote published afterwards: shipped CAM-579, filed CAM-580. */
	remoteMain: string;
}

/**
 * A bare remote whose main carries a commit the clone has never seen, so the
 * clone's `main` AND its `origin/main` both start stale.
 */
function seedFixture(): Fixture {
	const root = createTestTmpdir('gship-source-ref-');
	const seed = join(root, 'seed');
	mkdirSync(seed, { recursive: true });
	git(seed, ['init', '-q', '-b', 'main']);
	identify(seed);
	writeFileSync(join(seed, '.gitignore'), '.gship/\n');
	writeIssue(seed, 'CAM-0579.json', 'CAM-579', 'specified');
	git(seed, ['add', '.']);
	git(seed, ['commit', '-q', '-m', 'seed']);

	const remote = join(root, 'remote');
	git(root, ['clone', '-q', '--bare', seed, remote]);
	const local = join(root, 'local');
	git(root, ['clone', '-q', remote, local]);
	identify(local);
	const staleMain = git(local, ['rev-parse', 'refs/heads/main']);

	// The remote moves on: CAM-579 ships and CAM-580 is filed, exactly the
	// post-merge shape that left the previous run reading a stale base.
	writeIssue(seed, 'CAM-0579.json', 'CAM-579', 'shipped');
	writeIssue(seed, 'CAM-0580.json', 'CAM-580', 'specified');
	git(seed, ['add', '.']);
	git(seed, ['commit', '-q', '-m', 'ship CAM-579, file CAM-580']);
	git(seed, ['push', '-q', remote, 'main']);

	return { root, remote, local, staleMain, remoteMain: git(remote, ['rev-parse', 'refs/heads/main']) };
}

describe('the web runtime Git source', () => {
	test('refreshes origin/main before a run and reads the issue there, leaving main alone', () => {
		const fixture = seedFixture();
		writeFileSync(join(fixture.local, 'operator-notes.txt'), 'keep me\n');
		const dirtyBefore = git(fixture.local, ['status', '--porcelain', '--untracked-files=all']);

		// CAM-580 exists only on the commit the remote published.
		expect(getIssueOnMain(fixture.local, 'CAM-580').ok).toBe(false);

		createGitRuntimePreflight(fixture.local)('CAM-580');

		expect(git(fixture.local, ['rev-parse', RUNTIME_SOURCE_REF])).toBe(fixture.remoteMain);
		expect(getIssueOnMain(fixture.local, 'CAM-580', spawnSync, RUNTIME_SOURCE_REF).ok).toBe(true);
		// The local branch never moves, and neither does the host working tree:
		// main may be checked out and dirty in another worktree.
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(fixture.staleMain);
		expect(git(fixture.local, ['status', '--porcelain', '--untracked-files=all'])).toBe(dirtyBefore);
		// The legacy default still reads the local main, stale on purpose.
		expect(getIssueOnMain(fixture.local, 'CAM-580').ok).toBe(false);
		expect(readBacklogFromMain(fixture.local).map((entry) => entry.id)).toEqual(['CAM-579']);
	});

	test('rejects the run when the source ref cannot be refreshed', () => {
		const fixture = seedFixture();
		git(fixture.local, ['remote', 'set-url', 'origin', join(fixture.root, 'gone')]);

		expect(() => createGitRuntimePreflight(fixture.local)('CAM-579'))
			.toThrow(RuntimePreflightError);
		// Fail-closed: an unreachable remote must not admit a run against the
		// ref the clone happens to be holding.
		expect(() => createGitRuntimePreflight(fixture.local)('CAM-579'))
			.toThrow('cannot fetch origin/main');
	});

	test('cuts the run worktree from the refreshed source commit, not from local main', async () => {
		const fixture = seedFixture();
		createGitRuntimePreflight(fixture.local)('CAM-580');

		const workspace = await new GitWorkspaceManager(
			fixture.local,
			undefined,
			noopInstall,
			RUNTIME_SOURCE_REF,
		).prepare({ runId: 'run-580aaaaa-0001', issueId: 'CAM-580' });

		expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(fixture.remoteMain);
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(fixture.staleMain);
	});

	test('the workspace manager still defaults to main for legacy callers', async () => {
		const fixture = seedFixture();
		createGitRuntimePreflight(fixture.local)('CAM-580');

		const workspace = await new GitWorkspaceManager(fixture.local, undefined, noopInstall)
			.prepare({ runId: 'run-580bbbbb-0002', issueId: 'CAM-580' });

		expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(fixture.staleMain);
	});
});
