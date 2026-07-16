// src/commands/issue-file.ts
//
// createLocalIssueOnMain() -- file a new issue to
// scripts/cam/issues/CAM-NNNN.json directly on main, from any branch.
//
// Design goals:
//   - Id allocation is collision-free: allocateId reads the committed backlog
//     in scripts/cam/issues/ on main via git ls-tree + cat-file --batch;
//     never reads from the working tree (which may lag behind main).
//   - All writes go to a single CAM-NNNN.json file via writeIssueFile (US-003
//     CAS-hardened on-main commit). The old array backlog file is never touched.
//   - All external dependencies are injectable for unit-testing without a real
//     git binary or filesystem.
//
// US-005 additions (preserved from the earlier array-backlog version):
//   - Up-to-date guard: best-effort fetch + local vs origin/main sha comparison;
//     skip when origin/main is absent (no remote configured).
//   - Detached HEAD and missing local main branch: clear errors returned as
//     { ok: false, reason } before any mutation.
//   - Best-effort push after commit: non-zero exit is logged via printError,
//     never silently swallowed.
//
// CAM-90 US-004 (file-per-issue cutover).

import { parseToml } from '../config/toml.ts';
import { writeIssueFile } from '../issues/alloc.ts';
import { readBacklogFromMain } from '../issues/backlog.ts';
import type { BacklogSpawnFn } from '../issues/backlog.ts';
import { validateSpecSource } from '../issues/spec.ts';
import type { WsjfScore } from '../issues/types.ts';
import type { SpawnFn } from '../git/on-main.ts';
import { printError } from '../logging/color.ts';

// Re-export SpawnFn from the shared module so existing callers do not need
// to update their import paths.
export type { SpawnFn };

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateLocalIssueOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Issue title. */
	title: string;
	/** Optional long description. */
	description?: string;
	/** Optional priority (accepted for backward compat; never written into the entry). */
	priority?: string;
	/**
	 * Source of the spec, derived from CLI flags:
	 *   'operator' (from --fast-track) or 'derived' (from --derived-from).
	 * When present, guardrails are enforced and stage is set to 'specified'.
	 * Absent on normal filing (no flags) -- stage stays 'idea'.
	 */
	specSource?: 'interview' | 'derived' | 'operator';
	/** Parent issue ids parsed from --derived-from (required when specSource === 'derived'). */
	derivedFrom?: string[];
	/**
	 * Explicit WSJF scores from stdin JSON. When absent on the --derived-from path,
	 * WSJF is inherited from the first parent that has a wsjf field (suggested default).
	 */
	wsjf?: WsjfScore;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/** Read scripts/cam/project.toml as raw text. */
	readProjectToml: () => string;
}

/** Successful outcome: issue was allocated, committed to main, and pushed. */
export interface CreateLocalIssueOnMainResult {
	ok: true;
	id: string;
	committedTo: 'main';
	sha: string;
	branchWasMain: boolean;
}

/** Guard or error outcome: no commit was made. */
export interface CreateLocalIssueOnMainError {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main' | 'guardrail-failed';
}

export type CreateLocalIssueOnMainOutcome =
	| CreateLocalIssueOnMainResult
	| CreateLocalIssueOnMainError;

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

type MainGuardResult =
	| CreateLocalIssueOnMainError
	| { ok: true; branchWasMain: boolean; localMainSha: string };

/**
 * Up-to-date guard. Runs before any mutation.
 *
 *   0a. Detached HEAD -> { ok: false, reason: 'detached-head' }.
 *   0b. Missing local main branch -> { ok: false, reason: 'missing-main' }.
 *   0c. Best-effort git fetch origin main; if origin/main exists and its sha
 *       differs from local main -> { ok: false, reason: 'diverged' }. When
 *       origin/main is absent (no remote), the check is skipped entirely.
 */
function checkMainUpToDate(cwd: string, spawnFn: SpawnFn): MainGuardResult {
	// Guard 0a: Determine current branch; detect detached HEAD.
	const branchResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
		{ encoding: 'utf8' },
	);
	const currentBranch = (branchResult.stdout ?? '').trim();
	const branchWasMain = currentBranch === 'main';

	if (currentBranch === 'HEAD') {
		printError('detached HEAD', 'cannot file issue from a detached HEAD state');
		return { ok: false, reason: 'detached-head' };
	}

	// Guard 0b: Verify local main exists; capture sha for the diverge check.
	const localMainResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'main'],
		{ encoding: 'utf8' },
	);
	if ((localMainResult.status ?? 1) !== 0) {
		printError('missing local main branch', 'run: git fetch origin main:main');
		return { ok: false, reason: 'missing-main' };
	}
	const localMainSha = (localMainResult.stdout ?? '').trim();

	// Guard 0c: Best-effort fetch + up-to-date check.
	spawnFn('git', ['-C', cwd, 'fetch', 'origin', 'main'], { encoding: 'utf8' });

	const originMainResult = spawnFn(
		'git',
		['-C', cwd, 'rev-parse', 'origin/main'],
		{ encoding: 'utf8' },
	);
	if ((originMainResult.status ?? 1) === 0) {
		const originSha = (originMainResult.stdout ?? '').trim();
		if (localMainSha !== originSha) {
			printError(
				'local main is diverged from origin/main',
				'run: git pull origin main',
			);
			return { ok: false, reason: 'diverged' };
		}
	}

	return { ok: true, branchWasMain, localMainSha };
}

/**
 * Best-effort push of main to origin.
 */
function pushMainBestEffort(cwd: string, spawnFn: SpawnFn): void {
	const pushResult = spawnFn(
		'git',
		['-C', cwd, 'push', 'origin', 'main'],
		{ encoding: 'utf8' },
	);
	if ((pushResult.status ?? 1) !== 0) {
		printError(
			'push rejected',
			`git push origin main: ${(pushResult.stderr ?? '').trim() || 'unknown error'}`,
		);
	}
}

/**
 * Adapt SpawnFn (which has optional env) to BacklogSpawnFn (no env param).
 * SpawnFn's options are a strict superset of BacklogSpawnFn's, so the adapter
 * is safe: callers pass { encoding, input? } and the underlying SpawnFn accepts
 * those fields unchanged.
 */
function toBacklogSpawn(spawnFn: SpawnFn): BacklogSpawnFn {
	return (cmd, args, o) => spawnFn(cmd, args, o);
}

/** Result of applyFastTrackGuardrails: resolved WSJF on success, reason on failure. */
type FastTrackGuardrailResult =
	| { ok: true; resolvedWsjf: WsjfScore }
	| { ok: false; reason: 'guardrail-failed' };

/**
 * Run all 4 hard pre-commit guardrails for a fast-track filing and resolve WSJF.
 *
 *   Guardrail 1: specSource-required -- caller guarantees specSource is present.
 *   Guardrail 2: derivedFrom-when-derived -- validateSpecSource invariant 2.
 *   Guardrail 3: description-non-empty-when-fast-track -- validateSpecSource invariant 3.
 *   Guardrail 4: WSJF-resolvable -- explicit wsjf wins; falls back to parent inheritance
 *                for --derived-from; refuses when unresolvable.
 *
 * Extracted from createLocalIssueOnMain to keep complexity below the biome limit.
 */
function applyFastTrackGuardrails(
	specSource: string,
	derivedFrom: string[] | undefined,
	description: string | undefined,
	wsjf: WsjfScore | undefined,
	cwd: string,
	spawnFn: SpawnFn,
): FastTrackGuardrailResult {
	// Guardrails 2 + 3: validateSpecSource mirrors specifyIssueOnMain validate-before-mutate order.
	const vResult = validateSpecSource({ specSource, derivedFrom, description });
	if (!vResult.ok) {
		for (const err of vResult.errors) {
			printError('fast-track guardrail', err);
		}
		return { ok: false, reason: 'guardrail-failed' };
	}

	// Guardrail 4: WSJF resolution.
	// Explicit wsjf from stdin JSON takes priority (SUGGESTED default is overridable per Gotcha #2).
	let resolvedWsjf = wsjf;
	if (resolvedWsjf === undefined && specSource === 'derived' && derivedFrom !== undefined && derivedFrom.length > 0) {
		// Inherit WSJF from the first parent that has a wsjf field.
		const backlog = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));
		for (const parentId of derivedFrom) {
			const parent = backlog.find((e) => e.id === parentId);
			if (parent?.wsjf !== undefined) {
				resolvedWsjf = parent.wsjf;
				break;
			}
		}
	}

	if (resolvedWsjf === undefined) {
		printError(
			'WSJF unresolvable',
			'provide explicit wsjf in stdin JSON, or use --derived-from naming a parent with wsjf',
		);
		return { ok: false, reason: 'guardrail-failed' };
	}

	return { ok: true, resolvedWsjf };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * File a new issue as scripts/cam/issues/CAM-NNNN.json on main.
 *
 * Guard steps (run before any mutation):
 *   0a. Detached HEAD -> return { ok: false, reason: 'detached-head' }.
 *   0b. Missing local main branch -> return { ok: false, reason: 'missing-main' }.
 *   0c. Best-effort git fetch origin main; if origin/main exists and sha differs
 *       from local main -> return { ok: false, reason: 'diverged' }.
 *       If origin/main is absent (no remote), the check is skipped entirely.
 *
 * Steps:
 *   1. Read issue_prefix from project.toml.
 *   2. Call writeIssueFile (US-003 CAS primitive) which:
 *      - allocates id via allocateId (max on main + 1)
 *      - writes scripts/cam/issues/CAM-NNNN.json directly to main via CAS update-ref
 *   3. Best-effort git push origin main.
 *   4. Return { ok: true, id, committedTo: 'main', sha, branchWasMain }.
 *
 * The old array backlog file is never read or written.
 */
export function createLocalIssueOnMain(
	options: CreateLocalIssueOnMainOptions,
): CreateLocalIssueOnMainOutcome {
	const { cwd, title, description, specSource, derivedFrom, wsjf, spawnFn, clock, readProjectToml } = options;

	// Guards 0a-0c: run before any mutation.
	const guard = checkMainUpToDate(cwd, spawnFn);
	if (!guard.ok) {
		return guard;
	}
	const { branchWasMain } = guard;

	// Fast-track guardrails -- only when specSource is provided (--fast-track /
	// --derived-from flag was used). Normal filing (no flags) bypasses all guards.
	let resolvedWsjf: WsjfScore | undefined;
	if (specSource !== undefined) {
		const guardrail = applyFastTrackGuardrails(specSource, derivedFrom, description, wsjf, cwd, spawnFn);
		if (!guardrail.ok) {
			return guardrail;
		}
		resolvedWsjf = guardrail.resolvedWsjf;
	}

	// 1. Read issue_prefix from project.toml.
	const tomlText = readProjectToml();
	const config = parseToml(tomlText);
	const prefix =
		typeof config['issue_prefix'] === 'string' ? config['issue_prefix'] : 'CAM';

	// 2. Allocate id and write the per-file JSON via the CAS primitive.
	const result = writeIssueFile({
		cwd,
		title,
		description,
		prefix,
		createdAt: clock(),
		spawnFn,
		...(specSource !== undefined ? { specSource } : {}),
		...(derivedFrom !== undefined && derivedFrom.length > 0 ? { derivedFrom } : {}),
		...(resolvedWsjf !== undefined ? { wsjf: resolvedWsjf } : {}),
	});

	// 3. Best-effort push. Rejection is logged explicitly, never swallowed.
	pushMainBestEffort(cwd, spawnFn);

	// 4. Return.
	return { ok: true, id: result.id, committedTo: 'main', sha: result.sha, branchWasMain };
}
