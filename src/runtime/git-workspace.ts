import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
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

export interface ReleaseWorkspaceInput extends PrepareWorkspaceInput {
	workspacePath: string;
	/**
	 * Set by a caller releasing an abandoned or a failed run (GSHIP-658): the
	 * branch only releases once it also has no commit missing from the base
	 * ref, so a commit that reached no other copy stays available for the
	 * operator to inspect. Never set by the merge path: `ship` merges with
	 * `--squash`, so a merged branch's own commits are never reachable from
	 * the base ref even though the work landed there -- the merge itself is
	 * that path's proof, not commit reachability. Also left unset by
	 * `prepare`'s own rollback of a workspace it just created, which can never
	 * carry a commit missing from anywhere.
	 */
	requireUpstream?: boolean;
	/**
	 * Set by a caller that durably recorded an earlier failure to delete this
	 * run's remote branch (GSHIP-658): forces the origin probe even though this
	 * call finds nothing left to release locally, so a previously failed
	 * delete keeps being retried instead of going silently unretried forever
	 * once the local side is already gone.
	 */
	retryRemoteDelete?: boolean;
}

export type WorkspaceReleaseResult =
	| { outcome: 'released' | 'already-released'; branch: string; remoteWarning?: string }
	| { outcome: 'preserved'; branch: string; detail: string };

export interface WorkspaceRunReference extends ReleaseWorkspaceInput {
	/**
	 * `done` releases once the worktree is clean; the merge that got it there
	 * is already its own proof the work landed elsewhere. `cancelled` and
	 * `failed` release the same way as each other but with one more gate: the
	 * branch must also carry no commit missing from the base ref, since
	 * nothing else guarantees that work exists anywhere but that branch --
	 * otherwise it is kept for inspection, on both the local and the remote
	 * side (GSHIP-658).
	 */
	state: 'active' | 'done' | 'failed' | 'cancelled';
}

export interface WorkspaceNotice {
	kind: 'cleanup-failed' | 'dirty' | 'failed-run' | 'orphan';
	runId: string | null;
	workspacePath: string | null;
	branch: string | null;
	detail: string;
}

export interface RuntimeWorkspace {
	prepare: (input: PrepareWorkspaceInput) => string;
	release?: (input: ReleaseWorkspaceInput) => WorkspaceReleaseResult;
	inspect?: (runs: readonly WorkspaceRunReference[]) => WorkspaceNotice[];
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

interface CleanupStepResult {
	changed: boolean;
	detail?: string;
}

function workspaceNotice(
	run: WorkspaceRunReference | undefined,
	workspacePath: string,
	branch: string | null,
	dirty: boolean,
	readable: boolean,
): WorkspaceNotice | null {
	if (run?.state === 'active') return null;
	if (!readable) {
		return {
			kind: run === undefined ? 'orphan' : 'cleanup-failed',
			runId: run?.runId ?? null,
			workspacePath,
			branch,
			detail: 'managed path is not a readable git worktree',
		};
	}
	if (run === undefined) {
		return {
			kind: dirty ? 'dirty' : 'orphan',
			runId: null,
			workspacePath,
			branch,
			detail: 'workspace is not owned by a persisted run',
		};
	}
	if (dirty) {
		return {
			kind: 'dirty',
			runId: run.runId,
			workspacePath,
			branch,
			detail: 'finished workspace has local changes',
		};
	}
	return {
		kind: run.state === 'failed' ? 'failed-run' : 'cleanup-failed',
		runId: run.runId,
		workspacePath,
		branch,
		detail: run.state === 'failed'
			? 'failed run workspace was preserved for inspection'
			: 'finished workspace could not be released',
	};
}

function branchNotice(
	run: WorkspaceRunReference | undefined,
	branch: string,
): WorkspaceNotice | null {
	if (run?.state === 'active') return null;
	return {
		kind: run === undefined ? 'orphan' : run.state === 'failed' ? 'failed-run' : 'cleanup-failed',
		runId: run?.runId ?? null,
		workspacePath: null,
		branch,
		detail: run === undefined
			? 'local gship branch is not owned by a persisted run'
			: 'run branch remains without its managed workspace',
	};
}

export class GitWorkspaceManager implements RuntimeWorkspace {
	readonly #projectRoot: string;
	readonly #runGit: WorkspaceGitRunner;
	readonly #runInstall: WorkspaceInstallRunner;
	readonly #baseRef: string;

	/**
	 * @param baseRef Ref every run branch is cut from. Defaults to the local
	 *                `main`; the web runtime passes its remote-tracking source
	 *                ref so a run starts from the commit the remote published,
	 *                not from whatever the local branch still points at.
	 */
	constructor(
		projectRoot: string,
		runGit: WorkspaceGitRunner = defaultRunGit,
		runInstall: WorkspaceInstallRunner = defaultRunInstall,
		baseRef = 'main',
	) {
		this.#projectRoot = resolve(projectRoot);
		this.#runGit = runGit;
		this.#runInstall = runInstall;
		this.#baseRef = baseRef;
	}

	prepare(input: PrepareWorkspaceInput): string {
		const base = this.#runGit(this.#projectRoot, ['rev-parse', '--verify', this.#baseRef]);
		if (base.exitCode !== 0) {
			throw new RuntimeWorkspaceError(`cannot resolve ${this.#baseRef}: ${failureDetail(base)}`);
		}

		const runSegment = safeSegment(input.runId, 'run');
		const worktreesRoot = this.#worktreesRoot();
		const workspacePath = this.#workspacePath(input.runId);
		if (existsSync(worktreesRoot) && !lstatSync(worktreesRoot).isDirectory()) {
			throw new RuntimeWorkspaceError('managed worktrees root is not a directory');
		}
		if (!workspacePath.startsWith(`${worktreesRoot}${sep}`)) {
			throw new RuntimeWorkspaceError('workspace path escaped the managed root');
		}
		if (existsSync(workspacePath)) {
			throw new RuntimeWorkspaceError(`workspace already exists: ${workspacePath}`);
		}

		mkdirSync(worktreesRoot, { recursive: true });
		const branch = this.#branch(input.issueId, runSegment);
		const added = this.#runGit(this.#projectRoot, [
			'worktree',
			'add',
			'-b',
			branch,
			workspacePath,
			this.#baseRef,
		]);
		if (added.exitCode !== 0) {
			throw new RuntimeWorkspaceError(`cannot create run workspace: ${failureDetail(added)}`);
		}

		let installed: CommandResult;
		try {
			installed = this.#runInstall(workspacePath, ['install', '--frozen-lockfile']);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new RuntimeWorkspaceError(this.#prepareFailure(
				input,
				workspacePath,
				`cannot start workspace install: ${detail}`,
			));
		}
		if (installed.exitCode !== 0) {
			throw new RuntimeWorkspaceError(this.#prepareFailure(
				input,
				workspacePath,
				`cannot install workspace dependencies: ${failureDetail(installed)}`,
			));
		}
		return workspacePath;
	}

	/**
	 * Release only the exact worktree and branch this manager would create for
	 * the run. A dirty, moved, symlinked or otherwise surprising checkout is
	 * preserved for the operator instead of being forced away. A call that
	 * actually releases the worktree and local branch also pushes the delete
	 * for the matching branch on `origin`; a repo with no `origin`, a branch
	 * never published there, or a push failure never turns the release into
	 * `preserved` -- it surfaces as `remoteWarning` instead. A repeat call on
	 * an already-released run (e.g. startup reconciliation replaying run
	 * history) finds nothing left to release locally and skips the origin
	 * probe entirely, so it stays local and offline-safe, unless the caller
	 * sets `retryRemoteDelete` because it durably recorded a previous push
	 * failure for this run and wants it retried.
	 */
	release(input: ReleaseWorkspaceInput): WorkspaceReleaseResult {
		const expectedPath = this.#workspacePath(input.runId);
		const branch = this.#branch(input.issueId, safeSegment(input.runId, 'run'));
		const worktreesRoot = this.#worktreesRoot();
		if (existsSync(worktreesRoot) && !lstatSync(worktreesRoot).isDirectory()) {
			return { outcome: 'preserved', branch, detail: 'managed worktrees root is unsafe' };
		}
		if (resolve(input.workspacePath) !== expectedPath) {
			return {
				outcome: 'preserved',
				branch,
				detail: `workspace path does not belong to run ${input.runId}`,
			};
		}
		if (input.requireUpstream === true) {
			const missing = this.#branchMissingFromBase(branch);
			if (missing instanceof Error) {
				return { outcome: 'preserved', branch, detail: missing.message };
			}
			if (missing) {
				return {
					outcome: 'preserved',
					branch,
					detail: `branch has a commit missing from ${this.#baseRef}`,
				};
			}
		}

		const steps = this.#releaseLocal(expectedPath, branch);
		if (!Array.isArray(steps)) {
			return { outcome: 'preserved', branch, detail: steps.detail };
		}
		return this.#finishRelease(branch, steps, input.retryRemoteDelete === true);
	}

	/** The three purely local cleanup steps, in order, or the detail of whichever one first refuses to proceed. */
	#releaseLocal(
		expectedPath: string,
		branch: string,
	): CleanupStepResult[] | { detail: string } {
		const workspace = this.#removeWorkspace(expectedPath, branch);
		if (workspace.detail !== undefined) return { detail: workspace.detail };
		const localBranch = this.#deleteRef(
			`refs/heads/${branch}`,
			['branch', '-D', '--', branch],
			'cannot delete local branch',
		);
		if (localBranch.detail !== undefined) return { detail: localBranch.detail };
		const remoteTracking = this.#deleteRef(
			`refs/remotes/origin/${branch}`,
			['update-ref', '-d', `refs/remotes/origin/${branch}`],
			'cannot prune remote-tracking ref',
		);
		if (remoteTracking.detail !== undefined) return { detail: remoteTracking.detail };
		return [workspace, localBranch, remoteTracking];
	}

	/**
	 * Only probes origin when this call itself just released something
	 * locally, or the caller durably recorded a prior remote-delete failure for
	 * this run and asked for a retry: a reconcile pass over an already
	 * fully-released run with no such pending failure (RunRuntime replays its
	 * whole run history at startup) would otherwise cost one network round
	 * trip per historical run for a branch that is either long gone or was
	 * never published, and would misreport a warning when offline.
	 */
	#finishRelease(
		branch: string,
		steps: readonly CleanupStepResult[],
		retryRemoteDelete: boolean,
	): WorkspaceReleaseResult {
		const localChanged = steps.some((step) => step.changed);
		const shouldProbeRemote = localChanged || retryRemoteDelete;
		const remoteBranch = shouldProbeRemote ? this.#deleteRemoteBranch(branch) : { changed: false };
		return {
			outcome: localChanged || remoteBranch.changed ? 'released' : 'already-released',
			branch,
			...(remoteBranch.warning === undefined ? {} : { remoteWarning: remoteBranch.warning }),
		};
	}

	/** Inspect leftovers without mutating them. Active workspaces are expected. */
	inspect(runs: readonly WorkspaceRunReference[]): WorkspaceNotice[] {
		const knownByPath = new Map(runs.map((run) => [resolve(run.workspacePath), run]));
		const knownByBranch = new Map(runs.map((run) => [
			this.#branch(run.issueId, safeSegment(run.runId, 'run')),
			run,
		]));
		const notices: WorkspaceNotice[] = [];
		const coveredBranches = new Set<string>();
		const worktreesRoot = this.#worktreesRoot();
		if (existsSync(worktreesRoot) && !lstatSync(worktreesRoot).isDirectory()) {
			return [{
				kind: 'orphan',
				runId: null,
				workspacePath: worktreesRoot,
				branch: null,
				detail: 'managed worktrees root is unsafe',
			}];
		}

		const entries = existsSync(worktreesRoot)
			? readdirSync(worktreesRoot, { withFileTypes: true })
			: [];
		for (const entry of entries) {
			const workspacePath = resolve(worktreesRoot, entry.name);
			const inspected = this.#inspectWorkspace(workspacePath, entry.isDirectory());
			if (inspected.branch !== null) coveredBranches.add(inspected.branch);
			const notice = workspaceNotice(
				knownByPath.get(workspacePath),
				workspacePath,
				inspected.branch,
				inspected.dirty,
				inspected.readable,
			);
			if (notice !== null) notices.push(notice);
		}

		for (const branch of this.#localBranches()) {
			if (coveredBranches.has(branch)) continue;
			const notice = branchNotice(knownByBranch.get(branch), branch);
			if (notice !== null) notices.push(notice);
		}

		return notices.sort((left, right) =>
			(left.workspacePath ?? left.branch ?? '').localeCompare(
				right.workspacePath ?? right.branch ?? '',
			));
	}

	#worktreesRoot(): string {
		return resolve(this.#projectRoot, '.gship', 'worktrees');
	}

	#workspacePath(runId: string): string {
		return resolve(this.#worktreesRoot(), safeSegment(runId, 'run'));
	}

	#branch(issueId: string, runSegment: string): string {
		return `gship/${safeSegment(issueId, 'issue')}-${runSegment.slice(0, 8)}`;
	}

	#registeredWorktrees(): Set<string> {
		const listed = this.#runGit(this.#projectRoot, ['worktree', 'list', '--porcelain']);
		if (listed.exitCode !== 0) return new Set();
		return new Set(listed.stdout
			.split('\n')
			.filter((line) => line.startsWith('worktree '))
			.map((line) => resolve(line.slice('worktree '.length))));
	}

	#removeWorkspace(workspacePath: string, branch: string): CleanupStepResult {
		const registered = this.#registeredWorktrees().has(workspacePath);
		if (!existsSync(workspacePath)) {
			if (!registered) return { changed: false };
			return this.#mutation(
				['worktree', 'remove', '--force', workspacePath],
				'cannot forget missing workspace',
			);
		}
		if (!lstatSync(workspacePath).isDirectory()) {
			return { changed: false, detail: 'workspace path is not a directory' };
		}
		if (!registered) return { changed: false, detail: 'workspace is not registered by git' };
		const status = this.#runGit(workspacePath, ['status', '--porcelain', '--untracked-files=all']);
		if (status.exitCode !== 0) {
			return { changed: false, detail: `cannot inspect workspace: ${failureDetail(status)}` };
		}
		if (status.stdout.trim().length > 0) {
			return { changed: false, detail: 'workspace has local changes' };
		}
		const currentBranch = this.#runGit(workspacePath, ['branch', '--show-current']);
		if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== branch) {
			return { changed: false, detail: `workspace is not on expected branch ${branch}` };
		}
		return this.#mutation(['worktree', 'remove', workspacePath], 'cannot remove workspace');
	}

	#deleteRef(ref: string, args: string[], failure: string): CleanupStepResult {
		const exists = this.#hasRef(ref);
		if (exists instanceof Error) return { changed: false, detail: exists.message };
		return exists ? this.#mutation(args, failure) : { changed: false };
	}

	/**
	 * A repo with no `origin` remote configured is left alone -- it is not a
	 * Gateship checkout published to GitHub, so there is nothing to warn about.
	 */
	#hasOriginRemote(): boolean {
		return this.#runGit(this.#projectRoot, ['remote', 'get-url', 'origin']).exitCode === 0;
	}

	#hasRemoteBranch(branch: string): boolean | Error {
		const result = this.#runGit(this.#projectRoot, [
			'ls-remote', '--exit-code', '--heads', 'origin', branch,
		]);
		if (result.exitCode === 0) return true;
		if (result.exitCode === 2) return false;
		return new Error(`cannot inspect origin/${branch}: ${failureDetail(result)}`);
	}

	/**
	 * Never turns a release into `preserved`: a failure here is reported back
	 * as a warning so the caller can raise it as a workspace notice while the
	 * already-released local worktree and branch keep the run's state as is.
	 */
	#deleteRemoteBranch(branch: string): { changed: boolean; warning?: string } {
		if (!this.#hasOriginRemote()) return { changed: false };
		const exists = this.#hasRemoteBranch(branch);
		if (exists instanceof Error) return { changed: false, warning: exists.message };
		if (!exists) return { changed: false };
		const result = this.#runGit(this.#projectRoot, ['push', 'origin', '--delete', '--', branch]);
		return result.exitCode === 0
			? { changed: true }
			: { changed: false, warning: `cannot delete remote branch: ${failureDetail(result)}` };
	}

	#mutation(args: string[], failure: string): CleanupStepResult {
		const result = this.#runGit(this.#projectRoot, args);
		return result.exitCode === 0
			? { changed: true }
			: { changed: false, detail: `${failure}: ${failureDetail(result)}` };
	}

	#inspectWorkspace(
		workspacePath: string,
		isDirectory: boolean,
	): { branch: string | null; dirty: boolean; readable: boolean } {
		if (!isDirectory) return { branch: null, dirty: false, readable: false };
		const branchResult = this.#runGit(workspacePath, ['branch', '--show-current']);
		const status = this.#runGit(workspacePath, ['status', '--porcelain', '--untracked-files=all']);
		return {
			branch: branchResult.exitCode === 0 && branchResult.stdout.trim().length > 0
				? branchResult.stdout.trim()
				: null,
			dirty: status.exitCode === 0 && status.stdout.trim().length > 0,
			readable: branchResult.exitCode === 0 && status.exitCode === 0,
		};
	}

	#localBranches(): string[] {
		const result = this.#runGit(this.#projectRoot, [
			'for-each-ref', '--format=%(refname:short)', 'refs/heads/gship/',
		]);
		return result.exitCode === 0
			? result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
			: [];
	}

	/** Whether `branch` carries a commit not reachable from the base ref. */
	#branchMissingFromBase(branch: string): boolean | Error {
		const hasRef = this.#hasRef(`refs/heads/${branch}`);
		if (hasRef instanceof Error) return hasRef;
		if (!hasRef) return false;
		const result = this.#runGit(this.#projectRoot, [
			'rev-list', '--count', `${this.#baseRef}..${branch}`,
		]);
		if (result.exitCode !== 0) {
			return new Error(`cannot compare ${branch} to ${this.#baseRef}: ${failureDetail(result)}`);
		}
		return Number.parseInt(result.stdout.trim(), 10) > 0;
	}

	#hasRef(ref: string): boolean | Error {
		const result = this.#runGit(this.#projectRoot, ['show-ref', '--verify', '--quiet', ref]);
		if (result.exitCode === 0) return true;
		if (result.exitCode === 1) return false;
		return new Error(`cannot inspect ${ref}: ${failureDetail(result)}`);
	}

	#prepareFailure(
		input: PrepareWorkspaceInput,
		workspacePath: string,
		detail: string,
	): string {
		const cleanup = this.release({ ...input, workspacePath });
		return cleanup.outcome === 'preserved'
			? `${detail}; workspace preserved: ${cleanup.detail}`
			: detail;
	}
}
