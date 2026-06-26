// src/release/merge-watch.ts
//
// Merge-watch state machine for CI-gated ship mode (US-007).
//
// When ci-gated merge mode is active, the orchestrator creates the PR and hands
// off to the sidecar. The sidecar polls the PR via `gh pr view` and, on MERGED,
// runs the deterministic post-merge (runPostMerge). On CI-red or
// closed-not-merged it narrates the outcome and stops the watch without running
// post-merge.
//
// The MERGE_WATCH_FILENAME constant names the watch-state file
// (.claude/.cam-merge-watch.json) that the orchestrator writes when entering
// ci-gated mode. The sidecar reads it on idle ticks and removes it when the
// watch completes (merged, ci-red, closed, or timeout).
//
// All I/O is injectable via MergeWatchOptions so the state machine is fully
// unit-testable without a real gh binary or filesystem.
//
// US-007 (CAM-101).

import type { PostMergeOutcome } from './post-merge.ts';
import type {
	WorkerEventKind,
	WorkerEventDetail,
	MergeWatchWatchingEventDetail,
	MergeWatchMergedEventDetail,
	MergeWatchCiRedEventDetail,
	MergeWatchPostMergeDoneEventDetail,
} from '../supervisor/events.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename of the merge-watch state file (relative to .claude/ dir). */
export const MERGE_WATCH_FILENAME = '.cam-merge-watch.json';

/** Default poll interval between gh pr view calls (60 seconds). */
export const DEFAULT_MERGE_WATCH_POLL_INTERVAL_MS = 60_000;

/**
 * Default maximum number of polls before giving up with a timeout outcome.
 * 240 polls * 60s = 4 hours.
 */
export const DEFAULT_MERGE_WATCH_MAX_POLLS = 240;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * State persisted in .claude/.cam-merge-watch.json by the orchestrator
 * when it enters ci-gated mode after creating a PR.
 *
 * The file is written by the orchestrator (cam-ship.md Step 7 ci-gated branch)
 * and consumed + removed by the sidecar on each idle tick.
 */
export interface MergeWatchState {
	prNumber: number;
	mergedBranch: string;
}

/**
 * One entry from the `statusCheckRollup` array returned by
 * `gh pr view --json statusCheckRollup`.
 *
 * GitHub returns a polymorphic list of `CheckRun` and `StatusContext` objects.
 * We only care about the fields that signal a definitive failure.
 *
 * - CheckRun: `conclusion` is null while in-progress; a string like
 *   "FAILURE" / "TIMED_OUT" / "CANCELLED" when the run completed.
 * - StatusContext: `state` is "PENDING" while running; "FAILURE" / "ERROR"
 *   on failure.
 */
export interface PrCheckRollupEntry {
	/** CheckRun conclusion. null = in-progress; string = completed (see FAILED_CHECK_CONCLUSIONS). */
	conclusion?: string | null;
	/** StatusContext state (legacy commit-status API). */
	state?: string;
}

/**
 * Subset of the `gh pr view --json state,mergeStateStatus,statusCheckRollup` output we care about.
 *
 * state: "OPEN" | "MERGED" | "CLOSED"
 * mergeStateStatus: "BLOCKED" | "CLEAN" | "BEHIND" | "DIRTY" | "HAS_HOOKS" |
 *                   "UNKNOWN" | "UNSTABLE"
 * statusCheckRollup: list of check-run / status-context entries (may be absent
 *   when the PR has no required checks configured).
 */
export interface PrStatus {
	state: string;
	mergeStateStatus: string;
	statusCheckRollup?: PrCheckRollupEntry[];
}

/**
 * Injectable gh poll function.
 *
 * Production: calls `gh pr view <N> --json state,mergeStateStatus` via spawnSync.
 * Tests: returns a controlled PrStatus sequence.
 * Returns null on gh error (poll is silently retried).
 */
export type GhPollFn = (prNumber: number) => PrStatus | null;

/**
 * Injectable post-merge invocable.
 *
 * Production: wraps runPostMerge from src/release/post-merge.ts.
 * Tests: returns a canned PostMergeOutcome.
 */
export type PostMergeFn = (opts: { cwd: string; mergedBranch: string }) => PostMergeOutcome;

/** Options bag for runMergeWatch. All I/O is injectable for unit tests. */
export interface MergeWatchOptions {
	prNumber: number;
	mergedBranch: string;
	cwd: string;
	/** Injectable gh poll function. */
	pollFn: GhPollFn;
	/** Injectable post-merge invocable. */
	postMergeFn: PostMergeFn;
	/**
	 * Narrate events to the orchestrator pane.
	 * Reuses the notifyOrchestrator seam (send-keys) from CAM-70/78.
	 * Do NOT invent a new narration channel (single-pusher invariant CAM-78).
	 */
	notifyOrchestrator: (line: string) => void;
	/**
	 * Structured event emitter (US-008). Injectable for tests (use
	 * makeInMemoryEventLogger wrapper). Production: wired by the sidecar to
	 * the file event logger so lifecycle events land in cam-worker-events.jsonl.
	 * Called with the event kind and typed detail; the caller wraps ts/uuid/storyId.
	 */
	logEvent?: (kind: WorkerEventKind, detail: WorkerEventDetail) => void;
	/**
	 * Sleep between polls. Defaults to Bun.sleepSync.
	 * Tests inject a no-op to avoid real delays (with tiny pollIntervalMs).
	 */
	sleepFn?: (ms: number) => void;
	/**
	 * Poll interval in ms.
	 * Default: DEFAULT_MERGE_WATCH_POLL_INTERVAL_MS (60 000 ms = 60s).
	 */
	pollIntervalMs?: number;
	/**
	 * Max number of polls before returning a timeout outcome.
	 * Default: DEFAULT_MERGE_WATCH_MAX_POLLS (240 = 4 hours at 60s/poll).
	 */
	maxPolls?: number;
}

/** Terminal outcome of the merge-watch state machine. */
export type MergeWatchOutcome =
	| { kind: 'merged'; postMerge: PostMergeOutcome }
	| { kind: 'ci-red'; prNumber: number }
	| { kind: 'closed-not-merged'; prNumber: number }
	| { kind: 'timeout'; polls: number };

// ---------------------------------------------------------------------------
// Check-failure detection helpers
// ---------------------------------------------------------------------------

/**
 * CheckRun conclusion values that represent a definitive CI failure.
 * Excludes SUCCESS, SKIPPED, NEUTRAL, STALE (passing/ignored outcomes).
 * Excludes null (in-progress/pending).
 */
const FAILED_CHECK_CONCLUSIONS = new Set([
	'FAILURE',
	'CANCELLED',
	'TIMED_OUT',
	'ACTION_REQUIRED',
	'STARTUP_FAILURE',
]);

/**
 * StatusContext state values (legacy commit-status API) that represent failure.
 */
const FAILED_CHECK_STATES = new Set(['FAILURE', 'ERROR']);

/**
 * Returns true if the rollup contains at least one entry with a conclusively
 * failed check run or status context.
 *
 * A null `conclusion` means the check is still in-progress (not a failure).
 * An absent/empty rollup means no checks have concluded yet -- NOT a failure.
 */
function hasFailedCheck(rollup: PrCheckRollupEntry[]): boolean {
	return rollup.some(
		(entry) =>
			(typeof entry.conclusion === 'string' &&
				FAILED_CHECK_CONCLUSIONS.has(entry.conclusion)) ||
			(typeof entry.state === 'string' && FAILED_CHECK_STATES.has(entry.state)),
	);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Poll the GitHub PR state machine until a terminal outcome is reached.
 *
 * Terminal outcomes (in priority order per poll):
 *   - merged: state=="MERGED" -> run postMergeFn + narrate result.
 *   - closed-not-merged: state=="CLOSED" -> narrate + stop (no post-merge).
 *   - ci-red: state=="OPEN" && mergeStateStatus=="BLOCKED" &&
 *             statusCheckRollup contains a failed check -> narrate + stop.
 *   - timeout: maxPolls exhausted -> narrate + stop.
 *
 * Non-terminal outcomes (loop continues):
 *   - pollFn returns null (gh error): silent retry.
 *   - state=="OPEN" && mergeStateStatus!="BLOCKED" (CLEAN, BEHIND, etc.):
 *     keep polling.
 *   - state=="OPEN" && mergeStateStatus=="BLOCKED" && no failed check in rollup
 *     (CI is pending/in-progress, or BLOCKED for a non-CI reason): keep polling.
 *     GitHub returns BLOCKED while required checks are still running, not only on
 *     failure, so we must inspect statusCheckRollup before treating it as ci-red.
 *
 * Only engages under ci-gated merge mode. Under immediate mode, the sidecar
 * never injects this function, so it is completely inert (zero behavior change).
 */
export async function runMergeWatch(opts: MergeWatchOptions): Promise<MergeWatchOutcome> {
	const { prNumber, mergedBranch, cwd, pollFn, postMergeFn, notifyOrchestrator } = opts;
	const { logEvent } = opts;
	const sleep = opts.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_MERGE_WATCH_POLL_INTERVAL_MS;
	const maxPolls = opts.maxPolls ?? DEFAULT_MERGE_WATCH_MAX_POLLS;

	// Emit structured 'watching' event so the operator can identify when
	// monitoring started (US-008).
	const watchingDetail: MergeWatchWatchingEventDetail = { prNumber, mergedBranch };
	logEvent?.('merge-watch-watching', watchingDetail);

	for (let poll = 0; poll < maxPolls; poll++) {
		// Skip sleep on first poll: start immediately.
		if (poll > 0) {
			sleep(pollIntervalMs);
		}

		const status = pollFn(prNumber);
		if (status === null) {
			// gh error: silent retry (network blip, gh auth, etc.).
			continue;
		}

		if (status.state === 'MERGED') {
			notifyOrchestrator(`[cam] PR #${prNumber} merged - running post-merge`);
			const mergedDetail: MergeWatchMergedEventDetail = { prNumber };
			logEvent?.('merge-watch-merged', mergedDetail);
			const result = postMergeFn({ cwd, mergedBranch });
			if (result.ok) {
				const tagNote = result.tagCreated ? '(tag created)' : '(tag existed)';
				notifyOrchestrator(`[cam] post-merge complete: ${result.tag} ${tagNote}`);
				const doneDetail: MergeWatchPostMergeDoneEventDetail = {
					prNumber,
					ok: true,
					tag: result.tag,
					tagCreated: result.tagCreated,
				};
				logEvent?.('merge-watch-post-merge-done', doneDetail);
			} else {
				notifyOrchestrator(`[cam] post-merge failed: ${result.reason}`);
				const doneDetail: MergeWatchPostMergeDoneEventDetail = {
					prNumber,
					ok: false,
					reason: result.reason,
				};
				logEvent?.('merge-watch-post-merge-done', doneDetail);
			}
			return { kind: 'merged', postMerge: result };
		}

		if (status.state === 'CLOSED') {
			notifyOrchestrator(`[cam] CI red, PR #${prNumber} closed-not-merged`);
			const ciRedDetail: MergeWatchCiRedEventDetail = { prNumber, reason: 'closed' };
			logEvent?.('merge-watch-ci-red', ciRedDetail);
			return { kind: 'closed-not-merged', prNumber };
		}

		if (status.state === 'OPEN' && status.mergeStateStatus === 'BLOCKED') {
			// GitHub returns BLOCKED while checks are still pending/in-progress.
			// Only treat it as a true CI failure when the rollup confirms a
			// failed check conclusion. An absent or all-pending rollup means
			// CI is still running: keep polling.
			const rollup = status.statusCheckRollup ?? [];
			if (rollup.length === 0 || !hasFailedCheck(rollup)) {
				// Checks are pending/in-progress (or BLOCKED for a non-CI reason).
				// Keep polling.
				continue;
			}
			notifyOrchestrator(`[cam] CI red, PR #${prNumber} open, not merged`);
			const ciRedDetail: MergeWatchCiRedEventDetail = { prNumber, reason: 'blocked' };
			logEvent?.('merge-watch-ci-red', ciRedDetail);
			return { kind: 'ci-red', prNumber };
		}

		// Still OPEN and CI not failed (CLEAN, BEHIND, UNSTABLE, BLOCKED+pending, etc.): keep polling.
	}

	notifyOrchestrator(
		`[cam] merge-watch timeout: PR #${prNumber} not yet merged after ${maxPolls} polls`,
	);
	return { kind: 'timeout', polls: maxPolls };
}
