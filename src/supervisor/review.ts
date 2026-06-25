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
//   - buildReviewerWorkerArgv is a pure function (no I/O).
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
import type { PrdSnapshot } from './decide.ts';
import type { ReviewReport, ReviewFinding } from './review-report.ts';
import { workerEnvPrefix } from './worker-argv.ts';
import { DEFAULTS, readPhaseModel, readBackend } from '../config/models.ts';
import { emitSpawnResolution } from '../logging/spawn-resolution.ts';

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
	 * prompt (CAM-41: a promptless reviewer dies instantly). Will be shell-escaped.
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
}

/** Default agent name; matches .claude/agents/subagent-reviewer.md. */
export const DEFAULT_REVIEWER_AGENT = 'subagent-reviewer';

/**
 * Default task prompt for the interactive reviewer session (CAM-42 US-003).
 * The <review> tag on the very last line is the completion sentinel the
 * supervisor polls for.
 */
export const REVIEWER_TASK_PROMPT =
	'Review all changes on the current branch vs main per your AGENT.md. Run the project quality gates. End your output with the <review> verdict tag on the very last line.';

/**
 * Escape a string for safe embedding inside a POSIX single-quoted shell argument.
 * Handles embedded single quotes via the '\'' technique.
 */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the shell string passed to `respawn-pane` to launch an interactive
 * TUI reviewer worker.
 *
 * Returns a shell string with the shape:
 *
 *   env -u CLAUDECODE -u ... claude --permission-mode <mode> --session-id <uuid> \
 *     --agent <agentName> '<taskPrompt>'
 *
 * The `env -u ...` prefix (shared with the implementer via workerEnvPrefix)
 * strips nesting-detection env vars so the reviewer boots from a tmux server
 * bootstrapped inside a claude session (CAM-43). -p and --output-format are
 * omitted so the process stays open for interaction. The tmux wait-for chain
 * is also omitted; the supervisor detects completion by polling capture-pane
 * for the <review> verdict tag.
 *
 * The task prompt is the initial-prompt argument (CAM-41: a promptless reviewer
 * dies instantly) and --permission-mode lets quality gates run unprompted.
 */
export function buildReviewerWorkerArgv(opts: ReviewerWorkerArgvOptions): string {
	const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;
	const model = opts.model ?? DEFAULTS.reviewer;
	const escapedPrompt = shellEscape(opts.taskPrompt ?? REVIEWER_TASK_PROMPT);
	const permissionMode = opts.permissionMode ?? 'bypassPermissions';
	return (
		workerEnvPrefix() +
		`claude` +
		` --permission-mode ${permissionMode}` +
		` --session-id ${opts.uuid}` +
		` --model ${shellEscape(model)}` +
		` --agent ${agentName}` +
		` ${escapedPrompt}`
	);
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

	return function reviewDispatch(uuid: string): ReviewDispatchResult {
		// CAM-57: ensure a live worker pane exists before the respawn. When
		// ensureWorkerPane is absent, fall back to the static workerPaneId from
		// opts (backward compat). Re-resolve per-call, not once at construction.
		const liveWorkerPaneId = ensureWorkerPane !== undefined
			? ensureWorkerPane()
			: opts.workerPaneId;

		// Resolve model/backend once so argv and the spawn-resolution event
		// report the identical resolved values (reviewer finding: double-read).
		const reviewModel = readPhaseModel('reviewer');
		const reviewBackend = readBackend();

		// Build and respawn the interactive reviewer (CAM-41: the prompt is
		// mandatory; a promptless claude dies instantly).
		const shellCmd = buildReviewerWorkerArgv({
			uuid,
			agentName,
			taskPrompt,
			permissionMode,
			model: reviewModel,
		});

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

		spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', liveWorkerPaneId, shellCmd]);

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
				return {
					status: 'error',
					detail: 'Reviewer pane died before a <review> verdict was emitted.',
				};
			}

			// Fallback completion signal: <review> tag scraped from capture-pane.
			// parseReviewVerdict is retained as a human-readable sentinel.
			parsed = parseReviewVerdict(capturePane(liveWorkerPaneId));
			if (parsed !== null) break;

			if (now() - startMs >= timeoutMs) {
				// Kill the stuck reviewer so the retry (CAM-37) starts clean.
				spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', liveWorkerPaneId, 'echo review-timeout']);
				return {
					status: 'error',
					detail: 'Reviewer timed out before emitting a <review> verdict.',
				};
			}
		}

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
			writePrd({
				...prd,
				review: {
					...(prd.review ?? {}),
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
		if (newRound > maxRounds) {
			// Exceeded max rounds: set terminal debt verdict.
			writePrd({
				...prd,
				review: {
					...(prd.review ?? {}),
					roundsCompleted: newRound,
					maxRounds,
					lastVerdict: 'MAX_ROUNDS_DEBT',
				},
			});
			return {
				status: 'ok',
				detail: `Review round ${newRound} exceeded maxRounds (${maxRounds}). Set MAX_ROUNDS_DEBT.`,
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

/**
 * Build fix story records for a FIXES_PENDING round.
 * Generates `count` stories with IDs US-R{round}-001 .. US-R{round}-{NNN}.
 *
 * When `findings` are provided (from review-report.json), each story's `notes`
 * field is populated with the verbatim finding text (severity/file/line/text)
 * so a fix-worker reads the real finding rather than a generic placeholder.
 *
 * When `findings` is absent (tag-based fallback path), stories are created with
 * placeholder titles only (backward-compat behavior).
 */
function buildFixStories(
	count: number,
	round: number,
	findings?: ReviewFinding[],
): Array<{ id: string; title: string; notes?: string }> {
	const stories: Array<{ id: string; title: string; notes?: string }> = [];
	const actualCount = Math.max(count, 1); // always create at least 1 story on FIXES_PENDING

	for (let i = 1; i <= actualCount; i++) {
		const nnn = String(i).padStart(3, '0');
		const finding: ReviewFinding | undefined = findings !== undefined ? findings[i - 1] : undefined;
		const story: { id: string; title: string; notes?: string } = {
			id: `US-R${round}-${nnn}`,
			title: `Review round ${round} fix ${nnn}: address reviewer finding`,
		};
		if (finding !== undefined) {
			// Inject verbatim finding into notes so the fix-worker has the real context.
			const loc = finding.file !== undefined
				? ` [${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}]`
				: '';
			story.notes = `${finding.severity}${loc}: ${finding.text}`;
		}
		stories.push(story);
	}

	return stories;
}
