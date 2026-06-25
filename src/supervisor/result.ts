// src/supervisor/result.ts
//
// Deterministic worker result reader for the cam supervisor.
//
// worker-report.json is the authoritative source (the Event). The supervisor
// reads it as the PRIMARY outcome signal after a worker pane finishes.
// handoff.json and the CAM_IMPLEMENTER_STATUS sentinel are no longer outcome
// gates: they are either not consulted (when a valid report is present) or
// used only as secondary/corroboration signals in the backward-compat fallback
// path (when workerReportPath is absent or the report is missing/stale).
//
// Priority order (US-001 inversion, 2026-06-25):
//   1. worker-report.json (EVENT, authoritative): report.story = which story;
//      report.outcome = DONE/BLOCKED_*/PRD_COMPLETE.
//   2. Integrity confirmation: prd.json passes:true (STATE, read-only check).
//      readWorkerOutcome never writes prd.json (no double-push).
//   3. Fallback (no valid report): sentinel for BLOCKED/PRD_COMPLETE; then
//      handoff.json for state-primary story resolution (backward compat).
//
// The DONE-sentinel-vs-handoff mismatch->fail block was dropped in US-001.
// When a report is present, the sentinel is parsed only for corroboration
// detail strings. When a report is absent, handoff wins over sentinel for
// story selection (no fail-on-mismatch).
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
 * worker-report.json is the authoritative source (US-001). When workerReportPath
 * is provided and the file is valid and non-stale, the report drives the entire
 * outcome: report.story is which story, report.outcome is the result kind.
 * handoff.json and the CAM_IMPLEMENTER_STATUS sentinel are no longer outcome
 * gates in this path.
 *
 * When workerReportPath is absent or the report is missing/stale, the function
 * falls back to sentinel-based detection (BLOCKED/PRD_COMPLETE) and then to
 * handoff.json for story-primary resolution (backward compat).
 *
 * Integrity check: for DONE outcomes, prd.json passes:true is confirmed.
 * DONE + passes:false yields kind 'incomplete' (supervisor finalize required).
 * readWorkerOutcome never writes prd.json.
 *
 * @returns A WorkerOutcome with kind, storyId, and detail.
 */
export function readWorkerOutcome(opts: ReadWorkerOutcomeOptions): WorkerOutcome {
	const { prdPath, handoffPath, capturedPaneText, readFile } = opts;

	// Parse sentinel for corroboration details. It is no longer a gate (US-001):
	// a DONE sentinel that disagrees with the report does not override the report
	// and never produces a fail-on-mismatch.
	const sentinel = parseSentinel(capturedPaneText);

	// -------------------------------------------------------------------------
	// PRIMARY PATH: worker-report.json is authoritative (US-001).
	//
	// When workerReportPath is provided and the file contains a valid, non-stale
	// report, derive the full outcome from it. handoff.json is not consulted
	// here; the sentinel is used only for corroboration in detail strings.
	// -------------------------------------------------------------------------
	if (opts.workerReportPath) {
		const report = tryReadWorkerReport(opts.workerReportPath, readFile);

		if (report && typeof report.outcome === 'string' && typeof report.story === 'string') {
			const reportStory = report.story;

			// Staleness guard (US-004): reject any report that names a story
			// different from the one the supervisor dispatched. A leftover report
			// from a prior run would otherwise masquerade as a fresh completion
			// signal (e.g. clearWorkerReport failed, or worker crashed after
			// writing). When expectedStoryId is absent, skip the guard.
			const isStale =
				opts.expectedStoryId !== undefined && reportStory !== opts.expectedStoryId;

			if (!isStale) {
				if (report.outcome.startsWith('BLOCKED_')) {
					return {
						kind: 'blocked',
						storyId: reportStory,
						detail: `Worker reported ${report.outcome} story=${reportStory} (worker-report-fallback).`,
					};
				}

				if (report.outcome === 'PRD_COMPLETE') {
					return {
						kind: 'pass',
						storyId: undefined,
						detail: 'Worker reported PRD_COMPLETE (worker-report-fallback).',
					};
				}

				if (report.outcome === 'DONE') {
					const prd = readPrd(prdPath, readFile);
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
				// Unknown outcome value: fall through to fallback path.
			}
		}
	}

	// -------------------------------------------------------------------------
	// FALLBACK PATH: no valid worker-report (absent workerReportPath, missing
	// file, or stale report). Use sentinel and handoff.json (backward compat).
	//
	// The DONE-sentinel-vs-handoff mismatch->fail block was dropped in US-001:
	// the sentinel is never a gate; when sentinel and handoff disagree, handoff
	// wins for story selection without raising a fail.
	// -------------------------------------------------------------------------

	// BLOCKED from sentinel (does not require story resolution).
	if (sentinel && sentinel.status.startsWith('BLOCKED')) {
		return {
			kind: 'blocked',
			storyId: sentinel.storyId,
			detail: `Worker reported ${sentinel.raw}`,
		};
	}

	// Also check raw pane text for BLOCKED tokens even without a full sentinel parse.
	if (!sentinel && /BLOCKED_\w+/.test(capturedPaneText)) {
		const rawMatch = capturedPaneText.match(/BLOCKED_\w+/);
		const blockedToken = rawMatch?.[0] ?? 'BLOCKED_UNKNOWN';
		return {
			kind: 'blocked',
			storyId: undefined,
			detail: `Pane text contains blocked token: ${blockedToken} (no full sentinel found)`,
		};
	}

	// PRD_COMPLETE from sentinel.
	if (sentinel && sentinel.status === 'PRD_COMPLETE') {
		return {
			kind: 'pass',
			storyId: undefined,
			detail: 'Worker reported PRD_COMPLETE (all stories already passing).',
		};
	}

	// State-primary: handoff.json is the story source (backward compat).
	// The mismatch->fail block has been removed; handoff wins over sentinel
	// for story selection without raising a fail.
	const { handoff, coerced: handoffWasStringCoerced } = readHandoff(handoffPath, readFile);
	const handoffStoryId = handoff?.lastCompletedStory?.id;
	const prd = readPrd(prdPath, readFile);

	const sentinelDone = sentinel !== null && sentinel.status === 'DONE';

	// Completed story (fallback path): handoff wins; fall back to a DONE sentinel's story.
	const completedStory =
		handoffStoryId ?? (sentinelDone ? sentinel.storyId : undefined);

	if (completedStory === undefined) {
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
