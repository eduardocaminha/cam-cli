// src/supervisor/result.ts
//
// Deterministic worker result reader for the cam supervisor.
//
// The supervisor calls readWorkerOutcome after a worker pane finishes to
// determine what actually happened. It never trusts process exit alone:
//
//   1. Parse the CAM_IMPLEMENTER_STATUS=... sentinel from the captured pane
//      text to learn what the worker reported.
//   2. Read handoff.json to get lastCompletedStory.id (the story the worker
//      self-selected and completed).
//   3. Read prd.json to verify the completed story's passes field is now true.
//
// Cross-checking (2) vs (1) is important: the worker self-selects the story
// (the supervisor never tells it which story to implement), so the only
// authoritative proof of completion is that all three agree.
//
// Design decisions:
//   - Pure function: all file I/O is injected via FileReader callbacks so the
//     function is fully unit-testable without touching the real filesystem.
//   - No external runtime dependencies (no jq, no child processes).
//   - Regex over sentinel line only (CAM_IMPLEMENTER_STATUS=DONE story=US-XXX).
//   - noUncheckedIndexedAccess: all regex group accesses are guarded.

/** File-reading callback injected by the caller. Returns null on missing/error. */
export type FileReader = (path: string) => string | null;

/** Outcome kinds returned by readWorkerOutcome. */
export type WorkerOutcomeKind = 'pass' | 'incomplete' | 'fail' | 'blocked' | 'unknown';

/** Typed result from readWorkerOutcome. */
export interface WorkerOutcome {
	/** What happened. */
	kind: WorkerOutcomeKind;
	/**
	 * The story ID the worker completed, derived from handoff.json and the
	 * sentinel. May be undefined when kind is 'unknown' and no signals exist.
	 */
	storyId: string | undefined;
	/** Human-readable explanation of what was detected and why. */
	detail: string;
}

/** Options passed to readWorkerOutcome. */
export interface ReadWorkerOutcomeOptions {
	/** Absolute path to scripts/cam/prd.json. */
	prdPath: string;
	/** Absolute path to scripts/cam/handoff.json. */
	handoffPath: string;
	/**
	 * Optional absolute path to scripts/cam/worker-report.json.
	 * When provided and neither handoff nor DONE sentinel yield a story id,
	 * readWorkerOutcome falls back to worker-report.json (worker-report-fallback).
	 */
	workerReportPath?: string;
	/**
	 * Optional advisory story id set by the supervisor loop (the story it
	 * dispatched). When provided, the worker-report.json fallback rejects any
	 * report whose story field does NOT match this id (staleness guard). This
	 * prevents a leftover report from a previous run from being mistaken as a
	 * fresh completion signal when clearWorkerReport failed or the worker wrote
	 * a report and then crashed before clearing it. When undefined, the fallback
	 * degrades gracefully to US-001 behavior (no staleness check).
	 */
	expectedStoryId?: string;
	/** Raw text captured from the worker pane (via capture-pane -p). */
	capturedPaneText: string;
	/** Injected file reader; returns file contents as string, or null on error. */
	readFile: FileReader;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the CAM_IMPLEMENTER_STATUS sentinel from the captured pane text.
 * Returns the parsed sentinel info or null if no sentinel found.
 */
function parseSentinel(paneText: string): {
	status: string;
	storyId: string | undefined;
	raw: string;
} | null {
	// Match CAM_IMPLEMENTER_STATUS=<VALUE> optionally followed by story=<ID>.
	// The sentinel may appear anywhere in the pane output.
	//
	// The capture classes are tight on purpose (NOT \S+): a worker often wraps
	// the sentinel in markdown when it emits it as prose — a code span
	// (`CAM_IMPLEMENTER_STATUS=DONE story=US-001`), **bold**, or a trailing
	// period. \S+ would swallow that punctuation into the captured value, e.g.
	// the trailing backtick above yields storyId="US-001`". That polluted id then
	// false-mismatches the clean handoff id in readWorkerOutcome and degrades a
	// real pass to fail (CAM-35), contradicting this module's own contract that
	// the sentinel is corroboration, never a gate. The classes stop at the first
	// non-id character. Status is uppercase letters/digits/underscores
	// (DONE, PRD_COMPLETE, BLOCKED_QUALITY, RATE_LIMIT, ...); story ids are
	// US-<alnum> and include the review-round form US-RX-NNN, so the hyphen is
	// allowed inside the id.
	const match = paneText.match(/CAM_IMPLEMENTER_STATUS=([A-Z0-9_]+)(?:\s+story=(US-[A-Za-z0-9-]+))?/);
	if (!match) return null;

	const status = match[1] ?? '';
	const storyId = match[2]; // may be undefined (noUncheckedIndexedAccess: match[2] is string | undefined)

	return { status, storyId, raw: match[0] ?? '' };
}

/**
 * Minimal shape of handoff.json we care about.
 * We do a runtime shape check before accessing fields.
 */
interface HandoffJson {
	lastCompletedStory?: {
		id?: string;
		title?: string;
	};
}

/**
 * Minimal shape of prd.json we care about.
 * We do a runtime shape check before accessing fields.
 */
interface PrdJson {
	userStories?: Array<{
		id?: string;
		passes?: boolean;
	}>;
}

/** Safely parse JSON; returns null on any error. */
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Runtime guard: is obj a non-null object? */
function isObject(obj: unknown): obj is Record<string, unknown> {
	return typeof obj === 'object' && obj !== null;
}

/**
 * Read and validate handoff.json. Returns null on any problem.
 * Also returns a coerced flag: true when lastCompletedStory was a bare string
 * that was coerced to {id: string} (handoff-string-coerced path).
 */
function readHandoff(
	handoffPath: string,
	readFile: FileReader,
): { handoff: HandoffJson | null; coerced: boolean } {
	const text = readFile(handoffPath);
	if (text === null) return { handoff: null, coerced: false };
	const parsed = tryParseJson(text);
	if (!isObject(parsed)) return { handoff: null, coerced: false };
	// Validate and possibly coerce lastCompletedStory.
	// Tolerate a bare string (e.g. "US-001"): coerce to {id: string} in place.
	const rawStory = (parsed as Record<string, unknown>).lastCompletedStory;
	if (rawStory !== undefined) {
		if (typeof rawStory === 'string') {
			(parsed as Record<string, unknown>).lastCompletedStory = { id: rawStory };
			return { handoff: parsed as HandoffJson, coerced: true };
		} else if (!isObject(rawStory)) {
			return { handoff: null, coerced: false };
		}
	}
	return { handoff: parsed as HandoffJson, coerced: false };
}

/**
 * Minimal shape of worker-report.json consumed for the fallback path.
 * Only outcome and story are needed; other fields are ignored.
 */
interface WorkerReportFallback {
	outcome?: string;
	story?: string;
}

/** Read and parse worker-report.json for the fallback branch. Returns null on any problem. */
function tryReadWorkerReport(reportPath: string, readFile: FileReader): WorkerReportFallback | null {
	const text = readFile(reportPath);
	if (text === null) return null;
	const parsed = tryParseJson(text);
	if (!isObject(parsed)) return null;
	return parsed as WorkerReportFallback;
}

/** Read and validate prd.json. Returns null on any problem. */
function readPrd(prdPath: string, readFile: FileReader): PrdJson | null {
	const text = readFile(prdPath);
	if (text === null) return null;
	const parsed = tryParseJson(text);
	if (!isObject(parsed)) return null;
	const prd = parsed as PrdJson;
	if (prd.userStories !== undefined && !Array.isArray(prd.userStories)) return null;
	return prd;
}

/** Check if a story is marked as passes:true in the PRD. */
function storyPassesInPrd(prd: PrdJson, storyId: string): boolean {
	if (!prd.userStories) return false;
	const story = prd.userStories.find((s) => s.id === storyId);
	if (!story) return false;
	return story.passes === true;
}

// ---------------------------------------------------------------------------
// Sentinel polling helper (US-012)
// ---------------------------------------------------------------------------

/** Which sentinel source was matched when polling the pane. */
export type AnySentinelSource = 'implementer' | 'reviewer' | 'review-tag';

/** Result of parseAnySentinel. */
export interface AnySentinelMatch {
	/** Which signal was found. */
	source: AnySentinelSource;
	/** Raw matched text. */
	raw: string;
}

/**
 * Scan captured pane text for ANY worker completion sentinel.
 * Used by the sentinel-polling path in loop.ts to decide when to stop polling.
 *
 * Detects (in order):
 *   - CAM_IMPLEMENTER_STATUS=<VALUE> [story=<ID>]
 *   - CAM_REVIEWER_STATUS=<VALUE>
 *   - <review>CLEAN</review> or <review>FIXES_PENDING:N</review>
 *
 * Returns the first match found, or null if none present.
 */
export function parseAnySentinel(paneText: string): AnySentinelMatch | null {
	const implMatch = paneText.match(/CAM_IMPLEMENTER_STATUS=\S+/);
	if (implMatch) {
		return { source: 'implementer', raw: implMatch[0] ?? '' };
	}

	const reviewerMatch = paneText.match(/CAM_REVIEWER_STATUS=\S+/);
	if (reviewerMatch) {
		return { source: 'reviewer', raw: reviewerMatch[0] ?? '' };
	}

	const reviewTagMatch = paneText.match(/<review>(CLEAN|FIXES_PENDING:\d+)<\/review>/);
	if (reviewTagMatch) {
		return { source: 'review-tag', raw: reviewTagMatch[0] ?? '' };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Exported function
// ---------------------------------------------------------------------------

/**
 * Read the outcome of a finished worker deterministically.
 *
 * Never trusts process exit alone. Cross-checks three signals:
 *   1. The CAM_IMPLEMENTER_STATUS sentinel in the captured pane text.
 *   2. handoff.json lastCompletedStory.id.
 *   3. prd.json passes:true for the completed story.
 *
 * @returns A WorkerOutcome with kind, storyId, and detail.
 */
export function readWorkerOutcome(opts: ReadWorkerOutcomeOptions): WorkerOutcome {
	const { prdPath, handoffPath, capturedPaneText, readFile } = opts;

	// --- Step 1: Parse sentinel from pane text ---
	const sentinel = parseSentinel(capturedPaneText);

	// --- Step 2: Detect BLOCKED early (does not require cross-checks) ---
	// BLOCKED_OPERATOR_REQUIRED or any BLOCKED_* token means the worker stopped
	// without completing a story.
	if (sentinel && sentinel.status.startsWith('BLOCKED')) {
		return {
			kind: 'blocked',
			storyId: sentinel.storyId,
			detail: `Worker reported ${sentinel.raw}`,
		};
	}

	// Also check raw pane text for BLOCKED tokens even without a full sentinel parse
	if (!sentinel && /BLOCKED_\w+/.test(capturedPaneText)) {
		const rawMatch = capturedPaneText.match(/BLOCKED_\w+/);
		const blockedToken = rawMatch?.[0] ?? 'BLOCKED_UNKNOWN';
		return {
			kind: 'blocked',
			storyId: undefined,
			detail: `Pane text contains blocked token: ${blockedToken} (no full sentinel found)`,
		};
	}

	// --- Step 3: PRD_COMPLETE sentinel (worker found nothing to implement) ---
	if (sentinel && sentinel.status === 'PRD_COMPLETE') {
		return {
			kind: 'pass',
			storyId: undefined,
			detail: 'Worker reported PRD_COMPLETE (all stories already passing).',
		};
	}

	// --- Step 4: State-primary outcome (CAM-32) ---
	// The authoritative proof of WHICH story is handoff.json (the worker self-
	// selects); the authoritative proof of DONE is prd.json passes:true. The
	// sentinel is corroboration, never a gate: a worker can succeed yet lose its
	// sentinel when the ephemeral pane dies (BUG 1), or truncate before emitting
	// it (BUG 2). We never depend on the sentinel alone.
	const { handoff, coerced: handoffWasStringCoerced } = readHandoff(handoffPath, readFile);
	const handoffStoryId = handoff?.lastCompletedStory?.id;
	const prd = readPrd(prdPath, readFile);

	const sentinelDone = sentinel !== null && sentinel.status === 'DONE';

	// A DONE sentinel that names a different story than handoff is a real mismatch.
	if (
		sentinel !== null &&
		sentinel.status === 'DONE' &&
		sentinel.storyId &&
		handoffStoryId &&
		sentinel.storyId !== handoffStoryId
	) {
		return {
			kind: 'fail',
			storyId: sentinel.storyId,
			detail: `Sentinel says story=${sentinel.storyId} but handoff.json has lastCompletedStory.id=${handoffStoryId}; mismatch.`,
		};
	}

	// Completed story: handoff is authoritative; fall back to a DONE sentinel's story.
	const completedStory =
		handoffStoryId ?? (sentinel !== null && sentinel.status === 'DONE' ? sentinel.storyId : undefined);

	if (completedStory === undefined) {
		// Worker-report fallback: when neither handoff.lastCompletedStory.id nor a
		// DONE sentinel yields a story id, consult worker-report.json (the push
		// signal written by the worker at exit). This recovers from cases where the
		// pane scrollback was idle/truncated by the time the supervisor captured it
		// and the handoff.json was never written (e.g. worker died mid-protocol).
		if (opts.workerReportPath) {
			const report = tryReadWorkerReport(opts.workerReportPath, readFile);
			if (report && typeof report.outcome === 'string' && typeof report.story === 'string') {
				const reportStory = report.story;
				// Staleness guard (US-004): when the supervisor knows which story it
				// dispatched, reject any report that names a DIFFERENT story. A leftover
				// report from a prior run would otherwise be mistaken as a fresh signal
				// (e.g. clearWorkerReport failed, or worker crashed after writing the
				// report). When expectedStoryId is undefined we skip the guard and fall
				// back to US-001 behavior (backward compat for older callers and tests).
				if (opts.expectedStoryId !== undefined && reportStory !== opts.expectedStoryId) {
					// Stale report: fall through to 'unknown'
				} else {
					if (report.outcome.startsWith('BLOCKED_')) {
						return {
							kind: 'blocked',
							storyId: reportStory,
							detail: `Worker reported ${report.outcome} story=${reportStory} (worker-report-fallback).`,
						};
					}
					if (report.outcome === 'DONE') {
						if (!prd) {
							return {
								kind: 'fail',
								storyId: reportStory,
								detail: `worker-report-fallback: story=${reportStory} but prd.json could not be read.`,
							};
						}
						if (storyPassesInPrd(prd, reportStory)) {
							return {
								kind: 'pass',
								storyId: reportStory,
								detail: `story=${reportStory} confirmed: prd.json passes:true (worker-report-fallback).`,
							};
						}
						return {
							kind: 'incomplete',
							storyId: reportStory,
							detail: `Worker completed ${reportStory} (worker-report-fallback) but prd.json still shows passes:false; supervisor finalize required.`,
						};
					}
				}
			}
		}

		return {
			kind: 'unknown',
			storyId: undefined,
			detail:
				'No completed story: handoff.json has no lastCompletedStory.id and no DONE sentinel with story= was found.',
		};
	}

	if (!prd) {
		return {
			kind: 'fail',
			storyId: completedStory,
			detail: `handoff/sentinel point to ${completedStory} but prd.json could not be read.`,
		};
	}

	if (storyPassesInPrd(prd, completedStory)) {
		const corroboration = sentinelDone
			? 'sentinel DONE corroborates'
			: handoffWasStringCoerced
				? 'handoff-string-coerced'
				: 'no sentinel, state-primary';
		return {
			kind: 'pass',
			storyId: completedStory,
			detail: `story=${completedStory} confirmed: handoff matches, prd.json passes:true (${corroboration}).`,
		};
	}

	// Worker implemented the story (handoff records it) but prd.json was never
	// flipped to passes:true: the worker truncated its protocol tail (BUG 2).
	// The supervisor must verify gates and finalize.
	return {
		kind: 'incomplete',
		storyId: completedStory,
		detail: `Worker completed ${completedStory} (handoff set) but prd.json still shows passes:false; supervisor finalize required.`,
	};
}
