// test/release/post-merge.test.ts
//
// Unit tests for runPostMerge() in src/release/post-merge.ts.
// All git calls go through a fake SpawnFn; no real git binary, no real FS.
//
// Coverage:
//   (a) Happy path: pull succeeds, tag is new, branch pruned local+remote.
//   (b) Pull failure: returns ok:false, reason:'pull-failed'.
//   (c) Version-file read failure: returns ok:false, reason:'version-file-read-failed'.
//   (d) Version-parse failure: returns ok:false, reason:'version-parse-failed'.
//   (e) Tag create failure: returns ok:false, reason:'tag-create-failed'.
//   (f) Tag push failure: returns ok:false, reason:'tag-push-failed'.
//   (g) Idempotent tag: tag already exists -> no-op, ok:true, tagCreated:false.
//   (h) Branch prune best-effort: branch delete fails but result is still ok:true.
//   (i) Structured result fields: pulledSha, tag, tagCreated, branchPrunedLocal, branchPrunedRemote.
//   (j) Tag step reads version from injected file (not CAM_VERSION constant).
//
// US-006 (CAM-101).

import { describe, test, expect } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	runPostMerge,
	type PostMergeOptions,
	type SpawnFn,
} from '../../src/release/post-merge.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeSpawn(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [],
		stdout: '',
		stderr: '',
		status: 0,
		signal: null,
		error: undefined,
		...overrides,
	};
}

type SpawnCall = { cmd: string; args: string[] };

const FAKE_VERSION = '1.2.3';
const FAKE_TAG = `v${FAKE_VERSION}`;
const FAKE_VERSION_CONTENT = `export const CAM_VERSION = '${FAKE_VERSION}';\n`;
const FAKE_SHA = 'abc1234def5678';
const FAKE_BRANCH = 'cam/test-feature-branch';
const FAKE_CWD = '/tmp/testproject';

/**
 * Build a SpawnFn that records every call and delegates to a per-subcommand map.
 * Anything not in the map returns fakeSpawn() (exit 0).
 */
function makeSpawnFn(
	responses: Record<string, SpawnSyncReturns<string>>,
	calls?: SpawnCall[],
): SpawnFn {
	return (cmd, args, _opts) => {
		if (calls) calls.push({ cmd, args: [...args] });
		// Match by the subcommand (the arg after any -C flags)
		const subcommand = args[0] === '-C' ? args[2] : args[0];
		const key = `${cmd} ${args.join(' ')}`;
		return responses[key] ?? responses[subcommand ?? ''] ?? fakeSpawn();
	};
}

/**
 * Options for happySpawn.
 *
 * US-001 adds ls-remote modelling so the fakes genuinely represent the
 * end-state classification path (not just the old exit-code path).
 *
 * Defaults produce the "already pruned" scenario:
 *   lsRemotePreStatus = 0, lsRemotePreEmpty = true
 * => pre-check reports branch absent => branchPrunedRemote = true without
 *    any push --delete call.
 */
interface HappySpawnOpts {
	checkoutStatus?: number;
	tagListReturnsTag?: boolean;
	tagCreateStatus?: number;
	tagPushStatus?: number;
	/**
	 * Exit status for `git branch -D <branch>` (US-002: force delete).
	 * Only relevant when revParseLocalPreStatus is 0 (branch present).
	 */
	branchDeleteLocalStatus?: number;
	/** Only relevant when lsRemotePreEmpty is false (branch present path). */
	branchDeleteRemoteStatus?: number;
	/** Exit status returned by the ls-remote PRE-check (default 0 = success). */
	lsRemotePreStatus?: number;
	/**
	 * When lsRemotePreStatus === 0:
	 *   true (default) => empty stdout (branch absent => already pruned, no delete).
	 *   false => non-empty stdout (branch present => delete + post-check).
	 */
	lsRemotePreEmpty?: boolean;
	/** Exit status returned by the ls-remote POST-delete check (default 0). */
	lsRemotePostStatus?: number;
	/**
	 * When lsRemotePostStatus === 0:
	 *   true (default) => empty stdout (branch absent after delete => pruned).
	 *   false => non-empty stdout (branch still present => not pruned).
	 */
	lsRemotePostEmpty?: boolean;
	/**
	 * Exit status for the rev-parse --verify --quiet refs/heads/<branch> PRE-check
	 * (US-002 local end-state classification).
	 * Default 128 = branch absent => already pruned, no -D delete needed.
	 * 0 = branch present => proceed to force-delete + post-check.
	 */
	revParseLocalPreStatus?: number;
	/**
	 * Exit status for the rev-parse --verify --quiet refs/heads/<branch> POST-check
	 * (US-002 local end-state classification).
	 * Default 128 = branch absent after delete => branchPrunedLocal:true.
	 * 0 = branch still present => branchPrunedLocal:false.
	 */
	revParseLocalPostStatus?: number;
}

/** Build a standard happy-path SpawnFn. Caller provides per-command overrides. */
function happySpawn(
	opts: HappySpawnOpts = {},
	calls?: SpawnCall[],
): SpawnFn {
	// Track ls-remote call count inside the closure so pre-check and post-check
	// can return different values (each happySpawn() call resets the counter).
	let lsRemoteCallCount = 0;
	// Track rev-parse --verify --quiet refs/heads/ call count (US-002 local end-state).
	let revParseLocalCallCount = 0;

	return (cmd, args, _o) => {
		if (calls) calls.push({ cmd, args: [...args] });

		// checkout main (Step 0)
		if (args.includes('checkout') && args.includes('main')) {
			return fakeSpawn({ status: opts.checkoutStatus ?? 0 });
		}
		// pull origin main
		if (args.includes('pull') && args.includes('origin') && args.includes('main')) {
			return fakeSpawn({ status: 0 });
		}
		// rev-parse HEAD (plain HEAD, not refs/heads)
		if (args.includes('rev-parse') && args.includes('HEAD') && !args.includes('--verify')) {
			return fakeSpawn({ stdout: `${FAKE_SHA}\n`, status: 0 });
		}
		// rev-parse --verify --quiet refs/heads/<branch> (US-002: local end-state classification)
		if (
			args.includes('rev-parse') &&
			args.includes('--verify') &&
			args.includes('--quiet') &&
			args.some((a) => a === `refs/heads/${FAKE_BRANCH}`)
		) {
			revParseLocalCallCount += 1;
			if (revParseLocalCallCount === 1) {
				// Pre-check: default 128 = absent (branch already pruned).
				const status = opts.revParseLocalPreStatus ?? 128;
				const stdout = status === 0 ? `${FAKE_SHA}\n` : '';
				return fakeSpawn({ status, stdout });
			}
			// Post-delete check: default 128 = absent (deleted successfully).
			const status = opts.revParseLocalPostStatus ?? 128;
			const stdout = status === 0 ? `${FAKE_SHA}\n` : '';
			return fakeSpawn({ status, stdout });
		}
		// tag -l <tag>
		if (args.includes('tag') && args.includes('-l') && args.includes(FAKE_TAG)) {
			return fakeSpawn({ stdout: opts.tagListReturnsTag ? `${FAKE_TAG}\n` : '', status: 0 });
		}
		// tag <tag> (create)
		if (args.includes('tag') && args.includes(FAKE_TAG) && !args.includes('-l')) {
			return fakeSpawn({ status: opts.tagCreateStatus ?? 0 });
		}
		// push origin <tag>
		if (args.includes('push') && args.includes('origin') && args.includes(FAKE_TAG)) {
			return fakeSpawn({ status: opts.tagPushStatus ?? 0 });
		}
		// branch -D <branch> (US-002: force delete)
		if (args.includes('branch') && args.includes('-D') && args.includes(FAKE_BRANCH)) {
			return fakeSpawn({ status: opts.branchDeleteLocalStatus ?? 0 });
		}
		// push origin --delete <branch>
		if (args.includes('push') && args.includes('--delete') && args.includes(FAKE_BRANCH)) {
			return fakeSpawn({ status: opts.branchDeleteRemoteStatus ?? 0 });
		}
		// ls-remote --heads origin <branch> (US-001: end-state classification)
		if (
			args.includes('ls-remote') &&
			args.includes('--heads') &&
			args.includes('origin') &&
			args.includes(FAKE_BRANCH)
		) {
			lsRemoteCallCount += 1;
			if (lsRemoteCallCount === 1) {
				// Pre-check
				const status = opts.lsRemotePreStatus ?? 0;
				const empty = opts.lsRemotePreEmpty !== false; // default true = absent
				const stdout =
					status === 0 && !empty ? `${FAKE_SHA}\trefs/heads/${FAKE_BRANCH}\n` : '';
				return fakeSpawn({ status, stdout });
			}
			// Post-delete check
			const status = opts.lsRemotePostStatus ?? 0;
			const empty = opts.lsRemotePostEmpty !== false; // default true = absent
			const stdout =
				status === 0 && !empty ? `${FAKE_SHA}\trefs/heads/${FAKE_BRANCH}\n` : '';
			return fakeSpawn({ status, stdout });
		}
		return fakeSpawn();
	};
}

function baseOpts(overrides: Partial<PostMergeOptions> = {}): PostMergeOptions {
	return {
		cwd: FAKE_CWD,
		mergedBranch: FAKE_BRANCH,
		spawnFn: happySpawn(),
		readVersionFile: () => FAKE_VERSION_CONTENT,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests: happy path
// ---------------------------------------------------------------------------

describe('runPostMerge -- happy path', () => {
	test('returns ok:true with all structured result fields', () => {
		const calls: SpawnCall[] = [];
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({}, calls) }),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.pulledSha).toBe(FAKE_SHA);
		expect(result.tag).toBe(FAKE_TAG);
		expect(result.tagCreated).toBe(true);
		expect(result.branchPrunedLocal).toBe(true);
		expect(result.branchPrunedRemote).toBe(true);
	});

	test('git checkout main is called before git pull', () => {
		const calls: SpawnCall[] = [];
		runPostMerge(baseOpts({ spawnFn: happySpawn({}, calls) }));

		const checkoutIdx = calls.findIndex(
			(c) => c.args.includes('checkout') && c.args.includes('main'),
		);
		expect(checkoutIdx).toBeGreaterThanOrEqual(0);

		const pullIdx = calls.findIndex(
			(c) => c.args.includes('pull') && c.args.includes('origin') && c.args.includes('main'),
		);
		expect(pullIdx).toBeGreaterThan(checkoutIdx);
	});

	test('git pull is called before tag operations', () => {
		const calls: SpawnCall[] = [];
		runPostMerge(baseOpts({ spawnFn: happySpawn({}, calls) }));

		const pullIdx = calls.findIndex(
			(c) => c.args.includes('pull') && c.args.includes('origin') && c.args.includes('main'),
		);
		expect(pullIdx).toBeGreaterThanOrEqual(0);
		// Pull must come before tag and branch operations
		const tagIdx = calls.findIndex((c) => c.args.includes('tag'));
		expect(pullIdx).toBeLessThan(tagIdx);
	});

	test('git tag create and push are called', () => {
		const calls: SpawnCall[] = [];
		runPostMerge(baseOpts({ spawnFn: happySpawn({}, calls) }));

		const createCall = calls.find(
			(c) => c.args.includes('tag') && c.args.includes(FAKE_TAG) && !c.args.includes('-l'),
		);
		expect(createCall).toBeDefined();

		const pushTagCall = calls.find(
			(c) => c.args.includes('push') && c.args.includes('origin') && c.args.includes(FAKE_TAG),
		);
		expect(pushTagCall).toBeDefined();
	});

	test('branch force-deleted locally (-D) and push --delete called when both branches are present', () => {
		const calls: SpawnCall[] = [];
		// revParseLocalPreStatus:0 => local branch present => -D is invoked.
		// lsRemotePreEmpty:false => remote branch present => push --delete is attempted.
		runPostMerge(baseOpts({
			spawnFn: happySpawn({ revParseLocalPreStatus: 0, lsRemotePreEmpty: false }, calls),
		}));

		// US-002: must use -D (force), not -d
		const localDelete = calls.find(
			(c) => c.args.includes('branch') && c.args.includes('-D') && c.args.includes(FAKE_BRANCH),
		);
		expect(localDelete).toBeDefined();

		const remoteDelete = calls.find(
			(c) =>
				c.args.includes('push') &&
				c.args.includes('--delete') &&
				c.args.includes(FAKE_BRANCH),
		);
		expect(remoteDelete).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: checkout-main failure (Step 0 guard)
// ---------------------------------------------------------------------------

describe('runPostMerge -- checkout-main failure', () => {
	test('returns ok:false reason:checkout-main-failed when checkout exits non-zero', () => {
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ checkoutStatus: 1 }) }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('checkout-main-failed');
		}
	});

	test('no pull or tag calls are made when checkout fails', () => {
		const calls: SpawnCall[] = [];
		runPostMerge(baseOpts({ spawnFn: happySpawn({ checkoutStatus: 128 }, calls) }));

		const pullCall = calls.find((c) => c.args.includes('pull'));
		expect(pullCall).toBeUndefined();

		const tagCall = calls.find((c) => c.args.includes('tag'));
		expect(tagCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: pull failure
// ---------------------------------------------------------------------------

describe('runPostMerge -- pull failure', () => {
	test('returns ok:false reason:pull-failed when pull exits non-zero', () => {
		const spawnFn: SpawnFn = (cmd, args, _o) => {
			if (args.includes('pull')) {
				return fakeSpawn({ status: 1, stderr: 'fatal: no remote configured\n' });
			}
			return fakeSpawn();
		};
		const result = runPostMerge(baseOpts({ spawnFn }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('pull-failed');
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: version-file errors
// ---------------------------------------------------------------------------

describe('runPostMerge -- version-file errors', () => {
	test('returns ok:false reason:version-file-read-failed when readVersionFile throws', () => {
		const result = runPostMerge(
			baseOpts({
				readVersionFile: () => { throw new Error('ENOENT'); },
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('version-file-read-failed');
		}
	});

	test('returns ok:false reason:version-parse-failed when version.ts has no CAM_VERSION', () => {
		const result = runPostMerge(
			baseOpts({
				readVersionFile: () => '// no version here\n',
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('version-parse-failed');
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: tag reads version from file (not binary literal)
// ---------------------------------------------------------------------------

describe('runPostMerge -- version read-from-file', () => {
	test('tag uses version from injected file, not CAM_VERSION constant', () => {
		// Inject a version different from whatever CAM_VERSION the binary knows.
		const differentVersion = '9.8.7';
		const calls: SpawnCall[] = [];
		const spawnFn: SpawnFn = (cmd, args, _o) => {
			calls.push({ cmd, args: [...args] });
			if (args.includes('pull')) return fakeSpawn({ status: 0 });
			if (args.includes('rev-parse') && args.includes('HEAD')) return fakeSpawn({ stdout: 'sha123\n' });
			if (args.includes('tag') && args.includes('-l')) return fakeSpawn({ stdout: '' });
			if (args.includes('tag') && args.includes(`v${differentVersion}`)) return fakeSpawn({ status: 0 });
			if (args.includes('push') && args.includes(`v${differentVersion}`)) return fakeSpawn({ status: 0 });
			if (args.includes('branch') && args.includes('-d')) return fakeSpawn({ status: 0 });
			if (args.includes('push') && args.includes('--delete')) return fakeSpawn({ status: 0 });
			return fakeSpawn();
		};

		const result = runPostMerge({
			cwd: FAKE_CWD,
			mergedBranch: FAKE_BRANCH,
			spawnFn,
			readVersionFile: () => `export const CAM_VERSION = '${differentVersion}';\n`,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tag).toBe(`v${differentVersion}`);

		const tagCreate = calls.find(
			(c) => c.args.includes('tag') && c.args.includes(`v${differentVersion}`) && !c.args.includes('-l'),
		);
		expect(tagCreate).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: tag idempotency
// ---------------------------------------------------------------------------

describe('runPostMerge -- tag idempotency', () => {
	test('tagCreated is false when tag already exists, no create/push called', () => {
		const calls: SpawnCall[] = [];
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ tagListReturnsTag: true }, calls) }),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.tagCreated).toBe(false);
		expect(result.tag).toBe(FAKE_TAG);

		// No git tag <name> create call.
		const createCall = calls.find(
			(c) => c.args.includes('tag') && c.args.includes(FAKE_TAG) && !c.args.includes('-l'),
		);
		expect(createCall).toBeUndefined();

		// No git push <tag> call.
		const pushTagCall = calls.find(
			(c) => c.args.includes('push') && c.args.includes(FAKE_TAG),
		);
		expect(pushTagCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: tag-create / tag-push failures
// ---------------------------------------------------------------------------

describe('runPostMerge -- tag error paths', () => {
	test('returns ok:false reason:tag-create-failed when git tag fails', () => {
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ tagCreateStatus: 128 }) }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('tag-create-failed');
		}
	});

	test('returns ok:false reason:tag-push-failed when git push tag fails', () => {
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ tagPushStatus: 1 }) }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('tag-push-failed');
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: branch prune best-effort
// ---------------------------------------------------------------------------

describe('runPostMerge -- branch prune best-effort', () => {
	test('branchPrunedLocal is false when branch is still present after force-delete attempt, result still ok:true', () => {
		// US-002: classify by end-state. Branch present before AND after the -D attempt => false.
		const result = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({
					revParseLocalPreStatus: 0,  // branch present
					branchDeleteLocalStatus: 1, // -D exits non-zero
					revParseLocalPostStatus: 0, // still present after failed delete
				}),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedLocal).toBe(false);
		// Remote should still succeed (default: branch already absent on remote).
		expect(result.branchPrunedRemote).toBe(true);
	});

	test('branchPrunedRemote is false when branch is still present after delete, result still ok:true', () => {
		// Branch present on origin before delete (lsRemotePreEmpty:false) and still
		// present after delete (lsRemotePostEmpty:false) => branchPrunedRemote:false.
		const result = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({ lsRemotePreEmpty: false, lsRemotePostEmpty: false }),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedRemote).toBe(false);
		expect(result.branchPrunedLocal).toBe(true);
	});

	test('result is ok:true even when both branch prunes fail', () => {
		// Local: branch present, -D attempted, still present after. Remote: present, delete attempted, still present.
		const result = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({
					revParseLocalPreStatus: 0,  // local branch present
					branchDeleteLocalStatus: 1, // -D exits non-zero
					revParseLocalPostStatus: 0, // still present after failed delete
					lsRemotePreEmpty: false,
					lsRemotePostEmpty: false,
				}),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedLocal).toBe(false);
		expect(result.branchPrunedRemote).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: remote prune end-state classification (US-001)
// ---------------------------------------------------------------------------

describe('runPostMerge -- remote prune end-state classification (US-001)', () => {
	test('AC1: ls-remote pre-check empty => branchPrunedRemote:true, no push --delete called', () => {
		// Default: lsRemotePreEmpty=true (branch already absent).
		const calls: SpawnCall[] = [];
		const result = runPostMerge(baseOpts({ spawnFn: happySpawn({}, calls) }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedRemote).toBe(true);

		// No push --delete should be attempted when branch is already absent.
		const remoteDeleteCall = calls.find(
			(c) => c.args.includes('push') && c.args.includes('--delete') && c.args.includes(FAKE_BRANCH),
		);
		expect(remoteDeleteCall).toBeUndefined();
	});

	test('AC1/AC4: ls-remote empty (simulating GitHub auto-delete on ci-gated merge) => branchPrunedRemote:true', () => {
		// This is the ci-gated scenario: GitHub auto-deleted the head branch on merge.
		// The empty ls-remote response correctly classifies the end-state as pruned.
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ lsRemotePreEmpty: true }) }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedRemote).toBe(true);
	});

	test('AC2: ls-remote reports branch present => push --delete called, post-check empty => branchPrunedRemote:true', () => {
		// Branch present before delete; absent after => result is true based on end-state.
		const calls: SpawnCall[] = [];
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ lsRemotePreEmpty: false, lsRemotePostEmpty: true }, calls) }),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedRemote).toBe(true);

		// push --delete must be called since the branch was present.
		const remoteDeleteCall = calls.find(
			(c) => c.args.includes('push') && c.args.includes('--delete') && c.args.includes(FAKE_BRANCH),
		);
		expect(remoteDeleteCall).toBeDefined();

		// Two ls-remote calls: pre-check and post-delete check.
		const lsRemoteCalls = calls.filter(
			(c) => c.args.includes('ls-remote') && c.args.includes('--heads'),
		);
		expect(lsRemoteCalls.length).toBe(2);
	});

	test('AC2: branchPrunedRemote is derived from end-state, not delete exit code (delete fails but branch absent)', () => {
		// Delete fails (non-zero exit) but post-check shows branch absent => still true.
		const result = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({
					lsRemotePreEmpty: false,
					branchDeleteRemoteStatus: 1,
					lsRemotePostEmpty: true,
				}),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// End-state says absent; result must be true regardless of delete exit code.
		expect(result.branchPrunedRemote).toBe(true);
	});

	test('AC3: ls-remote pre-check errors (non-zero) => fall back to push --delete + exit code', () => {
		// ls-remote fails (e.g. network error). Fall back: attempt delete + classify on exit code.
		const callsOk: SpawnCall[] = [];
		const resultOk = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({ lsRemotePreStatus: 1, branchDeleteRemoteStatus: 0 }, callsOk),
			}),
		);
		expect(resultOk.ok).toBe(true);
		if (!resultOk.ok) return;
		// Delete succeeded => branchPrunedRemote:true.
		expect(resultOk.branchPrunedRemote).toBe(true);

		// Confirm push --delete was called (not just ls-remote skip).
		const remoteDeleteCall = callsOk.find(
			(c) => c.args.includes('push') && c.args.includes('--delete'),
		);
		expect(remoteDeleteCall).toBeDefined();

		// Now test the same error path but with delete failing.
		const resultFail = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({ lsRemotePreStatus: 1, branchDeleteRemoteStatus: 1 }),
			}),
		);
		expect(resultFail.ok).toBe(true);
		if (!resultFail.ok) return;
		// Delete failed => branchPrunedRemote:false.
		expect(resultFail.branchPrunedRemote).toBe(false);
	});

	test('AC3: ls-remote error does NOT assume branch is absent (no false-positive prune)', () => {
		// When ls-remote errors, we must NOT treat the branch as already absent.
		// We must attempt the delete and use its exit code.
		const calls: SpawnCall[] = [];
		runPostMerge(
			baseOpts({ spawnFn: happySpawn({ lsRemotePreStatus: 128 }, calls) }),
		);

		// push --delete must be called (not skipped on the assumption of already-absent).
		const remoteDeleteCall = calls.find(
			(c) => c.args.includes('push') && c.args.includes('--delete') && c.args.includes(FAKE_BRANCH),
		);
		expect(remoteDeleteCall).toBeDefined();
	});

	test('AC5: all git interactions use injectable spawnFn (source oracle)', async () => {
		// grep oracle: spawnFn is the sole executor of git commands.
		const content = await Bun.file(
			new URL('../../src/release/post-merge.ts', import.meta.url),
		).text();
		expect(content).toContain('spawnFn');
		// No direct child_process import should exist (SpawnFn is injectable).
		expect(content).not.toContain("require('child_process')");
	});
});

// ---------------------------------------------------------------------------
// Tests: local prune end-state classification (US-002)
// ---------------------------------------------------------------------------

describe('runPostMerge -- local prune end-state classification (US-002)', () => {
	test('AC1/AC3: branch already absent before delete => branchPrunedLocal:true, no branch -D called', () => {
		// Default revParseLocalPreStatus:128 => branch absent => already pruned.
		const calls: SpawnCall[] = [];
		const result = runPostMerge(baseOpts({ spawnFn: happySpawn({}, calls) }));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedLocal).toBe(true);

		// No force-delete should be attempted when branch is already absent.
		const localDeleteCall = calls.find(
			(c) => c.args.includes('branch') && c.args.includes('-D') && c.args.includes(FAKE_BRANCH),
		);
		expect(localDeleteCall).toBeUndefined();
	});

	test('AC4: branch present, force-deleted (-D invoked), absent after => branchPrunedLocal:true', () => {
		// revParseLocalPreStatus:0 => present. revParseLocalPostStatus:128 (default) => absent after delete.
		const calls: SpawnCall[] = [];
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ revParseLocalPreStatus: 0 }, calls) }),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedLocal).toBe(true);

		// -D must have been called.
		const localDeleteCall = calls.find(
			(c) => c.args.includes('branch') && c.args.includes('-D') && c.args.includes(FAKE_BRANCH),
		);
		expect(localDeleteCall).toBeDefined();

		// Two rev-parse calls: pre-check (present) and post-check (absent).
		const revParseCalls = calls.filter(
			(c) =>
				c.args.includes('rev-parse') &&
				c.args.includes('--verify') &&
				c.args.includes('--quiet'),
		);
		expect(revParseCalls.length).toBe(2);
	});

	test('AC2: branchPrunedLocal derived from end-state, not -D exit code (delete fails but branch absent)', () => {
		// -D exits non-zero, but post-check shows branch absent => still branchPrunedLocal:true.
		const result = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({
					revParseLocalPreStatus: 0,  // branch present
					branchDeleteLocalStatus: 1, // -D exits non-zero
					// revParseLocalPostStatus defaults to 128 (absent) => pruned true
				}),
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// End-state says absent; result must be true regardless of -D exit code.
		expect(result.branchPrunedLocal).toBe(true);
	});

	test('uses -D (force delete), not -d (source oracle)', async () => {
		const content = await Bun.file(
			new URL('../../src/release/post-merge.ts', import.meta.url),
		).text();
		// AC1 grep oracle: '-D' must be present in the source
		expect(content).toContain("'-D'");
		// -d (soft delete) must NOT be used for the local branch delete
		expect(content).not.toContain("'-d'");
	});

	test('branchPrunedLocal:false does not abort result (result still ok:true)', () => {
		// Branch present, delete fails, still present after: branchPrunedLocal:false but ok:true.
		const result = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({
					revParseLocalPreStatus: 0,
					branchDeleteLocalStatus: 1,
					revParseLocalPostStatus: 0,
				}),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedLocal).toBe(false);
		// Other fields intact
		expect(result.tag).toBe(FAKE_TAG);
		expect(result.tagCreated).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: no release log writes
// ---------------------------------------------------------------------------

describe('runPostMerge -- no release log writes', () => {
	test('module source contains no "journal" token', async () => {
		// Mirror of the oracle: ! grep -iq 'journal' src/release/post-merge.ts
		const content = await Bun.file(
			new URL('../../src/release/post-merge.ts', import.meta.url),
		).text();
		expect(content.toLowerCase()).not.toContain('journal');
	});
});
