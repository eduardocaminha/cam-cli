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
//     sentinel branch in loop.ts. The legacy headless (-p + wait-for) builder
//     branch remains only until US-004 deletes it.

import type { ReviewDispatch, ReviewDispatchResult, SpawnFn, CapturePane, ReadPrd, WritePrd } from './loop.ts';
import type { PrdSnapshot } from './decide.ts';

// ---------------------------------------------------------------------------
// buildReviewerWorkerArgv
// ---------------------------------------------------------------------------

/** Arguments for buildReviewerWorkerArgv. */
export interface ReviewerWorkerArgvOptions {
	/** UUID for this reviewer invocation; passed as --session-id. */
	uuid: string;
	/**
	 * tmux wait-for channel name; will be shell-escaped. Only used by the
	 * legacy headless (exit) path. Ignored when interactive: true.
	 */
	channel?: string;
	/**
	 * Agent name matching the .claude/agents/<name>.md frontmatter.
	 * Defaults to 'subagent-reviewer'.
	 */
	agentName?: string;
	/**
	 * Durable output-log path. When set, the reviewer's stdout+stderr is tee'd to
	 * this file so the verdict (and any instant-exit / rate-limit message) can be
	 * read AFTER the ephemeral pane dies (CAM-37, mirrors CAM-32 BUG 1 for the
	 * implementer). Will be shell-escaped. When omitted, output goes only to the
	 * pane (legacy behaviour). Ignored when interactive: true (piping stdout
	 * would strip the pty from the TUI renderer).
	 */
	outFile?: string;
	/**
	 * When true, launch claude as an interactive TUI session: omit -p and
	 * --output-format, pass the task prompt as the initial-prompt argument, and
	 * omit the tmux wait-for chain. Completion is detected by polling
	 * capture-pane for the <review> verdict tag (CAM-42; claude -p is forbidden
	 * for subscription accounts).
	 */
	interactive?: boolean;
	/**
	 * Free-text task prompt for the reviewer session. Required in interactive
	 * mode (the TUI needs an initial prompt; CAM-41 root cause was launching the
	 * reviewer with no prompt at all). Will be shell-escaped.
	 */
	taskPrompt?: string;
	/**
	 * Claude permission mode forwarded to the spawned claude process (NEVER a
	 * cam CLI flag). Required in interactive mode so the reviewer can run the
	 * quality gates without interactive permission prompts.
	 */
	permissionMode?: string;
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
 * Build the shell string passed to `respawn-pane` to launch a headless
 * reviewer worker.
 *
 * Returns a shell string with the shape:
 *
 *   claude -p --session-id <uuid> \
 *     --output-format text --agent <agentName> \
 *     ; tmux -L cam wait-for -S '<channel>'
 *
 * Note: no --permission-mode flag; the reviewer agent only reads and does not
 * modify files, so no special permission mode is needed. The channel is
 * single-quote-escaped to prevent shell injection.
 */
export function buildReviewerWorkerArgv(opts: ReviewerWorkerArgvOptions): string {
	const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;

	if (opts.interactive) {
		// Interactive TUI reviewer (CAM-42): no -p, no --output-format, no tee,
		// no wait-for chain. The task prompt is the initial-prompt argument
		// (CAM-41: a promptless reviewer dies instantly under -p) and
		// --permission-mode lets the gates run unprompted.
		const escapedPrompt = shellEscape(opts.taskPrompt ?? REVIEWER_TASK_PROMPT);
		const permissionMode = opts.permissionMode ?? 'bypassPermissions';
		return (
			`claude` +
			` --permission-mode ${permissionMode}` +
			` --session-id ${opts.uuid}` +
			` --agent ${agentName}` +
			` ${escapedPrompt}`
		);
	}

	const escapedChannel = shellEscape(opts.channel ?? '');
	// When outFile is set, tee stdout+stderr to a durable log so the verdict can
	// be read even if the pane dies before capture-pane (CAM-32 BUG 1 class). The
	// pipe binds tighter than `;`, so it is (claude ... | tee file) ; (tmux ...).
	const teePart = opts.outFile ? ` 2>&1 | tee ${shellEscape(opts.outFile)}` : '';

	return (
		`claude -p` +
		` --session-id ${opts.uuid}` +
		` --output-format text` +
		` --agent ${agentName}` +
		teePart +
		` ; tmux -L cam wait-for -S ${escapedChannel}`
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
 *   (uuid: string, channel: string) => ReviewDispatchResult
 * (the channel argument is a legacy leftover and is ignored).
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
		workerPaneId,
		isPaneAlive,
		sleepFn,
		permissionMode,
	} = opts;
	const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;
	const taskPrompt = opts.taskPrompt ?? REVIEWER_TASK_PROMPT;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_REVIEW_POLL_INTERVAL_MS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
	const now = opts.now ?? (() => Date.now());

	return function reviewDispatch(uuid: string, _channel: string): ReviewDispatchResult {
		// Build and respawn the interactive reviewer (CAM-41: the prompt is
		// mandatory; a promptless claude dies instantly).
		const shellCmd = buildReviewerWorkerArgv({
			uuid,
			agentName,
			interactive: true,
			taskPrompt,
			permissionMode,
		});
		spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, shellCmd]);

		// Poll the pane until the <review> tag appears, the pane dies, or the
		// deadline fires. The TUI session does not exit on its own.
		const startMs = now();
		let parsed: ParsedReviewVerdict | null = null;
		while (true) {
			sleepFn(pollIntervalMs);
			if (!isPaneAlive(workerPaneId)) {
				return {
					status: 'error',
					detail: 'Reviewer pane died before a <review> verdict was emitted.',
				};
			}
			parsed = parseReviewVerdict(capturePane(workerPaneId));
			if (parsed !== null) break;
			if (now() - startMs >= timeoutMs) {
				// Kill the stuck reviewer so the retry (CAM-37) starts clean.
				spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, 'echo review-timeout']);
				return {
					status: 'error',
					detail: 'Reviewer timed out before emitting a <review> verdict.',
				};
			}
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

		if (parsed.verdict === 'CLEAN') {
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
		const newStories = buildFixStories(parsed.findingsCount, newRound);

		// Prepend new fix stories before existing stories.
		// New stories get priorities 1..N; existing stories are bumped up by N.
		const existingStories = prd.userStories ?? [];
		const storiesWithPriority = newStories.map((s, i) => ({
			id: s.id,
			title: s.title,
			priority: i + 1,
			passes: false,
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
				lastVerdict: 'FIXES_PENDING',
			},
			userStories: [...storiesWithPriority, ...bumpedExisting],
		});

		return {
			status: 'ok',
			detail: `Review round ${newRound}: FIXES_PENDING:${parsed.findingsCount}. Created ${newStories.length} fix stories.`,
		};
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build fix story records for a FIXES_PENDING round.
 * Generates `count` stories with IDs US-R{round}-001 .. US-R{round}-{NNN}.
 * Titles are placeholder descriptions; the implementer agent will read the
 * reviewer's pane output to understand the actual findings.
 */
function buildFixStories(
	count: number,
	round: number,
): Array<{ id: string; title: string }> {
	const stories: Array<{ id: string; title: string }> = [];
	const actualCount = Math.max(count, 1); // always create at least 1 story on FIXES_PENDING

	for (let i = 1; i <= actualCount; i++) {
		const nnn = String(i).padStart(3, '0');
		stories.push({
			id: `US-R${round}-${nnn}`,
			title: `Review round ${round} fix ${nnn}: address reviewer finding`,
		});
	}

	return stories;
}
