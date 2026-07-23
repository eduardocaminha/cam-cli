// src/commands/status-diagnostics.ts
//
// Closed, ordered, deterministic "why is the cycle not moving" diagnostic
// (US-003, CAM-401).
//
// Pure function, zero LLM, zero I/O: maps each detectable cycle-blocking
// condition -- drawn from the US-002 projected `StatusReport` model
// (src/commands/status.ts) plus the orch-pane-busy / push-undelivered
// signals from US-001 (src/tmux/dispatch.ts, src/supervisor/events.ts) -- to
// exactly one fixed operator-facing message and one fixed suggested next
// command. The rule-set is CLOSED (WHY_NOT_MOVING_CONDITIONS enumerates every
// detectable condition; WHY_NOT_MOVING_TEXT gives each one exactly one fixed
// message/command pair) and ORDERED (detectCondition evaluates conditions in
// the fixed precedence order below, first match wins). When nothing matches,
// the single fixed 'none' result is returned -- never an empty or ambiguous
// value.
//
// Precedence (highest first): operator-paused > ship-stalled > plan-escalated
// > plan-preflight-failed > implement-blocked > post-merge-stalled >
// sidecar-stalled > gate-awaiting-decision > merge-watch-waiting >
// orch-pane-busy (transient send-anyway wedge) > delivery-exhausted (genuine
// push-undelivered retries-exhausted) > none.
//
// orch-pane-busy vs delivery-exhausted (AC3): these are deliberately kept
// distinct and in this precedence order rather than correlated by recency.
// `orch-pane-busy` is emitted alongside `push-undelivered` (reason
// 'pane-not-idle') when the sidecar found the orchestrator pane not idle and
// sent anyway -- a transient, self-resolving condition. `push-undelivered`
// (reason 'retries-exhausted') is emitted alone when the idle-verified retry
// loop never confirmed delivery -- a genuine delivery failure. Conflating the
// two would mask a real problem behind a benign one.

import type { StatusReport } from './status.ts';

/** Closed enum of every detectable why-not-moving condition. */
export type WhyNotMovingConditionId =
	| 'operator-paused'
	| 'ship-stalled'
	| 'plan-escalated'
	| 'plan-preflight-failed'
	| 'implement-blocked'
	| 'post-merge-stalled'
	| 'sidecar-stalled'
	| 'gate-awaiting-decision'
	| 'merge-watch-waiting'
	| 'orch-pane-busy'
	| 'delivery-exhausted'
	| 'none';

/**
 * The enumerated conditions in fixed precedence order (highest first). This
 * IS the closed rule-set: `detectCondition` evaluates exactly these, in
 * exactly this order, and nothing else.
 */
export const WHY_NOT_MOVING_CONDITIONS: readonly WhyNotMovingConditionId[] = [
	'operator-paused',
	'ship-stalled',
	'plan-escalated',
	'plan-preflight-failed',
	'implement-blocked',
	'post-merge-stalled',
	'sidecar-stalled',
	'gate-awaiting-decision',
	'merge-watch-waiting',
	'orch-pane-busy',
	'delivery-exhausted',
	'none',
];

/** One diagnostic result: the detected condition plus its fixed message + suggested next command. */
export interface WhyNotMovingDiagnostic {
	condition: WhyNotMovingConditionId;
	message: string;
	suggestedCommand: string;
}

/**
 * Signals from US-001 (CAM-401) that live only in the event log
 * (`.claude/cam-worker-events.jsonl`), not in a durable marker file, so they
 * are not part of the US-002 `StatusReport` projection. The caller
 * (`buildStatusReport`) derives these booleans/strings from the event log;
 * this module only consumes the already-derived signals, keeping the
 * diagnostic itself free of I/O.
 */
export interface WhyNotMovingSignals {
	/** True when an `orch-pane-busy` event is present in the event log. */
	orchPaneBusy: boolean;
	/** The `reason` field of the LAST `push-undelivered` event, when present. */
	pushUndeliveredReason?: 'retries-exhausted' | 'pane-not-idle';
}

/** Subset of `StatusReport` the diagnostic reads. Never the full report -- keeps the function's input surface explicit and minimal. */
export type WhyNotMovingReportInput = Pick<
	StatusReport,
	| 'state'
	| 'shipStalled'
	| 'planEscalated'
	| 'planPreflightFailed'
	| 'implementBlocked'
	| 'postMergeStalled'
	| 'sidecarStalled'
	| 'gate'
	| 'mergeWatch'
>;

/** Fixed message + suggested command for every enumerated condition. Exactly one entry per `WhyNotMovingConditionId`. */
const WHY_NOT_MOVING_TEXT: Record<WhyNotMovingConditionId, { message: string; suggestedCommand: string }> = {
	'operator-paused': {
		message: 'Loop is intentionally paused by the operator (.cam-pause marker present).',
		suggestedCommand: 'cam resume',
	},
	'ship-stalled': {
		message: 'Ship phase is stalled: the auto-merge/ship sequence did not complete and needs manual recovery.',
		suggestedCommand: 'cam ship --finalize',
	},
	'plan-escalated': {
		message: 'Plan phase escalated: a BLOCK verdict persisted after exhausting the re-plan rounds.',
		suggestedCommand: 'cam next',
	},
	'plan-preflight-failed': {
		message:
			'Plan preflight failed: a deterministic environment check (clean tree, typecheck, or tests) failed before the planner could spawn.',
		suggestedCommand: 'git status',
	},
	'implement-blocked': {
		message: 'Implement loop is blocked: the last worker terminal was BLOCKED and needs operator attention before it re-arms.',
		suggestedCommand: 'cam next',
	},
	'post-merge-stalled': {
		message: 'Post-merge sequence stalled: the pull request merged but tag/prune/close did not finish.',
		suggestedCommand: 'git fetch origin',
	},
	'sidecar-stalled': {
		message: 'Sidecar failed to bring up the worker container or session before it could dispatch.',
		suggestedCommand: 'cam next',
	},
	'gate-awaiting-decision': {
		message: 'An operator-decision gate is open: the sidecar is waiting on a decision before it can continue.',
		suggestedCommand: 'cam decide',
	},
	'merge-watch-waiting': {
		message: 'Merge-watch is polling an open pull request: the loop is waiting on CI/merge, not stuck.',
		suggestedCommand: 'gh pr status',
	},
	'orch-pane-busy': {
		message:
			'Orchestrator pane was busy when the sidecar last pushed a wake-up nudge (transient, self-resolving send-anyway).',
		suggestedCommand: 'cam status',
	},
	'delivery-exhausted': {
		message:
			'A wake-up push to the orchestrator pane failed delivery after exhausting retries: a genuine delivery failure, not a busy-pane wedge.',
		suggestedCommand: 'cam resume',
	},
	none: {
		message: 'Nothing blocking: the cycle is progressing normally.',
		suggestedCommand: 'cam status',
	},
};

/**
 * Evaluate the closed rule-set in fixed precedence order; the first matching
 * condition wins. Pure: no I/O, no LLM call.
 */
function detectCondition(report: WhyNotMovingReportInput, signals: WhyNotMovingSignals): WhyNotMovingConditionId {
	if (report.state === 'operator-paused') return 'operator-paused';
	if (report.shipStalled) return 'ship-stalled';
	if (report.planEscalated) return 'plan-escalated';
	if (report.planPreflightFailed) return 'plan-preflight-failed';
	if (report.implementBlocked) return 'implement-blocked';
	if (report.postMergeStalled) return 'post-merge-stalled';
	if (report.sidecarStalled) return 'sidecar-stalled';
	if (report.gate) return 'gate-awaiting-decision';
	if (report.mergeWatch) return 'merge-watch-waiting';
	if (signals.orchPaneBusy) return 'orch-pane-busy';
	if (signals.pushUndeliveredReason === 'retries-exhausted') return 'delivery-exhausted';
	return 'none';
}

/**
 * Derive the why-not-moving diagnostic from the projected `StatusReport`
 * model (US-002) plus the orch-pane-busy / push-undelivered signals (US-001).
 * Pure function: no I/O, no LLM call. Total over the closed rule-set --
 * always returns exactly one result, never an empty or ambiguous value.
 */
export function diagnoseWhyNotMoving(
	report: WhyNotMovingReportInput,
	signals: WhyNotMovingSignals,
): WhyNotMovingDiagnostic {
	const condition = detectCondition(report, signals);
	const text = WHY_NOT_MOVING_TEXT[condition];
	return { condition, message: text.message, suggestedCommand: text.suggestedCommand };
}
