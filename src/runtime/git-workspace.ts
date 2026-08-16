import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type WorkspaceGitRunner = (cwd: string, args: string[]) => CommandResult;

export type WorkspaceInstallRunner = (cwd: string, args: string[]) => CommandResult;

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

function defaultRunGit(cwd: string, args: string[]): CommandResult {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function defaultRunInstall(cwd: string, args: string[]): CommandResult {
	const result = spawnSync('bun', args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
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

function failureDetail(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

export class GitWorkspaceManager implements RuntimeWorkspace {
	readonly #projectRoot: string;
	readonly #runGit: WorkspaceGitRunner;
	readonly #runInstall: WorkspaceInstallRunner;

	constructor(
		projectRoot: string,
		runGit: WorkspaceGitRunner = defaultRunGit,
		runInstall: WorkspaceInstallRunner = defaultRunInstall,
	) {
		this.#projectRoot = resolve(projectRoot);
		this.#runGit = runGit;
		this.#runInstall = runInstall;
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

		let installed: CommandResult;
		try {
			installed = this.#runInstall(workspacePath, ['install', '--frozen-lockfile']);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new RuntimeWorkspaceError(`cannot start workspace install: ${detail}`);
		}
		if (installed.exitCode !== 0) {
			throw new RuntimeWorkspaceError(
				`cannot install workspace dependencies: ${failureDetail(installed)}`,
			);
		}
		return workspacePath;
	}
}
