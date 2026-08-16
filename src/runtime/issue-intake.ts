import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { issueFilePath, numericIdSuffix, readBacklogFromMain } from '../issues/backlog.ts';
import { fingerprintSpec, type Spec, validateSpec } from '../issues/spec.ts';
import type { IssueEntry } from '../issues/types.ts';
import { defaultRunGit } from './git-runtime.ts';
import { fetchRuntimeSource, RUNTIME_SOURCE_REF } from './source-ref.ts';

const MAX_PUBLISH_ATTEMPTS = 3;

export interface OperatorSpecInput {
	scope: string;
	verificationCommand: string;
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
		throw new IssueIntakeError('invalid-request', `${label} é obrigatório.`, 400);
	}
	return value.trim();
}

/** Validate the browser payload before any Git or filesystem write occurs. */
export function parseOperatorSpecInput(value: unknown): OperatorSpecInput {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'Um objeto JSON é obrigatório.', 400);
	}
	const input = value as Record<string, unknown>;
	return {
		scope: requiredString(input['scope'], 'Escopo'),
		verificationCommand: requiredString(
			input['verificationCommand'],
			'Comando de verificação',
		),
	};
}

export function parseOperatorIssueInput(value: unknown): OperatorIssueInput {
	const spec = parseOperatorSpecInput(value);
	return {
		title: requiredString((value as Record<string, unknown>)['title'], 'Título'),
		...spec,
	};
}

/** Abandoning carries no spec contract: only a durable justification. */
export function parseOperatorAbandonInput(value: unknown): OperatorAbandonInput {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'Um objeto JSON é obrigatório.', 400);
	}
	const input = value as Record<string, unknown>;
	return { reason: requiredString(input['reason'], 'Justificativa') };
}

function commandFailure(label: string, detail: string): IssueIntakeError {
	return new IssueIntakeError(
		'source-unavailable',
		`${label}: ${detail.trim() || 'git saiu sem diagnóstico'}`,
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
	const spec = {
		scope: input.scope,
		verify: [input.verificationCommand],
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
): { kind: 'published'; issue: CreatedOperatorIssue } | { kind: 'retry' } {
	const path = issueFilePath(entry.id);
	const tempRoot = mkdtempSync(join(tmpdir(), 'gship-intake-'));
	const worktree = join(tempRoot, 'checkout');

	try {
		const added = git(cwd, ['worktree', 'add', '--quiet', '--detach', worktree, sourceSha]);
		if (added.exitCode !== 0) throw commandFailure('Não foi possível preparar o intake', added.stderr);

		const target = join(worktree, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, `${JSON.stringify(entry, null, 2)}\n`);

		const staged = git(worktree, ['add', '--', path]);
		if (staged.exitCode !== 0) throw commandFailure('Não foi possível registrar a tarefa', staged.stderr);
		const committed = git(worktree, ['commit', '--quiet', '-m', commitMessage]);
		if (committed.exitCode !== 0) throw commandFailure('Não foi possível criar o commit', committed.stderr);
		const shaResult = git(worktree, ['rev-parse', 'HEAD']);
		if (shaResult.exitCode !== 0) throw commandFailure('Não foi possível resolver o commit', shaResult.stderr);
		const sha = shaResult.stdout.trim();

		const pushed = git(worktree, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
		if (pushed.exitCode === 0) {
			return { kind: 'published', issue: { id: entry.id, title: entry.title, sha } };
		}
		if (isPushRace(pushed.stderr)) return { kind: 'retry' };
		throw commandFailure('Não foi possível publicar a tarefa', pushed.stderr);
	} finally {
		git(cwd, ['worktree', 'remove', '--force', worktree]);
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function refreshRuntimeSource(cwd: string): string {
	const fetched = fetchRuntimeSource(defaultRunGit, cwd);
	if (fetched.exitCode !== 0) {
		throw commandFailure(`Não foi possível atualizar ${RUNTIME_SOURCE_REF}`, fetched.stderr);
	}
	const resolved = git(cwd, ['rev-parse', '--verify', RUNTIME_SOURCE_REF]);
	if (resolved.exitCode !== 0) {
		throw commandFailure(`Não foi possível resolver ${RUNTIME_SOURCE_REF}`, resolved.stderr);
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
): CreatedOperatorIssue {
	const input = parseOperatorIssueInput(rawInput);
	const createdAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const number = nextIssueNumber(cwd, sourceSha);
		const id = `GSHIP-${number}`;
		const entry = buildIssue(input, id, createdAt, options.approve ?? false);
		const result = publishEntryAttempt(cwd, sourceSha, entry, `chore(gship): file ${id}`);
		if (result.kind === 'published') {
			// The push is already durable. A transient second fetch must not turn
			// success into a retry that could file a duplicate issue.
			fetchRuntimeSource(defaultRunGit, cwd);
			return result.issue;
		}
	}

	throw new IssueIntakeError(
		'publish-conflict',
		'O backlog avançou durante três tentativas; tente criar a tarefa novamente.',
		409,
	);
}

/** Promote one existing idea with the same operator contract used for new tasks. */
export function specifyOperatorIssue(
	cwd: string,
	id: string,
	rawInput: unknown,
	now: () => string = () => new Date().toISOString(),
): CreatedOperatorIssue {
	const issueId = requiredString(id, 'Issue');
	const input = parseOperatorSpecInput(rawInput);
	const updatedAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const entry = readBacklogFromMain(cwd, spawnSync, sourceSha)
			.find((issue) => issue.id === issueId);
		if (entry === undefined) {
			throw new IssueIntakeError('issue-not-found', `${issueId} não existe no backlog.`, 404);
		}
		if (entry.status !== 'open' || entry.stage !== 'idea') {
			throw new IssueIntakeError(
				'issue-not-eligible',
				`${issueId} precisa estar open e em stage:idea.`,
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
		const result = publishEntryAttempt(
			cwd,
			sourceSha,
			specified,
			`chore(gship): specify ${issueId}`,
		);
		if (result.kind === 'published') {
			fetchRuntimeSource(defaultRunGit, cwd);
			return result.issue;
		}
	}

	throw new IssueIntakeError(
		'publish-conflict',
		'O backlog avançou durante três tentativas; tente especificar a ideia novamente.',
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
): CreatedOperatorIssue {
	const issueId = requiredString(id, 'Issue');
	const input = parseOperatorAbandonInput(rawInput);
	const updatedAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const sourceSha = refreshRuntimeSource(cwd);
		const entry = readBacklogFromMain(cwd, spawnSync, sourceSha)
			.find((issue) => issue.id === issueId);
		if (entry === undefined) {
			throw new IssueIntakeError('issue-not-found', `${issueId} não existe no backlog.`, 404);
		}
		if (entry.status !== 'open') {
			throw new IssueIntakeError(
				'issue-not-eligible',
				`${issueId} precisa estar open.`,
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
		);
		if (result.kind === 'published') {
			fetchRuntimeSource(defaultRunGit, cwd);
			return result.issue;
		}
	}

	throw new IssueIntakeError(
		'publish-conflict',
		'O backlog avançou durante três tentativas; tente abandonar a tarefa novamente.',
		409,
	);
}
