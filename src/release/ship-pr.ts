// src/release/ship-pr.ts
//
// runShipPrStep(opts) -- deterministic PR-create + merge-mode step (US-003,
// CAM-149). Replaces the last LLM-orchestrated part of templates/commands/
// cam-ship.md (Steps 7-9: gh pr create, auto-merge, reviewer-artifact PR
// comment, ci-gated merge-watch enrichment vs immediate-mode issue close)
// with a deterministic function whose only side effects are injected.
//
// Consumes the ready-for-pr state computed by runShipPhase (ship-runner.ts,
// US-002): the caller passes prdSnapshot (feeds composePrTitle/composePrBody,
// pr-body.ts, US-001, so no LLM authors the PR title/body) and branchName
// (the already-pushed branch to open the PR from).
//
// GITHUB_TOKEN handling: gh MUTATION calls (pr create, pr merge, pr comment,
// issue close) run with GITHUB_TOKEN stripped from the child env so gh falls
// back to its keyring OAuth token -- the .env GITHUB_TOKEN fine-grained PAT
// lacks "Pull requests: write" (mirrors sidecar.ts's
// makeProductionUpdateBranchFn / memory ship-pr-create-token-keyring-fallback).
// Read-only gh calls (gh pr view) keep the ambient env, including GITHUB_TOKEN.
//
// US-003 (CAM-149).

import process from 'node:process';
import type { MergeMode } from '../config/models.ts';
import type { CloseIssueOnMainOutcome } from '../commands/issue-specify.ts';
import { AUTOMERGE_NOTICE } from '../logging/notices.ts';
import { composePrBody, composePrTitle } from './pr-body.ts';
import type { PrdSnapshot } from './pr-body.ts';
import type { MergeWatchState } from './merge-watch.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types
// ---------------------------------------------------------------------------

/**
 * Injectable spawn for all gh subprocess calls.
 *
 * `env` is passed only for mutation calls (GITHUB_TOKEN stripped); read-only
 * calls omit it so the child inherits the ambient environment unchanged.
 */
export type ShipPrSpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; env?: Record<string, string> },
) => { status: number | null; stdout: string; stderr: string };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal input ship-runner.ts's injected runShipPrStepFn needs after a
 * successful push (US-002 ready-for-pr internals). Kept separate from
 * RunShipPrStepOptions so ship-runner.ts's test doubles never need the
 * full I/O dependency set below.
 */
export interface ShipPrStepInput {
	/** Branch the PR is opened from (already pushed by runShipPhase). */
	branchName: string;
	/** PRD snapshot captured before finalizeFn removed prd.json (US-002). */
	prdSnapshot: PrdSnapshot;
	/** Resolved issue id from finalizeCycleClose (e.g. "CAM-149"), or null. */
	issueId: string | null;
	/** Issue backend from finalizeCycleClose ("none" | "github" | "linear"). */
	issueBackend: string;
}

/** Outcome of runShipPrStep, consumed by ship-runner.ts's ShipPhaseResult. */
export type ShipPrStepOutcome =
	| { ok: true; prNumber: number; mergeMode: MergeMode }
	| { ok: false; detail: string };

/** Full options for runShipPrStep: ShipPrStepInput plus all injected I/O. */
export interface RunShipPrStepOptions extends ShipPrStepInput {
	/** Injectable spawn for gh subprocess calls. */
	spawnFn: ShipPrSpawnFn;
	/** Write text to a temp file; returns the absolute path (for --body-file args). */
	writeTempFile: (content: string) => string;
	/** Read scripts/cam/review-artifact.txt; null when absent/unreadable. */
	readReviewArtifact: () => string | null;
	/** Resolve the configured merge mode ([ship] merge_mode in project.toml). */
	readMergeModeFn: () => MergeMode;
	/** Read the durable merge-watch state file (US-002, merge-watch.ts). */
	readMergeWatchStateFn: () => MergeWatchState | null;
	/**
	 * Write the merge-watch state file. Called exactly once on the ci-gated
	 * path, before the sidecar starts consuming the file (gotcha: re-writing
	 * after this point causes a double post-merge).
	 */
	writeMergeWatchStateFn: (state: MergeWatchState) => void;
	/** Remove the merge-watch state file (immediate-mode "none"-backend cleanup). */
	removeMergeWatchStateFn: () => void;
	/** Close an issue on main (issue-specify.ts closeIssueOnMain), "none" backend only. */
	closeIssueOnMainFn: (id: string) => CloseIssueOnMainOutcome;
	/** Emit an operator-facing hint line (e.g. the auto-merge settings hint). */
	emitHint: (msg: string) => void;
	/** Emit an operator-facing warning line (best-effort failure narration). */
	emitWarning: (msg: string, hint?: string) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a child-process env with GITHUB_TOKEN stripped, so `gh` falls back to
 * its keyring OAuth token instead of the ambient .env fine-grained PAT (which
 * lacks "Pull requests: write").
 */
function stripGithubToken(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== 'GITHUB_TOKEN') env[key] = value;
	}
	return env;
}

/** Extract the trailing numeric github issue number from an issueId like "CAM-149". */
function parseGithubIssueNumber(issueId: string | null): number | null {
	if (issueId === null) return null;
	const match = /-(\d+)$/.exec(issueId);
	const raw = match?.[1];
	if (raw === undefined) return null;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : null;
}

/**
 * Read-modify-write the merge-watch state file for the ci-gated path:
 * preserves the issueId stashed by finalizeCycleClose (only ever present for
 * the "none" backend), adds prNumber + mergedBranch, and writes exactly once.
 * Never a blind overwrite: readMergeWatchStateFn runs first.
 */
function enrichMergeWatchState(opts: RunShipPrStepOptions, prNumber: number): void {
	const existing = opts.readMergeWatchStateFn();
	const preservedIssueId =
		existing?.issueId ?? (opts.issueBackend === 'none' && opts.issueId !== null ? opts.issueId : undefined);
	const state: MergeWatchState = {
		...(existing ?? {}),
		prNumber,
		mergedBranch: opts.branchName,
		...(preservedIssueId !== undefined ? { issueId: preservedIssueId } : {}),
	};
	opts.writeMergeWatchStateFn(state);
}

/** Close the target issue on main via closeIssueOnMainFn, then remove the watch file. */
function closeNoneBackendIssue(opts: RunShipPrStepOptions): void {
	if (opts.issueId !== null) {
		const closeResult = opts.closeIssueOnMainFn(opts.issueId);
		if (!closeResult.ok) {
			opts.emitWarning(
				`close issue ${opts.issueId} failed (${closeResult.reason})`,
				'issue was not marked shipped; please close manually',
			);
		}
	}
	opts.removeMergeWatchStateFn();
}

/** Close the target issue via `gh issue close`, best-effort. */
function closeGithubIssue(opts: RunShipPrStepOptions, prNumber: number): void {
	const issueNumber = parseGithubIssueNumber(opts.issueId);
	if (issueNumber === null) return;
	const closeResult = opts.spawnFn(
		'gh',
		[
			'issue', 'close', String(issueNumber),
			'--reason', 'completed',
			'--comment', `Shipped via PR #${prNumber}`,
		],
		{ encoding: 'utf8', env: stripGithubToken() },
	);
	if ((closeResult.status ?? 1) !== 0) {
		opts.emitWarning(`gh issue close ${issueNumber} failed`, 'please close the issue manually');
	}
}

/** Immediate-mode issue close, branching on issueBackend. */
function closeIssuePerBackend(opts: RunShipPrStepOptions, prNumber: number): void {
	if (opts.issueBackend === 'none') {
		closeNoneBackendIssue(opts);
		return;
	}
	if (opts.issueBackend === 'github') {
		closeGithubIssue(opts, prNumber);
		return;
	}
	if (opts.issueBackend === 'linear') {
		opts.emitHint(
			`linear backend: close ${opts.issueId ?? 'the target issue'} manually in the Linear UI (shipped via PR #${prNumber})`,
		);
	}
}

/** Post the reviewer artifact-of-record as a PR comment, best-effort. */
function postReviewArtifactComment(opts: RunShipPrStepOptions, prNumber: number): void {
	const artifact = opts.readReviewArtifact();
	if (artifact === null) return;
	const commentBody = `**artifact-of-record**\n\n${artifact}`;
	const commentFilePath = opts.writeTempFile(commentBody);
	opts.spawnFn(
		'gh',
		['pr', 'comment', String(prNumber), '--body-file', commentFilePath],
		{ encoding: 'utf8', env: stripGithubToken() },
	);
}

// ---------------------------------------------------------------------------
// runShipPrStep
// ---------------------------------------------------------------------------

/**
 * Execute the deterministic PR-create + merge-mode step.
 *
 * Steps (in order):
 *   1. Compose the title/body from prdSnapshot (US-001, no LLM authoring)
 *      and write the body to a temp file.
 *   2. `gh pr create --title <title> --body-file <tmpfile> --base main`
 *      (mutation: GITHUB_TOKEN stripped). Failure aborts with pr-create-failed.
 *   3. Resolve the PR number via `gh pr view --json number --jq .number`
 *      (read-only: ambient env). A non-numeric result aborts.
 *   4. `gh pr merge --auto --squash` (mutation: GITHUB_TOKEN stripped),
 *      best-effort: a failure emits the auto-merge settings hint and does
 *      NOT abort (the PR is already created).
 *   5. Post the reviewer artifact-of-record (scripts/cam/review-artifact.txt)
 *      as a PR comment when present, best-effort.
 *   6. Merge-mode branching (readMergeModeFn): ci-gated enriches the
 *      merge-watch state file; immediate closes the issue per backend.
 */
export function runShipPrStep(opts: RunShipPrStepOptions): ShipPrStepOutcome {
	const { prdSnapshot, spawnFn } = opts;

	// 1. Compose title/body; write body to a temp file.
	const title = composePrTitle(prdSnapshot);
	const body = composePrBody(prdSnapshot);
	const bodyFilePath = opts.writeTempFile(body);

	// 2. Create the PR. Mutation: strip GITHUB_TOKEN.
	const createResult = spawnFn(
		'gh',
		['pr', 'create', '--title', title, '--body-file', bodyFilePath, '--base', 'main'],
		{ encoding: 'utf8', env: stripGithubToken() },
	);
	if ((createResult.status ?? 1) !== 0) {
		const detail = (createResult.stderr || createResult.stdout || '').trim() || '(no output)';
		return { ok: false, detail: `gh pr create failed (exit ${createResult.status ?? 'null'}): ${detail}` };
	}

	// 3. Resolve the PR number. Read-only: keeps the ambient env.
	const viewResult = spawnFn('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'], { encoding: 'utf8' });
	const prNumber = Number.parseInt((viewResult.stdout ?? '').trim(), 10);
	if (!Number.isFinite(prNumber)) {
		return { ok: false, detail: 'gh pr view --json number returned a non-numeric value after pr create succeeded' };
	}

	// 4. Enable auto-merge, best-effort. Mutation: strip GITHUB_TOKEN.
	const mergeResult = spawnFn('gh', ['pr', 'merge', '--auto', '--squash'], { encoding: 'utf8', env: stripGithubToken() });
	if ((mergeResult.status ?? 1) !== 0) {
		opts.emitHint(AUTOMERGE_NOTICE);
	}

	// 5. Post the reviewer artifact-of-record, best-effort.
	postReviewArtifactComment(opts, prNumber);

	// 6. Merge-mode branching.
	const mergeMode = opts.readMergeModeFn();
	if (mergeMode === 'ci-gated') {
		enrichMergeWatchState(opts, prNumber);
	} else {
		closeIssuePerBackend(opts, prNumber);
	}

	return { ok: true, prNumber, mergeMode };
}
