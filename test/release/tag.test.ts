// test/release/tag.test.ts
//
// Unit tests for runTag() in src/commands/tag.ts.
// All git calls go through a fake SpawnFn -- no real git, no real tags.
//
// US-005 (CAM-89).

import { describe, test, expect } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { runTag, type SpawnFn } from '../../src/commands/tag.ts';
import { CAM_VERSION } from '../../src/version.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake SpawnSyncReturns<string> with sensible defaults.
 */
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

/**
 * Build a SpawnFn that maps command+args to a fake result.
 * Each entry in the map is matched by `args[0]` (the git subcommand) plus
 * optional args content.
 */
function makeSpawnFn(
	responses: Record<string, SpawnSyncReturns<string>>,
	calls?: SpawnCall[],
): SpawnFn {
	return (cmd, args, _opts) => {
		const key = `${cmd} ${args.join(' ')}`;
		// Record the call if a collector was given.
		if (calls) calls.push({ cmd, args: [...args] });
		// Match exact key first, then sub-command prefix, then default to success.
		return responses[key] ?? responses[args[0] ?? ''] ?? fakeSpawn();
	};
}

const TAG = `v${CAM_VERSION}`;

// ---------------------------------------------------------------------------
// Tests: branch guard
// ---------------------------------------------------------------------------

describe('runTag -- branch guard', () => {
	test('refuses when branch is not main', () => {
		const spawnFn = makeSpawnFn({
			'git rev-parse': fakeSpawn({ stdout: 'feat/my-branch\n', status: 0 }),
		});
		const result = runTag({ cwd: '/tmp/proj', spawnFn });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('not-main');
		}
	});

	test('refuses on detached HEAD', () => {
		const spawnFn = makeSpawnFn({
			'git rev-parse': fakeSpawn({ stdout: 'HEAD\n', status: 0 }),
		});
		const result = runTag({ cwd: '/tmp/proj', spawnFn });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('not-main');
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: dirty-tree guard
// ---------------------------------------------------------------------------

describe('runTag -- dirty-tree guard', () => {
	test('refuses when working tree is dirty', () => {
		const calls: SpawnCall[] = [];
		const spawnFn: SpawnFn = (cmd, args, opts) => {
			calls.push({ cmd, args: [...args] });
			if (args[0] === 'rev-parse') return fakeSpawn({ stdout: 'main\n' });
			if (args[0] === 'status') return fakeSpawn({ stdout: ' M src/version.ts\n' });
			return fakeSpawn();
		};
		const result = runTag({ cwd: '/tmp/proj', spawnFn });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('dirty-working-tree');
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: happy path
// ---------------------------------------------------------------------------

describe('runTag -- happy path', () => {
	test('creates and pushes the tag when it does not exist', () => {
		const calls: SpawnCall[] = [];
		const spawnFn: SpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args: [...args] });
			if (args[0] === 'rev-parse') return fakeSpawn({ stdout: 'main\n' });
			if (args[0] === 'status') return fakeSpawn({ stdout: '' });
			// tag -l returns empty (tag does not exist yet).
			if (args[0] === 'tag' && args[1] === '-l') return fakeSpawn({ stdout: '' });
			// tag <name> (create) returns success.
			if (args[0] === 'tag' && args[1] === TAG) return fakeSpawn({ status: 0 });
			// push origin <tag> returns success.
			if (args[0] === 'push') return fakeSpawn({ status: 0 });
			return fakeSpawn();
		};

		const result = runTag({ cwd: '/tmp/proj', spawnFn });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.tag).toBe(TAG);
			expect(result.alreadyExisted).toBe(false);
		}

		// Assert git tag was created.
		const tagCreate = calls.find((c) => c.cmd === 'git' && c.args[0] === 'tag' && c.args[1] === TAG && !c.args.includes('-l'));
		expect(tagCreate).toBeDefined();

		// Assert git push was called.
		const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push' && c.args.includes(TAG));
		expect(pushCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: idempotency
// ---------------------------------------------------------------------------

describe('runTag -- idempotency', () => {
	test('is a no-op when the tag already exists', () => {
		const calls: SpawnCall[] = [];
		const spawnFn: SpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args: [...args] });
			if (args[0] === 'rev-parse') return fakeSpawn({ stdout: 'main\n' });
			if (args[0] === 'status') return fakeSpawn({ stdout: '' });
			// tag -l returns the tag name (it already exists).
			if (args[0] === 'tag' && args[1] === '-l') return fakeSpawn({ stdout: `${TAG}\n` });
			return fakeSpawn();
		};

		const result = runTag({ cwd: '/tmp/proj', spawnFn });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.tag).toBe(TAG);
			expect(result.alreadyExisted).toBe(true);
		}

		// Assert no `git tag <name>` create call was made.
		const tagCreate = calls.find((c) => c.cmd === 'git' && c.args[0] === 'tag' && !c.args.includes('-l'));
		expect(tagCreate).toBeUndefined();

		// Assert no `git push` was made.
		const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
		expect(pushCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: tag-create failure
// ---------------------------------------------------------------------------

describe('runTag -- error paths', () => {
	test('returns ok:false when git tag create fails', () => {
		const spawnFn: SpawnFn = (cmd, args, _opts) => {
			if (args[0] === 'rev-parse') return fakeSpawn({ stdout: 'main\n' });
			if (args[0] === 'status') return fakeSpawn({ stdout: '' });
			if (args[0] === 'tag' && args[1] === '-l') return fakeSpawn({ stdout: '' });
			// create fails
			if (args[0] === 'tag') return fakeSpawn({ status: 128, stderr: 'fatal: tag already exists' });
			return fakeSpawn();
		};
		const result = runTag({ cwd: '/tmp/proj', spawnFn });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('tag-create-failed');
		}
	});

	test('returns ok:false when git push fails', () => {
		const spawnFn: SpawnFn = (cmd, args, _opts) => {
			if (args[0] === 'rev-parse') return fakeSpawn({ stdout: 'main\n' });
			if (args[0] === 'status') return fakeSpawn({ stdout: '' });
			if (args[0] === 'tag' && args[1] === '-l') return fakeSpawn({ stdout: '' });
			if (args[0] === 'tag') return fakeSpawn({ status: 0 });
			// push fails
			if (args[0] === 'push') return fakeSpawn({ status: 1, stderr: 'fatal: remote error' });
			return fakeSpawn();
		};
		const result = runTag({ cwd: '/tmp/proj', spawnFn });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('tag-push-failed');
		}
	});
});
