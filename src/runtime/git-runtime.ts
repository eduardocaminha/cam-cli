import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import { issueFilePath } from '../issues/backlog.ts';
import { type EvidenceItem, fingerprintSpec, type Spec } from '../issues/spec.ts';
import { terminateProcessGroup } from './process-group.ts';
import { fetchRuntimeSource, RUNTIME_SOURCE_REF } from './source-ref.ts';
import type {
	RuntimeEvidenceCheck,
	RuntimeExecutionInput,
	RuntimeVerificationResult,
	RuntimeVerifier,
} from './run-runtime.ts';

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
	/** Reads the issue record from the run's own checked-out workspace, not from `origin/main`. */
	loadIssueFromWorkspace?: (cwd: string, issueId: string) => string;
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

/**
 * Read the issue record straight from the run's own checkout instead of via
 * git: by the time the evidence check runs, `workspace.prepare` has already
 * cut this exact worktree from the same `origin/main` sha the preflight
 * validated, so the file on disk is the approved record.
 */
function defaultLoadIssueFromWorkspace(cwd: string, issueId: string): string {
	return readFileSync(join(cwd, issueFilePath(issueId)), 'utf8');
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

function verificationCommands(issueContent: string): string[] {
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
	const direct = (spec as Record<string, unknown>).verify;
	if (Array.isArray(direct) && direct.length > 0 && direct.every((item) => typeof item === 'string')) {
		return direct;
	}
	throw new Error('issue has no verification commands');
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

function evidenceOutputText(result: CommandResult): string {
	return `${result.stdout}\n${result.stderr}`.trim();
}

/**
 * The optional evidence items on an issue's spec, or an empty array when the
 * spec has none. Unlike `verificationCommands`, a missing or malformed
 * `evidence` field is not an error -- the field is optional, and every issue
 * filed before GSHIP-629 lacks it entirely.
 */
function evidenceFromIssue(issueContent: string): EvidenceItem[] {
	let issue: unknown;
	try {
		issue = JSON.parse(issueContent);
	} catch {
		throw new Error('issue record is not valid JSON');
	}
	if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) {
		throw new Error('issue record is not an object');
	}
	const spec = (issue as Record<string, unknown>).spec;
	if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
		return [];
	}
	const evidence = (spec as Record<string, unknown>).evidence;
	return Array.isArray(evidence) ? (evidence as EvidenceItem[]) : [];
}

/**
 * Gate on a fresh source ref before a run is accepted.
 *
 * The refresh is fail-closed and happens first: a run admitted against a stale
 * `origin/main` would read an issue the remote has already shipped and branch
 * from a base commit the remote has already moved past. Only
 * `refs/remotes/origin/main` is written -- the local `main` never moves, so a
 * checked-out and dirty `main` in another worktree is unaffected.
 *
 * This does not check the spec's evidence: at this point `RunRuntime.startRun`
 * has not yet called `workspace.prepare`, so there is no run workspace to run
 * evidence commands against, and cutting one here just for this check would be
 * the additional worktree the issue's scope explicitly excluded. Evidence is
 * instead checked by `GitEvidenceChecker`, against the run's own workspace,
 * after it exists and before the executor runs (GSHIP-629).
 */
export function createGitRuntimePreflight(
	cwd: string,
	options: GitRuntimeOptions = {},
): (issueId: string) => void {
	const runGit = options.runGit ?? defaultRunGit;
	const issueExists = options.issueExists ?? defaultIssueExists;
	const loadIssue = options.loadIssue ?? defaultLoadIssue;
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
		const issue = JSON.parse(loadIssue(cwd, issueId)) as {
			spec?: Spec;
			approval?: { fingerprint?: string };
		};
		if (issue.approval?.fingerprint === undefined) {
			throw new RuntimePreflightError(
				`${issueId} has no approval; approve this draft before starting a run`,
			);
		}
		if (issue.spec === undefined || issue.approval.fingerprint !== fingerprintSpec(issue.spec)) {
			throw new RuntimePreflightError(
				`${issueId} has stale approval; its executable contract changed after approval`,
			);
		}
	};
}

/**
 * The spec's executable premise, checked in the run's own workspace: after
 * `workspace.prepare` has cut its worktree and installed its dependencies
 * (`GitWorkspaceManager.prepare`, git-workspace.ts), and before the executor
 * is ever invoked (`RunRuntime.#drive`/`#checkEvidence`, run-runtime.ts, which
 * also owns whether a given pass runs this check at all). No worktree of its
 * own is cut here -- there is nothing to clean up and nothing that can leak an
 * orphaned `.git/worktrees` entry if the process dies mid-check. Each command
 * runs through the same cancellable, timeout-bound path `GitIssueVerifier`
 * already uses for verify commands, so a command that hangs is terminated by
 * the run's own abort instead of blocking the service.
 */
export class GitEvidenceChecker implements RuntimeEvidenceCheck {
	readonly #loadIssue: (cwd: string, issueId: string) => string;
	readonly #runCommand: VerificationCommandRunner;

	constructor(options: GitRuntimeOptions = {}) {
		this.#loadIssue = options.loadIssueFromWorkspace ?? defaultLoadIssueFromWorkspace;
		this.#runCommand = options.runCommand ?? ((input) =>
			defaultRunCommand(input, options.terminationGraceMs));
	}

	async check(input: RuntimeExecutionInput): Promise<RuntimeVerificationResult> {
		let evidence: EvidenceItem[];
		try {
			evidence = evidenceFromIssue(this.#loadIssue(input.cwd, input.issueId));
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}

		for (const item of evidence) {
			const result = await this.#runCommand({
				cwd: input.cwd,
				command: item.command,
				signal: input.signal,
			});
			const observed = evidenceOutputText(result);
			const recorded = item.output.trim();
			if (result.exitCode !== 0 || observed !== recorded) {
				// Leads with "the spec's evidence diverged" in full, not just
				// "evidence diverged": this text becomes `run.error` verbatim, with
				// no separate label distinguishing it from an implementation bug, so
				// it has to say on its own that the *spec's premise* stopped holding.
				// `recorded` is already bounded by EVIDENCE_LIMITS.output at intake;
				// `observed` is whatever the current command just printed, so it gets
				// the same tail cap `outputTail` already gives the verify diagnostic.
				return {
					ok: false,
					detail: `the run ended because the spec's evidence diverged from the repository:`
						+ ` command \`${item.command}\` recorded \`${recorded}\` but the current`
						+ ` repository observed \`${outputTail(result)}\``
						+ (result.exitCode === 0 ? '' : ` (command exited ${result.exitCode})`),
				};
			}
		}
		return { ok: true };
	}
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

		let commands: string[];
		try {
			commands = verificationCommands(this.#loadIssue(input.cwd, input.issueId));
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}

		for (const [commandIndex, command] of commands.entries()) {
			input.emit('verify.command.started', { commandIndex: commandIndex + 1 });
			const result = await this.#runCommand({
				cwd: input.cwd,
				command,
				signal: input.signal,
			});
			input.emit('verify.command.completed', {
				commandIndex: commandIndex + 1,
				exitCode: result.exitCode,
			});
			if (result.exitCode !== 0) {
				return {
					ok: false,
					detail: `verification command ${commandIndex + 1} exited ${result.exitCode}: ${outputTail(result)}`,
				};
			}
		}
		return { ok: true };
	}
}

/**
 * Whether the workspace's own `package.json` declares a `verify` script
 * (GSHIP-649). A missing or unreadable `package.json`, invalid JSON, or a
 * `scripts.verify` of the wrong shape all read the same way as "no script
 * declared" -- this only ever decides whether to run `bun run verify`, never
 * fails the run on its own.
 */
function hasVerifyScript(cwd: string): boolean {
	let raw: string;
	try {
		raw = readFileSync(join(cwd, 'package.json'), 'utf8');
	} catch {
		return false;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
	const scripts = (parsed as Record<string, unknown>).scripts;
	if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return false;
	return typeof (scripts as Record<string, unknown>).verify === 'string';
}

/**
 * The project's full verification gate (GSHIP-649): whatever `package.json`
 * already declares as its `verify` script -- e.g. `bun run check:all` --
 * run once per ready-to-ship pass, through the same cancellable,
 * timeout-bound command path `GitIssueVerifier` and `GitEvidenceChecker`
 * already use. The slice never hardcodes what `verify` runs: a project that
 * declares no such script is skipped, not failed, so this stays exactly the
 * cutout the issue's own `spec.verify` and the project's full manifest
 * already agree on.
 */
export class GitFullVerifier implements RuntimeVerifier {
	readonly #runCommand: VerificationCommandRunner;

	constructor(options: GitRuntimeOptions = {}) {
		this.#runCommand = options.runCommand ?? ((input) =>
			defaultRunCommand(input, options.terminationGraceMs));
	}

	async verify(input: Parameters<RuntimeVerifier['verify']>[0]) {
		if (!hasVerifyScript(input.cwd)) return { ok: true, skipped: true };

		input.emit('full-verify.command.started');
		const result = await this.#runCommand({
			cwd: input.cwd,
			command: 'bun run verify',
			signal: input.signal,
		});
		input.emit('full-verify.command.completed', { exitCode: result.exitCode });
		if (result.exitCode !== 0) {
			return { ok: false, detail: `full verification failed: ${outputTail(result)}` };
		}
		return { ok: true };
	}
}
