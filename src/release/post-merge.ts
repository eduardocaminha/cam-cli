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
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { printError, printSuccess } from '../logging/color.ts';
import {
	closeIssueOnMain,
	abandonIssueOnMain,
	type CloseIssueOnMainOutcome,
	type AbandonIssueOnMainOutcome,
	type SpawnFn as CloseSpawnFn,
} from '../commands/issue-specify.ts';

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

/**
 * Injectable seam for closing the target issue on main.
 * Defaults to closeIssueOnMain from issue-specify.ts.
 * Tests inject a function that returns a canned outcome.
 */
export type CloseIssueFn = (cwd: string, id: string) => CloseIssueOnMainOutcome;

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
	/**
	 * Issue id to close after the tag and branch prune succeed (e.g. "CAM-121").
	 * When absent, no close is attempted and behavior is unchanged.
	 */
	closeIssueId?: string;
	/**
	 * Injectable seam for closing the target issue on main.
	 * Defaults to closeIssueOnMain (production default).
	 * Inject a stub in tests to avoid real git operations.
	 */
	closeIssueFn?: CloseIssueFn;
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
			/**
			 * Result of closing the target issue on main (present when closeIssueId
			 * was supplied). When ok:false, the close failed (e.g. not-found) and
			 * runPostMerge emitted a printError; the git steps all succeeded.
			 */
			closeResult?: CloseIssueOnMainOutcome;
	  }
	| { ok: false; reason: string; completedSteps: string[]; remainingSteps: string[] };

// ---------------------------------------------------------------------------
// Step vocabulary (US-002)
// ---------------------------------------------------------------------------

/**
 * Ordered vocabulary of runPostMerge's steps. Used to derive completedSteps /
 * remainingSteps on every failure path so a caller (e.g. the sidecar's
 * post-merge-stalled marker, US-003) knows exactly where the sequence stopped.
 *
 * "tag" covers the version read + idempotent tag create/push (both are part
 * of the same logical step in this vocabulary). "prune" and "close" are
 * best-effort/non-fatal and never produce a failure outcome themselves.
 */
const ALL_STEPS = ['checkout', 'pull-rebase', 'tag', 'prune', 'close'] as const;
type StepName = (typeof ALL_STEPS)[number];

/**
 * Build a failure outcome for a failure at `step`: everything strictly
 * before `step` is completed, `step` itself (which did not finish) and
 * everything after it are remaining.
 */
function failAt(step: StepName, reason: string): PostMergeOutcome & { ok: false } {
	const idx = ALL_STEPS.indexOf(step);
	return {
		ok: false,
		reason,
		completedSteps: [...ALL_STEPS.slice(0, idx)],
		remainingSteps: [...ALL_STEPS.slice(idx)],
	};
}

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

type FailOutcome = { ok: false; reason: string; completedSteps: string[]; remainingSteps: string[] };

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
		return failAt('tag', 'version-file-read-failed');
	}
	const version = parseVersionFromContent(versionContent);
	if (version === undefined) {
		printError('could not parse CAM_VERSION from src/version.ts');
		return failAt('tag', 'version-parse-failed');
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
		return failAt('tag', 'tag-create-failed');
	}

	const pushTagResult = spawnFn('git', ['-C', cwd, 'push', 'origin', tag], { encoding: 'utf8' });
	if ((pushTagResult.status ?? 1) !== 0) {
		const stderr = (pushTagResult.stderr ?? '').trim();
		printError(
			`git push origin ${tag} failed: ${stderr || '(no output)'}`,
			'tag was created locally but not pushed',
		);
		return failAt('tag', 'tag-push-failed');
	}

	printSuccess(`tagged and pushed ${tag}`);
	return { tagCreated: true };
}

/**
 * Determine whether the local branch is pruned, using rev-parse end-state
 * classification instead of the delete command's exit code.
 *
 * Logic (US-002):
 *   1. Pre-check via `git rev-parse --verify --quiet refs/heads/<branch>`:
 *      - Non-zero exit or empty stdout => branch already absent => return true.
 *   2. Branch present (exit 0, non-empty stdout): run `git branch -D <branch>`
 *      (force delete; safe only from a confirmed-MERGED state).
 *   3. Post-delete rev-parse check: absent => return true, present => false.
 *
 * SAFETY NOTE: `git branch -D` (force) is safe ONLY because runPostMerge is
 * invoked after processPollResult confirms state === 'MERGED'. Never call this
 * helper from a non-MERGED path.
 */
function checkAndPruneLocalBranch(
	spawnFn: SpawnFn,
	cwd: string,
	mergedBranch: string,
): boolean {
	const revParseArgs = [
		'-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${mergedBranch}`,
	];

	const preCheck = spawnFn('git', revParseArgs, { encoding: 'utf8' });
	const preAbsent =
		(preCheck.status ?? 1) !== 0 || (preCheck.stdout ?? '').trim() === '';

	if (preAbsent) {
		// Branch already absent locally: consider it pruned.
		return true;
	}

	// Branch is present: force-delete it (idempotent when already merged to main).
	spawnFn('git', ['-C', cwd, 'branch', '-D', mergedBranch], { encoding: 'utf8' });

	// Derive result from post-delete end-state (not from the delete exit code).
	const postCheck = spawnFn('git', revParseArgs, { encoding: 'utf8' });
	return (postCheck.status ?? 1) !== 0 || (postCheck.stdout ?? '').trim() === '';
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
// Close-issue step helper + production default for closeIssueFn
// ---------------------------------------------------------------------------

/**
 * Perform the optional issue-close step (Step 6 of runPostMerge).
 * Extracted to keep runPostMerge under the biome 15-complexity limit.
 */
function performCloseStep(
	cwd: string,
	closeIssueId: string,
	closeIssueFnArg: CloseIssueFn | undefined,
): CloseIssueOnMainOutcome {
	const closeFn = closeIssueFnArg ?? defaultCloseIssueFn;
	const result = closeFn(cwd, closeIssueId);
	if (!result.ok) {
		printError(
			`close issue ${closeIssueId} failed: ${result.reason}`,
			'issue was not marked shipped; please close manually',
		);
	}
	return result;
}

/**
 * Production default CloseIssueFn: wraps closeIssueOnMain with a real spawnSync.
 * Used when closeIssueFn is absent but closeIssueId is present.
 * Tests always inject a stub so this path is never exercised in unit tests.
 *
 * Exported so other production callers that need to close an issue on main
 * (e.g. the sidecar's ship-phase PR-create step, US-004 CAM-149) reuse the
 * exact same real-spawnSync wiring instead of duplicating it (jscpd gate).
 */
export function defaultCloseIssueFn(closeCwd: string, id: string): CloseIssueOnMainOutcome {
	const closeSpawnFn: CloseSpawnFn = (cmd, args, opts) =>
		spawnSync(cmd, args, {
			encoding: opts.encoding,
			...(opts.env !== undefined ? { env: opts.env } : {}),
			...(opts.input !== undefined ? { input: opts.input } : {}),
		}) as SpawnSyncReturns<string>;
	return closeIssueOnMain({
		cwd: closeCwd,
		id,
		spawnFn: closeSpawnFn,
		clock: () => new Date().toISOString(),
	});
}

/**
 * Production default AbandonIssueFn: wraps abandonIssueOnMain with a real spawnSync.
 * Mirrors defaultCloseIssueFn's wiring exactly (same real-spawnSync closure shape).
 *
 * Exported so other production callers that need to abandon an issue on main
 * (e.g. the `cam issue abandon <id>` positional subcommand, US-003 CAM-210)
 * reuse this exact wiring instead of duplicating a spawnFn closure inline
 * (jscpd gate).
 */
export function defaultAbandonIssueFn(abandonCwd: string, id: string): AbandonIssueOnMainOutcome {
	const abandonSpawnFn: CloseSpawnFn = (cmd, args, opts) =>
		spawnSync(cmd, args, {
			encoding: opts.encoding,
			...(opts.env !== undefined ? { env: opts.env } : {}),
			...(opts.input !== undefined ? { input: opts.input } : {}),
		}) as SpawnSyncReturns<string>;
	return abandonIssueOnMain({
		cwd: abandonCwd,
		id,
		spawnFn: abandonSpawnFn,
		clock: () => new Date().toISOString(),
	});
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
		return failAt('checkout', 'checkout-main-failed');
	}

	// Step 1: git pull --rebase origin main.
	// --rebase (not a plain pull, and never an auto-reset) drops a local commit
	// that main's squash-merge already subsumed via patch-id comparison,
	// replaying anything genuinely un-squashed on top; a real divergence fails
	// the rebase loudly instead of silently discarding work.
	const pullResult = spawnFn(
		'git', ['-C', cwd, 'pull', '--rebase', 'origin', 'main'], { encoding: 'utf8' },
	);
	if ((pullResult.status ?? 1) !== 0) {
		const stderr = (pullResult.stderr ?? '').trim();
		printError(`git pull --rebase origin main failed: ${stderr || '(no output)'}`);
		return failAt('pull-rebase', 'rebase-failed');
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
	// End-state classification via rev-parse avoids false failure when the local
	// branch was already absent (often pruned by the next cycle's pre-flight).
	const branchPrunedLocal = checkAndPruneLocalBranch(spawnFn, cwd, mergedBranch);

	// Step 5: Delete merged branch on origin (best-effort, non-fatal).
	// End-state classification via ls-remote pre-check avoids false 'remote: FAILED'
	// when GitHub already auto-deleted the head branch on merge (ci-gated mode).
	const branchPrunedRemote = checkAndPruneRemoteBranch(spawnFn, cwd, mergedBranch);

	// Step 6: Close the target issue on main (optional, additive, non-fatal to git steps).
	// Runs after all git steps so commitTreeToMain reads the correct main HEAD.
	const closeResult = opts.closeIssueId !== undefined
		? performCloseStep(cwd, opts.closeIssueId, opts.closeIssueFn)
		: undefined;

	return {
		ok: true,
		pulledSha,
		tag,
		tagCreated,
		branchPrunedLocal,
		branchPrunedRemote,
		...(closeResult !== undefined ? { closeResult } : {}),
	};
}
