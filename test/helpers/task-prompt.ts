import { spawnSync } from 'node:child_process';

const PROMPT_ARGUMENT_RE = /"\$\(cat -- ([^)]+)\)"/;

/**
 * Resolve the task-prompt argument through the same real shell read rendered
 * by the adapter. Call this before the next dispatch reaps the current file.
 */
export function readTaskPromptFromCommand(command: string): string {
	const match = PROMPT_ARGUMENT_RE.exec(command);
	if (match?.[1] === undefined) {
		throw new Error(`task prompt file argument not found: ${command}`);
	}
	const result = spawnSync('/bin/sh', ['-c', `printf '%s' "$(cat -- ${match[1]})"`], {
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		throw new Error(`task prompt file read failed: ${result.stderr}`);
	}
	return result.stdout;
}
