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
	MergeWatchStalledEventDetail,
} from '../supervisor/events.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename of the merge-watch state file (relative to .claude/ dir). */
export const MERGE_WATCH_FILENAME = '.cam-merge-watch.json';

/**
 * Filename of the durable ship-stalled marker (relative to .claude/ dir,
 * US-002, CAM-182). Written by the sidecar caller on every non-merged
 * merge-watch terminal; removed when a later watch reaches MERGED for the
 * same prNumber. Deliberately a SEPARATE file from MERGE_WATCH_FILENAME,
 * which keeps its consume-on-terminal lifecycle unchanged.
 */
export const SHIP_STALLED_FILENAME = '.cam-ship-stalled.json';

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
		if (typeof obj['updateBranchCount'] === 'number') {
			state.updateBranchCount = obj['updateBranchCount'] as number;
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
		updateBranchCount: state.updateBranchCount ?? 0,
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
 * absent), so stashing before the PR is created writes a preserved seed: the
 * sidecar GC (gcMergeWatchIfGarbage in sidecar.ts) keeps it intact until the
 * cam-ship enrich step adds prNumber + mergedBranch to produce the full state.
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

/**
 * Durable ship-stalled marker (US-002, CAM-182): written on every non-merged
 * merge-watch terminal so a recycled orchestrator can learn the ship stalled
 * even when the live send-keys narration is lost.
 *
 * prUrl/issueId are `string | null` (not optional) so the marker always
 * round-trips the same three-state field: known, unknown (null), or absent
 * key entirely on a legacy read. `null` covers the case where the terminal
 * fired before the PR url or issueId was ever learned (e.g. timeout before
 * any successful poll).
 */
export interface ShipStalledMarker {
	prNumber: number;
	prUrl: string | null;
	issueId: string | null;
	reason: string;
	ts: string;
}

/**
 * Read the ship-stalled marker from a persistent file.
 *
 * Returns null when the file is absent, contains malformed JSON, a non-object
 * / array value, or is missing the required `prNumber: number` / `reason:
 * string` / `ts: string` fields. Never throws (mirrors readMergeWatchState).
 */
export function readShipStalledMarker(filePath: string): ShipStalledMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		if (
			typeof obj['prNumber'] !== 'number' ||
			typeof obj['reason'] !== 'string' ||
			typeof obj['ts'] !== 'string'
		) {
			return null;
		}
		const prUrl = obj['prUrl'];
		const issueId = obj['issueId'];
		return {
			prNumber: obj['prNumber'] as number,
			prUrl: typeof prUrl === 'string' ? prUrl : null,
			issueId: typeof issueId === 'string' ? issueId : null,
			reason: obj['reason'] as string,
			ts: obj['ts'] as string,
		};
	} catch {
		return null;
	}
}

/**
 * Write the ship-stalled marker to a persistent file (durable, not
 * consume-on-read; mirrors writeMergeWatchState). Overwrites any previous
 * marker (a fresh non-merged terminal always reflects the latest state).
 * Never throws.
 */
export function writeShipStalledMarker(filePath: string, marker: ShipStalledMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the marker is not durable this tick */
	}
}

/**
 * Remove the ship-stalled marker file.
 *
 * Called when a later watch reaches MERGED for the SAME prNumber the marker
 * references (caller's responsibility to check prNumber match first). Never
 * throws when the file is already absent (mirrors removeMergeWatchState).
 */
export function removeShipStalledMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
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
 * readMergeWatchState still returns null when prNumber is absent; the sidecar
 * GC (gcMergeWatchIfGarbage) preserves the issueId-only seed until the
 * cam-ship enrich step adds prNumber + mergedBranch.
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
	/**
	 * Number of `gh pr update-branch` auto-recovery attempts performed so far
	 * for the current BEHIND streak (US-001, CAM-182). Absent = 0 (fresh
	 * state; a legacy state file predating this field reads back as fresh).
	 * Capped at MAX_UPDATE_BRANCH_ATTEMPTS.
	 */
	updateBranchCount?: number;
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
 * Subset of the
 * `gh pr view --json state,mergeStateStatus,statusCheckRollup,autoMergeRequest,url`
 * output we care about.
 *
 * state: "OPEN" | "MERGED" | "CLOSED"
 * mergeStateStatus: "BLOCKED" | "CLEAN" | "BEHIND" | "DIRTY" | "HAS_HOOKS" |
 *                   "UNKNOWN" | "UNSTABLE"
 * statusCheckRollup: list of check-run / status-context entries (may be absent
 *   when the PR has no required checks configured).
 * autoMergeRequest: non-null when GitHub auto-merge is armed (`gh pr merge
 *   --auto`); null/absent when not armed. Gates the BEHIND auto-recovery: we
 *   only run `gh pr update-branch` when the PR will merge itself once CI goes
 *   green again, so we never leave an update-branch-fresh PR mid-flight
 *   without a merge follow-up.
 * url: PR URL, surfaced in terminal narration when auto-recovery gives up.
 */
export interface PrStatus {
	state: string;
	mergeStateStatus: string;
	statusCheckRollup?: PrCheckRollupEntry[];
	autoMergeRequest?: Record<string, unknown> | null;
	url?: string;
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
 * Injectable gh pr update-branch invocable (US-001, CAM-182).
 *
 * Production: spawns `gh pr update-branch <prNumber>` with GITHUB_TOKEN
 * stripped from the child environment (falls back to the gh keyring OAuth
 * token, same pattern as `gh pr create`/`gh pr merge`/`gh pr comment` -- the
 * .env GITHUB_TOKEN fine-grained PAT lacks "Pull requests: write").
 * Tests: records the call.
 */
export type UpdateBranchFn = (prNumber: number) => void;

/**
 * Maximum number of `gh pr update-branch` auto-recovery attempts for a single
 * BEHIND streak. After this many attempts a still-BEHIND poll terminates the
 * watch with outcome kind 'behind-unrecovered' instead of retrying forever.
 */
export const MAX_UPDATE_BRANCH_ATTEMPTS = 2;

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
	 * Injectable `gh pr update-branch` invocable (US-001, CAM-182). Optional so
	 * existing callers/tests keep compiling: absent means the BEHIND
	 * auto-recovery never runs (the watch just keeps polling on BEHIND, the
	 * pre-US-001 behavior).
	 */
	updateBranchFn?: UpdateBranchFn;
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

/**
 * Terminal outcome of the merge-watch state machine.
 *
 * The non-merged variants carry an optional `prUrl` (US-002, CAM-182) so the
 * caller (sidecar.ts) can write the ship-stalled marker without a second gh
 * poll. Absent when the terminal fired without ever learning the PR url
 * (e.g. timeout).
 */
export type MergeWatchOutcome =
	| { kind: 'merged'; postMerge: PostMergeOutcome }
	| { kind: 'ci-red'; prNumber: number; prUrl?: string }
	| { kind: 'closed-not-merged'; prNumber: number; prUrl?: string }
	| { kind: 'timeout'; polls: number }
	| { kind: 'behind-unrecovered'; prNumber: number; prUrl?: string }
	| { kind: 'dirty'; prNumber: number; prUrl?: string };

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
 * Build the post-merge-done event detail for a successful (ok:true) result.
 * Extracted from processPollResult to keep it under the biome 15-complexity limit.
 * Records issueCloseFailed when closeResult indicates a close failure (US-005).
 */
function buildSuccessPostMergeDoneDetail(
	prNumber: number,
	result: Extract<PostMergeOutcome, { ok: true }>,
): MergeWatchPostMergeDoneEventDetail {
	const detail: MergeWatchPostMergeDoneEventDetail = {
		prNumber, ok: true, tag: result.tag, tagCreated: result.tagCreated,
		branchPrunedLocal: result.branchPrunedLocal,
		branchPrunedRemote: result.branchPrunedRemote,
	};
	if (result.closeResult !== undefined && !result.closeResult.ok) {
		detail.issueCloseFailed = true;
	}
	return detail;
}

/**
 * Emit the 'merge-watch-stalled' event (US-002, CAM-182) via the injected
 * logEvent seam. Called at every non-merged terminal (behind-unrecovered,
 * dirty, ci-red, closed-not-merged, timeout). prUrl/issueId are included only
 * when defined (mirrors the optional-field convention used elsewhere in this
 * module, e.g. writeMergeWatchState's lastPolledAt).
 */
function emitStalledEvent(
	logEvent: ((kind: WorkerEventKind, detail: WorkerEventDetail) => void) | undefined,
	prNumber: number,
	reason: MergeWatchStalledEventDetail['reason'],
	prUrl: string | undefined,
	issueId: string | undefined,
): void {
	const detail: MergeWatchStalledEventDetail = { prNumber, reason };
	if (prUrl !== undefined) detail.prUrl = prUrl;
	if (issueId !== undefined) detail.issueId = issueId;
	logEvent?.('merge-watch-stalled', detail);
}

/**
 * Handle an OPEN+BEHIND poll result (US-001, CAM-182): decide whether to run
 * the bounded `gh pr update-branch` auto-recovery.
 *
 * Guards (all must hold before calling updateBranchFn):
 *   - no failed check in statusCheckRollup (never recover a BEHIND branch
 *     that is also failing CI -- update-branch would just re-run doomed checks).
 *   - autoMergeRequest is armed (non-null): only recover when the PR will
 *     merge itself once CI goes green again, so update-branch always has a
 *     merge follow-up and never leaves the PR mid-flight.
 *   - updateBranchCount < MAX_UPDATE_BRANCH_ATTEMPTS.
 *
 * Returns `{ outcome }` on the give-up terminal, `{ updateBranchCount }` when
 * an attempt was made (caller merges this into the continuing state), or
 * `null` to keep polling with the count unchanged.
 *
 * Extracted from processPollResult to keep it under the biome complexity limit.
 */
function handleBehindStatus(
	status: PrStatus,
	updateBranchCount: number,
	opts: MergeWatchOptions,
	issueId: string | undefined,
): { outcome: MergeWatchOutcome } | { updateBranchCount: number } | null {
	const { prNumber, notifyOrchestrator, updateBranchFn, logEvent } = opts;
	const rollup = status.statusCheckRollup ?? [];
	if (hasFailedCheck(rollup)) {
		return null; // guard: never recover a BEHIND branch that is also failing CI
	}
	const autoMergeArmed = status.autoMergeRequest !== null && status.autoMergeRequest !== undefined;
	if (!autoMergeArmed) {
		return null; // auto-merge not armed: leave the branch alone
	}
	if (updateBranchCount >= MAX_UPDATE_BRANCH_ATTEMPTS) {
		notifyOrchestrator(
			`[cam] merge-watch: PR #${prNumber} still BEHIND after ${updateBranchCount} auto-update-branch attempts, giving up${status.url ? ` - ${status.url}` : ''}`,
		);
		emitStalledEvent(logEvent, prNumber, 'behind-unrecovered', status.url, issueId);
		return { outcome: { kind: 'behind-unrecovered', prNumber, ...(status.url !== undefined ? { prUrl: status.url } : {}) } };
	}
	updateBranchFn?.(prNumber);
	const nextCount = updateBranchCount + 1;
	notifyOrchestrator(
		`[cam] merge-watch: PR #${prNumber} BEHIND, ran gh pr update-branch (attempt ${nextCount}/${MAX_UPDATE_BRANCH_ATTEMPTS})`,
	);
	return { updateBranchCount: nextCount };
}

/**
 * Handle a MERGED poll result: run post-merge and narrate the outcome.
 * Extracted from processPollResult to keep it under the biome complexity limit.
 */
function handleMergedStatus(opts: MergeWatchOptions): { outcome: MergeWatchOutcome } {
	const { prNumber, mergedBranch, cwd, postMergeFn, notifyOrchestrator, logEvent } = opts;
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
		const doneDetail = buildSuccessPostMergeDoneDetail(prNumber, result);
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

/**
 * Handle an OPEN+BLOCKED poll result: GitHub returns BLOCKED while checks are
 * pending, so inspect the rollup before treating it as ci-red (US-R1-003
 * pattern). Extracted from processPollResult to keep it under the biome
 * complexity limit.
 */
function handleBlockedStatus(
	status: PrStatus,
	opts: MergeWatchOptions,
	issueId: string | undefined,
): { outcome: MergeWatchOutcome } | null {
	const { prNumber, notifyOrchestrator, logEvent } = opts;
	const rollup = status.statusCheckRollup ?? [];
	if (rollup.length === 0 || !hasFailedCheck(rollup)) {
		return null; // CI pending/in-progress: keep polling
	}
	notifyOrchestrator(`[cam] CI red, PR #${prNumber} open, not merged`);
	const ciRedDetail: MergeWatchCiRedEventDetail = { prNumber, reason: 'blocked' };
	logEvent?.('merge-watch-ci-red', ciRedDetail);
	emitStalledEvent(logEvent, prNumber, 'ci-red', status.url, issueId);
	return { outcome: { kind: 'ci-red', prNumber, ...(status.url !== undefined ? { prUrl: status.url } : {}) } };
}

/**
 * Handle one non-null poll result.
 *
 * Returns `{ outcome }` when the state machine should stop (terminal outcome),
 * `{ updateBranchCount }` when a BEHIND auto-recovery attempt updated the
 * counter (caller merges this into the continuing state), or `null` to
 * continue polling with the count unchanged.
 *
 * Extracted from runMergeWatch to keep the main function under complexity/line
 * limits (CAM-60 factory/helper pattern).
 */
function processPollResult(
	status: PrStatus,
	opts: MergeWatchOptions,
	updateBranchCount: number,
	issueId: string | undefined,
): { outcome: MergeWatchOutcome } | { updateBranchCount: number } | null {
	const { prNumber, notifyOrchestrator, logEvent } = opts;

	if (status.state === 'MERGED') {
		return handleMergedStatus(opts);
	}

	if (status.state === 'CLOSED') {
		notifyOrchestrator(`[cam] CI red, PR #${prNumber} closed-not-merged`);
		const ciRedDetail: MergeWatchCiRedEventDetail = { prNumber, reason: 'closed' };
		logEvent?.('merge-watch-ci-red', ciRedDetail);
		emitStalledEvent(logEvent, prNumber, 'closed-not-merged', status.url, issueId);
		return { outcome: { kind: 'closed-not-merged', prNumber, ...(status.url !== undefined ? { prUrl: status.url } : {}) } };
	}

	if (status.state === 'OPEN' && status.mergeStateStatus === 'BLOCKED') {
		return handleBlockedStatus(status, opts, issueId);
	}

	if (status.state === 'OPEN' && status.mergeStateStatus === 'DIRTY') {
		notifyOrchestrator(
			`[cam] merge-watch: PR #${prNumber} is DIRTY (merge conflict), stopping${status.url ? ` - ${status.url}` : ''}`,
		);
		emitStalledEvent(logEvent, prNumber, 'dirty', status.url, issueId);
		return { outcome: { kind: 'dirty', prNumber, ...(status.url !== undefined ? { prUrl: status.url } : {}) } };
	}

	if (status.state === 'OPEN' && status.mergeStateStatus === 'BEHIND') {
		return handleBehindStatus(status, updateBranchCount, opts, issueId);
	}

	return null; // OPEN + non-BLOCKED/DIRTY/BEHIND (CLEAN, UNSTABLE, etc.): keep polling
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
	/** Injectable gh pr update-branch invocable (US-001, CAM-182). Absent = never update. */
	updateBranchFn?: UpdateBranchFn;
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
		// No successful poll this tick: prUrl is never known at timeout.
		emitStalledEvent(opts.logEvent, state.prNumber, 'timeout', undefined, state.issueId);
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
		updateBranchFn: opts.updateBranchFn,
	};
	const updateBranchCount = state.updateBranchCount ?? 0;
	const result = processPollResult(status, mergeWatchOpts, updateBranchCount, state.issueId);
	if (result !== null && 'outcome' in result) {
		return { kind: 'terminal', outcome: result.outcome };
	}

	// Non-terminal: keep watching with updated counters. Merge in the new
	// updateBranchCount only when a BEHIND auto-recovery attempt ran; otherwise
	// preserve whatever was already on state (undefined stays undefined).
	const nextState: MergeWatchState = { ...state, pollCount: newPollCount, lastPolledAt: newLastPolledAt };
	if (result !== null && 'updateBranchCount' in result) {
		nextState.updateBranchCount = result.updateBranchCount;
	}
	return { kind: 'continue', state: nextState };
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
		updateBranchFn: opts.updateBranchFn,
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
