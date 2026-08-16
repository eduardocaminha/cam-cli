// test/runtime/github-shipper-source-sync.test.ts
//
// CAM-580 acceptance criterion 2: once GitHub confirms MERGED, the shipper
// refreshes origin/main before it reports merged. If that refresh fails the run
// stays retryable, and the repetition over an already-merged pull request
// syncs again without duplicating the commit or the pull request.
//
// Every `git` the shipper runs is the real binary against a real clone of a
// real (bare) remote, so the refresh is measured on refs rather than on a
// recorded argv. Only `gh` is a double: the merge it reports is applied to the
// remote's own main, which is what GitHub would have done.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandResult } from '../../src/runtime/git-runtime.ts';
import { GithubShipper, type ShipCommandRunner } from '../../src/runtime/github-shipper.ts';
import type { RuntimeShipInput, RuntimeShipResult } from '../../src/runtime/run-runtime.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const BRANCH = 'gship/cam-580-580aaaaa';
const PR_NUMBER = 386;

function git(cwd: string, args: string[]): string {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function identify(cwd: string): void {
	git(cwd, ['config', 'user.name', 'Gateship Test']);
	git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

function writeIssue(cwd: string, stage: string): void {
	mkdirSync(join(cwd, '.gateship', 'issues'), { recursive: true });
	writeFileSync(
		join(cwd, '.gateship', 'issues', 'CAM-0580.json'),
		`${JSON.stringify({
			id: 'CAM-580',
			title: 'gship web: fonte remota fresca sem mover main local',
			stage,
			status: 'open',
		}, null, 2)}\n`,
	);
}

interface Fixture {
	root: string;
	remote: string;
	local: string;
	/** Commit the clone's local main is pinned at, and must stay pinned at. */
	staleMain: string;
}

function seedFixture(): Fixture {
	const root = createTestTmpdir('gship-ship-sync-');
	const seed = join(root, 'seed');
	mkdirSync(seed, { recursive: true });
	git(seed, ['init', '-q', '-b', 'main']);
	identify(seed);
	writeFileSync(join(seed, '.gitignore'), '.gship/\n');
	writeIssue(seed, 'specified');
	git(seed, ['add', '.']);
	git(seed, ['commit', '-q', '-m', 'file CAM-580']);

	const remote = join(root, 'remote');
	git(root, ['clone', '-q', '--bare', seed, remote]);
	const local = join(root, 'local');
	git(root, ['clone', '-q', remote, local]);
	identify(local);
	// The run's branch is cut from the source ref, and the change it carries is
	// the one the ship has to land.
	git(local, ['checkout', '-q', '-b', BRANCH, 'origin/main']);
	writeFileSync(join(local, 'CHANGE.md'), 'the verified change\n');

	return { root, remote, local, staleMain: git(local, ['rev-parse', 'refs/heads/main']) };
}

interface Hub {
	/** Null until `gh pr create` opens the pull request. */
	pr: { number: number; state: string; headRefOid: string } | null;
	creates: number;
	merges: number;
	/** Break the clone's remote just as GitHub reports the merge. */
	breakRemoteOnMerge: boolean;
}

/** Real git, doubled gh. The doubled merge lands on the remote's own main. */
function createRunner(fixture: Fixture, hub: Hub): ShipCommandRunner {
	return async ({ cwd, command, args }) => {
		if (command === 'git') {
			const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
			return {
				exitCode: result.status ?? 1,
				stdout: result.stdout ?? '',
				stderr: result.stderr ?? '',
			} satisfies CommandResult;
		}
		if (command === 'gh' && args[1] === 'list') {
			return { exitCode: 0, stdout: JSON.stringify(hub.pr === null ? [] : [hub.pr]), stderr: '' };
		}
		if (command === 'gh' && args[1] === 'create') {
			hub.creates += 1;
			hub.pr = {
				number: PR_NUMBER,
				state: 'OPEN',
				headRefOid: git(fixture.remote, ['rev-parse', `refs/heads/${BRANCH}`]),
			};
			return { exitCode: 0, stdout: `https://github.com/x/y/pull/${PR_NUMBER}\n`, stderr: '' };
		}
		if (command === 'gh' && args[1] === 'merge') {
			hub.merges += 1;
			return { exitCode: 0, stdout: '', stderr: '' };
		}
		if (command === 'gh' && args[1] === 'view') {
			// GitHub merges the branch: the REMOTE's main moves, nothing local does.
			git(fixture.remote, ['update-ref', 'refs/heads/main', `refs/heads/${BRANCH}`]);
			if (hub.pr !== null) hub.pr.state = 'MERGED';
			if (hub.breakRemoteOnMerge) {
				git(fixture.local, ['remote', 'set-url', 'origin', join(fixture.root, 'gone')]);
			}
			return {
				exitCode: 0,
				stdout: JSON.stringify({ state: 'MERGED', mergeStateStatus: 'CLEAN' }),
				stderr: '',
			};
		}
		throw new Error(`unscripted command: ${command} ${args.join(' ')}`);
	};
}

function shipInput(cwd: string, events: string[]): RuntimeShipInput {
	return {
		runId: '580aaaaa-1d68-4ba4-b99b-bc3bf905114f',
		issueId: 'CAM-580',
		cwd,
		signal: new AbortController().signal,
		emit: (kind) => {
			events.push(kind);
		},
	};
}

function ship(fixture: Fixture, hub: Hub, events: string[]): Promise<RuntimeShipResult> {
	return new GithubShipper({ runCommand: createRunner(fixture, hub), pollIntervalMs: 0 })
		.ship(shipInput(fixture.local, events));
}

function newHub(overrides: Partial<Hub> = {}): Hub {
	return { pr: null, creates: 0, merges: 0, breakRemoteOnMerge: false, ...overrides };
}

describe('the post-merge source sync', () => {
	test('refreshes origin/main before reporting merged, without moving local main', async () => {
		const fixture = seedFixture();
		const events: string[] = [];

		const shipped = await ship(fixture, newHub(), events);

		expect(shipped).toEqual({ outcome: 'merged', prNumber: PR_NUMBER });
		expect(git(fixture.local, ['rev-parse', 'origin/main']))
			.toBe(git(fixture.remote, ['rev-parse', 'refs/heads/main']));
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(fixture.staleMain);
		// The merge this ship landed is visible on the source ref the next run
		// reads: the issue is no longer offered as specified.
		expect(git(fixture.local, ['show', 'origin/main:.gateship/issues/CAM-0580.json']))
			.toContain('"stage": "shipped"');
		expect(events.slice(-2)).toEqual(['ship.source-synced', 'ship.merged']);
	});

	test('a failed refresh keeps the run retryable, and the retry syncs without duplicating', async () => {
		const fixture = seedFixture();
		const hub = newHub({ breakRemoteOnMerge: true });

		const failed = await ship(fixture, hub, []);

		expect(failed.outcome).toBe('failed');
		expect(failed).toMatchObject({
			detail: expect.stringContaining('origin/main could not be refreshed'),
		});
		// Done would be a lie while the source ref still offers CAM-580.
		expect(git(fixture.local, ['rev-parse', 'origin/main'])).toBe(fixture.staleMain);

		const branchHead = git(fixture.local, ['rev-parse', 'HEAD']);
		const branchCommits = git(fixture.local, ['rev-list', '--count', 'HEAD']);
		hub.breakRemoteOnMerge = false;
		git(fixture.local, ['remote', 'set-url', 'origin', fixture.remote]);

		const events: string[] = [];
		const retried = await ship(fixture, hub, events);

		expect(retried).toEqual({ outcome: 'merged', prNumber: PR_NUMBER });
		expect(git(fixture.local, ['rev-parse', 'origin/main']))
			.toBe(git(fixture.remote, ['rev-parse', 'refs/heads/main']));
		// The retry re-ran only the sync: no second commit, no second pull request.
		expect(git(fixture.local, ['rev-parse', 'HEAD'])).toBe(branchHead);
		expect(git(fixture.local, ['rev-list', '--count', 'HEAD'])).toBe(branchCommits);
		expect(hub.creates).toBe(1);
		expect(events).toEqual([
			'ship.pushed',
			'ship.pr-reused',
			'ship.source-synced',
			'ship.merged',
		]);
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main'])).toBe(fixture.staleMain);
	});
});
