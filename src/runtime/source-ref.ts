// src/runtime/source-ref.ts
//
// The one Git ref the web runtime treats as its source of truth: the
// remote-tracking `origin/main`, never the local `refs/heads/main`.
//
// `main` may be checked out, and dirty, in another worktree of the same
// repository, so the runtime is never allowed to move it: no `update-ref`, no
// `branch --force`, no `fetch origin main:main`. The remote-tracking ref
// carries no such constraint and is shared by every worktree of the repository,
// so refreshing it from whichever worktree happens to be at hand leaves every
// working tree untouched.
//
// The refspec is spelled out in full instead of relying on the remote's
// configured fetch refspec, so `refs/remotes/origin/main` is updated
// deterministically even in a repository whose `origin` was added without one.

import type { CommandResult, GitCommandRunner } from './git-runtime.ts';

/** Remote the runtime considers authoritative. */
const RUNTIME_SOURCE_REMOTE = 'origin';
/** Branch on that remote the runtime considers authoritative. */
const RUNTIME_SOURCE_BRANCH = 'main';

/**
 * Remote-tracking ref every runtime read resolves against: the issue record,
 * the plannable backlog, and the base commit of a new run's worktree.
 */
export const RUNTIME_SOURCE_REF = `${RUNTIME_SOURCE_REMOTE}/${RUNTIME_SOURCE_BRANCH}`;

const RUNTIME_SOURCE_REFSPEC =
	`+refs/heads/${RUNTIME_SOURCE_BRANCH}:refs/remotes/${RUNTIME_SOURCE_REF}`;

/**
 * Argv that refreshes the runtime source ref from the remote. Writes only
 * `refs/remotes/origin/main`; no local branch and no working tree moves.
 *
 * Exported as argv rather than only as a call so the shipper, whose command
 * seam is asynchronous and takes command plus args, refreshes through the exact
 * same refspec as the preflight.
 */
export function runtimeSourceFetchArgs(): string[] {
	return ['fetch', '--quiet', RUNTIME_SOURCE_REMOTE, RUNTIME_SOURCE_REFSPEC];
}

/** Refresh the runtime source ref through a synchronous git seam. */
export function fetchRuntimeSource(runGit: GitCommandRunner, cwd: string): CommandResult {
	return runGit(cwd, runtimeSourceFetchArgs());
}
