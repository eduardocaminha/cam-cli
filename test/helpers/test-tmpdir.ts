// test/helpers/test-tmpdir.ts
//
// Single test-scratch helper (US-002, CAM-508). Every temp directory a test
// needs is created under a repo-local scratch root (`.gship-test-tmp/`,
// ignored by the repository .gitignore) instead of the shared $TMPDIR. Under a
// degraded shared-$TMPDIR environment (CAM-503), dozens of test files each
// rooting their own `mkdtempSync(join(tmpdir(), ...))` produced spurious
// slow/failing tests; this is the single replacement call site.
//
// GOTCHA 4: this file must never reference `node:os` on a CODE line (the
// acceptance-criteria oracle greps for it, ignoring comment lines). The
// scratch root below is derived from `import.meta.dir`, never
// `process.cwd()` or `os.tmpdir()`, because dozens of existing tests call
// `process.chdir()` mid-run to exercise cwd-sensitive code paths.
//
// Reap mechanism (US-R1-002, CAM-508): `process.on('exit', ...)` below fires
// for any runtime that reaches a real process exit (a `bun -e` one-liner, a
// plain `bun <script>.ts`), but NEVER fires under `bun test` -- the only
// runner every call site in this suite actually runs under (confirmed
// empirically, bun 1.3.13: a probe registering
// `process.on('exit', () => console.error('EXIT-HOOK-FIRED'))` prints
// nothing when the file is loaded by `bun test`). So the exit hook alone is
// NOT the delivery mechanism for reaping directories created while running
// this suite; `test/helpers/reap-preload.ts` (wired via `bunfig.toml`'s
// `[test].preload`) registers a run-wide `afterAll` that calls
// `reapOwnDirectories` (exported below for that file to import) once after
// the entire `bun test` invocation finishes -- Bun's documented mechanism
// for run-wide teardown (https://bun.sh/docs/test/lifecycle, "Global Setup
// and Teardown"). The exit hook is kept as a second, harmless layer for any
// non-test-runner usage of `createTestTmpdir` that does reach a real exit.
//
// Location-independent git fence (US-R1-003, CAM-508): the original fence
// (`GIT_CEILING_DIRECTORIES`, set on `process.env` below) is a runtime env
// mutation, so it only reaches a child git process that forwards live
// `process.env` -- and `Bun.spawnSync` does NOT live-inherit env mutations
// made after Bun startup unless `env: process.env` is passed explicitly
// (confirmed empirically). Nothing enforces that every future spawn site
// remembers to forward it, and a spawn site that forgets would silently walk
// a non-git-inited scratch dir up into Gateship's own working tree instead of
// failing closed. `ensureScratchRootIsAGitRepo` below closes that class of
// gap structurally: it makes `SCRATCH_ROOT` itself a (near-empty) git repo,
// so any git command run from a subdirectory with no `.git` of its own
// resolves its toplevel to `SCRATCH_ROOT` and stops there, regardless of
// whether `GIT_CEILING_DIRECTORIES` reached that particular child's
// environment. `GIT_CEILING_DIRECTORIES` is kept as a second, redundant
// layer for spawn sites that do forward env.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Repo root, derived from this file's own location (never process.cwd()). */
const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Repo-local scratch root every helper-created directory lives under.
 * Ignored by the repository .gitignore so a directory surviving a crash
 * never dirties the working tree.
 */
export const SCRATCH_ROOT = join(REPO_ROOT, '.gship-test-tmp');

/** Directories created by this helper are pruned if older than this (ms). */
const STALE_AGE_MS = 60 * 60 * 1000;

let initialized = false;
const createdByThisProcess: string[] = [];

/**
 * The prune below owns only the scratch directories this helper itself
 * creates, and those are never dot-prefixed (`gship-test-*`, and
 * `gship-check-all-inprocess-bare-*` from the in-process check-all runs). A
 * dot-prefixed entry therefore always belongs to some other mechanism, so the
 * prune must leave it alone regardless of age (CAM-519): the concrete case is
 * `SCRATCH_ROOT`'s own `.git` fence, which `ensureScratchRootIsAGitRepo`
 * installs and the prune used to delete once it aged past `STALE_AGE_MS`,
 * unfencing the whole suite for the rest of the process (the fence is created
 * before `initialized` flips, so nothing rebuilt it). Skipping by "is this a
 * dotfile" rather than by "is this name `.git`" keeps any future sentinel
 * planted in this directory safe too, without requiring an allowlist of every
 * scratch prefix the suite might grow.
 */
function isPruneCandidate(entry: string): boolean {
	return !entry.startsWith('.');
}

/**
 * Bounded, failure-tolerant sweep of `SCRATCH_ROOT`'s own direct children
 * (never `$TMPDIR`, GOTCHA 12: enumerating the shared temp dir blew
 * 30-120s timeouts). Removes leftovers from a prior process that never
 * reached its own exit-time reap (e.g. a hard kill).
 */
function pruneStaleSiblings(): void {
	let entries: string[];
	try {
		entries = readdirSync(SCRATCH_ROOT);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!isPruneCandidate(entry)) continue;
		const entryPath = join(SCRATCH_ROOT, entry);
		try {
			const info = statSync(entryPath);
			if (now - info.mtimeMs > STALE_AGE_MS) {
				rmSync(entryPath, { recursive: true, force: true });
			}
		} catch {
			// A concurrent process may have already removed this entry, or
			// removal may hit a transient permission error; either way a single
			// stale sibling must never fail this process's own directory
			// creation.
		}
	}
}

/**
 * Removes every directory this process created, tolerating partial failure.
 * Exported so `test/helpers/reap-preload.ts` can call it from a run-wide
 * `afterAll`, since `process.on('exit', ...)` below never fires under
 * `bun test` (see the header comment).
 */
export function reapOwnDirectories(): void {
	for (const dir of createdByThisProcess) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// A half-removed directory must never fail an unrelated test
			// process's shutdown.
		}
	}
}

/**
 * Primary fence (US-R1-003, CAM-508): makes `SCRATCH_ROOT` itself a
 * (near-empty) git repository, once, idempotently. A git command run from
 * any subdirectory under `SCRATCH_ROOT` that has no `.git` of its own then
 * resolves its toplevel to `SCRATCH_ROOT` and stops there -- it can never
 * walk further up into Gateship's own working tree, regardless of whether the
 * spawning process forwarded `GIT_CEILING_DIRECTORIES` (see header comment).
 * Best-effort: a missing/unusable `git` binary must never fail scratch-dir
 * creation itself (git is a hard test dependency elsewhere, see
 * test/helpers/test-deps.ts, but this helper has no test-runner-only import
 * and stays defensive regardless).
 */
function ensureScratchRootIsAGitRepo(): void {
	if (existsSync(join(SCRATCH_ROOT, '.git'))) return;
	try {
		Bun.spawnSync(['git', 'init', '-q', SCRATCH_ROOT], { stdout: 'ignore', stderr: 'ignore' });
	} catch {
		// git absent/unusable: GIT_CEILING_DIRECTORIES below remains the only
		// fence in that (unsupported) environment.
	}
}

function ensureScratchRoot(): void {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	// Redundant secondary layer: GIT_CEILING_DIRECTORIES stops git's upward
	// repo search AT this directory for any child process that forwards live
	// `process.env`. See the header comment and ensureScratchRootIsAGitRepo
	// above for why this alone is not sufficient.
	process.env.GIT_CEILING_DIRECTORIES = SCRATCH_ROOT;
	if (!initialized) {
		initialized = true;
		ensureScratchRootIsAGitRepo();
		pruneStaleSiblings();
		process.on('exit', reapOwnDirectories);
	}
}

/**
 * Creates and returns a fresh directory under the repo-local scratch root.
 * The single replacement for every `mkdtempSync(join(tmpdir(), prefix))` /
 * `await mkdtemp(join(tmpdir(), prefix))` call site across the suite.
 */
export function createTestTmpdir(prefix = 'gship-test-'): string {
	ensureScratchRoot();
	const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
	createdByThisProcess.push(dir);
	return dir;
}
