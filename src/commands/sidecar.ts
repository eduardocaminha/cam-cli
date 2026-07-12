// src/commands/sidecar.ts
//
// Production caller for runSupervisor via the sidecar model (US-FIX-002).
//
// `cam sidecar` is an INTERNAL command spawned as a detached background process
// by `cam run`. It is not listed in `cam help` (there is no public user-facing
// use case) but it IS a real registered subcommand in index.ts so that
// `Bun.spawn(['cam', 'sidecar', ...])` works against the installed binary.
//
// Architecture (FLOW.md §4 + §9, sidecar model):
//   The sidecar:
//     1. Reads the `active` flag in .claude/cam-loop.local.md.
//     2. When active:false (or absent): idles (sleeps SIDECAR_IDLE_POLL_MS).
//     3. When active:true AND non-operator stories pending:
//        a. Acquires the supervisor lock (.claude/.cam-supervisor.lock).
//        b. Calls runSupervisor with the real-I/O options from host.ts.
//        c. On terminal: sets active:false (cam status shows 'paused').
//     4. Loops forever until killed by cam run's SIGINT/SIGTERM cleanup.
//
// All I/O is injectable via SidecarOptions for unit tests.

import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { runSidecarLoop, type RunSidecarLoopOptions, type SpawnFn as LoopSpawnFn, type IsPaneAlive } from '../supervisor/loop.ts';
import { FirewallError } from '../supervisor/container-firewall.ts';
import { ContainerConfigError } from '../supervisor/container-config.ts';
import { ToolchainMismatchError } from '../supervisor/toolchain-assert.ts';
import {
	buildSupervisorOptions,
	makeNotifyOrchestrator,
	makeReadReviewReport,
	makeCapturePaneFn,
	adaptLogEventForPush,
} from '../supervisor/host.ts';
import { extractSuggestions, dedupSuggestions, buildFollowUpIssue } from '../supervisor/suggestion-followups.ts';
import type { FollowUpProvenance } from '../supervisor/suggestion-followups.ts';
import type { ReviewFinding } from '../supervisor/review-report.ts';
import { readBacklogFromMain, numericIdSuffix, type BacklogSpawnFn } from '../issues/backlog.ts';
import { createLocalIssueOnMain, type SpawnFn as IssueFileSpawnFn } from './issue-file.ts';
import { resolveIssueId } from '../issues/resolve-id.ts';
import { parseToml } from '../config/toml.ts';
import { makeFileEventLogger, type WorkerEventLogger } from '../supervisor/events.ts';
import { parseStateFile, type LoopPhase } from './status.ts';
import { renderStateFile, writeStateFile } from './next.ts';
import { TERMINAL_VERDICTS, type PrdSnapshot } from '../supervisor/decide.ts';
import { hasSession, projectSessionName, getOrchPaneId, paneCountMutex, readWorkerPaneMarker, openPaneInSession, writeWorkerPaneMarker, type SpawnFn } from '../tmux/session.ts';
import { runPlanPhaseWithReplan, runPostAuditAction, type PlanPhaseResult, type PostAuditActionResult, type PlanEscalationWriterParams } from '../supervisor/plan-runner.ts';
import { writePlanEscalatedMarker, removePlanEscalatedMarker, PLAN_ESCALATED_FILENAME, type PlanEscalatedMarker } from '../supervisor/plan-escalation.ts';
import { writePlanPreflightFailedMarker, removePlanPreflightFailedMarker, PLAN_PREFLIGHT_FAILED_FILENAME, type PlanPreflightFailedMarker, type PlanPreflightFailedWriterParams } from '../supervisor/plan-preflight-marker.ts';
import { readImplementBlockedMarker, removeImplementBlockedMarker, IMPLEMENT_BLOCKED_FILENAME } from '../supervisor/implement-blocked-marker.ts';
import { writePostMergeStalledMarker, POST_MERGE_STALLED_FILENAME } from '../supervisor/post-merge-stalled-marker.ts';
import { writeSidecarStalledMarker, removeSidecarStalledMarker, SIDECAR_STALLED_FILENAME } from '../supervisor/sidecar-stalled.ts';
import { makeReadPlanVerdict, PLAN_VERDICT_REPORT_FILENAME } from '../supervisor/plan-verdict-report.ts';
import { runPlanPreflight, type PlanPreflightSpawnFn } from '../supervisor/plan-preflight.ts';
import { readMergeMode, readMetaLoop, readPlanApproval, readResendConfig, readWorkerIsolation, type WorkerIsolation } from '../config/models.ts';
import { makeProductionEnsureContainerFn } from '../supervisor/ensure-container.ts';
import { preflightWorkerContainer, type PreflightResult } from '../supervisor/preflight-container.ts';
import { sendEscalation, type ResendSendFn } from '../notify/resend.ts';
import {
	stepMergeWatch,
	readMergeWatchState,
	writeMergeWatchState,
	removeMergeWatchState,
	readShipStalledMarker,
	writeShipStalledMarker,
	removeShipStalledMarker,
	MERGE_WATCH_FILENAME,
	SHIP_STALLED_FILENAME,
	type GhPollFn,
	type GhPollResult,
	type PrStatus,
	type StepMergeWatchOptions,
	type UpdateBranchFn,
	type MergeWatchOutcome,
	type MergeWatchState,
} from '../release/merge-watch.ts';
import { runPostMerge, defaultCloseIssueFn, type SpawnFn as PostMergeSpawnFn } from '../release/post-merge.ts';
import { observeDecide, type ObserveState } from '../supervisor/observe.ts';
import { selectPlannableFromFile, selectPlanTargetFromFile } from '../issues/select.ts';
import { isDrainStopSet } from '../supervisor/drain-kill-switch.ts';
import { evaluateDrainPreconditions, type DrainPreconditionResult } from '../supervisor/drain-preconditions.ts';
import { evaluateRearmPreconditions } from '../supervisor/rearm-preconditions.ts';
import type { IssueEntry } from '../issues/types.ts';
import { runShipPhase, type ShipPhaseResult, type ShipPrdRecord, type ShipGatesResult, DEFAULT_GATES_COMMAND } from '../supervisor/ship-runner.ts';
import { runShipPrStep, type ShipPrSpawnFn, type RunShipPrStepOptions, type ShipPrStepInput } from '../release/ship-pr.ts';
import { finalizeCycleClose } from './ship-finalize.ts';
import { runShipBump } from '../release/ship-bump.ts';
import { buildShipFinalizeOpts, buildShipBumpOpts } from './ship-deps.ts';
import { REVIEW_ARTIFACT_FILENAME } from '../supervisor/review-report.ts';
import { writeSidecarSessionStart } from '../supervisor/session-start.ts';
import { printHint, printWarning } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SidecarOptions {
	/** Working directory (defaults to process.cwd()). */
	cwd?: string;
	/**
	 * Override the orphaned implement-blocked marker sweep (US-002, CAM-282).
	 * Production: sweepOrphanedImplementBlockedMarker(markerPath, cwd) --
	 * read-only on main, removes the marker only when its issueId is a
	 * closed/shipped issue. Tests inject a no-op / spy to avoid real git calls.
	 */
	sweepOrphanedImplementBlockedMarkerFn?: () => void;
	/**
	 * Override the readActive implementation.
	 * Reads the active flag from .claude/cam-loop.local.md.
	 * Tests inject a fake to control the gate.
	 */
	readActiveFn?: () => boolean | undefined;
	/**
	 * Override the clearActive implementation.
	 * Sets active:false in .claude/cam-loop.local.md.
	 * Tests inject a fake to assert it was called.
	 */
	clearActiveFn?: () => void;
	/**
	 * Override the hasPendingStories check.
	 * Tests inject a fake to control whether work exists.
	 */
	hasPendingStoriesFn?: () => boolean;
	/**
	 * Override the sleep function. Tests inject a no-op.
	 */
	sleepFn?: (ms: number) => void;
	/**
	 * Override the supervisor lock acquisition. Tests inject a fake.
	 */
	acquireLockFn?: () => { acquired: true; release: () => void } | { acquired: false; holderPid: number };
	/**
	 * Override the runSupervisor call. Tests inject a fake.
	 */
	runSupervisorFn?: RunSidecarLoopOptions['runSupervisorFn'];
	/**
	 * Override the buildOpts call. Tests inject a fake.
	 */
	buildOptsFn?: RunSidecarLoopOptions['buildOpts'];
	/**
	 * Override the hasSession check used for sidecar self-exit.
	 * Production: closure over hasSession(projectSessionName(cwd), spawnFn).
	 * Tests inject a fake to avoid spawning real tmux.
	 */
	hasSessionFn?: () => boolean;
	/**
	 * Override the event logger used to record sidecar lifecycle events.
	 * Production: makeFileEventLogger('.claude/cam-worker-events.jsonl').
	 * Tests inject makeInMemoryEventLogger().logger to capture events in memory.
	 */
	logEventFn?: WorkerEventLogger;
	/**
	 * Override the flipActiveFn (US-005).
	 *
	 * Production (auto mode): writes active:true to .claude/cam-loop.local.md
	 * so the sidecar re-triggers after a supervisor run without a human cam-next.
	 * Production (operator mode): undefined (inert, zero behavior change).
	 * Tests inject a spy to assert the flip happened.
	 */
	flipActiveFn?: RunSidecarLoopOptions['flipActiveFn'];
	/**
	 * Override the readImplementBlockedMarkerFn (US-003, CAM-214).
	 *
	 * Production (auto mode): closure over
	 * readImplementBlockedMarker(join(claudeDir, IMPLEMENT_BLOCKED_FILENAME)),
	 * consulted by the loop.ts auto-chain immediately before flipActiveFn; when
	 * the marker is escalated:true the circuit breaker skips the re-dispatch.
	 * Production (operator mode): undefined (inert, zero behavior change,
	 * mirrors flipActiveFn's own auto-mode gate).
	 * Tests inject a fake to control the marker without touching disk.
	 */
	readImplementBlockedMarkerFn?: RunSidecarLoopOptions['readImplementBlockedMarkerFn'];
	/**
	 * Override the autoShipFn (US-005, deterministic since US-004 CAM-149).
	 *
	 * Production (auto mode): writes phase:shipping to .claude/cam-loop.local.md
	 * (setPhase('shipping')) so the sidecar's shipping branch runs the
	 * deterministic ship runner without a human gate after a CLEAN review
	 * verdict. No tmux send-keys dispatch of a slash command is involved.
	 * Production (operator mode): undefined (inert, zero behavior change).
	 * Tests inject a spy to assert the dispatch happened.
	 */
	autoShipFn?: RunSidecarLoopOptions['autoShipFn'];
	/**
	 * Override the readReviewReportFn (US-003, CAM-189).
	 *
	 * Production: makeReadReviewReport(cwd) (host.ts) — reads
	 * scripts/cam/review-report.json. Paired with fileSuggestionsFn below to
	 * drive the terminal SUGGESTION-follow-up-filing hook.
	 * Tests: inject a fake to control the report contents without touching disk.
	 */
	readReviewReportFn?: RunSidecarLoopOptions['readReviewReportFn'];
	/**
	 * Override the fileSuggestionsFn (US-003, CAM-189).
	 *
	 * Production: makeProductionFileSuggestionsFn(cwd, logEvent) — dedups the
	 * report's SUGGESTION findings against the open backlog (readBacklogFromMain
	 * + dedupSuggestions) and files each survivor via createLocalIssueOnMain.
	 * Tests: inject a spy to assert filing without spawning real git.
	 */
	fileSuggestionsFn?: RunSidecarLoopOptions['fileSuggestionsFn'];
	/**
	 * Override the merge-watch function (US-007).
	 *
	 * Production (ci-gated mode): reads .claude/.cam-merge-watch.json, advances
	 * the poll state one step via stepMergeWatch, narrates via notifyOrchestrator.
	 * Production (immediate mode): undefined (inert, zero behavior change).
	 * Tests: inject a fake to drive MERGED / CI-red paths without real gh calls.
	 *
	 * When absent and merge mode is ci-gated, the production runSidecar builds
	 * the real implementation automatically.
	 */
	runMergeWatchFn?: RunSidecarLoopOptions['runMergeWatchFn'];
	/**
	 * Override the escalateFn (US-R1-001).
	 *
	 * Production: reads RESEND_API_KEY env var + resend_recipient from
	 * [notify] project.toml and builds a sendEscalation closure. Absent when
	 * Resend is unconfigured (both values must be non-empty).
	 * Tests: inject a spy to assert the escalation was dispatched without a
	 * real network hit.
	 */
	escalateFn?: RunSidecarLoopOptions['escalateFn'];
	/**
	 * Override the meta-loop observe/dispatch function (US-004/US-005, CAM-132/CAM-139).
	 *
	 * Production (meta_loop=observe): calls selectPlannableFromFile on the MAIN backlog,
	 * runs observeDecide with in-memory dedup state, emits 'meta-loop-observe' events.
	 * Production (meta_loop=auto): built by makeProductionMetaLoopDispatchFn; checks
	 * the kill-switch (US-002), evaluates drain preconditions (US-003), confirms safe-boundary
	 * guards, and dispatches phase:planning for the selected issue.
	 * Production (meta_loop=off, default): undefined (inert, zero behavior change).
	 * Tests: inject a spy or call makeProductionMetaLoopDispatchFn with fake deps to
	 * assert observe+dispatch+drain+refuse+kill branches without real fs/Docker/tmux.
	 */
	runMetaLoopObserveFn?: RunSidecarLoopOptions['runMetaLoopObserveFn'];
	/**
	 * Override the loop-phase reader (US-002, CAM-151).
	 *
	 * Production: makeReadLoopPhase(claudeDir) — reads phase from cam-loop.local.md.
	 * Tests: inject a controlled sequence or constant-returning closure.
	 */
	readLoopPhaseFn?: RunSidecarLoopOptions['readLoopPhaseFn'];
	/**
	 * Override the plan-phase runner (US-002, CAM-151).
	 *
	 * Production: makeProductionPlanPhaseFn closure over runPlanPhase with all
	 * deps wired (plannerPaneId, paneCountMutexFn, selectIssueFn, preflightFn,
	 * spawnFn, isPaneAlive, sleepFn, genUuid, clock).
	 * Tests: inject a spy to assert call count without spawning real tmux panes.
	 */
	runPlanPhaseFn?: RunSidecarLoopOptions['runPlanPhaseFn'];
	/**
	 * Override the ship-phase runner (US-004, CAM-149).
	 *
	 * Production: makeProductionShipPhaseFn closure over runShipPhase with all
	 * deps wired (spawnFn, the bun run check:all gates adapter, the shared
	 * buildShipBumpOpts/buildShipFinalizeOpts factories, runShipPrStep). ALWAYS
	 * resets phase to idle when the run ends, success or failure.
	 * Tests: inject a spy to assert call count / crash-survival without
	 * spawning real git/gh processes.
	 */
	runShipPhaseFn?: RunSidecarLoopOptions['runShipPhaseFn'];
	/**
	 * Override the implementing re-arm function (US-003, CAM-195, Defect 1).
	 *
	 * Production: makeProductionRearmImplementingFn(claudeDir, cwd, ...) —
	 * fail-closed via evaluateRearmPreconditions, gated on hasPendingStories()
	 * (already excludes the MAX_ROUNDS_DEBT blocked terminal), phase==='implementing',
	 * and no pending merge-watch marker. Wired UNCONDITIONALLY (regardless of
	 * meta_loop/plan_approval config): resuming an ALREADY-in-flight PRD is a
	 * resilience fix, not an autonomy escalation.
	 * Tests: inject a spy to assert call count / return value without touching disk.
	 */
	rearmImplementingFn?: RunSidecarLoopOptions['rearmImplementingFn'];
	/**
	 * Override the ensure-container function (US-003, CAM-150).
	 *
	 * Production (container mode): built via makeProductionEnsureContainerFn,
	 * calls ensureWorkerContainer with spawnSync-backed deps at sidecar boot.
	 * Production (host mode): not called (zero docker invocations).
	 * Tests: inject a spy to assert the call happened without real docker.
	 */
	ensureContainerFn?: () => void;
	/**
	 * Override the runSidecarLoop call (US-001, CAM-176).
	 *
	 * Production: calls the real runSidecarLoop from supervisor/loop.ts.
	 * Tests: inject a spy to assert fail-closed behaviour: when ensureContainerFn
	 * throws FirewallError, this spy must never be called.
	 */
	runSidecarLoopFn?: (opts: RunSidecarLoopOptions) => Promise<void>;
	/**
	 * Override the session-start recorder (US-001, PR-83, dashboard
	 * total-session elapsed).
	 *
	 * Production: writes `.claude/.cam-sidecar-session.json` once, before the
	 * poll loop starts, via `writeSidecarSessionStart`. The supervisor lock's
	 * `startedAt` resets on every active cycle (see session-start.ts header),
	 * so this dedicated once-per-process record is what the dashboard reads
	 * for the "session" elapsed row.
	 * Tests: inject a spy to assert it fires exactly once per runSidecar call,
	 * regardless of how many active/idle cycles the injected loop simulates.
	 */
	writeSessionStartFn?: (claudeDir: string) => void;
}

// ---------------------------------------------------------------------------
// Active-flag helpers (real implementations)
// ---------------------------------------------------------------------------

/**
 * Read the `active` flag from .claude/cam-loop.local.md.
 * Returns the DERIVED active value: `phase === 'implementing'` when phase is
 * present (US-001 invariant). Falls back to the raw `active:` field for legacy
 * state files that predate the phase field.
 * Returns undefined when the file is absent, unparseable, or the active field
 * is not present. The sidecar treats undefined as false (idle).
 *
 * Exported for testability (AC1, US-002).
 */
export function makeReadActive(claudeDir: string): () => boolean | undefined {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return () => {
		try {
			if (!existsSync(stateFilePath)) return undefined;
			const contents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(contents);
			if (parsed === null) return undefined;
			return parsed.active;
		} catch {
			return undefined;
		}
	};
}

/**
 * Read the current loop phase from .claude/cam-loop.local.md (US-002, CAM-151).
 * Returns undefined when the file is absent, unparseable, or has no phase field.
 *
 * Exported for testability (AC1, US-002).
 */
export function makeReadLoopPhase(claudeDir: string): () => LoopPhase | undefined {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return () => {
		try {
			if (!existsSync(stateFilePath)) return undefined;
			const contents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(contents);
			return parsed?.phase;
		} catch {
			return undefined;
		}
	};
}

/**
 * Read plan_issue from .claude/cam-loop.local.md (US-001, CAM-154).
 * Returns the plan_issue string when present and non-empty; undefined when the
 * file is absent, unparseable, or has no plan_issue field.
 *
 * Exported for testability (AC4, US-001).
 */
export function makeReadPlanIssue(claudeDir: string): () => string | undefined {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return () => {
		try {
			if (!existsSync(stateFilePath)) return undefined;
			const contents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(contents);
			return parsed?.plan_issue ?? undefined;
		} catch {
			return undefined;
		}
	};
}

/**
 * Clear the loop's active trigger in .claude/cam-loop.local.md by overwriting
 * the frontmatter. Reads the existing state to preserve other fields; falls
 * back to a minimal write if the file is absent or unparseable. Best-effort:
 * a failure here is non-fatal (the loop will just re-check on the next poll).
 *
 * Phase-preserving (US-001, CAM-195, Defect 3 fix): `phase` is deliberately
 * left absent on every renderStateFile call below and `cwd` is passed instead,
 * so renderStateFile's read-modify-write derives `phase` (and therefore
 * `active`) from whatever is CURRENTLY on disk, rather than collapsing it to
 * `idle`. This is what makes `phase:idle` a trustworthy "nothing is running"
 * signal: a terminal tick that already wrote e.g. `phase:shipping` survives
 * this call unchanged, while a genuinely idle/nonexistent/unparseable file
 * still defaults to `idle` (same fallback renderStateFile always had).
 */
export function makeClearActive(claudeDir: string, cwd: string): () => void {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return () => {
		try {
			if (!existsSync(stateFilePath)) {
				// No file to preserve a phase from: renders phase:idle (RMW default).
				const body = renderStateFile({
					maxIterations: 50,
					completionPromise: 'COMPLETE',
					startedAt: new Date().toISOString(),
					pid: process.pid,
					cwd,
				});
				writeStateFile(cwd, body, { force: true });
				return;
			}
			const contents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(contents);
			if (parsed === null) {
				// Unparseable: write fresh minimal state (RMW defaults to phase:idle).
				const body = renderStateFile({
					maxIterations: 50,
					completionPromise: 'COMPLETE',
					startedAt: new Date().toISOString(),
					pid: process.pid,
					cwd,
				});
				writeFileSync(stateFilePath, body, 'utf8');
				return;
			}
			const body = renderStateFile({
				maxIterations: parsed.max_iterations ?? 50,
				completionPromise: parsed.completion_promise ?? 'COMPLETE',
				startedAt: parsed.started_at ?? new Date().toISOString(),
				pid: parsed.pid ?? process.pid,
				iteration: parsed.iteration,
				currentStory: parsed.current_story,
				storiesDone: parsed.stories_done,
				storiesTotal: parsed.stories_total,
				lastActivity: parsed.last_activity ?? new Date().toISOString(),
				cwd,
			});
			writeFileSync(stateFilePath, body, 'utf8');
		} catch {
			// Non-fatal.
		}
	};
}

/**
 * Check whether there is pending work in prd.json.
 *
 * Returns true when:
 *   (a) at least one non-operator story has passes !== true, OR
 *   (b) all non-operator stories pass but the review verdict is non-terminal
 *       (absent, null, or any value not in TERMINAL_VERDICTS from decide.ts).
 *
 * Returns false only when all non-operator stories pass AND the review verdict
 * is terminal ('CLEAN' or 'MAX_ROUNDS_DEBT').
 *
 * Exported so unit tests can import it directly.
 */
export function makeHasPendingStories(prdPath: string): () => boolean {
	return () => {
		try {
			const raw = readFileSync(prdPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object') return false;
			const prd = parsed as PrdSnapshot;
			const stories = prd.userStories ?? [];
			// US-008 guard: MAX_ROUNDS_DEBT is the non-convergence terminal. At this
			// state no further implement should be dispatched, regardless of any
			// passes:false stories (orphan fix stories left before the terminal was
			// detected). Return false so the auto-chain does not re-trigger the loop.
			// Note: CLEAN is NOT guarded here — CLEAN + pending stories is a valid
			// scenario (e.g. review passed but the operator added a new story). Only
			// MAX_ROUNDS_DEBT means "the pipeline is exhausted, stop everything."
			const currentVerdict = prd.review?.lastVerdict ?? null;
			if (currentVerdict === 'MAX_ROUNDS_DEBT') {
				return false;
			}
			// Case (a): at least one implementable story is still pending.
			if (stories.some((s) => s.passes !== true && s.requires !== 'operator')) {
				return true;
			}
			// Case (b): all non-operator stories pass — gate on review verdict.
			// Return true when the verdict is absent/null (review not yet run) or
			// non-terminal (e.g. FIXES_PENDING:*), so the sidecar triggers review.
			const verdict = prd.review?.lastVerdict;
			return verdict == null || !TERMINAL_VERDICTS.has(verdict);
		} catch {
			return false;
		}
	};
}

/**
 * Build the production rearmImplementingFn (US-003, CAM-195, Defect 1).
 *
 * Called on every idle tick (active !== true) BEFORE runMergeWatchFn /
 * runMetaLoopObserveFn (see loop.ts's `active !== true` branch): this outer
 * loop has no separate boot preamble, so the FIRST idle tick after process
 * start already covers "at sidecar boot" (AC1); every subsequent tick covers
 * "at the idle-tick".
 *
 * Evaluates evaluateRearmPreconditions fail-closed:
 *   - prdInFlight: hasPendingStoriesFn() (already excludes the MAX_ROUNDS_DEBT
 *     blocked terminal — see the CAM-109 guard above — so "no blocked
 *     terminal" falls out of reusing this seam rather than a separate check).
 *   - phase==='implementing': the parked discriminator; phase:idle (or any
 *     other phase) never resumes (AC2). LoopPhase is a mutually-exclusive
 *     enum, so this one check also covers "no plan/ship phase in progress".
 *   - no pending merge-watch marker file.
 *
 * When the decision is `{ rearm: true }`, writes phase:implementing via
 * makeSetPhaseFn -- the same write flipActiveFn uses for the auto-chain (it
 * derives active:true, see renderStateFile) -- but wired UNCONDITIONALLY
 * (regardless of meta_loop/plan_approval config): resuming an ALREADY-in-flight
 * PRD is a general sidecar resilience fix, not an autonomy escalation gated to
 * auto/container mode like evaluateDrainPreconditions (drain-preconditions.ts).
 *
 * Returns true when it re-armed this tick (the caller should skip the rest of
 * the idle branch and let the next tick pick up active:true), false otherwise.
 *
 * US-005 (CAM-195, Defect 2): re-arming IS "the next implement dispatch for
 * that issue" (AC2) -- so a rearm also clears the durable implement-blocked
 * marker via clearImplementBlockedMarkerForCurrentIssue, keyed on the
 * CURRENT prd.json's issueNumber.
 */
export function makeProductionRearmImplementingFn(
	claudeDir: string,
	cwd: string,
	hasPendingStoriesFn: () => boolean,
	readLoopPhaseFn: () => LoopPhase | undefined,
): () => boolean {
	const setPhase = makeSetPhaseFn(claudeDir, cwd);
	const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
	const prdPath = join(cwd, 'scripts/cam/prd.json');
	return (): boolean => {
		const decision = evaluateRearmPreconditions({
			phase: readLoopPhaseFn(),
			prdInFlight: hasPendingStoriesFn(),
			mergeWatchPresent: existsSync(join(claudeDir, MERGE_WATCH_FILENAME)),
		});
		if (!decision.rearm) return false;
		setPhase('implementing');
		clearImplementBlockedMarkerForCurrentIssue(markerPath, prdPath);
		return true;
	};
}

/**
 * Clear the durable implement-blocked marker when it references the CURRENT
 * PRD's issue (US-005, CAM-195, Defect 2).
 *
 * Removes the marker only when:
 *   - it can be read (readImplementBlockedMarker returns non-null), AND
 *   - either the current prd.json's issueNumber cannot be determined
 *     (missing / unreadable prd.json: best-effort, nothing to compare
 *     against), OR it matches the marker's issueId (stringified).
 *
 * A marker referencing a DIFFERENT issueId is left untouched (mirrors the
 * "caller's responsibility to check issueId match first" contract documented
 * on removeShipStalledMarker / removePlanEscalatedMarker). Never throws: the
 * prd.json read is try/catch best-effort and removeImplementBlockedMarker
 * itself never throws.
 */
export function clearImplementBlockedMarkerForCurrentIssue(markerPath: string, prdPath: string): void {
	const marker = readImplementBlockedMarker(markerPath);
	if (marker === null) return;
	let issueNumber: unknown;
	try {
		const prdRaw = JSON.parse(readFileSync(prdPath, 'utf8')) as { issueNumber?: unknown };
		issueNumber = prdRaw.issueNumber;
	} catch {
		// best-effort: prd.json unreadable, fall through and clear unconditionally
	}
	if (typeof issueNumber === 'number' && String(issueNumber) !== marker.issueId) return;
	removeImplementBlockedMarker(markerPath);
}

/**
 * Sweep an ORPHANED implement-blocked marker whose issueId is a
 * closed/shipped issue (US-002, CAM-282).
 *
 * Complements clearImplementBlockedMarkerForCurrentIssue (which clears the
 * marker only when it matches the CURRENT in-flight prd.json issue, on
 * re-arm). This sweep instead answers "has the issue this marker references
 * already shipped or been abandoned, regardless of what the current PRD is
 * targeting" -- catching the case where the operator moved on to a new issue
 * entirely (no re-arm of the SAME issue ever happens) and the stale marker
 * would otherwise linger forever, misleading the boot-surface and the
 * auto-chain circuit-breaker read (loop.ts:2194).
 *
 * Read-only on main: looks the marker's issueId up in readBacklogFromMain
 * (git ls-tree/cat-file, never checks out, pulls, or stages anything) by
 * matching marker.issueId (the stringified numeric issueNumber, no prefix)
 * against each backlog entry's numericIdSuffix(entry.id).
 *
 * Removes the marker when a matching backlog entry is found AND it is
 * closed/shipped (stage === 'shipped' OR status === 'abandoned'). Leaves the
 * marker untouched when: no marker is present, no matching entry is found
 * (best-effort -- can't determine, so don't guess), or the matching entry is
 * still open/in-flight.
 *
 * Never throws: readImplementBlockedMarker / removeImplementBlockedMarker
 * already never throw, and readBacklogFromMain's git calls are non-fatal by
 * construction (empty results on failure).
 */
export function sweepOrphanedImplementBlockedMarker(
	markerPath: string,
	cwd: string,
	spawn?: BacklogSpawnFn,
): void {
	const marker = readImplementBlockedMarker(markerPath);
	if (marker === null) return;

	const targetId = Number(marker.issueId);
	if (Number.isNaN(targetId)) return;

	const entries = spawn !== undefined ? readBacklogFromMain(cwd, spawn) : readBacklogFromMain(cwd);
	const match = entries.find((entry) => numericIdSuffix(entry.id) === targetId);
	if (match === undefined) return;

	if (match.stage === 'shipped' || match.status === 'abandoned') {
		removeImplementBlockedMarker(markerPath);
	}
}

// ---------------------------------------------------------------------------
// Merge-watch production factory (extracted to keep runSidecar under
// complexity/line limits; CAM-60 factory/helper pattern)
// ---------------------------------------------------------------------------

/**
 * Null-state GC for the merge-watch file.
 *
 * Called by makeProductionMergeWatchFn when readMergeWatchState returns null
 * (file present but no valid watch state). Discriminates between a valid
 * issueId-only seed (pre-PR stash written by stashIssueIdInMergeWatch) and
 * real garbage.
 *
 * Preserves: a JSON object whose `issueId` is a string and whose `prNumber`
 * is NOT a number. This is the seed cam-ship --finalize writes before
 * gh pr create; the cam-ship enrich step later adds prNumber + mergedBranch.
 *
 * Deletes: malformed JSON, a non-object or array value, or an object with
 * neither an `issueId` string nor a numeric `prNumber`.
 *
 * Exported so tests can drive the real GC code path against a temp file
 * (AC4 anti-shadow-mock regression).
 *
 * Never throws.
 */
export function gcMergeWatchIfGarbage(filePath: string): void {
	if (!existsSync(filePath)) return;
	try {
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			!Array.isArray(parsed)
		) {
			const obj = parsed as Record<string, unknown>;
			if (typeof obj['issueId'] === 'string' && typeof obj['prNumber'] !== 'number') {
				// Valid issueId-only seed: preserve it.
				return;
			}
		}
	} catch {
		// Malformed JSON: fall through to delete.
	}
	// Real garbage: delete.
	try { unlinkSync(filePath); } catch { /* best-effort */ }
}

/**
 * Reconcile the durable ship-stalled marker against a terminal merge-watch
 * outcome (US-002, CAM-182).
 *
 * MERGED: removes the marker ONLY when it references the SAME prNumber (a
 * marker for a different, still-stalled PR is left intact).
 * Any non-merged terminal (behind-unrecovered, dirty, ci-red,
 * closed-not-merged, timeout): writes/refreshes the marker with the outcome's
 * reason, prUrl (when the outcome variant carries one), and the watch's
 * issueId.
 */
export function updateShipStalledMarker(
	markerPath: string,
	outcome: MergeWatchOutcome,
	state: MergeWatchState,
): void {
	if (outcome.kind === 'merged') {
		const existing = readShipStalledMarker(markerPath);
		if (existing !== null && existing.prNumber === state.prNumber) {
			removeShipStalledMarker(markerPath);
		}
		return;
	}
	writeShipStalledMarker(markerPath, {
		prNumber: state.prNumber,
		prUrl: 'prUrl' in outcome ? (outcome.prUrl ?? null) : null,
		issueId: state.issueId ?? null,
		reason: outcome.kind,
		ts: new Date().toISOString(),
	});
}

/**
 * Write the durable post-merge-stalled marker when a MERGED terminal's inner
 * post-merge sequence failed (US-003, CAM-174).
 *
 * Only acts when outcome.kind === 'merged' AND outcome.postMerge.ok === false:
 * the PR really did merge (the 'merged' classification is untouched), but the
 * post-merge sequence (checkout/rebase/tag/prune/close) stalled partway
 * through, so this persists exactly where it stopped
 * (completedSteps/remainingSteps/reason from the failed PostMergeOutcome)
 * plus prNumber/issueId from the merge-watch state.
 *
 * A no-op for every non-merged terminal (those stay owned exclusively by
 * updateShipStalledMarker) and for a merged outcome whose post-merge
 * succeeded (ok:true; nothing stalled, so no marker is written).
 */
export function updatePostMergeStalledMarker(
	markerPath: string,
	outcome: MergeWatchOutcome,
	state: MergeWatchState,
): void {
	if (outcome.kind !== 'merged' || outcome.postMerge.ok) return;
	writePostMergeStalledMarker(markerPath, {
		prNumber: state.prNumber,
		issueId: state.issueId ?? null,
		completedSteps: outcome.postMerge.completedSteps,
		remainingSteps: outcome.postMerge.remainingSteps,
		reason: outcome.postMerge.reason,
		writtenAt: new Date().toISOString(),
	});
}

/**
 * Parse a `gh pr view` spawnSync result into a discriminated GhPollResult
 * (US-001, CAM-170): ok:true with the parsed PrStatus on a zero exit with
 * well-shaped JSON, ok:false carrying the gh stderr (or a synthesized message
 * when stderr is empty) on a non-zero exit or a JSON-parse/shape failure.
 *
 * Extracted from ghPollFn to keep it under the biome complexity/line limits
 * (CAM-60 factory/helper pattern).
 */
function parseGhPollResult(result: SpawnSyncReturns<string>): GhPollResult {
	if ((result.status ?? 1) !== 0) {
		const stderr = result.stderr && result.stderr.trim().length > 0
			? result.stderr.trim()
			: `gh pr view exited with status ${result.status ?? 'unknown'}`;
		return { ok: false, stderr };
	}
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { ok: true, status: parsed as PrStatus };
		}
		return { ok: false, stderr: 'gh pr view returned unexpected JSON shape' };
	} catch {
		const stderr = result.stderr && result.stderr.trim().length > 0
			? result.stderr.trim()
			: 'gh pr view returned malformed JSON';
		return { ok: false, stderr };
	}
}

/**
 * Build the production runMergeWatchFn closure for ci-gated ship mode.
 *
 * This factory is called by runSidecar when merge_mode == "ci-gated".
 * It is NOT exported: tests inject `options.runMergeWatchFn` directly.
 */
function makeProductionMergeWatchFn(
	cwd: string,
	claudeDir: string,
	sessionName: string,
	logEvent: WorkerEventLogger,
	realSpawnFn: SpawnFn,
): () => Promise<void> {
	return async (): Promise<void> => {
		const watchFilePath = join(claudeDir, MERGE_WATCH_FILENAME);

		// Read durable state via US-002 helper. Returns null when the file is
		// absent or contains malformed JSON (never throws).
		const state = readMergeWatchState(watchFilePath);
		if (state === null) {
			// Absent: no watch pending.
			// File present but readMergeWatchState returned null: discriminate a
			// valid issueId-only seed (pre-PR stash) from real garbage.
			// gcMergeWatchIfGarbage preserves the seed and deletes only real garbage.
			gcMergeWatchIfGarbage(watchFilePath);
			return;
		}

		const ghPollFn: GhPollFn = (prNumber): GhPollResult => {
			// Read-only poll: keeps the ambient GITHUB_TOKEN (no env stripping).
			const result = spawnSync(
				'gh',
				['pr', 'view', String(prNumber), '--json', 'state,mergeStateStatus,statusCheckRollup,autoMergeRequest,url'],
				{ encoding: 'utf8' },
			);
			return parseGhPollResult(result);
		};

		// Mutation: `gh pr update-branch` runs with GITHUB_TOKEN stripped from the
		// child environment so gh falls back to its keyring OAuth token (same
		// pattern as gh pr create/merge/comment -- the .env GITHUB_TOKEN
		// fine-grained PAT lacks "Pull requests: write").
		const updateBranchFn: UpdateBranchFn = (prNumber): void => {
			const env: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) {
				if (v !== undefined && k !== 'GITHUB_TOKEN') env[k] = v;
			}
			spawnSync('gh', ['pr', 'update-branch', String(prNumber)], { encoding: 'utf8', env });
		};

		const postMergeSpawnFn: PostMergeSpawnFn = (cmd, args, spawnOpts) =>
			spawnSync(cmd, args, spawnOpts as Parameters<typeof spawnSync>[2]) as SpawnSyncReturns<string>;

		// US-003 (CAM-200): thread the capture-pane reader + logEvent deps
		// sendKeysVerified needs (idle-gate + composer-emptied verify + bounded
		// retry, 'push-undelivered' on exhaustion).
		const notify = makeNotifyOrchestrator(
			sessionName,
			realSpawnFn,
			makeCapturePaneFn(realSpawnFn),
			adaptLogEventForPush(logEvent),
		);

		// Build step options (scheduling and persistence owned by this caller).
		const stepOpts: StepMergeWatchOptions = {
			cwd,
			postMergeFn: ({ cwd: mergeCwd, mergedBranch }) =>
				runPostMerge({ cwd: mergeCwd, mergedBranch, spawnFn: postMergeSpawnFn, closeIssueId: state.issueId }),
			notifyOrchestrator: notify,
			logEvent: (kind, detail) =>
				logEvent({ ts: new Date().toISOString(), storyId: undefined, uuid: 'sidecar', kind, detail }),
			updateBranchFn,
		};

		// One step per tick. The outer sidecar loop owns the 2s idle-poll cadence;
		// the 60s gh-poll throttle is enforced inside stepMergeWatch via lastPolledAt.
		const result = stepMergeWatch(state, Date.now(), ghPollFn, stepOpts);

		if (result.kind === 'continue') {
			// Non-terminal: persist updated state (pollCount, lastPolledAt) so the
			// watch survives a sidecar restart.
			writeMergeWatchState(watchFilePath, result.state);
		} else {
			// Terminal outcome (merged | closed-not-merged | ci-red | timeout |
			// behind-unrecovered | dirty): remove the state file so idle ticks
			// become no-ops, then reconcile the durable ship-stalled marker
			// (US-002, CAM-182).
			removeMergeWatchState(watchFilePath);
			updateShipStalledMarker(join(claudeDir, SHIP_STALLED_FILENAME), result.outcome, state);
			updatePostMergeStalledMarker(join(claudeDir, POST_MERGE_STALLED_FILENAME), result.outcome, state);
		}
	};
}

// ---------------------------------------------------------------------------
// Auto-chain production factories (US-005)
// ---------------------------------------------------------------------------

/**
 * Build the production setPhaseFn closure for plan-phase handoff (US-003, CAM-151).
 *
 * Writes phase:<value> to .claude/cam-loop.local.md, preserving all other
 * fields from the existing state file. Used by runPostAuditAction on the
 * proceed-branch path to flip phase to 'implementing' so the sidecar loop
 * dispatches the implementer worker without a human cam-next.
 * Non-fatal on any error: the sidecar continues; the phase flip may simply
 * miss one cycle rather than aborting.
 */
export function makeSetPhaseFn(claudeDir: string, cwd: string): (phase: LoopPhase, planIssue?: string) => void {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return (phase: LoopPhase, planIssue?: string): void => {
		try {
			const now = new Date().toISOString();
			let body: string;
			if (existsSync(stateFilePath)) {
				const contents = readFileSync(stateFilePath, 'utf8');
				const parsed = parseStateFile(contents);
				body = renderStateFile({
					maxIterations: parsed?.max_iterations ?? 50,
					completionPromise: parsed?.completion_promise ?? 'COMPLETE',
					startedAt: parsed?.started_at ?? now,
					pid: parsed?.pid ?? process.pid,
					phase,
					plan_issue: planIssue,
					iteration: parsed?.iteration,
					currentStory: parsed?.current_story,
					storiesDone: parsed?.stories_done,
					storiesTotal: parsed?.stories_total,
					lastActivity: now,
				});
			} else {
				body = renderStateFile({
					maxIterations: 50,
					completionPromise: 'COMPLETE',
					startedAt: now,
					pid: process.pid,
					phase,
					plan_issue: planIssue,
					lastActivity: now,
				});
			}
			writeStateFile(cwd, body, { force: true });
		} catch {
			// Non-fatal: sidecar continues to next poll cycle.
		}
	};
}

/**
 * Build the production flipActiveFn closure for auto mode.
 *
 * Delegates to makeSetPhaseFn with 'implementing', so the state file carries
 * phase:implementing (active derives to true) rather than the legacy active:true
 * field. Preserves all other fields from the existing state file.
 * Non-fatal on any error (same contract as makeSetPhaseFn).
 */
function makeFlipActiveFn(claudeDir: string, cwd: string): () => void {
	const setPhase = makeSetPhaseFn(claudeDir, cwd);
	return (): void => setPhase('implementing');
}

/**
 * Build the production readImplementBlockedMarkerFn closure for auto mode
 * (US-003, CAM-214).
 *
 * Delegates to readImplementBlockedMarker(join(claudeDir, IMPLEMENT_BLOCKED_FILENAME))
 * -- reuses the same read helper clearImplementBlockedMarkerForCurrentIssue
 * already calls, never reimplements the marker read. Consulted by the loop.ts
 * auto-chain immediately before flipActiveFn; returns null when the marker is
 * absent (the common case), leaving the breaker untripped.
 */
function makeReadImplementBlockedMarkerFn(claudeDir: string): () => ReturnType<typeof readImplementBlockedMarker> {
	const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
	return () => readImplementBlockedMarker(markerPath);
}

/**
 * Build the production autoShipFn closure for auto mode (US-005, CAM-149:
 * deterministic CLEAN trigger).
 *
 * Delegates to makeSetPhaseFn with 'shipping', so the state file carries
 * phase:shipping and the sidecar's shipping branch (loop.ts) runs the
 * deterministic ship runner on its next tick. Replaces the former tmux
 * send-keys dispatch of the cam-ship slash command (no LLM interprets the
 * CLEAN trigger). Preserves all other fields from the existing state file.
 * Non-fatal on any error (same contract as makeSetPhaseFn).
 */
function makeAutoShipFn(claudeDir: string, cwd: string): () => void {
	const setPhase = makeSetPhaseFn(claudeDir, cwd);
	return (): void => setPhase('shipping');
}

// ---------------------------------------------------------------------------
// Ship-phase production factory (US-004, CAM-149)
// ---------------------------------------------------------------------------

/** Trailing lines of combined stdout+stderr captured on a gates-failed result. */
const GATES_OUTPUT_TAIL_LINES = 60;

/**
 * Build the production runGatesFn adapter for runShipPhase.
 *
 * Spawns DEFAULT_GATES_COMMAND ('bun run check:all', ship-runner.ts) with a
 * real spawnSync and captures the trailing GATES_OUTPUT_TAIL_LINES lines of
 * combined stdout+stderr on failure, so a gates-failed result is diagnosable
 * without re-running the gate manually.
 */
function makeProductionShipGatesFn(cwd: string): () => ShipGatesResult {
	const [bin, ...rest] = DEFAULT_GATES_COMMAND.split(' ');
	return (): ShipGatesResult => {
		const result = spawnSync(bin ?? 'bun', rest, { cwd, encoding: 'utf8' });
		if ((result.status ?? 1) === 0) return { ok: true, outputTail: '' };
		const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
		return { ok: false, outputTail: combined.split('\n').slice(-GATES_OUTPUT_TAIL_LINES).join('\n') };
	};
}

/**
 * Build the constant (non-input) deps runShipPrStep needs, everything except
 * the per-call ShipPrStepInput (US-003, ship-pr.ts).
 *
 * Reuses defaultCloseIssueFn (post-merge.ts) for closeIssueOnMainFn so the
 * "none" backend issue-close never drifts from the post-merge production
 * wiring, and printHint/printWarning (logging/color.ts) for the operator-
 * facing emit seams.
 *
 * Extracted from makeProductionShipPhaseFn to keep that closure under biome's
 * noExcessiveLinesPerFunction(maxLines=80) limit (CAM-60 factory/helper
 * pattern). Not exported: tests inject options.runShipPhaseFn directly.
 */
function buildProductionShipPrStepDeps(
	cwd: string,
	claudeDir: string,
): Omit<RunShipPrStepOptions, keyof ShipPrStepInput> {
	const watchFilePath = join(claudeDir, MERGE_WATCH_FILENAME);
	const spawnFn: ShipPrSpawnFn = (cmd, args, options) =>
		spawnSync(cmd, args, options as Parameters<typeof spawnSync>[2]) as SpawnSyncReturns<string>;
	return {
		spawnFn,
		writeTempFile: (content: string): string => {
			const dir = mkdtempSync(join(tmpdir(), 'cam-ship-pr-'));
			const filePath = join(dir, 'body.md');
			writeFileSync(filePath, content, 'utf8');
			return filePath;
		},
		readReviewArtifact: (): string | null => {
			const artifactPath = join(cwd, REVIEW_ARTIFACT_FILENAME);
			try {
				if (!existsSync(artifactPath)) return null;
				return readFileSync(artifactPath, 'utf8');
			} catch {
				return null;
			}
		},
		readMergeModeFn: () => readMergeMode(join(cwd, 'scripts/cam/project.toml')),
		readMergeWatchStateFn: () => readMergeWatchState(watchFilePath),
		writeMergeWatchStateFn: (state) => writeMergeWatchState(watchFilePath, state),
		removeMergeWatchStateFn: () => removeMergeWatchState(watchFilePath),
		closeIssueOnMainFn: (id: string) => defaultCloseIssueFn(cwd, id),
		emitHint: printHint,
		emitWarning: printWarning,
	};
}

/**
 * Build the production ship-phase escalateFn.
 *
 * Mirrors makeProductionEscalateFn's shape with a ship-specific subject.
 * Returns undefined when Resend is unconfigured (inert, zero behavior change).
 */
function buildShipEscalateFn(cwd: string): (() => Promise<void>) | undefined {
	const resendCfg = readResendConfig(join(cwd, 'scripts/cam/project.toml'));
	if (resendCfg.apiKey === '' || resendCfg.recipient === '') return undefined;
	return async (): Promise<void> => {
		await sendEscalation({
			apiKey: resendCfg.apiKey,
			recipient: resendCfg.recipient,
			subject: '[cam] Ship failed: deterministic ship phase did not complete',
			html: '<p><strong>[cam]</strong> The deterministic ship phase failed. Manual intervention required.</p>',
		});
	};
}

/**
 * Build the production toolchain-mismatch escalateFn (US-007, CAM-192/CAM-201).
 *
 * Mirrors buildShipEscalateFn's shape with a toolchain-specific subject.
 * Returns undefined when Resend is unconfigured (inert, zero behavior change).
 */
function buildToolchainEscalateFn(cwd: string): (() => Promise<void>) | undefined {
	const resendCfg = readResendConfig(join(cwd, 'scripts/cam/project.toml'));
	if (resendCfg.apiKey === '' || resendCfg.recipient === '') return undefined;
	return async (): Promise<void> => {
		await sendEscalation({
			apiKey: resendCfg.apiKey,
			recipient: resendCfg.recipient,
			subject: '[cam] Container toolchain mismatch: rebuild did not converge',
			html: '<p><strong>[cam]</strong> The cam-worker container toolchain still mismatches the repo pins after an auto-rebuild attempt. No worker will be dispatched. Manual intervention required.</p>',
		});
	};
}

/**
 * Fire an escalateFn best-effort (fire-and-forget), swallowing any error to
 * stderr so a Resend failure never blocks the caller. Shared by the
 * ensure-container boot-time catch (runSidecar) below.
 */
function fireEscalateBestEffort(escalateFn: (() => Promise<void>) | undefined): void {
	if (escalateFn === undefined) return;
	void (async () => {
		try {
			await escalateFn();
		} catch (e) {
			process.stderr.write(
				`[cam] escalateFn error (swallowed): ${e instanceof Error ? e.message : String(e)}\n`,
			);
		}
	})();
}

/**
 * Build a short human-readable detail string for a ShipPhaseResult, used by
 * narrateShipPhaseResult for the orchestrator-pane summary line.
 */
function shipFailureDetail(result: ShipPhaseResult): string {
	switch (result.kind) {
		case 'on-main':
			return 'current branch is main';
		case 'prd-incomplete':
			return `blocking stories: ${result.blockingStoryIds.join(', ')}`;
		case 'no-commits-ahead':
			return 'no commits ahead of main';
		case 'gates-failed':
			return result.outputTail.split('\n').filter((l) => l.trim() !== '').slice(-3).join(' | ') || 'gates failed';
		case 'bump-failed':
			return result.detail;
		case 'finalize-failed':
			return result.detail;
		case 'push-failed':
			return result.detail;
		case 'pr-create-failed':
			return result.detail;
		case 'shipped':
			return `PR #${result.prNumber} (${result.mergeMode})`;
	}
}

/**
 * Push a one-line summary of the ship-phase outcome to the orchestrator pane.
 * The shipped kind narrates success; every other kind narrates the failure
 * kind plus a short detail.
 */
function narrateShipPhaseResult(result: ShipPhaseResult, notify: (line: string) => void): void {
	if (result.kind === 'shipped') {
		notify(`[cam] ship shipped: ${shipFailureDetail(result)}`);
		return;
	}
	notify(`[cam] ship failed (${result.kind}): ${shipFailureDetail(result)}`);
}

/**
 * Narrate + log the outcome of runShipPhase (US-004, CAM-149).
 *
 * Every outcome is logged via logEvent (kind 'ship-phase-result', detail is
 * the full ShipPhaseResult) so a failed ship is diagnosable from
 * .claude/cam-worker-events.jsonl without reading source. Failure kinds also
 * push a one-line summary to the orchestrator pane and fire escalateFn
 * best-effort (fire-and-forget); the shipped kind pushes a success line.
 *
 * Exported for direct unit testing (mirrors runPostAuditAction, CAM-155):
 * makeProductionShipPhaseFn calls this after runShipPhase returns; tests
 * exercise it with fake notify/escalateFn/logEvent, no real spawn needed.
 */
export function handleShipPhaseResult(
	result: ShipPhaseResult,
	deps: {
		notify: (line: string) => void;
		escalateFn: (() => Promise<void>) | undefined;
		logEvent: WorkerEventLogger;
	},
): void {
	deps.logEvent({
		ts: new Date().toISOString(),
		storyId: undefined,
		uuid: 'ship',
		kind: 'ship-phase-result',
		detail: { ...result } as unknown as Record<string, unknown>,
	});
	narrateShipPhaseResult(result, deps.notify);
	if (result.kind !== 'shipped' && deps.escalateFn !== undefined) {
		void deps.escalateFn();
	}
}

/**
 * Build the production runShipPhaseFn closure (US-004, CAM-149).
 *
 * Wires runShipPhase (ship-runner.ts, US-002/US-003) with production adapters:
 *   - spawnFn: spawnSync-backed loop.ts SpawnFn shape (git branch/log/push).
 *   - runGatesFn: makeProductionShipGatesFn (spawns DEFAULT_GATES_COMMAND).
 *   - bumpFn / finalizeFn: buildShipBumpOpts / buildShipFinalizeOpts
 *     (src/commands/ship-deps.ts) -- the SAME shared factories `cam ship
 *     --bump` / `--finalize` use (index.ts dispatchShip), so the two
 *     production paths never drift.
 *   - runShipPrStepFn: runShipPrStep (ship-pr.ts, US-003) wired via
 *     buildProductionShipPrStepDeps (real gh spawn, temp-file writer,
 *     review-artifact reader, merge-watch read/write/remove, closeIssueOnMain).
 *
 * The outcome is narrated + logged via handleShipPhaseResult. ALWAYS resets
 * phase to idle when the run ends (finally), success or failure, so the
 * sidecar never gets wedged in phase:shipping. Any thrown exception (e.g. an
 * unreadable prd.json) is caught, logged as a 'sidecar-exit' event, and
 * swallowed (mirrors makeProductionPlanPhaseFn's outer safety net).
 *
 * Not exported: tests inject options.runShipPhaseFn directly.
 */
function makeProductionShipPhaseFn(
	cwd: string,
	claudeDir: string,
	sessionName: string,
	logEvent: WorkerEventLogger,
	realSpawnFn: SpawnFn,
): () => void {
	return (): void => {
		const setPhase = makeSetPhaseFn(claudeDir, cwd);
		try {
			const loopSpawnFn: LoopSpawnFn = (cmd, args, spawnOpts) => {
				const result = spawnSync(cmd, args, {
					cwd,
					stdio: spawnOpts?.stdio ?? 'pipe',
					encoding: 'utf8',
				} as Parameters<typeof spawnSync>[2]);
				return {
					stdout: typeof result.stdout === 'string' ? result.stdout : '',
					exitCode: result.status ?? null,
				};
			};

			const prStepDeps = buildProductionShipPrStepDeps(cwd, claudeDir);

			const result = runShipPhase({
				spawnFn: loopSpawnFn,
				readPrd: () => JSON.parse(readFileSync(join(cwd, 'scripts/cam/prd.json'), 'utf8')) as ShipPrdRecord,
				runGatesFn: makeProductionShipGatesFn(cwd),
				bumpFn: () => runShipBump(buildShipBumpOpts(cwd)),
				finalizeFn: () => finalizeCycleClose(buildShipFinalizeOpts(cwd)),
				runShipPrStepFn: (input: ShipPrStepInput) => runShipPrStep({ ...input, ...prStepDeps }),
				clock: () => new Date().toISOString(),
				logEvent,
			});

			handleShipPhaseResult(result, {
				// US-003 (CAM-200): thread the capture-pane reader + logEvent deps
				// sendKeysVerified needs (idle-gate + composer-emptied verify +
				// bounded retry, 'push-undelivered' on exhaustion).
				notify: makeNotifyOrchestrator(
					sessionName,
					realSpawnFn,
					makeCapturePaneFn(realSpawnFn),
					adaptLogEventForPush(logEvent),
				),
				escalateFn: buildShipEscalateFn(cwd),
				logEvent,
			});
		} catch (err: unknown) {
			logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'sidecar-exit',
				detail: { reason: 'ship-phase-crash', error: err instanceof Error ? err.message : String(err) },
			});
		} finally {
			setPhase('idle');
		}
	};
}

// ---------------------------------------------------------------------------
// Dep-resolution helper (extracted from runSidecar to keep it under the biome
// cognitive-complexity <=15 and function-length <=80 line limits; CAM-60
// factory/helper-extraction pattern)
// ---------------------------------------------------------------------------

interface SidecarLoopDepsCtx {
	cwd: string;
	claudeDir: string;
	prdPath: string;
	sessionName: string;
	logEvent: WorkerEventLogger;
	realSpawnFn: SpawnFn;
}

interface SidecarLoopDepsResult {
	readActiveFn: () => boolean | undefined;
	clearActiveFn: () => void;
	hasPendingStoriesFn: () => boolean;
	sleepFn: (ms: number) => void;
	hasSessionFn: () => boolean;
	acquireLockFn: NonNullable<SidecarOptions['acquireLockFn']>;
	buildOptsFn: NonNullable<RunSidecarLoopOptions['buildOpts']>;
	runMergeWatchFn: RunSidecarLoopOptions['runMergeWatchFn'];
	flipActiveFn: RunSidecarLoopOptions['flipActiveFn'];
	readImplementBlockedMarkerFn: RunSidecarLoopOptions['readImplementBlockedMarkerFn'];
	autoShipFn: RunSidecarLoopOptions['autoShipFn'];
	readReviewReportFn: RunSidecarLoopOptions['readReviewReportFn'];
	fileSuggestionsFn: RunSidecarLoopOptions['fileSuggestionsFn'];
	escalateFn: RunSidecarLoopOptions['escalateFn'];
	runMetaLoopObserveFn: RunSidecarLoopOptions['runMetaLoopObserveFn'];
	readLoopPhaseFn: RunSidecarLoopOptions['readLoopPhaseFn'];
	runPlanPhaseFn: RunSidecarLoopOptions['runPlanPhaseFn'];
	runShipPhaseFn: RunSidecarLoopOptions['runShipPhaseFn'];
	rearmImplementingFn: RunSidecarLoopOptions['rearmImplementingFn'];
}

// ---------------------------------------------------------------------------
// Drain notification (US-005, CAM-132)
// ---------------------------------------------------------------------------

/**
 * Subject line for drain-specific Resend emails.
 * Exported so tests can assert against the canonical string without
 * hardcoding it, and so file-assert oracles can verify its presence.
 */
export const DRAIN_NOTIFY_SUBJECT = '[cam] Backlog drained: no plannable issues remain';

/**
 * Build the drain-notify closure (US-005, CAM-132).
 *
 * Reuses readResendConfig + sendEscalation with a drain-specific subject/body.
 * NOT the escalateFn closure (which carries the non-convergence subject).
 * No second Resend client is instantiated: sendEscalation builds the client
 * internally from apiKey when sendFn is absent.
 *
 * Returns undefined when apiKey or recipient is empty so the drain path is
 * inert for projects that have not configured Resend.
 *
 * @param sendFn Injectable send function for unit tests (avoids real network).
 */
function makeProductionDrainNotifyFn(
	apiKey: string,
	recipient: string,
	sendFn?: ResendSendFn,
): (() => Promise<void>) | undefined {
	if (apiKey === '' || recipient === '') return undefined;
	return async () => {
		await sendEscalation({
			apiKey,
			recipient,
			subject: DRAIN_NOTIFY_SUBJECT,
			html: '<p><strong>[cam]</strong> The meta-loop observer found no plannable issues in the backlog. The project backlog is drained.</p>',
			sendFn,
		});
	};
}

/**
 * Build the production escalateFn closure (US-R1-001).
 *
 * Extracted from buildSidecarLoopDeps to reduce its cognitive complexity (biome
 * noExcessiveCognitiveComplexity, max 15). Not exported: tests inject
 * options.escalateFn directly.
 *
 * Returns undefined when either apiKey or recipient is empty so the non-convergence
 * terminal stays inert for projects that have not configured Resend.
 */
function makeProductionEscalateFn(
	apiKey: string,
	recipient: string,
): RunSidecarLoopOptions['escalateFn'] {
	if (apiKey === '' || recipient === '') return undefined;
	return async () => {
		await sendEscalation({
			apiKey,
			recipient,
			subject: '[cam] Non-convergence: max review rounds reached',
			html: '<p><strong>[cam]</strong> The supervisor reached the maximum number of review rounds without a CLEAN verdict. Manual intervention is required.</p>',
		});
	};
}

/**
 * Build the production runMetaLoopObserveFn closure for meta_loop=observe mode
 * (US-004/US-005, CAM-132).
 *
 * Extracted from buildSidecarLoopDeps to keep that function under the biome
 * noExcessiveLinesPerFunction(maxLines=80) limit. Exported (rather than the
 * previous unexported form) so the regression test for the selector-error
 * boundary below (US-001, CAM-115) can inject a throwing selectFn without a
 * real corrupted backlog fixture; production callers still get
 * options.runMetaLoopObserveFn injected via buildMetaLoopFn.
 *
 * Dedup state is held in the closure (NOT persisted to any file under .claude
 * or the working tree per CAM-68 invariant).
 *
 * Internally builds the drain notify fn from apiKey/recipient so that
 * buildSidecarLoopDeps avoids an extra ?? expression (complexity budget).
 * When apiKey or recipient is empty, drainNotify is undefined (inert).
 *
 * selectFn defaults to the real selectPlannableFromFile(cwd) seam; tests
 * override it to simulate a real backlog read/parse error (US-001, CAM-115).
 * Since selectPlannableFromFile no longer swallows read/parse errors, a throw
 * here would otherwise propagate through the unguarded
 * `await opts.runMetaLoopObserveFn()` call in loop.ts's idle tick and crash
 * the long-lived sidecar. The catch below is that boundary: it logs the real
 * error via the WorkerEventLogger and skips the tick WITHOUT calling
 * observeDecide, so a corrupted backlog is never converted into a
 * drained/empty-backlog observation. lastState is left untouched so the next
 * tick retries cleanly once the underlying error clears.
 */
export function makeProductionMetaLoopObserveFn(
	cwd: string,
	logEvent: WorkerEventLogger,
	resendApiKey: string,
	resendRecipient: string,
	selectFn: () => IssueEntry | null = () => selectPlannableFromFile(cwd),
): () => Promise<void> {
	const drainNotifyFn = makeProductionDrainNotifyFn(resendApiKey, resendRecipient);
	let lastState: ObserveState = { kind: 'none' };
	return async (): Promise<void> => {
		let selected: IssueEntry | null;
		try {
			selected = selectFn();
		} catch (err: unknown) {
			logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'sidecar-exit',
				detail: {
					reason: 'meta-loop-observe-select-error',
					error: err instanceof Error ? err.message : String(err),
				},
			});
			return;
		}
		const result = observeDecide(selected, lastState);
		if (result !== null) {
			lastState = result.newState;
			logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'meta-loop-observe',
				detail: result.detail,
			});
			// US-005: send drain notification once when the backlog empties.
			if ('drained' in result.detail && result.detail.drained === true && drainNotifyFn) {
				await drainNotifyFn();
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Auto-dispatcher (US-004, CAM-139): meta_loop=auto drain
// ---------------------------------------------------------------------------

/**
 * Subject line for blocked-cycle Resend emails (US-005, CAM-139).
 * Exported so tests can assert against the canonical string without
 * hardcoding it, and so file-assert oracles can verify its presence.
 */
export const BLOCKED_CYCLE_ESCALATE_SUBJECT = '[cam] Blocked cycle: MAX_ROUNDS_DEBT reached, operator intervention required';

/**
 * Injectable sub-deps for the inter-cycle auto-dispatcher.
 *
 * Every dep has a corresponding production default built by
 * buildProductionDispatchFn; tests inject fakes to drive dispatch/drained/
 * refuse/kill branches without real filesystem, Docker, or tmux access
 * (anti-shadow-mock, CAM-55).
 */
export interface MetaLoopDispatchDeps {
	/** Read the next plannable issue from the MAIN backlog. Returns null when drained. */
	selectFn: () => IssueEntry | null;
	/** Read the current loop phase from cam-loop.local.md. Returns undefined when absent. */
	readPhaseFn: () => LoopPhase | undefined;
	/** Return true when scripts/cam/prd.json is present (a PRD cycle is in flight). */
	prdPresentFn: () => boolean;
	/** Return true when the merge-watch marker file is present. */
	mergeWatchPresentFn: () => boolean;
	/** Evaluate drain preconditions fail-closed (US-003). */
	preconditionFn: () => DrainPreconditionResult;
	/** Return true when the drain kill-switch marker is present (US-002). */
	killSwitchFn: () => boolean;
	/** Write phase (and optional plan_issue) to cam-loop.local.md (US-003 / ADR-0006). */
	setPhaseFn: (phase: LoopPhase, planIssue?: string) => void;
	/** Send drain notification email. Absent when Resend is not configured. */
	drainNotifyFn?: () => Promise<void>;
	/**
	 * Emit a precondition refusal warning (default: process.stderr.write).
	 * Tests inject a capture array to assert the warning fires without touching stderr.
	 */
	warnFn?: (msg: string) => void;
	/** Emit structured events to the flight recorder. */
	logEvent: WorkerEventLogger;
	/**
	 * Read review.lastVerdict from scripts/cam/prd.json (US-005, CAM-139).
	 * Returns null when absent, unparseable, or no verdict is set.
	 * Used by handleBlockedCycleBoundary to distinguish MAX_ROUNDS_DEBT (blocked)
	 * from a plain in-flight cycle. Absent in existing tests = backward compat
	 * (falls back to plain in-flight silent skip).
	 */
	readPrdVerdictFn?: () => string | null;
	/**
	 * Read a pending explicit plan_issue from cam-loop.local.md (US-004, CAM-203).
	 * Returns undefined (or empty string) when no operator target is pending, in
	 * which case dispatch behavior is unchanged (top-of-queue via selectFn).
	 * When it returns a non-empty id, the pending explicit target takes priority
	 * over selectFn's top-of-queue pick for that tick (see dispatchOrDrain /
	 * handlePendingTarget). Optional for backward compat with existing tests.
	 */
	readPlanIssueFn?: () => string | undefined;
	/**
	 * Target-aware plannable selector (US-004, CAM-203): resolves a specific
	 * pending plan_issue id to an IssueEntry, or null when the id is absent from
	 * the backlog or not plannable (never falls back to top-of-queue). Only
	 * consulted when readPlanIssueFn returns a non-empty id. Optional for
	 * backward compat with existing tests.
	 */
	selectTargetFn?: (targetId: string) => IssueEntry | null;
	/**
	 * Send blocked-cycle escalation email (US-005, CAM-139).
	 * Distinct from drainNotifyFn (empty backlog) and from loop's escalateFn
	 * (MAX_ROUNDS_DEBT detected by the supervisor itself).
	 * This is the DRAIN-level halt notification: the auto-dispatcher detected
	 * a blocked cycle at the safe boundary and parked.
	 * Absent when Resend is not configured (both apiKey and recipient must be set).
	 * Escalation is best-effort: failure never prevents parking.
	 */
	blockedCycleEscalateFn?: () => Promise<void>;
}

/**
 * Build the auto-dispatcher closure for meta_loop=auto mode (US-004, CAM-139).
 *
 * On each idle tick (called via the runMetaLoopObserveFn seam in loop.ts) the
 * closure checks the kill-switch, evaluates fail-closed preconditions, and
 * verifies safe-boundary guards before dispatching:
 *
 *   1. Kill-switch engaged -> emit 'stopped' once (deduped), park.
 *   2. Preconditions not met -> emit 'refused' + warn, park.
 *   3. PRD cycle in flight (prd.json present) -> emit 'meta-loop-dispatch
 *      {skipped:true, reason:'cycle-in-flight'}' this tick (US-007), park.
 *   4. Merge-watch file present -> emit 'meta-loop-dispatch {skipped:true,
 *      reason:'merge-watch-present'}' this tick (US-007), park.
 *   5. Phase not idle/absent -> emit 'meta-loop-dispatch {skipped:true,
 *      reason:'phase-not-idle'}' this tick (US-007), park.
 *   6. Backlog drained (selectFn returns null) -> emit 'meta-loop-observe {drained:true}'
 *      + drain-notify (once, deduped by observeDecide state), park.
 *   7. Issue found -> write phase:planning + plan_issue:<id> via setPhaseFn,
 *      emit 'meta-loop-dispatch {dispatched:true}' (deduped per-issue, see
 *      DispatchClosureState.pendingIssueId below).
 *
 * Dedup: a per-issue pending-guard (DispatchClosureState.pendingIssueId, US-007,
 * CAM-98/CAM-195) suppresses the *event* on repeat dispatch attempts of the SAME
 * issue id: setPhaseFn is still called every tick so a legitimate retry (e.g. the
 * plan phase bouncing phase back to 'idle' on pane-count mutex-busy, exitPhaseAfterPlan
 * in this file) keeps working, but 'dispatched:true' fires only on the FIRST attempt
 * for that issue id. This is what eliminated the ~4.7s dispatched:true storm (CAM-98):
 * without it, every idle tick during a mutex-busy retry loop re-selected the same
 * still-open issue and re-emitted 'dispatched:true'. The guard self-clears the moment
 * a DIFFERENT issue id is selected (no separate reset hook is needed: comparison is by
 * identity, and a issue's cycle "reaching a terminal" is exactly what frees the backlog
 * slot for a different pick). Drain dedup mirrors the observe path (observeDecide state
 * in closure). Kill-switch dedup: stopped event is emitted exactly once per engagement
 * (boolean flag in closure).
 *
 * Exported for direct testability (anti-shadow-mock): tests call this factory
 * with injected fakes and assert the returned closure's behavior without touching
 * real filesystem, Docker, or tmux (AC#2-6, US-004).
 */
/** Mutable refs threaded through makeProductionMetaLoopDispatchFn helpers. */
interface DispatchClosureState {
	stoppedEmitted: boolean;
	observeState: ObserveState;
	/**
	 * Dedup flag for the blocked-cycle judgment point (US-005).
	 * Set to true after the first blockedCycle event + escalation fires.
	 * Reset to false when prd.json is absent (block cleared by operator ship/abandon).
	 */
	blockedCycleEmitted: boolean;
	/**
	 * Per-issue pending-guard (US-007, CAM-98/CAM-195 rider): the issue id of the
	 * most recent 'dispatched:true' emission. A repeat dispatch attempt for the
	 * SAME id (selected.id === pendingIssueId) still calls setPhaseFn (retry is
	 * preserved) but does NOT re-emit the event, which is what kills the ~4.7s
	 * dispatched:true storm caused by the plan-phase mutex-busy path resetting
	 * phase back to 'idle' before a PRD is ever created for that issue. Cleared
	 * implicitly (not by an explicit reset) the moment a different issue id is
	 * selected, since that only happens once the previous issue's cycle reaches
	 * a terminal and vacates the top of the backlog. Undefined until the first
	 * dispatch of this closure's lifetime.
	 */
	pendingIssueId: string | undefined;
}

/**
 * Handle the kill-switch check for one dispatch tick.
 * Returns true when the kill-switch is engaged (caller should return early).
 * Emits the 'stopped' event exactly once per engagement (dedup via ctx.stoppedEmitted).
 */
function handleKillSwitchBoundary(deps: MetaLoopDispatchDeps, ctx: DispatchClosureState): boolean {
	if (!deps.killSwitchFn()) {
		ctx.stoppedEmitted = false; // reset when kill-switch clears
		return false;
	}
	if (!ctx.stoppedEmitted) {
		ctx.stoppedEmitted = true;
		deps.logEvent({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'sidecar',
			kind: 'meta-loop-dispatch',
			detail: { stopped: true },
		});
	}
	return true;
}

/**
 * Evaluate fail-closed preconditions (US-003) and emit 'refused' when not met.
 * Returns true when the caller should return early (preconditions failed).
 */
function handlePreconditionRefuse(deps: MetaLoopDispatchDeps): boolean {
	const result = deps.preconditionFn();
	if (result.ok) return false;
	const warn = deps.warnFn ?? ((m: string) => process.stderr.write(`[cam] ${m}\n`));
	warn(`auto-drain refused: ${result.reason}`);
	deps.logEvent({
		ts: new Date().toISOString(),
		storyId: undefined,
		uuid: 'sidecar',
		kind: 'meta-loop-dispatch',
		detail: { refused: true, reason: result.reason },
	});
	return true;
}

/**
 * Handle the blocked-cycle judgment point for one dispatch tick (US-005, CAM-139).
 *
 * Returns false when prd.json is absent (block cleared by operator ship/abandon):
 *   the caller resets ctx.blockedCycleEmitted and continues to normal dispatch.
 * Returns true when prd.json is present (caller should return early):
 *   - verdict === 'MAX_ROUNDS_DEBT': park, emit 'meta-loop-dispatch {blockedCycle:true}'
 *     once (deduped via ctx.blockedCycleEmitted), fire blockedCycleEscalateFn or warnFn.
 *   - any other verdict: plain in-flight cycle, silent skip.
 *
 * Escalation is best-effort: a thrown exception is swallowed so parking is never
 * conditional on the network call succeeding (AC2: "escalation is never a precondition").
 */
async function handleBlockedCycleBoundary(
	deps: MetaLoopDispatchDeps,
	ctx: DispatchClosureState,
): Promise<boolean> {
	if (!deps.prdPresentFn()) {
		ctx.blockedCycleEmitted = false; // block cleared: reset dedup for next cycle
		return false;
	}
	const verdict = deps.readPrdVerdictFn?.() ?? null;
	if (verdict !== 'MAX_ROUNDS_DEBT') {
		// US-007 (CAM-195, Defect 2 refusals): previously silent; now a
		// structured event so the flight recorder shows every refused tick.
		deps.logEvent({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'sidecar',
			kind: 'meta-loop-dispatch',
			detail: { skipped: true, reason: 'cycle-in-flight' },
		});
		return true; // plain in-flight cycle: skip (now observable)
	}
	// Blocked cycle: park + escalate exactly once (dedup via ctx.blockedCycleEmitted).
	if (!ctx.blockedCycleEmitted) {
		ctx.blockedCycleEmitted = true;
		deps.logEvent({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'sidecar',
			kind: 'meta-loop-dispatch',
			detail: { blockedCycle: true },
		});
		if (deps.blockedCycleEscalateFn) {
			try { await deps.blockedCycleEscalateFn(); } catch { /* best-effort */ }
		} else {
			const warn = deps.warnFn ?? ((m: string) => process.stderr.write(`[cam] ${m}\n`));
			warn('blocked-cycle: MAX_ROUNDS_DEBT; operator intervention required');
		}
	}
	return true;
}

/**
 * Resolve a pending explicit plan_issue target (US-004, CAM-203): an
 * operator-set plan_issue (e.g. via /cam-plan <id>) that is still pending when
 * an idle auto-dispatch tick fires. This wins over selectFn's top-of-queue
 * pick for the tick, regardless of rank/WSJF (CAM-201-class bug: an explicit
 * target must never be silently clobbered by rank-based auto-dispatch).
 *
 * Plannable -> dispatch it via setPhaseFn('planning', target-id), emitting the
 * same 'meta-loop-dispatch' {dispatched} event shape as top-of-queue dispatch.
 *
 * Not plannable (missing / not open / blocked) -> the dispatcher never
 * substitutes a different issue on this tick. It emits a 'meta-loop-dispatch'
 * {refusedTarget, targetId} event and clears the stale plan_issue via
 * setPhaseFn('idle') (no 2nd arg; makeSetPhaseFn writes plan_issue as the raw
 * 2nd argument with no fallback, so omitting it clears the field) so the NEXT
 * tick resumes top-of-queue dispatch instead of retrying the same dead target
 * forever.
 *
 * Deliberately bypasses observeDecide/ctx.observeState: the pending-target
 * branch is a distinct decision point from the drain-dedup path and must not
 * perturb that state.
 *
 * selectTargetFn boundary (US-R1-001, CAM-115): selectPlanTargetFromFile no
 * longer swallows real backlog read/parse errors (mirrors selectFn below).
 * A throw here is caught, logged via logEvent as a 'sidecar-exit' event, and
 * the tick is skipped WITHOUT dispatching or clearing plan_issue, so a
 * transient corrupted-backlog read never gets misread as "target not found".
 *
 * Per-issue pending-guard (US-007): mirrors dispatchOrDrain's top-of-queue
 * dispatch -- setPhaseFn is always called on a plannable resolve (so a
 * mutex-busy retry keeps working), but the 'dispatched:true' event is deduped
 * via ctx.pendingIssueId so re-resolving the same target across ticks does not
 * re-fire the event.
 */
function handlePendingTarget(deps: MetaLoopDispatchDeps, ctx: DispatchClosureState, targetId: string): void {
	let resolved: IssueEntry | null;
	try {
		resolved = deps.selectTargetFn?.(targetId) ?? null;
	} catch (err: unknown) {
		deps.logEvent({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'sidecar',
			kind: 'sidecar-exit',
			detail: {
				reason: 'meta-loop-dispatch-select-target-error',
				error: err instanceof Error ? err.message : String(err),
			},
		});
		return;
	}
	if (resolved !== null) {
		deps.setPhaseFn('planning', resolved.id);
		if (ctx.pendingIssueId !== resolved.id) {
			ctx.pendingIssueId = resolved.id;
			deps.logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'meta-loop-dispatch',
				detail: { dispatched: true, issueId: resolved.id, rank: resolved.rank ?? 0 },
			});
		}
		return;
	}
	deps.logEvent({
		ts: new Date().toISOString(),
		storyId: undefined,
		uuid: 'sidecar',
		kind: 'meta-loop-dispatch',
		detail: { refusedTarget: true, targetId },
	});
	deps.setPhaseFn('idle');
}

/**
 * Select the next plannable issue and either dispatch it or emit a drain event.
 * Mutates ctx.observeState for cross-tick dedup (mirrors the observe path).
 *
 * A pending explicit plan_issue (US-004, CAM-203) is checked first and, when
 * present, takes over the tick entirely via handlePendingTarget: top-of-queue
 * selection is not consulted at all for that tick.
 *
 * selectFn boundary (US-R1-001, CAM-115): mirrors makeProductionMetaLoopObserveFn's
 * selector-error boundary. selectPlannableFromFile no longer swallows real
 * backlog read/parse errors, so a throw here is caught, logged via logEvent
 * as a 'sidecar-exit' event, and the tick is skipped WITHOUT dispatching --
 * a corrupted backlog must never be misread as a drained/empty backlog.
 */
async function dispatchOrDrain(
	deps: MetaLoopDispatchDeps,
	ctx: DispatchClosureState,
): Promise<void> {
	const pendingTarget = deps.readPlanIssueFn?.();
	if (pendingTarget !== undefined && pendingTarget.length > 0) {
		handlePendingTarget(deps, ctx, pendingTarget);
		return;
	}
	let selected: IssueEntry | null;
	try {
		selected = deps.selectFn();
	} catch (err: unknown) {
		deps.logEvent({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'sidecar',
			kind: 'sidecar-exit',
			detail: {
				reason: 'meta-loop-dispatch-select-error',
				error: err instanceof Error ? err.message : String(err),
			},
		});
		return;
	}
	const observeResult = observeDecide(selected, ctx.observeState);
	if (observeResult !== null) ctx.observeState = observeResult.newState;
	if (selected === null) {
		// Drained. Emit observe event + notify once (dedup: observeResult null when
		// lastState was already 'drained').
		if (observeResult !== null) {
			deps.logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'meta-loop-observe',
				detail: observeResult.detail,
			});
			if (deps.drainNotifyFn) await deps.drainNotifyFn();
		}
		return;
	}
	// Issue found: write phase:planning + plan_issue so the plan runner picks it up.
	// setPhaseFn always runs (a mutex-busy retry of the SAME issue must keep
	// working); the event is deduped per-issue via ctx.pendingIssueId (US-007)
	// so a retry storm of the same issue no longer re-emits 'dispatched:true'.
	deps.setPhaseFn('planning', selected.id);
	if (ctx.pendingIssueId !== selected.id) {
		ctx.pendingIssueId = selected.id;
		deps.logEvent({
			ts: new Date().toISOString(),
			storyId: undefined,
			uuid: 'sidecar',
			kind: 'meta-loop-dispatch',
			detail: { dispatched: true, issueId: selected.id, rank: selected.rank ?? 0 },
		});
	}
}

export function makeProductionMetaLoopDispatchFn(deps: MetaLoopDispatchDeps): () => Promise<void> {
	const ctx: DispatchClosureState = {
		stoppedEmitted: false,
		observeState: { kind: 'none' },
		blockedCycleEmitted: false,
		pendingIssueId: undefined,
	};

	return async (): Promise<void> => {
		if (handleKillSwitchBoundary(deps, ctx)) return;
		if (handlePreconditionRefuse(deps)) return;
		// US-005: check for blocked cycle (MAX_ROUNDS_DEBT) before plain prd-present skip.
		// Returns true (park) for both blocked and plain in-flight; false when prd absent.
		if (await handleBlockedCycleBoundary(deps, ctx)) return;
		if (deps.mergeWatchPresentFn()) {
			// US-007 (CAM-195, Defect 2 refusals): previously silent.
			deps.logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'meta-loop-dispatch',
				detail: { skipped: true, reason: 'merge-watch-present' },
			});
			return;
		}
		const phase = deps.readPhaseFn();
		if (phase !== undefined && phase !== 'idle') {
			// US-007 (CAM-195, Defect 2 refusals): previously silent.
			deps.logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'meta-loop-dispatch',
				detail: { skipped: true, reason: 'phase-not-idle' },
			});
			return;
		}
		await dispatchOrDrain(deps, ctx);
	};
}

/**
 * Build the production MetaLoopDispatchDeps for meta_loop=auto mode and return
 * the dispatch closure (US-004, CAM-139).
 *
 * Extracted from buildSidecarLoopDeps to keep that function under biome's
 * noExcessiveCognitiveComplexity(max=15) and noExcessiveLinesPerFunction(max=80)
 * limits (CAM-60 factory/helper-extraction pattern).
 * Not exported: tests inject options.runMetaLoopObserveFn or call
 * makeProductionMetaLoopDispatchFn directly with fake deps.
 */
function buildProductionDispatchFn(
	ctx: SidecarLoopDepsCtx,
	logEvent: WorkerEventLogger,
	resendConfig: { apiKey: string; recipient: string },
): () => Promise<void> {
	const { cwd, claudeDir } = ctx;
	const configPath = join(cwd, 'scripts/cam/project.toml');

	// Read isolation + approval once at build time (project config is stable per run).
	const workerIsolation = readWorkerIsolation(configPath);
	const planApproval = readPlanApproval(configPath);

	// Container preflight probe: called fresh on each tick when isolation=container.
	// In host mode, always returns { ready: false } (fail-closed; host mode never drains).
	const preflightFn: () => import('../supervisor/preflight-container.ts').PreflightResult =
		workerIsolation === 'container'
			? (): import('../supervisor/preflight-container.ts').PreflightResult =>
				preflightWorkerContainer({
					probe: (args) => {
						const r = spawnSync('docker', args, {
							stdio: 'pipe',
							encoding: 'utf8',
						} as Parameters<typeof spawnSync>[2]);
						return {
							stdout: typeof r.stdout === 'string' ? r.stdout : '',
							exitCode: r.status ?? 1,
						};
					},
				})
			: (): import('../supervisor/preflight-container.ts').PreflightResult =>
				({ ready: false, reason: 'daemon-unreachable' as const });

	const prdPath = join(cwd, 'scripts/cam/prd.json');

	return makeProductionMetaLoopDispatchFn({
		selectFn: () => selectPlannableFromFile(cwd),
		readPhaseFn: makeReadLoopPhase(claudeDir),
		// US-004, CAM-203: a pending explicit /cam-plan <id> target wins over
		// top-of-queue auto-dispatch for this tick (see handlePendingTarget).
		readPlanIssueFn: makeReadPlanIssue(claudeDir),
		selectTargetFn: (targetId) => selectPlanTargetFromFile(cwd, targetId),
		prdPresentFn: () => existsSync(prdPath),
		mergeWatchPresentFn: () => existsSync(join(claudeDir, MERGE_WATCH_FILENAME)),
		preconditionFn: () =>
			evaluateDrainPreconditions({
				workerIsolation,
				containerPreflight: preflightFn(),
				planApproval,
			}),
		killSwitchFn: () => isDrainStopSet(claudeDir),
		setPhaseFn: makeSetPhaseFn(claudeDir, cwd),
		drainNotifyFn: makeProductionDrainNotifyFn(resendConfig.apiKey, resendConfig.recipient),
		logEvent,
		// US-005: blocked-cycle judgment point deps.
		readPrdVerdictFn: () => {
			try {
				const raw = readFileSync(prdPath, 'utf8');
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
				const prd = parsed as { review?: { lastVerdict?: string | null } };
				return prd.review?.lastVerdict ?? null;
			} catch { return null; }
		},
		blockedCycleEscalateFn: (resendConfig.apiKey !== '' && resendConfig.recipient !== '')
			? async (): Promise<void> => {
				await sendEscalation({
					apiKey: resendConfig.apiKey,
					recipient: resendConfig.recipient,
					subject: BLOCKED_CYCLE_ESCALATE_SUBJECT,
					html: '<p><strong>[cam]</strong> The drain detected a blocked cycle. The review reached MAX_ROUNDS_DEBT without converging. Operator intervention is required.</p>',
				});
			}
			: undefined,
	});
}

/**
 * Transition the loop phase out of 'planning' after a non-implementing
 * post-audit result (US-R1-002, CAM-151).
 *
 * branch-created: setPhaseFn('implementing') was already called inside
 * runPostAuditAction; nothing to do here.
 * awaiting-operator-approval: write 'awaiting-operator' so the operator can
 * trigger the next step manually.
 * escalated / no-action: write 'idle' to stop the re-entry loop.
 *
 * Extracted from makeProductionPlanPhaseFn to keep its closure under the
 * biome noExcessiveLinesPerFunction limit (80 lines).
 */
function exitPhaseAfterPlan(
	result: PostAuditActionResult,
	setPhase: (phase: LoopPhase) => void,
): void {
	if (result.kind === 'branch-created') return;
	setPhase(result.kind === 'awaiting-operator-approval' ? 'awaiting-operator' : 'idle');
}

/**
 * Build the isPaneAlive probe + ensureWorkerPane self-heal closure for the plan
 * phase (US-001, CAM-155).
 *
 * Mirrors host.ts ensureWorkerPaneFn (patterns.md 'ensureWorkerPane self-heal
 * CAM-57'): re-reads the marker fresh on each call, probes isPaneAlive, and when
 * dead calls openPaneInSession targeting the orchestrator pane (CAM-80 geometry),
 * then writeWorkerPaneMarker.
 *
 * Extracted from makeProductionPlanPhaseFn closure to keep that function under
 * biome's noExcessiveLinesPerFunction(maxLines=80) limit (CAM-60 factory/helper
 * extraction pattern). Not exported: tests inject options.runPlanPhaseFn directly.
 */
function makePlanPaneHelpers(
	claudeDir: string,
	sessionName: string,
): { isPaneAlive: IsPaneAlive; ensureWorkerPane: () => string } {
	const isPaneAlive: IsPaneAlive = (paneId) => {
		const r = spawnSync(
			'tmux',
			['-L', 'cam', 'display-message', '-p', '-t', paneId, '#{pane_dead}'],
			{ stdio: 'pipe', encoding: 'utf8' } as Parameters<typeof spawnSync>[2],
		);
		if (r.status !== 0) return false;
		return (typeof r.stdout === 'string' ? r.stdout.trim() : '') === '0';
	};
	const ensureWorkerPane = (): string => {
		const currentId = readWorkerPaneMarker(claudeDir) ?? '%2';
		if (isPaneAlive(currentId)) return currentId;
		const orchPaneId = getOrchPaneId(sessionName, (cmd, args, opts) =>
			spawnSync(cmd, args, {
				stdio: opts?.stdio ?? 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]),
		);
		const targetPaneId = orchPaneId ?? `${sessionName}:0`;
		const newId = openPaneInSession(
			sessionName,
			['cat'],
			(cmd, args, opts) =>
				spawnSync(cmd, args, {
					stdio: opts?.stdio ?? 'pipe',
					encoding: 'utf8',
				} as Parameters<typeof spawnSync>[2]),
			targetPaneId,
		);
		writeWorkerPaneMarker(claudeDir, newId);
		return newId;
	};
	return { isPaneAlive, ensureWorkerPane };
}

/**
 * Build the real teardownPlanPanesFn for the plan phase (US-004, CAM-204).
 *
 * Mirrors host.ts:398 teardownWorkerPaneFn EXACTLY: `tmux kill-pane` (NOT
 * respawn-pane -k, which keeps the pane alive and leaves the pane-count mutex
 * busy). The pane id is resolved FRESH from readWorkerPaneMarker on every call
 * (never cached), so a mid-run pane re-allocation (self-heal) is picked up
 * correctly. Best-effort: a null marker, an already-dead pane, or absent tmux
 * is a silent no-op; this function never throws.
 *
 * Wired into runPlanPhaseWithReplan so a kill-pane happens on all three
 * production paths (AC3, US-004): audit-approved terminal, each re-plan round
 * boundary, and the plan-escalated terminal -- runPlanPhaseWithReplan itself
 * (US-003) already calls this seam at exactly those three points.
 */
function makeTeardownPlanPanesFn(claudeDir: string): () => void {
	return () => {
		const id = readWorkerPaneMarker(claudeDir) ?? '%2';
		try {
			spawnSync('tmux', ['-L', 'cam', 'kill-pane', '-t', id], { stdio: 'pipe' });
		} catch {
			// best-effort: silent no-op
		}
	};
}

/**
 * Build the real writeEscalationMarkerFn for the plan phase (US-004, CAM-204).
 *
 * Stamps `writtenAt` (the one field runPlanPhaseWithReplan's pure seam does
 * NOT add, keeping plan-runner.ts clock-free) and persists the durable
 * .cam-plan-escalated.json marker via writePlanEscalatedMarker
 * (src/supervisor/plan-escalation.ts, US-002). Called unconditionally by
 * runPlanPhaseWithReplan on MAX_REPLAN_ROUNDS exhaustion, independent of
 * notifyFn/escalateFn presence or success (AC2).
 */
function makeWriteEscalationMarkerFn(claudeDir: string): (params: PlanEscalationWriterParams) => void {
	const filePath = join(claudeDir, PLAN_ESCALATED_FILENAME);
	return (params: PlanEscalationWriterParams): void => {
		const marker: PlanEscalatedMarker = { ...params, writtenAt: new Date().toISOString() };
		writePlanEscalatedMarker(filePath, marker);
	};
}

/**
 * Build the real writePreflightFailedMarkerFn for the plan phase (US-003, CAM-215).
 *
 * Stamps `writtenAt` (the one field runPostAuditAction's pure seam does NOT
 * add, keeping plan-runner.ts clock-free) and persists the durable
 * .cam-plan-preflight-failed.json marker via writePlanPreflightFailedMarker
 * (src/supervisor/plan-preflight-marker.ts, US-002). Called unconditionally by
 * runPostAuditAction on a preflight-failed planResult, independent of
 * notifyFn's presence or outcome (mirrors makeWriteEscalationMarkerFn above).
 */
function makeWritePreflightFailedMarkerFn(claudeDir: string): (params: PlanPreflightFailedWriterParams) => void {
	const filePath = join(claudeDir, PLAN_PREFLIGHT_FAILED_FILENAME);
	return (params: PlanPreflightFailedWriterParams): void => {
		const marker: PlanPreflightFailedMarker = { ...params, writtenAt: new Date().toISOString() };
		writePlanPreflightFailedMarker(filePath, marker);
	};
}

/**
 * Build a clearStalePlanArtifacts function for the given cwd (US-002, CAM-155).
 *
 * Removes both:
 *   - `<cwd>/scripts/cam/plan-verdict-report.json` (stale auditor verdict)
 *   - `<cwd>/scripts/cam/prd.json` (stale planner output)
 *
 * Best-effort: no-op on missing files, never throws.
 * Mirrors makeClearReviewReport in host.ts (patterns.md 'Review-report.json
 * reader dep-injection pattern').
 */
function makeClearStalePlanArtifacts(cwd: string): () => void {
	const verdictPath = join(cwd, PLAN_VERDICT_REPORT_FILENAME);
	const prdPath = join(cwd, 'scripts/cam/prd.json');
	return () => {
		try {
			if (existsSync(verdictPath)) unlinkSync(verdictPath);
		} catch { /* best-effort */ }
		try {
			if (existsSync(prdPath)) unlinkSync(prdPath);
		} catch { /* best-effort */ }
	};
}

/**
 * Writes the derived branch name back into scripts/cam/prd.json's
 * `branchName` field (US-001, CAM-236, ADR-0016, AC4). Called from
 * executeGitProceedBranch BEFORE the prd.json commit, so the committed PRD
 * and downstream readers (status, dashboard, ship, suggestions source) stay
 * coherent with the real branch even when the planner emitted something
 * else. Best-effort: a read/parse/write failure here must not detonate the
 * plan phase (the git checkout -B already succeeded); mirrors the
 * best-effort contract of the other marker-writer seams in this module.
 */
function makeWritePrdBranchNameFn(cwd: string): (branchName: string) => void {
	return (branchName: string): void => {
		try {
			const prdPath = join(cwd, 'scripts/cam/prd.json');
			const prdRaw = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
			prdRaw.branchName = branchName;
			writeFileSync(prdPath, JSON.stringify(prdRaw, null, 2) + '\n', 'utf8');
		} catch { /* best-effort; the branch was already created by git checkout -B */ }
	};
}

/**
 * Run the post-audit actions after runPlanPhase returns (US-005, CAM-155).
 *
 * Extracted from makeProductionPlanPhaseFn to keep the outer closure and
 * outer function under biome's noExcessiveLinesPerFunction(maxLines=80) limit.
 * Reads issueNumber from prd.json (US-001, CAM-236: the branch name is
 * derived in code from issueNumber, never trusted from the planner-authored
 * prd.branchName string), builds escalateFn from Resend config, calls
 * runPostAuditAction, and flips the phase via exitPhaseAfterPlan.
 */
interface PostPlanActionsOpts {
	planResult: PlanPhaseResult;
	cwd: string;
	claudeDir: string;
	sessionName: string;
	loopSpawnFn: LoopSpawnFn;
	realSpawnFn: SpawnFn;
	logEvent: WorkerEventLogger;
}
function runPostPlanActions(o: PostPlanActionsOpts): void {
	let issueNumber: unknown;
	try {
		const prdRaw = JSON.parse(
			readFileSync(join(o.cwd, 'scripts/cam/prd.json'), 'utf8'),
		) as { issueNumber?: unknown };
		issueNumber = prdRaw.issueNumber;
	} catch { /* fallback: undefined; runPostAuditAction's missing-issueNumber gate no-ops */ }

	const resendCfg = readResendConfig(join(o.cwd, 'scripts/cam/project.toml'));
	const escalateFn = (resendCfg.apiKey !== '' && resendCfg.recipient !== '')
		? async (): Promise<void> => {
			await sendEscalation({
				apiKey: resendCfg.apiKey,
				recipient: resendCfg.recipient,
				subject: '[cam] Plan BLOCK: audit rejected the planning output',
				html: '<p><strong>[cam]</strong> The plan auditor blocked the planning phase. Manual intervention required.</p>',
			});
		}
		: undefined;

	const postAuditResult = runPostAuditAction({
		planResult: o.planResult,
		spawnFn: o.loopSpawnFn,
		setPhaseFn: makeSetPhaseFn(o.claudeDir, o.cwd),
		issueNumber,
		writePrdBranchNameFn: makeWritePrdBranchNameFn(o.cwd),
		readPlanApprovalFn: () => readPlanApproval(join(o.cwd, 'scripts/cam/project.toml')),
		escalateFn,
		// US-003 (CAM-200): thread the capture-pane reader + logEvent deps
		// sendKeysVerified needs (idle-gate + composer-emptied verify + bounded
		// retry, 'push-undelivered' on exhaustion).
		notifyFn: makeNotifyOrchestrator(
			o.sessionName,
			o.realSpawnFn,
			makeCapturePaneFn(o.realSpawnFn),
			adaptLogEventForPush(o.logEvent),
		),
		// US-004 (CAM-204, AC4): a converging run (audit-approved -> branch-created)
		// removes any pre-existing plan-escalation marker so a stale BLOCK
		// escalation from an earlier round/issue never outlives convergence.
		removeEscalationMarkerFn: () => removePlanEscalatedMarker(join(o.claudeDir, PLAN_ESCALATED_FILENAME)),
		// US-003 (CAM-203): structured event for the plan-target-invalid terminal.
		logEvent: o.logEvent,
		// US-003 (CAM-215): durable plan-preflight-failed marker writer.
		writePreflightFailedMarkerFn: makeWritePreflightFailedMarkerFn(o.claudeDir),
		// US-004 (CAM-215, Option B): remove the durable plan-preflight-failed
		// marker on ANY non-preflight-failed planResult (not gated on
		// convergence or issueId, unlike removeEscalationMarkerFn above).
		// removePlanPreflightFailedMarker never throws when the file is
		// already absent (best-effort unlinkSync).
		removePreflightFailedMarkerFn: () => removePlanPreflightFailedMarker(join(o.claudeDir, PLAN_PREFLIGHT_FAILED_FILENAME)),
	});
	exitPhaseAfterPlan(postAuditResult, makeSetPhaseFn(o.claudeDir, o.cwd)); // US-R1-002
}

/** Grouped container-isolation deps for the plan phase (US-006, CAM-152). */
interface PlanContainerOpts {
	workerIsolation: WorkerIsolation;
	preflightContainerFn: (() => PreflightResult) | undefined;
	escalateFn: (() => Promise<void>) | undefined;
}

/**
 * Build the container isolation deps for the plan phase (US-006, CAM-152).
 *
 * Reads worker_isolation from project.toml; builds a preflightWorkerContainer
 * closure (real spawnSync probe, no stat check) when isolation === 'container';
 * builds an escalateFn from Resend config when both apiKey and recipient are set.
 * In host mode all three fields are no-ops (undefined / 'host').
 *
 * Extracted from makeProductionPlanPhaseFn to keep the closure under biome's
 * noExcessiveLinesPerFunction(maxLines=80) limit (CAM-60 factory/helper pattern).
 * Not exported: tests inject options.runPlanPhaseFn directly.
 */
function buildPlanContainerOpts(cwd: string): PlanContainerOpts {
	const workerIsolation = readWorkerIsolation(join(cwd, 'scripts/cam/project.toml'));
	const preflightContainerFn: (() => PreflightResult) | undefined =
		workerIsolation === 'container'
			? (): PreflightResult => preflightWorkerContainer({
				probe: (args) => {
					const r = spawnSync('docker', args, {
						stdio: 'pipe',
						encoding: 'utf8',
					} as Parameters<typeof spawnSync>[2]);
					return {
						stdout: typeof r.stdout === 'string' ? r.stdout : '',
						exitCode: r.status ?? 1,
					};
				},
			})
			: undefined;
	const resendCfg = readResendConfig(join(cwd, 'scripts/cam/project.toml'));
	const escalateFn: (() => Promise<void>) | undefined =
		(resendCfg.apiKey !== '' && resendCfg.recipient !== '')
			? async (): Promise<void> => {
				await sendEscalation({
					apiKey: resendCfg.apiKey,
					recipient: resendCfg.recipient,
					subject: '[cam] Plan container not ready: preflight failed before worker spawn',
					html: '<p><strong>[cam]</strong> The plan phase container preflight failed. The cam-worker container is not ready. Manual intervention required.</p>',
				});
			}
			: undefined;
	return { workerIsolation, preflightContainerFn, escalateFn };
}

/** Grouped deps for runProductionPlanPhaseWithReplan (US-004, CAM-204). */
interface PlanWorkerRunDeps {
	cwd: string;
	claudeDir: string;
	sessionName: string;
	realSpawnFn: SpawnFn;
	logEvent: WorkerEventLogger;
	loopSpawnFn: LoopSpawnFn;
	preflightSpawnFn: PlanPreflightSpawnFn;
	plannerPaneId: string;
	planIssue: string | undefined;
	isPaneAlive: IsPaneAlive;
	ensureWorkerPane: () => string;
	containerOpts: PlanContainerOpts;
}

/**
 * Assemble the runPlanPhaseWithReplan options bag and execute it (US-004, CAM-204).
 *
 * Extracted from makeProductionPlanPhaseFn to keep that closure under biome's
 * noExcessiveLinesPerFunction(maxLines=80) limit. Wires the real
 * teardownPlanPanesFn (kill-pane, makeTeardownPlanPanesFn) and
 * writeEscalationMarkerFn (durable marker, makeWriteEscalationMarkerFn) seams
 * alongside every existing runPlanPhase dep.
 */
function runProductionPlanPhaseWithReplan(deps: PlanWorkerRunDeps): PlanPhaseResult {
	const {
		cwd, claudeDir, sessionName, realSpawnFn, logEvent, loopSpawnFn,
		preflightSpawnFn, plannerPaneId, planIssue, isPaneAlive, ensureWorkerPane, containerOpts,
	} = deps;
	return runPlanPhaseWithReplan({
		spawnFn: loopSpawnFn,
		isPaneAlive,
		sleepFn: (ms) => Bun.sleepSync(ms),
		genUuid: () => randomUUID(),
		selectIssueFn: () => selectPlanTargetFromFile(cwd, planIssue),
		// US-003 (CAM-203): thread the fresh-read plan_issue into runPlanPhaseWithReplan
		// as planTargetId. This is a pure LABEL: it keeps the plan-target-invalid
		// terminal's targetId in sync with what selectIssueFn actually resolved
		// against, without changing selectIssueFn's own wiring.
		planTargetId: planIssue,
		readPlanVerdictFn: makeReadPlanVerdict(cwd),
		readPlannerReportFn: () => {
			// Completion signal: prd.json written by the planner.
			const prdPath = join(cwd, 'scripts/cam/prd.json');
			try {
				if (!existsSync(prdPath)) return null;
				return readFileSync(prdPath, 'utf8');
			} catch { return null; }
		},
		preflightFn: () => runPlanPreflight({ cwd, spawnFn: preflightSpawnFn }),
		clock: Date.now,
		plannerPaneId,
		paneCountMutexFn: () => paneCountMutex(sessionName, realSpawnFn),
		logEvent,
		ensureWorkerPane,
		claudeDir,
		clearStalePlanArtifactsFn: makeClearStalePlanArtifacts(cwd),
		workerIsolation: containerOpts.workerIsolation,
		preflightContainerFn: containerOpts.preflightContainerFn,
		escalateFn: containerOpts.escalateFn,
		// US-004 (CAM-204): real kill-pane teardown + durable escalation marker.
		teardownPlanPanesFn: makeTeardownPlanPanesFn(claudeDir),
		writeEscalationMarkerFn: makeWriteEscalationMarkerFn(claudeDir),
	});
}

/**
 * Build the production runPlanPhaseFn closure (US-002/US-R1-001, CAM-151;
 * re-plan loop wiring US-004, CAM-204).
 *
 * Wires runPlanPhaseWithReplan with all deps: plannerPaneId (read fresh from
 * marker each call), paneCountMutexFn (session.ts paneCountMutex),
 * selectIssueFn (selectPlannableFromFile), preflightFn (runPlanPreflight),
 * readPlanVerdictFn (makeReadPlanVerdict), spawnFn (loop.ts SpawnFn shape),
 * isPaneAlive (and ensureWorkerPane for self-heal, AC1/AC2 US-001), sleepFn,
 * genUuid (randomUUID lowercased per CAM-23), clock, teardownPlanPanesFn
 * (real kill-pane, US-004 AC1) and writeEscalationMarkerFn (real durable
 * marker writer, US-004 AC1). runPlanPhaseWithReplan (US-003) drives the
 * BLOCK->re-plan loop itself and calls both seams at the correct boundaries;
 * this closure only wires them to real tmux/fs side effects.
 *
 * After runPlanPhaseWithReplan returns, calls runPostAuditAction with the
 * PlanPhaseResult (ADR 0006 section Decisao point 3; ADR-0012 for the
 * plan-escalated terminal): on APPROVE+auto this creates the feature branch,
 * commits prd.json, removes any stale plan-escalation marker (US-004 AC4),
 * and flips phase:implementing so the sidecar loop dispatches the first
 * implementer worker.
 *
 * US-006 / CAM-152: container isolation + plan-phase preflight are wired via
 * buildPlanContainerOpts (extracted to keep this closure under biome's 80-line
 * limit). In host mode, zero docker calls are made.
 *
 * Extracted from buildSidecarLoopDeps to keep that function under the biome
 * cognitive-complexity (<=15) and function-length (<=80 lines) limits.
 * Not exported: tests inject options.runPlanPhaseFn directly.
 *
 * The pane-count mutex check lives inside runPlanPhase (Step 3); no separate
 * mutex call is made by the outer loop.
 */
function makeProductionPlanPhaseFn(
	cwd: string,
	claudeDir: string,
	sessionName: string,
	logEvent: WorkerEventLogger,
	realSpawnFn: SpawnFn,
): () => void {
	// Build the plan_issue reader once (US-001, CAM-154); called fresh each invocation.
	const readPlanIssueFn = makeReadPlanIssue(claudeDir);
	return (): void => {
		// US-005 (CAM-155): outermost safety net -- any exception from runPlanPhase or
		// runPostAuditAction is caught here, logged, and the phase is forced back to
		// idle so the sidecar loop can continue. Never rethrows.
		try {
		// Read the plannerPaneId fresh on each call (mirrors ensureWorkerPane pattern).
		const plannerPaneId = readWorkerPaneMarker(claudeDir) ?? '%2';
		// Read plan_issue fresh on each invocation (US-001, CAM-154).
		const planIssue = readPlanIssueFn();

		// Build a loop.ts-compatible SpawnFn wrapping spawnSync with cwd.
		const loopSpawnFn: LoopSpawnFn = (cmd, args, spawnOpts) => {
			const result = spawnSync(cmd, args, {
				cwd,
				stdio: spawnOpts?.stdio ?? 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			return {
				stdout: typeof result.stdout === 'string' ? result.stdout : '',
				exitCode: result.status ?? null,
			};
		};

		// Build the preflight spawnFn (PlanPreflightSpawnFn shape: no stdio opt).
		const preflightSpawnFn: PlanPreflightSpawnFn = (bin, args) => {
			const r = spawnSync(bin, args, {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			return {
				stdout: typeof r.stdout === 'string' ? r.stdout : '',
				exitCode: r.status ?? 1,
			};
		};

		// Build isPaneAlive + ensureWorkerPane (AC1/AC2, US-001). Extracted to
		// makePlanPaneHelpers to keep this closure under biome's 80-line limit.
		const { isPaneAlive, ensureWorkerPane } = makePlanPaneHelpers(claudeDir, sessionName);

		// US-006 / CAM-152: container isolation deps for the plan phase.
		// In host mode all three fields are undefined/'host' (zero docker calls).
		// Extracted to buildPlanContainerOpts to keep this closure under biome's
		// noExcessiveLinesPerFunction(maxLines=80) limit.
		const containerOpts = buildPlanContainerOpts(cwd);

		const planResult = runProductionPlanPhaseWithReplan({
			cwd, claudeDir, sessionName, realSpawnFn, logEvent, loopSpawnFn,
			preflightSpawnFn, plannerPaneId, planIssue, isPaneAlive, ensureWorkerPane, containerOpts,
		});

		// Post-audit phase: read branchName, build escalateFn, run post-audit
		// action. Extracted to runPostPlanActions to keep this closure under
		// biome's noExcessiveLinesPerFunction(maxLines=80) limit.
		runPostPlanActions({ planResult, cwd, claudeDir, sessionName, loopSpawnFn, realSpawnFn, logEvent });
		} catch (err: unknown) {
			logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'sidecar-exit',
				detail: { reason: 'plan-phase-crash', error: err instanceof Error ? err.message : String(err) },
			});
			makeSetPhaseFn(claudeDir, cwd)('idle');
		}
	};
}

/**
 * Resolve the runMetaLoopObserveFn dep from SidecarOptions + context (US-004, CAM-139).
 *
 * Extracted from buildSidecarLoopDeps to keep that function under biome's
 * noExcessiveCognitiveComplexity(max=15) limit (each `??` and ternary adds +1).
 * The meta-loop section contains two nested ternaries which would push the parent
 * function over the limit. Extracted here, they live in a separate budget.
 *
 * Branching:
 *   meta_loop=observe -> production observe fn (wouldSelect / drained observe events only)
 *   meta_loop=auto    -> production dispatch fn, gated on worker_isolation=container
 *                        (US-001, CAM-208): host mode never arms the auto-dispatcher
 *                        (a permanent boot-time config mismatch, not the transient
 *                        per-tick container-preflight-not-ready refuse handled by
 *                        evaluateDrainPreconditions), and emits a single boot-time
 *                        warning instead (this function runs once at sidecar boot).
 *   meta_loop=off     -> undefined (zero behavior change for the default case)
 *
 * options.runMetaLoopObserveFn (the injected-seam override) always takes precedence
 * over the worker_isolation gate below, matching pre-existing test expectations.
 *
 * Exported for the regression test (US-001, CAM-208): buildMetaLoopFn is not called
 * per idle tick, so exercising it directly is the only way to assert the boot-time
 * warn fires exactly once.
 */
export function buildMetaLoopFn(
	ctx: SidecarLoopDepsCtx,
	options: SidecarOptions,
	logEvent: WorkerEventLogger,
	resendConfig: { apiKey: string; recipient: string },
): RunSidecarLoopOptions['runMetaLoopObserveFn'] {
	if (options.runMetaLoopObserveFn !== undefined) return options.runMetaLoopObserveFn;

	const configPath = join(ctx.cwd, 'scripts/cam/project.toml');
	const metaLoop = readMetaLoop(configPath);

	if (metaLoop === 'observe') {
		return makeProductionMetaLoopObserveFn(ctx.cwd, logEvent, resendConfig.apiKey, resendConfig.recipient);
	}

	if (metaLoop === 'auto') {
		const workerIsolation = readWorkerIsolation(configPath);
		if (workerIsolation !== 'container') {
			process.stderr.write(
				'[cam] meta_loop=auto requires worker_isolation=container; auto-chaining disabled in host mode\n',
			);
			return undefined;
		}
		return buildProductionDispatchFn(ctx, logEvent, resendConfig);
	}

	return undefined;
}

/**
 * Build the plan-phase injectable deps (US-002, CAM-151).
 *
 * Extracted from buildSidecarLoopDeps to keep it under the biome
 * noExcessiveCognitiveComplexity(max=15) limit. Each ?? adds +1 complexity;
 * two new plan-phase deps would push the parent function to 17. Extracted here,
 * they live in a separate function with its own complexity budget.
 */
function buildPlanPhaseDeps(
	ctx: SidecarLoopDepsCtx,
	options: SidecarOptions,
): Pick<SidecarLoopDepsResult, 'readLoopPhaseFn' | 'runPlanPhaseFn'> {
	const { cwd, claudeDir, sessionName, logEvent, realSpawnFn } = ctx;
	return {
		readLoopPhaseFn: options.readLoopPhaseFn ?? makeReadLoopPhase(claudeDir),
		runPlanPhaseFn: options.runPlanPhaseFn ?? makeProductionPlanPhaseFn(
			cwd, claudeDir, sessionName, logEvent, realSpawnFn,
		),
	};
}

/**
 * Build the ship-phase injectable dep (US-004, CAM-149).
 *
 * Extracted from buildSidecarLoopDeps to keep it under the biome
 * noExcessiveCognitiveComplexity(max=15) limit (CAM-60 factory/helper
 * pattern), mirroring buildPlanPhaseDeps.
 */
function buildShipPhaseDeps(
	ctx: SidecarLoopDepsCtx,
	options: SidecarOptions,
): Pick<SidecarLoopDepsResult, 'runShipPhaseFn'> {
	const { cwd, claudeDir, sessionName, logEvent, realSpawnFn } = ctx;
	return {
		runShipPhaseFn: options.runShipPhaseFn ?? makeProductionShipPhaseFn(
			cwd, claudeDir, sessionName, logEvent, realSpawnFn,
		),
	};
}

/**
 * Build the auto-chain deps: flipActiveFn, readImplementBlockedMarkerFn, and
 * autoShipFn (US-005, extended by US-003/CAM-214).
 *
 * plan_approval drives all three: in auto mode they close over the real
 * state-file/marker writes and reads; in operator mode all three stay
 * undefined (zero behavior change). readImplementBlockedMarkerFn is the
 * circuit-breaker read consulted by loop.ts immediately before flipActiveFn,
 * so it is gated on the SAME auto-mode condition as flipActiveFn itself
 * (AC3: the breaker is inert whenever flipActiveFn is absent).
 *
 * Extracted from buildSidecarLoopDeps to keep it under the biome
 * noExcessiveCognitiveComplexity(max=15) limit (CAM-60 factory/helper
 * pattern), mirroring buildPlanPhaseDeps/buildShipPhaseDeps.
 */
function buildAutoChainDeps(
	ctx: SidecarLoopDepsCtx,
	options: SidecarOptions,
): Pick<SidecarLoopDepsResult, 'flipActiveFn' | 'readImplementBlockedMarkerFn' | 'autoShipFn'> {
	const { cwd, claudeDir } = ctx;
	const planApproval = readPlanApproval(join(cwd, 'scripts/cam/project.toml'));
	const autoChainProduction = planApproval === 'auto'
		? {
				flipActiveFn: makeFlipActiveFn(claudeDir, cwd),
				readImplementBlockedMarkerFn: makeReadImplementBlockedMarkerFn(claudeDir),
				autoShipFn: makeAutoShipFn(claudeDir, cwd),
			}
		: {
				flipActiveFn: undefined as RunSidecarLoopOptions['flipActiveFn'],
				readImplementBlockedMarkerFn: undefined as RunSidecarLoopOptions['readImplementBlockedMarkerFn'],
				autoShipFn: undefined as RunSidecarLoopOptions['autoShipFn'],
			};
	return {
		flipActiveFn: options.flipActiveFn ?? autoChainProduction.flipActiveFn,
		readImplementBlockedMarkerFn:
			options.readImplementBlockedMarkerFn ?? autoChainProduction.readImplementBlockedMarkerFn,
		autoShipFn: options.autoShipFn ?? autoChainProduction.autoShipFn,
	};
}

/**
 * Build the implementing re-arm dep (US-003, CAM-195, Defect 1).
 *
 * Extracted from buildSidecarLoopDeps to keep it under the biome
 * noExcessiveCognitiveComplexity(max=15) limit (CAM-60 factory/helper
 * pattern), mirroring buildPlanPhaseDeps/buildShipPhaseDeps.
 *
 * hasPendingStoriesFn and readLoopPhaseFn are threaded in (rather than
 * re-resolved from options here) so this dep reuses the SAME resolved
 * closures the rest of buildSidecarLoopDeps already built, instead of a
 * second independent instance.
 */
function buildRearmDeps(
	ctx: SidecarLoopDepsCtx,
	options: SidecarOptions,
	hasPendingStoriesFn: () => boolean,
	planReadLoopPhaseFn: RunSidecarLoopOptions['readLoopPhaseFn'],
): Pick<SidecarLoopDepsResult, 'rearmImplementingFn'> {
	const { cwd, claudeDir } = ctx;
	const readLoopPhaseFn = planReadLoopPhaseFn ?? makeReadLoopPhase(claudeDir);
	return {
		rearmImplementingFn: options.rearmImplementingFn ??
			makeProductionRearmImplementingFn(claudeDir, cwd, hasPendingStoriesFn, readLoopPhaseFn),
	};
}

// ---------------------------------------------------------------------------
// Suggestion-follow-up filing (US-003, CAM-189)
// ---------------------------------------------------------------------------

/**
 * spawnSync-backed IssueFileSpawnFn (issue-file.ts's SpawnFn contract: raw
 * SpawnSyncReturns, encoding/env/input passthrough). Mirrors index.ts's
 * `_buildCreateIssueOpts` spawnFn exactly -- the same production wiring
 * `cam issue --file-local` uses -- so createLocalIssueOnMain's GIT_INDEX_FILE
 * env plumbing and cat-file --batch stdin both work unchanged here.
 */
function issueFileSpawnFn(
	cmd: string,
	args: string[],
	opts: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
): SpawnSyncReturns<string> {
	return spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;
}

/** Adapts IssueFileSpawnFn (env optional) to BacklogSpawnFn (no env param). */
function toBacklogSpawn(spawnFn: IssueFileSpawnFn): BacklogSpawnFn {
	return (cmd, args, o) => spawnFn(cmd, args, o);
}

/**
 * Resolves the project.toml-derived issue prefix + parentIssue id and files
 * each candidate finding via createLocalIssueOnMain. Extracted from
 * makeProductionFileSuggestionsFn's closure (US-001, CAM-264) so the
 * candidates.length > 0 guard doesn't push the closure over Biome's
 * cognitive-complexity ceiling.
 */
function fileCandidates(
	candidates: ReviewFinding[],
	provenance: FollowUpProvenance,
	deps: {
		cwd: string;
		spawnFn: IssueFileSpawnFn;
		clock: () => string;
		readProjectToml: () => string;
	},
): { filedIds: string[]; failedCount: number } {
	const { cwd, spawnFn, clock, readProjectToml } = deps;
	const config = parseToml(readProjectToml());
	const prefix = typeof config['issue_prefix'] === 'string' ? config['issue_prefix'] : 'CAM';
	const parentIssueId = resolveIssueId(provenance.parentIssue, prefix);
	const filedIds: string[] = [];
	let failedCount = 0;
	for (const finding of candidates) {
		const { title, description } = buildFollowUpIssue(finding, provenance);
		const outcome = createLocalIssueOnMain({
			cwd,
			title,
			description,
			spawnFn,
			clock,
			readProjectToml,
			...(parentIssueId !== null ? { derivedFrom: [parentIssueId] } : {}),
		});
		if (outcome.ok) {
			filedIds.push(outcome.id);
		} else {
			failedCount++;
		}
	}
	return { filedIds, failedCount };
}

/**
 * Build the production fileSuggestionsFn (US-003, CAM-189).
 *
 * Reads the current open backlog via readBacklogFromMain, dedups the
 * report's SUGGESTION findings against it (US-002 dedupSuggestions), and
 * files each surviving finding via createLocalIssueOnMain (default filing:
 * no specSource, so stage stays 'idea' and status 'open'). The working
 * branch is never touched: createLocalIssueOnMain always commits+pushes to
 * main directly (issue-file.ts's on-main commit-tree path), regardless of
 * the cwd's current checked-out branch.
 *
 * A createLocalIssueOnMain failure (diverged main, detached head, missing
 * main) for one finding is skip-and-warned: the finding is simply excluded
 * from filedIds and counted in failedCount, never thrown, so the remaining
 * findings in the batch still get attempted. When there is anything to
 * report (a file, a dup-skip, or a failure), one 'suggestion-filed' event is
 * logged for the audit trail.
 *
 * spawnFn is injected (production: issueFileSpawnFn, the real spawnSync
 * wrapper defined above) so tests can exercise the full dedup+file path with
 * a fake git plumbing recorder, exactly like createLocalIssueOnMain's own
 * unit tests, without spawning a real git binary. No 'claude' spawn is ever
 * issued: only git plumbing, via readBacklogFromMain/createLocalIssueOnMain.
 */
export function makeProductionFileSuggestionsFn(
	cwd: string,
	spawnFn: IssueFileSpawnFn,
	logEvent: WorkerEventLogger,
): NonNullable<RunSidecarLoopOptions['fileSuggestionsFn']> {
	const clock = () => new Date().toISOString();
	const readProjectToml = () => readFileSync(join(cwd, 'scripts/cam/project.toml'), 'utf8');
	return (report, provenance) => {
		const backlog = readBacklogFromMain(cwd, toBacklogSpawn(spawnFn));
		const candidates = dedupSuggestions(backlog, report);
		const dupSkipped = extractSuggestions(report).length - candidates.length;
		const { filedIds, failedCount } =
			candidates.length > 0
				? fileCandidates(candidates, provenance, { cwd, spawnFn, clock, readProjectToml })
				: { filedIds: [] as string[], failedCount: 0 };
		if (filedIds.length > 0 || dupSkipped > 0 || failedCount > 0) {
			logEvent({
				ts: clock(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'suggestion-filed',
				detail: { filedIds, dupSkipped, failedCount },
			});
		}
		return { filedIds, dupSkipped };
	};
}

/**
 * Resolve all injectable sidecar loop deps from SidecarOptions + context.
 *
 * Each dep follows the options-injection-or-production-default pattern: when
 * the option is provided (by tests), use it; otherwise build the real dep.
 * Extracted so runSidecar stays under the biome cognitive-complexity (<=15)
 * and function-length (<=80 lines) limits.
 */
function buildSidecarLoopDeps(ctx: SidecarLoopDepsCtx, options: SidecarOptions): SidecarLoopDepsResult {
	const { cwd, claudeDir, prdPath, sessionName, logEvent, realSpawnFn } = ctx;

	const readActiveFn = options.readActiveFn ?? makeReadActive(claudeDir);
	const clearActiveFn = options.clearActiveFn ?? makeClearActive(claudeDir, cwd);
	const hasPendingStoriesFn = options.hasPendingStoriesFn ?? makeHasPendingStories(prdPath);
	const sleepFn = options.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
	const hasSessionFn = options.hasSessionFn ?? (() => hasSession(sessionName, realSpawnFn));
	const acquireLockFn =
		options.acquireLockFn ??
		(() => { const built = buildSupervisorOptions(cwd); return built.acquireLock(); });
	const buildOptsFn =
		options.buildOptsFn ??
		(() => { const built = buildSupervisorOptions(cwd); return built.opts; });

	// US-007: Merge-watch wiring for CI-gated ship mode.
	const mergeMode = readMergeMode(join(cwd, 'scripts/cam/project.toml'));
	const runMergeWatchFn: RunSidecarLoopOptions['runMergeWatchFn'] =
		options.runMergeWatchFn ??
		(mergeMode === 'ci-gated'
			? makeProductionMergeWatchFn(cwd, claudeDir, sessionName, logEvent, realSpawnFn)
			: undefined);

	// US-005: plan_approval drives auto-chain wiring (flip + autoShip only in auto
	// mode; undefined in operator mode = zero behavior change). Extracted to
	// buildAutoChainDeps (US-003, CAM-214) to keep this function under the
	// biome noExcessiveCognitiveComplexity(max=15) limit.
	const { flipActiveFn, readImplementBlockedMarkerFn, autoShipFn } = buildAutoChainDeps(ctx, options);

	// US-003 (CAM-189): SUGGESTION-follow-up-filing hook. Unlike the auto-chain
	// pair above, this is wired unconditionally (both operator and auto
	// plan_approval mode): filing a non-blocking follow-up idea issue is not an
	// autonomy escalation, so it does not need the auto-mode gate.
	const readReviewReportFn: RunSidecarLoopOptions['readReviewReportFn'] =
		options.readReviewReportFn ?? makeReadReviewReport(cwd);
	const fileSuggestionsFn: RunSidecarLoopOptions['fileSuggestionsFn'] =
		options.fileSuggestionsFn ?? makeProductionFileSuggestionsFn(cwd, issueFileSpawnFn, logEvent);

	// US-R1-001: escalateFn from Resend config; only wired when both apiKey and
	// recipient are non-empty. Production logic extracted to makeProductionEscalateFn
	// to keep buildSidecarLoopDeps under biome cognitive-complexity limit.
	const resendConfig = readResendConfig(join(cwd, 'scripts/cam/project.toml'));
	const escalateFn: RunSidecarLoopOptions['escalateFn'] =
		options.escalateFn ?? makeProductionEscalateFn(resendConfig.apiKey, resendConfig.recipient);

	// US-004 / CAM-139: meta-loop wiring (observe | auto | off).
	// Extracted to buildMetaLoopFn to keep buildSidecarLoopDeps under the biome
	// noExcessiveCognitiveComplexity(max=15) limit.
	const runMetaLoopObserveFn = buildMetaLoopFn(ctx, options, logEvent, resendConfig);

	// US-002 / CAM-151: plan-phase deps extracted to a helper (biome complexity budget).
	const planPhaseDeps = buildPlanPhaseDeps(ctx, options);

	// US-004 / CAM-149: ship-phase dep extracted to a helper (biome complexity budget).
	const shipPhaseDeps = buildShipPhaseDeps(ctx, options);

	// US-003 (CAM-195, Defect 1): implementing re-arm, wired unconditionally
	// (resuming an already-in-flight PRD is a resilience fix, not an autonomy
	// escalation gated to meta_loop/plan_approval config like the pair above).
	// Extracted to buildRearmDeps to keep this function under the biome
	// noExcessiveCognitiveComplexity(max=15) limit.
	const rearmDeps = buildRearmDeps(ctx, options, hasPendingStoriesFn, planPhaseDeps.readLoopPhaseFn);

	return {
		readActiveFn, clearActiveFn, hasPendingStoriesFn, sleepFn, hasSessionFn,
		acquireLockFn, buildOptsFn, runMergeWatchFn, flipActiveFn, readImplementBlockedMarkerFn, autoShipFn,
		readReviewReportFn, fileSuggestionsFn, escalateFn,
		runMetaLoopObserveFn, ...planPhaseDeps, ...shipPhaseDeps, ...rearmDeps,
	};
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Boot-time container ensure/reconcile guard (US-001/CAM-176, US-007/CAM-192,
 * CAM-201). Runs `ensureContainerFn` (production: `makeProductionEnsureContainerFn`)
 * once at sidecar boot, in container mode only.
 *
 * FirewallError / ContainerConfigError / ToolchainMismatchError are caught
 * specifically (instanceof) so a bare catch cannot accidentally swallow an
 * unexpected runtime error; any other thrown value is rethrown.
 *
 * Returns `true` when the caller should abort boot (no worker will be
 * dispatched), `false` when it is safe to proceed into `runSidecarLoop`.
 *
 * Extracted from `runSidecar` to keep that function under biome's
 * noExcessiveCognitiveComplexity(max=15) limit (CAM-60 factory/helper pattern).
 *
 * US-001 (CAM-207): also owns the durable sidecar-stalled marker lifecycle.
 * A FirewallError writes the marker (reason 'firewall-init-failed') before
 * returning abort=true; every other return path (host mode no-op, or a
 * container-mode ensure that succeeds) removes any stale marker, since both
 * represent a healthy bring-up.
 */
function runContainerEnsureGuard(cwd: string, options: SidecarOptions): boolean {
	const stalledMarkerPath = join(cwd, '.claude', SIDECAR_STALLED_FILENAME);
	const isolation = readWorkerIsolation(join(cwd, 'scripts/cam/project.toml'));
	if (isolation !== 'container') {
		removeSidecarStalledMarker(stalledMarkerPath);
		return false;
	}

	try {
		(options.ensureContainerFn ?? makeProductionEnsureContainerFn(cwd))();
		removeSidecarStalledMarker(stalledMarkerPath);
		return false;
	} catch (e) {
		if (e instanceof FirewallError) {
			process.stderr.write(
				`[cam] container firewall init failed — no worker will be dispatched.\n${e.stderrTail}\n`,
			);
			writeSidecarStalledMarker(stalledMarkerPath, {
				reason: 'firewall-init-failed',
				detail: e.stderrTail,
				writtenAt: new Date().toISOString(),
			});
			return true;
		}
		if (e instanceof ContainerConfigError) {
			process.stderr.write(
				`[cam] container config repair failed — no worker will be dispatched.\n${e.stderrTail}\n`,
			);
			return true;
		}
		if (e instanceof ToolchainMismatchError) {
			process.stderr.write(
				`[cam] container toolchain mismatch — rebuild did not converge, no worker will be dispatched.\n${e.message}\n`,
			);
			fireEscalateBestEffort(buildToolchainEscalateFn(cwd));
			return true;
		}
		throw e;
	}
}

/**
 * Run the sidecar supervisor loop.
 *
 * This is the PRODUCTION caller of runSupervisor. It is spawned as a detached
 * background process by `cam run` and runs for the lifetime of the cam session.
 *
 * Returns a Promise<void> that never resolves (the process is killed by cam run's
 * cleanup handler on SIGINT/SIGTERM).
 */
export async function runSidecar(options: SidecarOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir = join(cwd, '.claude');
	const prdPath = join(cwd, 'scripts/cam/prd.json');

	const realSpawnFn: SpawnFn = (cmd, args, spawnOpts) =>
		spawnSync(cmd, args, spawnOpts as Parameters<typeof spawnSync>[2]);
	const sessionName = projectSessionName(cwd);
	const logEvent =
		options.logEventFn ?? makeFileEventLogger(join(claudeDir, 'cam-worker-events.jsonl'));

	// US-001 (PR-83): record the session-start timestamp exactly once, at
	// process startup, before the poll loop runs any active/idle cycle. See
	// session-start.ts for why the supervisor lock's startedAt cannot be
	// reused for this.
	(options.writeSessionStartFn ??
		((dir: string) => writeSidecarSessionStart(dir, new Date().toISOString())))(claudeDir);

	// US-002 (CAM-282): sweep an orphaned implement-blocked marker (issueId
	// points to an already-shipped/abandoned issue) BEFORE anything else can
	// read it -- the boot-surface, the auto-chain circuit-breaker read
	// (loop.ts:2194), and the plan-preflight clean-tree gate all happen later
	// in this process. Read-only on main; never touches the working tree.
	(options.sweepOrphanedImplementBlockedMarkerFn ??
		(() => sweepOrphanedImplementBlockedMarker(join(claudeDir, IMPLEMENT_BLOCKED_FILENAME), cwd)))();

	// US-001 / CAM-176: ensure the worker container is running AND apply the
	// egress firewall before dispatching (container mode only).
	// In host mode this block is a complete no-op (zero docker calls, zero
	// firewall calls).
	if (runContainerEnsureGuard(cwd, options)) return;

	const deps = buildSidecarLoopDeps(
		{ cwd, claudeDir, prdPath, sessionName, logEvent, realSpawnFn },
		options,
	);

	const loopFn = options.runSidecarLoopFn ?? runSidecarLoop;
	await loopFn({
		buildOpts: deps.buildOptsFn,
		readActive: deps.readActiveFn,
		clearActive: deps.clearActiveFn,
		sleep: deps.sleepFn,
		hasPendingStories: deps.hasPendingStoriesFn,
		acquireLock: deps.acquireLockFn,
		runSupervisorFn: options.runSupervisorFn,
		hasSessionFn: deps.hasSessionFn,
		logEvent,
		runMergeWatchFn: deps.runMergeWatchFn,
		flipActiveFn: deps.flipActiveFn,
		readImplementBlockedMarkerFn: deps.readImplementBlockedMarkerFn,
		autoShipFn: deps.autoShipFn,
		readReviewReportFn: deps.readReviewReportFn,
		fileSuggestionsFn: deps.fileSuggestionsFn,
		escalateFn: deps.escalateFn,
		runMetaLoopObserveFn: deps.runMetaLoopObserveFn,
		readLoopPhaseFn: deps.readLoopPhaseFn,
		runPlanPhaseFn: deps.runPlanPhaseFn,
		runShipPhaseFn: deps.runShipPhaseFn,
		rearmImplementingFn: deps.rearmImplementingFn,
	});
}
