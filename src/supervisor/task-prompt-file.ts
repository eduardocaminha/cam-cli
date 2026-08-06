// src/supervisor/task-prompt-file.ts
//
// Per-dispatch task-prompt transport (US-001, CAM-433). Worker prompts can be
// much larger than tmux's packed argv limit, so rendered worker commands carry
// only a stable path and read the prompt when the pane shell executes.
//
// resolveTaskPromptClaudeDirFallback (US-005, CAM-510, site 5 of 5): the
// tmpdir-rooted claudeDir fallback used by plan-runner.ts, worker-dispatch.ts,
// and backend-adapter.ts previously created a fresh top-level
// `cam-cli-task-prompts` directory suffixed with the pid per process -- a
// permanent new entry
// on every dispatch, exactly the class of leak this issue's prior four sites
// fixed. This nests the pid one level under a single fixed, reused parent
// instead (`tmpdir()/cam-cli-task-prompts/<pid>/.claude`), mirroring
// src/release/ship-pr-tempfile.ts's shape: prune-by-age over OTHER pid
// siblings only (never reap-all-before-write, since a second live cam process
// owns its own pid directory), reading only the fixed parent's own direct
// children, never the shared temp root (GOTCHA 5).

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TASK_PROMPT_FILE_STEM = '.cam-task-prompt-';

/** Fixed, reused top-level directory name under tmpdir() for the claudeDir fallback. */
export const TASK_PROMPT_ROOT_DIR_NAME = 'cam-cli-task-prompts';

/** Sibling pid subdirectories older than this are pruned as abandoned (ms). */
const STALE_PID_DIR_AGE_MS = 60 * 60 * 1000;

/**
 * Removes stale sibling pid subdirectories under `parent`, skipping
 * `ownPidDirName` unconditionally so a live in-flight fallback claudeDir
 * written earlier by THIS process is never at risk, and tolerating removal
 * failures (a concurrent process may already be cleaning up its own
 * directory).
 */
function pruneStaleTaskPromptPidSiblings(parent: string, ownPidDirName: string): void {
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
			// process's own resolution.
		}
	}
}

/**
 * Resolves the tmpdir-rooted fallback claudeDir used by plan/worker dispatch
 * when no explicit claudeDir override is supplied. The single shared
 * definition for all three call sites (plan-runner.ts, worker-dispatch.ts,
 * backend-adapter.ts) so the fixed-parent invariant cannot drift back apart.
 */
export function resolveTaskPromptClaudeDirFallback(): string {
	const parent = join(tmpdir(), TASK_PROMPT_ROOT_DIR_NAME);
	mkdirSync(parent, { recursive: true });

	const ownPidDirName = String(process.pid);
	pruneStaleTaskPromptPidSiblings(parent, ownPidDirName);

	const ownDir = join(parent, ownPidDirName);
	mkdirSync(ownDir, { recursive: true });

	return join(ownDir, '.claude');
}

function taskPromptFilename(uuid: string): string {
	if (!/^[A-Za-z0-9-]+$/.test(uuid)) {
		throw new Error('task prompt dispatch uuid must contain only letters, numbers, and hyphens');
	}
	return `${TASK_PROMPT_FILE_STEM}${uuid}.txt`;
}

/**
 * Reap every prior task-prompt sibling, then write this dispatch's prompt.
 *
 * Reaping before every write gives the lifecycle a hard upper bound of one
 * prompt file across planner, auditor, implementer, reviewer, and later cycles.
 */
export function writeTaskPromptFile(claudeDir: string, uuid: string, prompt: string): string {
	mkdirSync(claudeDir, { recursive: true });
	for (const entry of readdirSync(claudeDir, { withFileTypes: true })) {
		if (entry.name.startsWith(TASK_PROMPT_FILE_STEM)) {
			rmSync(join(claudeDir, entry.name), { recursive: true, force: true });
		}
	}

	const path = join(claudeDir, taskPromptFilename(uuid));
	writeFileSync(path, prompt, 'utf8');
	return path;
}

/**
 * Remove one completed dispatch's prompt file.
 *
 * Terminal owners call this as soon as the dispatched worker produces its
 * report, times out, or fails to dispatch. `force:true` keeps cleanup
 * idempotent when a later prompt write already reaped the same file.
 */
export function removeTaskPromptFile(claudeDir: string, uuid: string): void {
	rmSync(join(claudeDir, taskPromptFilename(uuid)), { force: true });
}

function shellEscapePath(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Render one shell argument that reads a prompt file at exec time.
 *
 * Double quotes keep the prompt in one argv entry and prevent its dollar
 * signs, backticks, quotes, or newlines from being re-parsed as shell syntax.
 * POSIX command substitution intentionally removes trailing newline bytes;
 * task prompts are authored without a final newline and the boundary behavior
 * is pinned by the real-subprocess test.
 */
export function taskPromptFileArgument(path: string): string {
	return `"$(cat -- ${shellEscapePath(path)})"`;
}
