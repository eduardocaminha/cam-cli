import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { issueFilePath, numericIdSuffix, readBacklogFromMain } from '../issues/backlog.ts';
import { type EvidenceItem, fingerprintSpec, type Spec, validateSpec } from '../issues/spec.ts';
import type { IssueEntry } from '../issues/types.ts';
import { defaultRunGit } from './git-runtime.ts';
import { ensureGitIdentity, type GitIdentityResult } from './git-identity.ts';
import { fetchRuntimeSource, RUNTIME_SOURCE_REF } from './source-ref.ts';

const MAX_PUBLISH_ATTEMPTS = 3;

export interface OperatorSpecInput {
	scope: string;
	verificationCommand: string;
	/** Executable premise recorded at specify time; never run here (GSHIP-629). */
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
 * Shape-coerce the optional evidence payload without executing or judging its
 * contents: `validateSpec` (called from `buildSpec`) is the single place that
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
		return {
			command: typeof record['command'] === 'string' ? record['command'] : '',
			output: typeof record['output'] === 'string' ? record['output'] : '',
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

function publishEntryAttempt(
	cwd: string,
	sourceSha: string,
	entry: IssueEntry,
	commitMessage: string,
	ensureIdentity: () => GitIdentityResult,
): { kind: 'published'; issue: CreatedOperatorIssue } | { kind: 'retry' } {
	// Right before the first write this attempt makes, not merely displayed
	// (GSHIP-654): a missing identity fails clearly here, before any worktree
	// is even prepared, instead of surfacing later as git's own opaque
	// "Author identity unknown" once the commit below is already attempted.
	const identity = ensureIdentity();
	if (identity.outcome === 'missing') {
		throw commandFailure('Could not create the commit', identity.detail);
	}

	const path = issueFilePath(entry.id);
	const tempRoot = mkdtempSync(join(tmpdir(), 'gship-intake-'));
	const worktree = join(tempRoot, 'checkout');

	try {
		const added = git(cwd, ['worktree', 'add', '--quiet', '--detach', worktree, sourceSha]);
		if (added.exitCode !== 0) throw commandFailure('Could not stage the intake', added.stderr);

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
export function createOperatorIssue(
	cwd: string,
	rawInput: unknown,
	options: { approve?: boolean } = {},
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
): CreatedOperatorIssue {
	const input = parseOperatorIssueInput(rawInput);
	const createdAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const number = nextIssueNumber(cwd, sourceSha);
		const id = `GSHIP-${number}`;
		const entry = buildIssue(input, id, createdAt, options.approve ?? false);
		const result = publishEntryAttempt(cwd, sourceSha, entry, `chore(gship): file ${id}`, ensureIdentity);
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
export function specifyOperatorIssue(
	cwd: string,
	id: string,
	rawInput: unknown,
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
): CreatedOperatorIssue {
	const issueId = requiredString(id, 'Issue');
	const input = parseOperatorSpecInput(rawInput);
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
		const specified: IssueEntry = {
			...entry,
			stage: 'specified',
			updatedAt,
			specSource: 'operator',
			spec: buildSpec(input),
		};
		delete specified.approval;
		const result = publishEntryAttempt(
			cwd,
			sourceSha,
			specified,
			`chore(gship): specify ${issueId}`,
			ensureIdentity,
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
export function approveOperatorIssue(
	cwd: string,
	id: string,
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
): CreatedOperatorIssue {
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
		const result = publishEntryAttempt(
			cwd,
			sourceSha,
			approved,
			`chore(gship): approve ${issueId}`,
			ensureIdentity,
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
export function abandonOperatorIssue(
	cwd: string,
	id: string,
	rawInput: unknown,
	now: () => string = () => new Date().toISOString(),
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
): CreatedOperatorIssue {
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
		const result = publishEntryAttempt(
			cwd,
			sourceSha,
			abandoned,
			`chore(gship): abandon ${issueId}`,
			ensureIdentity,
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
