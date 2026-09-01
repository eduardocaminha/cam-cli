import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { issueFilePath, numericIdSuffix, readBacklogFromMain } from '../issues/backlog.ts';
import {
	type EvidenceItem,
	EVIDENCE_LIMITS,
	fingerprintSpec,
	type Spec,
	validateSpec,
} from '../issues/spec.ts';
import type { IssueEntry } from '../issues/types.ts';
import {
	defaultRunGit,
	evidenceOutputText,
	runVerificationCommand,
	type CommandResult,
	type VerificationCommandRunner,
	VERIFICATION_COMMAND_TIMEOUT_MS,
} from './git-runtime.ts';
import { ensureGitIdentity, type GitIdentityResult } from './git-identity.ts';
import { GithubShipper, type GithubPullRequestMerger } from './github-shipper.ts';
import { fetchRuntimeSource, RUNTIME_SOURCE_REF } from './source-ref.ts';

const MAX_PUBLISH_ATTEMPTS = 3;
export interface IssueEvidenceExecutionOptions {
	evidenceTimeoutMs?: number;
	runCommand?: VerificationCommandRunner;
	signal?: AbortSignal;
	/** The shared pull-request lifecycle, injectable only for deterministic tests. */
	shipper?: GithubPullRequestMerger;
}

export interface OperatorSpecInput {
	scope: string;
	verificationCommand: string;
	/** Executable premise captured against the fresh remote snapshot at intake. */
	evidence?: EvidenceItem[];
}

export interface OperatorIssueInput extends OperatorSpecInput {
	title: string;
}

export interface OperatorAbandonInput {
	reason: string;
}

export interface CreatedOperatorIssue {
	id: string;
	title: string;
	sha: string;
}

export type IssueIntakeErrorCode =
	| 'invalid-request'
	| 'issue-not-found'
	| 'issue-not-eligible'
	/** A non-terminal run owns the issue file; main must not be written now. */
	| 'issue-run-active'
	| 'authorization-required'
	| 'fingerprint-mismatch'
	| 'source-unavailable'
	| 'publish-conflict';

export class IssueIntakeError extends Error {
	constructor(
		readonly code: IssueIntakeErrorCode,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'IssueIntakeError';
	}
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new IssueIntakeError('invalid-request', `${label} is required.`, 400);
	}
	return value.trim();
}

/**
 * Shape-coerce the optional evidence payload. `validateSpec` is the single place that
 * enforces item count and size, so a malformed field surfaces one consistent
 * error instead of two different messages for the same contract.
 */
function optionalEvidence(value: unknown): EvidenceItem[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'Evidence must be a list.', 400);
	}
	if (value.length === 0) return undefined;
	return value.map((item, index) => {
		if (item === null || typeof item !== 'object' || Array.isArray(item)) {
			throw new IssueIntakeError('invalid-request', `Evidence ${index + 1} must be an object.`, 400);
		}
		const record = item as Record<string, unknown>;
		const output = record['output'] === undefined ? '' : record['output'];
		return {
			command: typeof record['command'] === 'string' ? record['command'] : '',
			output: output as string,
		};
	});
}

/** Validate the browser payload before any Git or filesystem write occurs. */
export function parseOperatorSpecInput(value: unknown): OperatorSpecInput {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'A JSON object is required.', 400);
	}
	const input = value as Record<string, unknown>;
	const evidence = optionalEvidence(input['evidence']);
	return {
		scope: requiredString(input['scope'], 'Scope'),
		verificationCommand: requiredString(
			input['verificationCommand'],
			'Verification command',
		),
		...(evidence === undefined ? {} : { evidence }),
	};
}

export function parseOperatorIssueInput(value: unknown): OperatorIssueInput {
	const spec = parseOperatorSpecInput(value);
	return {
		title: requiredString((value as Record<string, unknown>)['title'], 'Title'),
		...spec,
	};
}

/** Abandoning carries no spec contract: only a durable justification. */
export function parseOperatorAbandonInput(value: unknown): OperatorAbandonInput {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'A JSON object is required.', 400);
	}
	const input = value as Record<string, unknown>;
	return { reason: requiredString(input['reason'], 'Reason') };
}

function commandFailure(label: string, detail: string): IssueIntakeError {
	return new IssueIntakeError(
		'source-unavailable',
		`${label}: ${detail.trim() || 'git exited without diagnostics'}`,
		503,
	);
}

function git(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function nextIssueNumber(cwd: string, sourceSha: string): number {
	let max = 0;
	for (const issue of readBacklogFromMain(cwd, spawnSync, sourceSha)) {
		const suffix = numericIdSuffix(issue.id);
		if (suffix !== Infinity && suffix > max) max = suffix;
	}
	return max + 1;
}

function buildSpec(input: OperatorSpecInput): Spec {
	const spec: Spec = {
		scope: input.scope,
		verify: [input.verificationCommand],
		...(input.evidence === undefined ? {} : { evidence: input.evidence }),
	};
	const validated = validateSpec(spec);
	if (!validated.ok) {
		throw new IssueIntakeError('invalid-request', validated.errors.join(' '), 400);
	}
	return spec;
}

/** Validate intake shape and limits while empty output still means “capture it”. */
function validateIntakeSpecInput(input: OperatorSpecInput): void {
	buildSpec({
		...input,
		...(input.evidence === undefined
			? {}
			: {
				evidence: input.evidence.map((item) => ({
					...item,
					output: typeof item.output === 'string'
						&& item.output.length <= EVIDENCE_LIMITS.output
						&& item.output.trim().length === 0
						? '(validate intake output)'
						: item.output,
				})),
			}),
	});
}

function boundedEvidenceOutput(output: string): string {
	if (output.length <= EVIDENCE_LIMITS.output) return output;
	return `${output.slice(0, EVIDENCE_LIMITS.output)}…`;
}

async function runEvidenceCommand(
	cwd: string,
	item: EvidenceItem,
	options: IssueEvidenceExecutionOptions,
): Promise<CommandResult> {
	const runCommand = options.runCommand ?? runVerificationCommand;
	const signal = options.signal ?? new AbortController().signal;

	try {
		const result = await runCommand({
			cwd,
			command: item.command,
			signal,
			timeoutMs: options.evidenceTimeoutMs ?? VERIFICATION_COMMAND_TIMEOUT_MS,
		});
		if (result.timedOut === true) {
			throw new IssueIntakeError(
				'invalid-request',
				`Evidence command \`${item.command}\` was timed out before it completed.`,
				400,
			);
		}
		return result;
	} catch (error) {
		if (error instanceof IssueIntakeError) throw error;
		if (!signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
			throw error;
		}
		throw new IssueIntakeError(
			'invalid-request',
			`Evidence command \`${item.command}\` was cancelled before it completed.`,
			400,
		);
	}
}

function confirmEvidence(item: EvidenceItem, result: CommandResult): EvidenceItem {
	const observed = evidenceOutputText(result);
	const expected = item.output;
	if (result.exitCode !== 0) {
		throw new IssueIntakeError(
			'invalid-request',
			`Evidence command \`${item.command}\` exited ${result.exitCode}; observed output: `
				+ `\`${boundedEvidenceOutput(observed) || '(no output)'}\`.`,
			400,
		);
	}
	if (observed.length > EVIDENCE_LIMITS.output) {
		throw new IssueIntakeError(
			'invalid-request',
			`Evidence command \`${item.command}\` produced more than ${EVIDENCE_LIMITS.output}`
				+ ` characters; observed output: \`${boundedEvidenceOutput(observed)}\`.`,
			400,
		);
	}
	if (expected.length > 0 && observed !== expected) {
		throw new IssueIntakeError(
			'invalid-request',
			`Evidence command \`${item.command}\` did not match. Expected: \`${expected}\`.`
				+ ` Observed: \`${observed || '(no output)'}\`.`,
			400,
		);
	}
	return { command: item.command, output: observed };
}

async function captureEvidence(
	cwd: string,
	input: OperatorSpecInput,
	options: IssueEvidenceExecutionOptions,
): Promise<OperatorSpecInput> {
	if (input.evidence === undefined) return input;
	const captured: EvidenceItem[] = [];
	for (const item of input.evidence) {
		captured.push(confirmEvidence(item, await runEvidenceCommand(cwd, item, options)));
	}

	return { ...input, evidence: captured };
}

function buildIssue(
	input: OperatorIssueInput,
	id: string,
	now: string,
	approve: boolean,
): IssueEntry {
	const spec = buildSpec(input);
	return {
		id,
		title: input.title,
		stage: 'specified',
		status: 'open',
		blockedBy: [],
		createdAt: now,
		updatedAt: now,
		description: input.scope,
		specSource: 'operator',
		spec,
		...(approve ? { approval: { fingerprint: fingerprintSpec(spec), approvedAt: now } } : {}),
	};
}

function isPushRace(stderr: string): boolean {
	return /non-fast-forward|fetch first/i.test(stderr);
}

/**
 * This is intentionally narrower than a failed push. Only GitHub's explicit
 * protected-ref / pull-request refusal, or the explicit local policy that
 * blocks a direct push to main or master, may take the intake PR path; an
 * auth, transport, arbitrary hook or ordinary rejected push remains
 * fail-closed.
 */
function requiresPullRequest(stderr: string): boolean {
	return /(?:protected (?:branch|ref)|branch protection|GH006: Protected branch update failed|changes must be made through a pull request|pull request (?:is )?required|requires? a pull request)/i.test(stderr)
		|| /(?:^|\r?\n)(?:remote:\s*)?BLOCKED: direct push to refs\/heads\/(?:main|master) is not allowed(?:\r?$|\r?\n)/.test(stderr);
}

function intakeControlBranch(issueId: string, headSha: string): string {
	return `gship/intake/${issueId.toLowerCase()}-${headSha.slice(0, 12)}`;
}

async function publishProtectedEntry(
	worktree: string,
	entry: IssueEntry,
	sha: string,
	options: IssueEvidenceExecutionOptions,
): Promise<{ kind: 'published'; issue: CreatedOperatorIssue }> {
	// The head suffix makes the branch stable for a retry of this exact write,
	// while a later specify/approve/abandon commit for the same issue cannot
	// accidentally reuse the already-merged pull request from an earlier head.
	const branch = intakeControlBranch(entry.id, sha);
	const controlPushed = git(worktree, [
		'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`,
	]);
	if (controlPushed.exitCode !== 0) {
		throw commandFailure('Could not publish the protected intake branch', controlPushed.stderr);
	}
	const merged = await (options.shipper ?? new GithubShipper()).mergePullRequest({
		runId: `intake-${entry.id}`,
		evidence: { workflowRevision: 'intake', review: 'not-applicable', fullVerification: 'not-applicable' },
		cwd: worktree,
		issueId: entry.id,
		title: entry.title,
		branch,
		headSha: sha,
		verificationCommands: entry.spec?.verify ?? [],
		signal: options.signal ?? new AbortController().signal,
		emit: () => {},
		initialCiStatus: 'not-reported',
		deleteBranch: true,
	});
	if (merged.outcome === 'merged') {
		return { kind: 'published', issue: { id: entry.id, title: entry.title, sha } };
	}
	throw commandFailure(
		'Could not merge the protected intake pull request',
		merged.outcome === 'ci-failed'
			? `required check failed: ${merged.evidence.check.name}`
			: merged.detail,
	);
}

async function publishEntryAttempt(
	cwd: string,
	sourceSha: string,
	buildEntry: (worktree: string) => Promise<IssueEntry>,
	commitMessage: string,
	ensureIdentity: () => GitIdentityResult,
	options: IssueEvidenceExecutionOptions,
): Promise<{ kind: 'published'; issue: CreatedOperatorIssue } | { kind: 'retry' }> {
	// Right before the first write this attempt makes, not merely displayed
	// (GSHIP-654): a missing identity fails clearly here, before any worktree
	// is even prepared, instead of surfacing later as git's own opaque
	// "Author identity unknown" once the commit below is already attempted.
	const identity = ensureIdentity();
	if (identity.outcome === 'missing') {
		throw commandFailure('Could not create the commit', identity.detail);
	}

	const tempRoot = mkdtempSync(join(tmpdir(), 'gship-intake-'));
	const worktree = join(tempRoot, 'checkout');

	try {
		const added = git(cwd, ['worktree', 'add', '--quiet', '--detach', worktree, sourceSha]);
		if (added.exitCode !== 0) throw commandFailure('Could not stage the intake', added.stderr);
		const entry = await buildEntry(worktree);
		const path = issueFilePath(entry.id);

		const target = join(worktree, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, `${JSON.stringify(entry, null, 2)}\n`);

		const staged = git(worktree, ['add', '--', path]);
		if (staged.exitCode !== 0) throw commandFailure('Could not record the issue', staged.stderr);
		const committed = git(worktree, ['commit', '--quiet', '-m', commitMessage]);
		if (committed.exitCode !== 0) throw commandFailure('Could not create the commit', committed.stderr);
		const shaResult = git(worktree, ['rev-parse', 'HEAD']);
		if (shaResult.exitCode !== 0) throw commandFailure('Could not resolve the commit', shaResult.stderr);
		const sha = shaResult.stdout.trim();

		const pushed = git(worktree, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
		if (pushed.exitCode === 0) {
			return { kind: 'published', issue: { id: entry.id, title: entry.title, sha } };
		}
		if (isPushRace(pushed.stderr)) return { kind: 'retry' };
		if (requiresPullRequest(pushed.stderr)) {
			return await publishProtectedEntry(worktree, entry, sha, options);
		}
		throw commandFailure('Could not publish the issue', pushed.stderr);
	} finally {
		git(cwd, ['worktree', 'remove', '--force', worktree]);
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function refreshRuntimeSource(cwd: string): string {
	const fetched = fetchRuntimeSource(defaultRunGit, cwd);
	if (fetched.exitCode !== 0) {
		throw commandFailure(`Could not update ${RUNTIME_SOURCE_REF}`, fetched.stderr);
	}
	const resolved = git(cwd, ['rev-parse', '--verify', RUNTIME_SOURCE_REF]);
	if (resolved.exitCode !== 0) {
		throw commandFailure(`Could not resolve ${RUNTIME_SOURCE_REF}`, resolved.stderr);
	}
	return resolved.stdout.trim();
}

/**
 * File one operator-specified issue on the remote main without moving the
 * local main ref or touching the host working tree. A non-fast-forward push
 * refreshes origin/main and re-allocates the id from the new immutable base.
 */
export async function createOperatorIssue(
	cwd: string,
	rawInput: unknown,
	options: { approve?: boolean } & IssueEvidenceExecutionOptions = {},
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
): Promise<CreatedOperatorIssue> {
	const input = parseOperatorIssueInput(rawInput);
	validateIntakeSpecInput(input);
	const createdAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const number = nextIssueNumber(cwd, sourceSha);
		const id = `GSHIP-${number}`;
		const result = await publishEntryAttempt(
			cwd,
			sourceSha,
			async (worktree) => buildIssue(
				await captureEvidence(worktree, input, options) as OperatorIssueInput,
				id,
				createdAt,
				options.approve ?? false,
			),
			`chore(gship): file ${id}`,
			ensureIdentity,
			options,
		);
		if (result.kind === 'published') {
			// The push is already durable. A transient second fetch must not turn
			// success into a retry that could file a duplicate issue.
			fetchRuntimeSource(defaultRunGit, cwd);
			return result.issue;
		}
	}

	throw new IssueIntakeError(
		'publish-conflict',
		'The backlog advanced during three attempts; try creating the issue again.',
		409,
	);
}

/** Promote one existing idea with the same operator contract used for new tasks. */
export async function specifyOperatorIssue(
	cwd: string,
	id: string,
	rawInput: unknown,
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
	options: IssueEvidenceExecutionOptions = {},
): Promise<CreatedOperatorIssue> {
	const issueId = requiredString(id, 'Issue');
	const input = parseOperatorSpecInput(rawInput);
	validateIntakeSpecInput(input);
	const updatedAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const entry = readBacklogFromMain(cwd, spawnSync, sourceSha)
			.find((issue) => issue.id === issueId);
		if (entry === undefined) {
			throw new IssueIntakeError('issue-not-found', `${issueId} does not exist in the backlog.`, 404);
		}
		if (entry.status !== 'open' || (entry.stage !== 'idea' && entry.stage !== 'specified')) {
			throw new IssueIntakeError(
				'issue-not-eligible',
				`${issueId} must be open and at stage:idea or stage:specified.`,
				409,
			);
		}
		const result = await publishEntryAttempt(
			cwd,
			sourceSha,
			async (worktree) => {
				const specified: IssueEntry = {
					...entry,
					stage: 'specified',
					updatedAt,
					specSource: 'operator',
					spec: buildSpec(await captureEvidence(worktree, input, options)),
				};
				delete specified.approval;
				return specified;
			},
			`chore(gship): specify ${issueId}`,
			ensureIdentity,
			options,
		);
		if (result.kind === 'published') {
			fetchRuntimeSource(defaultRunGit, cwd);
			return result.issue;
		}
	}

	throw new IssueIntakeError(
		'publish-conflict',
		'The backlog advanced during three attempts; try specifying the idea again.',
		409,
	);
}

/** Approve the currently published executable spec without starting a run. */
export async function approveOperatorIssue(
	cwd: string,
	id: string,
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
	options: Pick<IssueEvidenceExecutionOptions, 'signal' | 'shipper'> = {},
): Promise<CreatedOperatorIssue> {
	const issueId = requiredString(id, 'Issue');
	const approvedAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const entry = readBacklogFromMain(cwd, spawnSync, sourceSha)
			.find((issue) => issue.id === issueId);
		if (entry === undefined) {
			throw new IssueIntakeError('issue-not-found', `${issueId} does not exist in the backlog.`, 404);
		}
		const validation = entry.spec === undefined ? null : validateSpec(entry.spec);
		if (entry.status !== 'open' || entry.stage !== 'specified' || validation?.ok !== true) {
			throw new IssueIntakeError(
				'issue-not-eligible',
				`${issueId} must be open, at stage:specified and have an executable spec.`,
				409,
			);
		}
		const fingerprint = fingerprintSpec(entry.spec!);
		// Approving the published contract again is the same decision, not a new
		// one: keep the recorded approvedAt and write nothing, so a repeated
		// approval never publishes a commit over an issue that is being executed.
		if (entry.approval?.fingerprint === fingerprint) {
			return { id: entry.id, title: entry.title, sha: sourceSha };
		}
		const approved: IssueEntry = {
			...entry,
			updatedAt: approvedAt,
			approval: { fingerprint, approvedAt },
		};
		const result = await publishEntryAttempt(
			cwd,
			sourceSha,
			async () => approved,
			`chore(gship): approve ${issueId}`,
			ensureIdentity,
			options,
		);
		if (result.kind === 'published') {
			fetchRuntimeSource(defaultRunGit, cwd);
			return result.issue;
		}
	}

	throw new IssueIntakeError(
		'publish-conflict',
		'The backlog advanced during three attempts; try approving the issue again.',
		409,
	);
}

/**
 * Close one open issue without shipping it, keeping the justification durable
 * in the record. Every other field of the entry is preserved as published.
 */
export async function abandonOperatorIssue(
	cwd: string,
	id: string,
	rawInput: unknown,
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
	options: Pick<IssueEvidenceExecutionOptions, 'signal' | 'shipper'> = {},
): Promise<CreatedOperatorIssue> {
	const issueId = requiredString(id, 'Issue');
	const input = parseOperatorAbandonInput(rawInput);
	const updatedAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const entry = readBacklogFromMain(cwd, spawnSync, sourceSha)
			.find((issue) => issue.id === issueId);
		if (entry === undefined) {
			throw new IssueIntakeError('issue-not-found', `${issueId} does not exist in the backlog.`, 404);
		}
		if (entry.status !== 'open') {
			throw new IssueIntakeError(
				'issue-not-eligible',
				`${issueId} must be open.`,
				409,
			);
		}
		const abandoned: IssueEntry = {
			...entry,
			status: 'abandoned',
			updatedAt,
			abandonedReason: input.reason,
		};
		const result = await publishEntryAttempt(
			cwd,
			sourceSha,
			async () => abandoned,
			`chore(gship): abandon ${issueId}`,
			ensureIdentity,
			options,
		);
		if (result.kind === 'published') {
			fetchRuntimeSource(defaultRunGit, cwd);
			return result.issue;
		}
	}

	throw new IssueIntakeError(
		'publish-conflict',
		'The backlog advanced during three attempts; try abandoning the issue again.',
		409,
	);
}
