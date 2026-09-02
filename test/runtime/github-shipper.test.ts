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
/** Heads `gh pr update-branch` leaves behind, one per call (GSHIP-632). */
const UPDATED_SHAS = [
	'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
	'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
	'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
];
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
	/** Post-merge refreshes of the runtime source ref (CAM-580), plus any post-update-branch worktree syncs (GSHIP-632). */
	fetches: number;
	/** Local worktree hard-resets after the service updates the branch (GSHIP-632). */
	resets: number;
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
	/** The poll from which `gh pr view` reports CLOSED without merging (GSHIP-641). */
	closedOnView: number;
	/** `gh pr view` reports BEHIND while fewer than this many updates have run (GSHIP-632). */
	behindWhileUpdatesBelow: number;
	/** Mergeability reported for an open PR when it is not behind or updating. */
	openMergeState: string;
	/** Times `gh pr update-branch` has been called. */
	branchUpdates: number;
	/** A specific `gh pr update-branch` refusal, if GitHub returns one. */
	updateBranchFailure: string | null;
	/** The update mutation loses the branch because auto-merge landed it first. */
	mergeOnUpdateBranchFailure: boolean;
	/**
	 * `gh pr view` calls after a `gh pr update-branch` before its new head
	 * becomes visible on `prHeadRefOid` (GSHIP-656): 0 means the very first
	 * post-update view already sees it, matching a same-tick apply; a higher
	 * number simulates the update landing asynchronously, a poll or more after
	 * `gh` reported the request accepted.
	 */
	branchUpdateDelayViews: number;
	/** Head an outstanding `gh pr update-branch` will apply once its delay elapses, or null once applied. */
	pendingHeadSha: string | null;
	/** `views` count at the moment the outstanding update was requested. */
	pendingHeadSinceView: number;
	/**
	 * `mergeStateStatus` `gh pr view` reports while an update is pending and
	 * unapplied (GSHIP-656). Real GitHub invalidates and recomputes
	 * mergeability as soon as `update-branch` is requested and reports
	 * UNKNOWN while it does — defaults to 'BEHIND' to match that in every
	 * other test, but a test can set 'UNKNOWN' to prove a status leaving
	 * BEHIND is not read as confirmation while the head is still unchanged.
	 */
	mergeStateWhilePending: string;
	/** Arming take-downs GitHub accepted or refused (GSHIP-616). */
	disarms: number;
	disarmFails: boolean;
	pushFails: boolean;
	/** Times `gh pr merge --auto` reports HTTP 503 before succeeding (GSHIP-625). */
	armUnavailableRemaining: number;
	/** A decision failure `gh pr merge --auto` reports immediately, never retried. */
	armDecisionFailure: string | null;
	/** Times direct squash merge is attempted after GitHub arms or refuses auto-merge. */
	directMergeAttempts: number;
	/** Times direct squash merge reports HTTP 503 before succeeding. */
	directMergeUnavailableRemaining: number;
	/** A decision failure direct squash merge reports immediately, never retried. */
	directMergeDecisionFailure: string | null;
	/** True while `gh pr view` keeps reporting HTTP 503 (GSHIP-625). */
	viewUnavailableAlways: boolean;
	/** `gh pr view` reports HTTP 503 from this poll onwards (GSHIP-632). */
	viewUnavailableFromView: number;
	armAttempts: number;
	/** What `gh pr checks --required` reports while the pull request is BLOCKED (GSHIP-646). */
	requiredChecks: Array<{ name: string; bucket: string; link?: string }>;
	/** Times `gh pr checks --required` reports HTTP 503 before succeeding (GSHIP-646). */
	requiredChecksUnavailableRemaining: number;
	/** Times `gh pr checks --required` has been called. */
	requiredChecksCalls: number;
	statusCheckRollups: unknown[][];
}

function createRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
	return {
		branch: BRANCH,
		staged: true,
		commits: 0,
		pushes: 0,
		fetches: 0,
		resets: 0,
		prNumber: null,
		prState: 'OPEN',
		prHeadRefOid: HEAD_SHA,
		prCreates: 0,
		views: 0,
		mergedOnView: 1,
		headMovedOnView: Number.MAX_SAFE_INTEGER,
		closedOnView: Number.MAX_SAFE_INTEGER,
		behindWhileUpdatesBelow: 0,
		openMergeState: 'BLOCKED',
		branchUpdates: 0,
		updateBranchFailure: null,
		mergeOnUpdateBranchFailure: false,
		branchUpdateDelayViews: 0,
		pendingHeadSha: null,
		pendingHeadSinceView: 0,
		mergeStateWhilePending: 'BEHIND',
		disarms: 0,
		disarmFails: false,
		pushFails: false,
		armUnavailableRemaining: 0,
		armDecisionFailure: null,
		directMergeAttempts: 0,
		directMergeUnavailableRemaining: 0,
		directMergeDecisionFailure: null,
		viewUnavailableAlways: false,
		viewUnavailableFromView: Number.POSITIVE_INFINITY,
		armAttempts: 0,
		requiredChecks: [],
		requiredChecksUnavailableRemaining: 0,
		requiredChecksCalls: 0,
		statusCheckRollups: [[]],
		...overrides,
	};
}

function result(exitCode: number, stdout = '', stderr = ''): CommandResult {
	return { exitCode, stdout, stderr };
}

function runGitCommand(repo: FakeRepo, args: string[]): CommandResult | undefined {
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
	if (args[0] === 'reset') {
		repo.resets += 1;
		return result(0);
	}
	return undefined;
}

function ghList(repo: FakeRepo): CommandResult {
	const existing = repo.prNumber === null ? [] : [{
		number: repo.prNumber,
		state: repo.prState,
		headRefOid: repo.prHeadRefOid,
		url: PR_URL.trim(),
	}];
	return result(0, JSON.stringify(existing));
}

function ghCreate(repo: FakeRepo): CommandResult {
	repo.prNumber = 385;
	repo.prCreates += 1;
	return result(0, PR_URL);
}

function ghMerge(repo: FakeRepo, args: string[]): CommandResult {
	if (args.includes('--disable-auto')) {
		repo.disarms += 1;
		return repo.disarmFails
			? result(1, '', 'failed to disable auto-merge: not enabled')
			: result(0);
	}
	if (args.includes('--auto')) {
		repo.armAttempts += 1;
		if (repo.armDecisionFailure !== null) {
			return result(1, '', repo.armDecisionFailure);
		}
		if (repo.armUnavailableRemaining > 0) {
			repo.armUnavailableRemaining -= 1;
			return result(1, '', 'HTTP 503: Service Unavailable (https://api.github.com/graphql)');
		}
		return result(0);
	}
	repo.directMergeAttempts += 1;
	if (repo.directMergeDecisionFailure !== null) {
		return result(1, '', repo.directMergeDecisionFailure);
	}
	if (repo.directMergeUnavailableRemaining > 0) {
		repo.directMergeUnavailableRemaining -= 1;
		return result(1, '', 'HTTP 503: Service Unavailable (https://api.github.com/graphql)');
	}
	repo.prState = 'MERGED';
	return result(0);
}

function ghUpdateBranch(repo: FakeRepo): CommandResult {
	repo.branchUpdates += 1;
	if (repo.updateBranchFailure !== null) {
		if (repo.mergeOnUpdateBranchFailure) repo.prState = 'MERGED';
		return result(1, '', repo.updateBranchFailure);
	}
	// The new head is not applied here: `gh pr update-branch` only reports
	// GitHub accepted the request. `ghView` applies it once `branchUpdateDelayViews`
	// worth of rereads have passed, simulating the asynchronous apply GSHIP-656
	// exists to wait out.
	repo.pendingHeadSha = UPDATED_SHAS[repo.branchUpdates - 1] ?? FOREIGN_SHA;
	repo.pendingHeadSinceView = repo.views;
	return result(0, `✓ Updated branch ${repo.branch}\n`);
}

/**
 * MERGED and CLOSED are both durable once reported (GSHIP-641): `gh pr list`
 * keeps repeating whichever one fired on every later call, same as `prState`
 * does elsewhere in this double.
 */
function resolvePullRequestState(repo: FakeRepo): { state: string; mergeStateStatus: string } {
	if (repo.prState === 'MERGED') return { state: 'MERGED', mergeStateStatus: 'CLEAN' };
	if (repo.views >= repo.mergedOnView) {
		repo.prState = 'MERGED';
		return { state: 'MERGED', mergeStateStatus: 'CLEAN' };
	}
	if (repo.views >= repo.closedOnView) {
		repo.prState = 'CLOSED';
		return { state: 'CLOSED', mergeStateStatus: 'UNKNOWN' };
	}
	// An update whose new head has not become visible yet (GSHIP-656) reports
	// `mergeStateWhilePending` regardless of `behindWhileUpdatesBelow` — real
	// GitHub itself may already report something other than BEHIND (UNKNOWN,
	// while it recomputes mergeability) before the merge has actually landed.
	if (repo.pendingHeadSha !== null) {
		return { state: 'OPEN', mergeStateStatus: repo.mergeStateWhilePending };
	}
	const behind = repo.branchUpdates < repo.behindWhileUpdatesBelow;
	return { state: 'OPEN', mergeStateStatus: behind ? 'BEHIND' : repo.openMergeState };
}

function ghView(repo: FakeRepo): CommandResult {
	repo.views += 1;
	if (repo.viewUnavailableAlways || repo.views >= repo.viewUnavailableFromView) {
		return result(1, '', 'HTTP 503: Service Unavailable (https://api.github.com/graphql)');
	}
	// The head an outstanding `gh pr update-branch` produced only becomes
	// visible once `branchUpdateDelayViews` worth of rereads have passed
	// (GSHIP-656) — a read fired too soon must still see the pre-update head.
	if (
		repo.pendingHeadSha !== null &&
		repo.views - repo.pendingHeadSinceView > repo.branchUpdateDelayViews
	) {
		repo.prHeadRefOid = repo.pendingHeadSha;
		repo.pendingHeadSha = null;
	}
	// A force-push from outside the service is durable too: the pull
	// request carries the foreign head from this poll onwards.
	if (repo.views >= repo.headMovedOnView) repo.prHeadRefOid = FOREIGN_SHA;
	const { state, mergeStateStatus } = resolvePullRequestState(repo);
	return result(0, JSON.stringify({
		state,
		mergeStateStatus,
		headRefOid: repo.prHeadRefOid,
		url: PR_URL.trim(),
		statusCheckRollup: repo.statusCheckRollups[Math.min(
			repo.views - 1,
			repo.statusCheckRollups.length - 1,
		)] ?? [],
	}));
}

/**
 * `gh pr checks --required`: empty by default, so BLOCKED stays a wait
 * exactly as before GSHIP-646. `gh` documents a non-zero exit for a failing
 * check even under `--json`, so this reports one right alongside the `fail`
 * payload, the same as the real command would: the shipper has to read
 * stdout regardless of the exit code, not only when it happens to be 0.
 */
function ghChecks(repo: FakeRepo): CommandResult {
	repo.requiredChecksCalls += 1;
	if (repo.requiredChecksUnavailableRemaining > 0) {
		repo.requiredChecksUnavailableRemaining -= 1;
		return result(1, '', 'HTTP 503: Service Unavailable (https://api.github.com/graphql)');
	}
	const failing = repo.requiredChecks.some((check) => check.bucket === 'fail');
	return result(failing ? 1 : 0, JSON.stringify(repo.requiredChecks));
}

function runGhCommand(repo: FakeRepo, args: string[]): CommandResult | undefined {
	if (args[1] === 'list') return ghList(repo);
	if (args[1] === 'create') return ghCreate(repo);
	if (args[1] === 'merge') return ghMerge(repo, args);
	if (args[1] === 'update-branch') return ghUpdateBranch(repo);
	if (args[1] === 'view') return ghView(repo);
	if (args[1] === 'checks') return ghChecks(repo);
	return undefined;
}

/** In-memory git + gh double: the only I/O the shipper is allowed to do. */
function createRunner(repo: FakeRepo, calls: RecordedCall[]): ShipCommandRunner {
	return async ({ command, args }) => {
		calls.push({ command, args });
		const response =
			command === 'git' ? runGitCommand(repo, args) :
			command === 'gh' ? runGhCommand(repo, args) :
			undefined;
		if (response !== undefined) return response;
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
			spec: { verify: ['bun test test/runtime/github-shipper.test.ts'] },
		}, null, 2)}\n`,
	);
	return cwd;
}

function readIssue(cwd: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(join(cwd, '.gateship', 'issues', 'CAM-0579.json'), 'utf8'),
	) as Record<string, unknown>;
}

/**
 * The shipper's own view of an event: `payloads` is only collected by the tests
 * that read what an event carries, not just that it happened.
 */
function createShipInput(
	cwd: string,
	events: string[],
	signal: AbortSignal,
	payloads?: Map<string, Record<string, unknown> | undefined>,
): RuntimeShipInput {
	return {
		runId: '2a6af4e6-1d68-4ba4-b99b-bc3bf905114f',
		issueId: 'CAM-579',
		cwd,
		signal,
		emit: (kind, payload) => {
			events.push(kind);
			payloads?.set(kind, payload);
		},
		evidence: {
			workflowRevision: 'revision-test',
			review: 'passed',
			fullVerification: 'passed',
		},
		initialCiStatus: 'not-reported',
	};
}

function findCall(calls: RecordedCall[], command: string, first: string, second?: string) {
	return calls.filter((call) =>
		call.command === command &&
		call.args[0] === first &&
		(second === undefined || call.args[1] === second));
}

/** `gh pr merge` arming the pull request, told apart from the take-down. */
function armCalls(calls: RecordedCall[]): RecordedCall[] {
	return findCall(calls, 'gh', 'pr', 'merge').filter((call) => call.args.includes('--auto'));
}

/** `gh pr merge --disable-auto`: the take-down of a previous arming. */
function disarmCalls(calls: RecordedCall[]): RecordedCall[] {
	return findCall(calls, 'gh', 'pr', 'merge').filter((call) =>
		call.args.includes('--disable-auto'));
}

describe('the GitHub shipper', () => {
	test('monitors an intake control PR through the same pinned-head lifecycle and deletes it after merge', async () => {
		const cwd = createWorkspace();
		const repo = createRepo();
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 });

		const merged = await shipper.mergePullRequest({
			runId: 'intake-CAM-579',
			evidence: { workflowRevision: 'intake', review: 'not-applicable', fullVerification: 'not-applicable' },
			cwd,
			issueId: 'CAM-579',
			title: 'intake control',
			branch: 'gship/intake/cam-579',
			headSha: HEAD_SHA,
			verificationCommands: ['true'],
			signal: new AbortController().signal,
			emit: () => {},
			initialCiStatus: 'not-reported',
			deleteBranch: true,
		});

		expect(merged).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.commits).toBe(0);
		expect(repo.pushes).toBe(0);
		expect(repo.prCreates).toBe(1);
		expect(armCalls(calls)[0]?.args).toContain('--match-head-commit');
		expect(armCalls(calls)[0]?.args).toContain(HEAD_SHA);
		expect(armCalls(calls)[0]?.args).toContain('--delete-branch');
	});

	test('refuses an intake PR merged with a head other than the published one', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({ prNumber: 385, prState: 'MERGED', prHeadRefOid: FOREIGN_SHA });
		const shipper = new GithubShipper({ runCommand: createRunner(repo, []), pollIntervalMs: 0 });
		const result = await shipper.mergePullRequest({
			runId: 'intake-CAM-579',
			evidence: { workflowRevision: 'intake', review: 'not-applicable', fullVerification: 'not-applicable' },
			cwd, issueId: 'CAM-579', title: 'intake control', branch: 'gship/intake/cam-579',
			headSha: HEAD_SHA, verificationCommands: ['true'], signal: new AbortController().signal,
			emit: () => {}, initialCiStatus: 'not-reported', deleteBranch: true,
		});
		expect(result).toMatchObject({ outcome: 'failed' });
		expect((result as { detail: string }).detail).toContain('never verified');
	});

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

	test('opens the pull request with compact approved evidence and records its canonical URL', async () => {
		const cwd = createWorkspace();
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(createRepo(), calls),
			pollIntervalMs: 0,
		});

		await shipper.ship(createShipInput(cwd, events, new AbortController().signal, payloads));

		const create = findCall(calls, 'gh', 'pr', 'create')[0];
		const body = create?.args[(create.args.indexOf('--body') + 1)];
		expect(body).toContain('## Gateship evidence');
		expect(body).toContain('`2a6af4e6-1d68-4ba4-b99b-bc3bf905114f`');
		expect(body).toContain('`CAM-579`');
		expect(body).toContain('`revision-test`');
		expect(body).toContain('bun test test/runtime/github-shipper.test.ts');
		expect(body).toContain('Independent review: passed');
		expect(body).toContain('Full-project verification: passed');
		expect(payloads.get('ship.pr-opened')).toMatchObject({
			prNumber: 385,
			url: PR_URL.trim(),
		});
	});

	test('reports CI only when its aggregate changes, and never treats empty checks as passed', async () => {
		const cwd = createWorkspace();
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const repo = createRepo({
			mergedOnView: 4,
			statusCheckRollups: [
				[],
				[{ name: 'verify', status: 'IN_PROGRESS', conclusion: null }],
				[{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
				[{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
			],
		});
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, []),
			pollIntervalMs: 0,
		});

		await shipper.ship(createShipInput(cwd, events, new AbortController().signal, payloads));

		expect(events.filter((kind) => kind === 'ship.ci-status')).toHaveLength(2);
		expect(payloads.get('ship.ci-status')).toMatchObject({ status: 'passed' });
	});

	test('a failed CI transition names and links every failed check GitHub reports', async () => {
		const cwd = createWorkspace();
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const repo = createRepo({
			statusCheckRollups: [[{
				name: 'lint',
				status: 'COMPLETED',
				conclusion: 'FAILURE',
				detailsUrl: 'https://github.com/gateship-dev/gateship/actions/runs/42',
			}]],
		});
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, []),
			pollIntervalMs: 0,
		});

		await shipper.ship(createShipInput(cwd, events, new AbortController().signal, payloads));

		expect(payloads.get('ship.ci-status')).toEqual({
			prNumber: 385,
			url: PR_URL.trim(),
			status: 'failed',
			failedChecks: [{
				name: 'lint',
				url: 'https://github.com/gateship-dev/gateship/actions/runs/42',
			}],
		});
	});

	test('GitHub reporting unavailable while arming auto-merge retries and still ships (GSHIP-625)', async () => {
		const cwd = createWorkspace();
		// Same shape as the GSHIP-624 evidence: `gh pr merge` answers HTTP 503
		// twice before GitHub actually accepts the arming.
		const repo = createRepo({ armUnavailableRemaining: 2 });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			unavailableRetryDelaysMs: [0, 0, 0],
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.armAttempts).toBe(3);
		expect(armCalls(calls)).toHaveLength(3);
		expect(events.filter((kind) => kind === 'ship.github-unavailable')).toHaveLength(2);
		expect(events.at(-1)).toBe('ship.merged');
	});

	test('GitHub staying unavailable while reading merge state ends the ship as unconfirmed, not failed (GSHIP-625)', async () => {
		const cwd = createWorkspace();
		// The evidence for GSHIP-624: `gh pr view` kept answering HTTP 503 right
		// after auto-merge was armed, while GitHub actually merged the branch a
		// second later. The ship must say it could not confirm the merge, never
		// that the merge failed.
		const repo = createRepo({ viewUnavailableAlways: true });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			unavailableRetryDelaysMs: [0, 0, 0],
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toMatchObject({ outcome: 'failed' });
		const detail = (shipped as { detail: string }).detail;
		expect(detail).toContain('could not be confirmed');
		expect(detail).toContain('not a merge failure');
		expect(detail).not.toContain('did not merge');
		expect(detail).not.toContain('closed without merging');
		// One initial attempt plus the three fixed retries, then it gives up.
		expect(repo.views).toBe(4);
		expect(events.filter((kind) => kind === 'ship.github-unavailable')).toHaveLength(3);
		expect(events.at(-1)).toBe('ship.merge-unconfirmed');
		// The ship just stopped trying to look: nothing is re-armed or disarmed.
		expect(disarmCalls(calls)).toHaveLength(0);
		expect(armCalls(calls)).toHaveLength(1);
	});

	test('a GitHub decision refusing to arm auto-merge fails immediately, without retrying (GSHIP-625)', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			armDecisionFailure: 'GraphQL: Resource not accessible by integration (mergePullRequest)',
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			unavailableRetryDelaysMs: [0, 0, 0],
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({
			outcome: 'failed',
			detail: 'gh pr merge failed: GraphQL: Resource not accessible by integration (mergePullRequest)',
		});
		// A decision is never retried: exactly one attempt, no backoff.
		expect(repo.armAttempts).toBe(1);
		expect(armCalls(calls)).toHaveLength(1);
		expect(events).not.toContain('ship.github-unavailable');
		expect(repo.directMergeAttempts).toBe(0);
	});

	test('falls back through the same monitor after GitHub explicitly disallows auto-merge, waiting for CI', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			armDecisionFailure: 'GraphQL: Pull request Auto merge is not allowed for this repository',
			mergedOnView: Number.MAX_SAFE_INTEGER,
			openMergeState: 'CLEAN',
			statusCheckRollups: [
				[{ name: 'verify', status: 'IN_PROGRESS', conclusion: null }],
				[{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
			],
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.armAttempts).toBe(1);
		expect(repo.directMergeAttempts).toBe(1);
		expect(events).toContain('ship.direct-merge-fallback');
		const direct = findCall(calls, 'gh', 'pr', 'merge').find((call) => !call.args.includes('--auto'));
		expect(direct?.args).toEqual(['pr', 'merge', '385', '--squash', '--match-head-commit', HEAD_SHA]);
		expect(direct?.args).not.toContain('--admin');
	});

	test('requests a direct merge for a clean PR even while auto-merge remains armed', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			mergedOnView: Number.MAX_SAFE_INTEGER,
			openMergeState: 'CLEAN',
			statusCheckRollups: [[{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }]],
			directMergeUnavailableRemaining: 2,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipped = await new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			unavailableRetryDelaysMs: [0, 0, 0],
		}).ship(createShipInput(cwd, events, new AbortController().signal, payloads));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.armAttempts).toBe(1);
		expect(repo.directMergeAttempts).toBe(3);
		expect(events.filter((kind) => kind === 'ship.github-unavailable')).toHaveLength(2);
		expect(payloads.get('ship.direct-merge-requested')).toEqual({
			prNumber: 385,
			headSha: HEAD_SHA,
			reason: 'auto-merge-stalled',
		});
		const direct = findCall(calls, 'gh', 'pr', 'merge').find((call) => !call.args.includes('--auto'));
		expect(direct?.args).toEqual(['pr', 'merge', '385', '--squash', '--match-head-commit', HEAD_SHA]);
		expect(direct?.args).not.toContain('--admin');
	});

	test('records auto-merge-unavailable when a clean PR needs the direct merge recovery', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			armDecisionFailure: 'GraphQL: Pull request Auto merge is not allowed for this repository',
			mergedOnView: Number.MAX_SAFE_INTEGER,
			openMergeState: 'CLEAN',
		});
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, []), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, [], new AbortController().signal, payloads));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(payloads.get('ship.direct-merge-requested')).toEqual({
			prNumber: 385,
			headSha: HEAD_SHA,
			reason: 'auto-merge-unavailable',
		});
	});

	test('fails closed when GitHub refuses the direct merge', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			mergedOnView: Number.MAX_SAFE_INTEGER,
			openMergeState: 'CLEAN',
			directMergeDecisionFailure: 'GraphQL: merge queue is required',
		});
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, []), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, [], new AbortController().signal));

		expect(shipped).toEqual({
			outcome: 'failed',
			detail: 'gh pr merge failed: GraphQL: merge queue is required',
		});
		expect(repo.directMergeAttempts).toBe(1);
	});

	test('never directly merges a non-clean, non-open, unverified, or unfinished PR', async () => {
		const scenarios: Array<{
			name: string;
			repo: Partial<FakeRepo>;
			options?: { maxBranchUpdates?: number };
		}> = [
			{ name: 'BLOCKED', repo: { openMergeState: 'BLOCKED' } },
			{ name: 'BEHIND', repo: { behindWhileUpdatesBelow: Number.MAX_SAFE_INTEGER }, options: { maxBranchUpdates: 0 } },
			{ name: 'DIRTY', repo: { openMergeState: 'DIRTY' } },
			{ name: 'UNKNOWN', repo: { openMergeState: 'UNKNOWN' } },
			{
				name: 'CI pending',
				repo: {
					openMergeState: 'CLEAN',
					statusCheckRollups: [[{ name: 'verify', status: 'IN_PROGRESS', conclusion: null }]],
				},
			},
			{
				name: 'CI failed',
				repo: {
					openMergeState: 'CLEAN',
					statusCheckRollups: [[{ name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }]],
				},
			},
			{ name: 'head divergente', repo: { openMergeState: 'CLEAN', headMovedOnView: 1 } },
		];

		for (const scenario of scenarios) {
			const cwd = createWorkspace();
			const repo = createRepo({ mergedOnView: Number.MAX_SAFE_INTEGER, ...scenario.repo });
			const shipped = await new GithubShipper({
				runCommand: createRunner(repo, []),
				pollIntervalMs: 0,
				mergeTimeoutMs: 0,
				...scenario.options,
			}).ship(createShipInput(cwd, [], new AbortController().signal));

			expect(shipped.outcome, scenario.name).not.toBe('merged');
			expect(repo.directMergeAttempts, scenario.name).toBe(0);
		}
	});

	test('direct fallback merges a clean PR with no reported checks and preserves branch deletion', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			armDecisionFailure: 'GraphQL: Pull request Auto merge is not allowed for this repository',
			mergedOnView: Number.MAX_SAFE_INTEGER,
			openMergeState: 'CLEAN',
		});
		const calls: RecordedCall[] = [];
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 })
			.mergePullRequest({
				runId: 'intake-CAM-579',
				evidence: { workflowRevision: 'intake', review: 'not-applicable', fullVerification: 'not-applicable' },
				cwd, issueId: 'CAM-579', title: 'intake control', branch: 'gship/intake/cam-579',
				headSha: HEAD_SHA, verificationCommands: ['true'], signal: new AbortController().signal,
				emit: () => {}, initialCiStatus: 'not-reported', deleteBranch: true,
			});

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		const direct = findCall(calls, 'gh', 'pr', 'merge').find((call) => !call.args.includes('--auto'));
		expect(direct?.args).toContain('--delete-branch');
	});

	test('direct fallback refuses a diverged head before requesting a merge', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			armDecisionFailure: 'GraphQL: Pull request Auto merge is not allowed for this repository',
			openMergeState: 'CLEAN',
			headMovedOnView: 1,
		});
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, []), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, [], new AbortController().signal));

		expect(shipped).toMatchObject({ outcome: 'failed' });
		expect(repo.directMergeAttempts).toBe(0);
		expect(repo.disarms).toBe(1);
	});

	test('direct fallback never merges while a reported required check has failed', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			armDecisionFailure: 'GraphQL: Pull request Auto merge is not allowed for this repository',
			mergedOnView: Number.MAX_SAFE_INTEGER,
			statusCheckRollups: [[{ name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }]],
			requiredChecks: [{ name: 'verify', bucket: 'fail' }],
		});
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, []), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, [], new AbortController().signal));

		expect(shipped).toMatchObject({ outcome: 'ci-failed' });
		expect(repo.directMergeAttempts).toBe(0);
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

	test('a pull request closed without merging fails instead of reopening one, and disarms a leftover auto-merge (GSHIP-641)', async () => {
		const cwd = createWorkspace();
		// The pull request is already closed before this ship even lists it —
		// exactly the shape a previous ship attempt's arming would survive in,
		// since a closed pull request never reaches this ship's own arm call.
		const repo = createRepo({ prNumber: 385, prState: 'CLOSED' });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal),
		);

		expect(failed).toEqual({
			outcome: 'failed',
			detail: 'pull request #385 was closed without merging',
		});
		expect(repo.prCreates).toBe(0);
		// This ship never arms auto-merge itself, but a stale arming from an
		// earlier attempt is taken down anyway, so a later reopen cannot let
		// GitHub merge it with nobody watching.
		expect(armCalls(calls)).toHaveLength(0);
		expect(disarmCalls(calls)[0]?.args).toEqual(['pr', 'merge', '385', '--disable-auto']);
		expect(repo.disarms).toBe(1);
		expect(events.at(-1)).toBe('ship.automerge-disarmed');
	});

	test('a pull request closed without merging while the monitor is watching disarms the arming this ship placed (GSHIP-641)', async () => {
		const cwd = createWorkspace();
		// Unlike the case above, this ship arms auto-merge itself and then, while
		// polling, sees the pull request close instead of merge.
		const repo = createRepo({ mergedOnView: Number.MAX_SAFE_INTEGER, closedOnView: 2 });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal),
		);

		expect(failed).toEqual({
			outcome: 'failed',
			detail: 'pull request #385 was closed without merging',
		});
		expect(repo.views).toBe(2);
		expect(armCalls(calls)).toHaveLength(1);
		expect(disarmCalls(calls)[0]?.args).toEqual(['pr', 'merge', '385', '--disable-auto']);
		expect(repo.disarms).toBe(1);
		expect(events.at(-1)).toBe('ship.automerge-disarmed');
		expect(events).not.toContain('ship.merged');
	});

	test('a disarm GitHub refuses after a pull request closed without merging still reports that as the reason (GSHIP-641)', async () => {
		const cwd = createWorkspace();
		// `--disable-auto` fails — nothing armed, a flaky API, an expired login.
		// The ship still reports the closed pull request as the reason: the
		// take-down is a precaution, never the reason the ship failed.
		const repo = createRepo({ prNumber: 385, prState: 'CLOSED', disarmFails: true });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(failed).toEqual({
			outcome: 'failed',
			detail: 'pull request #385 was closed without merging',
		});
		expect(repo.disarms).toBe(1);
		expect(events.at(-1)).toBe('ship.automerge-disarmed');
		expect(payloads.get('ship.automerge-disarmed')).toEqual({
			prNumber: 385,
			disarmed: false,
			detail: 'failed to disable auto-merge: not enabled',
		});
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
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail).toContain(FOREIGN_SHA);
		expect((failed as { detail: string }).detail).toContain('moved outside the service');
		// The monitor stops on the poll that saw the foreign head.
		expect(repo.views).toBe(2);
		expect(events).not.toContain('ship.merged');
		// GSHIP-625: a divergent head is a successful read, not a GitHub outage,
		// so it still fails on the spot with no retry loop involved.
		expect(events).not.toContain('ship.github-unavailable');
		// GSHIP-616: the arming this ship left on the pull request is taken down
		// before the failure is reported, so GitHub cannot land the refused head
		// once nobody is watching any more.
		expect(disarmCalls(calls)[0]?.args).toEqual(['pr', 'merge', '385', '--disable-auto']);
		expect(events.slice(-2)).toEqual(['ship.automerge-disarmed', 'ship.head-diverged']);
		expect(payloads.get('ship.automerge-disarmed')).toEqual({ prNumber: 385, disarmed: true });
		// Nothing is merged, nothing is re-armed, and origin/main is left alone.
		expect(armCalls(calls)).toHaveLength(1);
		expect(repo.fetches).toBe(0);
	});

	test('a disarm GitHub refuses still reports the divergence as the reason', async () => {
		const cwd = createWorkspace();
		// GSHIP-616: `--disable-auto` fails — nothing armed, a flaky API, an
		// expired login. The ship reports the head it refused all the same: the
		// take-down is a precaution, never the reason the ship failed.
		const repo = createRepo({
			mergedOnView: Number.MAX_SAFE_INTEGER,
			headMovedOnView: 1,
			disarmFails: true,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail)
			.toContain(`now carries ${FOREIGN_SHA}, not the head ${HEAD_SHA}`);
		expect((failed as { detail: string }).detail).not.toContain('disable auto-merge');
		expect(repo.disarms).toBe(1);
		// The refused take-down is still recorded, so the run history says the
		// arming may have survived the divergence.
		expect(events.slice(-2)).toEqual(['ship.automerge-disarmed', 'ship.head-diverged']);
		expect(payloads.get('ship.automerge-disarmed')).toEqual({
			prNumber: 385,
			disarmed: false,
			detail: 'failed to disable auto-merge: not enabled',
		});
		expect(armCalls(calls)).toHaveLength(1);
		expect(repo.fetches).toBe(0);
	});

	test('a merge that landed a foreign head is reported as a failure, never as merged', async () => {
		const cwd = createWorkspace();
		// The force-push wins the race and GitHub merges the head it left, so the
		// divergence surfaces on the same poll that reports MERGED.
		const repo = createRepo({ mergedOnView: 1, headMovedOnView: 1 });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toMatchObject({ outcome: 'failed' });
		expect((failed as { detail: string }).detail)
			.toContain(`merged ${FOREIGN_SHA}, not the head ${HEAD_SHA}`);
		expect((failed as { detail: string }).detail).toContain('never verified');
		expect(events).not.toContain('ship.merged');
		expect(events).not.toContain('ship.source-synced');
		// GSHIP-616: the arming goes down here too. GitHub reporting the merge is
		// a head behind the branch often enough that leaving it armed would keep
		// the window open on whatever the force-push pushes next.
		expect(repo.disarms).toBe(1);
		expect(events.slice(-2)).toEqual(['ship.automerge-disarmed', 'ship.head-diverged']);
		expect(armCalls(calls)).toHaveLength(1);
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
		// GSHIP-616: nothing is disarmed on the way to a merge of our own head —
		// the arming is what lands it.
		expect(events).not.toContain('ship.automerge-disarmed');
		expect(disarmCalls(calls)).toHaveLength(0);
		expect(repo.disarms).toBe(0);
		// Every poll reads the head, not only the merge state.
		const views = findCall(calls, 'gh', 'pr', 'view');
		expect(views).toHaveLength(3);
		for (const view of views) {
			expect(view.args).toContain('state,mergeStateStatus,headRefOid,url,statusCheckRollup');
		}
	});

	test('a required check completed in failure ends the ship immediately, naming it (GSHIP-646)', async () => {
		// The evidence: on the GSHIP-639 run, CI failed, the pull request went
		// BLOCKED, and the shipper kept polling — left alone it would have spent
		// the whole hour-long timeout to fail. This must end on the first poll.
		const cwd = createWorkspace();
		const repo = createRepo({
			mergedOnView: Number.MAX_SAFE_INTEGER,
			requiredChecks: [{ name: 'ci/build', bucket: 'fail', link: 'https://github.com/acme/repo/actions/runs/7' }],
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(failed).toEqual({
			outcome: 'ci-failed',
			evidence: {
				prNumber: 385,
				headSha: HEAD_SHA,
				check: { name: 'ci/build', url: 'https://github.com/acme/repo/actions/runs/7' },
			},
		});
		if (failed.outcome !== 'ci-failed') throw new Error('expected a typed CI failure');
		expect(failed.evidence).not.toHaveProperty('logExcerpt');
		// Ends on the very first poll, not after waiting out the merge timeout.
		expect(repo.views).toBe(1);
		expect(repo.requiredChecksCalls).toBe(1);
		// GSHIP-616: the arming this ship placed comes down before the failure
		// is reported, the same as every other non-merge ending.
		expect(disarmCalls(calls)[0]?.args).toEqual(['pr', 'merge', '385', '--disable-auto']);
		expect(repo.disarms).toBe(1);
		expect(events.slice(-2)).toEqual(['ship.automerge-disarmed', 'ship.required-check-failed']);
		const failedPayload = payloads.get('ship.required-check-failed');
		expect(failedPayload).toEqual({
			prNumber: 385,
			headSha: HEAD_SHA,
			check: { name: 'ci/build', url: 'https://github.com/acme/repo/actions/runs/7' },
		});
		expect(failedPayload).not.toHaveProperty('logExcerpt');
		expect(calls).not.toContainEqual(expect.objectContaining({ command: 'gh', args: expect.arrayContaining(['run']) }));
		expect(events).not.toContain('ship.merged');
		expect(armCalls(calls)).toHaveLength(1);
	});

	test('a required check still running leaves the monitor waiting instead of ending the ship (GSHIP-646)', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			mergedOnView: 3,
			requiredChecks: [{ name: 'ci/build', bucket: 'pending' }],
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.requiredChecksCalls).toBe(2);
		expect(events).not.toContain('ship.required-check-failed');
		expect(events).not.toContain('ship.automerge-disarmed');
		expect(disarmCalls(calls)).toHaveLength(0);
		expect(events.slice(-2)).toEqual(['ship.source-synced', 'ship.merged']);
	});

	test('GitHub staying unavailable while reading required checks repeats instead of failing the ship (GSHIP-646)', async () => {
		const cwd = createWorkspace();
		// The pull request stays BLOCKED for two polls with `gh pr checks`
		// always reporting HTTP 503, then GitHub reports the merge on the third
		// — the outage must never turn into a ship failure of its own.
		const repo = createRepo({
			mergedOnView: 3,
			requiredChecksUnavailableRemaining: Number.MAX_SAFE_INTEGER,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			unavailableRetryDelaysMs: [0, 0, 0],
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		// One initial attempt plus three retries, on each of the two BLOCKED polls.
		expect(repo.requiredChecksCalls).toBe(8);
		expect(events.filter((kind) => kind === 'ship.github-unavailable')).toHaveLength(6);
		expect(events).not.toContain('ship.required-check-failed');
		expect(events).not.toContain('ship.merge-unconfirmed');
		expect(disarmCalls(calls)).toHaveLength(0);
	});

	test('a pull request BEHIND is updated by the service and still merges (GSHIP-632)', async () => {
		// The monitor finds BEHIND on the head it just pushed — main advanced
		// while this ship waited, not a divergence and not GitHub being
		// unavailable — updates the branch itself, and the very next poll
		// already reports the merge of the updated head.
		const cwd = createWorkspace();
		const repo = createRepo({ behindWhileUpdatesBelow: 1, mergedOnView: 3 });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const shipped = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.branchUpdates).toBe(1);
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(1);
		expect(events).toEqual([
			'ship.issue-closed',
			'ship.committed',
			'ship.pushed',
			'ship.pr-opened',
			'ship.automerge-armed',
			'ship.branch-updated',
			'ship.source-synced',
			'ship.merged',
		]);
		// The new head is registered as the head this ship published, with the
		// previous head kept for the run history (GSHIP-632).
		expect(payloads.get('ship.branch-updated')).toEqual({
			prNumber: 385,
			previousHead: HEAD_SHA,
			headSha: UPDATED_SHAS[0],
		});
		// No re-arm, and no disarm: BEHIND is neither a divergence nor a refusal.
		expect(armCalls(calls)).toHaveLength(1);
		expect(disarmCalls(calls)).toHaveLength(0);
		expect(events).not.toContain('ship.head-diverged');
		// The run's own worktree is synced to the head GitHub just recorded, or
		// this ship's next push would be rejected as non-fast-forward and every
		// later head comparison would read against a stale local HEAD.
		expect(findCall(calls, 'git', 'fetch')).toContainEqual({
			command: 'git',
			args: ['fetch', 'origin', BRANCH],
		});
		expect(findCall(calls, 'git', 'reset')[0]?.args).toEqual(['reset', '--hard', UPDATED_SHAS[0] as string]);
	});

	test('an auto-merge that lands after CI passes but before update-branch ships once (GSHIP-769)', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: 2,
			statusCheckRollups: [[{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }]],
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(0);
		expect(events.filter((kind) => kind === 'ship.source-synced')).toHaveLength(1);
		expect(events.filter((kind) => kind === 'ship.merged')).toHaveLength(1);
	});

	test('a missing-head update refusal stays failed while the same PR remains open (GSHIP-769)', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: Number.MAX_SAFE_INTEGER,
			updateBranchFailure: 'GraphQL: Head ref does not exist (updatePullRequestBranch)',
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const failed = await new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toEqual({
			outcome: 'failed',
			detail: 'gh pr update-branch failed: GraphQL: Head ref does not exist (updatePullRequestBranch)',
		});
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(1);
		expect(events).not.toContain('ship.source-synced');
		expect(events).not.toContain('ship.merged');
	});

	test('a missing-head update refusal completes when auto-merge already landed the expected head (GSHIP-769)', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: Number.MAX_SAFE_INTEGER,
			updateBranchFailure: 'GraphQL: Head ref does not exist (updatePullRequestBranch)',
			mergeOnUpdateBranchFailure: true,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipped = await new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(1);
		expect(events.filter((kind) => kind === 'ship.source-synced')).toHaveLength(1);
		expect(events.filter((kind) => kind === 'ship.merged')).toHaveLength(1);
	});

	test('a PR closed without merge before update-branch keeps the safe refusal (GSHIP-769)', async () => {
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			closedOnView: 2,
			mergedOnView: Number.MAX_SAFE_INTEGER,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const failed = await new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 })
			.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toEqual({ outcome: 'failed', detail: 'pull request #385 was closed without merging' });
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(0);
		expect(disarmCalls(calls)).toHaveLength(1);
		expect(events).not.toContain('ship.source-synced');
	});

	test('repeating a ship after the branch was merged only resynchronizes its source (GSHIP-769)', async () => {
		const cwd = createWorkspace();
		const repo = createRepo();
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 });
		const firstEvents: string[] = [];
		expect(await shipper.ship(createShipInput(cwd, firstEvents, new AbortController().signal)))
			.toEqual({ outcome: 'merged', prNumber: 385 });
		const repeatedEvents: string[] = [];
		expect(await shipper.ship(createShipInput(cwd, repeatedEvents, new AbortController().signal)))
			.toEqual({ outcome: 'merged', prNumber: 385 });

		expect(repeatedEvents).toEqual(['ship.pushed', 'ship.pr-reused', 'ship.source-synced', 'ship.merged']);
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(0);
		expect(repo.prCreates).toBe(1);
	});

	test('GitHub staying unavailable while confirming a branch update ends the ship as unconfirmed, not failed (GSHIP-632)', async () => {
		// The first poll reports BEHIND and `gh pr update-branch` succeeds, but
		// the follow-up read that would tell this ship what head resulted keeps
		// failing. The same GSHIP-625 confusion applies here: GitHub may already
		// have updated (or even merged) the branch and simply could not be
		// asked, which is not the same thing as the update having failed.
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: 3,
			viewUnavailableFromView: 3,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			unavailableRetryDelaysMs: [0, 0, 0],
		});

		const failed = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toMatchObject({ outcome: 'failed' });
		const detail = (failed as { detail: string }).detail;
		expect(detail).toContain('could not be confirmed');
		expect(detail).toContain('not a merge failure');
		expect(events.at(-1)).toBe('ship.merge-unconfirmed');
		expect(events).not.toContain('ship.branch-updated');
		// `gh pr update-branch` itself succeeded; only the follow-up read failed.
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(1);
		// Without a confirmed new head, the worktree is never reset.
		expect(findCall(calls, 'git', 'reset')).toHaveLength(0);
	});

	test('a head this ship updated to clear BEHIND is not read as a divergence across later polls (GSHIP-632)', async () => {
		const cwd = createWorkspace();
		// The merge lands a few polls after the update, so the updated head has
		// to survive more than one divergence check before GitHub reports MERGED.
		const repo = createRepo({ behindWhileUpdatesBelow: 1, mergedOnView: 4 });
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const shipped = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(events).not.toContain('ship.head-diverged');
		expect(events).not.toContain('ship.automerge-disarmed');
		expect(events.slice(-3)).toEqual(['ship.branch-updated', 'ship.source-synced', 'ship.merged']);
		expect(disarmCalls(calls)).toHaveLength(0);
	});

	test('a head moved outside the service after a service branch update still fails with a disarm (GSHIP-632)', async () => {
		// GSHIP-615's guard still has to tell the service's own update apart
		// from someone else's force-push, using the updated head as the new
		// baseline rather than the head this ship originally pushed.
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			headMovedOnView: 4,
			mergedOnView: Number.MAX_SAFE_INTEGER,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
		});

		const failed = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toMatchObject({ outcome: 'failed' });
		const detail = (failed as { detail: string }).detail;
		expect(detail).toContain(FOREIGN_SHA);
		expect(detail).toContain(`not the head ${UPDATED_SHAS[0]}`);
		expect(detail).not.toContain(`not the head ${HEAD_SHA}`);
		expect(detail).toContain('moved outside the service');
		expect(repo.branchUpdates).toBe(1);
		expect(disarmCalls(calls)).toHaveLength(1);
		expect(events.slice(-2)).toEqual(['ship.automerge-disarmed', 'ship.head-diverged']);
		expect(armCalls(calls)).toHaveLength(1);
	});

	test('exhausting the branch-update limit ends the ship with an explicit reason (GSHIP-632)', async () => {
		// A main that never stops advancing must not turn this recovery into an
		// infinite loop: BEHIND stays BEHIND no matter how many times the
		// service updates the branch, so the fixed cap has to end the ship.
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: Number.MAX_SAFE_INTEGER,
			mergedOnView: Number.MAX_SAFE_INTEGER,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			maxBranchUpdates: 2,
		});

		const failed = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toMatchObject({ outcome: 'failed' });
		const detail = (failed as { detail: string }).detail;
		expect(detail).toContain('BEHIND');
		expect(detail).toContain('2 branch updates');
		expect(repo.branchUpdates).toBe(2);
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(2);
		expect(events.filter((kind) => kind === 'ship.branch-updated')).toHaveLength(2);
		// Giving up on BEHIND is not a divergence: nothing is disarmed.
		expect(disarmCalls(calls)).toHaveLength(0);
		expect(armCalls(calls)).toHaveLength(1);
	});

	test('a branch update whose head only becomes visible after rereads registers the confirmed head, not a stale one (GSHIP-656)', async () => {
		// `gh pr update-branch` returns as soon as GitHub accepts the request;
		// the real evidence for GSHIP-656 was a `gh pr view` fired immediately
		// after that still returned the head this ship had already published.
		// Here the new head only becomes visible on the third reread, and the
		// confirm loop has to wait for it — the previous head must never be
		// registered as though it were the result of the update.
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: 5,
			branchUpdateDelayViews: 2,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			branchUpdateConfirmAttempts: 5,
			branchUpdateConfirmDelayMs: 0,
		});

		const shipped = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.branchUpdates).toBe(1);
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(1);
		// Two stale rereads (still the previous head, still BEHIND) before the
		// third confirms the new one.
		expect(findCall(calls, 'gh', 'pr', 'view')).toHaveLength(6);
		expect(payloads.get('ship.branch-updated')).toEqual({
			prNumber: 385,
			previousHead: HEAD_SHA,
			headSha: UPDATED_SHAS[0],
		});
		expect(events).toEqual([
			'ship.issue-closed',
			'ship.committed',
			'ship.pushed',
			'ship.pr-opened',
			'ship.automerge-armed',
			'ship.branch-updated',
			'ship.source-synced',
			'ship.merged',
		]);
		expect(events).not.toContain('ship.head-diverged');
		expect(events).not.toContain('ship.branch-update-stalled');
		expect(findCall(calls, 'git', 'reset')[0]?.args).toEqual(['reset', '--hard', UPDATED_SHAS[0] as string]);
	});

	test('a pull request that stops reporting BEHIND before its head changes is not read as confirmation (GSHIP-656)', async () => {
		// Real GitHub invalidates and recomputes mergeability the moment
		// `update-branch` is requested and reports UNKNOWN while it does, so a
		// reread fired in that window can already read as "not BEHIND" while the
		// head has not moved at all. Trusting that alone reproduces the
		// GSHIP-656 bug exactly: it would register the head this ship already
		// published as though it were the update's result. The confirm loop
		// must keep rereading through that window and only accept the head once
		// it actually changes.
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: 5,
			branchUpdateDelayViews: 2,
			mergeStateWhilePending: 'UNKNOWN',
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			branchUpdateConfirmAttempts: 5,
			branchUpdateConfirmDelayMs: 0,
		});

		const shipped = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.branchUpdates).toBe(1);
		// Two rereads see the previous head under a non-BEHIND status (UNKNOWN)
		// before the third confirms the new head — a buggy confirm loop would
		// have stopped, and registered, on the very first of these.
		expect(findCall(calls, 'gh', 'pr', 'view')).toHaveLength(6);
		expect(payloads.get('ship.branch-updated')).toEqual({
			prNumber: 385,
			previousHead: HEAD_SHA,
			headSha: UPDATED_SHAS[0],
		});
		expect(events).not.toContain('ship.head-diverged');
		expect(events).not.toContain('ship.branch-update-stalled');
	});

	test('exhausting the branch-update confirmation attempts without a change ends the ship with its own reason, not a registered head (GSHIP-656)', async () => {
		// The update never visibly lands within the attempts this ship allots:
		// the head this ship still recognises as published must stay exactly
		// what it was, and the ship must end with a reason of its own instead
		// of registering the still-unconfirmed, stale head.
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: Number.MAX_SAFE_INTEGER,
			branchUpdateDelayViews: 1000,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const payloads = new Map<string, Record<string, unknown> | undefined>();
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			branchUpdateConfirmAttempts: 3,
			branchUpdateConfirmDelayMs: 0,
		});

		const failed = await shipper.ship(
			createShipInput(cwd, events, new AbortController().signal, payloads),
		);

		expect(failed).toMatchObject({ outcome: 'failed' });
		const detail = (failed as { detail: string }).detail;
		expect(detail).toContain('branch update did not complete');
		expect(detail).toContain(HEAD_SHA);
		expect(events.at(-1)).toBe('ship.branch-update-stalled');
		expect(payloads.get('ship.branch-update-stalled')).toMatchObject({
			prNumber: 385,
			headSha: HEAD_SHA,
		});
		expect(events).not.toContain('ship.branch-updated');
		expect(events).not.toContain('ship.head-diverged');
		// `gh pr update-branch` itself succeeded and is not retried: only its
		// unconfirmed result ends the ship.
		expect(findCall(calls, 'gh', 'pr', 'update-branch')).toHaveLength(1);
		// One read right after the update, plus the confirmation attempts.
		expect(findCall(calls, 'gh', 'pr', 'view')).toHaveLength(5);
		// Without a confirmed new head, the worktree is never synced, and
		// nothing this ship never confirmed producing gets disarmed either —
		// same as GSHIP-625's unconfirmed ending, a retry may find it landed.
		expect(findCall(calls, 'git', 'reset')).toHaveLength(0);
		expect(disarmCalls(calls)).toHaveLength(0);
		expect(armCalls(calls)).toHaveLength(1);
	});

	test('a head moved outside the service right after a delayed branch-update confirmation still fails with a disarm (GSHIP-656)', async () => {
		// GSHIP-615's guard must keep refusing a head this ship did not confirm
		// producing itself, even once confirming its own update takes more than
		// one reread: the baseline for the next poll is the head this ship
		// actually confirmed, not the one it started with.
		const cwd = createWorkspace();
		const repo = createRepo({
			behindWhileUpdatesBelow: 1,
			mergedOnView: Number.MAX_SAFE_INTEGER,
			branchUpdateDelayViews: 1,
			headMovedOnView: 5,
		});
		const calls: RecordedCall[] = [];
		const events: string[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			branchUpdateConfirmAttempts: 5,
			branchUpdateConfirmDelayMs: 0,
		});

		const failed = await shipper.ship(createShipInput(cwd, events, new AbortController().signal));

		expect(failed).toMatchObject({ outcome: 'failed' });
		const detail = (failed as { detail: string }).detail;
		expect(detail).toContain(FOREIGN_SHA);
		expect(detail).toContain(`not the head ${UPDATED_SHAS[0]}`);
		expect(detail).not.toContain(`not the head ${HEAD_SHA}`);
		expect(detail).toContain('moved outside the service');
		expect(repo.branchUpdates).toBe(1);
		expect(disarmCalls(calls)).toHaveLength(1);
		expect(events.slice(-2)).toEqual(['ship.automerge-disarmed', 'ship.head-diverged']);
		expect(armCalls(calls)).toHaveLength(1);
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

// A fresh container's volume has no git author identity until something
// derives one; the ship's own commit is one of the two paths that must
// derive it themselves, right on the commit path, before their own first
// write -- never by depending on the operator-facing snapshot in
// src/commands/web.ts having been read first (the other path is issue
// intake, covered in issue-intake.test.ts) (GSHIP-654).
describe('git author identity on the ship commit path (GSHIP-654)', () => {
	test('a missing identity fails the ship before the commit, and no commit is ever attempted', async () => {
		const cwd = createWorkspace();
		const repo = createRepo();
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			ensureIdentity: () => ({ outcome: 'missing', detail: 'gh is not authenticated yet (fixture)' }),
		});

		const shipped = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(shipped).toMatchObject({ outcome: 'failed' });
		expect((shipped as { detail: string }).detail).toContain('gh is not authenticated yet (fixture)');
		expect(repo.commits).toBe(0);
		expect(findCall(calls, 'git', 'commit')).toHaveLength(0);
		// The run's diff survives a missing identity: `git add --all` already
		// staged it, and nothing here discards a worktree over a retryable gap.
		expect(findCall(calls, 'git', 'add')).toHaveLength(1);
	});

	test('an identity ensureIdentity reports as already there lets the commit proceed, called exactly once', async () => {
		const cwd = createWorkspace();
		const repo = createRepo();
		const calls: RecordedCall[] = [];
		let ensureIdentityCalls = 0;
		const shipper = new GithubShipper({
			runCommand: createRunner(repo, calls),
			pollIntervalMs: 0,
			ensureIdentity: () => {
				ensureIdentityCalls += 1;
				return { outcome: 'already-configured' };
			},
		});

		const shipped = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.commits).toBe(1);
		expect(ensureIdentityCalls).toBe(1);
	});

	test('without an injected ensureIdentity, the ship commits exactly as it did before this option existed', async () => {
		const cwd = createWorkspace();
		const repo = createRepo();
		const calls: RecordedCall[] = [];
		const shipper = new GithubShipper({ runCommand: createRunner(repo, calls), pollIntervalMs: 0 });

		const shipped = await shipper.ship(
			createShipInput(cwd, [], new AbortController().signal),
		);

		expect(shipped).toEqual({ outcome: 'merged', prNumber: 385 });
		expect(repo.commits).toBe(1);
	});
});
