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

import type { SpawnFn, IsPaneAlive } from './loop.ts';
import type { WorkerEventLogger } from './events.ts';
import type { PlanPreflightResult } from './plan-preflight.ts';
import type { PlanVerdictReport } from './plan-verdict-report.ts';
import type { IssueEntry } from '../issues/types.ts';
import type { SpawnResolutionEvent } from '../logging/spawn-resolution.ts';
import type { PlanApproval } from '../config/models.ts';
import type { LoopPhase } from '../commands/status.ts';
import { buildPlannerWorkerArgv, buildAuditorWorkerArgv } from './plan-argv.ts';
import { readPhaseModel, readBackend } from '../config/models.ts';
import { emitSpawnResolution } from '../logging/spawn-resolution.ts';
import { decidePostAuditAction } from '../plan/plan-approval-decision.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default planner task prompt (can be overridden via opts.plannerTaskPrompt). */
export const DEFAULT_PLANNER_TASK_PROMPT =
	'Plan the next issue from the backlog per your AGENT.md. Write the resulting PRD to scripts/cam/prd.json.';

/** Default auditor task prompt (can be overridden via opts.auditorTaskPrompt). */
export const DEFAULT_AUDITOR_TASK_PROMPT =
	'Audit the generated plan per your AGENT.md. Write your verdict to scripts/cam/plan-verdict-report.json.';

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
 */
export type PlanPhaseResult =
	| { kind: 'preflight-failed'; step: string; detail: string }
	| { kind: 'no-plannable-issue' }
	| { kind: 'mutex-busy' }
	| { kind: 'planner-timeout' }
	| { kind: 'auditor-timeout' }
	| { kind: 'audit-approved'; issue: IssueEntry; report: PlanVerdictReport }
	| { kind: 'audit-blocked'; issue: IssueEntry; report: PlanVerdictReport };

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
	 * selectPlannableFromFile (src/issues/select.ts); returns null when the
	 * backlog is empty or all issues are blocked/non-specified.
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
	 * Run the deterministic plan pre-flight checks. Returns PlanPreflightResult
	 * (same discriminated union as runPlanPreflight in plan-preflight.ts).
	 */
	preflightFn: () => PlanPreflightResult;

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

	/** Task prompt sent to the auditor. Defaults to DEFAULT_AUDITOR_TASK_PROMPT. */
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
 * set @cam_label on the pane, and spawn the planner worker via respawn-pane -k.
 *
 * @cam_label is set BEFORE respawn-pane (AC5, patterns.md '@cam_label pane-labeling').
 * genUuid() output is lowercased (CAM-23: macOS uuidgen is uppercase).
 * Returns the lowercased uuid (for the event log if needed).
 */
function resolveAndSpawnPlanner(
	spawnFn: SpawnFn,
	plannerPaneId: string,
	genUuid: () => string,
	taskPrompt: string,
	permissionMode: string,
	logEvent: WorkerEventLogger | undefined,
): string {
	const uuid = genUuid().toLowerCase();
	const model = readPhaseModel('planner');
	const backend = readBackend();
	emitSpawnResolution({ phase: 'planner', model, backend, writeEvent: makeEventWriter(logEvent, uuid) });
	const shell = buildPlannerWorkerArgv({ uuid, taskPrompt, permissionMode, model });
	spawnFn('tmux', ['-L', 'cam', 'set-option', '-p', '-t', plannerPaneId, '@cam_label', 'planner']);
	spawnFn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', plannerPaneId, shell]);
	return uuid;
}

/**
 * Resolve model/backend, emit spawn-resolution, build the argv shell string,
 * set @cam_label on the pane, and spawn the auditor worker via respawn-pane -k.
 *
 * @cam_label is set BEFORE respawn-pane (AC5, patterns.md '@cam_label pane-labeling').
 * genUuid() output is lowercased (CAM-23: macOS uuidgen is uppercase).
 * Returns the lowercased uuid.
 */
function resolveAndSpawnAuditor(
	spawnFn: SpawnFn,
	plannerPaneId: string,
	genUuid: () => string,
	taskPrompt: string,
	permissionMode: string,
	logEvent: WorkerEventLogger | undefined,
): string {
	const uuid = genUuid().toLowerCase();
	const model = readPhaseModel('auditor');
	const backend = readBackend();
	emitSpawnResolution({ phase: 'auditor', model, backend, writeEvent: makeEventWriter(logEvent, uuid) });
	const shell = buildAuditorWorkerArgv({ uuid, taskPrompt, permissionMode, model });
	spawnFn('tmux', ['-L', 'cam', 'set-option', '-p', '-t', plannerPaneId, '@cam_label', 'auditor']);
	spawnFn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', plannerPaneId, shell]);
	return uuid;
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
export function runPlanPhase(opts: RunPlanPhaseOptions): PlanPhaseResult {
	const {
		spawnFn, isPaneAlive, sleepFn, genUuid,
		selectIssueFn, readPlanVerdictFn, preflightFn, clock,
		plannerPaneId, paneCountMutexFn, readPlannerReportFn,
	} = opts;

	const permissionMode = opts.permissionMode ?? 'bypassPermissions';
	const plannerTaskPrompt = opts.plannerTaskPrompt ?? DEFAULT_PLANNER_TASK_PROMPT;
	const auditorTaskPrompt = opts.auditorTaskPrompt ?? DEFAULT_AUDITOR_TASK_PROMPT;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_PLAN_POLL_INTERVAL_MS;
	const plannerTimeoutMs = opts.plannerTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
	const auditorTimeoutMs = opts.auditorTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
	const logEvent = opts.logEvent;

	// Step 1: Pre-flight checks (AC2)
	const preflight = preflightFn();
	if (!preflight.ok) {
		return { kind: 'preflight-failed', step: preflight.step, detail: preflight.detail };
	}

	// Step 2: Pick plannable issue (AC3)
	const issue = selectIssueFn();
	if (issue === null) {
		return { kind: 'no-plannable-issue' };
	}

	// Step 3: Assert pane-count mutex (AC5)
	// Production wiring: () => paneCountMutex(sessionName, tmuxSpawnFn)
	if (paneCountMutexFn() === 'busy') {
		return { kind: 'mutex-busy' };
	}

	// Step 4: Spawn planner pane (AC4, AC5)
	// resolveAndSpawnPlanner: reads model/backend, emits spawn-resolution,
	// builds argv, sets @cam_label 'planner', runs respawn-pane -k.
	resolveAndSpawnPlanner(spawnFn, plannerPaneId, genUuid, plannerTaskPrompt, permissionMode, logEvent);

	// Step 5: Poll until prd.json written OR planner pane dies (AC4, US-R1-001).
	// readPlannerReportFn is the primary signal; isPaneAlive is the fallback.
	const plannerDied = pollPlannerDeath(
		isPaneAlive, sleepFn, clock, spawnFn,
		plannerPaneId, pollIntervalMs, plannerTimeoutMs, readPlannerReportFn,
	);
	if (!plannerDied) {
		return { kind: 'planner-timeout' };
	}

	// Step 6: Spawn auditor pane (AC4, AC5)
	// resolveAndSpawnAuditor: reads model/backend, emits spawn-resolution,
	// builds argv, sets @cam_label 'auditor', runs respawn-pane -k.
	resolveAndSpawnAuditor(spawnFn, plannerPaneId, genUuid, auditorTaskPrompt, permissionMode, logEvent);

	// Step 7: Poll until plan-verdict-report.json present (AC4)
	// Verdict read from FILE ONLY - never from capture-pane (patterns.md).
	const auditorResult = pollAuditorReport(
		isPaneAlive, sleepFn, clock, spawnFn,
		readPlanVerdictFn, plannerPaneId, pollIntervalMs, auditorTimeoutMs,
	);

	if (!auditorResult.ok) {
		return { kind: 'auditor-timeout' };
	}

	const report = auditorResult.report;
	if (report.verdict === 'APPROVE') {
		return { kind: 'audit-approved', issue, report };
	}
	return { kind: 'audit-blocked', issue, report };
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
 * escalated              - audit-blocked path: escalateFn + notifyFn called,
 *                          no branch/commit/flip.
 * no-action              - planResult was neither audit-approved nor
 *                          audit-blocked (e.g. preflight-failed, timeout).
 */
export type PostAuditActionResult =
	| { kind: 'branch-created'; branchName: string }
	| { kind: 'awaiting-operator-approval' }
	| { kind: 'escalated' }
	| { kind: 'no-action' };

/** Options for runPostAuditAction. All side effects are injected. */
export interface RunPostAuditOptions {
	/** Result from a prior runPlanPhase call. */
	planResult: PlanPhaseResult;
	/**
	 * Spawn a shell command (loop.ts SpawnFn shape).
	 * Used for git checkout -b, git add, git commit.
	 */
	spawnFn: SpawnFn;
	/**
	 * Writes phase:<value> to .claude/cam-loop.local.md so the sidecar loop
	 * picks up the correct phase. Called exactly once on the proceed-branch
	 * path with 'implementing' so the loop dispatches the implementer worker.
	 * Production: makeSetPhaseFn(claudeDir, cwd) in sidecar.ts.
	 */
	setPhaseFn: (phase: LoopPhase) => void;
	/** Feature branch name to create from current HEAD (from prd.branchName). */
	branchName: string;
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
}

/**
 * Execute the post-audit action after runPlanPhase returns.
 *
 * On audit-approved + proceed-branch (auto mode):
 *   1. git checkout -b <branchName>  (branch BEFORE commit - cam-plan.md Step 9)
 *   2. git add scripts/cam/prd.json
 *   3. git commit -m "chore(cam): commit audited prd.json"
 *   4. setPhaseFn('implementing')    (flip phase to implementing for sidecar loop)
 *   Returns { kind: 'branch-created', branchName }.
 *
 * On audit-approved + pause-operator (operator mode, Half A scope):
 *   Returns { kind: 'awaiting-operator-approval' }. No branch/commit/flip.
 *
 * On audit-blocked:
 *   Calls notifyFn (pane push) then fires escalateFn (best-effort, not awaited).
 *   Returns { kind: 'escalated' }. No branch/commit/flip. No re-plan (CAM-151).
 *
 * On any other planResult kind:
 *   Returns { kind: 'no-action' }.
 *
 * Design: all git calls go through the injected spawnFn; exit-code guard fires
 * a throw on non-zero exit (spawnSync exit-status guard, patterns.md US-R1-001).
 * escalateFn is fire-and-forget (void, never awaited) per its best-effort contract.
 */
export function runPostAuditAction(opts: RunPostAuditOptions): PostAuditActionResult {
	const {
		planResult,
		spawnFn,
		setPhaseFn,
		branchName,
		readPlanApprovalFn,
		escalateFn,
		notifyFn,
	} = opts;

	// audit-blocked: escalate and bail; no branch/commit/flip (AC3, AC4)
	if (planResult.kind === 'audit-blocked') {
		notifyFn?.(`[cam] plan BLOCK: ${planResult.report.summary}`);
		if (escalateFn !== undefined) {
			void escalateFn(); // best-effort: fire-and-forget, never throws by contract
		}
		return { kind: 'escalated' };
	}

	// Non-approved: nothing to do
	if (planResult.kind !== 'audit-approved') {
		return { kind: 'no-action' };
	}

	// audit-approved: decide based on plan_approval config (AC1, AC2, AC4)
	const action = decidePostAuditAction(readPlanApprovalFn());

	if (action.kind === 'pause-operator') {
		return { kind: 'awaiting-operator-approval' }; // AC2
	}

	// proceed-branch: create branch BEFORE committing prd.json (AC1, cam-plan.md Step 9)
	const checkoutResult = spawnFn('git', ['checkout', '-b', branchName]);
	if ((checkoutResult.exitCode ?? 1) !== 0) {
		throw new Error(
			`git checkout -b ${branchName} failed (exit ${checkoutResult.exitCode ?? 'null'})`,
		);
	}

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

	setPhaseFn('implementing'); // flip phase to implementing so the sidecar loop dispatches implementation (AC1)

	return { kind: 'branch-created', branchName }; // AC1
}
