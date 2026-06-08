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
import { readWorkerOutcome } from './result.ts';
import type { WorkerOutcome } from './result.ts';
import { buildImplementerWorkerArgv } from './worker-argv.ts';

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
 * Minimal shape of handoff.json consumed by runSupervisor.
 * Passed through to readWorkerOutcome via the readFile adapter.
 */
export interface HandoffSnapshot {
	lastCompletedStory?: {
		id?: string;
		title?: string;
	};
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
	/** Hard max iterations cap. Default: MAX_ITERATIONS (50). */
	maxIterations?: number;
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
		clock: _clock,
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

	let iterations = 0;
	let lastOutcome: WorkerOutcome | null = null;

	while (iterations < maxIter) {
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

			// Build the shell command for the worker.
			const shellCmd = buildImplementerWorkerArgv({
				uuid,
				taskPrompt,
				permissionMode,
				channel,
			});

			// Respawn the worker pane with the implementer command.
			// respawn-pane argv: tmuxArgs(['respawn-pane', '-k', '-t', paneId, ...shellCmd])
			// We accept a generic spawn fn, so call it directly with the respawn args.
			spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, shellCmd]);

			// Block until the worker signals the channel, bounded by the per-worker deadline.
			const waitResult = waitFor(channel, perWorkerTimeoutMs);

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
				// US-013 structured log placeholder: supervisor detected timeout/pane-death.
				// Proceed to decideNextAction on next iteration (do not exit the loop).
				continue;
			}

			// Capture pane output to detect the sentinel.
			const paneText = capturePane(workerPaneId);

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
