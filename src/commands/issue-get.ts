// src/commands/issue-get.ts
//
// Deterministic, read-only issue lookup used by the web runtime.
// JSON fetch from main (US-002, CAM-400).
//
// De-inlines the ad hoc `git show main:.gateship/issues/<PREFIX>-NNNN.json`
// shell-out several templates currently spawn inline (reading a single issue's
// JSON as part of an LLM-driven slash command) into one deterministic CLI
// primitive. Read-only: unlike close/abandon/demote (US-002/US-003, CAM-210)
// this never mutates or commits anything.
//
// Reuses issueFilePath for the GSHIP-42 -> GSHIP-0042.json
// zero-padding instead of re-implementing id parsing, and BacklogSpawnFn for
// the injectable spawnSync type so tests never shell out (mirrors
// readBacklogFromMain's cat-file read path).

import { spawnSync } from 'node:child_process';
import { issueFilePath, type BacklogSpawnFn } from '../issues/backlog.ts';

export type GetIssueOnMainOutcome =
	| { ok: true; id: string; content: string }
	| { ok: false; reason: 'not-found' };

/**
 * Read a single issue's JSON blob from `<ref>:.gateship/issues/<PREFIX>-NNNN.json`
 * via `git show`. Always reads from a committed ref (never the working tree),
 * matching the read-from-main invariant readBacklogFromMain establishes.
 *
 * @param cwd     Absolute path to the git repo root.
 * @param id      Issue id (e.g. 'GSHIP-42'); resolved to its zero-padded on-disk
 *                filename via issueFilePath (e.g. '.gateship/issues/GSHIP-0042.json').
 * @param spawnFn Injectable spawnSync (defaults to node:child_process.spawnSync).
 * @param ref     Ref to read from. Defaults to the local `main` every legacy
 *                caller already relies on; the web runtime passes its own
 *                remote-tracking source ref (RUNTIME_SOURCE_REF) instead.
 */
export function getIssueOnMain(
	cwd: string,
	id: string,
	spawnFn: BacklogSpawnFn = spawnSync,
	ref = 'main',
): GetIssueOnMainOutcome {
	const filePath = issueFilePath(id);
	const result = spawnFn('git', ['-C', cwd, 'show', `${ref}:${filePath}`], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) {
		return { ok: false, reason: 'not-found' };
	}
	return { ok: true, id, content: result.stdout ?? '' };
}
