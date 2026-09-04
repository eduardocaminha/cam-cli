// src/runtime/project-checkout.ts
//
// One local-Git seam for identifying the primary checkout behind any path in a
// repository. Linked worktrees are Git implementation detail, never projects.

import { realpathSync } from 'node:fs';

import { readLocalGitMetadata, type ProjectCommandRunner } from './project-readiness.ts';

export interface ProjectCheckout {
	/** The actual checkout containing the requested directory. */
	root: string;
	/** The repository's primary checkout, including when `root` is linked. */
	primaryRoot: string;
	linked: boolean;
}

function primaryWorktree(stdout: string): string | null {
	// Git's porcelain output lists the main worktree first. `-z` keeps this a
	// metadata protocol even when a checkout path contains whitespace or lines.
	const first = stdout.split('\0').find((line) => line.startsWith('worktree '));
	return first === undefined ? null : first.slice('worktree '.length);
}

/**
 * Resolves any directory within a checkout to its Git-declared primary
 * worktree. A non-repository has no checkout result; callers retain their
 * existing readiness behavior in that case.
 */
export function resolveProjectCheckout(
	cwd: string,
	run: ProjectCommandRunner = readLocalGitMetadata,
): ProjectCheckout | null {
	const topLevel = run(cwd, ['rev-parse', '--show-toplevel']);
	if (topLevel.exitCode !== 0 || topLevel.stdout === '') return null;
	const root = realpathSync(topLevel.stdout);
	const worktrees = run(root, ['worktree', 'list', '--porcelain', '-z']);
	const primary = worktrees.exitCode === 0 ? primaryWorktree(worktrees.stdout) : null;
	const primaryRoot = primary === null ? root : realpathSync(primary);
	return { root, primaryRoot, linked: root !== primaryRoot };
}
