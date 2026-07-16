// src/supervisor/in-progress-conflict.ts
//
// In-progress-work conflict gate (US-004, CAM-241/153).
//
// Detects whether a fresh plan request would clobber in-progress work: an
// existing prd.json carrying a passes:false non-operator story, or HEAD
// already on a cam/* feature branch. When detected, the sidecar pauses on an
// operator-decision gate (options: continue | ship | abandon) via the US-003
// generic write+notify / poll+resolve+clear+flip primitive (supervisor/gate.ts)
// instead of silently proceeding into runPlanPhase's selectIssueFn/spawn
// sequence, which would otherwise clear the in-flight prd.json out from
// under an unfinished PRD (clearStalePlanArtifactsFn) or create a second
// branch on top of the live one.
//
// Mirrors decideNextAction's non-operator-incomplete partition (decide.ts):
// the same `passes !== true && requires !== 'operator'` predicate, applied
// here to the PRD BEFORE any plan-phase side effect runs.

import type { SpawnFn } from './loop.ts';
import type { PrdSnapshot } from './decide.ts';
import type { CamGate, GateResolutionHandler } from './gate.ts';
import type { LoopPhase } from '../commands/status.ts';

// ---------------------------------------------------------------------------
// Gate identity (AC2)
// ---------------------------------------------------------------------------

/** Gate discriminator for the in-progress-work conflict (AC1, AC2). */
export const IN_PROGRESS_CONFLICT_GATE = 'in-progress-conflict';

/** The exact, ordered set of valid resolutions (AC2). */
export const IN_PROGRESS_CONFLICT_OPTIONS = ['continue', 'ship', 'abandon'] as const;

export type InProgressConflictDecision = (typeof IN_PROGRESS_CONFLICT_OPTIONS)[number];

// ---------------------------------------------------------------------------
// Detection (AC1, AC4)
// ---------------------------------------------------------------------------

/**
 * True when `prd` carries at least one non-operator story with passes !== true.
 * Mirrors decideNextAction's implementableIncomplete partition (decide.ts).
 * `prd` is null when prd.json is absent/unreadable (no conflict from this half).
 */
export function hasIncompletePrd(prd: PrdSnapshot | null): boolean {
	if (prd === null) return false;
	const stories = prd.userStories ?? [];
	return stories.some((s) => s.passes !== true && s.requires !== 'operator');
}

/** True when `headBranch` names a cam/* feature branch. Null/undefined -> false. */
export function isCamFeatureBranch(headBranch: string | null | undefined): boolean {
	return typeof headBranch === 'string' && headBranch.startsWith('cam/');
}

/**
 * Pure detection predicate (AC1): true when EITHER half fires.
 *   (a) prd carries a passes:false non-operator story, OR
 *   (b) headBranch names a cam/* feature branch.
 */
export function detectInProgressConflict(
	prd: PrdSnapshot | null,
	headBranch: string | null | undefined,
): boolean {
	return hasIncompletePrd(prd) || isCamFeatureBranch(headBranch);
}

/**
 * Build the free-text gate context surfaced to the operator (AC2), naming
 * WHICH half fired (one or both) so the operator's decision is informed.
 * Callers should only call this after detectInProgressConflict(...) === true;
 * it renders a generic fallback line if called with neither half true.
 */
export function buildInProgressConflictContext(
	prd: PrdSnapshot | null,
	headBranch: string | null | undefined,
): string {
	const reasons: string[] = [];
	if (hasIncompletePrd(prd)) {
		reasons.push('an existing prd.json carries a passes:false non-operator story');
	}
	if (isCamFeatureBranch(headBranch)) {
		reasons.push(`HEAD is on feature branch "${String(headBranch)}"`);
	}
	const reasonText = reasons.length > 0 ? reasons.join('; ') : 'in-progress work detected';
	return `In-progress work detected (${reasonText}). Starting a new plan would clobber it.`;
}

/**
 * Read the current HEAD branch name via `git symbolic-ref --short HEAD`
 * (notes: "Branch check: git HEAD symbolic-ref matches cam/*"). Returns null
 * on a non-zero exit (e.g. detached HEAD) or empty output -- both mean "not
 * on a named branch", which is never a cam/* conflict.
 */
export function readHeadBranchName(spawnFn: SpawnFn, cwd: string): string | null {
	const result = spawnFn('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD']);
	if ((result.exitCode ?? 1) !== 0) return null;
	const branch = result.stdout.trim();
	return branch.length > 0 ? branch : null;
}

// ---------------------------------------------------------------------------
// Resolution (AC3)
// ---------------------------------------------------------------------------

/**
 * Deps for resolving the gate's three decisions into an outbound LoopPhase
 * (AC3). Each is best-effort (never throws): a partial failure must never
 * leave the gate resolution handler itself throwing, since pollAndResolveGate
 * (gate.ts) calls the handler with no surrounding try/catch of its own --
 * only the loop's outer per-tick try/catch (which would otherwise leave the
 * gate file AND the awaiting-operator phase stuck).
 */
export interface InProgressConflictResolverDeps {
	/** rm scripts/cam/handoff.json. Called ONLY on 'abandon'. Never throws. */
	removeHandoffFn: () => void;
	/** rm scripts/cam/prd.json. Called ONLY on 'abandon'. Never throws. */
	removePrdFn: () => void;
	/** Discard the in-progress feature-branch state: `git checkout main`. Called ONLY on 'abandon'. Never throws. */
	checkoutMainFn: () => void;
}

/**
 * Build the GateResolutionHandler for the 'in-progress-conflict' gate (AC3):
 *   continue -> 'implementing' (resume the existing PRD as-is).
 *   ship     -> 'shipping' (the pending plan request is dropped).
 *   abandon  -> rm handoff.json + rm prd.json + git checkout main, then
 *               'planning' (proceed with the requested plan fresh).
 *
 * pollAndResolveGate has already re-validated `gate.decision` against
 * `gate.options` before calling this handler (gate.ts's own contract), so the
 * `default` arm below is unreachable in production; it exists only to
 * satisfy LoopPhase's return type exhaustively, failing safe to 'idle'
 * rather than throwing.
 */
export function makeInProgressConflictResolver(
	deps: InProgressConflictResolverDeps,
): GateResolutionHandler {
	return (gate: CamGate): LoopPhase => {
		const decision = gate.decision as InProgressConflictDecision | undefined;
		switch (decision) {
			case 'continue':
				return 'implementing';
			case 'ship':
				return 'shipping';
			case 'abandon':
				deps.removeHandoffFn();
				deps.removePrdFn();
				deps.checkoutMainFn();
				return 'planning';
			default:
				return 'idle';
		}
	};
}
