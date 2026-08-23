import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { buildGithubCliEnv } from './child-env.ts';
import { ensureGitIdentity, type GitIdentityResult } from './git-identity.ts';
import { runOwnedCommand, type CommandResult } from './git-runtime.ts';
import { parseRepositorySpecifier, ProjectImportError } from './project-import.ts';
import {
	inspectProject,
	readLocalGitMetadata,
	type ProjectCommandRunner,
	type ProjectStatus,
} from './project-readiness.ts';
import {
	ProjectRegistrationError,
	registerExistingCheckout,
} from './project-registration.ts';
import type { ProjectRegistry, RegisteredProject } from './project-registry.ts';

export const PROJECT_DESCRIPTION_MAX_LENGTH = 350;

export type ProjectVisibility = 'private' | 'public';

export type ProjectCreateErrorCode =
	| 'invalid-request'
	| 'invalid-authorization'
	| 'local-conflict'
	| 'remote-conflict'
	| 'git-identity'
	| 'create-failed'
	| 'partial-create';

export class ProjectCreateError extends Error {
	constructor(
		readonly code: ProjectCreateErrorCode,
		message: string,
		readonly status: 400 | 409 | 502,
		readonly recovery?: {
			repository: string;
			root: string;
			readiness: ProjectStatus;
		},
	) {
		super(message);
		this.name = 'ProjectCreateError';
	}
}

export interface ProjectCreateCommandInput {
	cmd: string[];
	cwd: string;
}

export type ProjectCreateCommandRunner = (
	input: ProjectCreateCommandInput,
) => Promise<CommandResult>;

async function defaultRunCreateCommand(input: ProjectCreateCommandInput): Promise<CommandResult> {
	return runOwnedCommand({
		cmd: input.cmd,
		cwd: input.cwd,
		signal: new AbortController().signal,
		...(input.cmd[0] === 'gh' ? { env: buildGithubCliEnv(process.env) } : {}),
	});
}

interface CreateProjectInput {
	repository: string;
	visibility: ProjectVisibility;
	description?: string;
	authorization: string;
}

function inputRecord(body: unknown): Record<string, unknown> {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw new ProjectCreateError('invalid-request', 'A JSON object is required.', 400);
	}
	return body as Record<string, unknown>;
}

function refuseUnsupportedInput(input: Record<string, unknown>): void {
	const allowed = new Set(['repository', 'visibility', 'description', 'authorization']);
	const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
	if (unsupported.length === 0) return;
	throw new ProjectCreateError(
		'invalid-request',
		`Unsupported project creation field: ${unsupported.join(', ')}.`,
		400,
	);
}

function requestedRepository(input: Record<string, unknown>): string {
	const repository = input.repository;
	if (typeof repository !== 'string' || repository.trim().length === 0) {
		throw new ProjectCreateError('invalid-request', 'A JSON repository is required.', 400);
	}
	return repository;
}

function requestedVisibility(input: Record<string, unknown>): ProjectVisibility {
	const visibility = input.visibility;
	if (visibility !== 'private' && visibility !== 'public') {
		throw new ProjectCreateError('invalid-request', 'Visibility must be private or public.', 400);
	}
	return visibility;
}

function requestedAuthorization(input: Record<string, unknown>): string {
	const authorization = input.authorization;
	if (typeof authorization !== 'string' || authorization.trim().length === 0) {
		throw new ProjectCreateError(
			'invalid-authorization',
			'Explicit operator authorization naming the repository and visibility is required.',
			400,
		);
	}
	return authorization.trim();
}

function requestedDescription(input: Record<string, unknown>): string | undefined {
	const value = input.description;
	if (value === undefined) return undefined;
	if (typeof value !== 'string') {
		throw new ProjectCreateError('invalid-request', 'Description must be a string.', 400);
	}
	const description = value.trim();
	if (description.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
		throw new ProjectCreateError(
			'invalid-request',
			`Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters.`,
			400,
		);
	}
	return description === '' ? undefined : description;
}

function createInput(body: unknown): CreateProjectInput {
	const input = inputRecord(body);
	refuseUnsupportedInput(input);
	const description = requestedDescription(input);
	return {
		repository: requestedRepository(input),
		visibility: requestedVisibility(input),
		...(description === undefined ? {} : { description }),
		authorization: requestedAuthorization(input),
	};
}

function parsedRepository(repository: string): { owner: string; repo: string; slug: string } {
	try {
		return parseRepositorySpecifier(repository);
	} catch (error) {
		if (error instanceof ProjectImportError) {
			throw new ProjectCreateError('invalid-request', error.message, 400);
		}
		throw error;
	}
}

export function buildRepositoryExistsArgv(repository: string): string[] {
	return ['gh', 'repo', 'view', repository, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'];
}

export function buildRepositoryCreateArgv(
	repository: string,
	root: string,
	visibility: ProjectVisibility,
	description?: string,
): string[] {
	return [
		'gh', 'repo', 'create', repository,
		visibility === 'private' ? '--private' : '--public',
		...(description === undefined ? [] : ['--description', description]),
		'--source', root,
		'--remote', 'origin',
		'--push',
	];
}

function commandDetail(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `command exited with ${result.exitCode}`;
}

function repositoryWasNotFound(result: CommandResult): boolean {
	return /could not resolve to a repository|http 404|repository[^\n]*not found|requested url returned error: 404/i.test(
		`${result.stderr}\n${result.stdout}`,
	);
}

async function refuseExistingRemote(
	repository: string,
	cwd: string,
	runCommand: ProjectCreateCommandRunner,
): Promise<void> {
	let result: CommandResult;
	try {
		result = await runCommand({ cmd: buildRepositoryExistsArgv(repository), cwd });
	} catch (error) {
		throw new ProjectCreateError(
			'create-failed',
			`Could not confirm that ${repository} is available: ${error instanceof Error ? error.message : String(error)}`,
			502,
		);
	}
	if (result.exitCode === 0) {
		throw new ProjectCreateError(
			'remote-conflict',
			`${repository} already exists on GitHub. Use Import GitHub instead.`,
			409,
		);
	}
	if (!repositoryWasNotFound(result)) {
		throw new ProjectCreateError(
			'create-failed',
			`Could not confirm that ${repository} is available: ${commandDetail(result)}`,
			502,
		);
	}
}

function createdDirectories(root: string): string[] {
	const created: string[] = [];
	let cursor = root;
	while (!existsSync(cursor)) {
		created.push(cursor);
		cursor = dirname(cursor);
	}
	return created;
}

function cleanCreatedCheckout(root: string, created: readonly string[], ownsRoot: boolean): void {
	if (ownsRoot) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			return;
		}
	}
	for (const directory of created.slice(1)) {
		try {
			rmdirSync(directory);
		} catch {
			break;
		}
	}
}

function partialCreate(
	repository: string,
	root: string,
	readiness: ProjectStatus,
	detail: string,
): ProjectCreateError {
	return new ProjectCreateError(
		'partial-create',
		`GitHub repository creation may have started, but ${repository} is not ready in Gateship: ${detail}. The managed checkout was preserved at ${root}.`,
		502,
		{ repository, root, readiness },
	);
}

export interface CreateProjectOptions {
	run?: ProjectCommandRunner;
	runCommand?: ProjectCreateCommandRunner;
	ensureIdentity?: (cwd: string) => GitIdentityResult;
}

interface CreationAttempt {
	createdDirectories: string[];
	ownsRoot: boolean;
	remoteMayExist: boolean;
}

interface CreateProjectContext {
	input: CreateProjectInput;
	registry: ProjectRegistry;
	currentRoot: string;
	repo: string;
	slug: string;
	root: string;
	run: ProjectCommandRunner;
	runCommand: ProjectCreateCommandRunner;
	ensureIdentity: (cwd: string) => GitIdentityResult;
	attempt: CreationAttempt;
}

function localConflict(root: string): ProjectCreateError {
	return new ProjectCreateError(
		'local-conflict',
		`${root} already exists. Use Import GitHub instead; Gateship will not adopt or overwrite it.`,
		409,
	);
}

function refuseExistingDestination(root: string): void {
	if (existsSync(root)) throw localConflict(root);
}

function createManagedRoot(context: CreateProjectContext): void {
	mkdirSync(dirname(context.root), { recursive: true });
	try {
		// Exclusive final admission: a destination created after the preflight is
		// a conflict too, and must never be adopted, overwritten or cleaned up.
		mkdirSync(context.root);
		context.attempt.ownsRoot = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw localConflict(context.root);
		throw error;
	}
}

async function runInitializationCommand(
	context: CreateProjectContext,
	cmd: string[],
): Promise<void> {
	const result = await context.runCommand({ cmd, cwd: context.root });
	if (result.exitCode === 0) return;
	throw new ProjectCreateError(
		'create-failed',
		`Could not initialize ${context.slug}: ${commandDetail(result)}`,
		502,
	);
}

async function initializeCheckout(context: CreateProjectContext): Promise<void> {
	createManagedRoot(context);
	await runInitializationCommand(context, ['git', 'init', '--quiet', '-b', 'main']);
	// Check the identity in the repository that will actually commit. A local
	// identity in the boot project does not automatically apply here.
	const identity = context.ensureIdentity(context.root);
	if (identity.outcome === 'missing') {
		throw new ProjectCreateError('git-identity', identity.detail, 409);
	}
	writeFileSync(join(context.root, 'README.md'), `# ${context.repo}\n`);
	await runInitializationCommand(context, ['git', 'add', 'README.md']);
	await runInitializationCommand(context, ['git', 'commit', '--quiet', '-m', 'Initial commit']);
}

function registerCreatedCheckout(
	context: CreateProjectContext,
	readiness: ProjectStatus,
): RegisteredProject {
	try {
		return registerExistingCheckout(
			{ root: context.root },
			context.registry,
			context.currentRoot,
			context.run,
		);
	} catch (error) {
		if (error instanceof ProjectRegistrationError) {
			throw partialCreate(
				context.slug,
				context.root,
				error.readiness ?? readiness,
				error.message,
			);
		}
		throw error;
	}
}

async function publishCheckout(context: CreateProjectContext): Promise<RegisteredProject> {
	context.attempt.remoteMayExist = true;
	const result = await context.runCommand({
		cmd: buildRepositoryCreateArgv(
			context.slug,
			context.root,
			context.input.visibility,
			context.input.description,
		),
		cwd: context.root,
	});
	const readiness = inspectProject(context.root, context.run);
	if (readiness.state !== 'ready') {
		throw partialCreate(context.slug, context.root, readiness, commandDetail(result));
	}
	return registerCreatedCheckout(context, readiness);
}

function preRemoteFailure(context: CreateProjectContext, error: unknown): never {
	cleanCreatedCheckout(
		context.root,
		context.attempt.createdDirectories,
		context.attempt.ownsRoot,
	);
	if (error instanceof ProjectCreateError) throw error;
	throw new ProjectCreateError(
		'create-failed',
		`Could not initialize ${context.slug}: ${error instanceof Error ? error.message : String(error)}`,
		502,
	);
}

function tryRegisterRecoveredCheckout(
	context: CreateProjectContext,
	readiness: ProjectStatus,
): RegisteredProject | null {
	if (readiness.state !== 'ready') return null;
	try {
		return registerExistingCheckout(
			{ root: context.root },
			context.registry,
			context.currentRoot,
			context.run,
		);
	} catch {
		return null;
	}
}

function postRemoteFailure(
	context: CreateProjectContext,
	error: unknown,
): RegisteredProject {
	if (error instanceof ProjectCreateError && error.code === 'partial-create') throw error;
	const readiness = inspectProject(context.root, context.run);
	const recovered = tryRegisterRecoveredCheckout(context, readiness);
	if (recovered !== null) return recovered;
	throw partialCreate(
		context.slug,
		context.root,
		readiness,
		error instanceof Error ? error.message : String(error),
	);
}

function recoverCreateFailure(
	context: CreateProjectContext,
	error: unknown,
): RegisteredProject {
	if (!context.attempt.remoteMayExist) return preRemoteFailure(context, error);
	return postRemoteFailure(context, error);
}

export async function createProject(
	body: unknown,
	registry: ProjectRegistry,
	currentRoot: string,
	gateshipHome: string,
	options: CreateProjectOptions = {},
): Promise<RegisteredProject> {
	const input = createInput(body);
	const { owner, repo, slug } = parsedRepository(input.repository);
	const root = join(gateshipHome, 'projects', owner, repo);
	const run = options.run ?? readLocalGitMetadata;
	const runCommand = options.runCommand ?? defaultRunCreateCommand;
	refuseExistingDestination(root);
	await refuseExistingRemote(slug, currentRoot, runCommand);
	const context: CreateProjectContext = {
		input,
		registry,
		currentRoot,
		repo,
		slug,
		root,
		run,
		runCommand,
		ensureIdentity: options.ensureIdentity ?? ((cwd: string) => ensureGitIdentity(cwd)),
		attempt: {
			createdDirectories: createdDirectories(root),
			ownsRoot: false,
			remoteMayExist: false,
		},
	};
	try {
		await initializeCheckout(context);
		return await publishCheckout(context);
	} catch (error) {
		return recoverCreateFailure(context, error);
	}
}
