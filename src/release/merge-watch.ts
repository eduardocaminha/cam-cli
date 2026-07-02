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
// US-007 (CAM-101). Durable state I/O helpers added in US-002 (CAM-138).
// issueId threading + stashIssueIdInMergeWatch added in US-002 (CAM-121 PRD).

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
// Durable state I/O helpers (US-002)
// ---------------------------------------------------------------------------

/**
 * Read MergeWatchState from a persistent file.
 *
 * Returns null when:
 * - The file does not exist (no watch pending).
 * - The file contains malformed JSON or a non-object / array value.
 * - Required fields (prNumber: number, mergedBranch: string) are absent or
 *   the wrong type.
 *
 * A legacy two-field seed { prNumber, mergedBranch } reads back successfully
 * with pollCount and lastPolledAt absent (undefined), so stepMergeWatch treats
 * it as fresh (pollCount defaults to 0; absent lastPolledAt bypasses the
 * throttle check so the first tick polls immediately).
 *
 * Never throws.
 */
export function readMergeWatchState(filePath: string): MergeWatchState | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj['prNumber'] !== 'number' || typeof obj['mergedBranch'] !== 'string') return null;
		const state: MergeWatchState = {
			prNumber: obj['prNumber'] as number,
			mergedBranch: obj['mergedBranch'] as string,
		};
		if (typeof obj['pollCount'] === 'number') {
			state.pollCount = obj['pollCount'] as number;
		}
		if (typeof obj['lastPolledAt'] === 'number') {
			state.lastPolledAt = obj['lastPolledAt'] as number;
		}
		if (typeof obj['issueId'] === 'string') {
			state.issueId = obj['issueId'] as string;
		}
		return state;
	} catch {
		return null;
	}
}

/**
 * Write MergeWatchState to a persistent file (durable, not consume-on-read).
 *
 * Always writes prNumber, mergedBranch, and pollCount (defaulting to 0 when
 * absent in the state). Writes lastPolledAt only when it is defined (undefined
 * is omitted from the JSON so a fresh-state read bypasses the throttle check).
 *
 * Call after every non-terminal stepMergeWatch tick so the state survives a
 * sidecar restart. Single-writer assumption: only the sidecar writes this file
 * in production.
 */
export function writeMergeWatchState(filePath: string, state: MergeWatchState): void {
	const payload: Record<string, unknown> = {
		prNumber: state.prNumber,
		mergedBranch: state.mergedBranch,
		pollCount: state.pollCount ?? 0,
	};
	if (state.lastPolledAt !== undefined) {
		payload['lastPolledAt'] = state.lastPolledAt;
	}
	if (state.issueId !== undefined) {
		payload['issueId'] = state.issueId;
	}
	writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Remove the merge-watch state file on a terminal outcome.
 *
 * Called when the outcome is merged | closed-not-merged | ci-red | timeout.
 * Best-effort: does not throw when the file is already absent.
 */
export function removeMergeWatchState(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}

/**
 * Stash an issueId into the merge-watch state file (read-modify-write).
 *
 * Called before the PR is created so both the sidecar (ci-gated) and the
 * orchestrator (immediate) can close the issue after merge without re-reading
 * prd.json.
 *
 * Behaviour:
 * - If the file does not exist, creates it with just { issueId }.
 * - If the file exists and contains a JSON object, preserves all existing
 *   fields (prNumber, mergedBranch, pollCount, etc.) and adds/overwrites
 *   issueId.
 * - If the file exists but contains malformed JSON or a non-object, starts
 *   fresh with { issueId } (best-effort recovery; the sidecar will still
 *   return null from readMergeWatchState until prNumber is written).
 *
 * readMergeWatchState still returns null for issueId-only files (prNumber
 * absent), so stashing before the PR is created keeps the sidecar inert.
 *
 * Single-writer assumption holds (same as the rest of this module).
 * Never throws.
 */
export function stashIssueIdInMergeWatch(filePath: string, issueId: string): void {
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(filePath)) {
			const content = readFileSync(filePath, 'utf8');
			const parsed: unknown = JSON.parse(content);
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		}
	} catch {
		/* ignore read/parse errors: start from empty object */
	}
	existing['issueId'] = issueId;
	writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * State persisted in .claude/.cam-merge-watch.json by the orchestrator
 * when it enters ci-gated mode after creating a PR.
 *
 * The file is written by the orchestrator (cam-ship.md Step 7 ci-gated branch)
 * and consumed + removed by the sidecar on each idle tick.
 *
 * pollCount and lastPolledAt are optional so that a legacy seed state of only
 * { prNumber, mergedBranch } is accepted and treated as fresh: pollCount starts
 * at 0 and the first tick polls immediately (no migration, no schemaVersion
 * field needed).
 *
 * issueId is optional and may be stashed before the PR is created (US-002).
 * readMergeWatchState still returns null when prNumber is absent, so an
 * issueId-only file keeps the sidecar inert until the PR number is written.
 */
export interface MergeWatchState {
	prNumber: number;
	mergedBranch: string;
	/** Number of gh polls performed so far. Absent = 0 (fresh state). */
	pollCount?: number;
	/**
	 * Epoch-ms timestamp of the last poll. Absent = never polled (first tick
	 * polls immediately, bypassing the throttle check).
	 */
	lastPolledAt?: number;
	/**
	 * Resolved target issue id (e.g. "CAM-121"). Written by stashIssueIdInMergeWatch
	 * before the PR is created so the post-merge close path can close the issue
	 * without re-reading prd.json.
	 */
	issueId?: string;
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
// State machine helpers
// ---------------------------------------------------------------------------

/**
 * Return a prune-status suffix to fold into the completion line.
 * Returns an empty string when both legs succeeded (no sub-status appended).
 * When either leg failed, returns a non-empty suffix so the single
 * notifyOrchestrator call on the success path carries the prune result.
 * Pure builder: does NOT call notifyOrchestrator directly (coalesce invariant).
 */
function warnOnPruneFailure(
	prunedLocal: boolean,
	prunedRemote: boolean,
): string {
	if (prunedLocal && prunedRemote) return '';
	const local = prunedLocal ? 'ok' : 'FAILED';
	const remote = prunedRemote ? 'ok' : 'FAILED';
	return ` (warn: prune local ${local}, remote ${remote})`;
}

/**
 * Handle one non-null poll result.
 *
 * Returns `{ outcome }` when the state machine should stop (terminal outcome),
 * or `null` to continue polling.
 *
 * Extracted from runMergeWatch to keep the main function under complexity/line
 * limits (CAM-60 factory/helper pattern).
 */
function processPollResult(
	status: PrStatus,
	opts: MergeWatchOptions,
): { outcome: MergeWatchOutcome } | null {
	const { prNumber, mergedBranch, cwd, postMergeFn, notifyOrchestrator, logEvent } = opts;

	if (status.state === 'MERGED') {
		notifyOrchestrator(`[cam] PR #${prNumber} merged - running post-merge`);
		const mergedDetail: MergeWatchMergedEventDetail = { prNumber };
		logEvent?.('merge-watch-merged', mergedDetail);
		const result = postMergeFn({ cwd, mergedBranch });
		if (result.ok) {
			const tagNote = result.tagCreated ? '(tag created)' : '(tag existed)';
			// Coalesce: fold prune sub-status into a single completion line.
			// warnOnPruneFailure is a pure builder (returns string, no side-effects)
			// so there is EXACTLY ONE notifyOrchestrator call on the success path
			// (back-to-back send-keys would race in the orchestrator Ink prompt).
			const pruneSuffix = warnOnPruneFailure(result.branchPrunedLocal, result.branchPrunedRemote);
			notifyOrchestrator(`[cam] post-merge complete: ${result.tag} ${tagNote}${pruneSuffix}`);
			const doneDetail: MergeWatchPostMergeDoneEventDetail = {
				prNumber, ok: true, tag: result.tag, tagCreated: result.tagCreated,
				branchPrunedLocal: result.branchPrunedLocal,
				branchPrunedRemote: result.branchPrunedRemote,
			};
			logEvent?.('merge-watch-post-merge-done', doneDetail);
		} else {
			notifyOrchestrator(`[cam] post-merge failed: ${result.reason}`);
			const doneDetail: MergeWatchPostMergeDoneEventDetail = {
				prNumber, ok: false, reason: result.reason,
			};
			logEvent?.('merge-watch-post-merge-done', doneDetail);
		}
		return { outcome: { kind: 'merged', postMerge: result } };
	}

	if (status.state === 'CLOSED') {
		notifyOrchestrator(`[cam] CI red, PR #${prNumber} closed-not-merged`);
		const ciRedDetail: MergeWatchCiRedEventDetail = { prNumber, reason: 'closed' };
		logEvent?.('merge-watch-ci-red', ciRedDetail);
		return { outcome: { kind: 'closed-not-merged', prNumber } };
	}

	if (status.state === 'OPEN' && status.mergeStateStatus === 'BLOCKED') {
		// GitHub returns BLOCKED while checks are pending: inspect rollup before
		// treating as ci-red (US-R1-003 pattern).
		const rollup = status.statusCheckRollup ?? [];
		if (rollup.length === 0 || !hasFailedCheck(rollup)) {
			return null; // CI pending/in-progress: keep polling
		}
		notifyOrchestrator(`[cam] CI red, PR #${prNumber} open, not merged`);
		const ciRedDetail: MergeWatchCiRedEventDetail = { prNumber, reason: 'blocked' };
		logEvent?.('merge-watch-ci-red', ciRedDetail);
		return { outcome: { kind: 'ci-red', prNumber } };
	}

	return null; // OPEN + non-BLOCKED (CLEAN, BEHIND, etc.): keep polling
}

// ---------------------------------------------------------------------------
// stepMergeWatch: pure single-tick state machine
// ---------------------------------------------------------------------------

/**
 * Discriminated result of one stepMergeWatch tick.
 *
 * - continue: the state machine is still running; the caller receives the
 *   updated state and schedules the next tick.
 * - terminal: a terminal outcome was reached; the caller should stop.
 */
export type StepMergeWatchResult =
	| { kind: 'continue'; state: MergeWatchState }
	| { kind: 'terminal'; outcome: MergeWatchOutcome };

/**
 * Options bag for stepMergeWatch.
 *
 * Excludes the fields passed as positional arguments (state, now, pollFn) and
 * excludes scheduling concerns (sleep, clockFn) which belong to the caller.
 * This keeps stepMergeWatch a pure function: no FS, no sleep, no Date.now().
 */
export interface StepMergeWatchOptions {
	cwd: string;
	postMergeFn: PostMergeFn;
	notifyOrchestrator: (line: string) => void;
	logEvent?: (kind: WorkerEventKind, detail: WorkerEventDetail) => void;
	/** Default: DEFAULT_MERGE_WATCH_POLL_INTERVAL_MS */
	pollIntervalMs?: number;
	/** Default: DEFAULT_MERGE_WATCH_MAX_POLLS */
	maxPolls?: number;
}

/**
 * Advance the merge-watch state machine by one tick.
 *
 * Pure function: no FS, no sleep, no Date.now(). The caller owns persistence
 * and scheduling.
 *
 * Throttle rule: a tick where now < lastPolledAt + pollIntervalMs does NOT
 * call pollFn and returns { kind: 'continue', state } (state unchanged).
 * A tick at/after the interval calls pollFn exactly once, increments pollCount,
 * and sets lastPolledAt = now.
 *
 * Legacy seed: a state with no pollCount/lastPolledAt is treated as fresh.
 * pollCount defaults to 0 and the first tick always polls (lastPolledAt absent
 * bypasses the throttle check).
 */
export function stepMergeWatch(
	state: MergeWatchState,
	now: number,
	pollFn: GhPollFn,
	opts: StepMergeWatchOptions,
): StepMergeWatchResult {
	const pollCount = state.pollCount ?? 0;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_MERGE_WATCH_POLL_INTERVAL_MS;
	const maxPolls = opts.maxPolls ?? DEFAULT_MERGE_WATCH_MAX_POLLS;

	// Throttle: skip if not time to poll yet. When lastPolledAt is absent (legacy
	// seed or fresh state), always poll on the first tick.
	const shouldPoll =
		state.lastPolledAt === undefined || now >= state.lastPolledAt + pollIntervalMs;
	if (!shouldPoll) {
		return { kind: 'continue', state };
	}

	// Timeout: pollCount exhausted before calling pollFn for this tick.
	if (pollCount >= maxPolls) {
		opts.notifyOrchestrator(
			`[cam] merge-watch timeout: PR #${state.prNumber} not yet merged after ${maxPolls} polls`,
		);
		return { kind: 'terminal', outcome: { kind: 'timeout', polls: maxPolls } };
	}

	// Emit 'merge-watch-watching' on the very first poll (pollCount === 0).
	// Covers both the production one-step-per-tick path (sidecar.ts ->
	// stepMergeWatch directly) and the legacy blocking runMergeWatch wrapper.
	if (pollCount === 0) {
		const watchingDetail: MergeWatchWatchingEventDetail = {
			prNumber: state.prNumber,
			mergedBranch: state.mergedBranch,
		};
		opts.logEvent?.('merge-watch-watching', watchingDetail);
	}

	// Call pollFn exactly once.
	const status = pollFn(state.prNumber);
	const newPollCount = pollCount + 1;
	const newLastPolledAt = now;

	if (status === null) {
		// gh error: silent retry. Advance counters so the throttle fires correctly
		// on the next tick (the caller will sleep before calling us again).
		return {
			kind: 'continue',
			state: { ...state, pollCount: newPollCount, lastPolledAt: newLastPolledAt },
		};
	}

	// Delegate to processPollResult with a reconstructed opts bag.
	const mergeWatchOpts: MergeWatchOptions = {
		prNumber: state.prNumber,
		mergedBranch: state.mergedBranch,
		cwd: opts.cwd,
		pollFn,
		postMergeFn: opts.postMergeFn,
		notifyOrchestrator: opts.notifyOrchestrator,
		logEvent: opts.logEvent,
	};
	const result = processPollResult(status, mergeWatchOpts);
	if (result !== null) {
		return { kind: 'terminal', outcome: result.outcome };
	}

	// Non-terminal: keep watching with updated counters.
	return {
		kind: 'continue',
		state: { ...state, pollCount: newPollCount, lastPolledAt: newLastPolledAt },
	};
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
 *
 * Only engages under ci-gated merge mode. Under immediate mode, the sidecar
 * never injects this function, so it is completely inert (zero behavior change).
 */
export async function runMergeWatch(opts: MergeWatchOptions): Promise<MergeWatchOutcome> {
	const { prNumber, logEvent } = opts;
	const sleep = opts.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_MERGE_WATCH_POLL_INTERVAL_MS;
	const maxPolls = opts.maxPolls ?? DEFAULT_MERGE_WATCH_MAX_POLLS;

	const stepOpts: StepMergeWatchOptions = {
		cwd: opts.cwd,
		postMergeFn: opts.postMergeFn,
		notifyOrchestrator: opts.notifyOrchestrator,
		logEvent: opts.logEvent,
		pollIntervalMs,
		maxPolls,
	};

	// Use a monotonically increasing virtual clock that advances by pollIntervalMs
	// on each sleep so the stepMergeWatch throttle check always passes after a
	// real sleep without requiring a Date.now() call in product code.
	let state: MergeWatchState = { prNumber, mergedBranch: opts.mergedBranch };
	let virtualNow = 0;
	let first = true;

	while (true) {
		if (!first) {
			sleep(pollIntervalMs);
			virtualNow += pollIntervalMs;
		}
		first = false;

		const result = stepMergeWatch(state, virtualNow, opts.pollFn, stepOpts);
		if (result.kind === 'terminal') {
			return result.outcome;
		}
		state = result.state;
	}
}
