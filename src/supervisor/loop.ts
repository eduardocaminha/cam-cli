// src/supervisor/loop.ts
//
// Supervisor loop that ties together the cam-cli autonomous execution primitives.
//
// runSupervisor picks the next action (decideNextAction), dispatches a worker,
// waits for it to finish, reads the outcome, and repeats until the loop reaches
// a terminal state: complete, blocked, or max-iterations.
//
// Design decisions:
//   - All side effects injected: spawn, waitFor, capturePane, readPrd, writePrd,
//     readHandoff, clock, writeSessionMarker. The loop itself is pure over its
//     injectable interface, making it fully unit-testable with fakes.
//   - The worker SELF-SELECTS its story. The supervisor calls decideNextAction
//     only to decide implement-vs-review-vs-complete and for logging. The story
//     id from decideNextAction is advisory; the actual completed story comes from
//     handoff.json / the pane sentinel after the worker exits. This eliminates
//     the two-independent-selectors mismatch without touching the proven agent.
//   - writeSessionMarker is keyed to the actualStoryId from the outcome, never
//     to the advisory storyId from decideNextAction.
//   - Review dispatch is a placeholder (reviewDispatch injected fn). Full wiring
//     lands in US-008.
//   - Hard max-iterations cap (default MAX_ITERATIONS = 50) prevents runaway loops.

import { decideNextAction } from './decide.ts';
import type { PrdSnapshot } from './decide.ts';
import { readWorkerOutcome, parseAnySentinel } from './result.ts';
import type { WorkerOutcome } from './result.ts';
import { buildImplementerWorkerArgv } from './worker-argv.ts';
import { isRateLimited, findRateLimitMessage } from '../retry/patterns.ts';
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
 * Block until the named tmux wait-for channel is signalled, or until
 * timeoutMs elapses. Returns { timedOut: true } when the deadline fires
 * before the channel is signalled; { timedOut: false } on normal completion.
 */
export type WaitForFn = (channel: string, timeoutMs: number) => { timedOut: boolean };

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
 * Mint the wait-for channel name for a given uuid.
 * Injected so tests can produce deterministic channel names.
 */
export type GenChannel = (storyId: string, uuid: string) => string;

/**
 * Dispatch a review worker.
 * Receives a uuid for session tracking and a pre-minted wait-for channel.
 * Returns the outcome of the review dispatch.
 */
export type ReviewDispatch = (uuid: string, channel: string) => ReviewDispatchResult;

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
 * Pause until an Anthropic rate-limit clears, then return so the supervisor can
 * resume the worker (US-016). The supervisor calls this on detecting a
 * rate-limit; the production adapter (in next.ts) reuses src/retry/* to compute
 * the wait from the rate-limit message and sleeps. Tests inject a fake that
 * returns immediately to keep runtime low. May be sync or async.
 */
export type RateLimitResume = (info: {
	/** The rate-limit message scraped from the pane, or null if none parsed. */
	message: string | null;
	/** 1-based resume attempt number. */
	attempt: number;
}) => void | Promise<void>;

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
	/** Block until a tmux wait-for channel fires. */
	waitFor: WaitForFn;
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
	/** Generate a wait-for channel name. Defaults to workerWaitChannel(). */
	genChannel?: GenChannel;
	/** Dispatch a review worker. Required for review branch. */
	reviewDispatch: ReviewDispatch;
	/** Persist the per-story session marker (keyed to actual completed story). */
	writeSessionMarker: WriteSessionMarker;
	/** Check whether the worker pane is still alive (used on timeout). */
	isPaneAlive: IsPaneAlive;
	/** Per-worker deadline in milliseconds. Default: DEFAULT_PER_WORKER_TIMEOUT_MS (30 min). */
	perWorkerTimeoutMs?: number;
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
	 * Generic file reader for the durable worker output log (CAM-32 BUG 1).
	 * When provided together with workerOutFile, the supervisor reads the worker
	 * output from disk instead of the racy capture-pane. Optional.
	 */
	readFile?: (path: string) => string | null;
	/** Returns the durable output-log path for a worker uuid. Optional. */
	workerOutFile?: (uuid: string) => string;
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
	 * Completion detection mode for implement-branch workers.
	 * 'exit': wait for tmux wait-for channel signal (autonomous headless workers, default).
	 * 'sentinel': poll capture-pane for a CAM_*_STATUS or <review> sentinel
	 *   (interactive workers that do not exit on their own).
	 */
	implementerMode?: 'exit' | 'sentinel';
	/**
	 * Polling interval in milliseconds for sentinel detection mode.
	 * Only relevant when implementerMode === 'sentinel'.
	 * Default: DEFAULT_POLL_INTERVAL_MS (5 seconds).
	 */
	pollIntervalMs?: number;
	/**
	 * Sleep between polling ticks. Injected so tests can use a no-op and avoid
	 * real delays. In production, defaults to Bun.sleepSync (synchronous).
	 * Only called when implementerMode === 'sentinel'.
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
	 * lifecycle. Optional: absent ⇒ no events (zero behavior change).
	 */
	logEvent?: WorkerEventLogger;
	/**
	 * Resolve per-story token usage for a worker uuid (US-013). Bound by the
	 * caller to cwd + claude config dir (see readWorkerTokens in events.ts).
	 * Returns null when the transcript is absent; a null result skips the
	 * 'tokens' event. Optional: absent ⇒ no 'tokens' events.
	 */
	readWorkerTokens?: (uuid: string) => TokensEventDetail | null;
	/**
	 * Pause/resume hook for worker rate-limits (US-016). When provided, an
	 * exit-mode worker whose output shows a rate-limit (the RATE_LIMIT sentinel
	 * or the claude TUI rate-limit message) is paused via this hook and then
	 * respawned with the SAME session-id (same uuid) + channel, so the story is
	 * resumed rather than marked failed. Optional: absent ⇒ rate-limit detection
	 * is skipped (zero behavior change).
	 */
	rateLimitResume?: RateLimitResume;
	/**
	 * Max number of rate-limit pause/resume attempts before the supervisor gives
	 * up and blocks the story. Default: DEFAULT_MAX_RATE_LIMIT_RETRIES.
	 */
	maxRateLimitRetries?: number;
}

/** Terminal status returned by runSupervisor. */
export type SupervisorStatus = 'complete' | 'blocked' | 'max-iterations';

/** Return value of runSupervisor. */
export interface SupervisorResult {
	/** Terminal state reached. */
	status: SupervisorStatus;
	/** How many full iterations were executed. */
	iterations: number;
	/** Outcome of the last worker run, or null if no worker ran. */
	lastOutcome: WorkerOutcome | null;
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

/** Default max rate-limit pause/resume attempts before blocking the story (US-016). */
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;

/** Matches the headless worker's rate-limit exit sentinel (US-016). */
const RATE_LIMIT_SENTINEL_RE = /CAM_IMPLEMENTER_STATUS=RATE_LIMIT/;

/**
 * Detect a worker rate-limit from its captured output: either the explicit
 * RATE_LIMIT exit sentinel or the claude TUI rate-limit message (reusing the
 * retry module's isRateLimited matcher).
 */
function detectRateLimit(paneText: string): boolean {
	return RATE_LIMIT_SENTINEL_RE.test(paneText) || isRateLimited(paneText);
}

// ---------------------------------------------------------------------------
// Default injectable helpers (real-world defaults)
// ---------------------------------------------------------------------------

function defaultGenUuid(): string {
	return crypto.randomUUID();
}

// Lazily import workerWaitChannel to avoid circular dep issues in tests.
function defaultGenChannel(storyId: string, uuid: string): string {
	// Inline the same logic as workerWaitChannel from session.ts to keep
	// this module free of a hard dependency on the tmux session module.
	const safeStoryId = storyId.replace(/[^a-zA-Z0-9]/g, '-');
	const shortUuid = uuid.replace(/-/g, '').slice(0, 8);
	return `cam-worker-${safeStoryId}-${shortUuid}`;
}

// ---------------------------------------------------------------------------
// runSupervisor
// ---------------------------------------------------------------------------

/**
 * Run the cam supervisor loop.
 *
 * Iterates until one of three terminal states:
 *   - 'complete': decideNextAction returned complete (or review terminal).
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
		waitFor,
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
	const genChannel = opts.genChannel ?? defaultGenChannel;
	const maxIter = opts.maxIterations ?? MAX_ITERATIONS;
	const perWorkerTimeoutMs = opts.perWorkerTimeoutMs ?? DEFAULT_PER_WORKER_TIMEOUT_MS;
	const readFile = opts.readFile;
	const workerOutFile = opts.workerOutFile;
	const runGates = opts.runGates;
	const finalizeStory = opts.finalizeStory;
	const implementerMode = opts.implementerMode ?? 'exit';
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	// Real sleep: use a no-op by default so tests never block; callers that want
	// actual sleeping must inject Bun.sleepSync (or similar).
	const sleepFn = opts.sleepFn ?? ((_ms: number) => {});
	const now = opts.nowMs ?? (() => Date.now());
	const logEvent = opts.logEvent;
	const readWorkerTokens = opts.readWorkerTokens;
	const rateLimitResume = opts.rateLimitResume;
	const maxRateLimitRetries = opts.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;

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

	outer: while (iterations < maxIter) {
		// --- Read current PRD state ---
		const prd = readPrd();
		if (prd === null) {
			// PRD unreadable: treat as blocked.
			return { status: 'blocked', iterations, lastOutcome };
		}

		// --- Decide next action ---
		const action = decideNextAction(prd);

		// --- Handle terminal decisions ---
		if (action.kind === 'complete') {
			return { status: 'complete', iterations, lastOutcome };
		}

		if (action.kind === 'blocked-no-implementable') {
			return { status: 'blocked', iterations, lastOutcome };
		}

		// --- Implement branch ---
		if (action.kind === 'implement') {
			// Advisory storyId is used for logging and channel naming only.
			// The worker self-selects which story it actually implements.
			const advisoryStoryId = action.storyId;

			// Mint a fresh uuid for this invocation.
			const uuid = genUuid();

			// Build the channel name (advisory storyId used for disambiguation).
			const channel = genChannel(advisoryStoryId, uuid);

			// Build the shell command for the worker. When a durable out-file path
			// is available, the worker tee's its output there so the supervisor can
			// read it after the pane dies (CAM-32 BUG 1).
			const outFile = workerOutFile ? workerOutFile(uuid) : '';
			const shellCmd = buildImplementerWorkerArgv({
				uuid,
				taskPrompt,
				permissionMode,
				channel,
				interactive: implementerMode === 'sentinel',
				...(outFile ? { outFile } : {}),
			});

			// Respawn the worker pane with the implementer command.
			// respawn-pane argv: tmuxArgs(['respawn-pane', '-k', '-t', paneId, ...shellCmd])
			// We accept a generic spawn fn, so call it directly with the respawn args.
			spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, shellCmd]);

			// US-013: worker-start. storyId is advisory here (the worker
			// self-selects); later events carry the actual completed story.
			emit('worker-start', advisoryStoryId, uuid, { channel, mode: implementerMode });

			// ---------------------------------------------------------------
			// Sentinel polling mode (US-012): interactive worker does NOT exit
			// on its own, so we poll capture-pane until we see the sentinel.
			// ---------------------------------------------------------------
			if (implementerMode === 'sentinel') {
				const startMs = now();
				let pollOutcome: 'sentinel' | 'pane-died' | 'timeout' = 'timeout';

				while (true) {
					sleepFn(pollIntervalMs);
					if (!isPaneAlive(workerPaneId)) {
						pollOutcome = 'pane-died';
						break;
					}
					const polledText = capturePane(workerPaneId);
					if (parseAnySentinel(polledText) !== null) {
						pollOutcome = 'sentinel';
						break;
					}
					if (now() - startMs >= perWorkerTimeoutMs) {
						break; // timeout
					}
				}

				iterations++;

				// US-013: worker-end (sentinel mode). pollOutcome records how it ended.
				emit('worker-end', advisoryStoryId, uuid, { mode: 'sentinel', pollOutcome });

				if (pollOutcome === 'pane-died') {
					lastOutcome = {
						kind: 'blocked',
						storyId: undefined,
						detail: 'pane-died-pre-result',
					};
					continue;
				}
				if (pollOutcome === 'timeout') {
					spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, 'echo timeout']);
					lastOutcome = {
						kind: 'blocked',
						storyId: undefined,
						detail: 'timeout',
					};
					continue;
				}

				// Sentinel found: read full pane text and determine outcome.
				const durableSentinel = outFile && readFile ? readFile(outFile) : null;
				const sentinelPaneText =
					durableSentinel && durableSentinel.length > 0
						? durableSentinel
						: capturePane(workerPaneId);

				const sentinelFileReader = (path: string): string | null => {
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

				const sentinelOutcome = readWorkerOutcome({
					prdPath,
					handoffPath,
					capturedPaneText: sentinelPaneText,
					readFile: sentinelFileReader,
				});

				lastOutcome = sentinelOutcome;

				// US-013: result + tokens, keyed to the ACTUAL completed story.
				const sentinelStoryId = sentinelOutcome.storyId ?? advisoryStoryId;
				emit('result', sentinelStoryId, uuid, buildResultDetail(sentinelOutcome, _readHandoff()));
				emitTokens(sentinelStoryId, uuid);

				if (sentinelOutcome.kind === 'pass' && sentinelOutcome.storyId !== undefined) {
					writeSessionMarker(sentinelOutcome.storyId, uuid);
				}

				if (
					sentinelOutcome.kind === 'blocked' ||
					sentinelOutcome.kind === 'fail' ||
					sentinelOutcome.kind === 'unknown'
				) {
					return { status: 'blocked', iterations, lastOutcome };
				}

				if (
					sentinelOutcome.kind === 'incomplete' &&
					sentinelOutcome.storyId !== undefined &&
					runGates &&
					finalizeStory
				) {
					const gate = runGates();
					if (!gate.ok) {
						lastOutcome = {
							kind: 'blocked',
							storyId: sentinelOutcome.storyId,
							detail: `finalize aborted, gates failed for ${sentinelOutcome.storyId}: ${gate.detail}`,
						};
						return { status: 'blocked', iterations, lastOutcome };
					}
					const fin = finalizeStory(sentinelOutcome.storyId);
					if (!fin.ok) {
						lastOutcome = {
							kind: 'blocked',
							storyId: sentinelOutcome.storyId,
							detail: `finalize failed for ${sentinelOutcome.storyId}: ${fin.detail}`,
						};
						return { status: 'blocked', iterations, lastOutcome };
					}
					lastOutcome = {
						kind: 'pass',
						storyId: sentinelOutcome.storyId,
						detail: `supervisor-finalized ${sentinelOutcome.storyId} after worker truncation: ${fin.detail}`,
					};
					writeSessionMarker(sentinelOutcome.storyId, uuid);
					continue;
				}

				if (sentinelOutcome.kind === 'incomplete') {
					return { status: 'blocked', iterations, lastOutcome };
				}

				// PRD_COMPLETE or pass: continue to next decideNextAction call.
				continue;
			}

			// Block until the worker signals the channel, bounded by the per-worker deadline.
			const waitResult = waitFor(channel, perWorkerTimeoutMs);

			// US-013: worker-end (exit mode). The worker has stopped (signalled or timed out).
			emit('worker-end', advisoryStoryId, uuid, { mode: 'exit', timedOut: waitResult.timedOut });

			// --- Timeout / pane-death handling ---
			// If the deadline fired before the channel was signalled, the worker is
			// either stuck (pane alive) or has crashed (pane dead). In both cases we
			// mark the iteration blocked and continue to the next decideNextAction call
			// so the loop can pick another story or reach 'complete'.
			if (waitResult.timedOut) {
				iterations++;
				const alive = isPaneAlive(workerPaneId);
				if (!alive) {
					// Pane crashed before it could signal the channel.
					lastOutcome = {
						kind: 'blocked',
						storyId: undefined,
						detail: 'pane-died-pre-result',
					};
				} else {
					// Pane is alive but stuck: kill it and mark timeout.
					spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, 'echo timeout']);
					lastOutcome = {
						kind: 'blocked',
						storyId: undefined,
						detail: 'timeout',
					};
				}
				// US-013: worker-end already emitted above. No 'result'/'tokens' on a
				// timeout/pane-death: there is no canonical per-story record to log.
				// Proceed to decideNextAction on next iteration (do not exit the loop).
				continue;
			}

			// Capture pane output to detect the sentinel.
			let durable = outFile && readFile ? readFile(outFile) : null;
			let paneText = durable && durable.length > 0 ? durable : capturePane(workerPaneId);

			// --- US-016: rate-limit pause/resume ---
			// If the worker output shows a rate-limit (the RATE_LIMIT exit sentinel
			// or the claude TUI rate-limit message), pause via the injected hook and
			// respawn the SAME session so the story is resumed, not failed. Bounded
			// by maxRateLimitRetries. Skipped entirely when rateLimitResume is absent.
			if (rateLimitResume) {
				let rlAttempts = 0;
				while (detectRateLimit(paneText) && rlAttempts < maxRateLimitRetries) {
					rlAttempts++;
					const message = findRateLimitMessage(paneText);
					emit('rate-limited', advisoryStoryId, uuid, {
						phase: 'pause',
						attempt: rlAttempts,
						message,
					});
					await rateLimitResume({ message, attempt: rlAttempts });
					emit('rate-limited', advisoryStoryId, uuid, { phase: 'resume', attempt: rlAttempts });

					// Respawn the SAME worker command: same uuid (== --session-id) and
					// the same channel marker preserve session continuity (US-002, AC4).
					spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, shellCmd]);
					emit('worker-start', advisoryStoryId, uuid, {
						channel,
						mode: implementerMode,
						resumeAfterRateLimit: true,
					});

					const resumeWait = waitFor(channel, perWorkerTimeoutMs);
					emit('worker-end', advisoryStoryId, uuid, {
						mode: 'exit',
						timedOut: resumeWait.timedOut,
						resumeAfterRateLimit: true,
					});

					if (resumeWait.timedOut) {
						iterations++;
						const alive = isPaneAlive(workerPaneId);
						if (!alive) {
							lastOutcome = { kind: 'blocked', storyId: undefined, detail: 'pane-died-pre-result' };
						} else {
							spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, 'echo timeout']);
							lastOutcome = { kind: 'blocked', storyId: undefined, detail: 'timeout' };
						}
						continue outer;
					}

					durable = outFile && readFile ? readFile(outFile) : null;
					paneText = durable && durable.length > 0 ? durable : capturePane(workerPaneId);
				}

				// Still rate-limited after exhausting retries: block for the operator.
				if (detectRateLimit(paneText)) {
					iterations++;
					lastOutcome = {
						kind: 'blocked',
						storyId: advisoryStoryId,
						detail: `rate-limit retries exhausted after ${rlAttempts}`,
					};
					return { status: 'blocked', iterations, lastOutcome };
				}
			}

			// Build a file reader for readWorkerOutcome.
			// We re-read prd/handoff fresh from disk via the injected functions.
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

			// Determine what the worker actually did.
			const outcome = readWorkerOutcome({
				prdPath,
				handoffPath,
				capturedPaneText: paneText,
				readFile: fileReader,
			});

			lastOutcome = outcome;
			iterations++;

			// US-013: result + tokens, keyed to the ACTUAL completed story.
			const exitStoryId = outcome.storyId ?? advisoryStoryId;
			emit('result', exitStoryId, uuid, buildResultDetail(outcome, _readHandoff()));
			emitTokens(exitStoryId, uuid);

			// Write session marker keyed to the ACTUAL completed story.
			if (outcome.kind === 'pass' && outcome.storyId !== undefined) {
				writeSessionMarker(outcome.storyId, uuid);
			}

			// Worker blocked: exit loop.
			if (outcome.kind === 'blocked') {
				return { status: 'blocked', iterations, lastOutcome };
			}

			// Worker failed or unknown: exit loop to let the operator inspect.
			// This is a conservative choice: do not retry silently.
			if (outcome.kind === 'fail' || outcome.kind === 'unknown') {
				return { status: 'blocked', iterations, lastOutcome };
			}

			// --- Incomplete: worker implemented the story but did not finalize ---
				// (no prd flip / push, CAM-32 BUG 2). Re-run gates, then finalize.
				if (outcome.kind === 'incomplete' && outcome.storyId !== undefined && runGates && finalizeStory) {
					const gate = runGates();
					if (!gate.ok) {
						lastOutcome = {
							kind: 'blocked',
							storyId: outcome.storyId,
							detail: `finalize aborted, gates failed for ${outcome.storyId}: ${gate.detail}`,
						};
						return { status: 'blocked', iterations, lastOutcome };
					}
					const fin = finalizeStory(outcome.storyId);
					if (!fin.ok) {
						lastOutcome = {
							kind: 'blocked',
							storyId: outcome.storyId,
							detail: `finalize failed for ${outcome.storyId}: ${fin.detail}`,
						};
						return { status: 'blocked', iterations, lastOutcome };
					}
					lastOutcome = {
						kind: 'pass',
						storyId: outcome.storyId,
						detail: `supervisor-finalized ${outcome.storyId} after worker truncation: ${fin.detail}`,
					};
					writeSessionMarker(outcome.storyId, uuid);
					continue;
				}

				// Incomplete but no finalize capability (or no storyId): cannot
				// complete the tail deterministically; stop for the operator.
				if (outcome.kind === 'incomplete') {
					return { status: 'blocked', iterations, lastOutcome };
				}

				// PRD_COMPLETE sentinel (storyId === undefined): loop will call
			// decideNextAction next iteration which will return 'complete'.
			// Continue iterating so the state machine picks it up naturally.
			continue;
		}

		// --- Review branch ---
		if (action.kind === 'review') {
			const uuid = genUuid();
			const channel = genChannel('review', uuid);
			const reviewResult = reviewDispatch(uuid, channel);

			iterations++;

			if (reviewResult.status === 'error') {
				// Review dispatch failed: treat as blocked.
				return { status: 'blocked', iterations, lastOutcome };
			}

			// Re-read PRD to pick up the review verdict that reviewDispatch wrote.
			const updatedPrd = readPrd();
			if (updatedPrd !== null) {
				writePrd(updatedPrd);
			}

			// Continue: next iteration's decideNextAction will evaluate the verdict.
			continue;
		}
	}

	// Hard cap reached.
	return { status: 'max-iterations', iterations, lastOutcome };
}
