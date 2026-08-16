import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { numericIdSuffix, readBacklogFromMain } from '../issues/backlog.ts';
import { parseOracleDirective } from '../issues/oracle-directive.ts';
import { type Spec, validateSpec } from '../issues/spec.ts';
import type { IssueEntry } from '../issues/types.ts';
import { defaultRunGit } from './git-runtime.ts';
import { fetchRuntimeSource, RUNTIME_SOURCE_REF } from './source-ref.ts';

const MAX_PUBLISH_ATTEMPTS = 3;

export interface OperatorIssueInput {
	title: string;
	scope: string;
	verificationCommand: string;
}

export interface CreatedOperatorIssue {
	id: string;
	title: string;
	sha: string;
}

export type IssueIntakeErrorCode =
	| 'invalid-request'
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
export function parseOperatorIssueInput(value: unknown): OperatorIssueInput {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'Um objeto JSON é obrigatório.', 400);
	}
	const input = value as Record<string, unknown>;
	return {
		title: requiredString(input['title'], 'Título'),
		scope: requiredString(input['scope'], 'Escopo'),
		verificationCommand: requiredString(
			input['verificationCommand'],
			'Comando de verificação',
		),
	};
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

function buildIssue(input: OperatorIssueInput, id: string, now: string): IssueEntry {
	const criterion = `${input.scope} [oracle: named-command ${input.verificationCommand}]`;
	const directive = parseOracleDirective(criterion);
	if (directive?.kind !== 'named-command' || directive.command !== input.verificationCommand) {
		throw new IssueIntakeError(
			'invalid-request',
			'O comando de verificação contém colchetes incompatíveis com a diretiva de oracle.',
			400,
		);
	}
	const spec: Spec = {
		acceptanceCriteria: [criterion],
		scope: input.scope,
		gotchas: [],
		domainTerms: [],
	};
	const validated = validateSpec(spec);
	if (!validated.ok) {
		throw new IssueIntakeError('invalid-request', validated.errors.join(' '), 400);
	}
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
	};
}

function isPushRace(stderr: string): boolean {
	return /non-fast-forward|fetch first/i.test(stderr);
}

function publishAttempt(
	cwd: string,
	sourceSha: string,
	input: OperatorIssueInput,
	now: string,
): { kind: 'published'; issue: CreatedOperatorIssue } | { kind: 'retry' } {
	const number = nextIssueNumber(cwd, sourceSha);
	const id = `CAM-${number}`;
	const filename = `CAM-${String(number).padStart(4, '0')}.json`;
	const entry = buildIssue(input, id, now);
	const tempRoot = mkdtempSync(join(tmpdir(), 'gship-intake-'));
	const worktree = join(tempRoot, 'checkout');

	try {
		const added = git(cwd, ['worktree', 'add', '--quiet', '--detach', worktree, sourceSha]);
		if (added.exitCode !== 0) throw commandFailure('Não foi possível preparar o intake', added.stderr);

		const issueDir = join(worktree, 'scripts', 'cam', 'issues');
		mkdirSync(issueDir, { recursive: true });
		writeFileSync(join(issueDir, filename), `${JSON.stringify(entry, null, 2)}\n`);

		const staged = git(worktree, ['add', '--', `scripts/cam/issues/${filename}`]);
		if (staged.exitCode !== 0) throw commandFailure('Não foi possível registrar a tarefa', staged.stderr);
		const committed = git(worktree, ['commit', '--quiet', '-m', `chore(gship): file ${id}`]);
		if (committed.exitCode !== 0) throw commandFailure('Não foi possível criar o commit', committed.stderr);
		const shaResult = git(worktree, ['rev-parse', 'HEAD']);
		if (shaResult.exitCode !== 0) throw commandFailure('Não foi possível resolver o commit', shaResult.stderr);
		const sha = shaResult.stdout.trim();

		const pushed = git(worktree, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
		if (pushed.exitCode === 0) {
			return { kind: 'published', issue: { id, title: input.title, sha } };
		}
		if (isPushRace(pushed.stderr)) return { kind: 'retry' };
		throw commandFailure('Não foi possível publicar a tarefa', pushed.stderr);
	} finally {
		git(cwd, ['worktree', 'remove', '--force', worktree]);
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

/**
 * File one operator-specified issue on the remote main without moving the
 * local main ref or touching the host working tree. A non-fast-forward push
 * refreshes origin/main and re-allocates the id from the new immutable base.
 */
export function createOperatorIssue(
	cwd: string,
	rawInput: unknown,
	now: () => string = () => new Date().toISOString(),
): CreatedOperatorIssue {
	const input = parseOperatorIssueInput(rawInput);
	const createdAt = now();

	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
		const fetched = fetchRuntimeSource(defaultRunGit, cwd);
		if (fetched.exitCode !== 0) {
			throw commandFailure(`Não foi possível atualizar ${RUNTIME_SOURCE_REF}`, fetched.stderr);
		}
		const resolved = git(cwd, ['rev-parse', '--verify', RUNTIME_SOURCE_REF]);
		if (resolved.exitCode !== 0) {
			throw commandFailure(`Não foi possível resolver ${RUNTIME_SOURCE_REF}`, resolved.stderr);
		}
		const result = publishAttempt(cwd, resolved.stdout.trim(), input, createdAt);
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
