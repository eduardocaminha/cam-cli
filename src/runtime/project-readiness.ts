// src/runtime/project-readiness.ts
//
// Read-only readiness for the one project the Gateship process was started in.
// The browser cannot remount a host directory into a running container, so
// onboarding diagnoses this cwd instead of pretending to be a project picker.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';

export type ProjectAttentionReason =
	| 'not-repository'
	| 'origin-missing'
	| 'github-origin-required'
	| 'origin-main-missing';

export type ProjectStatus =
	| {
		state: 'ready';
		name: string;
		repository: string;
		remoteUrl: string;
		sourceRef: 'origin/main';
	}
	| {
		state: 'empty';
		name: string;
		detail: string;
	}
	| {
		state: 'needs-attention';
		name: string;
		reason: ProjectAttentionReason;
		detail: string;
	};

export interface ProjectCommandResult {
	exitCode: number;
	stdout: string;
}

export type ProjectCommandRunner = (cwd: string, args: readonly string[]) => ProjectCommandResult;

/** The one local-metadata reader every readiness and registration path shares. */
export const readLocalGitMetadata: ProjectCommandRunner = (cwd, args) => {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: process.env,
	});
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout?.trim() ?? '',
	};
};

function githubRepository(remoteUrl: string): string | null {
	const normalized = remoteUrl.trim().replace(/\.git$/, '');
	const match = normalized.match(
		/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/i,
	);
	return match?.[1] ?? null;
}

function hasProjectContent(cwd: string): boolean {
	try {
		return readdirSync(cwd).some((entry) => entry !== '.gship' && entry !== '.DS_Store');
	} catch {
		return true;
	}
}

/**
 * Inspect only local Git metadata. No fetch, `gh` call, credential read or
 * mutation belongs on this GET path; a missing remote ref is an actionable
 * state for the operator rather than permission to contact GitHub implicitly.
 */
export function inspectProject(
	cwd: string,
	run: ProjectCommandRunner = readLocalGitMetadata,
): ProjectStatus {
	const requestedName = basename(resolve(cwd));
	const rootResult = run(cwd, ['rev-parse', '--show-toplevel']);
	if (rootResult.exitCode !== 0 || rootResult.stdout === '') {
		if (!hasProjectContent(cwd)) {
			return {
				state: 'empty',
				name: requestedName,
				detail: 'This folder does not contain a Git project yet.',
			};
		}
		return {
			state: 'needs-attention',
			name: requestedName,
			reason: 'not-repository',
			detail: 'The current folder contains files but is not part of a Git repository.',
		};
	}

	const root = rootResult.stdout;
	const name = basename(root);
	const originResult = run(root, ['remote', 'get-url', 'origin']);
	if (originResult.exitCode !== 0 || originResult.stdout === '') {
		return {
			state: 'needs-attention',
			name,
			reason: 'origin-missing',
			detail: 'The repository does not have a remote named origin.',
		};
	}

	const remoteUrl = originResult.stdout;
	const repository = githubRepository(remoteUrl);
	if (repository === null) {
		return {
			state: 'needs-attention',
			name,
			reason: 'github-origin-required',
			detail: 'The origin remote must point to a repository on GitHub.com.',
		};
	}

	const mainResult = run(root, [
		'rev-parse',
		'--verify',
		'--quiet',
		'refs/remotes/origin/main^{commit}',
	]);
	if (mainResult.exitCode !== 0) {
		return {
			state: 'needs-attention',
			name,
			reason: 'origin-main-missing',
			detail: 'The local origin/main reference does not exist yet. Fetch or publish the main branch.',
		};
	}

	return {
		state: 'ready',
		name,
		repository,
		remoteUrl,
		sourceRef: 'origin/main',
	};
}
