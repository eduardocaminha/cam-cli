// src/supervisor/plan-approval-gate.ts
//
// Plan-approval gate (US-001, CAM-241/153/312).
//
// Turns the plan_approval=operator dead-end into a full-audited-PRD
// approve/reject gate. When the plan phase finishes auditing a PRD and
// plan_approval is set to "operator", the sidecar must pause on the FULL
// audited PRD (not a pre-PRD sketch) via the generic write+notify /
// poll+resolve+clear+flip primitive (supervisor/gate.ts) and resume
// deterministically once the operator calls `cam decide approve|reject`.
//
// Mirrors src/supervisor/in-progress-conflict.ts verbatim in shape: gate
// identity constants, a pure context builder, and a makeXResolver(deps)
// factory returning a GateResolutionHandler. Does NOT modify gate.ts itself
// (the shipped CAM-153 generic primitive).

import type { PrdSnapshot } from './decide.ts';
import type { CamGate, GateResolutionHandler } from './gate.ts';
import type { LoopPhase } from '../commands/status.ts';

// ---------------------------------------------------------------------------
// Gate identity (AC1, AC2)
// ---------------------------------------------------------------------------

/** Gate discriminator for the plan-approval pause (AC1). */
export const PLAN_APPROVAL_GATE = 'plan-approval';

/** The exact, ordered set of valid resolutions (AC1, AC2). */
export const PLAN_APPROVAL_OPTIONS = ['approve', 'reject'] as const;

export type PlanApprovalDecision = (typeof PLAN_APPROVAL_OPTIONS)[number];

// ---------------------------------------------------------------------------
// Context builder (AC3)
// ---------------------------------------------------------------------------

/**
 * PrdSnapshot plus the loosely-typed top-level identifying fields real
 * prd.json files carry (`title` on hand-authored PRDs, `description` on the
 * planner-generated ones) that PrdSnapshot itself does not declare. Both are
 * optional and either/neither may be present; the context builder falls back
 * gracefully.
 */
export type PlanApprovalPrd = PrdSnapshot & {
	title?: string;
	description?: string;
};

/**
 * Build the free-text summary surfaced to the operator (AC3): the PRD title,
 * the story count, and the per-story acceptance-criteria counts, so the
 * operator reviews the FULL audited PRD rather than a pre-PRD sketch.
 *
 * Never throws: a null/undefined/empty `prd` yields a safe fallback line
 * instead of touching properties that might not exist.
 */
export function buildPlanApprovalContext(prd: PlanApprovalPrd | null | undefined): string {
	if (prd === null || prd === undefined) {
		return 'No PRD found to summarize (prd.json is absent or empty).';
	}

	const title = prd.title ?? prd.description ?? '(untitled PRD)';
	const stories = prd.userStories ?? [];

	if (stories.length === 0) {
		return `PRD "${title}" has 0 user stories.`;
	}

	const storyLines = stories.map((story, index) => {
		const id = story.id ?? `story-${index + 1}`;
		const acCount = story.acceptanceCriteria?.length ?? 0;
		return `  - ${id}: ${acCount} acceptance criteria`;
	});

	return [`PRD: ${title}`, `Story count: ${stories.length}`, ...storyLines].join('\n');
}

// ---------------------------------------------------------------------------
// Resolution (AC4, AC5)
// ---------------------------------------------------------------------------

/**
 * Deps for resolving the gate's two decisions into an outbound LoopPhase
 * (AC4). Each is best-effort (never throws): a partial failure must never
 * leave the gate resolution handler itself throwing, since pollAndResolveGate
 * (gate.ts) calls the handler with no surrounding try/catch of its own.
 */
export interface PlanApprovalResolverDeps {
	/** Proceed with the pending plan-approved branch/work. Called ONLY on 'approve'. Never throws. */
	proceedBranchFn: () => void;
	/** rm scripts/cam/prd.json (discard the working-tree PRD). Called ONLY on 'reject'. Never throws. */
	removePrdFn: () => void;
	/** Push a one-line notify to the orchestrator pane. Called ONLY on 'reject'. Never throws. */
	notifyFn: (line: string) => void;
}

/**
 * Build the GateResolutionHandler for the 'plan-approval' gate (AC4):
 *   approve -> deps.proceedBranchFn(), returns 'implementing'.
 *   reject  -> deps.removePrdFn() then deps.notifyFn(...), returns 'idle'
 *              (the working-tree prd.json is discarded here: at pause time
 *              no branch/commit has happened yet, the PRD still lives on
 *              main).
 *
 * pollAndResolveGate has already re-validated `gate.decision` against
 * `gate.options` before calling this handler (gate.ts's own contract), so the
 * `default` arm below is unreachable in production; it exists only to
 * satisfy LoopPhase's return type exhaustively, failing safe to 'idle'
 * rather than throwing (AC5, mirrors makeInProgressConflictResolver).
 */
export function makePlanApprovalResolver(deps: PlanApprovalResolverDeps): GateResolutionHandler {
	return (gate: CamGate): LoopPhase => {
		const decision = gate.decision as PlanApprovalDecision | undefined;
		switch (decision) {
			case 'approve':
				deps.proceedBranchFn();
				return 'implementing';
			case 'reject':
				deps.removePrdFn();
				deps.notifyFn('[cam] plan rejected by operator; PRD discarded.');
				return 'idle';
			default:
				return 'idle';
		}
	};
}
