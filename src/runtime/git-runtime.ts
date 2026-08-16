import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import { parseOracleDirective } from '../issues/oracle-directive.ts';
import { terminateProcessGroup } from './process-group.ts';
import { fetchRuntimeSource, RUNTIME_SOURCE_REF } from './source-ref.ts';
import type { RuntimeVerificationResult, RuntimeVerifier } from './run-runtime.ts';

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DIAGNOSTIC_TAIL_LENGTH = 2_000;

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type GitCommandRunner = (cwd: string, args: string[]) => CommandResult;

export interface VerificationCommandInput {
	cwd: string;
	command: string;
	signal: AbortSignal;
}

export type VerificationCommandRunner = (
	input: VerificationCommandInput,
) => Promise<CommandResult>;

export interface GitRuntimeOptions {
	runGit?: GitCommandRunner;
	issueExists?: (cwd: string, issueId: string) => boolean;
	loadIssue?: (cwd: string, issueId: string) => string;
	runCommand?: VerificationCommandRunner;
	terminationGraceMs?: number;
}

export class RuntimePreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RuntimePreflightError';
	}
}

export function defaultRunGit(cwd: string, args: string[]): CommandResult {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function defaultIssueExists(cwd: string, issueId: string): boolean {
	return getIssueOnMain(cwd, issueId, spawnSync, RUNTIME_SOURCE_REF).ok;
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId, spawnSync, RUNTIME_SOURCE_REF);
	if (!issue.ok) throw new Error(`issue not found on ${RUNTIME_SOURCE_REF}: ${issueId}`);
	return issue.content;
}

function shellCommand(): string {
	const configured = process.env.SHELL?.trim();
	if (configured !== undefined && configured.length > 0) {
		if (!configured.startsWith('/') || existsSync(configured)) return configured;
	}
	return '/bin/sh';
}

export interface OwnedCommandInput {
	cmd: string[];
	cwd: string;
	signal: AbortSignal;
	/** Child environment; defaults to the ambient one. */
	env?: Record<string, string | undefined>;
	terminationGraceMs?: number;
}

/**
 * Spawn one owned child in its own process group and collect it. Cancellation
 * terminates the whole group and surfaces as an AbortError, so no runtime step
 * can outlive the run that asked for it.
 */
export async function runOwnedCommand(input: OwnedCommandInput): Promise<CommandResult> {
	const child = Bun.spawn({
		cmd: input.cmd,
		cwd: input.cwd,
		env: input.env ?? process.env,
		detached: true,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	let termination: Promise<void> | undefined;
	const abort = (): void => {
		termination ??= terminateProcessGroup(
			child,
			input.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
		);
	};
	input.signal.addEventListener('abort', abort, { once: true });
	if (input.signal.aborted) abort();

	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (termination !== undefined) await termination;
		if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		return { exitCode, stdout, stderr };
	} finally {
		input.signal.removeEventListener('abort', abort);
	}
}

async function defaultRunCommand(
	input: VerificationCommandInput,
	terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): Promise<CommandResult> {
	return runOwnedCommand({
		cmd: [shellCommand(), '-lc', input.command],
		cwd: input.cwd,
		signal: input.signal,
		terminationGraceMs,
	});
}

function acceptanceCriteria(issueContent: string): string[] {
	let issue: unknown;
	try {
		issue = JSON.parse(issueContent);
	} catch {
		throw new Error('issue record on main is not valid JSON');
	}
	if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) {
		throw new Error('issue record on main is not an object');
	}
	const spec = (issue as Record<string, unknown>).spec;
	if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
		throw new Error('issue has no structured spec');
	}
	const criteria = (spec as Record<string, unknown>).acceptanceCriteria;
	if (!Array.isArray(criteria) || !criteria.every((item) => typeof item === 'string')) {
		throw new Error('issue has no valid acceptance criteria');
	}
	if (criteria.length === 0) throw new Error('issue has no acceptance criteria');
	return criteria;
}

function outputTail(result: CommandResult): string {
	const output = `${result.stdout}\n${result.stderr}`.trim();
	return output.length === 0 ? '(no output)' : output.slice(-DIAGNOSTIC_TAIL_LENGTH);
}

function verifyWorkingTree(
	runGit: GitCommandRunner,
	cwd: string,
): RuntimeVerificationResult {
	for (const args of [['diff', '--check'], ['diff', '--cached', '--check']]) {
		const result = runGit(cwd, args);
		if (result.exitCode !== 0) {
			return { ok: false, detail: commandFailure('git diff check failed', result).message };
		}
	}
	const status = runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
	if (status.exitCode !== 0) {
		return { ok: false, detail: commandFailure('cannot read working tree', status).message };
	}
	if (status.stdout.trim().length === 0) {
		return { ok: false, detail: 'executor completed without a working-tree change' };
	}
	return { ok: true };
}

function commandFailure(label: string, result: CommandResult): RuntimePreflightError {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
	return new RuntimePreflightError(`${label}: ${detail}`);
}

/**
 * Gate on a fresh source ref before a run is accepted.
 *
 * The refresh is fail-closed and happens first: a run admitted against a stale
 * `origin/main` would read an issue the remote has already shipped and branch
 * from a base commit the remote has already moved past. Only
 * `refs/remotes/origin/main` is written -- the local `main` never moves, so a
 * checked-out and dirty `main` in another worktree is unaffected.
 */
export function createGitRuntimePreflight(
	cwd: string,
	options: GitRuntimeOptions = {},
): (issueId: string) => void {
	const runGit = options.runGit ?? defaultRunGit;
	const issueExists = options.issueExists ?? defaultIssueExists;
	return (issueId) => {
		const fetched = fetchRuntimeSource(runGit, cwd);
		if (fetched.exitCode !== 0) {
			throw commandFailure(`cannot fetch ${RUNTIME_SOURCE_REF}`, fetched);
		}
		if (!issueExists(cwd, issueId)) {
			throw new RuntimePreflightError(`issue not found on ${RUNTIME_SOURCE_REF}: ${issueId}`);
		}
		const source = runGit(cwd, ['rev-parse', '--verify', RUNTIME_SOURCE_REF]);
		if (source.exitCode !== 0) {
			throw commandFailure(`cannot resolve ${RUNTIME_SOURCE_REF}`, source);
		}
	};
}

export class GitIssueVerifier implements RuntimeVerifier {
	readonly #runGit: GitCommandRunner;
	readonly #loadIssue: (cwd: string, issueId: string) => string;
	readonly #runCommand: VerificationCommandRunner;

	constructor(options: GitRuntimeOptions = {}) {
		this.#runGit = options.runGit ?? defaultRunGit;
		this.#loadIssue = options.loadIssue ?? defaultLoadIssue;
		this.#runCommand = options.runCommand ?? ((input) =>
			defaultRunCommand(input, options.terminationGraceMs));
	}

	async verify(input: Parameters<RuntimeVerifier['verify']>[0]) {
		const workingTree = verifyWorkingTree(this.#runGit, input.cwd);
		if (!workingTree.ok) return workingTree;

		let criteria: string[];
		try {
			criteria = acceptanceCriteria(this.#loadIssue(input.cwd, input.issueId));
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}

		for (const [criterionIndex, criterion] of criteria.entries()) {
			const directive = parseOracleDirective(criterion);
			if (directive === null) {
				return { ok: false, detail: `acceptance criterion ${criterionIndex + 1} has no oracle` };
			}
			if (directive.kind !== 'named-command' && directive.kind !== 'file-assert') {
				return {
					ok: false,
					detail: `acceptance criterion ${criterionIndex + 1} uses unsupported oracle ${directive.kind}`,
				};
			}
			input.emit('verify.command.started', { criterionIndex: criterionIndex + 1 });
			const result = await this.#runCommand({
				cwd: input.cwd,
				command: directive.command,
				signal: input.signal,
			});
			input.emit('verify.command.completed', {
				criterionIndex: criterionIndex + 1,
				exitCode: result.exitCode,
			});
			if (result.exitCode !== 0) {
				return {
					ok: false,
					detail: `acceptance criterion ${criterionIndex + 1} exited ${result.exitCode}: ${outputTail(result)}`,
				};
			}
		}
		return { ok: true };
	}
}
