// src/commands/tag.ts
//
// runTag() -- deterministic post-merge tag command.
//
// Creates and pushes the vX.Y.Z git tag that matches the current CAM_VERSION
// on the main branch HEAD. Intended to be run by the operator after a PR
// squash-merges to main (squash mints a new SHA, so branch-side tagging is
// broken).
//
// Guards (all refuse with non-zero exit):
//   - Current branch must be `main`.
//   - Working tree must be clean (git status --porcelain empty).
//
// Idempotency: if the tag already exists, it is a no-op (exit 0 + message).
//
// All git interactions go through an injectable SpawnFn so tests are hermetic.
//
// US-005 (CAM-89).

import type { SpawnSyncReturns } from 'node:child_process';
import { CAM_VERSION } from '../version.ts';
import { printError, printHint, printSuccess } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types (same pattern as finalizeCycleClose)
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TagOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
}

export type TagResult =
	| { ok: true; tag: string; alreadyExisted: boolean }
	| { ok: false; reason: string };

/**
 * Create and push the vX.Y.Z tag that matches CAM_VERSION.
 *
 * Steps:
 *   1. Verify current branch is `main`.
 *   2. Verify working tree is clean.
 *   3. Check whether the tag already exists; if so, return idempotent no-op.
 *   4. Create tag: `git tag vX.Y.Z`.
 *   5. Push tag: `git push origin vX.Y.Z`.
 */
export function runTag(opts: TagOptions): TagResult {
	const tag = `v${CAM_VERSION}`;

	// Guard 1: must be on main.
	const branchResult = opts.spawnFn(
		'git',
		['rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const branch = (branchResult.stdout ?? '').trim();
	if (branch !== 'main') {
		printError(
			`cam tag must run on main (current branch: ${branch || '(detached)'})`,
			'check out main first',
		);
		return { ok: false, reason: 'not-main' };
	}

	// Guard 2: working tree must be clean.
	const statusResult = opts.spawnFn(
		'git',
		['status', '--porcelain'],
		{ encoding: 'utf8' },
	);
	const statusOutput = (statusResult.stdout ?? '').trim();
	if (statusOutput.length > 0) {
		printError(
			'cam tag requires a clean working tree',
			'commit or stash changes first',
		);
		return { ok: false, reason: 'dirty-working-tree' };
	}

	// Idempotency: check if the tag already exists.
	const listResult = opts.spawnFn(
		'git',
		['tag', '-l', tag],
		{ encoding: 'utf8' },
	);
	const existingTag = (listResult.stdout ?? '').trim();
	if (existingTag === tag) {
		printSuccess(`tag ${tag} already exists`, '(no-op)');
		printHint(`push it manually: git push origin ${tag}`);
		return { ok: true, tag, alreadyExisted: true };
	}

	// Create the tag.
	const createResult = opts.spawnFn(
		'git',
		['tag', tag],
		{ encoding: 'utf8' },
	);
	if ((createResult.status ?? 1) !== 0) {
		const stderr = (createResult.stderr ?? '').trim();
		printError(`git tag failed: ${stderr || '(no output)'}`);
		return { ok: false, reason: 'tag-create-failed' };
	}

	// Push the tag.
	const pushResult = opts.spawnFn(
		'git',
		['push', 'origin', tag],
		{ encoding: 'utf8' },
	);
	if ((pushResult.status ?? 1) !== 0) {
		const stderr = (pushResult.stderr ?? '').trim();
		printError(`git push origin ${tag} failed: ${stderr || '(no output)'}`, 'tag was created locally');
		return { ok: false, reason: 'tag-push-failed' };
	}

	printSuccess(`tagged and pushed ${tag}`);
	return { ok: true, tag, alreadyExisted: false };
}
