// test/runtime/github-shipper.test.ts
//
// CAM-579 acceptance criterion 1: the GitHub shipper closes the run's issue
// inside its own worktree, commits everything, pushes, opens or reuses the
// branch's pull request and arms squash auto-merge pinned to the published
// head commit. Running it twice must reuse the commit and the pull request
// instead of duplicating either.

import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { CommandResult } from '../../src/runtime/git-runtime.ts';
import { GithubShipper, type ShipCommandRunner } from '../../src/runtime/github-shipper.ts';
import type { RuntimeShipInput } from '../../src/runtime/run-runtime.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const BRANCH = 'gship/cam-579-2a6af4e6';
const HEAD_SHA = '9f1c0b7a5d3e2f1908a7b6c5d4e3f2a1b0c9d8e7';
/** What a force-push from outside the service leaves on the branch (GSHIP-615). */
const FOREIGN_SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const PR_URL = 'https://github.com/gateship-dev/gateship/pull/385\n';

interface RecordedCall {
	command: string;
	args: string[];
}

interface FakeRepo {
	branch: string;
	/** True while `git diff --cached --quiet` would report staged changes. */
	staged: boolean;
	commits: number;
	pushes: number;
	/** Post-merge refreshes of the runtime source ref (CAM-580). */
	fetches: number;
	prNumber: number | null;
	/** State `gh pr list --state all` reports for an existing pull request. */
	prState: string;
	/** Head commit the existing pull request carries, as GitHub records it. */
	prHeadRefOid: string;
	prCreates: number;
	views: number;
	/** The poll on which `gh pr view` starts reporting MERGED. */
	mergedOnView: number;
	/** The poll from which the branch carries a head the service never pushed. */
	headMovedOnView: number;
	pushFails: boolean;
}

function createRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
	return {
		branch: BRANCH,
		staged: true,
		commits: 0,
		pushes: 0,
		fetches: 0,
		prNumber: null,
		prState: 'OPEN',
		prHeadRefOid: HEAD_SHA,
		prCreates: 0,
		views: 0,
		mergedOnView: 1,
		headMovedOnView: Number.MAX_SAFE_INTEGER,
		pushFails: false,
		...overrides,
	};
}

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
	return { exitCode, stdout, stderr };
}

/** In-memory git + gh double: the only I/O the shipper is allowed to do. */
function createRunner(repo: FakeRepo, calls: RecordedCall[]): ShipCommandRunner {
	return async ({ command, args }) => {
		calls.push({ command, args });
		if (command === 'git') {
			if (args[0] === 'rev-parse') {
				return result(0, `${args[1] === '--abbrev-ref' ? repo.branch : HEAD_SHA}\n`);
			}
			if (args[0] === 'add') return result(0);
			if (args[0] === 'diff') return result(repo.staged ? 1 : 0);
			if (args[0] === 'commit') {
				repo.commits += 1;
				repo.staged = false;
				return result(0);
			}
			if (args[0] === 'push') {
				if (repo.pushFails) return result(1, '', 'fatal: unable to access origin');
				repo.pushes += 1;
				return result(0);
			}
			if (args[0] === 'fetch') {
				repo.fetches += 1;
				return result(0);
			}
		}
		if (command === 'gh') {
			if (args[1] === 'list') {
				const existing = repo.prNumber === null ? [] : [{
					number: repo.prNumber,
					state: repo.prState,
					headRefOid: repo.prHeadRefOid,
				}];
				return result(0, JSON.stringify(existing));
			}
			if (args[1] === 'create') {
				repo.prNumber = 385;
				repo.prCreates += 1;
				return result(0, PR_URL);
			}
			if (args[1] === 'merge') return result(0);
			if (args[1] === 'view') {
				repo.views += 1;
				// A force-push from outside the service is durable too: the pull
				// request carries the foreign head from this poll onwards.
				if (repo.views >= repo.headMovedOnView) repo.prHeadRefOid = FOREIGN_SHA;
				const merged = repo.views >= repo.mergedOnView;
				// A merge is durable: `gh pr list` reports MERGED from now on.
				if (merged) repo.prState = 'MERGED';
				return result(0, JSON.stringify({
					state: merged ? 'MERGED' : 'OPEN',
					mergeStateStatus: merged ? 'CLEAN' : 'BLOCKED',
					headRefOid: repo.prHeadRefOid,
				}));
			}
		}
		throw new Error(`unscripted command: ${command} ${args.join(' ')}`);
	};
}

function createWorkspace(stage = 'specified'): string {
	const cwd = createTestTmpdir('gship-shipper-');
	mkdirSync(join(cwd, '.gateship', 'issues'), { recursive: true });
	writeFileSync(
		join(cwd, '.gateship', 'issues', 'CAM-0579.json'),
		`${JSON.stringify({
			id: 'CAM-579',
			title: 'gship web: ship atomico do run ate o merge',
			stage,
			status: 'open',
		}, null, 2)}\n`,
	);
	return cwd;
}

function readIssue(cwd: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(join(cwd, '.gateship', 'issues', 'CAM-0579.json'), 'utf8'),
	) as Record<string, unknown>;
}

function createShipInput(cwd: string, events: string[], signal: AbortSignal): RuntimeShipInput {
	return {
		runId: '2a6af4e6-1d68-4ba4-b99b-bc3bf905114f',
		issueId: 'CAM-579',
		cwd,
		signal,
		emit: (kind) => {
			events.push(kind);
		},
	};
}

function findCall(calls: RecordedCall[], command: string, first: string, second?: string) {
	return calls.filter((call) =>
		call.command === command &&
		call.args[0] === first &&
		(second === undefined || call.args[1] === second));
}

describe('the GitHub shipper', () => {
	test('closes the issue in the worktree, commits, pushes and arms a pinned auto-merge', async () => {
		const cwd = createWorkspace();
		const repo = createRepo();
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		// The issue is closed on the branch: main only learns by merging the PR.
		expect(readIssue(cwd)).toMatchObject({ id: 'CAM-579', stage: 'shipped' });
		expect(repo.commits).toBe(1);
		expect(repo.pushes).toBe(1);
		expect(repo.prCreates).toBe(1);
		expect(findCall(calls, 'git', 'push')[0]?.args).toEqual([
			'push', '--set-upstream', 'origin', BRANCH,
		]);
		expect(findCall(calls, 'gh', 'pr', 'create')[0]?.args).toContain('--head');
		// Auto-merge is pinned to the exact published head.
		expect(findCall(calls, 'gh', 'pr', 'merge')[0]).toEqual({
			command: 'gh',
			args: ['pr', 'merge', '385', '--squash', '--auto', '--match-head-commit', HEAD_SHA],
		});
		expect(events).toEqual([
			'ship.issue-closed',
			'ship.committed',
			'ship.pushed',
			'ship.pr-opened',
			'ship.automerge-armed',
			'ship.source-synced',
			'ship.merged',
		]);
	});

	test('a repeated ship reuses the commit and the pull request instead of duplicating them', async () => {
		const cwd = createWorkspace();
		const repo = createRepo();
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});
		const signal = new AbortController().signal;

		const first: string[] = [];
		await shipper.ship(createShipInput(cwd, first, signal));
		const second: string[] = [];
		const repeated = await shipper.ship(createShipInput(cwd, second, signal));

		// The first ship already merged the pull request, so the repetition
		// recognises its own merge instead of opening a second, zero-diff one.
		expect(repeated).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.commits).toBe(1);
		expect(repo.prCreates).toBe(1);
		expect(second).toEqual(['ship.pushed', 'ship.pr-reused', 'ship.source-synced', 'ship.merged']);
		expect(findCall(calls, 'gh', 'pr', 'create')).toHaveLength(1);
		expect(findCall(calls, 'git', 'commit')).toHaveLength(1);
		expect(findCall(calls, 'gh', 'pr', 'merge')).toHaveLength(1);
		expect(findCall(calls, 'gh', 'pr', 'list')[1]?.args).toContain('all');
	});

	test('a ship retried after auto-merge landed the branch reports merged, not a new PR', async () => {
		const cwd = createWorkspace();
		// The monitor gives up before CI goes green: the run stays ready-to-ship
		// with auto-merge still armed, and GitHub merges the branch afterwards.
		const repo = createRepo({ mergedOnView: Number.MAX_SAFE_INTEGER });
		const calls: RecordedCall[] = [];
		const runner = createRunner(repo, calls);
		const abandoned = new GithubShipper({ runCommand: runner, pollIntervalMs: 0, mergeTimeoutMs: 0 });
		const signal = new AbortController().signal;

		expect(await abandoned.ship(createShipInput(cwd, [], signal)))
			.toMatchObject({ outcome: 'failed' });
		repo.prState = 'MERGED';

		const events: string[] = [];
		const retried = await new GithubShipper({ runCommand: runner, pollIntervalMs: 0 })
			.ship(createShipInput(cwd, events, signal));

		expect(retried).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.prCreates).toBe(1);
		expect(events).toEqual(['ship.pushed', 'ship.pr-reused', 'ship.source-synced', 'ship.merged']);
		// No second arming, and no poll: the merge already happened.
		expect(findCall(calls, 'gh', 'pr', 'merge')).toHaveLength(1);
		expect(repo.views).toBe(1);
	});

	test('a pull request closed without merging fails instead of reopening one', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ prNumber: 385, prState: 'CLOSED' });
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(failed).toEqual({
			outcome: 'failed',
			detail: 'pull request #385 was closed without merging',
		});
		expect(repo.prCreates).toBe(0);
		expect(findCall(calls, 'gh', 'pr', 'merge')).toHaveLength(0);
	});

	test('a merge of a different head never counts as this run shipping', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ prNumber: 385, prState: 'MERGED', prHeadRefOid: 'c0ffee' });
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, []),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail).toContain('merged c0ffee');
	});

	test('the monitor keeps polling until GitHub reports the merge', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ mergedOnView: 3 });
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, []),
			pollIntervalMs: 1,
		});

		const shipped = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal),
		);

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.views).toBe(3);
		// The pending status is reported once, not once per poll.
		expect(events.filter((kind) => kind === 'ship.merge-pending')).toHaveLength(1);
	});

	test('a head moved outside the service ends the monitor instead of waiting for it to merge', async () => {
		const cwd = createWorkspace();
		// GSHIP-615: the branch is force-pushed while the monitor waits for CI.
		// The armed auto-merge is GitHub's promise, so the ship checks the head
		// itself and refuses to keep waiting for a merge it cannot vouch for.
		const repo = createRepo({ mergedOnView: Number.MAX_SAFE_INTEGER, headMovedOnView: 2 });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail).toContain(FOREIGN_SHA);
		expect((failed as { detail: string }).detail).toContain('moved outside the service');
		// The monitor stops on the poll that saw the foreign head.
		expect(repo.views).toBe(2);
		expect(events.at(-1)).toBe('ship.head-diverged');
		expect(events).not.toContain('ship.merged');
		// Nothing is merged, nothing is re-armed, and origin/main is left alone.
		expect(findCall(calls, 'gh', 'pr', 'merge')).toHaveLength(1);
		expect(repo.fetches).toBe(0);
	});

	test('a merge that landed a foreign head is reported as a failure, never as merged', async () => {
		const cwd = createWorkspace();
		// The force-push wins the race and GitHub merges the head it left.
		const repo = createRepo({ mergedOnView: 1, headMovedOnView: 1 });
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, []),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail)
			.toContain(`merged ${FOREIGN_SHA}, not the head ${HEAD_SHA}`);
		expect((failed as { detail: string }).detail).toContain('never verified');
		expect(events.at(-1)).toBe('ship.head-diverged');
		expect(events).not.toContain('ship.merged');
		expect(events).not.toContain('ship.source-synced');
		expect(repo.fetches).toBe(0);
	});

	test('a head that never moves polls to a merge without any divergence report', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ mergedOnView: 3 });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(events).not.toContain('ship.head-diverged');
		expect(events.slice(-2)).toEqual(['ship.source-synced', 'ship.merged']);
		// Every poll reads the head, not only the merge state.
		const views = findCall(calls, 'gh', 'pr', 'view');
		expect(views).toHaveLength(3);
		for (const view of views) {
			expect(view.args).toContain('state,mergeStateStatus,headRefOid');
		}
	});

	test('a push failure fails before any pull request exists, and keeps the diff', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ pushFails: true });
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail).toContain('git push --set-upstream failed');
		expect(findCall(calls, 'gh', 'pr', 'create')).toHaveLength(0);
		expect(repo.commits).toBe(1);
	});

	test('an unmerged pull request stops at a retryable failure instead of done', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ mergedOnView: Number.MAX_SAFE_INTEGER });
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, []),
			pollIntervalMs: 0,
			mergeTimeoutMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail).toContain('did not merge');
	});

	test('cancelling while the monitor waits aborts the ship', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ mergedOnView: Number.MAX_SAFE_INTEGER });
		const calls: RecordedCall[] = [];
		const controller = new AbortController();
		const runner = createRunner(repo, calls);
		const shipper = new GithubShipper({
			runCommand: async (input) => {
				const commandResult = await runner(input);
				if (input.args[1] === 'view') controller.abort();
				return commandResult;
			},
			pollIntervalMs: 60_000,
		});

		await expect(shipper.ship(createShipInput(cwd, [], controller.signal)))
			.rejects.toThrow('cancelled');
		expect(repo.views).toBe(1);
	});

	test('a workspace still on main never ships', async () => {
		const cwd = createWorkspace();
		const shipper = new GithubShipper({
			runCommand: createRunner(createRepo({ branch: 'main' }), []),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(failed).toEqual({
			outcome: 'failed',
			detail: 'run workspace is not on a ship branch: main',
		});
		expect(readIssue(cwd)).toMatchObject({ stage: 'specified' });
	});

	test('rejects a symlinked issue path without writing outside the worktree', async () => {
		const cwd = createWorkspace();
		const issuePath = join(cwd, '.gateship', 'issues', 'CAM-0579.json');
		const outside = join(createTestTmpdir('gship-shipper-outside-'), 'outside.json');
		const original = '{"outside":"preserve me"}\n';
		writeFileSync(outside, original);
		unlinkSync(issuePath);
		symlinkSync(outside, issuePath);
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(createRepo(), calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail).toContain('run issue path is unsafe');
		expect(readFileSync(outside, 'utf8')).toBe(original);
		expect(findCall(calls, 'git', 'add')).toHaveLength(0);
	});
});
