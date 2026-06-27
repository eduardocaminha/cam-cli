// src/plan/plan-approval-decision.ts
//
// Post-audit branch decision: determines whether to pause for an operator
// confirmation or to proceed directly to branch creation after the auditor
// returns APPROVE.
//
// Mirrors the style of decideNextAction in src/supervisor/decide.ts:
// pure function, no I/O, no side effects.

import type { PlanApproval } from '../config/models.ts';

/** The action to take after the auditor returns APPROVE. */
export type PostAuditAction =
	/** Pause and ask the operator for a single plan confirmation
	 *  before running `git checkout -b`. */
	| { kind: 'pause-operator' }
	/** Proceed directly to `git checkout -b` with no operator gate. */
	| { kind: 'proceed-branch' };

/**
 * Decide what to do after the auditor returns APPROVE, based on the
 * `plan_approval` config value read by `readPlanApproval`.
 *
 * Pure function: no I/O, no side effects.
 *
 * - `"operator"` -> `{ kind: "pause-operator" }`: one human confirmation
 *   gate before branching.
 * - `"auto"` -> `{ kind: "proceed-branch" }`: branch immediately, no gate.
 *
 * @param approval - The plan approval mode from the project config.
 */
export function decidePostAuditAction(approval: PlanApproval): PostAuditAction {
	if (approval === 'operator') {
		return { kind: 'pause-operator' };
	}
	return { kind: 'proceed-branch' };
}
