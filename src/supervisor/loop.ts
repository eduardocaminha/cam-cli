// src/supervisor/loop.ts
//
// Supervisor loop that ties together the cam-cli autonomous execution primitives.
//
// runSupervisor picks the next action (decideNextAction), dispatches a worker,
// polls capture-pane for the sentinel, reads the outcome, and repeats until
// the loop reaches a terminal state: complete, blocked, or max-iterations.
//
// Design decisions:
//   - All side effects injected: spawn, capturePane, readPrd, writePrd,
//     readHandoff, clock, writeSessionMarker. The loop itself is pure over its
//     injectable interface, making it fully unit-testable with fakes.
//   - Workers are always interactive TUI sessions (claude -p is forbidden for
//     subscription accounts). Completion is detected by polling capture-pane
//     for the CAM_*_STATUS sentinel line.
//   - The worker SELF-SELECTS its story. The supervisor calls decideNextAction
//     only to decide implement-vs-review-vs-complete and for logging. The story
//     id from decideNextAction is advisory; the actual completed story comes from
//     handoff.json / the pane sentinel. This eliminates the two-independent-
//     selectors mismatch without touching the proven agent.
//   - writeSessionMarker is keyed to the actualStoryId from the outcome, never
//     to the advisory storyId from decideNextAction.
//   - Hard max-iterations cap (default MAX_ITERATIONS = 50) prevents runaway loops.
//   - worker-report.json is the canonical implementer completion-detect path
//     (US-002). buildSupervisorOptions in host.ts always injects readWorkerReport
//     so the report-file detection path is never skipped in production. When the
//     reader is present, parseAnySentinel is demoted to human-corroboration only:
//     a DONE sentinel in the pane without a matching report does NOT break the poll.

import { decideNextAction, DEFAULT_MAX_ROUNDS } from './decide.ts';
import type { PrdSnapshot } from './decide.ts';
import type { LoopPhase } from '../commands/status.ts';
import { readWorkerOutcome, parseAnySentinel } from './result.ts';
import type { WorkerOutcome } from './result.ts';
import { buildImplementerWorkerArgv } from './worker-argv.ts';
import { readPhaseModel, readBackend } from '../config/models.ts';
import { emitSpawnResolution } from '../logging/spawn-resolution.ts';
import { formatReviewVerdictLine, formatWorkerReportSummary, type WorkerReport } from './worker-report.ts';
import { buildResultDetail } from './events.ts';
import type { WorkerEventLogger, WorkerEventKind, WorkerEventDetail, TokensEventDetail, ReviewVerdictHandbackEventDetail, OutcomeSourceEventDetail, ContainerPreflightEventDetail } from './events.ts';
import type { PreflightResult } from './preflight-container.ts';

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

/**
 * Spawns a command synchronously.
 * Returns { stdout: string; exitCode: number | null }.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	opts?: { stdio?: 'pipe' | 'ignore' | 'inherit' },
) => { stdout: string; exitCode: number | null };

/**
 * Check whether a tmux pane is still alive.
 * Returns true if the pane exists; false if it has died.
 */
export type IsPaneAlive = (paneId: string) => boolean;

/**
 * Ensure a live worker pane exists and return its id (CAM-57).
 *
 * Called immediately before each `respawn-pane -k` dispatch (both implement
 * and review branches). If the currently-tracked pane id refers to a dead or
 * missing pane, the implementation creates a fresh pane, writes the new id to
 * the marker file, and returns it. If the pane is already live it is returned
 * unchanged. This makes the dispatch-side self-healing: the second loop in a
 * long-lived session works even when the worker pane was closed between runs.
 */
export type EnsureWorkerPane = () => string;

/**
 * Capture the visible text of a tmux pane.
 * Returns the captured text as a string.
 */
export type CapturePane = (paneId: string) => string;

/**
 * Read the current prd.json snapshot.
 * Returns null on missing or parse error.
 */
export type ReadPrd = () => PrdSnapshot | null;

/**
 * Read the current handoff.json.
 * Returns null on missing or parse error.
 */
export type ReadHandoff = () => HandoffSnapshot | null;

/**
 * Write a modified prd.json back to disk.
 * Called when the supervisor needs to update review state (US-008 wiring).
 */
export type WritePrd = (prd: PrdSnapshot) => void;

/**
 * Clock: returns the current ISO timestamp string.
 * Injected so tests can produce deterministic timestamps.
 */
export type ClockFn = () => string;

/**
 * Generate a new UUID (v4) string.
 * Injected for deterministic test fakes.
 */
export type GenUuid = () => string;

/**
 * Dispatch a review worker.
 * Receives a uuid for session tracking.
 * Returns the outcome of the review dispatch.
 */
export type ReviewDispatch = (uuid: string) => ReviewDispatchResult;

/** Result from reviewDispatch (placeholder shape for US-008). */
export interface ReviewDispatchResult {
	/** 'ok' if the review completed; 'error' on failure. */
	status: 'ok' | 'error';
	/** Human-readable detail string. */
	detail: string;
}

/**
 * Write the per-story worker session marker.
 * Called with the ACTUAL completed storyId (from handoff/sentinel), not advisory.
 */
export type WriteSessionMarker = (storyId: string, uuid: string) => void;

/**
 * Read the worker's structured exit report (scripts/cam/worker-report.json).
 * Returns the parsed WorkerReport on success, or null when the file is absent
 * or not yet written. Used by the implement poll loop to detect completion
 * (US-004); replaces the capturePane + parseAnySentinel path when injected.
 */
export type ReadWorkerReport = () => WorkerReport | null;

/**
 * Erase the worker report file before dispatching a new worker. This prevents
 * a stale report from a previous run from triggering a false-positive completion
 * on the first poll tick (US-004). Best-effort: absent file is fine.
 */
export type ClearWorkerReport = () => void;

/**
 * Minimal shape of handoff.json consumed by runSupervisor.
 * Passed through to readWorkerOutcome via the readFile adapter.
 */
export interface HandoffSnapshot {
	lastCompletedStory?: {
		id?: string;
		title?: string;
	};
	/** Files the worker created this story (surfaced for US-013 result events). */
	createdFiles?: string[];
	/** Files the worker modified this story (surfaced for US-013 result events). */
	modifiedFiles?: string[];
	/** Step-5.5 docs validated this story (surfaced for US-013 result events). */
	officialDocsValidated?: Array<{ lib?: string; status?: string; url?: string }>;
}

// ---------------------------------------------------------------------------
// Loop options & return type
// ---------------------------------------------------------------------------

/** Options bag for runSupervisor. */
export interface RunSupervisorOptions {
	/** Spawn a shell command (for respawn-pane etc.). */
	spawn: SpawnFn;
	/** Capture the visible pane text. */
	capturePane: CapturePane;
	/** Read the current prd.json. */
	readPrd: ReadPrd;
	/** Write back a modified prd.json. */
	writePrd: WritePrd;
	/** Read the current handoff.json. */
	readHandoff: ReadHandoff;
	/** Return current ISO timestamp. */
	clock: ClockFn;
	/** Generate a new UUID for a worker session. Defaults to crypto.randomUUID(). */
	genUuid?: GenUuid;
	/** Dispatch a review worker. Required for review branch. */
	reviewDispatch: ReviewDispatch;
	/** Persist the per-story session marker (keyed to actual completed story). */
	writeSessionMarker: WriteSessionMarker;
	/** Check whether the worker pane is still alive (used on timeout). */
	isPaneAlive: IsPaneAlive;
	/** Per-worker deadline in milliseconds. Default: DEFAULT_PER_WORKER_TIMEOUT_MS (30 min). */
	perWorkerTimeoutMs?: number;
	/**
	 * Per-worker cumulative token ceiling (CAM-5). When > 0 and readWorkerTokens
	 * is available, the sentinel poll loop reads the worker's spend each tick and
	 * kills the worker (terminal 'blocked') once spend >= this value. Default 0
	 * means DISABLED (no ceiling): the wall-clock timeout + the subscription
	 * rate-limit are the only bounds. Spend = input + cacheCreation + cacheRead,
	 * the same formula as the orchestrator budget (src/orchestrator/budget.ts).
	 */
	maxWorkerTokens?: number;
	/** Pane id of the worker slot. Must be pre-allocated by the caller. */
	workerPaneId: string;
	/** Absolute path to prd.json (for readWorkerOutcome). */
	prdPath: string;
	/** Absolute path to handoff.json (for readWorkerOutcome). */
	handoffPath: string;
	/**
	 * Absolute path to scripts/cam/worker-report.json (for readWorkerOutcome
	 * fallback when neither handoff nor DONE sentinel yield a story id).
	 * When provided, the fileReader adapter serves it via readWorkerReport.
	 * Optional: when absent, the fallback is simply skipped (backward compat).
	 */
	workerReportPath?: string;
	/** Claude permission mode forwarded to the worker. */
	permissionMode: string;
	/** Free-text task prompt sent to the implementer. */
	taskPrompt: string;
	/**
	 * Re-run quality gates (typecheck + test) to verify before finalizing a
	 * worker that implemented a story but did not flip prd.json (CAM-32 BUG 2).
	 * Optional; without it, an 'incomplete' outcome becomes blocked.
	 */
	runGates?: () => { ok: boolean; detail: string };
	/**
	 * Finalize a story the worker implemented but did not finalize: flip prd.json
	 * passes:true, commit, and push. Optional; without it, 'incomplete' is blocked.
	 */
	finalizeStory?: (storyId: string) => { ok: boolean; detail: string };
	/** Hard max iterations cap. Default: MAX_ITERATIONS (50). */
	maxIterations?: number;
	/**
	 * Polling interval in milliseconds for sentinel detection.
	 * Default: DEFAULT_POLL_INTERVAL_MS (5 seconds).
	 */
	pollIntervalMs?: number;
	/**
	 * Sleep between polling ticks. Injected so tests can use a no-op and avoid
	 * real delays. In production, defaults to Bun.sleepSync (synchronous).
	 */
	sleepFn?: (ms: number) => void;
	/**
	 * Random source for backoff jitter (CAM-85). Injected so tests can pin a
	 * deterministic value (e.g. () => 0.5 for zero jitter offset). Defaults to
	 * Math.random in production. Used only by computeBackoffMs at each retry site.
	 */
	randomFn?: () => number;
	/**
	 * Return current time in milliseconds. Injected for deterministic tests.
	 * Defaults to Date.now. Used for elapsed-time tracking in sentinel polling.
	 */
	nowMs?: () => number;
	/**
	 * Structured observability event sink (US-013). When provided, the supervisor
	 * emits worker-start / worker-end / result / tokens events per worker
	 * lifecycle. Optional: absent => no events (zero behavior change).
	 */
	logEvent?: WorkerEventLogger;
	/**
	 * Resolve per-story token usage for a worker uuid (US-013). Bound by the
	 * caller to cwd + claude config dir (see readWorkerTokens in events.ts).
	 * Returns null when the transcript is absent; a null result skips the
	 * 'tokens' event. Optional: absent => no 'tokens' events.
	 */
	readWorkerTokens?: (uuid: string) => TokensEventDetail | null;
	/**
	 * Read the worker's structured exit report (scripts/cam/worker-report.json).
	 * When injected, the implement poll loop uses this instead of capturePane +
	 * parseAnySentinel to detect worker completion (US-004). The report file
	 * presence is the push event; the report content corroborates but never
	 * sole-gates (prd.json + handoff.json remain the state-primary source).
	 * Optional: when absent the loop falls back to capturePane + parseAnySentinel.
	 */
	readWorkerReport?: ReadWorkerReport;
	/**
	 * Erase the worker report file before dispatching a new worker (US-004).
	 * Prevents a stale report from a previous run from triggering a false-positive
	 * completion on the first poll tick. Optional: best-effort, absent means no erase.
	 */
	clearWorkerReport?: ClearWorkerReport;
	/**
	 * Ensure a live worker pane exists before each dispatch (CAM-57).
	 *
	 * When injected, called immediately before every `respawn-pane -k` (in both
	 * the implement and review branches). If the currently-tracked pane is dead
	 * or missing, the implementation creates a fresh pane via
	 * `openPaneInSession`, writes the new id to the marker, and returns the new
	 * id. The returned id is used for `set-option @cam_label`, `respawn-pane
	 * -k`, and all subsequent poll calls in that dispatch.
	 *
	 * Optional: when absent the loop falls back to the current behavior (use
	 * the `workerPaneId` from options as-is). This keeps older callers and
	 * existing tests byte-for-byte unchanged.
	 */
	ensureWorkerPane?: EnsureWorkerPane;
	/**
	 * Verify that the worker's pass actually landed on origin before the supervisor
	 * continues the loop (US-001). Runs after writeSessionMarker, before continue.
	 * Returns { ok, pushed, sha, detail }:
	 *   ok:true  -> origin is in sync, loop continues unchanged.
	 *   ok:false -> supervisor degrades outcome to blocked and exits the loop.
	 *   pushed:true  -> git push moved origin (local was ahead).
	 *   pushed:false -> local sha already matched origin (no-op push).
	 * When absent, the pass branch is byte-for-byte unchanged (backward compatible).
	 */
	ensurePushed?: () => { ok: boolean; pushed: boolean; sha: string; detail: string };
	/**
	 * Per-iteration progress sink (US-001). When provided the supervisor calls it:
	 *   (a) Once per iteration, at the top, after decideNextAction resolves, with
	 *       at least { iteration, currentStoryId, storiesDone, storiesTotal,
	 *       lastActivity } and no terminalStatus.
	 *   (b) Once more on every terminal exit (complete / awaiting-operator /
	 *       blocked / max-iterations) with the same shape plus terminalStatus.
	 * Absent onProgress is a pure no-op; existing loop tests pass unchanged.
	 */
	onProgress?: OnProgress;
	/**
	 * Callback invoked after every non-error review dispatch (US-001).
	 * Receives a formatted verdict line and hands it to the wiring layer (e.g.
	 * tmux send-keys to the orchestrator pane). The loop does NOT contain any
	 * tmux details; this callback is the seam where wiring is injected.
	 *
	 * Line format (from formatReviewVerdictLine):
	 *   '[cam] review round N: CLEAN'
	 *   '[cam] review round N: FIXES_PENDING:K'
	 *   '[cam] review round N: MAX_ROUNDS_DEBT'
	 *
	 * Optional: when absent (undefined) the loop runs unchanged (no throw,
	 * no log line). Existing tests that do not inject this callback pass
	 * byte-for-byte unchanged.
	 */
	notifyOrchestrator?: (line: string) => void;
	/**
	 * Auto-ship callback for auto mode (US-005).
	 *
	 * When injected (plan_approval === 'auto'), called immediately after a CLEAN
	 * review verdict to dispatch /cam-ship without a human gate. In production
	 * this sends '/cam-ship Enter' to the orchestrator pane via tmux send-keys.
	 *
	 * Optional: when absent (operator mode or plan_approval != 'auto') the
	 * review branch is unchanged (zero behavior change for all existing tests).
	 */
	autoShipFn?: () => void;
	/**
	 * Best-effort escalation callback (US-007).
	 *
	 * When injected, called immediately after the MAX_ROUNDS_DEBT terminal is
	 * detected (non-convergence after maxRounds review rounds without CLEAN).
	 * The call is best-effort: any rejection is caught and logged; the pipeline
	 * always returns { status: 'complete' } regardless of escalation outcome.
	 *
	 * In production this calls sendEscalation() from src/notify/resend.ts with
	 * the configured Resend API key + recipient from project.toml.
	 *
	 * Optional: when absent (Resend unconfigured or operator mode without
	 * escalation) the non-convergence terminal is unchanged. All existing tests
	 * that do not inject this callback pass byte-for-byte unchanged.
	 */
	escalateFn?: () => Promise<void>;
	/**
	 * Container preflight seam (US-005 / B-1 observe-only).
	 *
	 * When injected, called once per implement dispatch immediately before the
	 * respawn-pane call. The PreflightResult is emitted to the logEvent sink as a
	 * 'container-preflight' event for observability. In B-1 the result does NOT
	 * gate, block, or alter the live host spawn: the worker always dispatches on
	 * the host regardless of ready/reason. B-2 (CAM-152) will flip this
	 * fail-closed using escalateFn.
	 *
	 * Optional: when absent (existing callers / tests that do not inject this dep)
	 * the loop behavior is byte-for-byte unchanged. The seam is the testable
	 * injection point; production wiring lives in host.ts.
	 */
	preflightContainerFn?: () => PreflightResult;
}

// ---------------------------------------------------------------------------
// Progress tracking types (US-001)
// ---------------------------------------------------------------------------

/**
 * Payload emitted by the supervisor to the optional onProgress callback.
 */
export interface ProgressPayload {
	/** 1-based iteration index at the time this callback fires. */
	iteration: number;
	/**
	 * Advisory story id the supervisor dispatched this iteration. Undefined for
	 * review, complete, blocked-no-implementable, and terminal-only emissions.
	 */
	currentStoryId: string | undefined;
	/** Count of non-operator stories where passes:true at emission time. */
	storiesDone: number;
	/** Total count of non-operator stories at emission time. */
	storiesTotal: number;
	/** ISO timestamp of this progress event (from the injected clock). */
	lastActivity: string;
	/**
	 * Set only on the terminal-exit emission (the second call per iteration for
	 * direct-terminal decisions; the only call for mid-iteration early returns).
	 */
	terminalStatus?: SupervisorStatus;
}

/** Optional per-iteration progress sink injected into RunSupervisorOptions. */
export type OnProgress = (payload: ProgressPayload) => void;

/** Terminal status returned by runSupervisor. */
export type SupervisorStatus = 'complete' | 'awaiting-operator' | 'blocked' | 'max-iterations';

/** Return value of runSupervisor. */
export interface SupervisorResult {
	/** Terminal state reached. */
	status: SupervisorStatus;
	/** How many full iterations were executed. */
	iterations: number;
	/** Outcome of the last worker run, or null if no worker ran. */
	lastOutcome: WorkerOutcome | null;
	/**
	 * Pending operator-required story ids, set only when status is
	 * 'awaiting-operator'. The autonomous loop finished everything it could
	 * (implement + review) and these ceremonies remain for the operator.
	 */
	pendingStoryIds?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum number of iterations before the loop stops. */
export const MAX_ITERATIONS = 50;

/** Default per-worker timeout in milliseconds (30 minutes). */
export const DEFAULT_PER_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

/** Default sentinel polling interval in milliseconds (5 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Max consecutive no-progress passes before the loop blocks (CAM-36). A worker
 * that no-ops (e.g. instant-exit: claude never initialises, so there is no
 * transcript, yet the pane shows nothing) leaves an empty captured pane, so
 * readWorkerOutcome falls back to the STALE handoff.json + prd.json and reports
 * kind:'pass' for the LAST completed story. Without this cap the loop
 * re-dispatches the same still-pending advisory story every iteration until
 * MAX_ITERATIONS, burning one claude invocation per turn. CAM-38 added a backoff
 * between retries (NO_PROGRESS_BACKOFF_MS), which makes more attempts
 * worthwhile. Cap is 4: streaks 1-3 sleep {60s,120s,240s} before streak 4
 * blocks, realizing the full three-step backoff window (CAM-171).
 */
export const MAX_NO_PROGRESS_RETRIES = 4;

/**
 * Base backoff (ms) before re-dispatching a story whose worker no-op'd (CAM-38,
 * CAM-85). Used as `base` in computeBackoffMs. Exponential formula:
 * min(MAX_BACKOFF_MS, NO_PROGRESS_BACKOFF_MS * 2^(streak-1)) before jitter.
 * With streak=1 this is 60s; streak=2 is 120s; streak=3 is 240s (all three
 * fire at cap=4 before streak 4 blocks). In production next.ts injects
 * Bun.sleepSync; tests inject a no-op sleepFn so they never actually wait.
 */
export const NO_PROGRESS_BACKOFF_MS = 60_000;

/**
 * Maximum backoff cap (ms) applied by computeBackoffMs (CAM-85). Prevents the
 * exponential from growing unboundedly on a long dead-worker or no-progress
 * streak. With NO_PROGRESS_BACKOFF_MS=60s and MAX_*_RETRIES=4, streaks 1-3
 * sleep {60s,120s,240s} and streak 4 blocks without sleeping (240s < 300s, so
 * the cap never actually binds at cap=4). The constant is exported so future
 * stories can raise the retry cap without modifying the max bound separately.
 */
export const MAX_BACKOFF_MS = 300_000;

/**
 * Jitter fraction applied symmetrically around the computed backoff (CAM-85).
 * A value of 0.2 means +/-20%: the actual sleep is in
 * [base*0.8, base*1.2] depending on the injected randomFn.
 * With randomFn() === 0.5 (the midpoint), jitter is exactly zero — useful for
 * deterministic tests.
 */
export const JITTER_FRACTION = 0.2;

/**
 * Pure helper: compute the exponential-with-jitter backoff for a given streak.
 *
 * Formula: min(max, base * 2^(streak-1)) * (1 + jitterFraction * (2*r - 1))
 *
 *   - streak=1 -> base * 1 (no doubling yet).
 *   - streak=2 -> base * 2, then jittered.
 *   - cap (max) prevents unbounded growth.
 *   - r=0.5 -> multiplier is exactly 1.0 (zero offset): use in deterministic tests.
 *   - r=0   -> multiplier is (1 - jitterFraction)  (-20% at the default fraction).
 *   - r=1   -> multiplier is (1 + jitterFraction)  (+20% at the default fraction).
 *
 * @param streak   Number of consecutive backoff retries so far (1-based).
 * @param opts     Base interval (ms), max cap (ms), jitter fraction, random source.
 * @returns        Milliseconds to sleep; always a non-negative integer.
 */
export function computeBackoffMs(
	streak: number,
	opts: {
		base: number;
		max: number;
		jitterFraction: number;
		random: () => number;
	},
): number {
	const exponential = Math.min(opts.max, opts.base * Math.pow(2, streak - 1));
	const jitter = 1 + opts.jitterFraction * (2 * opts.random() - 1);
	return Math.round(exponential * jitter);
}

/**
 * Max consecutive dead-pane / timeout outcomes before the loop blocks (CAM-44).
 * A worker that dies pre-result (pane-died) or never emits a sentinel (timeout)
 * leaves the story still passes:false, so decideNextAction re-dispatches it. When
 * the cause is persistent (a dead tmux server, a worker dying pre-session), the
 * loop would otherwise storm: re-dispatch every poll interval, burning
 * MAX_ITERATIONS in minutes with each spawn dying the same way. Mirroring the
 * CAM-36/38 no-progress guard, dead-pane outcomes get the same exponential-with-jitter
 * backoff via computeBackoffMs (base NO_PROGRESS_BACKOFF_MS, cap MAX_BACKOFF_MS) and
 * block after this many consecutive failures instead of spinning to the iteration cap.
 */
export const MAX_DEAD_WORKER_RETRIES = 4;

/**
 * Max review-dispatch attempts before the loop blocks (CAM-37). A reviewer
 * worker can silently no-op (claude instant-exit / rate-limited: empty output,
 * no `<review>` verdict) or its pane can be captured empty before it flushes,
 * making reviewDispatch return status:'error'. Rather than failing the whole
 * loop on one transient miss, the review branch re-dispatches with a fresh
 * uuid/channel up to this many times before blocking. reviewDispatch only
 * mutates prd.json on a non-error verdict, so retrying after 'error' is
 * side-effect free.
 */
export const MAX_REVIEW_DISPATCH_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Default injectable helpers (real-world defaults)
// ---------------------------------------------------------------------------

function defaultGenUuid(): string {
	return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// runSupervisor
// ---------------------------------------------------------------------------

/**
 * Run the cam supervisor loop.
 *
 * Iterates until one of four terminal states:
 *   - 'complete': decideNextAction returned complete (all stories pass, incl.
 *                 operator ones, and review is terminal).
 *   - 'awaiting-operator': implement + review are done (review clean) and only
 *                 operator-required ceremonies remain. Success, not a block.
 *   - 'blocked':  decideNextAction returned blocked-no-implementable, OR a
 *                 worker came back with kind='blocked'.
 *   - 'max-iterations': hard cap reached.
 *
 * All I/O is injected via RunSupervisorOptions so the loop is fully
 * unit-testable without spawning real tmux or claude processes.
 */
export async function runSupervisor(opts: RunSupervisorOptions): Promise<SupervisorResult> {
	const {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff: _readHandoff,
		clock,
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		prdPath,
		handoffPath,
		permissionMode,
		taskPrompt,
	} = opts;

	// CAM-57: mutable worker pane id. Re-resolved per dispatch via ensureWorkerPane
	// when injected; otherwise stays as the static value from opts (backward compat).
	let workerPaneId = opts.workerPaneId;

	const genUuid = opts.genUuid ?? defaultGenUuid;
	const maxIter = opts.maxIterations ?? MAX_ITERATIONS;
	const perWorkerTimeoutMs = opts.perWorkerTimeoutMs ?? DEFAULT_PER_WORKER_TIMEOUT_MS;
	const maxWorkerTokens = opts.maxWorkerTokens ?? 0;
	const runGates = opts.runGates;
	const finalizeStory = opts.finalizeStory;
	const ensureWorkerPane = opts.ensureWorkerPane;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	// Real sleep: use a no-op by default so tests never block; callers that want
	// actual sleeping must inject Bun.sleepSync (or similar).
	const sleepFn = opts.sleepFn ?? ((_ms: number) => {});
	// Random source for jitter in computeBackoffMs. Defaulted here so every
	// downstream call shares the same resolved fn without re-deriving.
	const randomFn = opts.randomFn ?? Math.random;
	const now = opts.nowMs ?? (() => Date.now());
	const logEvent = opts.logEvent;
	const readWorkerTokens = opts.readWorkerTokens;
	const ensurePushed = opts.ensurePushed;
	const onProgress = opts.onProgress;
	// US-004: report-file completion detection (optional; falls back to capturePane
	// + parseAnySentinel when absent for backward compat with existing callers).
	const readWorkerReport = opts.readWorkerReport;
	const clearWorkerReport = opts.clearWorkerReport;
	// Passed to readWorkerOutcome for the worker-report-fallback branch.
	const workerReportPath = opts.workerReportPath;
	// US-005 / B-1: container preflight seam. Observed-only in B-1; does not gate.
	const preflightContainerFn = opts.preflightContainerFn;

	// --- US-001 progress tracking helpers ---
	// Compute done/total counts from a PRD snapshot (non-operator stories only).
	function computeProgress(prd: PrdSnapshot): { storiesDone: number; storiesTotal: number } {
		const stories = prd.userStories ?? [];
		const implementable = stories.filter((s) => s.requires !== 'operator');
		return {
			storiesDone: implementable.filter((s) => s.passes === true).length,
			storiesTotal: implementable.length,
		};
	}

	// Tracks the most recent progress payload so terminal-exit emits can reuse
	// the iteration / storiesDone / storiesTotal values from the same iteration.
	let lastIterProgress: ProgressPayload = {
		iteration: 0,
		currentStoryId: undefined,
		storiesDone: 0,
		storiesTotal: 0,
		lastActivity: clock(),
	};

	// Emit a terminal-exit progress notification before every return path. No-op
	// when onProgress is absent (backward compatible).
	const notifyTerminal = (status: SupervisorStatus): void => {
		if (!onProgress) return;
		onProgress({ ...lastIterProgress, terminalStatus: status });
	};

	// --- US-013 structured event emitters (no-op when logEvent absent) ---
	const emit = (
		kind: WorkerEventKind,
		storyId: string | undefined,
		uuid: string,
		detail: WorkerEventDetail,
	): void => {
		if (!logEvent) return;
		logEvent({ ts: clock(), storyId, uuid, kind, detail });
	};
	// 'tokens' event: read the per-story transcript at worker end. Skipped when
	// no reader is wired or the transcript is absent (null) — never logs zeros.
	const emitTokens = (storyId: string | undefined, uuid: string): void => {
		if (!logEvent || !readWorkerTokens) return;
		const tokens = readWorkerTokens(uuid);
		if (tokens === null) return;
		logEvent({ ts: clock(), storyId, uuid, kind: 'tokens', detail: tokens });
	};

	let iterations = 0;
	let lastOutcome: WorkerOutcome | null = null;

	// CAM-36: counts consecutive worker passes that merely re-confirmed an
	// already-done story (zero PRD progress). See MAX_NO_PROGRESS_RETRIES.
	let noProgressStreak = 0;

	// CAM-44: counts consecutive dead-pane / timeout outcomes (a worker that
	// died pre-result or never emitted a sentinel). Without a backoff the loop
	// re-dispatches immediately and, when the cause is persistent, storms to
	// MAX_ITERATIONS in minutes. See MAX_DEAD_WORKER_RETRIES.
	let deadWorkerStreak = 0;

	outer: while (iterations < maxIter) {
		// --- Read current PRD state ---
		const prd = readPrd();
		if (prd === null) {
			// PRD unreadable: treat as blocked.
			notifyTerminal('blocked');
			return { status: 'blocked', iterations, lastOutcome };
		}

		// --- Decide next action ---
		const action = decideNextAction(prd);

		// --- US-001: emit top-of-iteration progress (after decideNextAction) ---
		{
			const { storiesDone, storiesTotal } = computeProgress(prd);
			lastIterProgress = {
				iteration: iterations + 1,
				currentStoryId: action.kind === 'implement' ? action.storyId : undefined,
				storiesDone,
				storiesTotal,
				lastActivity: clock(),
			};
			if (onProgress) onProgress(lastIterProgress);
		}

		// --- Handle terminal decisions ---
		if (action.kind === 'complete') {
			// US-002: cap-REENTRY promotion. When the loop re-enters with a prd that
			// already has roundsCompleted >= maxRounds and a non-terminal verdict
			// (e.g. 'FIXES_PENDING:1'), decideNextAction signals promoteVerdictTo so
			// the caller persists 'MAX_ROUNDS_DEBT' as the stored verdict BEFORE the
			// terminal return. This is the missing complement to the US-006 post-review
			// promotion (loop.ts ~1115-1148): that path fires after a review dispatch;
			// this path fires on cap-REENTRY when no review round runs this iteration.
			if (action.promoteVerdictTo === 'MAX_ROUNDS_DEBT') {
				const promoted: PrdSnapshot = {
					...prd,
					review: { ...(prd.review ?? {}), lastVerdict: 'MAX_ROUNDS_DEBT' },
				};
				writePrd(promoted);
				opts.notifyOrchestrator?.(
					formatReviewVerdictLine(prd.review?.roundsCompleted ?? 0, 'MAX_ROUNDS_DEBT'),
				);
			}
			notifyTerminal('complete');
			return { status: 'complete', iterations, lastOutcome };
		}

		if (action.kind === 'await-operator') {
			// All implementable work is done and reviewed clean; only operator
			// ceremonies remain. This is a successful terminal state, not a block.
			// US-002: same cap-REENTRY promotion as the 'complete' branch above.
			if (action.promoteVerdictTo === 'MAX_ROUNDS_DEBT') {
				const promoted: PrdSnapshot = {
					...prd,
					review: { ...(prd.review ?? {}), lastVerdict: 'MAX_ROUNDS_DEBT' },
				};
				writePrd(promoted);
				opts.notifyOrchestrator?.(
					formatReviewVerdictLine(prd.review?.roundsCompleted ?? 0, 'MAX_ROUNDS_DEBT'),
				);
			}
			notifyTerminal('awaiting-operator');
			return {
				status: 'awaiting-operator',
				iterations,
				lastOutcome,
				pendingStoryIds: action.pendingStoryIds,
			};
		}

		if (action.kind === 'blocked-no-implementable') {
			notifyTerminal('blocked');
			return { status: 'blocked', iterations, lastOutcome };
		}

		// --- Implement branch ---
		if (action.kind === 'implement') {
			// Advisory storyId is used for logging only.
			// The worker self-selects which story it actually implements.
			const advisoryStoryId = action.storyId;

			// Mint a fresh uuid for this invocation.
			const uuid = genUuid();

			// Resolve model/backend once so argv and the spawn-resolution event
			// report the identical resolved values (reviewer finding: double-read).
			const implModel = readPhaseModel('implementer');
			const implBackend = readBackend();

			// Build the shell command for the worker (always interactive TUI session).
			const shellCmd = buildImplementerWorkerArgv({
				uuid,
				taskPrompt,
				permissionMode,
				model: implModel,
			});

			// CAM-57: ensure a live worker pane exists before dispatching. When
			// ensureWorkerPane is injected it re-reads the marker and creates a
			// fresh pane if the current one is dead (self-heal for the 2nd loop in
			// a long-lived session). Without the injection the pane id is unchanged
			// (backward compat: existing callers and tests are unaffected).
			if (ensureWorkerPane !== undefined) {
				workerPaneId = ensureWorkerPane();
			}

			// US-002: set the worker pane label for this phase before respawning.
			// The pane-border-format #{@cam_label} at the session level picks this up,
			// rendering the same green pill that the orchestrator and dashboard panes use.
			// Best-effort: set-option -p is a no-op when the pane is not yet visible.
			spawn('tmux', ['-L', 'cam', 'set-option', '-p', '-t', workerPaneId, '@cam_label', 'implementer']);

			// US-004: erase any stale report from the previous worker run before
			// dispatching the new one. This prevents a leftover report file from
			// triggering a false-positive on the first poll tick of the new run.
			// Best-effort: clearWorkerReport handles the no-file case gracefully.
			clearWorkerReport?.();

			// US-005 / B-1: container preflight (observe-only, never gates in B-1).
			// Call the injectable seam so the PreflightResult is available before dispatch.
			// The result is threaded into the logEvent sink for observability; the host
			// spawn is UNCHANGED regardless of ready/reason (fail-closed is CAM-152 / B-2).
			if (preflightContainerFn !== undefined) {
				const preflightResult = preflightContainerFn();
				if (logEvent !== undefined) {
					const preflightDetail: ContainerPreflightEventDetail = preflightResult.ready
						? { ready: true }
						: { ready: false, reason: preflightResult.reason };
					logEvent({
						ts: clock(),
						storyId: advisoryStoryId,
						uuid,
						kind: 'container-preflight',
						detail: preflightDetail,
					});
				}
			}

			// US-007: emit structured {phase, model, backend} spawn-resolution event.
			// writeEvent bridges into the structured worker event log (logEvent sink).
			emitSpawnResolution({
				phase: 'implementer',
				model: implModel,
				backend: implBackend,
				writeEvent: logEvent
					? (e) => logEvent({ ts: clock(), storyId: advisoryStoryId, uuid, kind: 'spawn-resolution', detail: e })
					: undefined,
			});

			// Respawn the worker pane with the implementer command.
			// respawn-pane -k reuses the existing pane (no new split-window spawned).
			spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, shellCmd]);

			// US-013: worker-start. storyId is advisory here (the worker
			// self-selects); later events carry the actual completed story.
			emit('worker-start', advisoryStoryId, uuid, { mode: 'sentinel' });

			// Poll capture-pane until we see the sentinel, the pane dies, the token
			// ceiling is crossed (CAM-5), or timeout.
			const startMs = now();
			let pollOutcome: 'sentinel' | 'pane-died' | 'timeout' | 'token-ceiling' = 'timeout';
			let tokenSpendAtBreach = 0;

			while (true) {
				sleepFn(pollIntervalMs);
				if (!isPaneAlive(workerPaneId)) {
					pollOutcome = 'pane-died';
					break;
				}
				// US-002: worker-report.json is the canonical implementer completion-detect
				// path. When readWorkerReport is injected (always in production via
				// buildSupervisorOptions), the report file presence is the SOLE poll-exit
				// trigger. parseAnySentinel is demoted to human-corroboration only: a
				// DONE sentinel visible in the pane without a matching report does NOT
				// break the poll here. Falls back to capturePane + parseAnySentinel ONLY
				// when readWorkerReport is absent (backward compat with legacy callers).
				if (readWorkerReport !== undefined) {
					// US-006: staleness + shape guard on the PRIMARY poll-exit check.
					// A report whose story does not match the advisory story (stale
					// leftover from a previous run) is rejected here so the poll
					// continues — letting the pane-died / timeout nets with CAM-44
					// backoff remain the terminal signal. A malformed report (missing
					// string story / outcome discriminators) is also rejected so it
					// cannot cause a false poll-exit. When advisoryStoryId is absent,
					// skip the staleness part (graceful degradation for callers that
					// do not pass the dispatched story id).
					const report = readWorkerReport();
					const isValidFreshReport =
						report !== null &&
						typeof report.story === 'string' &&
						typeof report.outcome === 'string' &&
						(advisoryStoryId === undefined || report.story === advisoryStoryId);
					if (isValidFreshReport) {
						pollOutcome = 'sentinel';
						break;
					}
				} else {
					// W5 guard (US-FIX-006): only scan the LAST 10 lines of the pane.
					// The agent sentinel is always the final line of its output. Scanning
					// the full scrollback risks a false-positive if docs or templates
					// that contain a literal 'CAM_IMPLEMENTER_STATUS=DONE' string appear
					// anywhere earlier in the pane history (e.g. from CLAUDE.md displayed
					// in context or a template file being cat'd). Restricting to the tail
					// makes the guard exact: a sentinel in old scroll-history cannot fire.
					// (human-corroboration fallback only, not canonical detection)
					const polledText = capturePane(workerPaneId);
					const tail = polledText.split('\n').slice(-10).join('\n');
					if (parseAnySentinel(tail) !== null) {
						pollOutcome = 'sentinel';
						break;
					}
				}
				// CAM-5: opt-in per-worker token ceiling. Spend = input + cacheCreation
				// + cacheRead (same as computeOrchBudget). Disabled when maxWorkerTokens
				// is 0 or no token reader is wired.
				if (maxWorkerTokens > 0 && readWorkerTokens) {
					const tk = readWorkerTokens(uuid);
					if (tk) {
						const spend = tk.inputTokens + tk.cacheCreationTokens + tk.cacheReadTokens;
						if (spend >= maxWorkerTokens) {
							pollOutcome = 'token-ceiling';
							tokenSpendAtBreach = spend;
							break;
						}
					}
				}
				if (now() - startMs >= perWorkerTimeoutMs) {
					break; // timeout
				}
			}

			iterations++;

			// US-013: worker-end. pollOutcome records how it ended.
			emit('worker-end', advisoryStoryId, uuid, { mode: 'sentinel', pollOutcome });

			// CAM-5: token ceiling crossed. Kill the worker and stop terminally
			// (re-dispatching would only burn more tokens), bypassing the dead-worker
			// backoff path. Emitted before the pane-died/timeout handling below.
			if (pollOutcome === 'token-ceiling') {
				spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, 'echo token-ceiling']);
				emit('worker-token-ceiling', advisoryStoryId, uuid, {
					spend: tokenSpendAtBreach,
					ceiling: maxWorkerTokens,
				});
				lastOutcome = {
					kind: 'blocked',
					storyId: undefined,
					detail: `worker-token-ceiling: spend ${tokenSpendAtBreach} >= ceiling ${maxWorkerTokens} (advisory ${advisoryStoryId ?? 'unknown'})`,
				};
				notifyTerminal('blocked');
				return { status: 'blocked', iterations, lastOutcome };
			}

			// CAM-44: a dead pane (worker died pre-result) or a timeout (no sentinel
			// within the deadline) leaves the story unadvanced, so the next
			// decideNextAction re-dispatches it. When the cause is persistent this
			// storms to MAX_ITERATIONS. Apply the same escalating backoff + cap as
			// the no-progress guard: block cleanly after MAX_DEAD_WORKER_RETRIES
			// consecutive failures instead of spinning.
			if (pollOutcome === 'pane-died' || pollOutcome === 'timeout') {
				if (pollOutcome === 'timeout') {
					// Kill the stuck worker so the next dispatch starts from a clean pane.
					spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, 'echo timeout']);
				}
				deadWorkerStreak += 1;
				if (deadWorkerStreak >= MAX_DEAD_WORKER_RETRIES) {
					lastOutcome = {
						kind: 'blocked',
						storyId: undefined,
						detail: `dead-worker: ${deadWorkerStreak} consecutive ${pollOutcome} outcomes (advisory ${advisoryStoryId ?? 'unknown'})`,
					};
					notifyTerminal('blocked');
					return { status: 'blocked', iterations, lastOutcome };
				}
				lastOutcome = {
					kind: 'blocked',
					storyId: undefined,
					detail: pollOutcome === 'pane-died' ? 'pane-died-pre-result' : 'timeout',
				};
				const deadBackoffMs = computeBackoffMs(deadWorkerStreak, {
					base: NO_PROGRESS_BACKOFF_MS,
					max: MAX_BACKOFF_MS,
					jitterFraction: JITTER_FRACTION,
					random: randomFn,
				});
				emit('pane-died-retry', advisoryStoryId, uuid, {
					attempt: deadWorkerStreak,
					backoffMs: deadBackoffMs,
					pollOutcome,
				});
				sleepFn(deadBackoffMs);
				continue;
			}

			// Sentinel found: the worker ran to a sentinel (it did not die or time
			// out), so any prior dead-pane streak is broken regardless of the
			// outcome that follows (CAM-44).
			deadWorkerStreak = 0;

			// Sentinel found: read full pane text and determine outcome.
			const paneText = capturePane(workerPaneId);

			const fileReader = (path: string): string | null => {
				if (path === prdPath) {
					const snapshot = readPrd();
					return snapshot !== null ? JSON.stringify(snapshot) : null;
				}
				if (path === handoffPath) {
					const handoff = _readHandoff();
					return handoff !== null ? JSON.stringify(handoff) : null;
				}
				if (workerReportPath && path === workerReportPath) {
					const report = readWorkerReport ? readWorkerReport() : null;
					return report !== null ? JSON.stringify(report) : null;
				}
				return null;
			};

			const outcome = readWorkerOutcome({
				prdPath,
				handoffPath,
				workerReportPath,
				expectedStoryId: advisoryStoryId,
				capturedPaneText: paneText,
				readFile: fileReader,
			});

			lastOutcome = outcome;

			// US-013: result + tokens, keyed to the ACTUAL completed story.
			const actualStoryId = outcome.storyId ?? advisoryStoryId;
			emit('result', actualStoryId, uuid, buildResultDetail(outcome, _readHandoff()));
			emitTokens(actualStoryId, uuid);

			// US-005: emit outcome-fallback when readWorkerOutcome resolved via the
			// worker-report fallback path OR via handoff bare-string coercion.
			// Mirror the pane-died-retry pattern: thin detail, no new subsystem.
			if (
				outcome.detail.includes('worker-report-fallback') ||
				outcome.detail.includes('handoff-string-coerced')
			) {
				emit('outcome-fallback', actualStoryId, uuid, {
					fallbackKind: outcome.detail.includes('worker-report-fallback')
						? 'worker-report-fallback'
						: 'handoff-string-coerced',
					detail: outcome.detail,
				});
			}

			// US-005 (CAM-77): emit outcome-source on every readWorkerOutcome resolution.
			// Records which source won (worker-report.json vs legacy fallback) and the
			// integrity verdict so an operator can replay the decision without parsing
			// pane scrollback. No-op when logEvent is absent (emit() guards that).
			{
				const winningSrc: OutcomeSourceEventDetail['winningSrc'] =
					outcome.detail.includes('worker-report-fallback') ? 'worker-report' : 'fallback';
				const integrityResult: OutcomeSourceEventDetail['integrityResult'] =
					outcome.kind === 'pass'
						? 'confirmed-pass'
						: outcome.kind === 'incomplete'
							? 'incomplete'
							: 'stale-absent-rejection';
				emit('outcome-source', actualStoryId, uuid, {
					winningSrc,
					integrityResult,
					detail: outcome.detail,
				});
			}

			if (outcome.kind === 'pass' && outcome.storyId !== undefined) {
				writeSessionMarker(outcome.storyId, uuid);
				// US-001: verify the pass actually landed on origin before continuing.
				if (ensurePushed) {
					const pushCheck = ensurePushed();
					// US-002: structured audit record of the verification, emitted
					// whether ok or not, before any blocked return.
					emit('pushed', outcome.storyId, uuid, {
						sha: pushCheck.sha,
						pushed: pushCheck.pushed,
						ok: pushCheck.ok,
						detail: pushCheck.detail,
					});
					if (!pushCheck.ok) {
						lastOutcome = {
							kind: 'blocked',
							storyId: outcome.storyId,
							detail: `push-verification failed: ${pushCheck.detail}`,
						};
						opts.notifyOrchestrator?.(`[cam] ${lastOutcome.storyId ?? advisoryStoryId ?? 'unknown'} BLOCKED: ${lastOutcome.detail}`);
						notifyTerminal('blocked');
						return { status: 'blocked', iterations, lastOutcome };
					}
				}
			}

			if (
				outcome.kind === 'blocked' ||
				outcome.kind === 'fail' ||
				outcome.kind === 'unknown'
			) {
				opts.notifyOrchestrator?.(`[cam] ${lastOutcome.storyId ?? advisoryStoryId ?? 'unknown'} BLOCKED: ${lastOutcome.detail}`);
				notifyTerminal('blocked');
				return { status: 'blocked', iterations, lastOutcome };
			}

			if (
				outcome.kind === 'incomplete' &&
				outcome.storyId !== undefined &&
				runGates &&
				finalizeStory
			) {
				const gate = runGates();
				if (!gate.ok) {
					lastOutcome = {
						kind: 'blocked',
						storyId: outcome.storyId,
						detail: `finalize aborted, gates failed for ${outcome.storyId}: ${gate.detail}`,
					};
					opts.notifyOrchestrator?.(`[cam] ${lastOutcome.storyId ?? advisoryStoryId ?? 'unknown'} BLOCKED: ${lastOutcome.detail}`);
					notifyTerminal('blocked');
					return { status: 'blocked', iterations, lastOutcome };
				}
				const fin = finalizeStory(outcome.storyId);
				if (!fin.ok) {
					lastOutcome = {
						kind: 'blocked',
						storyId: outcome.storyId,
						detail: `finalize failed for ${outcome.storyId}: ${fin.detail}`,
					};
					opts.notifyOrchestrator?.(`[cam] ${lastOutcome.storyId ?? advisoryStoryId ?? 'unknown'} BLOCKED: ${lastOutcome.detail}`);
					notifyTerminal('blocked');
					return { status: 'blocked', iterations, lastOutcome };
				}
				lastOutcome = {
					kind: 'pass',
					storyId: outcome.storyId,
					detail: `supervisor-finalized ${outcome.storyId} after worker truncation: ${fin.detail}`,
				};
				writeSessionMarker(outcome.storyId, uuid);
				// CAM-36: a successful finalize is real progress; reset the no-op
				// streak so the "consecutive no-progress" semantics hold (review R1).
				noProgressStreak = 0;
				{ const r = readWorkerReport?.(); if (r) opts.notifyOrchestrator?.(formatWorkerReportSummary(r)); }
				continue;
			}

			if (outcome.kind === 'incomplete') {
				opts.notifyOrchestrator?.(`[cam] ${lastOutcome.storyId ?? advisoryStoryId ?? 'unknown'} BLOCKED: ${lastOutcome.detail}`);
				notifyTerminal('blocked');
				return { status: 'blocked', iterations, lastOutcome };
			}

			// CAM-36: no-progress guard. readWorkerOutcome is state-primary, so a
			// worker that no-op'd (instant-exit: empty captured pane, no transcript)
			// falls back to the stale handoff/prd and reports 'pass' for the LAST
			// completed story. Detect that the reported-completed story was ALREADY
			// passing at the top of THIS iteration (`prd`, already read): the worker
			// advanced nothing. Tolerate one transient, then block on the second in
			// a row instead of spinning to MAX_ITERATIONS. No extra PRD read.
			if (outcome.kind === 'pass' && outcome.storyId !== undefined) {
				const completedAlreadyPassing = (prd.userStories ?? []).some(
					(s) => s.id === outcome.storyId && s.passes === true,
				);
				if (completedAlreadyPassing) {
					noProgressStreak += 1;
					if (noProgressStreak >= MAX_NO_PROGRESS_RETRIES) {
						// storyId points at the ADVISORY story (the one that is stuck
						// and not advancing), not outcome.storyId (the stale already-
						// done story the worker re-confirmed). That is what an operator
						// needs to inspect.
						lastOutcome = {
							kind: 'blocked',
							storyId: advisoryStoryId,
							detail: `no-progress: ${noProgressStreak} consecutive worker passes re-confirmed an already-done story (advisory ${advisoryStoryId}, completed ${outcome.storyId})`,
						};
						// Fire the terminal progress callback so next.ts clears the
						// live state file (US-001 clear-on-exit). Every other terminal
						// return in this loop does this; the no-progress block is a
						// real terminal exit too.
						opts.notifyOrchestrator?.(`[cam] ${lastOutcome.storyId ?? advisoryStoryId ?? 'unknown'} BLOCKED: ${lastOutcome.detail}`);
						notifyTerminal('blocked');
						return { status: 'blocked', iterations, lastOutcome };
					}
					// CAM-38: still under the cap, so the loop will re-dispatch the
					// same still-pending story. Back off first (escalating by streak)
					// so a transient startup rate-limit whose message is never printed
					// can clear. A blind backoff is the only defense when the worker
					// produced no output.
					const noProgressBackoffMs = computeBackoffMs(noProgressStreak, {
						base: NO_PROGRESS_BACKOFF_MS,
						max: MAX_BACKOFF_MS,
						jitterFraction: JITTER_FRACTION,
						random: randomFn,
					});
					emit('no-progress-retry', advisoryStoryId, uuid, {
						attempt: noProgressStreak,
						backoffMs: noProgressBackoffMs,
						completedStory: outcome.storyId,
					});
					sleepFn(noProgressBackoffMs);
				} else {
					noProgressStreak = 0;
					// Genuine advance: story was NOT already passing. Notify the
					// orchestrator pane with the worker-report summary (US-003).
					{ const r = readWorkerReport?.(); if (r) opts.notifyOrchestrator?.(formatWorkerReportSummary(r)); }
				}
			}

			// PRD_COMPLETE sentinel (storyId === undefined): notify the orchestrator.
			// The genuine-advance case (storyId defined) already notified in the
			// else-branch above; this fires only for the PRD_COMPLETE path that
			// bypasses the no-progress guard.
			if (outcome.storyId === undefined) {
				const r = readWorkerReport?.();
				if (r) opts.notifyOrchestrator?.(formatWorkerReportSummary(r));
			}
			// PRD_COMPLETE or pass: loop will call decideNextAction next iteration.
			continue;
		}

		// --- Review branch ---
		if (action.kind === 'review') {
			// CAM-57: ensure a live worker pane exists before the review dispatch,
			// same self-heal as the implement branch above.
			if (ensureWorkerPane !== undefined) {
				workerPaneId = ensureWorkerPane();
			}

			// US-002: label the worker pane for the review phase.
			// Same pattern as the implement branch: set-option -p is best-effort.
			spawn('tmux', ['-L', 'cam', 'set-option', '-p', '-t', workerPaneId, '@cam_label', 'reviewer']);

			// CAM-37: a reviewer worker can silently no-op (instant-exit /
			// rate-limited: empty output, no `<review>` verdict) or its pane can be
			// captured before it flushes, making reviewDispatch return 'error'.
			// Retry with a fresh uuid up to MAX_REVIEW_DISPATCH_ATTEMPTS before
			// blocking, so one transient reviewer miss does not fail the whole loop.
			// reviewDispatch only writes prd.json on a real verdict, so retrying
			// after 'error' is side-effect free.
			let reviewResult: ReviewDispatchResult | null = null;
			let reviewUuid = '';
			for (let attempt = 1; attempt <= MAX_REVIEW_DISPATCH_ATTEMPTS; attempt += 1) {
				reviewUuid = genUuid();
				reviewResult = reviewDispatch(reviewUuid);
				if (reviewResult.status !== 'error') break;
			}

			iterations++;

			if (reviewResult === null || reviewResult.status === 'error') {
				// Review still failing after all attempts: treat as blocked.
				// US-005: best-effort notify the orchestrator so it narrates the blocker.
				const blockedDetail = reviewResult?.detail ?? 'pane died after retries';
				opts.notifyOrchestrator?.(`[cam] review BLOCKED: ${blockedDetail}`);
				notifyTerminal('blocked');
				return { status: 'blocked', iterations, lastOutcome };
			}

			// Re-read PRD to pick up the review verdict that reviewDispatch wrote.
			const updatedPrd = readPrd();
			if (updatedPrd !== null) {
				writePrd(updatedPrd);
			}

			// US-006: Non-convergence hard terminal.
			// When review hits maxRounds without CLEAN, promote the verdict to
			// MAX_ROUNDS_DEBT and return a terminal status WITHOUT continuing into
			// decideNextAction. This prevents a (maxRounds+1)-th fix dispatch
			// and exposes a deterministic seam US-007's escalation hooks on.
			// Auditor-no-APPROVE case: exhausting the review round cap without a
			// CLEAN verdict IS the deterministic terminal (no separate mechanism
			// needed; the maxRounds check is the single gate).
			if (updatedPrd !== null) {
				const ncRoundsCompleted = updatedPrd.review?.roundsCompleted ?? 0;
				const ncMaxRounds = updatedPrd.review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
				const ncLastVerdict = updatedPrd.review?.lastVerdict ?? null;
				if (ncRoundsCompleted >= ncMaxRounds && ncLastVerdict !== 'CLEAN') {
					// Promote the stored verdict to MAX_ROUNDS_DEBT so the prd.json
					// seam is deterministic for US-007 escalation.
					updatedPrd.review = { ...(updatedPrd.review ?? {}), lastVerdict: 'MAX_ROUNDS_DEBT' };
					writePrd(updatedPrd);
					// Notify orchestrator with the promoted verdict line.
					opts.notifyOrchestrator?.(formatReviewVerdictLine(ncRoundsCompleted, 'MAX_ROUNDS_DEBT'));
					// Emit structured event for the promotion.
					const promotionDetail: ReviewVerdictHandbackEventDetail = {
						verdict: 'MAX_ROUNDS_DEBT',
						round: ncRoundsCompleted,
					};
					emit('review-verdict-handback', undefined, reviewUuid, promotionDetail);
					// US-007: best-effort Resend escalation. Swallow any rejection so
					// the pipeline always reaches the 'complete' return below.
					if (opts.escalateFn !== undefined) {
						const escalateFn = opts.escalateFn;
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
					notifyTerminal('complete');
					return { status: 'complete', iterations, lastOutcome };
				}
			}

			// US-001: notify the orchestrator pane with the formatted verdict line.
			// Only fires when lastVerdict is non-null (reviewDispatch wrote a verdict).
			// The notifyOrchestrator callback carries no tmux details; the wiring layer
			// (US-002) supplies the actual send-keys call via the injected callback.
			if (opts.notifyOrchestrator !== undefined && updatedPrd !== null && updatedPrd.review?.lastVerdict != null) {
				const round = updatedPrd.review.roundsCompleted ?? 0;
				opts.notifyOrchestrator(formatReviewVerdictLine(round, updatedPrd.review.lastVerdict));
			}

			// US-004: emit a structured 'review-verdict-handback' event so the
			// handback is auditable independently of the pane scrollback.
			if (updatedPrd !== null && updatedPrd.review?.lastVerdict != null) {
				const handbackDetail: ReviewVerdictHandbackEventDetail = {
					verdict: updatedPrd.review.lastVerdict,
					round: updatedPrd.review.roundsCompleted ?? 0,
				};
				emit('review-verdict-handback', undefined, reviewUuid, handbackDetail);
			}

			// US-005: Auto-ship on CLEAN in auto mode.
			// When autoShipFn is injected (plan_approval === 'auto'), call it
			// immediately after a CLEAN verdict to dispatch /cam-ship without a
			// human gate. Inert when absent (operator mode or plan_approval != 'auto').
			if (opts.autoShipFn !== undefined && updatedPrd?.review?.lastVerdict === 'CLEAN') {
				opts.autoShipFn();
			}

			// CAM-36: a review iteration is real state-machine progress, so it
			// breaks any run of consecutive no-progress implement passes. Reset the
			// streak here so the "consecutive" semantics hold across a review (e.g.
			// no-op pass -> review FIXES_PENDING -> fresh implement starts at 0).
			// CAM-44: likewise breaks any dead-worker streak.
			noProgressStreak = 0;
			deadWorkerStreak = 0;

			// Continue: next iteration's decideNextAction will evaluate the verdict.
			continue;
		}
	}

	// Hard cap reached.
	notifyTerminal('max-iterations');
	return { status: 'max-iterations', iterations, lastOutcome };
}

// ---------------------------------------------------------------------------
// runSidecarLoop — outer active-flag gate (US-FIX-002 sidecar model)
// ---------------------------------------------------------------------------

/**
 * Options for the outer sidecar loop that gates on the active flag.
 * All dependencies are injectable for unit tests.
 */
export interface RunSidecarLoopOptions {
	/**
	 * Return the RunSupervisorOptions bag to use when active. Called once per
	 * sidecar cycle so the wiring can be rebuilt with a fresh onProgress closure.
	 */
	buildOpts: () => RunSupervisorOptions;
	/**
	 * Read the `active` flag from .claude/cam-loop.local.md.
	 * Returns undefined when the file is absent or unparseable.
	 */
	readActive: () => boolean | undefined;
	/**
	 * Set active:false in .claude/cam-loop.local.md after the supervisor
	 * reaches a terminal state.
	 */
	clearActive: () => void;
	/**
	 * Sleep between polls when inactive (ms).
	 * Injected so tests can use a no-op.
	 */
	sleep: (ms: number) => void;
	/**
	 * Poll interval when idle (no active flag set).
	 * Default: SIDECAR_IDLE_POLL_MS (2 000 ms).
	 */
	idlePollMs?: number;
	/**
	 * Check whether there are any non-operator stories with passes:false before
	 * calling runSupervisor. When this function returns false, the sidecar stays
	 * idle even if active:true (PRD is already done or empty). When absent,
	 * always defers to runSupervisor (which will return 'complete' quickly).
	 */
	hasPendingStories?: () => boolean;
	/**
	 * Acquire the single-supervisor lock. Returns { acquired:true } on success.
	 * Injected so tests never touch the filesystem.
	 */
	acquireLock: () => { acquired: true; release: () => void } | { acquired: false; holderPid: number };
	/**
	 * Run the supervisor inner loop. Injected for tests (default: runSupervisor).
	 */
	runSupervisorFn?: (opts: RunSupervisorOptions) => Promise<SupervisorResult>;
	/**
	 * Check whether the host tmux session (the one opened by `cam run`) is still
	 * alive. Returns true when the session exists, false when it is gone.
	 *
	 * Production wiring (src/commands/sidecar.ts) calls
	 *   hasSession(projectSessionName(cwd), spawnFn)
	 * on the dedicated -L cam socket. When absent, session-gone detection is
	 * disabled (sidecar runs until killed externally).
	 *
	 * Startup grace rule: the sidecar requires the session to have been observed
	 * PRESENT at least once (sessionSeen latch) before an absent-poll can trigger
	 * a self-exit. This prevents premature exit during the spawn-vs-session-creation
	 * race at startup.
	 *
	 * Injected so tests do not need a real tmux process.
	 */
	hasSessionFn?: () => boolean;
	/**
	 * Structured event sink for sidecar lifecycle events.
	 * When provided, the sidecar self-exit path writes a 'sidecar-exit' event.
	 * Production wiring: makeFileEventLogger('.claude/cam-worker-events.jsonl').
	 * Tests inject makeInMemoryEventLogger().logger to capture events.
	 */
	logEvent?: WorkerEventLogger;
	/**
	 * Run the merge-watch for a CI-gated PR (US-007).
	 *
	 * When injected, called on each idle tick (active !== true) BEFORE the
	 * session-health check and idle sleep. The function is responsible for
	 * checking whether a merge-watch file exists and, if so, advancing the
	 * merge-watch state machine by one step (via stepMergeWatch) and returning
	 * promptly. If no watch file is present, the function returns immediately (no-op).
	 *
	 * Only wired by the production sidecar (sidecar.ts) when the project config
	 * has [ship] merge_mode = "ci-gated". Under "immediate" mode this field is
	 * absent, making the merge-watch path completely inert with zero behavior
	 * change for existing projects and all tests that do not inject it.
	 */
	runMergeWatchFn?: () => Promise<void>;
	/**
	 * Run the meta-loop observer on each idle tick (US-004, CAM-132).
	 *
	 * When injected, called inside the active!==true branch ONLY when no PRD
	 * cycle is in flight (hasPendingStories() returns false, or hasPendingStories
	 * is absent). This additional gate ensures the observer stays silent when the
	 * sidecar is paused mid-cycle (active:false + pending stories present).
	 *
	 * Production wiring (sidecar.ts): undefined when meta_loop==='off' (default,
	 * zero behavior change for all existing projects and tests); calls observeDecide
	 * over selectPlannableFromFile on the MAIN backlog and emits a 'meta-loop-observe'
	 * event via logEvent when meta_loop==='observe'.
	 *
	 * Off path: when absent this tick is a complete no-op. Zero behavior change.
	 *
	 * Dedup state lives in a closure inside the production factory (NOT persisted
	 * to any file under .claude or the working tree).
	 */
	runMetaLoopObserveFn?: () => void | Promise<void>;
	/**
	 * Auto-chain active:true flip for auto mode (US-005).
	 *
	 * When injected (plan_approval === 'auto'), called after the supervisor
	 * reaches a terminal state AND hasPendingStories() returns true, to flip
	 * active:true immediately without waiting for a human cam-next call.
	 * In production this writes active:true to .claude/cam-loop.local.md.
	 *
	 * Optional: when absent (operator mode or plan_approval != 'auto') the loop
	 * calls clearActive() and sleeps as normal (zero behavior change).
	 */
	flipActiveFn?: () => void;
	/**
	 * Auto-ship callback for auto mode (US-005). When injected, threaded into
	 * RunSupervisorOptions.autoShipFn so the inner supervisor can call it after
	 * a CLEAN verdict. See RunSupervisorOptions.autoShipFn for full doc.
	 *
	 * Optional: when absent the supervisor runs unchanged.
	 */
	autoShipFn?: () => void;
	/**
	 * Best-effort escalation callback (US-R1-001).
	 *
	 * Threaded into RunSupervisorOptions.escalateFn on each supervisor run so
	 * the inner loop can call it when the MAX_ROUNDS_DEBT terminal is reached.
	 * In production this wraps sendEscalation() from src/notify/resend.ts using
	 * RESEND_API_KEY env var + resend_recipient from [notify] project.toml.
	 *
	 * Optional: when absent (Resend unconfigured) the non-convergence terminal
	 * is unchanged. Zero behavior change for all existing tests.
	 */
	escalateFn?: () => Promise<void>;
	/**
	 * Read the current loop phase from cam-loop.local.md (US-002, CAM-151).
	 *
	 * Returns undefined when the file is absent, unparseable, or the phase field
	 * is not present. Used to detect phase:'planning' and dispatch the plan runner
	 * as a sibling branch of the idle and implement paths.
	 *
	 * Production wiring (sidecar.ts): makeReadLoopPhase(claudeDir).
	 * Tests inject a controlled sequence or a constant-returning closure.
	 *
	 * Optional: when absent the planning detection path is fully inert, preserving
	 * zero behavior change for all existing tests.
	 */
	readLoopPhaseFn?: () => LoopPhase | undefined;
	/**
	 * Run the plan phase deterministically (US-002, CAM-151).
	 *
	 * When injected AND readLoopPhaseFn() returns 'planning', called once per tick.
	 * Wraps runPlanPhase with all deps wired: pane-count mutex check (Step 3),
	 * planner spawn (Step 4), planner poll (Step 5), auditor spawn (Step 6),
	 * auditor poll (Step 7).
	 *
	 * Production wiring (sidecar.ts): a closure over runPlanPhase(...) with
	 * plannerPaneId, paneCountMutexFn, selectIssueFn, preflightFn, spawnFn,
	 * isPaneAlive, sleepFn, genUuid, and clock all threaded in.
	 *
	 * Optional: when absent, phase:planning is silently ignored (zero behavior
	 * change for all existing tests that do not inject readLoopPhaseFn).
	 */
	runPlanPhaseFn?: () => void | Promise<void>;
}

/** Idle polling interval for the sidecar outer loop (2 seconds). */
export const SIDECAR_IDLE_POLL_MS = 2_000;

/**
 * The outer sidecar loop: gated on the `active` flag in cam-loop.local.md.
 *
 * When active:false (or absent): idle — poll via sleep.
 * When active:true AND pending non-operator stories: acquire lock + call runSupervisor.
 * On terminal SupervisorResult: call clearActive() to set active:false.
 *
 * Session self-exit (startup grace): on each idle tick, if hasSessionFn is wired,
 * the loop checks whether the host tmux session still exists. The sessionSeen latch
 * (one-shot flag set on the first PRESENT poll) provides startup grace: an absent
 * result cannot trigger self-exit until the session has been seen at least once.
 * Once the latch is set, an absent poll causes the loop to return cleanly. The lock
 * is NOT held during idle ticks, so no lock.release() is needed on the exit path.
 *
 * This function returns when the host session is gone (hasSessionFn wired + sessionSeen
 * latched + session absent). Otherwise it runs until the process is killed by cam run's
 * SIGINT/SIGTERM cleanup handler. All I/O is injectable for unit tests.
 */
export async function runSidecarLoop(opts: RunSidecarLoopOptions): Promise<void> {
	const idlePollMs = opts.idlePollMs ?? SIDECAR_IDLE_POLL_MS;
	const runSupervisorFn = opts.runSupervisorFn ?? runSupervisor;

	// Startup grace latch: must see the session PRESENT at least once before
	// an absent-poll can trigger self-exit (prevents premature exit on startup race).
	let sessionSeen = false;

	while (true) {
		const active = opts.readActive();

		// US-002 / CAM-151: plan-phase branch (sibling of the idle and implement
		// branches; mutually exclusive via the phase enum). phase:planning derives
		// active:false, so this guard MUST precede the active!==true idle check to
		// avoid silently falling into the idle path on a planning tick.
		// The pane-count mutex check lives inside runPlanPhaseFn (mirrors Step 3 of
		// runPlanPhase), so no separate mutex call is needed here.
		const loopPhase = opts.readLoopPhaseFn?.();
		if (loopPhase === 'planning' && opts.runPlanPhaseFn !== undefined) {
			// US-005 (CAM-155): outer guard -- a throwing injected runPlanPhaseFn cannot
			// kill the loop. loop.ts has no phase-setter; phase->idle lives in the closure.
			try {
				await opts.runPlanPhaseFn();
			} catch (err: unknown) {
				opts.logEvent?.({
					ts: new Date().toISOString(),
					storyId: undefined,
					uuid: 'sidecar',
					kind: 'sidecar-exit',
					detail: { reason: 'plan-phase-crash-outer', error: err instanceof Error ? err.message : String(err) },
				});
			}
			opts.sleep(idlePollMs);
			continue;
		}

		if (active !== true) {
			// US-007: run the merge-watch when ci-gated mode is active and a watch
			// file is present. The function is injected by sidecar.ts only when
			// merge_mode == "ci-gated"; under "immediate" it is absent (inert).
			// runMergeWatchFn checks the watch file itself and returns immediately
			// when none is present, so calling it on every idle tick is a no-op
			// in the common case.
			if (opts.runMergeWatchFn) {
				await opts.runMergeWatchFn();
			}

			// US-004 / CAM-132: meta-loop observer on idle ticks.
			// Only called when no PRD cycle is in flight:
			//   hasPendingStories() == false => prd.json absent OR all stories done
			//   + review terminal. Both are "between cycles" (appropriate for observe).
			//   When hasPendingStories is absent, treat as "no cycle" (observe allowed).
			if (opts.runMetaLoopObserveFn) {
				const prdInFlight = opts.hasPendingStories ? opts.hasPendingStories() : false;
				if (!prdInFlight) {
					await opts.runMetaLoopObserveFn();
				}
			}

			// Idle: check session health when a checker is wired.
			// Startup grace: only exit when sessionSeen is latched AND session is gone.
			// The lock is NOT held during idle, so no lock.release() is needed here.
			if (opts.hasSessionFn) {
				const sessionGone = !opts.hasSessionFn();
				if (!sessionGone) {
					sessionSeen = true;
				} else if (sessionSeen) {
					// Session was alive, now gone: the cam run host died abnormally.
					// Emit a structured 'sidecar-exit' event so the operator can diagnose
					// the self-exit from the event log without reading source.
					opts.logEvent?.({
						ts: new Date().toISOString(),
						storyId: undefined,
						uuid: 'sidecar',
						kind: 'sidecar-exit',
						detail: { reason: 'session-absent' },
					});
					return;
				}
			}
			opts.sleep(idlePollMs);
			continue;
		}

		// active:true: check if there is work to do.
		const hasPending = opts.hasPendingStories ? opts.hasPendingStories() : true;
		if (!hasPending) {
			// Nothing pending even though active was set. Clear the flag and idle.
			opts.clearActive();
			opts.sleep(idlePollMs);
			continue;
		}

		// Acquire the supervisor lock before running.
		const lockResult = opts.acquireLock();
		if (!lockResult.acquired) {
			// Another supervisor is already running (e.g. a concurrent cam next).
			// Idle and retry.
			opts.sleep(idlePollMs);
			continue;
		}

		// Run the deterministic loop. Guards (CAM-36, CAM-44, MAX_ITERATIONS,
		// event log) all live inside runSupervisor — unchanged.
		let result: SupervisorResult;
		try {
			const supervisorOpts = opts.buildOpts();
			// US-005: Thread autoShipFn from RunSidecarLoopOptions into
			// RunSupervisorOptions so the inner loop can call it after a CLEAN
			// verdict. Only injected when plan_approval === 'auto'; absent in
			// operator mode (zero behavior change for existing callers).
			if (opts.autoShipFn !== undefined) {
				supervisorOpts.autoShipFn = opts.autoShipFn;
			}
			// US-R1-001: Thread escalateFn into RunSupervisorOptions so the inner
			// loop can call it when the MAX_ROUNDS_DEBT terminal is reached.
			// Only wired when RESEND_API_KEY env var + resend_recipient are set.
			if (opts.escalateFn !== undefined) {
				supervisorOpts.escalateFn = opts.escalateFn;
			}
			result = await runSupervisorFn(supervisorOpts);
		} finally {
			// Release the lock whether the run succeeded or threw.
			lockResult.release();
		}

		// Terminal state reached: set active:false so cam status shows 'paused'.
		// The onProgress callback inside buildOpts() may have already updated the
		// state file; clearActive() is the safety net that ensures active:false
		// even when onProgress was absent or failed.
		opts.clearActive();

		// US-005: Auto-chain in auto mode. When flipActiveFn is injected
		// (plan_approval === 'auto') and pending work remains, flip active:true
		// immediately so the sidecar re-triggers without waiting for a human
		// cam-next call. Skip the idle sleep on the auto-chain path.
		if (opts.flipActiveFn !== undefined && opts.hasPendingStories && opts.hasPendingStories()) {
			opts.flipActiveFn();
			continue; // head straight back to the active-flag poll
		}

		// Prevent busy-spin on rapid complete/blocked cycles (e.g. empty PRD).
		// A short sleep lets the sidecar settle before the next poll.
		void result; // result is available for logging if needed
		opts.sleep(idlePollMs);
	}
}
