// src/supervisor/events.ts
//
// Structured per-story worker observability events (US-013).
//
// The supervisor appends one JSON line per worker lifecycle step to
// .claude/cam-worker-events.jsonl so an operator diagnosing a loop can replay
// exactly what happened: when each worker started, when it ended, what the
// outcome was, and how many tokens its session burned.
//
// The 'result' event detail is RICH enough to be the canonical per-story
// factual record: CAM-31 retired the freeform progress.txt, and the dashboard
// reads this log for its recent-activity panel. The durable Codebase Patterns
// prose is a SEPARATE concern (scripts/cam/patterns.md), kept out of this log.
//
// Design decisions:
//   - The logger is injected (default: append-to-file) so tests collect events
//     in memory without touching the filesystem.
//   - The default file logger is SYNCHRONOUS (appendFileSync) to match the
//     supervisor's all-synchronous injected I/O. (appendFileSync is Bun's own
//     fs primitive; an async Bun.file().writer() would force every emit site in
//     the loop to await and the in-memory test collector to go async too.)
//   - readWorkerTokens resolves the per-story transcript via
//     transcriptPathForSession (US-002) and sums usage with parseTranscriptUsage
//     (reused from src/transcript/usage.ts).

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseTranscriptUsage, transcriptPathForSession } from '../transcript/usage.ts';
import type { WorkerOutcome, WorkerOutcomeKind } from './result.ts';
import type { SpawnResolutionEvent } from '../logging/spawn-resolution.ts';
import handoffSchema from '../../scripts/cam/handoff.schema.json';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * Lifecycle step a WorkerEvent records.
 *
 * Most kinds are per-worker. 'pushed' (US-002) records the supervisor's
 * deterministic verification that a worker's pass actually landed on origin
 * (HEAD == origin/<branch>); see PushEventDetail. 'stale-lock' is a
 * supervisor-level event (US-015): it records that a new supervisor took over a
 * lock whose owning pid was dead. 'rate-limited' (US-016) records a worker
 * pause (phase: 'pause') and the subsequent resume (phase: 'resume') when a
 * worker hits an Anthropic rate-limit; the story is paused, never marked failed.
 * 'no-progress-retry' (CAM-38) records that a worker no-op'd (pre-session
 * instant-exit, likely a startup rate-limit with no printed message) and the
 * supervisor is backing off before re-dispatching the same story; carries a
 * free-form { attempt, backoffMs, completedStory } detail.
 *
 * Merge-watch event kinds (US-008, CAM-101): emitted by the ci-gated merge-watch
 * state machine (src/release/merge-watch.ts) via the injected logEvent seam.
 *   - 'merge-watch-watching': emitted once on the first gh poll (pollCount===0), inside stepMergeWatch.
 *   - 'merge-watch-merged': emitted when GitHub reports state==MERGED.
 *   - 'merge-watch-ci-red': emitted on OPEN+BLOCKED (CI failing) or CLOSED.
 *   - 'merge-watch-post-merge-done': emitted after the post-merge step completes.
 *   - 'merge-watch-stalled' (US-002, CAM-182): emitted on every non-merged
 *     terminal (behind-unrecovered, dirty, ci-red, closed-not-merged, timeout)
 *     so a recycled orchestrator can learn the ship stalled even when the live
 *     send-keys narration is lost. Mirrored by a durable .cam-ship-stalled.json
 *     marker (written by the sidecar caller, removed when the same PR later
 *     merges).
 *   - 'ship-phase-result' (US-004, CAM-149): emitted once per deterministic
 *     shipping-phase run (makeProductionShipPhaseFn, sidecar.ts), recording
 *     the full ShipPhaseResult (ship-runner.ts) -- kind plus its kind-specific
 *     fields (e.g. blockingStoryIds, outputTail, detail, prNumber, mergeMode)
 *     spread into detail -- so a failed ship is diagnosable from
 *     .claude/cam-worker-events.jsonl without reading source.
 *   - 'plan-escalated' (US-002, CAM-204): emitted when the BLOCK->re-plan
 *     loop (US-003) exhausts MAX_REPLAN_ROUNDS without an APPROVE verdict.
 *     Mirrored by a durable .cam-plan-escalated.json marker
 *     (src/supervisor/plan-escalation.ts) so a recycled orchestrator can
 *     derive the BLOCK terminal on wake even when the live send-keys
 *     narration is dropped (CAM-200-independent, CAM-195 style).
 *   - 'plan-target-invalid' (US-003, CAM-203): emitted when an explicit
 *     `/cam-plan <id>` target (planTargetId) named a missing/not-open/
 *     not-plannable issue and runPlanPhase returned the 'plan-target-invalid'
 *     terminal. Recorded alongside the orchestrator-pane notification so the
 *     failure is diagnosable from .claude/cam-worker-events.jsonl.
 *   - 'merge-watch-poll-error' (US-001, CAM-170): emitted when a gh poll
 *     inside stepMergeWatch fails (non-null stderr) on an edge-triggered
 *     basis, carrying the consecutive-failure count and the last stderr. See
 *     MergeWatchPollErrorEventDetail.
 *   - 'suggestion-filed' (US-003, CAM-189): emitted by the production
 *     fileSuggestionsFn closure (sidecar.ts) each time the terminal
 *     SUGGESTION-follow-up-filing hook runs and has something to report (at
 *     least one filed, dup-skipped, or failed finding). See
 *     SuggestionFiledEventDetail.
 *   - 'handoff-schema-warning' (US-002): emitted where the supervisor reads
 *     the handoff, when handoff.officialDocsValidated contains an entry with
 *     an invalid `status` (not one of the handoff.schema.json enum values) or
 *     an unknown object key. Warn-only, non-fatal: it NEVER halts the loop.
 *     See HandoffSchemaWarningEventDetail and validateOfficialDocsValidated.
 *   - 'push-undelivered' (US-001, CAM-200): emitted when a wake-up push
 *     (send-keys nudge to a worker/orchestrator pane) fails delivery
 *     verification after bounded retry. Distinct from the unrelated 'pushed'
 *     kind above (a git-origin push-verification record); this kind carries
 *     only wake-up-delivery metadata (pane id, retries exhausted), never
 *     report content. See PushUndeliveredEventDetail.
 */
export type WorkerEventKind =
	| 'worker-start'
	| 'worker-end'
	| 'result'
	| 'tokens'
	| 'pushed'
	| 'stale-lock'
	| 'rate-limited'
	| 'no-progress-retry'
	| 'pane-died-retry'
	| 'worker-token-ceiling'
	| 'outcome-fallback'
	| 'outcome-source'
	| 'sidecar-exit'
	| 'review-verdict-handback'
	| 'spawn-resolution'
	| 'ship-bump'
	| 'merge-watch-watching'
	| 'merge-watch-merged'
	| 'merge-watch-ci-red'
	| 'merge-watch-post-merge-done'
	| 'merge-watch-stalled'
	| 'ship-phase-result'
	| 'stage-promoted'
	| 'domain-docs-written'
	| 'cycle-tokens'
	| 'meta-loop-observe'
	| 'meta-loop-dispatch'
	| 'container-preflight'
	| 'plan-preflight-failed'
	| 'plan-escalated'
	| 'plan-target-invalid'
	| 'merge-watch-poll-error'
	| 'suggestion-filed'
	| 'handoff-schema-warning'
	| 'push-undelivered';

/** Gate status recorded in a 'result' event. */
export type GateStatus = 'pass' | 'fail' | 'unknown';

/** One Step-5.5 docs-validation entry, mirrored from handoff.json. */
export interface DocValidatedEntry {
	lib: string;
	status: string;
	url?: string;
}

/** Rich 'result' event detail: the canonical per-story factual record. */
export interface ResultEventDetail {
	/** Worker outcome kind (pass / incomplete / fail / blocked / unknown). */
	outcome: WorkerOutcomeKind;
	/** Files the worker created or modified (from handoff.json). */
	filesChanged: string[];
	/** Quality-gate verdicts the supervisor can attest to. */
	gates: { typecheck: GateStatus; tests: GateStatus };
	/** Step-5.5 docs validated by the worker (from handoff.json). */
	docsValidated: DocValidatedEntry[];
}

/** 'tokens' event detail: per-story session token usage. */
export interface TokensEventDetail {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/**
	 * Cache-creation tokens. Carried so the per-worker token ceiling (CAM-5) can
	 * compute spend with the same formula as the orchestrator budget
	 * (input + cacheCreation + cacheRead, src/orchestrator/budget.ts).
	 */
	cacheCreationTokens: number;
}

/**
 * 'pushed' event detail: a single auditable record of one push verification.
 *
 * Why a new 'pushed' kind rather than folding this into the 'result' event:
 * the supervisor verifies the push on EVERY pass (US-001), a distinct lifecycle
 * moment from the rich per-story 'result' record. A dedicated kind gives one
 * auditable record per push and decouples its lifecycle from 'result', so
 * verifying a push at every pass does not perturb the existing result-event
 * consumer surface (e.g. the dashboard recent-activity panel, CAM-31).
 *   - sha: the local HEAD sha confirmed against origin/<branch>.
 *   - pushed: true if the push moved origin; false if origin already matched.
 *   - ok: whether HEAD == origin/<branch> held after the idempotent push.
 *   - detail: human-readable outcome (git stdout/stderr, or 'up-to-date').
 */
export interface PushEventDetail {
	sha: string;
	pushed: boolean;
	ok: boolean;
	detail: string;
}

/**
 * 'review-verdict-handback' event detail: emitted in the review branch of the
 * supervisor loop after a reviewer worker completes and the verdict is known.
 * Provides an auditable record of the handback independently of pane scrollback.
 *   - verdict: the string stored in prd.review.lastVerdict (e.g. 'CLEAN',
 *     'FIXES_PENDING:3', 'MAX_ROUNDS_DEBT').
 *   - round: the roundsCompleted counter from prd.review at the time of emit.
 */
export interface ReviewVerdictHandbackEventDetail {
	verdict: string;
	round: number;
}

/**
 * 'outcome-source' event detail: emitted after every readWorkerOutcome call in
 * the implement branch, recording which source won the outcome decision and what
 * the integrity check concluded.
 *   - winningSrc: 'worker-report' when worker-report.json drove the outcome;
 *     'fallback' when the legacy handoff/sentinel path was used instead.
 *   - integrityResult: 'confirmed-pass' (prd.json passes:true confirmed),
 *     'incomplete' (DONE reported but prd.json not flipped), or
 *     'stale-absent-rejection' (blocked/fail/unknown; no integrity to confirm).
 *   - detail: verbatim outcome.detail string for operator diagnostics.
 */
export interface OutcomeSourceEventDetail {
	winningSrc: 'worker-report' | 'fallback';
	integrityResult: 'confirmed-pass' | 'incomplete' | 'stale-absent-rejection';
	detail: string;
}

/**
 * 'merge-watch-watching' event detail: emitted once on the first gh poll
 * (pollCount===0, inside stepMergeWatch). Allows operator to identify when monitoring started.
 */
export interface MergeWatchWatchingEventDetail {
	prNumber: number;
	mergedBranch: string;
}

/**
 * 'merge-watch-merged' event detail: emitted when GitHub reports state==MERGED.
 * The post-merge step is about to run when this event fires.
 */
export interface MergeWatchMergedEventDetail {
	prNumber: number;
}

/**
 * 'merge-watch-ci-red' event detail: emitted when the PR cannot proceed to
 * merge due to a failing or blocking condition.
 *   - reason 'blocked': state==OPEN and mergeStateStatus==BLOCKED (CI failing).
 *   - reason 'closed': state==CLOSED (PR closed without merging).
 */
export interface MergeWatchCiRedEventDetail {
	prNumber: number;
	reason: 'blocked' | 'closed';
}

/**
 * 'merge-watch-post-merge-done' event detail: emitted after the post-merge step
 * completes (whether successful or failed).
 *   - ok: true if the post-merge step succeeded.
 *   - tag: the semver tag created/found on main (present when ok==true).
 *   - tagCreated: whether the tag was newly created (present when ok==true).
 *   - branchPrunedLocal: whether the local branch was deleted (present when ok==true).
 *   - branchPrunedRemote: whether the remote branch was deleted (present when ok==true).
 *   - reason: failure reason string (present when ok==false).
 */
export interface MergeWatchPostMergeDoneEventDetail {
	prNumber: number;
	ok: boolean;
	tag?: string;
	tagCreated?: boolean;
	branchPrunedLocal?: boolean;
	branchPrunedRemote?: boolean;
	reason?: string;
	/**
	 * true when the post-merge git steps all succeeded (ok:true) but the issue
	 * close returned not-found or another error (US-005). The close failure is
	 * also surfaced via printError in runPostMerge.
	 */
	issueCloseFailed?: boolean;
}

/**
 * 'merge-watch-stalled' event detail (US-002, CAM-182): emitted on every
 * non-merged merge-watch terminal (behind-unrecovered, dirty, ci-red,
 * closed-not-merged, timeout). prUrl/issueId are omitted when unknown (e.g.
 * timeout before any successful poll never learns the PR url).
 */
export interface MergeWatchStalledEventDetail {
	prNumber: number;
	reason: 'behind-unrecovered' | 'dirty' | 'ci-red' | 'closed-not-merged' | 'timeout';
	prUrl?: string;
	issueId?: string;
}

/**
 * 'merge-watch-poll-error' event detail (US-001, CAM-170): emitted, on an
 * edge-triggered basis, when a gh poll inside stepMergeWatch fails.
 *   - prNumber: the PR being watched.
 *   - consecutiveNullPolls: how many consecutive gh polls have failed so far
 *     (mirrors MergeWatchState.consecutiveNullPolls).
 *   - lastStderr: the stderr text from the most recent failed gh call.
 */
export interface MergeWatchPollErrorEventDetail {
	prNumber: number;
	consecutiveNullPolls: number;
	lastStderr: string;
}

/**
 * 'stage-promoted' event detail: emitted by specifyIssueOnMain (the grill spec
 * writer) immediately after a successful commit. Carries the issue id and the
 * stage transition so a grill promotion is replayable from the event log.
 *   - id: the issue id that was promoted (e.g. 'CAM-42').
 *   - fromStage: the stage before promotion (always 'idea' for specifyIssueOnMain).
 *   - toStage: the stage after promotion (always 'specified' for specifyIssueOnMain).
 */
export interface StagePromotedEventDetail {
	id: string;
	fromStage: string;
	toStage: string;
}

/**
 * 'domain-docs-written' event detail: emitted by writeDomainDocsOnMain (the
 * /cam-spec domain-docs writer, CAM-118) immediately after a successful
 * (non-noOp) commit. Carries the id the domain docs were written for and the
 * list of newly-created ADR filenames (empty when the payload had no new,
 * non-duplicate ADR entries).
 *   - id: the id the domain docs were written for (e.g. an issue id).
 *   - adrFiles: filenames (not full paths) of newly-created docs/adr/ files.
 */
export interface DomainDocsWrittenEventDetail {
	id: string;
	adrFiles: string[];
}

/**
 * 'cycle-tokens' event detail: emitted at cycle-close time, recording the
 * per-cycle token spend for both the orchestrator session and all worker sessions
 * in that cycle. Used by CAM-136 for per-issue token analysis.
 *   - cycleId: machine identifier for the cycle (e.g. 'cam/CAM-131-handoff-por-ciclo').
 *   - issueNumber: issue reference (e.g. 'CAM-131').
 *   - orchTokens: cumulative orchestrator session spend (input + cacheCreation + cacheRead).
 *   - workerTokens: sum of all worker 'tokens' events in this cycle (per-cycle slice).
 *   - total: orchTokens + workerTokens.
 *   - recordedAt: ISO 8601 timestamp when the event was emitted.
 */
export interface CycleTokensEventDetail {
	cycleId: string;
	issueNumber: string;
	orchTokens: number;
	workerTokens: number;
	total: number;
	recordedAt: string;
}

/**
 * 'meta-loop-observe' event detail: emitted by the meta-loop observer to record
 * what the drainer would select next (or that the queue is empty), without
 * performing any mutation. Discriminated union of two shapes:
 *   - { wouldSelect, rank, wsjf }: a plannable issue was found at the given rank
 *     with the given computed WSJF scalar (not the WsjfScore object).
 *   - { drained: true }: the queue is empty (no plannable issue remains).
 */
export type MetaLoopObserveEventDetail =
	| { wouldSelect: string; rank: number; wsjf: number }
	| { drained: true };

/**
 * 'meta-loop-dispatch' event detail: emitted by the auto-dispatcher on each
 * idle tick at a safe cycle boundary. Discriminated union of five shapes:
 *   - { dispatched, issueId, rank }: phase:planning was written for the selected
 *     issue; the plan runner will pick it up on the next sidecar tick.
 *   - { refused, reason }: preconditions not met; dispatch refused fail-closed.
 *     reason mirrors DrainPreconditionResult.reason ('container-not-active' |
 *     'plan-approval-not-auto').
 *   - { stopped }: kill-switch engaged; dispatcher parked at boundary.
 *     Emitted once per kill-switch engagement (deduped in closure state).
 *   - { blockedCycle }: prd.json present with review.lastVerdict === 'MAX_ROUNDS_DEBT';
 *     drain parks until the operator clears the block (removes/finalizes prd.json).
 *     Emitted once per engagement (deduped in closure state). (US-005, CAM-139)
 *   - { refusedTarget, targetId }: a pending explicit plan_issue (operator
 *     /cam-plan <id> target) was not plannable (missing, not open, or blocked);
 *     the dispatcher never substitutes a different issue on this tick and
 *     clears the stale plan_issue so the next tick resumes top-of-queue
 *     dispatch. (US-004, CAM-203)
 *   - { skipped, reason }: a boundary check refused the tick silently before
 *     this story (US-007, CAM-195 Defect 2 refusals): reason is
 *     'cycle-in-flight' (prd.json present with a non-MAX_ROUNDS_DEBT verdict:
 *     a plain in-flight cycle, distinct from the blockedCycle terminal above),
 *     'merge-watch-present' (a merge-watch marker is pending), or
 *     'phase-not-idle' (loop phase is neither undefined nor 'idle'). Emitted
 *     every tick the boundary is hit (no dedup); this is a visibility fix,
 *     not a rate-limited event.
 */
export type MetaLoopDispatchSkipReason = 'cycle-in-flight' | 'merge-watch-present' | 'phase-not-idle';

export type MetaLoopDispatchEventDetail =
	| { dispatched: true; issueId: string; rank: number }
	| { refused: true; reason: string }
	| { stopped: true }
	| { blockedCycle: true }
	| { refusedTarget: true; targetId: string }
	| { skipped: true; reason: MetaLoopDispatchSkipReason };

/**
 * 'container-preflight' event detail: emitted once per implement dispatch
 * immediately before the respawn-pane call (B-1 observe-only; B-2 / CAM-152
 * will flip this fail-closed). The result is logged for observability without
 * gating or altering the host spawn in B-1.
 *   - ready: true when daemon is reachable and the image is present/current.
 *   - reason: set only when ready=false ('daemon-unreachable' | 'image-missing' | 'image-stale').
 */
export interface ContainerPreflightEventDetail {
	ready: boolean;
	reason?: string;
}

/**
 * 'plan-escalated' event detail (US-002, CAM-204): emitted when the
 * BLOCK->re-plan loop exhausts MAX_REPLAN_ROUNDS without an APPROVE verdict.
 *   - issueId: the issue the re-plan loop was targeting.
 *   - roundsCompleted: how many re-plan rounds actually ran before giving up.
 */
export interface PlanEscalatedEventDetail {
	issueId: string;
	roundsCompleted: number;
}

/**
 * 'plan-target-invalid' event detail (US-003, CAM-203): emitted when an
 * explicit /cam-plan <id> target could not be planned (missing, not-open, or
 * not-plannable) and runPlanPhase returned { kind: 'plan-target-invalid' }.
 *   - targetId: the explicit target id that failed to resolve.
 */
export interface PlanTargetInvalidEventDetail {
	targetId: string;
}

/**
 * 'suggestion-filed' event detail (US-003, CAM-189): emitted by the
 * production fileSuggestionsFn closure (sidecar.ts) each time it runs and has
 * something to report. Gives a per-tick audit trail of the review SUGGESTION
 * follow-up-filing hook independently of the single orchestrator-pane summary
 * line (which only fires when penned is non-zero).
 *
 * US-003 (CAM-285): the sink changed from filing idea-stage issues
 * (createLocalIssueOnMain) to appending to the suggestions pen
 * (appendSuggestionOnMain), so this detail reports pen-append COUNTS, never
 * filed issue ids.
 *   - penned: number of SUGGESTIONs actually appended to the pen this tick.
 *   - dupSkipped: SUGGESTIONs skipped because their fingerprint already
 *     existed in the pen, an open backlog issue, or was a duplicate within
 *     the same batch.
 *   - failedCount: SUGGESTIONs whose appendSuggestionOnMain call returned
 *     ok:false (diverged main, detached head, missing main, suggestions
 *     pen missing); skipped and warned, never thrown.
 */
export interface SuggestionFiledEventDetail {
	penned: number;
	dupSkipped: number;
	failedCount: number;
}

/**
 * 'handoff-schema-warning' event detail: one schema violation found in a
 * handoff.officialDocsValidated entry (US-002). Warn-only — never blocks the
 * loop, never coerces the offending entry.
 *   - field: which handoff field the violation was found in (always
 *     'officialDocsValidated' today; kept as a string so the guard can be
 *     reused for other handoff fields later without a shape change).
 *   - index: index of the offending entry within the array.
 *   - issues: human-readable descriptions of every issue found on that one
 *     entry (e.g. an invalid status AND an unknown key both collapse into
 *     this single warning's issues list, per AC: one entry -> one warning).
 */
export interface HandoffSchemaWarningEventDetail {
	field: string;
	index: number;
	issues: string[];
}

/**
 * 'push-undelivered' event detail (US-001, CAM-200): recorded when a wake-up
 * push to a pane fails delivery verification after bounded retry. Carries
 * only wake-up-delivery metadata: no report content ever travels in this
 * event, per the CAM-75/77/78 structured-handback decision (durable truth
 * lives in files; the pane only carries the wake-up nudge).
 *   - paneId: the tmux pane id the wake-up push targeted (e.g. '%3').
 *   - retriesExhausted: the number of retry attempts made before giving up.
 */
export interface PushUndeliveredEventDetail {
	paneId: string;
	retriesExhausted: number;
}

/** Detail payload by event kind ('worker-start'/'worker-end' carry free-form maps). */
export type WorkerEventDetail =
	| ResultEventDetail
	| TokensEventDetail
	| PushEventDetail
	| ReviewVerdictHandbackEventDetail
	| OutcomeSourceEventDetail
	| SpawnResolutionEvent
	| MergeWatchWatchingEventDetail
	| MergeWatchMergedEventDetail
	| MergeWatchCiRedEventDetail
	| MergeWatchPostMergeDoneEventDetail
	| MergeWatchStalledEventDetail
	| MergeWatchPollErrorEventDetail
	| StagePromotedEventDetail
	| DomainDocsWrittenEventDetail
	| CycleTokensEventDetail
	| MetaLoopObserveEventDetail
	| MetaLoopDispatchEventDetail
	| ContainerPreflightEventDetail
	| PlanEscalatedEventDetail
	| PlanTargetInvalidEventDetail
	| SuggestionFiledEventDetail
	| HandoffSchemaWarningEventDetail
	| PushUndeliveredEventDetail
	| Record<string, unknown>;

/** A single structured worker lifecycle event. */
export interface WorkerEvent {
	/** ISO timestamp the event was emitted. */
	ts: string;
	/** Story id (advisory at worker-start, actual once known). May be undefined. */
	storyId: string | undefined;
	/** Worker session uuid; constant across one worker's whole lifecycle. */
	uuid: string;
	/** Which lifecycle step this records. */
	kind: WorkerEventKind;
	/** Event-specific payload. */
	detail: WorkerEventDetail;
}

/** Injected event sink. The default appends a JSON line to a file. */
export type WorkerEventLogger = (event: WorkerEvent) => void;

/** Subset of handoff.json this module reads to build the 'result' detail. */
export interface HandoffForResult {
	createdFiles?: string[];
	modifiedFiles?: string[];
	officialDocsValidated?: Array<{ lib?: string; status?: string; url?: string }>;
}

// ---------------------------------------------------------------------------
// Loggers
// ---------------------------------------------------------------------------

/**
 * Append-to-file logger: one JSON line per event at `path`.
 * Creates the parent directory if it does not exist.
 */
export function makeFileEventLogger(path: string): WorkerEventLogger {
	return (event: WorkerEvent) => {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
	};
}

/**
 * In-memory logger for tests. Returns the logger plus the backing array so a
 * test can assert on the captured events.
 */
export function makeInMemoryEventLogger(): { logger: WorkerEventLogger; events: WorkerEvent[] } {
	const events: WorkerEvent[] = [];
	const logger: WorkerEventLogger = (event) => {
		events.push(event);
	};
	return { logger, events };
}

// ---------------------------------------------------------------------------
// Detail builders
// ---------------------------------------------------------------------------

/**
 * Build the rich 'result' event detail from a worker outcome + handoff.
 *
 * - filesChanged = handoff.createdFiles ++ handoff.modifiedFiles.
 * - gates: the supervisor has no per-worker gate transcript, so a 'pass'
 *   outcome records both gates as 'pass' (prd.json passes:true is the
 *   corroboration the worker's gates were green); every other outcome records
 *   'unknown'.
 * - docsValidated mirrors handoff.officialDocsValidated (lib + status [+ url]).
 */
export function buildResultDetail(
	outcome: WorkerOutcome,
	handoff: HandoffForResult | null,
): ResultEventDetail {
	const created = handoff?.createdFiles ?? [];
	const modified = handoff?.modifiedFiles ?? [];
	const gate: GateStatus = outcome.kind === 'pass' ? 'pass' : 'unknown';
	const docsValidated: DocValidatedEntry[] = (handoff?.officialDocsValidated ?? []).map((d) => {
		const entry: DocValidatedEntry = { lib: d.lib ?? 'unknown', status: d.status ?? 'unknown' };
		if (d.url !== undefined) entry.url = d.url;
		return entry;
	});
	return {
		outcome: outcome.kind,
		filesChanged: [...created, ...modified],
		gates: { typecheck: gate, tests: gate },
		docsValidated,
	};
}

/**
 * Valid `status` values for a handoff.officialDocsValidated entry. Derived at
 * runtime from the `status` enum in scripts/cam/handoff.schema.json (imported
 * as a JSON module) rather than hand-copied, so the schema is the single
 * source of truth and this array cannot drift from it.
 */
export const OFFICIAL_DOCS_VALIDATED_STATUSES = handoffSchema.properties.officialDocsValidated.items.properties.status.enum;

/**
 * Keys allowed on a handoff.officialDocsValidated entry. Derived at runtime
 * from Object.keys of the item schema's properties in
 * scripts/cam/handoff.schema.json (imported as a JSON module) rather than
 * hand-copied; that item schema sets `additionalProperties: false`.
 */
const OFFICIAL_DOCS_VALIDATED_ALLOWED_KEYS = new Set(
	Object.keys(handoffSchema.properties.officialDocsValidated.items.properties),
);

/**
 * Targeted, hand-rolled schema guard for handoff.officialDocsValidated
 * (US-002). Checks each entry's `status` against OFFICIAL_DOCS_VALIDATED_STATUSES
 * and flags any key not in OFFICIAL_DOCS_VALIDATED_ALLOWED_KEYS. This closes the
 * gap left by the loose `status ?? 'unknown'` reads elsewhere in this module
 * (and in loop.ts) that silently swallow a malformed entry: the loose default
 * stays as-is (this guard only warns, it never tightens what downstream
 * consumers accept).
 *
 * Warn-only by design: returns a list of violations for the caller to log via
 * a 'handoff-schema-warning' event. Never throws, never signals a hard
 * failure — a schema-invalid Step-5.5 entry must not halt an otherwise-healthy
 * loop. One offending entry collapses ALL of its issues (bad status, unknown
 * keys) into a single warning, per the one-entry-one-warning contract.
 *
 * Returns [] when `entries` is absent or every entry is conformant.
 */
export function validateOfficialDocsValidated(entries: unknown): HandoffSchemaWarningEventDetail[] {
	if (!Array.isArray(entries)) return [];
	const warnings: HandoffSchemaWarningEventDetail[] = [];
	entries.forEach((raw, index) => {
		if (raw === null || typeof raw !== 'object') {
			warnings.push({ field: 'officialDocsValidated', index, issues: ['entry is not an object'] });
			return;
		}
		const entry = raw as Record<string, unknown>;
		const issues: string[] = [];
		const status = entry.status;
		if (typeof status !== 'string' || !(OFFICIAL_DOCS_VALIDATED_STATUSES as readonly string[]).includes(status)) {
			issues.push(`invalid status: ${JSON.stringify(status)}`);
		}
		for (const key of Object.keys(entry)) {
			if (!OFFICIAL_DOCS_VALIDATED_ALLOWED_KEYS.has(key)) {
				issues.push(`unknown key: ${key}`);
			}
		}
		if (issues.length > 0) {
			warnings.push({ field: 'officialDocsValidated', index, issues });
		}
	});
	return warnings;
}

/**
 * Read the per-story transcript for `uuid` and return its token usage.
 *
 * Resolves the JSONL via transcriptPathForSession (US-002), reads it with the
 * injected `readFile` (default: synchronous node/Bun fs), and sums usage with
 * parseTranscriptUsage. Returns null when the transcript is absent or
 * unreadable, so the supervisor can skip the 'tokens' event rather than record
 * misleading zeros.
 */
export function readWorkerTokens(
	uuid: string,
	cwd: string,
	claudeDir: string,
	readFile: (path: string) => string | null = defaultReadFile,
): TokensEventDetail | null {
	const path = transcriptPathForSession(uuid, cwd, claudeDir);
	const jsonl = readFile(path);
	if (jsonl === null) return null;
	const usage = parseTranscriptUsage(jsonl);
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheCreationTokens: usage.cacheCreation,
	};
}

function defaultReadFile(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}
