// test/supervisor/host-ensure-pushed.test.ts
//
// Unit tests for resolveEnsurePushed (US-001, CAM-156): compare-first
// push-verification via `git ls-remote origin <branch>` before attempting
// any `git push`.
//
// Coverage:
//   (a) synced-ok-without-push: origin sha == local HEAD -> ok:true,
//       pushed:false, and NO `git push` call is issued.
//   (b) genuine-behind-then-push: origin sha != local HEAD (or branch
//       missing on remote) -> `git push` runs, HEAD/origin re-verified,
//       returns ok:true, pushed:true.
//   (c) ls-remote-failure fallback: `git ls-remote` exits non-zero ->
//       falls back to the push-then-compare path.
//   (d) missing branch name: ok:false, no push, no ls-remote.

import { describe, expect, test } from 'bun:test';
import { resolveEnsurePushed, type GitSpawnFn } from '../../src/supervisor/host.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpawnCall = { cmd: string; args: string[] };

function fakeResult(stdout: string, status: number | null = 0, stderr = '') {
	return { stdout, stderr, status };
}

const FAKE_CWD = '/tmp/testproject';
const FAKE_BRANCH = 'cam/issue-156';
const FAKE_SHA = 'abc1234def5678';

/** Extract the git subcommand from an argv that always starts with `-C <cwd>`. */
function subcommandOf(args: string[]): string | undefined {
	return args[0] === '-C' ? args[2] : args[0];
}

// ---------------------------------------------------------------------------
// (a) synced-ok-without-push
// ---------------------------------------------------------------------------

describe('resolveEnsurePushed (US-001, CAM-156)', () => {
	test('(a) synced-ok-without-push: origin sha == local HEAD -> ok:true, pushed:false, no git push', () => {
		const calls: SpawnCall[] = [];
		const spawnFn: GitSpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args: [...args] });
			const subcommand = subcommandOf(args);
			if (subcommand === 'branch') return fakeResult(FAKE_BRANCH);
			if (subcommand === 'rev-parse') return fakeResult(FAKE_SHA);
			if (subcommand === 'ls-remote') return fakeResult(`${FAKE_SHA}\trefs/heads/${FAKE_BRANCH}`);
			return fakeResult('', 0);
		};

		const result = resolveEnsurePushed(spawnFn, FAKE_CWD);

		expect(result).toEqual({
			ok: true,
			pushed: false,
			sha: FAKE_SHA,
			detail: `origin/${FAKE_BRANCH} already at HEAD (${FAKE_SHA}), no push needed`,
		});
		expect(calls.some((c) => c.args.includes('push'))).toBe(false);
		expect(calls.some((c) => c.args.includes('ls-remote'))).toBe(true);
		// ls-remote runs BEFORE any push attempt could occur.
		const lsRemoteIdx = calls.findIndex((c) => c.args.includes('ls-remote'));
		const pushIdx = calls.findIndex((c) => c.args.includes('push'));
		expect(lsRemoteIdx).toBeGreaterThanOrEqual(0);
		expect(pushIdx).toBe(-1);
	});

	// -------------------------------------------------------------------------
	// (b) genuine-behind-then-push
	// -------------------------------------------------------------------------

	test('(b) genuine-behind-then-push: origin behind local HEAD -> git push runs, re-verifies, pushed:true', () => {
		const calls: SpawnCall[] = [];
		const staleSha = 'stale0001111';
		let pushCount = 0;
		const spawnFn: GitSpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args: [...args] });
			const subcommand = args[0] === '-C' ? args[2] : args[0];
			if (subcommand === 'branch') return fakeResult(FAKE_BRANCH);
			if (subcommand === 'ls-remote') return fakeResult(`${staleSha}\trefs/heads/${FAKE_BRANCH}`);
			if (subcommand === 'push') {
				pushCount++;
				return fakeResult('');
			}
			if (subcommand === 'rev-parse') {
				const target = args[args.length - 1];
				if (target === 'HEAD') return fakeResult(FAKE_SHA);
				if (target === `origin/${FAKE_BRANCH}`) return fakeResult(FAKE_SHA);
			}
			return fakeResult('', 0);
		};

		const result = resolveEnsurePushed(spawnFn, FAKE_CWD);

		expect(result).toEqual({
			ok: true,
			pushed: true,
			sha: FAKE_SHA,
			detail: `HEAD == origin/${FAKE_BRANCH} (${FAKE_SHA})`,
		});
		expect(pushCount).toBe(1);
	});

	test('(b2) genuine-missing-branch-then-push: ls-remote returns empty stdout -> push runs, pushed:true', () => {
		const calls: SpawnCall[] = [];
		let pushCount = 0;
		const spawnFn: GitSpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args: [...args] });
			const subcommand = args[0] === '-C' ? args[2] : args[0];
			if (subcommand === 'branch') return fakeResult(FAKE_BRANCH);
			if (subcommand === 'ls-remote') return fakeResult('');
			if (subcommand === 'push') {
				pushCount++;
				return fakeResult('');
			}
			if (subcommand === 'rev-parse') return fakeResult(FAKE_SHA);
			return fakeResult('', 0);
		};

		const result = resolveEnsurePushed(spawnFn, FAKE_CWD);

		expect(result.ok).toBe(true);
		expect(result.pushed).toBe(true);
		expect(pushCount).toBe(1);
	});

	// -------------------------------------------------------------------------
	// (c) ls-remote-failure fallback
	// -------------------------------------------------------------------------

	test('(c) ls-remote-failure fallback: git ls-remote fails -> falls back to push-then-compare', () => {
		const calls: SpawnCall[] = [];
		let pushCount = 0;
		const spawnFn: GitSpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args: [...args] });
			const subcommand = args[0] === '-C' ? args[2] : args[0];
			if (subcommand === 'branch') return fakeResult(FAKE_BRANCH);
			if (subcommand === 'ls-remote') return fakeResult('', 1, 'network error');
			if (subcommand === 'push') {
				pushCount++;
				return fakeResult('');
			}
			if (subcommand === 'rev-parse') return fakeResult(FAKE_SHA);
			return fakeResult('', 0);
		};

		const result = resolveEnsurePushed(spawnFn, FAKE_CWD);

		expect(result.ok).toBe(true);
		expect(result.pushed).toBe(true);
		expect(pushCount).toBe(1);
	});

	// -------------------------------------------------------------------------
	// (d) missing branch name
	// -------------------------------------------------------------------------

	test('(d) missing branch name: ok:false, no push, no ls-remote', () => {
		const calls: SpawnCall[] = [];
		const spawnFn: GitSpawnFn = (cmd, args, _opts) => {
			calls.push({ cmd, args: [...args] });
			const subcommand = subcommandOf(args);
			if (subcommand === 'branch') return fakeResult('');
			return fakeResult('', 0);
		};

		const result = resolveEnsurePushed(spawnFn, FAKE_CWD);

		expect(result.ok).toBe(false);
		expect(result.detail).toBe('could not determine current branch');
		expect(calls.some((c) => c.args.includes('push'))).toBe(false);
		expect(calls.some((c) => c.args.includes('ls-remote'))).toBe(false);
	});

	// -------------------------------------------------------------------------
	// (e) push failure surfaces as ok:false (fallback path preserves old behavior)
	// -------------------------------------------------------------------------

	test('(e) genuine-behind, git push itself fails -> ok:false, pushed:false', () => {
		const spawnFn: GitSpawnFn = (_cmd, args, _opts) => {
			const subcommand = args[0] === '-C' ? args[2] : args[0];
			if (subcommand === 'branch') return fakeResult(FAKE_BRANCH);
			if (subcommand === 'ls-remote') return fakeResult('stale0001111\trefs/heads/' + FAKE_BRANCH);
			if (subcommand === 'push') return fakeResult('', 1, 'cannot lock ref');
			if (subcommand === 'rev-parse') return fakeResult(FAKE_SHA);
			return fakeResult('', 0);
		};

		const result = resolveEnsurePushed(spawnFn, FAKE_CWD);

		expect(result.ok).toBe(false);
		expect(result.pushed).toBe(false);
		expect(result.detail).toContain('git push failed');
	});
});
