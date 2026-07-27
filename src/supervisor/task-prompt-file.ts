// src/supervisor/task-prompt-file.ts
//
// Per-dispatch task-prompt transport (US-001, CAM-433). Worker prompts can be
// much larger than tmux's packed argv limit, so rendered worker commands carry
// only a stable path and read the prompt when the pane shell executes.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TASK_PROMPT_FILE_STEM = '.cam-task-prompt-';

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
