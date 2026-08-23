// src/runtime/project-import.ts
//
// The second multi-project onboarding seam, next to registering a checkout the
// operator already has on disk (GSHIP-716): import a GitHub repository the
// operator names by owner/repo or URL into a checkout Gateship manages and
// owns the location of.
//
// The destination is deterministic: <GATESHIP_HOME>/projects/<owner>/<repo>,
// the same product home every other durable Gateship state already lives
// under. A clone never writes there directly -- it lands in a unique staging
// directory confined to that same managed tree, and only a fully cloned,
// ready checkout is moved into the final destination. A failed or interrupted
// clone therefore never creates a registration and never leaves a partial
// checkout at the final destination; the only thing it can leave behind is its
// own staging directory, which is always cleaned up.
//
// Readiness and registration are never reimplemented here: a freshly cloned
// checkout and an already-present one both go through the exact same
// `inspectProject` / `registerExistingCheckout` contracts GSHIP-716 defined,
// so "the destination is already a ready checkout of this repository" and "a
// checkout registered by absolute path" are provably the same admission rule.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { runOwnedCommand, type CommandResult } from './git-runtime.ts';
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

/** GitHub's own required branch to import from; no other ref is accepted. */
const IMPORT_BRANCH = 'main';

/** Bounds one clone attempt; a stuck credential prompt or a stalled transfer ends here, not by hanging forever. */
export const PROJECT_IMPORT_CLONE_TIMEOUT_MS = 5 * 60 * 1000;

export type ProjectImportErrorCode =
	/** Missing, blank, or not `owner/repo` / an `https://github.com/owner/repo` URL. */
	| 'invalid-request'
	/** The destination exists and is not already a ready checkout of this repository. */
	| 'destination-conflict'
	/** `git clone` was refused or failed -- authentication, a missing repository, a missing `main` branch, or any other clone error. */
	| 'clone-failed'
	/** The clone did not finish inside `PROJECT_IMPORT_CLONE_TIMEOUT_MS`. */
	| 'clone-timeout'
	/** The clone finished, but the checkout it produced is not ready (see `readiness`). */
	| 'project-not-ready';

export class ProjectImportError extends Error {
	constructor(
		readonly code: ProjectImportErrorCode,
		message: string,
		readonly status: 400 | 409 | 502 | 504,
		/** The readiness detail behind a `destination-conflict` or `project-not-ready` refusal. */
		readonly readiness?: ProjectStatus,
	) {
		super(message);
		this.name = 'ProjectImportError';
	}
}

export interface ParsedRepository {
	owner: string;
	repo: string;
	/** Canonical `owner/repo`, exactly as stored, cloned from and matched against. */
	slug: string;
}

/** GitHub owner segment: alphanumeric with single interior hyphens, up to 39 characters. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]+)*$/;
/** GitHub repository segment: alphanumeric, dot, hyphen or underscore, up to 100 characters. */
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function invalidRepository(message: string): never {
	throw new ProjectImportError('invalid-request', message, 400);
}

/**
 * Accept only `owner/repo` or an `https://github.com/owner/repo` URL, and
 * normalize either to `owner/repo`. Every other host, extra path segment,
 * query, fragment, embedded credential or out-of-format character is refused
 * here, before anything derived from it ever reaches a spawned command.
 */
export function parseRepositorySpecifier(input: string): ParsedRepository {
	const trimmed = input.trim();
	if (trimmed.length === 0) invalidRepository('A non-empty repository is required.');

	let ownerRepo: string;
	if (/^https?:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			invalidRepository('The repository URL is not valid.');
		}
		if (
			url.protocol !== 'https:'
			|| url.hostname.toLowerCase() !== 'github.com'
			|| url.username.length > 0
			|| url.password.length > 0
			|| url.search.length > 0
			|| url.hash.length > 0
		) {
			invalidRepository('Only an HTTPS github.com/owner/repo URL is accepted.');
		}
		const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
		if (segments.length !== 2) {
			invalidRepository(
				'The URL must point to exactly github.com/owner/repo, with no extra path segments.',
			);
		}
		ownerRepo = `${segments[0]}/${segments[1]}`;
	} else {
		ownerRepo = trimmed;
	}

	ownerRepo = ownerRepo.replace(/\.git$/i, '');
	const parts = ownerRepo.split('/');
	if (parts.length !== 2) {
		invalidRepository('The repository must be "owner/repo" or an HTTPS github.com/owner/repo URL.');
	}
	const [owner, repo] = parts as [string, string];
	if (
		!OWNER_PATTERN.test(owner)
		|| owner.length > 39
		|| !REPO_PATTERN.test(repo)
		|| repo === '.'
		|| repo === '..'
	) {
		invalidRepository(
			'The repository must be "owner/repo" or an HTTPS github.com/owner/repo URL, with no other characters.',
		);
	}
	return { owner, repo, slug: `${owner}/${repo}` };
}

function requestedRepository(body: unknown): string {
	const value = body !== null && typeof body === 'object' && !Array.isArray(body)
		? (body as { repository?: unknown }).repository
		: undefined;
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ProjectImportError('invalid-request', 'A JSON repository is required.', 400);
	}
	return value;
}

/** Argv `git clone` runs with -- one array, no shell, so nothing in `url` or `destination` is ever interpolated. */
export function buildCloneArgv(url: string, destination: string): string[] {
	return ['git', 'clone', '--quiet', '--branch', IMPORT_BRANCH, '--single-branch', url, destination];
}

export interface GitCloneInput {
	url: string;
	/** An existing directory the clone process starts from; never the destination itself, which git creates. */
	cwd: string;
	destination: string;
	timeoutMs: number;
}

export type CloneResult = CommandResult & { timedOut: boolean };

export type GitCloneRunner = (input: GitCloneInput) => Promise<CloneResult>;

/**
 * Clone by argv, in a non-interactive environment, bounded by a timeout. No
 * credential is read, passed or stored here: `GIT_TERMINAL_PROMPT=0` makes a
 * clone that would otherwise prompt for one fail immediately instead of
 * hanging, and authentication itself is left entirely to whatever credential
 * helper is already configured for this process -- a public repository needs
 * none, a private one needs the operator's existing GitHub login.
 */
export async function defaultCloneRepository(input: GitCloneInput): Promise<CloneResult> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, input.timeoutMs);
	try {
		const result = await runOwnedCommand({
			cmd: buildCloneArgv(input.url, input.destination),
			cwd: input.cwd,
			signal: controller.signal,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		return { ...result, timedOut: false };
	} catch (error) {
		if (!timedOut) throw error;
		return {
			exitCode: 124,
			stdout: '',
			stderr: `git clone timed out after ${input.timeoutMs}ms`,
			timedOut: true,
		};
	} finally {
		clearTimeout(timer);
	}
}

export interface ImportRepositoryOptions {
	/** Test seam for local Git metadata reads; production reads real Git. */
	run?: ProjectCommandRunner;
	/** Test seam for the clone step; production spawns real `git clone`. */
	clone?: GitCloneRunner;
	cloneTimeoutMs?: number;
}

/** Registration through the one canonical contract (GSHIP-716), with clone-specific refusals instead of registration ones. */
function registerImportedCheckout(
	destination: string,
	registry: ProjectRegistry,
	currentRoot: string,
	run: ProjectCommandRunner,
): RegisteredProject {
	try {
		return registerExistingCheckout({ root: destination }, registry, currentRoot, run);
	} catch (error) {
		if (error instanceof ProjectRegistrationError) {
			throw new ProjectImportError('project-not-ready', error.message, 409, error.readiness);
		}
		throw error;
	}
}

function conflictError(destination: string, slug: string, readiness?: ProjectStatus): ProjectImportError {
	return new ProjectImportError(
		'destination-conflict',
		`${destination} already exists and is not a ready checkout of ${slug}.`,
		409,
		readiness,
	);
}

/** `true` when `destination` is already a ready checkout of `slug` -- the caller only has to register it. */
function isReadyDestination(destination: string, slug: string, run: ProjectCommandRunner): boolean {
	if (!existsSync(destination)) return false;
	const readiness = inspectProject(destination, run);
	if (readiness.state === 'ready' && readiness.repository.toLowerCase() === slug.toLowerCase()) {
		return true;
	}
	throw conflictError(destination, slug, readiness);
}

/**
 * Clone `slug` into a unique staging directory confined to `projectsRoot`, and
 * move it into `destination` only once it is a fully cloned, ready checkout.
 * Every failure -- the clone itself, a timeout, an unready result or a losing
 * race against a concurrent import -- cleans up the staging directory and
 * throws instead of leaving anything at `destination`.
 */
async function cloneIntoDestination(
	projectsRoot: string,
	destination: string,
	slug: string,
	clone: GitCloneRunner,
	cloneTimeoutMs: number,
	run: ProjectCommandRunner,
): Promise<void> {
	const stagingParent = join(projectsRoot, '.staging');
	mkdirSync(stagingParent, { recursive: true });
	const staging = join(stagingParent, randomUUID());
	const cleanupStaging = (): void => {
		try {
			rmSync(staging, { recursive: true, force: true });
		} catch {
			// Best effort: a directory this process could create, it can also remove.
		}
	};

	let cloneResult: CloneResult;
	try {
		cloneResult = await clone({
			url: `https://github.com/${slug}.git`,
			cwd: stagingParent,
			destination: staging,
			timeoutMs: cloneTimeoutMs,
		});
	} catch (error) {
		cleanupStaging();
		throw new ProjectImportError('clone-failed', error instanceof Error ? error.message : String(error), 502);
	}
	if (cloneResult.timedOut) {
		cleanupStaging();
		throw new ProjectImportError('clone-timeout', `Cloning ${slug} timed out after ${cloneTimeoutMs}ms.`, 504);
	}
	if (cloneResult.exitCode !== 0) {
		cleanupStaging();
		const detail = cloneResult.stderr.trim() || cloneResult.stdout.trim() || `git exited with ${cloneResult.exitCode}`;
		throw new ProjectImportError('clone-failed', `Cloning ${slug} failed: ${detail}`, 502);
	}

	const readiness = inspectProject(staging, run);
	if (readiness.state !== 'ready') {
		cleanupStaging();
		throw new ProjectImportError('project-not-ready', readiness.detail, 409, readiness);
	}

	// A second admission raced this same import between the pre-check and here;
	// refuse instead of overwriting whatever it left.
	if (existsSync(destination)) {
		cleanupStaging();
		throw conflictError(destination, slug);
	}

	try {
		mkdirSync(dirname(destination), { recursive: true });
		renameSync(staging, destination);
	} catch (error) {
		cleanupStaging();
		throw new ProjectImportError('clone-failed', error instanceof Error ? error.message : String(error), 502);
	}
}

/**
 * Import a GitHub repository into a Gateship-managed checkout, or return the
 * existing one if the destination is already a ready checkout of the same
 * repository. Every other pre-existing destination is a conflict, refused
 * without being touched. A clone failure, timeout or post-clone readiness
 * refusal all clean up their own staging directory and leave no registration
 * and no partial checkout behind.
 */
export async function importRepository(
	body: unknown,
	registry: ProjectRegistry,
	currentRoot: string,
	gateshipHome: string,
	options: ImportRepositoryOptions = {},
): Promise<RegisteredProject> {
	const run = options.run ?? readLocalGitMetadata;
	const clone = options.clone ?? defaultCloneRepository;
	const cloneTimeoutMs = options.cloneTimeoutMs ?? PROJECT_IMPORT_CLONE_TIMEOUT_MS;

	const { owner, repo, slug } = parseRepositorySpecifier(requestedRepository(body));
	const projectsRoot = join(gateshipHome, 'projects');
	const destination = join(projectsRoot, owner, repo);

	if (!isReadyDestination(destination, slug, run)) {
		await cloneIntoDestination(projectsRoot, destination, slug, clone, cloneTimeoutMs, run);
	}

	return registerImportedCheckout(destination, registry, currentRoot, run);
}
