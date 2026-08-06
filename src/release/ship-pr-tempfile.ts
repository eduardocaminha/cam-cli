// src/release/ship-pr-tempfile.ts
//
// writeShipPrTempFile(content) -- production writeTempFile for cam ship's
// PR-body and artifact-comment temp files (US-001, CAM-510).
//
// Prior behavior: `mkdtempSync(join(tmpdir(), 'cam-ship-pr-'))` created a
// fresh top-level randomized directory on the shared OS temp root on every
// `cam ship` invocation, so every run left a permanent cam-ship-pr-XXXXXX
// entry behind. This writes under a single fixed, reused parent
// (`tmpdir()/cam-ship-pr`) instead, nested one level by this process's pid.
//
// Mirrors the reused-parent shape of src/supervisor/task-prompt-file.ts, but
// adapted for concurrency (GOTCHA 8, CAM-510): task-prompt-file.ts reaps ALL
// stem siblings before every write, which is safe there because task-prompt
// files are single-owner per claudeDir. That would be wrong here: multiple
// `cam ship` invocations can run concurrently (different worktrees, same
// shared $TMPDIR), so reaping every sibling before a write could delete a
// second live process's in-flight file. Instead this only prunes OTHER pid
// subdirectories older than STALE_PID_DIR_AGE_MS, and only ever reads this
// fixed parent's own direct children (GOTCHA 5: never the shared temp root
// itself -- enumerating that root is the class of bug this story exists to
// fix).

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/** Fixed, reused top-level directory name under tmpdir(). */
export const SHIP_PR_TEMPDIR_NAME = 'cam-ship-pr';

/** Sibling pid subdirectories older than this are pruned as abandoned (ms). */
const STALE_PID_DIR_AGE_MS = 60 * 60 * 1000;

let fileCounter = 0;

/**
 * Removes stale sibling pid subdirectories under `parent`, skipping
 * `ownPidDirName` unconditionally so a live in-flight file written earlier
 * by THIS process is never at risk, and tolerating removal failures (a
 * concurrent process may already be cleaning up its own directory).
 */
function pruneStalePidSiblings(parent: string, ownPidDirName: string): void {
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (entry === ownPidDirName) continue;
		const entryPath = join(parent, entry);
		try {
			const info = statSync(entryPath);
			if (now - info.mtimeMs > STALE_PID_DIR_AGE_MS) {
				rmSync(entryPath, { recursive: true, force: true });
			}
		} catch {
			// Transient stat/removal failure on a sibling must never fail this
			// process's own write.
		}
	}
}

/**
 * Writes `content` to a fresh file under the fixed, reused ship-pr temp
 * parent and returns its absolute path. Safe to call more than once per
 * process (the PR-body and artifact-comment call sites, ship-pr.ts, both use
 * it): each call gets a distinct filename inside this process's own pid
 * subdirectory, and earlier files written by the same process are never
 * pruned.
 */
export function writeShipPrTempFile(content: string): string {
	const parent = join(tmpdir(), SHIP_PR_TEMPDIR_NAME);
	mkdirSync(parent, { recursive: true });

	const ownPidDirName = String(process.pid);
	pruneStalePidSiblings(parent, ownPidDirName);

	const ownDir = join(parent, ownPidDirName);
	mkdirSync(ownDir, { recursive: true });

	const filePath = join(ownDir, `body-${fileCounter++}.md`);
	writeFileSync(filePath, content, 'utf8');
	return filePath;
}
