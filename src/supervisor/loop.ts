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

import { decideNextAction } from './decide.ts';
import type { PrdSnapshot } from './decide.ts';
import { readWorkerOutcome, parseAnySentinel } from './result.ts';
import type { WorkerOutcome } from './result.ts';
import { buildImplementerWorkerArgv } from './worker-argv.ts';
import type { WorkerReport } from './worker-report.ts';
import { buildResultDetail } from './events.ts';
import type { WorkerEventLogger, WorkerEventKind, WorkerEventDetail, TokensEventDetail } from './events.ts';

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
 * between retries (NO_PROGRESS_BACKOFF_MS), which makes a couple more attempts
 * worthwhile, so the cap is 3 (block on the 3rd consecutive no-op after two
 * paused retries).
 */
export const MAX_NO_PROGRESS_RETRIES = 3;

/**
 * Base backoff (ms) before re-dispatching a story whose worker no-op'd (CAM-38).
 * The most likely cause of a pre-session instant-exit is a startup rate-limit,
 * whose message is never printed, so US-016 rate-limit detection cannot fire and
 * the durable out-log captures nothing. A blind escalating backoff
 * (NO_PROGRESS_BACKOFF_MS * streak) is the only defense: it gives the rate-limit
 * window a few minutes to clear across the bounded retries before blocking. With
 * the current values the worst-case total wait before blocking is
 * NO_PROGRESS_BACKOFF_MS * (1 + 2 + ... + (MAX_NO_PROGRESS_RETRIES - 1)) = 180s.
 * This is best-effort: a longer (usage-tier) rate-limit still blocks, and the
 * operator re-runs once it clears. In production next.ts injects Bun.sleepSync;
 * tests inject a no-op sleepFn so they never actually wait.
 */
export const NO_PROGRESS_BACKOFF_MS = 60_000;

/**
 * Max consecutive dead-pane / timeout outcomes before the loop blocks (CAM-44).
 * A worker that dies pre-result (pane-died) or never emits a sentinel (timeout)
 * leaves the story still passes:false, so decideNextAction re-dispatches it. When
 * the cause is persistent (a dead tmux server, a worker dying pre-session), the
 * loop would otherwise storm: re-dispatch every poll interval, burning
 * MAX_ITERATIONS in minutes with each spawn dying the same way. Mirroring the
 * CAM-36/38 no-progress guard, dead-pane outcomes get the same escalating
 * NO_PROGRESS_BACKOFF_MS * streak backoff and block after this many consecutive
 * failures instead of spinning to the iteration cap.
 */
export const MAX_DEAD_WORKER_RETRIES = 3;

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
		workerPaneId,
		prdPath,
		handoffPath,
		permissionMode,
		taskPrompt,
	} = opts;

	const genUuid = opts.genUuid ?? defaultGenUuid;
	const maxIter = opts.maxIterations ?? MAX_ITERATIONS;
	const perWorkerTimeoutMs = opts.perWorkerTimeoutMs ?? DEFAULT_PER_WORKER_TIMEOUT_MS;
	const maxWorkerTokens = opts.maxWorkerTokens ?? 0;
	const runGates = opts.runGates;
	const finalizeStory = opts.finalizeStory;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	// Real sleep: use a no-op by default so tests never block; callers that want
	// actual sleeping must inject Bun.sleepSync (or similar).
	const sleepFn = opts.sleepFn ?? ((_ms: number) => {});
	const now = opts.nowMs ?? (() => Date.now());
	const logEvent = opts.logEvent;
	const readWorkerTokens = opts.readWorkerTokens;
	const ensurePushed = opts.ensurePushed;
	const onProgress = opts.onProgress;
	// US-004: report-file completion detection (optional; falls back to capturePane
	// + parseAnySentinel when absent for backward compat with existing callers).
	const readWorkerReport = opts.readWorkerReport;
	const clearWorkerReport = opts.clearWorkerReport;

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
			notifyTerminal('complete');
			return { status: 'complete', iterations, lastOutcome };
		}

		if (action.kind === 'await-operator') {
			// All implementable work is done and reviewed clean; only operator
			// ceremonies remain. This is a successful terminal state, not a block.
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

			// Build the shell command for the worker (always interactive TUI session).
			const shellCmd = buildImplementerWorkerArgv({
				uuid,
				taskPrompt,
				permissionMode,
			});

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
				// US-004: primary completion-detection path. When a readWorkerReport
				// reader is injected, poll the report file instead of the pane text.
				// The file presence is the push event; report content corroborates but
				// never sole-gates (prd.json + handoff.json are consulted in
				// readWorkerOutcome below). Falls back to capturePane + parseAnySentinel
				// when no reader is provided (backward compat with existing callers).
				if (readWorkerReport !== undefined) {
					if (readWorkerReport() !== null) {
						pollOutcome = 'sentinel';
						break;
					}
				} else {
					const polledText = capturePane(workerPaneId);
					if (parseAnySentinel(polledText) !== null) {
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
				emit('pane-died-retry', advisoryStoryId, uuid, {
					attempt: deadWorkerStreak,
					backoffMs: NO_PROGRESS_BACKOFF_MS * deadWorkerStreak,
					pollOutcome,
				});
				sleepFn(NO_PROGRESS_BACKOFF_MS * deadWorkerStreak);
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
				return null;
			};

			const outcome = readWorkerOutcome({
				prdPath,
				handoffPath,
				capturedPaneText: paneText,
				readFile: fileReader,
			});

			lastOutcome = outcome;

			// US-013: result + tokens, keyed to the ACTUAL completed story.
			const actualStoryId = outcome.storyId ?? advisoryStoryId;
			emit('result', actualStoryId, uuid, buildResultDetail(outcome, _readHandoff()));
			emitTokens(actualStoryId, uuid);

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
				continue;
			}

			if (outcome.kind === 'incomplete') {
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
						notifyTerminal('blocked');
						return { status: 'blocked', iterations, lastOutcome };
					}
					// CAM-38: still under the cap, so the loop will re-dispatch the
					// same still-pending story. Back off first (escalating by streak)
					// so a transient startup rate-limit whose message is never printed
					// can clear. A blind backoff is the only defense when the worker
					// produced no output.
					emit('no-progress-retry', advisoryStoryId, uuid, {
						attempt: noProgressStreak,
						backoffMs: NO_PROGRESS_BACKOFF_MS * noProgressStreak,
						completedStory: outcome.storyId,
					});
					sleepFn(NO_PROGRESS_BACKOFF_MS * noProgressStreak);
				} else {
					noProgressStreak = 0;
				}
			}

			// PRD_COMPLETE sentinel (storyId === undefined) or pass: loop will call
			// decideNextAction next iteration.
			continue;
		}

		// --- Review branch ---
		if (action.kind === 'review') {
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
			for (let attempt = 1; attempt <= MAX_REVIEW_DISPATCH_ATTEMPTS; attempt += 1) {
				const uuid = genUuid();
				reviewResult = reviewDispatch(uuid);
				if (reviewResult.status !== 'error') break;
			}

			iterations++;

			if (reviewResult === null || reviewResult.status === 'error') {
				// Review still failing after all attempts: treat as blocked.
				notifyTerminal('blocked');
				return { status: 'blocked', iterations, lastOutcome };
			}

			// Re-read PRD to pick up the review verdict that reviewDispatch wrote.
			const updatedPrd = readPrd();
			if (updatedPrd !== null) {
				writePrd(updatedPrd);
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
