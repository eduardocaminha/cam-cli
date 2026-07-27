import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
	TASK_PROMPT_FILE_STEM,
	removeTaskPromptFile,
	taskPromptFileArgument,
	writeTaskPromptFile,
} from '../../src/supervisor/task-prompt-file.ts';

const dirsToCleanup: string[] = [];

function makeClaudeDir(): string {
	const root = mkdtempSync(join(tmpdir(), 'cam-task-prompt-'));
	dirsToCleanup.push(root);
	return join(root, '.claude');
}

function readThroughRealShell(path: string): Buffer {
	const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${taskPromptFileArgument(path)}`]);
	expect(result.status).toBe(0);
	return result.stdout;
}

afterEach(() => {
	for (const dir of dirsToCleanup) rmSync(dir, { recursive: true, force: true });
	dirsToCleanup.length = 0;
});

describe('writeTaskPromptFile', () => {
	test('writes the prompt to the dispatch-uuid path and returns that path', () => {
		const claudeDir = makeClaudeDir();
		const prompt = 'Implement US-001 exactly.';

		const path = writeTaskPromptFile(claudeDir, 'dispatch-123', prompt);

		expect(path).toBe(join(claudeDir, '.cam-task-prompt-dispatch-123.txt'));
		expect(readFileSync(path, 'utf8')).toBe(prompt);
	});

	test('reaps every stale sibling matching the stem before each write, retaining at most one prompt file', () => {
		const claudeDir = makeClaudeDir();
		const first = writeTaskPromptFile(claudeDir, 'first', 'first prompt');
		writeFileSync(join(claudeDir, `${TASK_PROMPT_FILE_STEM}stale.bin`), 'stale');
		writeFileSync(join(claudeDir, 'unrelated.txt'), 'keep');

		const second = writeTaskPromptFile(claudeDir, 'second', 'second prompt');
		const promptSiblings = readdirSync(claudeDir).filter((name) => name.startsWith(TASK_PROMPT_FILE_STEM));

		expect(promptSiblings).toEqual(['.cam-task-prompt-second.txt']);
		expect(first).not.toBe(second);
		expect(readFileSync(second, 'utf8')).toBe('second prompt');
		expect(readFileSync(join(claudeDir, 'unrelated.txt'), 'utf8')).toBe('keep');
	});

	test('exec-time read delivers quotes, dollar signs, backticks, and embedded newlines byte-intact to a real subprocess', () => {
		const claudeDir = makeClaudeDir();
		const prompt = 'double " quote, dollar $HOME, backtick `uname`\nsecond line';
		const path = writeTaskPromptFile(claudeDir, 'injection-safe', prompt);

		expect(readThroughRealShell(path).equals(Buffer.from(prompt))).toBe(true);
	});

	test('exec-time command substitution strips trailing newlines while preserving all other bytes', () => {
		const claudeDir = makeClaudeDir();
		const path = writeTaskPromptFile(claudeDir, 'trailing-newlines', 'body\nline\n\n');

		expect(readThroughRealShell(path).equals(Buffer.from('body\nline'))).toBe(true);
		expect(readFileSync(path, 'utf8')).toBe('body\nline\n\n');
	});

	test('terminal cleanup removes only the named dispatch prompt and is idempotent', () => {
		const claudeDir = makeClaudeDir();
		const path = writeTaskPromptFile(claudeDir, 'terminal', 'done');
		writeFileSync(join(claudeDir, 'unrelated.txt'), 'keep');

		removeTaskPromptFile(claudeDir, 'terminal');
		removeTaskPromptFile(claudeDir, 'terminal');

		expect(existsSync(path)).toBe(false);
		expect(readFileSync(join(claudeDir, 'unrelated.txt'), 'utf8')).toBe('keep');
	});
});
