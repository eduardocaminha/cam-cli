// src/commands/next-preflight.ts
//
// Deterministic preflight for `cam next` (US-003, CAM-400 PRD).
//
// Folds the imperative "Pre-flight Checks" section that used to live in
// cam-next.md (run by the orchestrator's own session before the sidecar
// starts) into a pure, testable gate the active:true signal write can key
// off of:
//   1. git fetch origin
//   2. resolve current branch (git rev-parse --abbrev-ref HEAD, unless
//      overridden)
//   3. sync with remote: git rev-parse --verify origin/<branch> —
//      exists -> git pull origin <branch>; absent -> git push -u origin
//      <branch> (creates the tracking branch, mirrors the old Step 1)
//   4. git status --porcelain (non-empty output => halt, step 'clean-tree')
//   5. bun run typecheck
//   6. bun test
//
// Every binary call routes through the injected spawnFn so unit tests never
// shell out to real git/bun (no test recursion: `cam next`'s own preflight
// must never spawn a real `bun test`, which would run this very suite).
// Follows the same discriminated-union + injectable-spawnFn shape as
// src/supervisor/plan-preflight.ts (US-004, CAM-117); `combineStreams` is
// re-used from there rather than re-implemented.

import { combineStreams, type PlanPreflightSpawnFn } from '../supervisor/plan-preflight.ts';

/** Injectable spawn seam; identical shape to PlanPreflightSpawnFn. */
export type NextPreflightSpawnFn = PlanPreflightSpawnFn;

export interface RunNextPreflightOptions {
	/**
	 * Project working directory. Not used by the pure function itself;
	 * present for the production caller to build a cwd-bound spawnFn closure.
	 */
	cwd: string;

	/** Injectable spawn seam; every git/bun call routes through this. */
	spawnFn: NextPreflightSpawnFn;

	/**
	 * Current branch name override. Defaults to
	 * `git rev-parse --abbrev-ref HEAD` (via spawnFn) when absent. Tests
	 * inject a fixed branch name to avoid an extra spawnFn call to assert on.
	 */
	branch?: string;
}

/**
 * Discriminated union returned by runNextPreflight.
 *
 * - `{ ok: true }` — all checks passed; safe to write active:true.
 * - `{ ok: false; step: string; detail: string }` — the first failing step.
 *   `step` is one of: 'git-fetch', 'git-branch', 'git-pull', 'git-push',
 *   'clean-tree', 'typecheck', 'bun-test'. For 'clean-tree', `detail` is the
 *   raw `git status --porcelain` stdout (trimmed). For the others, `detail`
 *   is stderr+stdout combined via `combineStreams` (stderr first).
 */
export type NextPreflightResult = { ok: true } | { ok: false; step: string; detail: string };

/**
 * Resolve the current branch name (unless `branchOverride` is given) via
 * `git rev-parse --abbrev-ref HEAD`. Extracted from `runNextPreflight` to
 * keep its cognitive complexity under the lint ceiling.
 */
function resolveBranch(
	spawnFn: NextPreflightSpawnFn,
	branchOverride: string | undefined,
): { ok: true; branch: string } | { ok: false; step: string; detail: string } {
	if (branchOverride !== undefined) return { ok: true, branch: branchOverride };
	const headBranch = spawnFn('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
	if ((headBranch.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'git-branch', detail: combineStreams(headBranch) };
	}
	return { ok: true, branch: headBranch.stdout.trim() };
}

/**
 * Sync `branch` with its remote counterpart — pull if the tracking branch
 * already exists on origin, else push -u to create it (mirrors the
 * de-inlined cam-next.md Step 1). Extracted from `runNextPreflight` to keep
 * its cognitive complexity under the lint ceiling.
 */
function syncWithRemote(
	spawnFn: NextPreflightSpawnFn,
	branch: string,
): { ok: true } | { ok: false; step: string; detail: string } {
	const verify = spawnFn('git', ['rev-parse', '--verify', `origin/${branch}`]);
	if ((verify.exitCode ?? 1) === 0) {
		const pull = spawnFn('git', ['pull', 'origin', branch]);
		if ((pull.exitCode ?? 1) !== 0) {
			return { ok: false, step: 'git-pull', detail: combineStreams(pull) };
		}
		return { ok: true };
	}
	const push = spawnFn('git', ['push', '-u', 'origin', branch]);
	if ((push.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'git-push', detail: combineStreams(push) };
	}
	return { ok: true };
}

/**
 * Run the deterministic `cam next` pre-flight checks.
 *
 * Steps run in order; the FIRST failing step halts immediately (no later
 * step is run).
 */
export function runNextPreflight(opts: RunNextPreflightOptions): NextPreflightResult {
	const { spawnFn } = opts;

	// Step 1: git fetch origin
	const fetch = spawnFn('git', ['fetch', 'origin']);
	if ((fetch.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'git-fetch', detail: combineStreams(fetch) };
	}

	// Step 2: resolve the current branch (unless overridden).
	const branchResult = resolveBranch(spawnFn, opts.branch);
	if (!branchResult.ok) return branchResult;

	// Step 3: sync with remote (pull or push -u).
	const syncResult = syncWithRemote(spawnFn, branchResult.branch);
	if (!syncResult.ok) return syncResult;

	// Step 4: clean working tree check. git status --porcelain exits 0 for
	// both clean and dirty trees; the signal is the stdout content.
	const status = spawnFn('git', ['status', '--porcelain']);
	if (status.stdout.trim().length > 0) {
		return { ok: false, step: 'clean-tree', detail: status.stdout.trim() };
	}

	// Step 5: typecheck
	const typecheck = spawnFn('bun', ['run', 'typecheck']);
	if ((typecheck.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'typecheck', detail: combineStreams(typecheck) };
	}

	// Step 6: tests
	const tests = spawnFn('bun', ['test']);
	if ((tests.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'bun-test', detail: combineStreams(tests) };
	}

	return { ok: true };
}
