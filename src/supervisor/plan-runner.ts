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
import type { PlanVerdictReport } from './plan-verdict-report.ts';
import type { IssueEntry } from '../issues/types.ts';
import type { SpawnResolutionEvent } from '../logging/spawn-resolution.ts';
import type { PlanApproval, WorkerIsolation } from '../config/models.ts';
import type { LoopPhase } from '../commands/status.ts';
import type { PreflightResult } from './preflight-container.ts';
import { buildPlannerWorkerArgv, buildAuditorWorkerArgv } from './plan-argv.ts';
import { readPhaseModel, readBackend } from '../config/models.ts';
import { emitSpawnResolution } from '../logging/spawn-resolution.ts';
import { decidePostAuditAction } from '../plan/plan-approval-decision.ts';
import { dockerExecWrap } from './docker-exec.ts';

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
 *   planner-failed       - planner poll ended but readPlannerReportFn returned null (no
 *                          prd.json written); auditor is NEVER spawned (US-003, CAM-155).
 */
export type PlanPhaseResult =
	| { kind: 'preflight-failed'; step: string; detail: string }
	| { kind: 'no-plannable-issue' }
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
	const shell = buildPlannerWorkerArgv({ uuid, taskPrompt, permissionMode, model });
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
	const shell = buildAuditorWorkerArgv({ uuid, taskPrompt, permissionMode, model });
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
 * Resolve the live worker pane id.
 * Calls ensureWorkerPane() when available (self-heal, CAM-57); falls back to staticId.
 * Extracted to avoid code duplication for planner and auditor spawns.
 */
function resolveLivePaneId(ensureWorkerPane: (() => string) | undefined, staticId: string): string {
	return ensureWorkerPane !== undefined ? ensureWorkerPane() : staticId;
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
	} = opts;
	const permissionMode = opts.permissionMode ?? 'bypassPermissions';
	const auditorTaskPrompt = opts.auditorTaskPrompt ?? DEFAULT_AUDITOR_TASK_PROMPT;
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
	const { preflightFn, selectIssueFn, paneCountMutexFn, clearStalePlanArtifactsFn, logEvent } = opts;

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
	if (issue === null) return { kind: 'no-plannable-issue' };

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
 * Execute the three git calls for the proceed-branch path:
 *   checkout -b -> add prd.json -> commit -> setPhaseFn('implementing')
 *
 * Extracted from runPostAuditAction to keep that function under the biome
 * cognitive-complexity limit (US-004, CAM-155). All exit-code checks follow
 * the spawnSync exit-status guard pattern (patterns.md US-R1-001).
 */
function executeGitProceedBranch(
	spawnFn: SpawnFn,
	branchName: string,
	setPhaseFn: (phase: LoopPhase) => void,
): PostAuditActionResult {
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

	setPhaseFn('implementing');
	return { kind: 'branch-created', branchName };
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
 * Design: all git calls go through the injected spawnFn via executeGitProceedBranch;
 * exit-code guard fires a throw on non-zero exit (patterns.md US-R1-001).
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

	// planner-failed: planner produced no prd.json; notify best-effort, no escalate
	// (US-003, CAM-155). Do NOT fire escalateFn: a transient planner no-op is not an
	// operator-alert condition. Phase exits to idle via the no-action return (AC2).
	if (planResult.kind === 'planner-failed') {
		notifyFn?.('[cam] plan failed: planner exited without writing prd.json');
		return { kind: 'no-action' };
	}

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

	// empty-branch guard (US-004, CAM-155): a missing/invalid prd.json in the sidecar
	// yields branchName=''; running `git checkout -b ''` exits 128 and throws, detonating
	// the plan phase. Pre-check here so a missing PRD escalates cleanly to idle.
	if (branchName.trim() === '') {
		notifyFn?.('[cam] plan skipped: branchName is empty (prd.json absent or invalid)');
		return { kind: 'no-action' };
	}

	// proceed-branch: create branch BEFORE committing prd.json (AC1, cam-plan.md Step 9)
	return executeGitProceedBranch(spawnFn, branchName, setPhaseFn);
}
