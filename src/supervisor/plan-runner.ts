// src/supervisor/plan-runner.ts
//
// Deterministic plan-runner driver (US-005, CAM-117).
//
// Provides runPlanPhase(opts): a pure, dep-injected function that executes
// the full plan phase in sequence:
//   1. Pre-flight checks (delegate to injected preflightFn).
//   2. Pick the highest-priority plannable issue (delegate to selectIssueFn).
//   3. Assert the pane-count mutex (no spawn when session is busy).
//   4. Spawn the planner pane (respawn-pane -k, buildPlannerWorkerArgv).
//   5. Poll until the planner pane dies.
//   6. Spawn the auditor pane (respawn-pane -k, buildAuditorWorkerArgv).
//   7. Poll until plan-verdict-report.json is present (readPlanVerdictFn).
//   8. Return a discriminated result.
//
// Design decisions:
//   - All side effects (tmux spawns, FS reads, sleep, clock) are injected.
//   - paneCountMutexFn is injected so tests avoid the session.ts SpawnFn
//     type mismatch (SpawnSyncReturns vs the loop.ts SpawnFn shape).
//     Production callers wire it as `() => paneCountMutex(sessionName, tmuxSpawnFn)`.
//   - genUuid() output is .toLowerCase() (CAM-23: macOS uuidgen is uppercase).
//   - @cam_label is set BEFORE each respawn-pane (patterns.md '@cam_label pane-labeling').
//   - The auditor verdict is read ONLY from the report file (never from capture-pane,
//     patterns.md 'capture-pane is rendered markdown').
//   - emitSpawnResolution is called before each respawn (patterns.md 'Spawn-resolution emitter').
//   - This module does NOT wire the post-audit commit/branch/flip (US-006)
//     and does NOT implement a BLOCK->re-plan loop (CAM-151 Half B).
//   - Cognitive complexity is managed via factory/helper extraction (patterns.md
//     'Biome cognitive complexity: use factory/helper extraction not grandfather').

import { join } from 'node:path';
import type { SpawnFn, IsPaneAlive } from './loop.ts';
import type { WorkerEventLogger } from './events.ts';
import type { PlanPreflightResult } from './plan-preflight.ts';
import type { PlanVerdictReport, PlanVerdictFinding } from './plan-verdict-report.ts';
import type { IssueEntry } from '../issues/types.ts';
import type { SpawnResolutionEvent } from '../logging/spawn-resolution.ts';
import type { PlanApproval, WorkerIsolation } from '../config/models.ts';
import type { LoopPhase, PrdShape } from '../commands/status.ts';
import type { PreflightResult } from './preflight-container.ts';
import { truncatePreflightDetail, type PlanPreflightFailedWriterParams } from './plan-preflight-marker.ts';
import { buildPlannerWorkerArgv, buildAuditorWorkerArgv } from './plan-argv.ts';
import { readPhaseModel, readBackend } from '../config/models.ts';
import { emitSpawnResolution } from '../logging/spawn-resolution.ts';
import { decidePostAuditAction } from '../plan/plan-approval-decision.ts';
import { dockerExecWrap } from './docker-exec.ts';
import type { PlanEscalatedMarker } from './plan-escalation.ts';
import { lintPrd, type PrdOracleLintFinding } from './prd-oracle-lint.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default planner task prompt (can be overridden via opts.plannerTaskPrompt). */
export const DEFAULT_PLANNER_TASK_PROMPT =
	'Plan the next issue from the backlog per your AGENT.md. Write the resulting PRD to scripts/cam/prd.json.';

/**
 * Build a target-aware planner task prompt for a specific issue id.
 *
 * The generated prompt names the exact issue id and instructs the planner
 * not to re-select from the backlog, so the spawned planner plans THAT
 * exact issue rather than independently picking top-of-queue (the root cause
 * of CAM-157).
 *
 * Pure helper exported for unit testing (AC1, AC2 of US-001 CAM-157).
 */
export function buildPlannerTaskPrompt(issueId: string): string {
	return (
		`Plan issue ${issueId} specifically per your AGENT.md. ` +
		`Do not re-select from the backlog; plan ONLY ${issueId}. ` +
		`Write the resulting PRD to scripts/cam/prd.json.`
	);
}

/**
 * Derive the deterministic feature-branch name from prd.issueNumber
 * (US-001, CAM-236, ADR-0016).
 *
 * Returns `cam/issue-<issueNumber>` (no slug) when issueNumber is a
 * `typeof number`; returns null for null, undefined, or any non-number
 * value (strings, objects, NaN excluded implicitly since NaN is still
 * `typeof number` but never appears in a valid prd.json). No ad-hoc
 * fallback: a missing/invalid issueNumber bars the plan (see the
 * missing-issueNumber gate in runPostAuditAction), it never falls back to
 * a planner-authored slug.
 */
export function deriveBranchName(issueNumber: unknown): string | null {
	if (typeof issueNumber !== 'number') return null;
	return `cam/issue-${issueNumber}`;
}

/**
 * Round cap for the BLOCK->re-plan loop (CAM-204, ADR-0012). After
 * MAX_REPLAN_ROUNDS re-plan attempts, a still-blocked plan terminates as
 * escalated: there is no plan analog of the review loop's MAX_ROUNDS_DEBT
 * (non-convergence is a hard stop, never proceed-with-debt).
 */
export const MAX_REPLAN_ROUNDS = 2;

/**
 * Build a re-plan planner task prompt that embeds the prior round's auditor
 * findings verbatim, so a round-2 (or later) planner corrects the flagged
 * defects instead of regenerating the PRD blind (US-001, CAM-204).
 *
 * Mirrors buildPlannerTaskPrompt (CAM-157): names the exact issue id and
 * forbids backlog re-selection, and instructs writing the PRD to
 * scripts/cam/prd.json. The planner does NOT read patterns.md or
 * plan-verdict-report.json on its own (the spawn prompt string is the ONLY
 * channel to inform it), so each finding's description AND suggestion (when
 * present) must be embedded here verbatim. Findings with no suggestion
 * render description-only (no literal 'undefined' text).
 */
export function buildReplanPlannerTaskPrompt(issueId: string, findings: PlanVerdictFinding[]): string {
	const findingLines = findings
		.map((finding, index) => {
			const suggestionText =
				finding.suggestion !== undefined ? ` Suggestion: ${finding.suggestion}` : '';
			return `${index + 1}. ${finding.description}${suggestionText}`;
		})
		.join('\n');

	return (
		`Re-plan issue ${issueId} specifically per your AGENT.md. ` +
		`Do not re-select from the backlog; plan ONLY ${issueId}. ` +
		`The previous plan round was BLOCKED by the auditor with the following findings; ` +
		`correct each one in the new PRD:\n${findingLines}\n` +
		`Write the resulting PRD to scripts/cam/prd.json.`
	);
}

/**
 * Parse the numeric suffix from an issue id like "CAM-156" -> 156. Mirrors
 * numericSuffix in src/commands/plan.ts (kept local: a one-line parse does
 * not warrant a cross-module import). Returns NaN when the id carries no
 * numeric suffix.
 */
function issueIdNumericSuffix(issueId: string): number {
	const part = issueId.split('-').at(-1);
	if (part === undefined) return NaN;
	const n = Number(part);
	return Number.isFinite(n) ? n : NaN;
}

/**
 * Derive the auditor-facing branch name from the resolved issue's id suffix
 * (US-001, CAM-273, AC2), reusing deriveBranchName so the SAME cam/issue-<N>
 * rule (ADR-0016) governs here as it does on the post-audit git-branch path.
 * Never a planner-authored slug. Returns null when issue.id carries no
 * numeric suffix.
 */
export function deriveBranchNameFromIssueId(issueId: string): string | null {
	const suffix = issueIdNumericSuffix(issueId);
	return deriveBranchName(Number.isFinite(suffix) ? suffix : null);
}

/**
 * Build a record-bearing auditor task prompt that embeds the already-resolved
 * issue record (id, title, description, spec.acceptanceCriteria) plus the
 * code-derived branchName verbatim, so the auditor never has to re-resolve
 * which issue/branch the PRD targets against any backend (US-001, CAM-273,
 * ADR-0027: the CAM-156 false-BLOCK was caused by the auditor re-deriving
 * identity and matching a coincident GitHub PR number).
 *
 * Pure helper exported for unit testing. issue.spec?.acceptanceCriteria is
 * optional (guarded per noUncheckedIndexedAccess); an absent/empty spec
 * renders '(none provided)' rather than the literal string 'undefined'.
 */
export function buildAuditorTaskPrompt(issue: IssueEntry, branchName: string): string {
	const acceptanceCriteria = issue.spec?.acceptanceCriteria ?? [];
	const acLines =
		acceptanceCriteria.length > 0
			? acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')
			: '(none provided)';
	return (
		'Audit the generated plan per your AGENT.md. ' +
		'The issue this plan targets has already been resolved by deterministic code; ' +
		'use this record verbatim and do NOT re-resolve issue/PR identity against any backend ' +
		'(e.g. no gh issue/PR lookups):\n' +
		`Issue ID: ${issue.id}\n` +
		`Title: ${issue.title}\n` +
		`Description: ${issue.description ?? '(none provided)'}\n` +
		`Branch: ${branchName}\n` +
		`Acceptance Criteria:\n${acLines}\n` +
		'Write your verdict to scripts/cam/plan-verdict-report.json.'
	);
}

/** Default polling interval between pane/file checks (ms). */
export const DEFAULT_PLAN_POLL_INTERVAL_MS = 5_000;

/** Default per-phase timeout: 30 minutes (matches review.ts DEFAULT_REVIEW_TIMEOUT_MS). */
export const DEFAULT_PLAN_TIMEOUT_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Discriminated result returned by runPlanPhase.
 *
 * Required by AC1 (at least these four):
 *   preflight-failed     - preflightFn returned ok:false; no pane spawned.
 *   no-plannable-issue   - selectIssueFn returned null; no pane spawned.
 *   audit-approved       - auditor wrote APPROVE; caller may proceed.
 *   audit-blocked        - auditor wrote BLOCK; caller must not proceed.
 *
 * Additional kinds:
 *   mutex-busy           - pane-count mutex was 'busy'; no pane spawned (AC5).
 *   planner-timeout      - planner pane still alive after plannerTimeoutMs.
 *   auditor-timeout      - plan-verdict-report.json absent when auditor died or timed out.
 *   planner-failed       - planner poll ended but readPlannerReportFn returned null (no
 *                          prd.json written); auditor is NEVER spawned (US-003, CAM-155).
 *   plan-target-invalid  - opts.planTargetId was set (an explicit /cam-plan <id> target) AND
 *                          selectIssueFn() returned null (the target is missing / not-open /
 *                          not-plannable); carries the target id. The planner pane is NEVER
 *                          spawned (US-002, CAM-203): an explicit target is never a silent
 *                          no-op that plans a different issue.
 *   plan-escalated       - ONLY produced by runPlanPhaseWithReplan (US-003, CAM-204):
 *                          MAX_REPLAN_ROUNDS consecutive audit-blocked rounds without an
 *                          APPROVE verdict. Terminal, never proceeds to branch (ADR-0012:
 *                          non-convergence is a hard stop, never proceed-with-debt).
 *                          runPlanPhase itself never returns this kind.
 *   in-progress-conflict - detectInProgressConflictFn detected in-progress work at plan
 *                          start (US-004, CAM-241/153, AC1): an existing prd.json carrying
 *                          a passes:false non-operator story, or HEAD on a cam/* branch.
 *                          The in-progress-conflict gate was written (writeInProgressConflictGateFn)
 *                          and the phase already flipped to 'awaiting-operator' by that call.
 *                          Terminal for this call: no clearStalePlanArtifactsFn, preflightFn,
 *                          selectIssueFn, or worker spawn ever runs (AC1, AC2).
 */
export type PlanPhaseResult =
	| { kind: 'preflight-failed'; step: string; detail: string }
	| { kind: 'no-plannable-issue' }
	/**
	 * In-progress-work conflict detected at plan start (US-004, CAM-241/153).
	 * See the field doc above.
	 */
	| { kind: 'in-progress-conflict' }
	/**
	 * An explicit /cam-plan <id> target (opts.planTargetId) named a missing,
	 * not-open, or not-plannable issue (US-002, CAM-203). Distinct from
	 * 'no-plannable-issue' so the caller can surface a target-naming error
	 * instead of a silent generic "nothing to plan" result. The planner pane
	 * is NEVER spawned.
	 */
	| { kind: 'plan-target-invalid'; targetId: string }
	| { kind: 'mutex-busy' }
	| { kind: 'planner-timeout' }
	| { kind: 'auditor-timeout' }
	| { kind: 'planner-failed' }
	/**
	 * Container preflight blocked the spawn (US-006, CAM-152).
	 * `phase` indicates which spawn was blocked ('planner' or 'auditor').
	 * The corresponding worker was NEVER spawned on the host.
	 */
	| { kind: 'container-preflight-failed'; phase: 'planner' | 'auditor'; reason: string }
	| { kind: 'audit-approved'; issue: IssueEntry; report: PlanVerdictReport }
	| { kind: 'audit-blocked'; issue: IssueEntry; report: PlanVerdictReport }
	| { kind: 'plan-escalated'; issue: IssueEntry; report: PlanVerdictReport; roundsCompleted: number };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Mutex state type mirroring PaneMutexState from src/tmux/session.ts.
 * Duplicated here to avoid importing the session.ts SpawnFn type, which
 * is incompatible with the loop.ts SpawnFn shape (SpawnSyncReturns vs
 * { stdout: string; exitCode: number | null }).
 */
export type PlanMutexState = 'available' | 'busy';

/** Options for runPlanPhase. All side effects are injected. */
export interface RunPlanPhaseOptions {
	// -------------------------------------------------------------------------
	// Core injected deps (AC1) - all side effects route through these
	// -------------------------------------------------------------------------

	/** Spawn a shell command (loop.ts SpawnFn shape). */
	spawnFn: SpawnFn;

	/** Check whether a tmux pane is still alive (IsPaneAlive from loop.ts). */
	isPaneAlive: IsPaneAlive;

	/** Sleep between polling ticks. Tests inject a no-op. */
	sleepFn: (ms: number) => void;

	/** Generate a UUID (lowercased by runPlanPhase; CAM-23). */
	genUuid: () => string;

	/**
	 * Pick the highest-priority plannable issue. Delegates to
	 * selectPlannableFromFile / selectPlanTargetFromFile (src/issues/select.ts);
	 * returns null when the backlog is empty, the target is absent/not-plannable,
	 * or all issues are blocked/non-specified.
	 *
	 * A real backlog read/parse error THROWS (US-001, CAM-115: select.ts no
	 * longer swallows read/parse errors into a false null). runPlanPhase (Step 2
	 * below) does not catch this call: the throw is deliberately allowed to
	 * propagate fail-loud out of runPlanPhase / runPlanPhaseWithReplan. The
	 * production wiring (makeProductionPlanPhaseFn, sidecar.ts) already has an
	 * outermost try/catch around the whole plan-phase tick that logs the real
	 * error and resets phase to idle, so this is safe: no additional guard is
	 * needed inside runPlanPhase itself.
	 */
	selectIssueFn: () => IssueEntry | null;

	/**
	 * Read the auditor's structured verdict report from plan-verdict-report.json.
	 * Returns null on any read/parse error (graceful degradation). Never throws.
	 * Mirrors makeReadPlanVerdict from plan-verdict-report.ts.
	 */
	readPlanVerdictFn: () => PlanVerdictReport | null;

	/**
	 * Detect whether the planner has written prd.json (the planner's completion
	 * signal). Returns non-null when prd.json is present and readable; null
	 * otherwise. Never throws.
	 *
	 * Required to break the planner poll loop when the pane is still alive
	 * (interactive TUI workers do not self-exit; the driver kills them via
	 * respawn-pane -k after detecting the report, per the implementer/reviewer
	 * session model). Without this dep, pollPlannerDeath loops until
	 * plannerTimeoutMs (30 min) and returns planner-timeout, never spawning
	 * the auditor (US-R1-001).
	 *
	 * Mirrors readReviewReport in review.ts (patterns.md 'Review-report.json
	 * reader dep-injection pattern'). The prd.json content is not inspected
	 * by the poll loop; only presence (non-null) matters.
	 *
	 * Optional for backward compat with tests that simulate pane death instead.
	 * Production callers MUST inject this so the happy path does not time out.
	 */
	readPlannerReportFn?: () => unknown | null;

	/**
	 * Read AND PARSE the prd.json content the planner just wrote, in-process
	 * (US-002, CAM-310). Distinct from readPlannerReportFn, which stays
	 * presence-only (an opaque non-null signal, currently the raw file text):
	 * this seam returns the parsed PrdShape so runPlanWorkerSequence can run
	 * the deterministic oracle linter (lintPrd) against it before the auditor
	 * is ever spawned. Returns null on any read/parse error or when absent
	 * (graceful degradation, mirrors readPlanVerdictFn/readPlannerReportFn).
	 *
	 * Optional for backward compat: when undefined, the lint check is skipped
	 * entirely and behavior is unchanged from before US-002 (existing tests /
	 * callers that only exercise the planner-presence + auditor-verdict path
	 * are unaffected). Production wiring injects `() => readPrd(cwd)`
	 * (src/commands/status.ts).
	 */
	readPrdContentFn?: () => PrdShape | null;

	/**
	 * Run the deterministic plan pre-flight checks. Returns PlanPreflightResult
	 * (same discriminated union as runPlanPreflight in plan-preflight.ts).
	 */
	preflightFn: () => PlanPreflightResult;

	/**
	 * The explicit target issue id for an operator-invoked `/cam-plan <id>`
	 * (US-002, CAM-203). Purely a labeling input: it does NOT change how
	 * selectIssueFn is called (the caller is responsible for wiring
	 * selectIssueFn to resolve the target, e.g. via
	 * `() => selectPlanTargetFromFile(cwd, planTargetId, spawn)`). When set
	 * AND selectIssueFn() returns null, runPlanPhase returns
	 * `{ kind: 'plan-target-invalid', targetId: planTargetId }` instead of the
	 * generic `{ kind: 'no-plannable-issue' }`, and the planner pane is NEVER
	 * spawned. Absent (undefined) preserves the bare `cam plan` behavior
	 * unchanged (AC4: null selection -> 'no-plannable-issue').
	 */
	planTargetId?: string;

	/**
	 * Monotonic-ish clock in ms (Date.now equivalent). Injectable for tests so
	 * they can simulate timeout conditions without real waits.
	 */
	clock: () => number;

	// -------------------------------------------------------------------------
	// Pane infrastructure
	// -------------------------------------------------------------------------

	/**
	 * The tmux pane ID used as the worker slot for both the planner and auditor.
	 * Mirrors workerPaneId in loop.ts RunSupervisorOptions.
	 */
	plannerPaneId: string;

	/**
	 * Returns the current pane-count mutex state for the session.
	 *
	 * 'available' = session has exactly 2 panes (orch + dashboard); safe to
	 * spawn the 3rd pane. 'busy' = 1, 3, or more panes; must NOT spawn.
	 *
	 * Production wiring: `() => paneCountMutex(sessionName, tmuxSpawnFn)`
	 * (paneCountMutex from src/tmux/session.ts, tmuxSpawnFn is the node:child_process
	 * SpawnSyncReturns-returning adapter). Injecting as a closure avoids the
	 * SpawnFn shape mismatch between session.ts and loop.ts.
	 *
	 * Tests inject a fake that returns 'available' or 'busy' as needed.
	 */
	paneCountMutexFn: () => PlanMutexState;

	// -------------------------------------------------------------------------
	// Optional config
	// -------------------------------------------------------------------------

	/**
	 * Claude permission mode forwarded to the spawned claude processes. NEVER a
	 * cam CLI flag. Required so planner/auditor can run tools unprompted.
	 * Defaults to 'bypassPermissions'.
	 */
	permissionMode?: string;

	/** Task prompt sent to the planner. Defaults to DEFAULT_PLANNER_TASK_PROMPT. */
	plannerTaskPrompt?: string;

	/**
	 * Task prompt sent to the auditor. Defaults to a record-bearing prompt
	 * built via buildAuditorTaskPrompt(issue, branchName) from the selected
	 * IssueEntry and its code-derived branch name (US-001, CAM-273, ADR-0027).
	 * Overriding this is honored for backward compat with existing callers/tests.
	 */
	auditorTaskPrompt?: string;

	/** Polling interval in ms. Default: DEFAULT_PLAN_POLL_INTERVAL_MS (5s). */
	pollIntervalMs?: number;

	/** Per-planner deadline in ms. Default: DEFAULT_PLAN_TIMEOUT_MS (30 min). */
	plannerTimeoutMs?: number;

	/** Per-auditor deadline in ms. Default: DEFAULT_PLAN_TIMEOUT_MS (30 min). */
	auditorTimeoutMs?: number;

	/**
	 * Structured worker event logger. When provided, spawn-resolution events are
	 * persisted via the event log (same pattern as loop.ts and review.ts).
	 */
	logEvent?: WorkerEventLogger;

	/**
	 * Clear stale plan-verdict-report.json and prd.json before the plan phase
	 * starts (AC1, US-002, CAM-155). Called at the very top of runPlanPhase,
	 * before preflight, so a stale APPROVE verdict cannot contaminate the new run
	 * and so prd.json absence is detectable as 'planner produced nothing'.
	 *
	 * Best-effort: no-op on missing files, never throws. Mirrors
	 * makeClearReviewReport in host.ts ('Review-report.json reader dep-injection').
	 * Optional for backward compat with tests that do not inject it.
	 */
	clearStalePlanArtifactsFn?: () => void;

	/**
	 * Detect in-progress work that conflicts with a fresh plan request (US-004,
	 * CAM-241/153, AC1). Returns a free-text gate context string when EITHER:
	 *   (a) an existing prd.json carries a passes:false non-operator story, OR
	 *   (b) HEAD is on a cam/* branch;
	 * returns null when neither applies (AC4: no conflict).
	 *
	 * Called as the FIRST thing inside runPlanPhase, strictly before
	 * clearStalePlanArtifactsFn (which would otherwise destroy the very
	 * prd.json state this detection needs to inspect) and before
	 * preflightFn/selectIssueFn (AC1: no issue selection/dispatch happens on a
	 * conflict tick).
	 *
	 * Optional: absent means no detection (backward compat; zero behavior
	 * change for existing tests/callers that predate US-004).
	 *
	 * runPlanPhaseWithReplan (US-003, CAM-204) explicitly OMITS this dep (and
	 * writeInProgressConflictGateFn below) on every re-plan round (round >= 2):
	 * the check must fire at most ONCE per outer "requested plan" call, on
	 * round 1 only -- a re-plan round's own just-written draft prd.json
	 * (BLOCKed but not yet approved) must never be misdetected as someone
	 * else's in-progress work by the SAME cycle's later round.
	 */
	detectInProgressConflictFn?: () => string | null;

	/**
	 * Write side of the in-progress-conflict gate (US-004, AC2). Called with
	 * the detected context string, ONLY when detectInProgressConflictFn
	 * returned non-null. Production wiring calls writeGateAndNotify
	 * (supervisor/gate.ts) with gate: 'in-progress-conflict', options: EXACTLY
	 * ['continue','ship','abandon'] (IN_PROGRESS_CONFLICT_OPTIONS,
	 * in-progress-conflict.ts).
	 *
	 * Optional: absent means the short-circuit still happens (runPlanPhase
	 * returns 'in-progress-conflict') but nothing is written/notified (for
	 * tests that only assert the short-circuit itself).
	 */
	writeInProgressConflictGateFn?: (context: string) => void;

	/**
	 * Ensure a live worker pane exists before each spawn. Returns the live pane id.
	 *
	 * When provided, called BEFORE spawning the planner AND BEFORE spawning the
	 * auditor. The RETURNED id is threaded into set-option/respawn-pane/poll calls
	 * (never the static plannerPaneId or a stale marker). When absent, plannerPaneId
	 * is used directly (backward compat for tests that simulate pane death).
	 *
	 * Mirrors the ensureWorkerPane dep in RunSupervisorOptions (patterns.md
	 * 'ensureWorkerPane self-heal (CAM-57)'). Production wiring in
	 * makeProductionPlanPhaseFn (sidecar.ts): re-reads the marker fresh,
	 * isPaneAlive probe, openPaneInSession when dead/missing, writeWorkerPaneMarker.
	 */
	ensureWorkerPane?: () => string;

	/**
	 * Path to the .claude directory. Used to derive per-worker out-log paths for
	 * the tmux pipe-pane call that captures each spawn's pane output (AC4). When
	 * absent, pipe-pane is skipped (backward compat for tests that do not inject
	 * a claudeDir). Scoped to plan-runner spawns only; loop.ts is NOT modified.
	 */
	claudeDir?: string;

	// -------------------------------------------------------------------------
	// Container isolation (US-006, CAM-152)
	// -------------------------------------------------------------------------

	/**
	 * Worker isolation mode. 'container' wraps both planner and auditor shell
	 * strings via dockerExecWrap before respawn-pane and enables fail-closed
	 * preflight (preflightContainerFn not-ready -> container-preflight-failed).
	 * 'host' (default) leaves every existing plan-phase behavior unchanged.
	 */
	workerIsolation?: WorkerIsolation;

	/**
	 * Container preflight seam. Called immediately before the planner spawn and
	 * again before the auditor spawn. In container mode a not-ready result halts
	 * the plan phase immediately (fail-closed: the worker is NEVER dispatched on
	 * the host). In host mode the result is ignored. Optional for backward compat
	 * with tests that do not inject it.
	 *
	 * Mirrors preflightContainerFn in RunSupervisorOptions and
	 * MakeReviewDispatchOptions (patterns.md 'B-1/B-2 staged dispatch gating').
	 */
	preflightContainerFn?: () => PreflightResult;

	/**
	 * Best-effort escalation on container-preflight failure. Called fire-and-forget
	 * (never awaited; never throws by contract) when the container is not ready in
	 * container mode. Mirrors escalateFn in RunPostAuditOptions.
	 * Optional: absent means silent no-op on preflight failure.
	 */
	escalateFn?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers (extracted to satisfy biome complexity limits)
// ---------------------------------------------------------------------------

/**
 * Build an injectable writeEvent closure for emitSpawnResolution.
 * Returns undefined when logEvent is absent so the emitter skips persistence.
 */
function makeEventWriter(
	logEvent: WorkerEventLogger | undefined,
	uuid: string,
): ((e: SpawnResolutionEvent) => void) | undefined {
	if (logEvent === undefined) return undefined;
	return (e: SpawnResolutionEvent) =>
		logEvent({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid,
			kind: 'spawn-resolution',
			detail: e,
		});
}

/**
 * Resolve model/backend, emit spawn-resolution, build the argv shell string,
 * set @cam_label on the pane, spawn the planner worker via respawn-pane -k,
 * and pipe pane output to a per-worker out-log (AC4) when claudeDir is provided.
 *
 * @cam_label is set BEFORE respawn-pane (AC5, patterns.md '@cam_label pane-labeling').
 * genUuid() output is lowercased (CAM-23: macOS uuidgen is uppercase).
 * US-006 / CAM-152: shell is wrapped via dockerExecWrap when workerIsolation === 'container'.
 * Returns the lowercased uuid (for the event log if needed).
 */
function resolveAndSpawnPlanner(
	spawnFn: SpawnFn,
	plannerPaneId: string,
	genUuid: () => string,
	taskPrompt: string,
	permissionMode: string,
	logEvent: WorkerEventLogger | undefined,
	workerIsolation: WorkerIsolation,
	claudeDir?: string,
): string {
	const uuid = genUuid().toLowerCase();
	const model = readPhaseModel('planner');
	const backend = readBackend();
	emitSpawnResolution({ phase: 'planner', model, backend, writeEvent: makeEventWriter(logEvent, uuid) });
	const shell = buildPlannerWorkerArgv({ uuid, taskPrompt, permissionMode, model, isolation: workerIsolation });
	// US-006 / CAM-152: wrap via dockerExecWrap in container mode.
	const dispatchCmd = workerIsolation === 'container' ? dockerExecWrap(shell) : shell;
	spawnFn('tmux', ['-L', 'cam', 'set-option', '-p', '-t', plannerPaneId, '@cam_label', 'planner']);
	spawnFn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', plannerPaneId, dispatchCmd]);
	// AC4: pipe pane output to a per-worker out-log so silent no-ops are diagnosable.
	if (claudeDir !== undefined) {
		const outLog = join(claudeDir, `cam-plan-out-planner-${uuid}.log`);
		spawnFn('tmux', ['-L', 'cam', 'pipe-pane', '-t', plannerPaneId, `cat >> ${outLog}`]);
	}
	return uuid;
}

/**
 * Resolve model/backend, emit spawn-resolution, build the argv shell string,
 * set @cam_label on the pane, spawn the auditor worker via respawn-pane -k,
 * and pipe pane output to a per-worker out-log (AC4) when claudeDir is provided.
 *
 * @cam_label is set BEFORE respawn-pane (AC5, patterns.md '@cam_label pane-labeling').
 * genUuid() output is lowercased (CAM-23: macOS uuidgen is uppercase).
 * US-006 / CAM-152: shell is wrapped via dockerExecWrap when workerIsolation === 'container'.
 * Returns the lowercased uuid.
 */
function resolveAndSpawnAuditor(
	spawnFn: SpawnFn,
	plannerPaneId: string,
	genUuid: () => string,
	taskPrompt: string,
	permissionMode: string,
	logEvent: WorkerEventLogger | undefined,
	workerIsolation: WorkerIsolation,
	claudeDir?: string,
): string {
	const uuid = genUuid().toLowerCase();
	const model = readPhaseModel('auditor');
	const backend = readBackend();
	emitSpawnResolution({ phase: 'auditor', model, backend, writeEvent: makeEventWriter(logEvent, uuid) });
	const shell = buildAuditorWorkerArgv({ uuid, taskPrompt, permissionMode, model, isolation: workerIsolation });
	// US-006 / CAM-152: wrap via dockerExecWrap in container mode.
	const dispatchCmd = workerIsolation === 'container' ? dockerExecWrap(shell) : shell;
	spawnFn('tmux', ['-L', 'cam', 'set-option', '-p', '-t', plannerPaneId, '@cam_label', 'auditor']);
	spawnFn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', plannerPaneId, dispatchCmd]);
	// AC4: pipe pane output to a per-worker out-log so silent no-ops are diagnosable.
	if (claudeDir !== undefined) {
		const outLog = join(claudeDir, `cam-plan-out-auditor-${uuid}.log`);
		spawnFn('tmux', ['-L', 'cam', 'pipe-pane', '-t', plannerPaneId, `cat >> ${outLog}`]);
	}
	return uuid;
}

/**
 * Run the container preflight check before a plan spawn (US-006, CAM-152).
 *
 * Returns a container-preflight-failed PlanPhaseResult when container mode is
 * active and preflightContainerFn reports not-ready; null otherwise (no block).
 * escalateFn is called fire-and-forget when a block occurs.
 *
 * Mirrors the container preflight logic in loop.ts (B-2, US-004) and review.ts
 * (US-005). The 'phase' discriminator ('planner' | 'auditor') identifies which
 * spawn was blocked so the caller can log/notify accurately.
 */
function runContainerPlanPreflight(
	phase: 'planner' | 'auditor',
	workerIsolation: WorkerIsolation,
	preflightContainerFn: (() => PreflightResult) | undefined,
	escalateFn: (() => Promise<void>) | undefined,
): Extract<PlanPhaseResult, { kind: 'container-preflight-failed' }> | null {
	if (preflightContainerFn === undefined) return null;
	const result = preflightContainerFn();
	if (workerIsolation === 'container' && !result.ready) {
		if (escalateFn !== undefined) {
			void escalateFn(); // fire-and-forget: best-effort, never throws by contract
		}
		return { kind: 'container-preflight-failed', phase, reason: result.reason };
	}
	return null;
}

/**
 * Return true when the planner poll ended without prd.json being written.
 *
 * pollPlannerDeath exits via EITHER the report signal (non-null) OR pane-death.
 * A fresh re-call of readPlannerReportFn distinguishes: undefined = absent dep
 * (backward-compat); non-null = prd.json written (happy path); null = no prd.json
 * (planner-failed). Extracted to satisfy biome complexity limits (US-003, CAM-155).
 */
function isPlannerNoPrd(readPlannerReportFn?: () => unknown | null): boolean {
	return readPlannerReportFn !== undefined && readPlannerReportFn() === null;
}

/**
 * Build a synthetic BLOCK PlanVerdictReport from the deterministic oracle
 * linter's findings (US-002, CAM-310), folding lintPrd's output into the
 * EXISTING audit-BLOCK machinery so runPlanPhaseWithReplan's while-loop
 * re-plans the same issue via buildReplanPlannerTaskPrompt with no new
 * terminal kind. Each PrdOracleLintFinding (story id + offending oracle
 * command + rule name + why-broken) becomes one PlanVerdictFinding, with the
 * rule name and offending command folded into `description` (PlanVerdictFinding
 * has no dedicated command/rule fields) so no information is lost.
 *
 * Exported for unit testing.
 */
export function buildLintBlockReport(findings: PrdOracleLintFinding[]): PlanVerdictReport {
	return {
		verdict: 'BLOCK',
		summary:
			`Deterministic oracle lint found ${findings.length} broken oracle` +
			`${findings.length === 1 ? '' : 's'} before the auditor was spawned.`,
		findings: findings.map((finding, index) => ({
			id: `oracle-lint-${index + 1}`,
			category: finding.ruleName,
			severity: 'critical',
			storyId: finding.storyId,
			description:
				`Oracle lint rule '${finding.ruleName}' flagged story ${finding.storyId}'s oracle ` +
				`command \`${finding.command}\`: ${finding.reason}`,
		})),
	};
}

/**
 * Run the deterministic oracle linter (lintPrd) against the just-written
 * prd.json content and, when it finds a broken oracle, return a synthetic
 * audit-blocked result so the auditor is NEVER spawned for that round
 * (US-002, CAM-310). Returns null (no block) when readPrdContentFn is absent
 * (backward compat: lint is skipped entirely), the content is unreadable, or
 * lintPrd finds nothing to flag -- the caller proceeds to the auditor
 * unchanged in every one of those cases (AC5: zero behavior change on a
 * clean PRD).
 *
 * Extracted to keep runPlanWorkerSequence under biome's line/complexity
 * limits (patterns.md 'Biome cognitive complexity: use factory/helper
 * extraction').
 */
function runOracleLintCheck(
	readPrdContentFn: (() => PrdShape | null) | undefined,
	issue: IssueEntry,
): Extract<PlanPhaseResult, { kind: 'audit-blocked' }> | null {
	if (readPrdContentFn === undefined) return null;
	const prd = readPrdContentFn();
	if (prd === null) return null;
	const findings = lintPrd(prd);
	if (findings.length === 0) return null;
	return { kind: 'audit-blocked', issue, report: buildLintBlockReport(findings) };
}

/**
 * Resolve the live worker pane id.
 * Calls ensureWorkerPane() when available (self-heal, CAM-57); falls back to staticId.
 * Extracted to avoid code duplication for planner and auditor spawns.
 */
function resolveLivePaneId(ensureWorkerPane: (() => string) | undefined, staticId: string): string {
	return ensureWorkerPane !== undefined ? ensureWorkerPane() : staticId;
}

/**
 * Resolve the result kind for a null selectIssueFn() outcome (US-002, CAM-203).
 *
 * When planTargetId is set (an explicit /cam-plan <id> invocation), the null
 * selection is loud and target-naming ('plan-target-invalid') rather than the
 * generic 'no-plannable-issue', so an explicit target is never a silent no-op.
 * Extracted to keep runPlanPhase's Step 2 a one-liner (patterns.md 'Biome
 * cognitive complexity: use factory/helper extraction').
 */
function resolveNoIssueResult(
	planTargetId: string | undefined,
): Extract<PlanPhaseResult, { kind: 'no-plannable-issue' } | { kind: 'plan-target-invalid' }> {
	return planTargetId !== undefined
		? { kind: 'plan-target-invalid', targetId: planTargetId }
		: { kind: 'no-plannable-issue' };
}

/**
 * Poll until the planner completes (prd.json written OR pane dies) or the
 * deadline fires. Returns true on completion; false on timeout (after killing
 * the pane).
 *
 * Completion is detected by two signals (in priority order, mirroring
 * review.ts makeReviewDispatch):
 *   1. readPlannerReportFn() !== null  – prd.json written (primary signal).
 *      The pane is still alive; respawn-pane -k at Step 6 (auditor spawn)
 *      will kill it. Explicit kill not needed here.
 *   2. !isPaneAlive(plannerPaneId)     – pane died naturally (fallback).
 *
 * Without signal (1), interactive TUI workers (claude sessions) never
 * self-exit, so isPaneAlive stays true until plannerTimeoutMs and the
 * happy path returns planner-timeout (US-R1-001 critical bug).
 */
function pollPlannerDeath(
	isPaneAlive: IsPaneAlive,
	sleepFn: (ms: number) => void,
	clock: () => number,
	spawnFn: SpawnFn,
	plannerPaneId: string,
	pollIntervalMs: number,
	plannerTimeoutMs: number,
	readPlannerReportFn?: () => unknown | null,
): boolean {
	const start = clock();
	while (true) {
		sleepFn(pollIntervalMs);

		// Primary completion signal: prd.json written by the planner.
		// Check BEFORE pane-death so we can detect completion even if the pane
		// exits right after writing (mirrors review.ts readReviewReport pattern).
		if (readPlannerReportFn !== undefined && readPlannerReportFn() !== null) {
			return true;
		}

		// Fallback: pane died naturally (e.g. non-interactive mode, test injection).
		if (!isPaneAlive(plannerPaneId)) {
			return true;
		}

		if (clock() - start >= plannerTimeoutMs) {
			spawnFn('tmux', [
				'-L', 'cam', 'respawn-pane', '-k', '-t', plannerPaneId, 'echo planner-timeout',
			]);
			return false;
		}
	}
}

/** Internal result from the auditor poll loop. */
type AuditorPollResult =
	| { ok: true; report: PlanVerdictReport }
	| { ok: false };

/**
 * Poll until plan-verdict-report.json is present, the auditor pane dies, or
 * the deadline fires. Returns { ok: true, report } on success; { ok: false }
 * on pane-death-without-report or timeout (after killing the pane on timeout).
 *
 * The verdict is read via readPlanVerdictFn ONLY - never from capture-pane
 * (patterns.md 'capture-pane is rendered markdown').
 */
function pollAuditorReport(
	isPaneAlive: IsPaneAlive,
	sleepFn: (ms: number) => void,
	clock: () => number,
	spawnFn: SpawnFn,
	readPlanVerdictFn: () => PlanVerdictReport | null,
	plannerPaneId: string,
	pollIntervalMs: number,
	auditorTimeoutMs: number,
): AuditorPollResult {
	const start = clock();
	while (true) {
		sleepFn(pollIntervalMs);
		const verdict = readPlanVerdictFn();
		if (verdict !== null) return { ok: true, report: verdict };
		if (!isPaneAlive(plannerPaneId)) return { ok: false };
		if (clock() - start >= auditorTimeoutMs) {
			spawnFn('tmux', [
				'-L', 'cam', 'respawn-pane', '-k', '-t', plannerPaneId, 'echo auditor-timeout',
			]);
			return { ok: false };
		}
	}
}

// ---------------------------------------------------------------------------
// runPlanPhase
// ---------------------------------------------------------------------------

/**
 * Execute the full plan phase deterministically.
 *
 * Returns a PlanPhaseResult discriminated union. The caller (US-006) is
 * responsible for acting on the result (commit, branch, flip prd.json on
 * audit-approved; re-plan loop on audit-blocked via CAM-151 Half B).
 *
 * Pure over its injected deps: all side effects are routed through the
 * options object so the test suite can assert exact spawn sequences,
 * session-id case, label ordering, and timeout behavior.
 */
/**
 * Execute plan phase steps 4-7: container preflight (US-006) + planner spawn +
 * planner poll + container preflight + auditor spawn + auditor poll.
 *
 * Extracted from runPlanPhase to keep that function under biome's
 * noExcessiveLinesPerFunction(max=80) and noExcessiveCognitiveComplexity(max=15)
 * limits (patterns.md 'Biome cognitive complexity: use factory/helper extraction').
 *
 * The caller (runPlanPhase) resolves plannerTaskPrompt and issue before calling;
 * both are unavailable until steps 1-3 complete.
 */
function runPlanWorkerSequence(
	opts: RunPlanPhaseOptions,
	plannerTaskPrompt: string,
	issue: IssueEntry,
): PlanPhaseResult {
	const {
		spawnFn, isPaneAlive, sleepFn, genUuid, clock, plannerPaneId,
		ensureWorkerPane, claudeDir, logEvent, readPlannerReportFn, readPlanVerdictFn,
		readPrdContentFn,
	} = opts;
	const permissionMode = opts.permissionMode ?? 'bypassPermissions';
	// US-001, CAM-273 (ADR-0027): default to a record-bearing prompt built from
	// the already-resolved issue + its code-derived branch name, rather than
	// the static prior default. opts.auditorTaskPrompt override still wins.
	const auditorTaskPrompt =
		opts.auditorTaskPrompt ??
		buildAuditorTaskPrompt(issue, deriveBranchNameFromIssueId(issue.id) ?? 'cam/issue-unknown');
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_PLAN_POLL_INTERVAL_MS;
	const plannerTimeoutMs = opts.plannerTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
	const auditorTimeoutMs = opts.auditorTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
	// US-006 / CAM-152: container isolation mode + preflight seam.
	const workerIsolation: WorkerIsolation = opts.workerIsolation ?? 'host';
	const { preflightContainerFn, escalateFn } = opts;

	// Step 4: Container preflight (US-006) + planner spawn.
	const planBlock = runContainerPlanPreflight('planner', workerIsolation, preflightContainerFn, escalateFn);
	if (planBlock !== null) return planBlock;
	const plannerLivePaneId = resolveLivePaneId(ensureWorkerPane, plannerPaneId);
	resolveAndSpawnPlanner(spawnFn, plannerLivePaneId, genUuid, plannerTaskPrompt, permissionMode, logEvent, workerIsolation, claudeDir);

	// Step 5: Poll planner — primary signal: prd.json written; fallback: pane dies.
	const plannerDied = pollPlannerDeath(isPaneAlive, sleepFn, clock, spawnFn, plannerLivePaneId, pollIntervalMs, plannerTimeoutMs, readPlannerReportFn);
	if (!plannerDied) return { kind: 'planner-timeout' };

	// US-003: Guard — re-check if prd.json was actually written (Bug 4-adjacent).
	if (isPlannerNoPrd(readPlannerReportFn)) return { kind: 'planner-failed' };

	// US-002 (CAM-310): deterministic oracle lint of the prd.json the planner
	// just wrote. Runs AFTER the presence guard above but BEFORE the auditor is
	// EVER spawned: a broken oracle becomes a synthetic audit-blocked result
	// (folded into the existing re-plan loop) and the auditor is never spent
	// on a round that is already deterministically broken.
	const lintBlock = runOracleLintCheck(readPrdContentFn, issue);
	if (lintBlock !== null) return lintBlock;

	// Step 6: Container preflight (US-006) + auditor spawn.
	const auditorBlock = runContainerPlanPreflight('auditor', workerIsolation, preflightContainerFn, escalateFn);
	if (auditorBlock !== null) return auditorBlock;
	const auditorLivePaneId = resolveLivePaneId(ensureWorkerPane, plannerPaneId);
	resolveAndSpawnAuditor(spawnFn, auditorLivePaneId, genUuid, auditorTaskPrompt, permissionMode, logEvent, workerIsolation, claudeDir);

	// Step 7: Poll auditor — verdict from FILE ONLY, never from capture-pane.
	const auditorResult = pollAuditorReport(isPaneAlive, sleepFn, clock, spawnFn, readPlanVerdictFn, auditorLivePaneId, pollIntervalMs, auditorTimeoutMs);
	if (!auditorResult.ok) return { kind: 'auditor-timeout' };
	const { report } = auditorResult;
	return report.verdict === 'APPROVE' ? { kind: 'audit-approved', issue, report } : { kind: 'audit-blocked', issue, report };
}

/**
 * Execute the full plan phase deterministically.
 *
 * Returns a PlanPhaseResult discriminated union. The caller (US-006) is
 * responsible for acting on the result (commit, branch, flip prd.json on
 * audit-approved; re-plan loop on audit-blocked via CAM-151 Half B).
 *
 * Pure over its injected deps: all side effects are routed through the
 * options object so the test suite can assert exact spawn sequences,
 * session-id case, label ordering, and timeout behavior.
 *
 * Steps 4-7 (worker dispatch) are delegated to runPlanWorkerSequence to keep
 * this function under biome's line/complexity limits (US-006, CAM-152).
 */
export function runPlanPhase(opts: RunPlanPhaseOptions): PlanPhaseResult {
	const {
		preflightFn, selectIssueFn, paneCountMutexFn, clearStalePlanArtifactsFn, logEvent,
		detectInProgressConflictFn, writeInProgressConflictGateFn,
	} = opts;

	// US-004 (CAM-241/153, AC1): in-progress-conflict gate. Runs BEFORE
	// clearStalePlanArtifactsFn (which would otherwise destroy the very
	// prd.json state this detection needs to inspect) and before ANY issue
	// selection/dispatch (AC1, AC2). AC4: absent/null means proceed unchanged.
	const conflictContext = detectInProgressConflictFn?.() ?? null;
	if (conflictContext !== null) {
		writeInProgressConflictGateFn?.(conflictContext);
		return { kind: 'in-progress-conflict' };
	}

	// Clear stale artifacts from any previous plan run (AC1, US-002).
	// Runs BEFORE preflight so a stale APPROVE verdict cannot contaminate the
	// new run and so prd.json absence is detectable as 'planner produced nothing'.
	clearStalePlanArtifactsFn?.();

	// Step 1: Pre-flight checks (AC2)
	const preflight = preflightFn();
	if (!preflight.ok) {
		logEvent?.({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'plan-preflight',
			kind: 'plan-preflight-failed',
			detail: { step: preflight.step, detail: preflight.detail },
		});
		return { kind: 'preflight-failed', step: preflight.step, detail: preflight.detail };
	}

	// Step 2: Pick plannable issue (AC3)
	const issue = selectIssueFn();
	if (issue === null) return resolveNoIssueResult(opts.planTargetId);

	// NOTE: plannerTaskPrompt is resolved AFTER issue selection so it can be
	// built from the selected issue.id (CAM-157 root-cause fix).
	// The opts.plannerTaskPrompt override is honored for backward compat.
	const plannerTaskPrompt = opts.plannerTaskPrompt ?? buildPlannerTaskPrompt(issue.id);

	// Step 3: Assert pane-count mutex (AC5)
	if (paneCountMutexFn() === 'busy') return { kind: 'mutex-busy' };

	// Steps 4-7: Worker dispatch (container preflight + spawn + poll for both
	// planner and auditor). Extracted to runPlanWorkerSequence (biome limits).
	return runPlanWorkerSequence(opts, plannerTaskPrompt, issue);
}

// ---------------------------------------------------------------------------
// BLOCK -> re-plan loop (US-003, CAM-204)
// ---------------------------------------------------------------------------

/**
 * Fields the escalation-marker writer seam is invoked with on non-convergence
 * (US-003, CAM-204). Mirrors PlanEscalatedMarker minus `writtenAt`: the
 * production wiring (US-004) stamps the timestamp itself when persisting the
 * durable marker file, keeping this pure module clock-free.
 */
export type PlanEscalationWriterParams = Omit<PlanEscalatedMarker, 'writtenAt'>;

/** Options for runPlanPhaseWithReplan: RunPlanPhaseOptions plus the two loop seams. */
export interface RunPlanPhaseWithReplanOptions extends RunPlanPhaseOptions {
	/**
	 * Teardown seam for the planner/auditor pane. Invoked:
	 *   - BEFORE each re-plan round's runPlanPhase call, so the pane-count
	 *     mutex sees 'available' (the auditor TUI pane never self-exits).
	 *   - Unconditionally, exactly once, at the function's single exit point
	 *     (US-001, CAM-269), covering EVERY terminal PlanPhaseResult kind:
	 *     audit-approved, plan-escalated, the non-audit post-spawn kinds
	 *     (planner-timeout, auditor-timeout, planner-failed), and the
	 *     pre-spawn kinds (preflight-failed, no-plannable-issue,
	 *     plan-target-invalid, mutex-busy, container-preflight-failed). On
	 *     the pre-spawn/timeout kinds this is a harmless no-op: kill-pane is
	 *     best-effort when no plan pane was ever spawned.
	 * Optional: defaults to a no-op for backward compat. Production wiring
	 * (US-004) mirrors host.ts teardownWorkerPaneFn (kill-pane, best-effort,
	 * never-throwing).
	 */
	teardownPlanPanesFn?: () => void;

	/**
	 * Escalation-marker writer seam. Invoked exactly once, when
	 * MAX_REPLAN_ROUNDS consecutive audit-blocked rounds are exhausted without
	 * an APPROVE verdict (AC3, US-003, ADR-0012: non-convergence is a hard
	 * stop, never proceed-with-debt). Called with the LAST round's issue id,
	 * summary, findings, and the total rounds completed. Optional: defaults to
	 * a no-op for backward compat. Production wiring (US-004) constructs the
	 * full PlanEscalatedMarker (adding writtenAt) and calls
	 * writePlanEscalatedMarker against the .claude/ dir.
	 */
	writeEscalationMarkerFn?: (params: PlanEscalationWriterParams) => void;
}

/**
 * Drive runPlanPhase through up to MAX_REPLAN_ROUNDS rounds, mirroring the
 * review loop's FIXES_PENDING -> re-implement -> MAX_ROUNDS control flow in
 * loop.ts (US-003, CAM-204).
 *
 * Round 1 runs runPlanPhase unchanged (opts as given). Each subsequent round
 * (while the previous round was audit-blocked and rounds remain) re-runs
 * runPlanPhase pinned to the SAME issue (selectIssueFn overridden to return
 * the blocked round's issue, never re-selecting from the backlog) with
 * plannerTaskPrompt built via buildReplanPlannerTaskPrompt(issue.id,
 * priorFindings) so the planner corrects the flagged defects instead of
 * regenerating blind.
 *
 * The prior round's findings/summary are captured from the in-memory
 * audit-blocked result BEFORE the next round's clearStalePlanArtifactsFn
 * (invoked at the top of the next runPlanPhase call) deletes
 * plan-verdict-report.json (AC2).
 *
 * Terminal outcomes:
 *   - audit-approved: returned as-is (proceeds to the caller's branch path).
 *   - MAX_REPLAN_ROUNDS exhausted still audit-blocked: writeEscalationMarkerFn
 *     is invoked with the last round's findings, and a terminal
 *     `plan-escalated` result is returned (never `audit-blocked`, never
 *     branch, AC3).
 *   - Any other (non-audit) kind from round 1: returned as-is, no re-plan
 *     round is ever triggered.
 *
 * Pane teardown (US-001, CAM-269): teardownPlanPanesFn() fires exactly once
 * at a SINGLE unconditional exit point (a try/finally wrapping the whole
 * function body), covering every terminal return path above, INCLUDING the
 * non-audit post-spawn kinds (planner-timeout, auditor-timeout,
 * planner-failed) and the pre-spawn kinds (preflight-failed,
 * no-plannable-issue, plan-target-invalid, mutex-busy,
 * container-preflight-failed) that previously fell through with no teardown
 * call. This mirrors the finishTerminal-always-tears-down invariant
 * (patterns.md, CAM-188): a single exit point is drift-proof against a
 * future terminal kind silently reopening the gap, whereas enumerating kinds
 * is exactly how the gap was introduced originally. The round-boundary
 * teardown() call inside the while loop (CAM-204) is unchanged: it fires
 * mid-function, before each re-plan round's spawn, and is unrelated to this
 * exit teardown (the exit teardown never fires until the whole loop, and any
 * re-plan round it drove, has completed).
 */
export function runPlanPhaseWithReplan(opts: RunPlanPhaseWithReplanOptions): PlanPhaseResult {
	const { teardownPlanPanesFn, writeEscalationMarkerFn, ...planOpts } = opts;
	const teardown = teardownPlanPanesFn ?? ((): void => {});
	const writeMarker = writeEscalationMarkerFn ?? ((): void => {});

	try {
		let result = runPlanPhase(planOpts);
		let roundsCompleted = 1;

		while (result.kind === 'audit-blocked' && roundsCompleted < MAX_REPLAN_ROUNDS) {
			const blockedIssue = result.issue;
			const blockedFindings = result.report.findings;

			// Teardown BEFORE the next round's spawn: functionally required, or
			// paneCountMutexFn returns 'busy' (the auditor TUI pane never self-exits).
			teardown();
			roundsCompleted += 1;
			result = runPlanPhase({
				...planOpts,
				selectIssueFn: () => blockedIssue,
				plannerTaskPrompt: buildReplanPlannerTaskPrompt(blockedIssue.id, blockedFindings),
				// US-004 (CAM-241/153): the in-progress-conflict check fires at most
				// ONCE per outer call, on round 1 only (see the field doc on
				// RunPlanPhaseOptions.detectInProgressConflictFn) -- a re-plan
				// round's own just-written draft prd.json must never be
				// misdetected as in-progress work by the SAME cycle's later round.
				detectInProgressConflictFn: undefined,
				writeInProgressConflictGateFn: undefined,
			});
		}

		if (result.kind === 'audit-blocked') {
			// MAX_REPLAN_ROUNDS exhausted without convergence (ADR-0012 hard stop).
			writeMarker({
				issueId: result.issue.id,
				summary: result.report.summary,
				findings: result.report.findings,
				roundsCompleted,
			});
			// US-R1-001 (CAM-204 review fix): emit the structured 'plan-escalated'
			// event UNCONDITIONALLY on this terminal (AC2). The durable marker above
			// covers the US-005 boot-doc read path; this event is the flight-recorder
			// counterpart (mirrors every other terminal that pairs a marker/state
			// write with a logEvent call, e.g. 'plan-preflight-failed' in
			// runPlanPhase). logEvent is optional (test callers omit it), so this is
			// a no-op when absent.
			planOpts.logEvent?.({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'plan-escalation',
				kind: 'plan-escalated',
				detail: { issueId: result.issue.id, roundsCompleted },
			});
			return {
				kind: 'plan-escalated',
				issue: result.issue,
				report: result.report,
				roundsCompleted,
			};
		}

		// audit-approved, or any non-audit kind (preflight-failed,
		// no-plannable-issue, plan-target-invalid, mutex-busy, planner-timeout,
		// auditor-timeout, planner-failed, container-preflight-failed):
		// returned as-is, no re-plan round. Every one of these still passes
		// through the exit-teardown in `finally` below (AC1, AC2).
		return result;
	} finally {
		teardown();
	}
}

// ---------------------------------------------------------------------------
// Post-audit action (US-006)
// ---------------------------------------------------------------------------

/**
 * Discriminated result returned by runPostAuditAction.
 *
 * branch-created         - proceed-branch path: branch created, prd.json
 *                          committed, active:true flipped.
 * awaiting-operator-approval - pause-operator path: no branch/commit/flip.
 * escalated              - audit-blocked OR plan-escalated (US-004, CAM-204)
 *                          path: escalateFn + notifyFn called, no
 *                          branch/commit/flip. The durable marker for
 *                          plan-escalated was already written unconditionally
 *                          by runPlanPhaseWithReplan before this result is
 *                          produced.
 * preflight-failed        - a plan-preflight check failed before the planner
 *                          was ever spawned (US-003, CAM-215): the durable
 *                          marker is written and notifyFn is called here, no
 *                          branch/commit/flip.
 * in-progress-conflict   - planResult was 'in-progress-conflict' (US-004,
 *                          CAM-241/153): the gate write already flipped the
 *                          phase to 'awaiting-operator' (inside
 *                          detectInProgressConflictFn's writer seam, BEFORE
 *                          runPostAuditAction is ever called). No further
 *                          notify/escalate/marker/phase-flip happens here.
 * no-action              - planResult was neither audit-approved,
 *                          audit-blocked, plan-escalated, nor preflight-failed
 *                          (e.g. timeout, mutex-busy).
 */
export type PostAuditActionResult =
	| { kind: 'branch-created'; branchName: string }
	| { kind: 'awaiting-operator-approval' }
	| { kind: 'escalated' }
	| { kind: 'preflight-failed' }
	| { kind: 'in-progress-conflict' }
	| { kind: 'no-action' };

/** Options for runPostAuditAction. All side effects are injected. */
export interface RunPostAuditOptions {
	/** Result from a prior runPlanPhase call. */
	planResult: PlanPhaseResult;
	/**
	 * Spawn a shell command (loop.ts SpawnFn shape).
	 * Used for git checkout -B, git add, git commit.
	 */
	spawnFn: SpawnFn;
	/**
	 * Writes phase:<value> to .claude/cam-loop.local.md so the sidecar loop
	 * picks up the correct phase. Called exactly once on the proceed-branch
	 * path with 'implementing' so the loop dispatches the implementer worker.
	 * Production: makeSetPhaseFn(claudeDir, cwd) in sidecar.ts.
	 */
	setPhaseFn: (phase: LoopPhase) => void;
	/**
	 * prd.issueNumber, read verbatim from prd.json (US-001, CAM-236, ADR-0016).
	 * The branch name is no longer trusted from the planner-authored
	 * prd.branchName string: runPostAuditAction derives it in code as
	 * `cam/issue-<issueNumber>` via deriveBranchName(). When issueNumber is
	 * null, undefined, or not a number, the proceed-branch path is barred by
	 * the missing-issueNumber gate (no git checkout is spawned, no branch is
	 * created, no slug or ad-hoc fallback).
	 */
	issueNumber: unknown;
	/**
	 * Writes the derived branch name back into prd.json's `branchName` field,
	 * BEFORE the prd.json commit in executeGitProceedBranch (US-001, CAM-236,
	 * AC4), so the committed PRD and downstream readers (status, dashboard,
	 * ship, suggestions source) stay coherent with the real branch even if the
	 * planner emitted something else. Production: rewrites scripts/cam/prd.json
	 * in place (sidecar.ts). Optional: absent means no rewrite (backward compat
	 * with tests that do not inject it).
	 */
	writePrdBranchNameFn?: (branchName: string) => void;
	/**
	 * Returns the plan_approval config value. Production: () => readPlanApproval().
	 * Tests inject a constant-returning closure to control the path.
	 */
	readPlanApprovalFn: () => PlanApproval;
	/**
	 * Best-effort email/pager alert on audit-blocked. Never throws (contract
	 * mirrors makeProductionEscalateFn / sendEscalation in src/notify/resend.ts).
	 * Absent when Resend is unconfigured.
	 */
	escalateFn?: () => Promise<void>;
	/**
	 * Best-effort orchestrator-pane push on audit-blocked.
	 * Mirrors the notifyOrchestrator seam in RunSupervisorOptions.
	 * Absent when no orchestrator session is running.
	 */
	notifyFn?: (msg: string) => void;
	/**
	 * Remove the durable plan-escalation marker (US-004, CAM-204, AC4). Called
	 * ONLY on the converging proceed-branch path (audit-approved ->
	 * branch-created), so a stale BLOCK escalation from an earlier round or
	 * issue never outlives a fresh convergence. Never called on
	 * pause-operator, escalated (audit-blocked / plan-escalated), or no-action
	 * outcomes. Optional: absent means no removal call (backward compat with
	 * tests that do not inject it; production wiring in sidecar.ts always
	 * supplies it via removePlanEscalatedMarker).
	 */
	removeEscalationMarkerFn?: () => void;
	/**
	 * Structured worker event logger (US-003, CAM-203). When provided, a
	 * 'plan-target-invalid' event is emitted on that terminal, carrying the
	 * target id, so the failure is diagnosable from
	 * .claude/cam-worker-events.jsonl. Optional for backward compat with tests
	 * that do not inject it.
	 */
	logEvent?: WorkerEventLogger;
	/**
	 * Durable plan-preflight-failed marker writer seam (US-003, CAM-215).
	 * Invoked with the FULL untruncated { step, detail } on a preflight-failed
	 * planResult, regardless of notifyFn's presence or outcome: notifyFn is a
	 * best-effort silent no-op when the orchestrator pane is gone, but the
	 * durable marker is the source of truth for a recycled orchestrator
	 * (src/supervisor/plan-preflight-marker.ts, US-002). Optional: defaults to
	 * a no-op for backward compat. Production wiring (sidecar.ts) constructs
	 * the full PlanPreflightFailedMarker (adding writtenAt) and calls
	 * writePlanPreflightFailedMarker against the .claude/ dir.
	 */
	writePreflightFailedMarkerFn?: (params: PlanPreflightFailedWriterParams) => void;
	/**
	 * Remove the durable plan-preflight-failed marker (US-004, CAM-215,
	 * Option B). Called for EVERY planResult whose kind is NOT
	 * 'preflight-failed', regardless of which kind it is. Unlike
	 * removeEscalationMarkerFn (gated on the single proceed-branch convergence
	 * path), this removal is NOT gated on convergence and NOT gated on issueId:
	 * the marker itself carries no issueId (a preflight failure is an
	 * environment-level problem, not tied to a specific issue), so "marker
	 * present" must always mean "the LAST plan attempt died in preflight" -
	 * any subsequent non-preflight-failed result, whatever its kind, means a
	 * stale marker must not outlive it. Optional: defaults to a no-op for
	 * backward compat with tests that do not inject it; production wiring
	 * (sidecar.ts) always supplies it via removePlanPreflightFailedMarker,
	 * sibling of removeEscalationMarkerFn's wiring.
	 */
	removePreflightFailedMarkerFn?: () => void;
}

/**
 * Execute the three git calls for the proceed-branch path:
 *   checkout -B -> [write branchName back into prd.json] -> add prd.json ->
 *   commit -> setPhaseFn('implementing')
 *
 * `checkout -B` (capital B, recreate from current HEAD) is used instead of
 * `-b` so re-planning the same issue with the branch already existing does
 * not fail with 'already exists' (US-001, CAM-236, ADR-0016): idempotent
 * convergence on one branch name per issue.
 *
 * writePrdBranchNameFn runs BEFORE `git add`, so the committed prd.json
 * reflects the derived name even when the planner emitted something else
 * (US-001, CAM-236, AC4).
 *
 * Extracted from runPostAuditAction to keep that function under the biome
 * cognitive-complexity limit (US-004, CAM-155). All exit-code checks follow
 * the spawnSync exit-status guard pattern (patterns.md US-R1-001).
 */
function executeGitProceedBranch(
	spawnFn: SpawnFn,
	branchName: string,
	setPhaseFn: (phase: LoopPhase) => void,
	writePrdBranchNameFn: ((branchName: string) => void) | undefined,
): PostAuditActionResult {
	const checkoutResult = spawnFn('git', ['checkout', '-B', branchName]);
	if ((checkoutResult.exitCode ?? 1) !== 0) {
		throw new Error(
			`git checkout -B ${branchName} failed (exit ${checkoutResult.exitCode ?? 'null'})`,
		);
	}

	writePrdBranchNameFn?.(branchName);

	const addResult = spawnFn('git', ['add', 'scripts/cam/prd.json']);
	if ((addResult.exitCode ?? 1) !== 0) {
		throw new Error(
			`git add scripts/cam/prd.json failed (exit ${addResult.exitCode ?? 'null'})`,
		);
	}

	const commitResult = spawnFn('git', ['commit', '-m', 'chore(cam): commit audited prd.json']);
	if ((commitResult.exitCode ?? 1) !== 0) {
		throw new Error(
			`git commit failed (exit ${commitResult.exitCode ?? 'null'})`,
		);
	}

	setPhaseFn('implementing');
	return { kind: 'branch-created', branchName };
}

/**
 * Handle the plan-target-invalid terminal (US-003, CAM-203): an explicit
 * /cam-plan <id> target could not be planned (missing / not-open /
 * not-specified / blocked). This is an operator-input error, not an infra
 * alert: notify the orchestrator pane naming the target, log a structured
 * event for the flight recorder, and do NOT fire escalateFn (mirrors the
 * planner-failed precedent's reasoning). Phase exits to idle via the
 * no-action return (the caller's exitPhaseAfterPlan maps no-action to idle,
 * which also clears the stale plan_issue: makeSetPhaseFn omits planIssue when
 * called without it, and renderStateFile renders plan_issue: null).
 *
 * Extracted from runPostAuditAction to keep that function under biome's
 * noExcessiveLinesPerFunction(maxLines=80) limit (CAM-60 factory/helper
 * extraction pattern).
 */
function handlePlanTargetInvalid(
	targetId: string,
	notifyFn: ((msg: string) => void) | undefined,
	logEvent: WorkerEventLogger | undefined,
): PostAuditActionResult {
	notifyFn?.(
		`[cam] plan target invalid: ${targetId} could not be planned ` +
		'(missing, not open, not specified, or blocked)',
	);
	logEvent?.({
		ts: new Date().toISOString(),
		storyId: undefined,
		uuid: 'plan-target-invalid',
		kind: 'plan-target-invalid',
		detail: { targetId },
	});
	return { kind: 'no-action' };
}

/**
 * Handle the preflight-failed terminal (US-003, CAM-215): a plan-preflight
 * check failed before the planner was ever spawned (dirty tree, failing
 * typecheck, failing tests, etc; see plan-preflight.ts). Writes the durable
 * marker with the FULL untruncated detail (writePreflightFailedMarkerFn seam),
 * regardless of notifyFn's outcome -- the marker is the source of truth for a
 * recycled orchestrator, notifyFn is best-effort. Then pushes a one-line pane
 * narration (step then detail, detail truncated via truncatePreflightDetail,
 * mirroring the existing ship-stalled/plan-escalated pane-line format).
 *
 * Extracted from runPostAuditAction to keep that function under biome's
 * noExcessiveLinesPerFunction(maxLines=80) limit (CAM-60 factory/helper
 * extraction pattern), mirroring handlePlanTargetInvalid.
 */
function handlePreflightFailed(
	step: string,
	detail: string,
	notifyFn: ((msg: string) => void) | undefined,
	writePreflightFailedMarkerFn: ((params: PlanPreflightFailedWriterParams) => void) | undefined,
): PostAuditActionResult {
	writePreflightFailedMarkerFn?.({ step, detail });
	notifyFn?.(`[cam] plan preflight failed: ${step} - ${truncatePreflightDetail(detail)}`);
	return { kind: 'preflight-failed' };
}

/**
 * Handle the audit-approved terminal: decide pause-operator vs proceed-branch
 * (plan_approval config), gate on a missing/invalid issueNumber (US-001,
 * CAM-236, ADR-0016: replaces the old empty-branchName guard), and on
 * convergence execute the git calls via executeGitProceedBranch.
 *
 * Extracted from runPostAuditAction to keep that function under biome's
 * noExcessiveLinesPerFunction(maxLines=80) limit (CAM-60 factory/helper
 * extraction pattern), mirroring handlePlanTargetInvalid / handlePreflightFailed.
 */
function handleAuditApproved(
	issueNumber: unknown,
	spawnFn: SpawnFn,
	setPhaseFn: (phase: LoopPhase) => void,
	writePrdBranchNameFn: ((branchName: string) => void) | undefined,
	readPlanApprovalFn: () => PlanApproval,
	notifyFn: ((msg: string) => void) | undefined,
	removeEscalationMarkerFn: (() => void) | undefined,
): PostAuditActionResult {
	const action = decidePostAuditAction(readPlanApprovalFn());

	if (action.kind === 'pause-operator') {
		return { kind: 'awaiting-operator-approval' }; // AC2
	}

	// missing-issueNumber gate (US-001, CAM-236, ADR-0016): the branch name is
	// derived in code from prd.issueNumber, never trusted from the
	// planner-authored prd.branchName string. When issueNumber is null,
	// absent, or not a number, the plan is barred here: no git checkout is
	// spawned, no branch is created, no slug or ad-hoc fallback.
	const derivedBranchName = deriveBranchName(issueNumber);
	if (derivedBranchName === null) {
		notifyFn?.(
			'[cam] plan skipped: issueNumber is missing or not a number ' +
			'(prd.json absent, invalid, or issueNumber not a number)',
		);
		return { kind: 'no-action' };
	}

	// proceed-branch: convergence (US-004, CAM-204 AC4). Remove any stale
	// plan-escalation marker BEFORE creating the branch, so a prior round's
	// BLOCK escalation never outlives this fresh APPROVE.
	removeEscalationMarkerFn?.();

	// proceed-branch: create branch BEFORE committing prd.json (AC1, cam-plan.md Step 9)
	return executeGitProceedBranch(spawnFn, derivedBranchName, setPhaseFn, writePrdBranchNameFn);
}

/**
 * Best-effort remove the durable plan-preflight-failed marker for any
 * planResult kind other than 'preflight-failed' (US-004, CAM-215, Option B).
 * Not gated on convergence or issueId - see the field doc on
 * RunPostAuditOptions.removePreflightFailedMarkerFn.
 *
 * Extracted from runPostAuditAction to keep that function under biome's
 * noExcessiveLinesPerFunction(maxLines=80) limit (CAM-60 factory/helper
 * extraction pattern).
 */
function removePreflightMarkerUnlessPreflightFailed(
	kind: PlanPhaseResult['kind'],
	removePreflightFailedMarkerFn: (() => void) | undefined,
): void {
	if (kind !== 'preflight-failed') {
		removePreflightFailedMarkerFn?.();
	}
}

/**
 * Execute the post-audit action after runPlanPhase returns.
 *
 * On audit-approved + proceed-branch (auto mode):
 *   0. removeEscalationMarkerFn() (best-effort; US-004, CAM-204 AC4: a
 *      converging run removes any stale BLOCK escalation marker)
 *   1. git checkout -B <branchName>  (branch BEFORE commit - cam-plan.md Step 9;
 *      branchName is derived in code from prd.issueNumber via deriveBranchName,
 *      US-001, CAM-236, ADR-0016. -B recreates from current HEAD so re-planning
 *      the same issue is idempotent.)
 *   2. writePrdBranchNameFn(branchName) (best-effort; writes the derived name
 *      back into prd.json's branchName field BEFORE the commit, AC4)
 *   3. git add scripts/cam/prd.json
 *   4. git commit -m "chore(cam): commit audited prd.json"
 *   5. setPhaseFn('implementing')    (flip phase to implementing for sidecar loop)
 *   Returns { kind: 'branch-created', branchName }.
 *
 * On audit-approved + pause-operator (operator mode, Half A scope):
 *   Returns { kind: 'awaiting-operator-approval' }. No branch/commit/flip.
 *
 * On audit-blocked OR plan-escalated (US-004, CAM-204):
 *   Calls notifyFn (pane push) then fires escalateFn (best-effort, not awaited).
 *   Returns { kind: 'escalated' }. No branch/commit/flip. No re-plan here (the
 *   re-plan decision, and the durable marker write for plan-escalated, already
 *   happened inside runPlanPhaseWithReplan, CAM-151 / CAM-204).
 *
 * On preflight-failed (US-003, CAM-215):
 *   Writes the durable plan-preflight-failed marker (writePreflightFailedMarkerFn,
 *   full untruncated detail) then calls notifyFn with a truncated one-line
 *   narration. Returns { kind: 'preflight-failed' }. No branch/commit/flip.
 *
 * On ANY planResult whose kind is NOT preflight-failed (US-004, CAM-215,
 * Option B), before the branch dispatch below:
 *   Calls removePreflightFailedMarkerFn() (best-effort). Not gated on
 *   convergence or issueId - see the field doc on RunPostAuditOptions.
 *
 * On any other planResult kind:
 *   Returns { kind: 'no-action' }.
 *
 * Design: all git calls go through the injected spawnFn via executeGitProceedBranch;
 * exit-code guard fires a throw on non-zero exit (patterns.md US-R1-001).
 * escalateFn is fire-and-forget (void, never awaited) per its best-effort contract.
 */
export function runPostAuditAction(opts: RunPostAuditOptions): PostAuditActionResult {
	const {
		planResult,
		spawnFn,
		setPhaseFn,
		issueNumber,
		writePrdBranchNameFn,
		readPlanApprovalFn,
		escalateFn,
		notifyFn,
		removeEscalationMarkerFn,
		logEvent,
		writePreflightFailedMarkerFn,
		removePreflightFailedMarkerFn,
	} = opts;

	// US-004 (CAM-215, Option B): see removePreflightMarkerUnlessPreflightFailed.
	removePreflightMarkerUnlessPreflightFailed(planResult.kind, removePreflightFailedMarkerFn);

	// in-progress-conflict (US-004, CAM-241/153): the gate write already
	// flipped the phase to 'awaiting-operator' and pushed the one-line notify
	// (writeGateAndNotify, called from detectInProgressConflictFn's writer
	// seam BEFORE runPlanPhase ever returned this kind). Nothing further to do:
	// no notify/escalate/marker/phase-flip here, and exitPhaseAfterPlan (US-R1-002,
	// sidecar.ts) must leave the phase untouched for this kind (mirrors
	// 'branch-created').
	if (planResult.kind === 'in-progress-conflict') {
		return { kind: 'in-progress-conflict' };
	}

	// planner-failed: planner produced no prd.json; notify best-effort, no escalate
	// (US-003, CAM-155). Do NOT fire escalateFn: a transient planner no-op is not an
	// operator-alert condition. Phase exits to idle via the no-action return (AC2).
	if (planResult.kind === 'planner-failed') {
		notifyFn?.('[cam] plan failed: planner exited without writing prd.json');
		return { kind: 'no-action' };
	}

	// plan-target-invalid (US-003, CAM-203): see handlePlanTargetInvalid.
	if (planResult.kind === 'plan-target-invalid') {
		return handlePlanTargetInvalid(planResult.targetId, notifyFn, logEvent);
	}

	// audit-blocked: escalate and bail; no branch/commit/flip (AC3, AC4)
	if (planResult.kind === 'audit-blocked') {
		notifyFn?.(`[cam] plan BLOCK: ${planResult.report.summary}`);
		if (escalateFn !== undefined) {
			void escalateFn(); // best-effort: fire-and-forget, never throws by contract
		}
		return { kind: 'escalated' };
	}

	// plan-escalated (US-004, CAM-204): the BLOCK->re-plan loop (US-003)
	// exhausted MAX_REPLAN_ROUNDS without converging. The durable marker was
	// ALREADY written unconditionally by runPlanPhaseWithReplan's
	// writeEscalationMarkerFn seam BEFORE this function is ever invoked, so
	// its persistence never depends on notifyFn/escalateFn presence or
	// success (AC2). Here we only fire the best-effort pane push + email
	// escalation and exit to idle: same shape as the audit-blocked branch,
	// no branch/commit/flip, no further re-plan (that decision was already
	// made by the loop, ADR-0012 hard stop).
	if (planResult.kind === 'plan-escalated') {
		notifyFn?.(`[cam] plan escalated: ${planResult.report.summary}`);
		if (escalateFn !== undefined) {
			void escalateFn(); // best-effort: fire-and-forget, never throws by contract
		}
		return { kind: 'escalated' };
	}

	// preflight-failed (US-003, CAM-215): see handlePreflightFailed.
	if (planResult.kind === 'preflight-failed') {
		return handlePreflightFailed(planResult.step, planResult.detail, notifyFn, writePreflightFailedMarkerFn);
	}

	// Non-approved: nothing to do
	if (planResult.kind !== 'audit-approved') {
		return { kind: 'no-action' };
	}

	// audit-approved: see handleAuditApproved (AC1, AC2, AC4).
	return handleAuditApproved(
		issueNumber,
		spawnFn,
		setPhaseFn,
		writePrdBranchNameFn,
		readPlanApprovalFn,
		notifyFn,
		removeEscalationMarkerFn,
	);
}
