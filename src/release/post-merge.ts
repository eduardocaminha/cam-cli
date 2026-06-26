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

	// Step 1: git pull origin main
	const pullResult = spawnFn(
		'git',
		['-C', cwd, 'pull', 'origin', 'main'],
		{ encoding: 'utf8' },
	);
	if ((pullResult.status ?? 1) !== 0) {
		const stderr = (pullResult.stderr ?? '').trim();
		printError(`git pull origin main failed: ${stderr || '(no output)'}`);
		return { ok: false, reason: 'pull-failed' };
	}

	// Get the HEAD sha after the pull.
	const shaResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const pulledSha = (shaResult.stdout ?? '').trim();

	// Step 2: Read version from src/version.ts on main AFTER pull.
	//         Using the file on disk (not CAM_VERSION from the running binary)
	//         ensures a stale installed binary cannot mis-tag.
	const versionTsPath = `${cwd}/src/version.ts`;
	let versionContent: string;
	try {
		const reader: ReadVersionFileFn =
			opts.readVersionFile ?? ((p) => readFileSync(p, 'utf8'));
		versionContent = reader(versionTsPath);
	} catch (_err) {
		printError('could not read src/version.ts after pull');
		return { ok: false, reason: 'version-file-read-failed' };
	}

	const version = parseVersionFromContent(versionContent);
	if (version === undefined) {
		printError('could not parse CAM_VERSION from src/version.ts');
		return { ok: false, reason: 'version-parse-failed' };
	}
	const tag = `v${version}`;

	// Step 3: Idempotent tag step.
	//         Check whether the tag already exists before creating.
	const listResult = spawnFn(
		'git',
		['-C', cwd, 'tag', '-l', tag],
		{ encoding: 'utf8' },
	);
	const existingTag = (listResult.stdout ?? '').trim();
	let tagCreated = false;

	if (existingTag === tag) {
		// Tag already exists: idempotent no-op.
		printSuccess(`tag ${tag} already exists`, '(no-op)');
	} else {
		// Create the tag on the current main HEAD.
		const createResult = spawnFn(
			'git',
			['-C', cwd, 'tag', tag],
			{ encoding: 'utf8' },
		);
		if ((createResult.status ?? 1) !== 0) {
			const stderr = (createResult.stderr ?? '').trim();
			printError(`git tag ${tag} failed: ${stderr || '(no output)'}`);
			return { ok: false, reason: 'tag-create-failed' };
		}

		// Push the tag to origin.
		const pushTagResult = spawnFn(
			'git',
			['-C', cwd, 'push', 'origin', tag],
			{ encoding: 'utf8' },
		);
		if ((pushTagResult.status ?? 1) !== 0) {
			const stderr = (pushTagResult.stderr ?? '').trim();
			printError(
				`git push origin ${tag} failed: ${stderr || '(no output)'}`,
				'tag was created locally but not pushed',
			);
			return { ok: false, reason: 'tag-push-failed' };
		}

		tagCreated = true;
		printSuccess(`tagged and pushed ${tag}`);
	}

	// Step 4: Delete merged branch locally (best-effort, non-fatal).
	const deleteLocalResult = spawnFn(
		'git',
		['-C', cwd, 'branch', '-d', mergedBranch],
		{ encoding: 'utf8' },
	);
	const branchPrunedLocal = (deleteLocalResult.status ?? 1) === 0;

	// Step 5: Delete merged branch on origin (best-effort, non-fatal).
	const deleteRemoteResult = spawnFn(
		'git',
		['-C', cwd, 'push', 'origin', '--delete', mergedBranch],
		{ encoding: 'utf8' },
	);
	const branchPrunedRemote = (deleteRemoteResult.status ?? 1) === 0;

	return {
		ok: true,
		pulledSha,
		tag,
		tagCreated,
		branchPrunedLocal,
		branchPrunedRemote,
	};
}
