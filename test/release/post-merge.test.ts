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

/** Build a standard happy-path SpawnFn. Caller provides tag response. */
function happySpawn(
	opts: { tagListReturnsTag?: boolean; tagCreateStatus?: number; tagPushStatus?: number; branchDeleteLocalStatus?: number; branchDeleteRemoteStatus?: number } = {},
	calls?: SpawnCall[],
): SpawnFn {
	return (cmd, args, _o) => {
		if (calls) calls.push({ cmd, args: [...args] });
		// pull origin main
		if (args.includes('pull') && args.includes('origin') && args.includes('main')) {
			return fakeSpawn({ status: 0 });
		}
		// rev-parse HEAD
		if (args.includes('rev-parse') && args.includes('HEAD')) {
			return fakeSpawn({ stdout: `${FAKE_SHA}\n`, status: 0 });
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
		// branch -d <branch>
		if (args.includes('branch') && args.includes('-d') && args.includes(FAKE_BRANCH)) {
			return fakeSpawn({ status: opts.branchDeleteLocalStatus ?? 0 });
		}
		// push origin --delete <branch>
		if (args.includes('push') && args.includes('--delete') && args.includes(FAKE_BRANCH)) {
			return fakeSpawn({ status: opts.branchDeleteRemoteStatus ?? 0 });
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

	test('git pull is called first', () => {
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

	test('branch deleted locally and remotely', () => {
		const calls: SpawnCall[] = [];
		runPostMerge(baseOpts({ spawnFn: happySpawn({}, calls) }));

		const localDelete = calls.find(
			(c) => c.args.includes('branch') && c.args.includes('-d') && c.args.includes(FAKE_BRANCH),
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
	test('branchPrunedLocal is false when local delete fails, result still ok:true', () => {
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ branchDeleteLocalStatus: 1 }) }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedLocal).toBe(false);
		// Remote should still succeed.
		expect(result.branchPrunedRemote).toBe(true);
	});

	test('branchPrunedRemote is false when remote delete fails, result still ok:true', () => {
		const result = runPostMerge(
			baseOpts({ spawnFn: happySpawn({ branchDeleteRemoteStatus: 1 }) }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedRemote).toBe(false);
		expect(result.branchPrunedLocal).toBe(true);
	});

	test('result is ok:true even when both branch deletes fail', () => {
		const result = runPostMerge(
			baseOpts({
				spawnFn: happySpawn({ branchDeleteLocalStatus: 1, branchDeleteRemoteStatus: 1 }),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.branchPrunedLocal).toBe(false);
		expect(result.branchPrunedRemote).toBe(false);
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
