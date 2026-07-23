// src/commands/issue-get.ts
//
// Implementation of `cam issue get <id>` -- deterministic, read-only issue
// JSON fetch from main (US-002, CAM-400).
//
// De-inlines the ad hoc `git show main:scripts/cam/issues/<PREFIX>-NNNN.json`
// shell-out several templates currently spawn inline (reading a single issue's
// JSON as part of an LLM-driven slash command) into one deterministic CLI
// primitive. Read-only: unlike close/abandon/demote (US-002/US-003, CAM-210)
// this never mutates or commits anything.
//
// Reuses issueFilePath (src/issues/backlog.ts) for the CAM-42 -> CAM-0042.json
// zero-padding instead of re-implementing id parsing, and BacklogSpawnFn for
// the injectable spawnSync type so tests never shell out (mirrors
// readBacklogFromMain's cat-file read path).

import { spawnSync } from 'node:child_process';
import { issueFilePath, type BacklogSpawnFn } from '../issues/backlog.ts';

export type GetIssueOnMainOutcome =
	| { ok: true; id: string; content: string }
	| { ok: false; reason: 'not-found' };

/**
 * Read a single issue's JSON blob from `main:scripts/cam/issues/<PREFIX>-NNNN.json`
 * via `git show`. Always reads from the `main` ref (never the working tree),
 * matching the read-from-main invariant readBacklogFromMain establishes.
 *
 * @param cwd     Absolute path to the git repo root.
 * @param id      Issue id (e.g. 'CAM-42'); resolved to its zero-padded on-disk
 *                filename via issueFilePath (e.g. 'scripts/cam/issues/CAM-0042.json').
 * @param spawnFn Injectable spawnSync (defaults to node:child_process.spawnSync).
 */
export function getIssueOnMain(
	cwd: string,
	id: string,
	spawnFn: BacklogSpawnFn = spawnSync,
): GetIssueOnMainOutcome {
	const filePath = issueFilePath(id);
	const result = spawnFn('git', ['-C', cwd, 'show', `main:${filePath}`], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) {
		return { ok: false, reason: 'not-found' };
	}
	return { ok: true, id, content: result.stdout ?? '' };
}
