// src/supervisor/review.ts
//
// Review worker dispatch for the cam supervisor.
//
// Provides:
//   1. buildReviewerWorkerArgv - pure argv builder mirroring worker-argv.ts
//      but for the reviewer agent (subagent-reviewer).
//   2. parseReviewVerdict - pure pane-text parser for <review>...</review> tags.
//   3. makeReviewDispatch - factory that returns a ReviewDispatch closure
//      suitable for injection into runSupervisor. The closure:
//        a. respawns the worker pane with an interactive TUI reviewer,
//        b. polls capture-pane until the <review> tag, pane death, or timeout,
//        c. parses the verdict,
//        d. updates prd.json (roundsCompleted, lastVerdict, new US-RX-NNN stories).
//
// Design decisions:
//   - buildReviewerWorkerArgv is NOT a pure function: it delegates to
//     ClaudeAdapter.buildSpawnArgv, which writes the task prompt to a
//     per-dispatch file on disk (reaping any prior prompt-file siblings) as
//     a side effect of building the argv string (US-001, CAM-433,
//     task-prompt-file.ts).
//   - parseReviewVerdict is a pure function (no I/O). It returns newStories: []
//     always; story creation is the responsibility of makeReviewDispatch, which
//     has access to the prd round counter.
//   - The <review> tag grammar (from .claude/agents/subagent-reviewer.md):
//       <review>CLEAN</review>
//       <review>FIXES_PENDING:N</review>
//     No other tag values are emitted by the reviewer; MAX_ROUNDS_DEBT is derived
//     by the supervisor when roundsCompleted >= maxRounds.
//   - US-RX-NNN story IDs follow cam-review.md Step 5.4:
//       US-R{roundNumber}-{NNN} where roundNumber = roundsCompleted + 1.
//   - The reviewer runs as an interactive TUI session (CAM-42: claude -p is
//     forbidden for subscription accounts) and does NOT exit on its own; the
//     dispatch polls for the <review> tag, mirroring the implementer's
//     sentinel polling in loop.ts.

import type { ReviewDispatch, ReviewDispatchResult, SpawnFn, CapturePane, ReadPrd, WritePrd, EnsureWorkerPane } from './loop.ts';
import type { WorkerEventLogger } from './events.ts';
import type { ReviewReport, ReviewFinding } from './review-report.ts';
import type { PreflightResult } from './preflight-container.ts';
import { ClaudeAdapter, selectAdapter, DEFAULT_REVIEWER_AGENT, REVIEWER_TASK_PROMPT } from './backend-adapter.ts';
import { readPhaseBackend } from '../config/models.ts';
import type { WorkerIsolation } from '../config/models.ts';
import { emitSpawnResolution } from '../logging/spawn-resolution.ts';
import { dockerExecWrap } from './docker-exec.ts';
import { codexAuthPreflight } from './codex-auth.ts';
import type { CodexAuthCheck } from './codex-auth.ts';
import { resolvePhaseModel } from '../config/model-resolution.ts';
import type { CodexModelsCacheReader } from '../config/codex-models-cache.ts';
import type { DispatchFailedMarker } from './dispatch-failed-marker.ts';
import {
	removeWorkerTaskPrompt,
	runCheckedWorkerSentinel,
	runVerifiedWorkerDispatch,
} from './worker-dispatch.ts';
import { emitEarlyDeathTerminal } from './verified-dispatch.ts';
import type { EarlyDeathVerdict } from './early-death.ts';

export { DEFAULT_REVIEWER_AGENT, REVIEWER_TASK_PROMPT };

// ---------------------------------------------------------------------------
// buildReviewerWorkerArgv
// ---------------------------------------------------------------------------

/** Arguments for buildReviewerWorkerArgv. */
export interface ReviewerWorkerArgvOptions {
	/** UUID for this reviewer invocation; passed as --session-id. */
	uuid: string;
	/**
	 * Agent name matching the .claude/agents/<name>.md frontmatter.
	 * Defaults to 'subagent-reviewer'.
	 */
	agentName?: string;
	/**
	 * Free-text task prompt for the reviewer session. The TUI needs an initial
	 * prompt (CAM-41); it is delivered via the per-dispatch prompt file.
	 * Defaults to REVIEWER_TASK_PROMPT.
	 */
	taskPrompt?: string;
	/**
	 * Claude permission mode forwarded to the spawned claude process (NEVER a
	 * cam CLI flag). Required so the reviewer can run quality gates without
	 * interactive permission prompts. Defaults to 'bypassPermissions'.
	 */
	permissionMode?: string;
	/**
	 * Model to pass as `--model` to the spawned claude process.
	 * Defaults to DEFAULTS.reviewer when absent. The caller (makeReviewDispatch)
	 * passes readPhaseModel('reviewer') so the project config is respected.
	 */
	model?: string;
	/**
	 * Worker isolation mode (US-001, CAM-242). Threaded into workerEnvPrefix so
	 * CLAUDE_CODE_OAUTH_TOKEN is stripped on 'host' only. Defaults to 'host'.
	 */
	isolation?: WorkerIsolation;
}

/**
 * Build the shell string passed to `respawn-pane` to launch an interactive
 * TUI reviewer worker.
 *
 * Returns a shell string with the shape:
 *
 *   env -u CLAUDECODE -u ... claude --permission-mode <mode> --session-id <uuid> \
 *     --agent <agentName> "$(cat -- '<taskPromptFilePath>')"
 *
 * The `env -u ...` prefix strips nesting-detection env vars so the reviewer
 * boots from a tmux server bootstrapped inside a claude session (CAM-43). -p
 * and --output-format are omitted so the process stays open for interaction.
 * The tmux wait-for chain is also omitted; the supervisor detects completion
 * by polling capture-pane for the <review> verdict tag.
 *
 * The task prompt is written to a per-dispatch file (task-prompt-file.ts,
 * US-001/CAM-433) rather than embedded in the argv; the returned string
 * carries a `"$(cat -- '<path>')"` snippet that reads it back at exec time
 * (CAM-41: a promptless reviewer dies instantly). --permission-mode lets
 * quality gates run unprompted.
 *
 * US-003 (CAM-339): thin wrapper resolving the 'reviewer' actor and delegating
 * to ClaudeAdapter.buildSpawnArgv (backend-adapter.ts) for the actual assembly.
 */
export function buildReviewerWorkerArgv(opts: ReviewerWorkerArgvOptions): string {
	return new ClaudeAdapter().buildSpawnArgv('reviewer', opts);
}

// ---------------------------------------------------------------------------
// parseReviewVerdict
// ---------------------------------------------------------------------------

/** Possible reviewer verdicts (from .claude/agents/subagent-reviewer.md grammar). */
export type ReviewVerdictKind = 'CLEAN' | 'FIXES_PENDING';

/** Result of parseReviewVerdict. */
export interface ParsedReviewVerdict {
	/** The verdict parsed from the <review> tag. */
	verdict: ReviewVerdictKind;
	/**
	 * Number of findings requiring stories.
	 * 0 for CLEAN; N (from FIXES_PENDING:N) for FIXES_PENDING.
	 */
	findingsCount: number;
	/**
	 * New stories to create (US-RX-NNN format).
	 * Always [] when returned from parseReviewVerdict; populated by makeReviewDispatch.
	 */
	newStories: Array<{ id: string; title: string }>;
}

/**
 * Parse the <review> verdict tag from captured pane text.
 *
 * Looks for the LAST occurrence of a <review> tag (the reviewer may have
 * partial output; the last tag is the final verdict).
 *
 * Returns null if no recognizable <review> tag is found.
 *
 * Grammar (from .claude/agents/subagent-reviewer.md):
 *   <review>CLEAN</review>
 *   <review>FIXES_PENDING:N</review>   where N is a positive integer
 */
export function parseReviewVerdict(capturedPaneText: string): ParsedReviewVerdict | null {
	// Collect all matches; take the last one as the final verdict.
	const regex = /<review>(CLEAN|FIXES_PENDING:(\d+))<\/review>/g;
	let lastMatch: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;

	while ((m = regex.exec(capturedPaneText)) !== null) {
		lastMatch = m;
	}

	if (lastMatch === null) return null;

	const inner = lastMatch[1] ?? '';

	if (inner === 'CLEAN') {
		return { verdict: 'CLEAN', findingsCount: 0, newStories: [] };
	}

	// FIXES_PENDING:N
	const countStr = lastMatch[2] ?? '0';
	const findingsCount = parseInt(countStr, 10);

	return {
		verdict: 'FIXES_PENDING',
		findingsCount: isNaN(findingsCount) ? 0 : findingsCount,
		newStories: [],
	};
}

// ---------------------------------------------------------------------------
// makeReviewDispatch
// ---------------------------------------------------------------------------

/** Options for makeReviewDispatch. */
export interface MakeReviewDispatchOptions {
	/** Spawn a shell command. */
	spawn: SpawnFn;
	/** Capture the text of a tmux pane (full scrollback via -S -). */
	capturePane: CapturePane;
	/** Read the current prd.json snapshot. */
	readPrd: ReadPrd;
	/** Write a modified prd.json back to disk. */
	writePrd: WritePrd;
	/** Pane id of the worker slot used for the reviewer. */
	workerPaneId: string;
	/** Project `.claude` directory for per-dispatch task-prompt transport. */
	claudeDir?: string;
	/** Persist a verified dispatch or checked timeout-sentinel failure. */
	writeDispatchFailedMarkerFn?: (marker: DispatchFailedMarker) => void;
	/** Remove stale dispatch-failed evidence after verified convergence. */
	removeDispatchFailedMarkerFn?: () => void;
	/** Live narration sink for verified dispatch/timeout failures. */
	notifyFn?: (message: string) => void;
	/** Remove this review dispatch's own task-prompt file at its terminal. */
	removeTaskPromptFileFn?: (uuid: string) => void;
	/** Check whether the reviewer pane is still alive (poll loop guard). */
	isPaneAlive: (paneId: string) => boolean;
	/** Sleep between polling ticks. Tests inject a no-op. */
	sleepFn: (ms: number) => void;
	/**
	 * Claude permission mode forwarded to the spawned reviewer (NEVER a cam CLI
	 * flag). Required so the interactive reviewer can run gates unprompted.
	 */
	permissionMode: string;
	/** Task prompt override. Defaults to REVIEWER_TASK_PROMPT. */
	taskPrompt?: string;
	/** Agent name override. Defaults to DEFAULT_REVIEWER_AGENT. */
	agentName?: string;
	/** Polling interval in ms. Default: DEFAULT_REVIEW_POLL_INTERVAL_MS (5s). */
	pollIntervalMs?: number;
	/** Per-review deadline in ms. Default: DEFAULT_REVIEW_TIMEOUT_MS (30 min). */
	timeoutMs?: number;
	/** Monotonic-ish clock in ms. Defaults to Date.now. Injectable for tests. */
	now?: () => number;
	/**
	 * Ensure a live worker pane exists before the respawn-pane call (CAM-57).
	 * When provided, called at the top of each reviewDispatch invocation before
	 * the `respawn-pane -k`. If the current pane is dead, it creates a fresh
	 * one and returns the new id; the returned id is used for respawn-pane and
	 * all poll calls in this invocation. Optional: when absent, the static
	 * `workerPaneId` from opts is used as-is (backward compat).
	 */
	ensureWorkerPane?: EnsureWorkerPane;
	/**
	 * Structured worker event logger (US-007). When provided, spawn-resolution
	 * events are persisted to .claude/cam-worker-events.jsonl. When absent, the
	 * event is silently dropped (backward compat).
	 */
	logEvent?: WorkerEventLogger;
	/**
	 * Read the reviewer's structured exit report from review-report.json.
	 * Returns the parsed ReviewReport when the file is present and well-formed,
	 * or null on any read/parse error (graceful degradation: never throws).
	 * When present, a non-null return is treated as the primary completion signal
	 * and the verdict/findings are sourced from the file instead of capture-pane.
	 * When absent (undefined), the poll loop falls back to parseReviewVerdict over
	 * capture-pane text (tag-based sentinel).
	 * Mirrors the readWorkerReport dep in RunSupervisorOptions.
	 */
	readReviewReport?: () => ReviewReport | null;
	/**
	 * Called when readReviewReport is provided but returns null (file missing or
	 * malformed) AND the dispatch ultimately resolves the verdict via the
	 * <review>-tag fallback. Called at most once per dispatch invocation.
	 * Defaults to console.warn when absent. Injectable for tests.
	 */
	warnFn?: (msg: string) => void;
	/**
	 * Remove any stale review-report.json before the reviewer is (re)spawned.
	 * Mirrors clearWorkerReport in RunSupervisorOptions: prevents a leftover
	 * report from round N from being read on the first poll tick of round N+1.
	 * Best-effort: no-op on missing file, never throws. Optional for backward
	 * compat with callers that do not yet inject this dep.
	 */
	clearReviewReport?: () => void;
	/**
	 * Worker isolation mode (US-005 / CAM-152).
	 * 'container': wraps shellCmd through dockerExecWrap before respawn-pane and
	 *   enables fail-closed preflight (preflightContainerFn not-ready -> error).
	 * 'host' (default): no wrapping, no preflight gating. All existing behavior
	 *   unchanged (backward compat).
	 */
	workerIsolation?: WorkerIsolation;
	/**
	 * Container preflight seam (US-005 / CAM-152).
	 * When provided, called before each reviewer respawn-pane. In container mode
	 * a not-ready result is fail-closed: returns status='error' with a
	 * 'container-not-ready' detail, never dispatches an un-wrapped host reviewer.
	 * When absent (or in host mode), dispatch is unchanged (backward compat).
	 */
	preflightContainerFn?: () => PreflightResult;
	/**
	 * Optional escalation hook called fire-and-forget when container preflight
	 * fails in container mode. Mirrors escalateFn in RunSupervisorOptions.
	 * When absent, the blocked return is silent (no escalation attempt).
	 */
	escalateFn?: () => Promise<void>;
	/**
	 * Codex auth-check DI seam (US-002, CAM-352). Mirrors codexAuthCheckFn in
	 * RunSupervisorOptions: injectable override for the auth-check invoked by
	 * codexAuthPreflight immediately before the reviewer respawn-pane call.
	 * When absent, codexAuthPreflight falls back to its own default (the real
	 * `~/.codex/auth.json` presence check). When reviewBackend !== 'codex'
	 * this seam is never invoked.
	 */
	codexAuthCheckFn?: CodexAuthCheck;
	/**
	 * Reviewer-backend/model resolution seam (US-001, CAM-405). Overrides the
	 * `configPath` argument threaded into the `readPhaseBackend('reviewer', ...)`
	 * call and the `resolvePhaseModel` call below, so a per-call fixture
	 * `project.toml` (e.g. a tmp file with `[backend] reviewer = "codex"`) is
	 * consulted instead of the repo's live `scripts/cam/project.toml`.
	 *
	 * When absent (the production default), `readPhaseBackend`/`resolvePhaseModel`
	 * fall back to their own default (`scripts/cam/project.toml` resolved from
	 * `process.cwd()`), so reviewer-backend resolution in production is
	 * unchanged. Exists purely so tests can isolate reviewer-backend/model
	 * resolution from the repo's committed config (letting a `reviewer = "codex"`
	 * project.toml be exercised in CI without requiring real codex auth or
	 * mutating the live config file), without bypassing the real
	 * `readPhaseBackend`/`resolvePhaseModel` resolution logic.
	 */
	configPath?: string;
	/**
	 * Injectable codex models-cache reader (DI seam, US-006, CAM-398). Mirrors
	 * codexAuthCheckFn immediately above: forwarded into `resolvePhaseModel` at
	 * the reviewer dispatch site below. When absent, `resolvePhaseModel` falls
	 * back to its own default (the real `~/.codex/models_cache.json` reader).
	 * Never invoked on the claude backend, and never invoked on the codex
	 * backend when a valid pin (nested or non-claude-shaped flat) is already
	 * found. Mirrors codexModelsCacheReaderFn in RunSupervisorOptions (loop.ts)
	 * and RunPlanPhaseOptions (plan-runner.ts).
	 */
	codexModelsCacheReaderFn?: CodexModelsCacheReader;
	/**
	 * Early-death transcript probe (US-003, CAM-479). Mirrors earlyDeathProbeFn
	 * in RunSupervisorOptions (loop.ts): called once per poll tick with the
	 * reviewer's session uuid. A 'dead-on-first-turn' verdict ends the wait at
	 * the detector's floor instead of the full DEFAULT_REVIEW_TIMEOUT_MS,
	 * killing the stuck reviewer pane and returning status='error' through the
	 * SAME MAX_REVIEW_DISPATCH_ATTEMPTS retry path the loop already applies to
	 * every other reviewDispatch 'error' result -- no second retry mechanism.
	 * Optional: when absent the poll loop is byte-for-byte unchanged.
	 */
	earlyDeathProbeFn?: (uuid: string) => EarlyDeathVerdict;
}

/** Default max review rounds (mirrors decide.ts and cam-review.md). */
const DEFAULT_MAX_ROUNDS = 3;

/** Default polling interval for the <review> tag (mirrors the implementer's sentinel poll). */
export const DEFAULT_REVIEW_POLL_INTERVAL_MS = 5_000;

/** Default per-review deadline (mirrors DEFAULT_PER_WORKER_TIMEOUT_MS in loop.ts). */
export const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Create a ReviewDispatch closure that performs the full review cycle (CAM-42):
 *   1. Respawn the worker pane with an interactive TUI reviewer (prompt as
 *      initial argument; no -p, no wait-for chain).
 *   2. Poll capture-pane until the <review> verdict tag appears, the pane
 *      dies, or the deadline fires (same semantics as the implementer's
 *      sentinel branch in loop.ts).
 *   3. Parse the verdict.
 *   4. Update prd.json (roundsCompleted, lastVerdict, new US-RX-NNN stories).
 *
 * The returned function matches the ReviewDispatch type from loop.ts:
 *   (uuid: string) => ReviewDispatchResult
 *
 * PRD update rules:
 *   - Always increments roundsCompleted.
 *   - CLEAN: sets lastVerdict='CLEAN'. No new stories.
 *   - FIXES_PENDING: if newRound > maxRounds, sets lastVerdict='MAX_ROUNDS_DEBT'
 *     (terminal). Otherwise sets lastVerdict='FIXES_PENDING' and prepends
 *     US-R{round}-{NNN} stories (passes=false, priority=1 minus index so they
 *     sort above existing stories).
 *   - Pane died or deadline fired before a verdict: returns status='error'.
 */
export function makeReviewDispatch(opts: MakeReviewDispatchOptions): ReviewDispatch {
	const {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		isPaneAlive,
		sleepFn,
		permissionMode,
	} = opts;
	const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;
	const taskPrompt = opts.taskPrompt ?? REVIEWER_TASK_PROMPT;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_REVIEW_POLL_INTERVAL_MS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
	const now = opts.now ?? (() => Date.now());
	const ensureWorkerPane = opts.ensureWorkerPane;
	const logEvent = opts.logEvent;
	const readReviewReport = opts.readReviewReport;
	const clearReviewReport = opts.clearReviewReport;
	const warnFn = opts.warnFn ?? ((msg: string) => console.warn(`[cam/review] ${msg}`));
	// US-005 / CAM-152: reviewer container isolation.
	const workerIsolation = opts.workerIsolation ?? 'host';
	const preflightContainerFn = opts.preflightContainerFn;
	// US-002 (CAM-352): codex auth-check DI seam, threaded straight into
	// codexAuthPreflight at the reviewer dispatch site.
	const codexAuthCheckFn = opts.codexAuthCheckFn;
	// US-001 (CAM-405): reviewer-backend/model resolution seam. When absent,
	// readPhaseBackend/resolvePhaseModel resolve their own default (the live
	// scripts/cam/project.toml), preserving production behavior byte-for-byte.
	const configPath = opts.configPath;
	// US-006 (CAM-398): injectable codex models-cache reader, threaded
	// straight into resolvePhaseModel at the reviewer dispatch site.
	const codexModelsCacheReaderFn = opts.codexModelsCacheReaderFn;
	// US-003 (CAM-479): early-death transcript probe, consulted once per poll tick.
	const earlyDeathProbeFn = opts.earlyDeathProbeFn;

	return function reviewDispatch(uuid: string): ReviewDispatchResult {
		// CAM-57: ensure a live worker pane exists before the respawn. When
		// ensureWorkerPane is absent, fall back to the static workerPaneId from
		// opts (backward compat). Re-resolve per-call, not once at construction.
		const liveWorkerPaneId = ensureWorkerPane !== undefined
			? ensureWorkerPane()
			: opts.workerPaneId;

		// Resolve model/backend once so argv and the spawn-resolution event
		// report the identical resolved values (reviewer finding: double-read).
		// US-002 (CAM-356): resolve reviewBackend first and thread it into
		// model resolution so a codex-backed reviewer phase resolves its slug from
		// [models.codex] instead of a backend-blind [models] read.
		// US-001 (CAM-405): configPath threads the resolution seam above through
		// to both calls, so tests can point resolution at a fixture project.toml
		// instead of the repo's live one.
		const reviewBackend = readPhaseBackend('reviewer', configPath);
		// US-006 (CAM-398): resolvePhaseModel runs before argv build (below) and
		// before codexAuthPreflight (further down, unchanged in position relative
		// to buildSpawnArgv), replacing the raw readPhaseModel read so a
		// codex-backed reviewer whose config only carries a claude-shaped flat
		// model auto-resolves a live codex slug (via the injectable
		// codexModelsCacheReaderFn seam) instead of leaking the claude alias into
		// `codex exec -m`. A not-ok resolution aborts before any spawn, mirroring
		// the codexAuthPreflight abort block below it (actionable message,
		// fire-and-forget escalateFn, no tmux respawn-pane invocation).
		const modelResolution = resolvePhaseModel({
			phase: 'reviewer',
			backend: reviewBackend,
			configPath,
			cacheReader: codexModelsCacheReaderFn,
		});
		if (!modelResolution.ok) {
			const modelReason = `model-resolution-failed: ${modelResolution.message}`;
			if (opts.escalateFn !== undefined) {
				const ef = opts.escalateFn;
				void (async () => {
					try {
						await ef();
					} catch (e) {
						process.stderr.write(
							`[cam] escalateFn error (swallowed): ${e instanceof Error ? e.message : String(e)}\n`,
						);
					}
				})();
			}
			return { status: 'error', detail: modelReason };
		}
		const reviewModel = modelResolution.model;

		// Build and respawn the interactive reviewer (CAM-41: the prompt is
		// mandatory; a promptless claude dies instantly).
		// US-002 (CAM-350): route through selectAdapter(reviewBackend) so a
		// per-phase 'codex' backend actually reaches spawn instead of always
		// hardcoding ClaudeAdapter.
		const shellCmd = selectAdapter(reviewBackend).buildSpawnArgv('reviewer', {
			uuid,
			claudeDir: opts.claudeDir,
			agentName,
			taskPrompt,
			permissionMode,
			model: reviewModel,
			isolation: workerIsolation,
		});

		// US-R1-001: erase any stale review-report.json from a previous round before
		// dispatching the new reviewer. Mirrors the clearWorkerReport call in loop.ts
		// (before each implementer respawn-pane). Without this, the round-N+1 poll
		// loop reads the leftover round-N report on its very first tick and
		// immediately exits with the previous round's verdict and findings.
		// Best-effort: clearReviewReport handles the no-file case gracefully.
		clearReviewReport?.();

		// US-005 / CAM-152: container preflight. In container mode a not-ready result
		// is fail-closed: return status='error' without dispatching an un-wrapped host
		// reviewer. Mirrors the B-2 logic in loop.ts (~lines 811-848).
		if (preflightContainerFn !== undefined) {
			const preflightResult = preflightContainerFn();
			if (workerIsolation === 'container' && !preflightResult.ready) {
				const containerReason = `container-not-ready: ${preflightResult.reason}`;
				if (opts.escalateFn !== undefined) {
					const ef = opts.escalateFn;
					void (async () => {
						try {
							await ef();
						} catch (e) {
							process.stderr.write(
								`[cam] escalateFn error (swallowed): ${e instanceof Error ? e.message : String(e)}\n`,
							);
						}
					})();
				}
				removeWorkerTaskPrompt({ ...opts, agentName }, uuid);
				return { status: 'error', detail: containerReason };
			}
		}

		// US-005 / CAM-152: wrap through docker exec in container mode.
		// In host mode (default), dispatchCmd === shellCmd (zero behavior change).
		const dispatchCmd = workerIsolation === 'container' ? dockerExecWrap(shellCmd) : shellCmd;

		// US-007: emit structured {phase, model, backend} spawn-resolution event.
		// writeEvent bridges into the structured worker event log (logEvent sink).
		emitSpawnResolution({
			phase: 'reviewer',
			model: reviewModel,
			backend: reviewBackend,
			writeEvent: logEvent
				? (e) => logEvent({ ts: new Date().toISOString(), storyId: undefined, uuid, kind: 'spawn-resolution', detail: e })
				: undefined,
		});

		// US-002 (CAM-352): fail-closed codex auth preflight, immediately before
		// respawn-pane. Mirrors the container preflight fail-closed block above.
		const codexPreflight = codexAuthPreflight({ backend: reviewBackend, model: reviewModel, authCheck: codexAuthCheckFn });
		if (!codexPreflight.proceed) {
			const codexReason = `codex-auth-failed: ${codexPreflight.message}`;
			if (opts.escalateFn !== undefined) {
				const ef = opts.escalateFn;
				void (async () => {
					try {
						await ef();
					} catch (e) {
						process.stderr.write(
							`[cam] escalateFn error (swallowed): ${e instanceof Error ? e.message : String(e)}\n`,
						);
					}
				})();
			}
			removeWorkerTaskPrompt({ ...opts, agentName }, uuid);
			return { status: 'error', detail: codexReason };
		}

		const dispatchResult = runVerifiedWorkerDispatch({
			spawnFn: spawn,
			phase: 'reviewer',
			paneId: liveWorkerPaneId,
			uuid,
			dispatchCmd,
			claudeDir: opts.claudeDir,
			logEvent,
			writeDispatchFailedMarkerFn: opts.writeDispatchFailedMarkerFn,
			removeDispatchFailedMarkerFn: opts.removeDispatchFailedMarkerFn,
			notifyFn: opts.notifyFn,
			removeTaskPromptFileFn: opts.removeTaskPromptFileFn,
			agentName,
		});
		if (!dispatchResult.ok) {
			return { status: 'error', detail: `dispatch-failed: ${dispatchResult.marker.reason}` };
		}

		// Poll until one of three sources signals completion:
		//   1. review-report.json present and well-formed (primary, structured).
		//   2. <review> tag in capture-pane (fallback, human-readable sentinel).
		// Or until an error condition fires (pane death, timeout).
		const startMs = now();
		let fileBasedReport: ReviewReport | null = null;
		let parsed: ParsedReviewVerdict | null = null;

		while (true) {
			sleepFn(pollIntervalMs);

			// Primary completion signal: review-report.json written by the reviewer.
			// Check before pane-death so we can use the report even if the pane
			// exits right after writing. Never throws (graceful degradation).
			if (readReviewReport !== undefined) {
				const fileReport = readReviewReport();
				if (fileReport !== null) {
					fileBasedReport = fileReport;
					break;
				}
			}

			if (!isPaneAlive(liveWorkerPaneId)) {
				removeWorkerTaskPrompt({ ...opts, agentName }, uuid);
				return {
					status: 'error',
					detail: 'Reviewer pane died before a <review> verdict was emitted.',
				};
			}

			// US-003 (CAM-479): a pane can be alive but the reviewer session inside
			// it died on its first turn. Ends the wait at the detector's floor
			// instead of the full timeoutMs, mirroring the implementer poll loop
			// (loop.ts) exactly.
			if (earlyDeathProbeFn !== undefined) {
				const earlyDeathVerdict = earlyDeathProbeFn(uuid);
				if (earlyDeathVerdict.verdict === 'dead-on-first-turn') {
					// Kill the stuck reviewer so the retry (CAM-37) starts clean.
					runCheckedWorkerSentinel({
						spawnFn: spawn,
						phase: 'reviewer-session-died-early',
						label: 'reviewer',
						paneId: liveWorkerPaneId,
						uuid,
						claudeDir: opts.claudeDir,
						logEvent,
						writeDispatchFailedMarkerFn: opts.writeDispatchFailedMarkerFn,
						notifyFn: opts.notifyFn,
						removeTaskPromptFileFn: opts.removeTaskPromptFileFn,
						agentName,
					}, 'echo session-died-early');
					// The cause-bearing terminal on all three observable channels,
					// independent of whether the sentinel replacement above itself
					// succeeded.
					emitEarlyDeathTerminal({
						phase: 'reviewer-session-died-early',
						paneId: liveWorkerPaneId,
						uuid,
						logEvent: logEvent ?? ((): void => {}),
						writeDispatchFailedMarkerFn: opts.writeDispatchFailedMarkerFn ?? ((): void => {}),
						notifyFn: opts.notifyFn ?? ((): void => {}),
						cause: earlyDeathVerdict.cause,
					});
					removeWorkerTaskPrompt({ ...opts, agentName }, uuid);
					return {
						status: 'error',
						detail: `session-died-early: ${earlyDeathVerdict.cause}`,
					};
				}
			}

			// Fallback completion signal: <review> tag scraped from capture-pane.
			// parseReviewVerdict is retained as a human-readable sentinel.
			parsed = parseReviewVerdict(capturePane(liveWorkerPaneId));
			if (parsed !== null) break;

			if (now() - startMs >= timeoutMs) {
				// Kill the stuck reviewer so the retry (CAM-37) starts clean.
				runCheckedWorkerSentinel({
					spawnFn: spawn,
					phase: 'review-timeout',
					label: 'reviewer',
					paneId: liveWorkerPaneId,
					uuid,
					claudeDir: opts.claudeDir,
					logEvent,
					writeDispatchFailedMarkerFn: opts.writeDispatchFailedMarkerFn,
					notifyFn: opts.notifyFn,
					removeTaskPromptFileFn: opts.removeTaskPromptFileFn,
					agentName,
				}, 'echo review-timeout');
				return {
					status: 'error',
					detail: 'Reviewer timed out before emitting a <review> verdict.',
				};
			}
		}
		removeWorkerTaskPrompt({ ...opts, agentName }, uuid);

		// Resolve verdict and findings from whichever source triggered loop exit.
		// File-based verdict takes priority over tag-based verdict.
		let verdictKind: 'CLEAN' | 'FIXES_PENDING';
		let findingsCount: number;
		let fileFindings: ReviewFinding[] | undefined;

		if (fileBasedReport !== null) {
			// Verdict sourced from review-report.json (structured, survives markdown render).
			const fileVerdict = fileBasedReport.verdict;
			if (fileVerdict === 'CLEAN') {
				verdictKind = 'CLEAN';
				findingsCount = 0;
			} else {
				// FIXES_PENDING:N - extract count from verdict string.
				const m = /^FIXES_PENDING:(\d+)$/.exec(fileVerdict);
				const n = m !== null ? parseInt(m[1] ?? '0', 10) : 0;
				verdictKind = 'FIXES_PENDING';
				findingsCount = isNaN(n) ? 0 : n;
			}
			fileFindings = fileBasedReport.findings;
		} else if (parsed !== null) {
			// Fallback: verdict from parseReviewVerdict (tag-based, no file findings).
			// When readReviewReport was provided (file expected) but returned null
			// (file missing or malformed), log a warning so the operator knows the
			// structured report channel was unavailable. The loop is never wedged:
			// placeholder fix stories are still created using the tag's count (AC4).
			if (readReviewReport !== undefined) {
				warnFn(
					'review-report.json was missing or malformed; falling back to <review>-tag verdict from capture-pane',
				);
			}
			verdictKind = parsed.verdict;
			findingsCount = parsed.findingsCount;
			fileFindings = undefined;
		} else {
			// Unreachable: loop can only exit with one of the two set.
			return {
				status: 'error',
				detail: 'Internal: poll loop exited without a verdict.',
			};
		}

		// Read current prd to update review state.
		const prd = readPrd();
		if (prd === null) {
			return {
				status: 'error',
				detail: 'Could not read prd.json to update review state.',
			};
		}

		const roundsCompleted = prd.review?.roundsCompleted ?? 0;
		const maxRounds = prd.review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
		const newRound = roundsCompleted + 1;

		if (verdictKind === 'CLEAN') {
			// CAM-115: a CLEAN verdict clears findings carried over from a prior
			// FIXES_PENDING round (line ~586 below), so prd.review.findings always
			// reflects the current round instead of showing stale findings. This
			// scope is CLEAN-only: the MAX_ROUNDS_DEBT write path (below) has its
			// own contract (CAM-478) for which round's findings it persists.
			const { findings: _staleFindings, ...reviewWithoutFindings } = prd.review ?? {};
			writePrd({
				...prd,
				review: {
					...reviewWithoutFindings,
					roundsCompleted: newRound,
					maxRounds,
					lastVerdict: 'CLEAN',
				},
			});
			return {
				status: 'ok',
				detail: `Review round ${newRound}: CLEAN.`,
			};
		}

		// FIXES_PENDING path.
		if (newRound >= maxRounds) {
			// At or beyond max rounds without CLEAN: set MAX_ROUNDS_DEBT directly.
			// US-008: do NOT create fix stories here. Orphan passes:false fix stories
			// created at the terminal round (newRound == maxRounds) would make
			// makeHasPendingStories return true, which re-triggers the auto-chain and
			// defeats the US-006 non-convergence hard terminal. By skipping
			// buildFixStories on the terminal round, prd.json userStories are
			// unchanged and the pipeline stops cleanly at MAX_ROUNDS_DEBT.
			//
			// CAM-478: prd.review.findings must hold the findings of the terminal
			// round that actually decided MAX_ROUNDS_DEBT when they parsed
			// (fileFindings !== undefined overrides whatever the spread carried
			// over from a prior round), and falls back to preserving the prior
			// round's findings only when nothing parsed this round (fileFindings
			// undefined, tag-fallback path) since that stale record is the only
			// one available. Never convert already-fixed findings into debt, and
			// never halt a ship over findings that no longer parsed.
			writePrd({
				...prd,
				review: {
					...(prd.review ?? {}),
					roundsCompleted: newRound,
					maxRounds,
					lastVerdict: 'MAX_ROUNDS_DEBT',
					...(fileFindings !== undefined ? { findings: fileFindings } : {}),
				},
			});
			return {
				status: 'ok',
				detail: `Review round ${newRound} reached maxRounds (${maxRounds}) without CLEAN. Set MAX_ROUNDS_DEBT.`,
			};
		}

		// FIXES_PENDING and still within max rounds: create US-R{round}-NNN stories.
		// Pass file findings so each fix story gets the verbatim finding text in notes.
		const newStories = buildFixStories(findingsCount, newRound, fileFindings);

		// Prepend new fix stories before existing stories.
		// New stories get priorities 1..N; existing stories are bumped up by N.
		const existingStories = prd.userStories ?? [];
		const storiesWithPriority = newStories.map((s, i) => ({
			id: s.id,
			title: s.title,
			priority: i + 1,
			passes: false,
			...(s.description !== undefined ? { description: s.description } : {}),
			...(s.notes !== undefined ? { notes: s.notes } : {}),
		}));
		const bumpedExisting = existingStories.map((s) => ({
			...s,
			priority: (s.priority ?? 0) + newStories.length,
		}));

		writePrd({
			...prd,
			review: {
				...(prd.review ?? {}),
				roundsCompleted: newRound,
				maxRounds,
				lastVerdict: `FIXES_PENDING:${findingsCount}`,
				...(fileFindings !== undefined ? { findings: fileFindings } : {}),
			},
			userStories: [...storiesWithPriority, ...bumpedExisting],
		});

		return {
			status: 'ok',
			detail: `Review round ${newRound}: FIXES_PENDING:${findingsCount}. Created ${newStories.length} fix stories.`,
		};
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Upper bound on a derived fix-story title's length (chars), sanitized suffix included. */
const FIX_STORY_TITLE_MAX_LEN = 80;

/**
 * Derive a fix-story title from a finding's severity + text, sanitized so it
 * is safe to use as a story title (single line, no pipe, length-bounded).
 *
 * Sanitization is required because the title flows into the commit subject
 * (templates/agents/subagent-implementer.md:99), handoff.json, and a markdown
 * table cell in the PR body (src/release/pr-body.ts:141): a raw multi-line or
 * pipe-containing finding text would corrupt any of those renderings.
 */
function deriveFixStoryTitle(finding: ReviewFinding): string {
	const raw = `${finding.severity}: ${finding.text}`;
	const singleLine = raw.replace(/[\r\n]+/g, ' ').trim();
	const pipeFree = singleLine.replace(/\|/g, '/');
	if (pipeFree.length <= FIX_STORY_TITLE_MAX_LEN) return pipeFree;
	return `${pipeFree.slice(0, FIX_STORY_TITLE_MAX_LEN - 1).trimEnd()}…`;
}

/**
 * Build fix story records for a FIXES_PENDING round.
 * Generates `count` stories with IDs US-R{round}-001 .. US-R{round}-{NNN}.
 *
 * When `findings` are provided (from review-report.json), each story's `notes`
 * field is populated with the verbatim finding text (severity/file/line/text)
 * so a fix-worker reads the real finding rather than a generic placeholder.
 * `description` is populated with that same verbatim finding text so it
 * reaches the fix-worker's spawn prompt directly (buildImplementerTaskPrompt
 * interpolates description, not notes), and `title` is replaced with a
 * sanitized, finding-derived title instead of the generic placeholder.
 *
 * When `findings` is absent (tag-based fallback path), stories are created with
 * placeholder titles only and no `description` (backward-compat behavior).
 */
function buildFixStories(
	count: number,
	round: number,
	findings?: ReviewFinding[],
): Array<{ id: string; title: string; description?: string; notes?: string }> {
	const stories: Array<{ id: string; title: string; description?: string; notes?: string }> = [];
	const actualCount = Math.max(count, 1); // always create at least 1 story on FIXES_PENDING

	for (let i = 1; i <= actualCount; i++) {
		const nnn = String(i).padStart(3, '0');
		const finding: ReviewFinding | undefined = findings !== undefined ? findings[i - 1] : undefined;
		const story: { id: string; title: string; description?: string; notes?: string } = {
			id: `US-R${round}-${nnn}`,
			title: `Review round ${round} fix ${nnn}: address reviewer finding`,
		};
		if (finding !== undefined) {
			// Inject verbatim finding into notes/description so the fix-worker has
			// the real context (notes for the re-reader path, description so it
			// reaches the spawn prompt directly).
			const loc = finding.file !== undefined
				? ` [${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}]`
				: '';
			const verbatim = `${finding.severity}${loc}: ${finding.text}`;
			story.notes = verbatim;
			story.description = verbatim;
			story.title = deriveFixStoryTitle(finding);
		}
		stories.push(story);
	}

	return stories;
}
