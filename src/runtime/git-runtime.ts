import { spawnSync } from 'node:child_process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import type { RuntimeVerifier } from './run-runtime.ts';

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type GitCommandRunner = (cwd: string, args: string[]) => CommandResult;

export interface GitRuntimeOptions {
	runGit?: GitCommandRunner;
	issueExists?: (cwd: string, issueId: string) => boolean;
}

export class RuntimePreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RuntimePreflightError';
	}
}

function defaultRunGit(cwd: string, args: string[]): CommandResult {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function defaultIssueExists(cwd: string, issueId: string): boolean {
	return getIssueOnMain(cwd, issueId).ok;
}

function commandFailure(label: string, result: CommandResult): RuntimePreflightError {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
	return new RuntimePreflightError(`${label}: ${detail}`);
}

export function createGitRuntimePreflight(
	cwd: string,
	options: GitRuntimeOptions = {},
): (issueId: string) => void {
	const runGit = options.runGit ?? defaultRunGit;
	const issueExists = options.issueExists ?? defaultIssueExists;
	return (issueId) => {
		if (!issueExists(cwd, issueId)) {
			throw new RuntimePreflightError(`issue not found on main: ${issueId}`);
		}
		const branch = runGit(cwd, ['branch', '--show-current']);
		if (branch.exitCode !== 0) throw commandFailure('cannot read current branch', branch);
		const branchName = branch.stdout.trim();
		if (branchName.length === 0 || branchName === 'main' || branchName === 'master') {
			throw new RuntimePreflightError('a durable run requires a non-main branch');
		}
		const status = runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
		if (status.exitCode !== 0) throw commandFailure('cannot read working tree', status);
		if (status.stdout.trim().length > 0) {
			throw new RuntimePreflightError('a durable run requires a clean working tree');
		}
	};
}

export class GitWorkingTreeVerifier implements RuntimeVerifier {
	readonly #runGit: GitCommandRunner;

	constructor(options: GitRuntimeOptions = {}) {
		this.#runGit = options.runGit ?? defaultRunGit;
	}

	async verify(input: Parameters<RuntimeVerifier['verify']>[0]) {
		for (const args of [['diff', '--check'], ['diff', '--cached', '--check']]) {
			const result = this.#runGit(input.cwd, args);
			if (result.exitCode !== 0) {
				return { ok: false, detail: commandFailure('git diff check failed', result).message };
			}
		}
		const status = this.#runGit(input.cwd, ['status', '--porcelain', '--untracked-files=all']);
		if (status.exitCode !== 0) {
			return { ok: false, detail: commandFailure('cannot read working tree', status).message };
		}
		if (status.stdout.trim().length === 0) {
			return { ok: false, detail: 'executor completed without a working-tree change' };
		}
		return { ok: true };
	}
}
