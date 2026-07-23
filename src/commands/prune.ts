// src/commands/prune.ts
//
// Implementation of `cam prune` — deterministic branch-cleanup CLI subcommand
// (US-001, CAM-400).
//
// De-inlines .claude/commands/cam-prune.md's LLM-driven git dance into a pure,
// zero-LLM primitive: the orchestrator calls this directly and narrates the
// result, instead of spawning a pane and letting an agent run the same steps.
//
// Steps (faithful to the original slash command):
//   1. Dirty-tree check (`git status --porcelain`) — STOP if uncommitted
//      changes exist. Never bypassable via --force.
//   2. Current branch (`git branch --show-current`) — STOP if already on
//      main/master. Never bypassable via --force (never delete main).
//   3. Confirmation: not a `cam/*` branch — STOP unless --force.
//   4. Confirmation: open (unmerged) PR detected via `gh pr view` — STOP
//      unless --force. Skipped entirely when --force is passed (mirrors the
//      "force bypasses the confirmation" contract: no gh call is needed once
//      the confirmation itself is bypassed).
//   5. `git checkout main`, `git pull origin main`, `git branch -D <branch>`,
//      `git fetch --prune`.
//
// All git/gh calls run through injected SpawnFn deps so tests never shell out.

import process from 'node:process';

import { realOnMainSpawnFn, type SpawnFn } from '../git/on-main.ts';
import { printError } from '../logging/color.ts';
import { emitOk, emitTitle, emitTrailingBlank } from '../logging/screen.ts';

export type { SpawnFn };

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

/** Parsed arguments for `cam prune`. */
export interface ParsedPruneArgs {
	force: boolean;
	help: boolean;
}

/**
 * Parse `cam prune [--force]` arguments. Returns `{ force: false, help: true
 * }` on `--help`/`-h` (checked first, short-circuiting any --force also
 * present), `null` on any unrecognized argument (caller prints a fatal
 * hint), or `{ force, help: false }` otherwise.
 */
export function parsePruneArgs(argv: string[]): ParsedPruneArgs | null {
	if (argv.includes('--help') || argv.includes('-h')) {
		return { force: false, help: true };
	}
	let force = false;
	for (const arg of argv) {
		if (arg === '--force') {
			force = true;
		} else {
			printError(`unexpected argument: ${arg}`);
			return null;
		}
	}
	return { force, help: false };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export interface PruneOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Skip the non-cam/* branch and open-PR confirmations. Never bypasses the dirty-tree or main-branch STOP. */
	force?: boolean;
	/** Injectable spawnSync for all git subprocess calls. Default: realOnMainSpawnFn. */
	spawnFn?: SpawnFn;
	/** Injectable spawnSync for the `gh pr view` call. Default: same as spawnFn. */
	ghSpawnFn?: SpawnFn;
}

/** Shape of `gh pr view --json state,mergedAt,url` stdout we care about. */
interface GhPrView {
	state?: string;
	mergedAt?: string | null;
	url?: string;
}

/**
 * Step 1: dirty-tree check. Never bypassable via --force. Returns `true` when
 * the working tree is clean and the check itself succeeded; prints the
 * appropriate error and returns `false` otherwise.
 */
function checkWorkingTreeClean(spawnFn: SpawnFn, cwd: string): boolean {
	const statusResult = spawnFn('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' });
	if ((statusResult.status ?? 1) !== 0) {
		printError('cam prune: git status failed', (statusResult.stderr ?? '').trim() || 'unknown error');
		return false;
	}
	if ((statusResult.stdout ?? '').trim().length > 0) {
		printError('cannot prune — uncommitted changes detected', 'commit or stash first');
		return false;
	}
	return true;
}

/**
 * Step 2: resolve the current branch. Main/master and detached-HEAD are hard
 * STOPs, never bypassable via --force. Returns the branch name on success, or
 * `null` after printing the appropriate error.
 */
function resolvePrunableBranch(spawnFn: SpawnFn, cwd: string): string | null {
	const branchResult = spawnFn('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
	if ((branchResult.status ?? 1) !== 0) {
		printError('cam prune: git branch --show-current failed', (branchResult.stderr ?? '').trim() || 'unknown error');
		return null;
	}
	const branch = (branchResult.stdout ?? '').trim();
	if (branch === 'main' || branch === 'master') {
		printError('already on main — nothing to prune');
		return null;
	}
	if (branch.length === 0) {
		printError('cam prune: could not determine current branch (detached HEAD?)');
		return null;
	}
	return branch;
}

/**
 * Step 4: does `gh pr view` report an open, unmerged PR for the current
 * branch? Any non-zero exit, no-PR, or malformed-JSON result is treated as
 * "no open-PR signal" (`false`) rather than an error — matching the original
 * slash command's "no PR exists: proceed without confirmation" rule.
 */
function hasOpenUnmergedPr(ghSpawnFn: SpawnFn): { open: boolean; url?: string } {
	const prResult = ghSpawnFn('gh', ['pr', 'view', '--json', 'state,mergedAt,url'], { encoding: 'utf8' });
	if ((prResult.status ?? 1) !== 0) return { open: false };
	let pr: GhPrView | null = null;
	try {
		pr = JSON.parse((prResult.stdout ?? '').trim() || '{}') as GhPrView;
	} catch {
		pr = null;
	}
	if (pr === null || pr.state !== 'OPEN' || pr.mergedAt) return { open: false };
	return { open: true, ...(pr.url !== undefined ? { url: pr.url } : {}) };
}

/**
 * Steps 3-4: confirmation gate for non-cam/* branches and open unmerged PRs.
 * Only called when `!force` (force bypasses both confirmations entirely,
 * including the gh call). Returns `true` when pruning may proceed.
 */
function confirmPruneAllowed(branch: string, ghSpawnFn: SpawnFn): boolean {
	if (!branch.startsWith('cam/')) {
		printError(`branch "${branch}" is not a cam/* branch`, 're-run with --force to prune it anyway');
		return false;
	}
	const prCheck = hasOpenUnmergedPr(ghSpawnFn);
	if (prCheck.open) {
		printError(
			`branch "${branch}" has an open PR: ${prCheck.url ?? 'unknown url'}`,
			're-run with --force to prune it anyway (the PR will remain open, only the local branch is deleted)',
		);
		return false;
	}
	return true;
}

/**
 * Step 5: checkout main, pull, delete the branch, prune remote-tracking
 * refs. Returns `true` on full success; prints the failing step's error and
 * returns `false` on the first non-zero exit.
 */
function performPruneDance(spawnFn: SpawnFn, cwd: string, branch: string): boolean {
	const steps: Array<{ label: string; args: string[] }> = [
		{ label: 'git checkout main', args: ['checkout', 'main'] },
		{ label: 'git pull origin main', args: ['pull', 'origin', 'main'] },
		{ label: `git branch -D ${branch}`, args: ['branch', '-D', branch] },
		{ label: 'git fetch --prune', args: ['fetch', '--prune'] },
	];
	for (const step of steps) {
		const result = spawnFn('git', ['-C', cwd, ...step.args], { encoding: 'utf8' });
		if ((result.status ?? 1) !== 0) {
			printError(`cam prune: ${step.label} failed`, (result.stderr ?? '').trim() || 'unknown error');
			return false;
		}
	}
	return true;
}

/**
 * Run `cam prune`. Exit codes:
 *   0 — branch pruned (or nothing to do isn't a distinct case: `main` is a
 *       hard STOP, not a no-op success).
 *   1 — dirty tree, already on main, non-cam/* branch without --force, open
 *       unmerged PR without --force, or any underlying git call failed.
 */
export function runPrune(options: PruneOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const force = options.force ?? false;
	const spawnFn = options.spawnFn ?? realOnMainSpawnFn;
	const ghSpawnFn = options.ghSpawnFn ?? spawnFn;

	if (!checkWorkingTreeClean(spawnFn, cwd)) return 1;

	const branch = resolvePrunableBranch(spawnFn, cwd);
	if (branch === null) return 1;

	if (!force && !confirmPruneAllowed(branch, ghSpawnFn)) return 1;

	if (!performPruneDance(spawnFn, cwd, branch)) return 1;

	emitTitle('cam prune');
	emitOk(`pruned branch: ${branch}`, 'now on main (up to date with origin)');
	emitTrailingBlank();
	return 0;
}
