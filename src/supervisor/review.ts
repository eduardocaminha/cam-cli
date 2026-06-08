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
//        a. generates a channel,
//        b. respawns the worker pane with the reviewer command,
//        c. waits for the channel,
//        d. captures the pane,
//        e. parses the verdict,
//        f. updates prd.json (roundsCompleted, lastVerdict, new US-RX-NNN stories).
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
//   - The reviewer agent is autonomous and exits on its own (like the implementer),
//     so the same wait-for chain pattern is used.

import type { ReviewDispatch, ReviewDispatchResult, SpawnFn, WaitForFn, CapturePane, ReadPrd, WritePrd } from './loop.ts';
import type { PrdSnapshot } from './decide.ts';

// ---------------------------------------------------------------------------
// buildReviewerWorkerArgv
// ---------------------------------------------------------------------------

/** Arguments for buildReviewerWorkerArgv. */
export interface ReviewerWorkerArgvOptions {
	/** UUID for this reviewer invocation; passed as --session-id. */
	uuid: string;
	/** tmux wait-for channel name; will be shell-escaped. */
	channel: string;
	/**
	 * Agent name matching the .claude/agents/<name>.md frontmatter.
	 * Defaults to 'subagent-reviewer'.
	 */
	agentName?: string;
}

/** Default agent name; matches .claude/agents/subagent-reviewer.md. */
export const DEFAULT_REVIEWER_AGENT = 'subagent-reviewer';

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
	const escapedChannel = shellEscape(opts.channel);

	return (
		`claude -p` +
		` --session-id ${opts.uuid}` +
		` --output-format text` +
		` --agent ${agentName}` +
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
	/** Block until the named tmux wait-for channel is signalled. */
	waitFor: WaitForFn;
	/** Capture the visible text of a tmux pane. */
	capturePane: CapturePane;
	/** Read the current prd.json snapshot. */
	readPrd: ReadPrd;
	/** Write a modified prd.json back to disk. */
	writePrd: WritePrd;
	/** Pane id of the worker slot used for the reviewer. */
	workerPaneId: string;
	/** Agent name override. Defaults to DEFAULT_REVIEWER_AGENT. */
	agentName?: string;
}

/** Default max review rounds (mirrors decide.ts and cam-review.md). */
const DEFAULT_MAX_ROUNDS = 3;

/**
 * Create a ReviewDispatch closure that performs the full review cycle:
 *   1. Generate a channel.
 *   2. Respawn the worker pane with the reviewer command.
 *   3. Wait for the channel.
 *   4. Capture the pane.
 *   5. Parse the verdict.
 *   6. Update prd.json (roundsCompleted, lastVerdict, new US-RX-NNN stories).
 *
 * The returned function matches the ReviewDispatch type from loop.ts:
 *   (uuid: string, channel: string) => ReviewDispatchResult
 *
 * PRD update rules:
 *   - Always increments roundsCompleted.
 *   - CLEAN: sets lastVerdict='CLEAN'. No new stories.
 *   - FIXES_PENDING: if newRound > maxRounds, sets lastVerdict='MAX_ROUNDS_DEBT'
 *     (terminal). Otherwise sets lastVerdict='FIXES_PENDING' and prepends
 *     US-R{round}-{NNN} stories (passes=false, priority=1 minus index so they
 *     sort above existing stories).
 *   - No verdict in pane: returns status='error'.
 */
export function makeReviewDispatch(opts: MakeReviewDispatchOptions): ReviewDispatch {
	const {
		spawn,
		waitFor,
		capturePane,
		readPrd,
		writePrd,
		workerPaneId,
	} = opts;
	const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;

	return function reviewDispatch(uuid: string, channel: string): ReviewDispatchResult {
		// Build and respawn the reviewer.
		const shellCmd = buildReviewerWorkerArgv({ uuid, channel, agentName });
		spawn('tmux', ['-L', 'cam', 'respawn-pane', '-k', '-t', workerPaneId, shellCmd]);

		// Block until the reviewer signals the channel.
		waitFor(channel);

		// Capture pane output.
		const paneText = capturePane(workerPaneId);

		// Parse the verdict.
		const parsed = parseReviewVerdict(paneText);
		if (parsed === null) {
			return {
				status: 'error',
				detail: 'No <review> verdict tag found in reviewer pane output.',
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
