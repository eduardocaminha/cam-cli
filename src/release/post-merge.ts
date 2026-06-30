// src/release/post-merge.ts
//
// runPostMerge() -- deterministic post-merge primitive.
//
// Performs, in order:
//   1. git pull origin main
//   2. Read the version from src/version.ts on main AFTER the pull (NOT the
//      installed binary's embedded literal) to avoid stale-binary mis-tagging.
//   3. Create and push the vX.Y.Z tag (idempotent: no-op when tag exists).
//   4. Delete the merged feature branch locally and on origin.
//
// All git interactions go through an injectable SpawnFn so the function is
// fully unit-testable without a real git binary or filesystem.
//
// The function does NOT write or append anything to the release log.
// The orchestrator is the sole author of the release log; the post-merge is
// pure deterministic git.
//
// US-006 (CAM-101).

import { readFileSync } from 'node:fs';
import type { SpawnSyncReturns } from 'node:child_process';
import { printError, printSuccess } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types (same pattern as ship-finalize.ts / tag.ts)
// ---------------------------------------------------------------------------

/**
 * Subset of node:child_process spawnSync we need.
 * Injectable so unit tests never shell out to a real git binary.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8' },
) => SpawnSyncReturns<string>;

/**
 * Injectable file reader for src/version.ts.
 * Defaults to readFileSync (synchronous, no network).
 * Tests inject a function that returns a fake version.ts content.
 */
export type ReadVersionFileFn = (absolutePath: string) => string;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PostMergeOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Name of the feature branch that was just merged (will be pruned). */
	mergedBranch: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/**
	 * Injectable reader for src/version.ts.
	 * When absent, falls back to readFileSync (production default).
	 */
	readVersionFile?: ReadVersionFileFn;
}

export type PostMergeOutcome =
	| {
			ok: true;
			/** SHA of main HEAD after the pull. */
			pulledSha: string;
			/** The vX.Y.Z tag that was checked/created. */
			tag: string;
			/** true = newly created and pushed; false = already existed (idempotent). */
			tagCreated: boolean;
			/** true = local branch deleted successfully. */
			branchPrunedLocal: boolean;
			/** true = remote branch deleted successfully. */
			branchPrunedRemote: boolean;
	  }
	| { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Version-file parsing
// ---------------------------------------------------------------------------

/** Extract the version string from the content of src/version.ts. */
function parseVersionFromContent(content: string): string | undefined {
	const match = /export const CAM_VERSION = '([^']+)'/.exec(content);
	return match?.[1];
}

// ---------------------------------------------------------------------------
// Step helpers (extracted to keep runPostMerge under complexity/line limits)
// ---------------------------------------------------------------------------

type FailOutcome = { ok: false; reason: string };

/**
 * Read and parse the version from src/version.ts.
 * Returns the `vX.Y.Z` tag string on success, or a FailOutcome on error.
 */
function readVersionTag(
	cwd: string,
	readVersionFileFn: ReadVersionFileFn | undefined,
): string | FailOutcome {
	const versionTsPath = `${cwd}/src/version.ts`;
	let versionContent: string;
	try {
		const reader: ReadVersionFileFn =
			readVersionFileFn ?? ((p) => readFileSync(p, 'utf8'));
		versionContent = reader(versionTsPath);
	} catch {
		printError('could not read src/version.ts after pull');
		return { ok: false, reason: 'version-file-read-failed' };
	}
	const version = parseVersionFromContent(versionContent);
	if (version === undefined) {
		printError('could not parse CAM_VERSION from src/version.ts');
		return { ok: false, reason: 'version-parse-failed' };
	}
	return `v${version}`;
}

/**
 * Idempotent tag-and-push step.
 * Returns { tagCreated } on success, or a FailOutcome on error.
 */
function performTagStep(
	spawnFn: SpawnFn,
	cwd: string,
	tag: string,
): { tagCreated: boolean } | FailOutcome {
	const listResult = spawnFn('git', ['-C', cwd, 'tag', '-l', tag], { encoding: 'utf8' });
	const existingTag = (listResult.stdout ?? '').trim();

	if (existingTag === tag) {
		printSuccess(`tag ${tag} already exists`, '(no-op)');
		return { tagCreated: false };
	}

	const createResult = spawnFn('git', ['-C', cwd, 'tag', tag], { encoding: 'utf8' });
	if ((createResult.status ?? 1) !== 0) {
		const stderr = (createResult.stderr ?? '').trim();
		printError(`git tag ${tag} failed: ${stderr || '(no output)'}`);
		return { ok: false, reason: 'tag-create-failed' };
	}

	const pushTagResult = spawnFn('git', ['-C', cwd, 'push', 'origin', tag], { encoding: 'utf8' });
	if ((pushTagResult.status ?? 1) !== 0) {
		const stderr = (pushTagResult.stderr ?? '').trim();
		printError(
			`git push origin ${tag} failed: ${stderr || '(no output)'}`,
			'tag was created locally but not pushed',
		);
		return { ok: false, reason: 'tag-push-failed' };
	}

	printSuccess(`tagged and pushed ${tag}`);
	return { tagCreated: true };
}

/**
 * Determine whether the remote branch is pruned, using ls-remote end-state
 * classification instead of the delete command's exit code.
 *
 * Logic (US-001):
 *   1. Pre-check via `git ls-remote --heads origin <branch>`:
 *      - Empty output (exit 0) => branch already absent => return true (AC1, AC4).
 *      - Non-zero exit (network/auth error) => fall back to delete + exit code (AC3).
 *   2. Non-empty output (exit 0) => branch present: run delete, then re-derive
 *      from a post-delete ls-remote check (branch absent => true) (AC2).
 *      If the post-check itself errors, fall back to the delete exit code.
 */
function checkAndPruneRemoteBranch(
	spawnFn: SpawnFn,
	cwd: string,
	mergedBranch: string,
): boolean {
	const preCheck = spawnFn(
		'git', ['-C', cwd, 'ls-remote', '--heads', 'origin', mergedBranch],
		{ encoding: 'utf8' },
	);

	if ((preCheck.status ?? 1) !== 0) {
		// ls-remote error (network/auth): fall through to delete + classify on exit code.
		const del = spawnFn(
			'git', ['-C', cwd, 'push', 'origin', '--delete', mergedBranch],
			{ encoding: 'utf8' },
		);
		return (del.status ?? 1) === 0;
	}

	if ((preCheck.stdout ?? '').trim() === '') {
		// Branch already absent on the remote: consider it pruned without deleting.
		return true;
	}

	// Branch is present: attempt delete, then re-derive from end-state.
	const del = spawnFn(
		'git', ['-C', cwd, 'push', 'origin', '--delete', mergedBranch],
		{ encoding: 'utf8' },
	);
	const postCheck = spawnFn(
		'git', ['-C', cwd, 'ls-remote', '--heads', 'origin', mergedBranch],
		{ encoding: 'utf8' },
	);
	if ((postCheck.status ?? 1) !== 0) {
		// Cannot verify post-delete end-state: fall back to delete exit code.
		return (del.status ?? 1) === 0;
	}
	return (postCheck.stdout ?? '').trim() === '';
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Deterministic post-merge primitive.
 *
 * Intended to be invoked by the sidecar after a PR auto-merges to main.
 * Never called inline in ship.
 */
export function runPostMerge(opts: PostMergeOptions): PostMergeOutcome {
	const { cwd, mergedBranch, spawnFn } = opts;

	// Step 0: Check out main before pulling (checkout-main guard pattern, US-R1-002).
	const checkoutResult = spawnFn('git', ['-C', cwd, 'checkout', 'main'], { encoding: 'utf8' });
	if ((checkoutResult.status ?? 1) !== 0) {
		const stderr = (checkoutResult.stderr ?? '').trim();
		printError(`git checkout main failed: ${stderr || '(no output)'}`);
		return { ok: false, reason: 'checkout-main-failed' };
	}

	// Step 1: git pull origin main
	const pullResult = spawnFn('git', ['-C', cwd, 'pull', 'origin', 'main'], { encoding: 'utf8' });
	if ((pullResult.status ?? 1) !== 0) {
		const stderr = (pullResult.stderr ?? '').trim();
		printError(`git pull origin main failed: ${stderr || '(no output)'}`);
		return { ok: false, reason: 'pull-failed' };
	}

	// Get the HEAD sha after the pull.
	const shaResult = spawnFn('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	const pulledSha = (shaResult.stdout ?? '').trim();

	// Step 2: Read version from src/version.ts on main AFTER pull.
	const tagResult = readVersionTag(cwd, opts.readVersionFile);
	if (typeof tagResult !== 'string') return tagResult;
	const tag = tagResult;

	// Step 3: Idempotent tag step.
	const tagStepResult = performTagStep(spawnFn, cwd, tag);
	if ('ok' in tagStepResult) return tagStepResult;
	const { tagCreated } = tagStepResult;

	// Step 4: Delete merged branch locally (best-effort, non-fatal).
	const deleteLocalResult = spawnFn(
		'git', ['-C', cwd, 'branch', '-d', mergedBranch], { encoding: 'utf8' },
	);
	const branchPrunedLocal = (deleteLocalResult.status ?? 1) === 0;

	// Step 5: Delete merged branch on origin (best-effort, non-fatal).
	// End-state classification via ls-remote pre-check avoids false 'remote: FAILED'
	// when GitHub already auto-deleted the head branch on merge (ci-gated mode).
	const branchPrunedRemote = checkAndPruneRemoteBranch(spawnFn, cwd, mergedBranch);

	return { ok: true, pulledSha, tag, tagCreated, branchPrunedLocal, branchPrunedRemote };
}
