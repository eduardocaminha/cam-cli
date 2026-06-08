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
export type WorkerOutcomeKind = 'pass' | 'fail' | 'blocked' | 'unknown';

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
	// Match CAM_IMPLEMENTER_STATUS=<VALUE> optionally followed by story=<ID>
	// The sentinel may appear anywhere in the pane output.
	const match = paneText.match(/CAM_IMPLEMENTER_STATUS=(\S+)(?:\s+story=(US-\S+))?/);
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

/** Read and validate handoff.json. Returns null on any problem. */
function readHandoff(handoffPath: string, readFile: FileReader): HandoffJson | null {
	const text = readFile(handoffPath);
	if (text === null) return null;
	const parsed = tryParseJson(text);
	if (!isObject(parsed)) return null;
	// Validate lastCompletedStory.id is a string if present
	const story = (parsed as HandoffJson).lastCompletedStory;
	if (story !== undefined && !isObject(story)) return null;
	return parsed as HandoffJson;
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

	// --- Step 3: DONE path - requires all three signals to agree ---
	if (sentinel && sentinel.status === 'DONE') {
		const sentinelStoryId = sentinel.storyId;

		// Read handoff to get lastCompletedStory.id
		const handoff = readHandoff(handoffPath, readFile);
		const handoffStoryId = handoff?.lastCompletedStory?.id;

		// Read prd to verify passes:true
		const prd = readPrd(prdPath, readFile);

		// Cross-check: sentinel story=US-XXX must match handoff lastCompletedStory.id
		if (!sentinelStoryId) {
			return {
				kind: 'fail',
				storyId: handoffStoryId,
				detail: 'Sentinel is DONE but missing story= field; cannot cross-check.',
			};
		}

		if (!handoffStoryId) {
			return {
				kind: 'fail',
				storyId: sentinelStoryId,
				detail: `Sentinel reports DONE story=${sentinelStoryId} but handoff.json has no lastCompletedStory.id.`,
			};
		}

		if (sentinelStoryId !== handoffStoryId) {
			return {
				kind: 'fail',
				storyId: sentinelStoryId,
				detail: `Sentinel says story=${sentinelStoryId} but handoff.json has lastCompletedStory.id=${handoffStoryId}; mismatch.`,
			};
		}

		// Cross-check: prd.json must show passes:true for this story
		if (!prd) {
			return {
				kind: 'fail',
				storyId: sentinelStoryId,
				detail: `Sentinel and handoff agree on story=${sentinelStoryId} but prd.json could not be read.`,
			};
		}

		if (!storyPassesInPrd(prd, sentinelStoryId)) {
			return {
				kind: 'fail',
				storyId: sentinelStoryId,
				detail: `Sentinel and handoff agree on story=${sentinelStoryId} but prd.json still shows passes:false.`,
			};
		}

		// All three signals agree: genuine pass
		return {
			kind: 'pass',
			storyId: sentinelStoryId,
			detail: `story=${sentinelStoryId} confirmed: sentinel DONE, handoff matches, prd.json passes:true.`,
		};
	}

	// --- Step 4: PRD_COMPLETE path ---
	if (sentinel && sentinel.status === 'PRD_COMPLETE') {
		// Worker found no stories to implement (all passes:true already).
		// Treat as a special pass variant with no storyId.
		return {
			kind: 'pass',
			storyId: undefined,
			detail: 'Worker reported PRD_COMPLETE (all stories already passing).',
		};
	}

	// --- Step 5: Unknown - no recognizable signals ---
	return {
		kind: 'unknown',
		storyId: undefined,
		detail:
			'No CAM_IMPLEMENTER_STATUS sentinel found in pane text and no blocked token detected.',
	};
}
