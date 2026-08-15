import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type WorkspaceGitRunner = (cwd: string, args: string[]) => GitResult;

export interface PrepareWorkspaceInput {
	runId: string;
	issueId: string;
}

export interface RuntimeWorkspace {
	prepare: (input: PrepareWorkspaceInput) => string;
}

export class RuntimeWorkspaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RuntimeWorkspaceError';
	}
}

function defaultRunGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function safeSegment(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return sanitized.length === 0 || sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

function failureDetail(result: GitResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

export class GitWorkspaceManager implements RuntimeWorkspace {
	readonly #projectRoot: string;
	readonly #runGit: WorkspaceGitRunner;

	constructor(projectRoot: string, runGit: WorkspaceGitRunner = defaultRunGit) {
		this.#projectRoot = resolve(projectRoot);
		this.#runGit = runGit;
	}

	prepare(input: PrepareWorkspaceInput): string {
		const main = this.#runGit(this.#projectRoot, ['rev-parse', '--verify', 'main']);
		if (main.exitCode !== 0) {
			throw new RuntimeWorkspaceError(`cannot resolve main: ${failureDetail(main)}`);
		}

		const runSegment = safeSegment(input.runId, 'run');
		const issueSegment = safeSegment(input.issueId, 'issue');
		const worktreesRoot = resolve(this.#projectRoot, '.gship', 'worktrees');
		const workspacePath = resolve(worktreesRoot, runSegment);
		if (!workspacePath.startsWith(`${worktreesRoot}${sep}`)) {
			throw new RuntimeWorkspaceError('workspace path escaped the managed root');
		}
		if (existsSync(workspacePath)) {
			throw new RuntimeWorkspaceError(`workspace already exists: ${workspacePath}`);
		}

		mkdirSync(worktreesRoot, { recursive: true });
		const branch = `gship/${issueSegment}-${runSegment.slice(0, 8)}`;
		const added = this.#runGit(this.#projectRoot, [
			'worktree',
			'add',
			'-b',
			branch,
			workspacePath,
			'main',
		]);
		if (added.exitCode !== 0) {
			throw new RuntimeWorkspaceError(`cannot create run workspace: ${failureDetail(added)}`);
		}
		return workspacePath;
	}
}
