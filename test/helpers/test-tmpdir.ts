// test/helpers/test-tmpdir.ts
//
// Single test-scratch helper (US-002, CAM-508). Every temp directory a test
// needs is created under a repo-local scratch root (`.cam-test-tmp/`,
// ignored on all three sides -- .gitignore, templates/.gitignore, and the
// embedded copy -- by US-001) instead of the shared $TMPDIR. Under a
// degraded shared-$TMPDIR environment (CAM-503), dozens of test files each
// rooting their own `mkdtempSync(join(tmpdir(), ...))` produced spurious
// slow/failing tests; this is the single replacement call site.
//
// GOTCHA 4: this file must never reference `node:os` on a CODE line (the
// acceptance-criteria oracle greps for it, ignoring comment lines). The
// scratch root below is derived from `import.meta.dir`, never
// `process.cwd()` or `os.tmpdir()`, because dozens of existing tests call
// `process.chdir()` mid-run to exercise cwd-sensitive code paths.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Repo root, derived from this file's own location (never process.cwd()). */
const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Repo-local scratch root every helper-created directory lives under.
 * Ignored identically in .gitignore / templates/.gitignore / the embedded
 * copy (US-001, CAM-508) so a directory surviving a crash never dirties the
 * working tree.
 */
export const SCRATCH_ROOT = join(REPO_ROOT, '.cam-test-tmp');

/** Directories created by this helper are pruned if older than this (ms). */
const STALE_AGE_MS = 60 * 60 * 1000;

let initialized = false;
const createdByThisProcess: string[] = [];

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

/** Removes every directory this process created, tolerating partial failure. */
function reapOwnDirectories(): void {
	for (const dir of createdByThisProcess) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// A half-removed directory must never fail an unrelated test
			// process's shutdown.
		}
	}
}

function ensureScratchRoot(): void {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	// GIT_CEILING_DIRECTORIES stops git's upward repo search AT this
	// directory: since .cam-test-tmp/ itself carries no .git, `git
	// rev-parse --show-toplevel` run from any directory under it fails with
	// "not a git repository" instead of silently walking up and resolving
	// to cam-cli's own working tree.
	process.env.GIT_CEILING_DIRECTORIES = SCRATCH_ROOT;
	if (!initialized) {
		initialized = true;
		pruneStaleSiblings();
		process.on('exit', reapOwnDirectories);
	}
}

/**
 * Creates and returns a fresh directory under the repo-local scratch root.
 * The single replacement for every `mkdtempSync(join(tmpdir(), prefix))` /
 * `await mkdtemp(join(tmpdir(), prefix))` call site across the suite.
 */
export function createTestTmpdir(prefix = 'cam-test-'): string {
	ensureScratchRoot();
	const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
	createdByThisProcess.push(dir);
	return dir;
}
