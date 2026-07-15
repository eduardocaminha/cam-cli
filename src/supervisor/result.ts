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
//
// The worker-report.json read path (tryReadWorkerReport) delegates to the
// shared fail-closed parser in report-parse.ts (US-003), so this module's own
// notion of "a valid report" is exactly parseWorkerReport's contract: the
// canonical WorkerReport type, never a divergent local shape.

import { parseWorkerReport } from './report-parse.ts';
import type { WorkerReport } from './worker-report.ts';

/** File-reading callback injected by the caller. Returns null on missing/error. */
export type FileReader = (path: string) => string | null;

/**
 * Outcome kinds returned by readWorkerOutcome.
 *
 * 'no-commit' (US-001, CAM-187): a story is passes:true in prd.json but the
 * injected commitExistsForStory callback could not confirm a matching commit
 * (and the story is not requires:'operator', which is exempt). This is
 * deliberately distinct from 'incomplete' (which routes the supervisor loop
 * to finalizeStory/auto-commit) -- a passes:true-but-no-commit story is not a
 * worker-truncated-protocol-tail case, it is a suspect DONE claim that should
 * not advance to review without an actual commit landing.
 *
 * 'fail' also covers the red-gate refusal (US-001, CAM-202: no-flaky-
 * evasion): a story is passes:true in prd.json AND worker-report.json reports
 * outcome DONE, but the report's own gates.tests string indicates a failing
 * test (see gateTestsIndicateFailure). The supervisor loop already routes
 * 'fail' to the blocked terminal branch, so this reuses the existing kind
 * rather than introducing a new one.
 *
 * 'blocked' also covers the empty-push gate (US-004): a story is passes:true
 * (and, when injected, confirmCommitGate already passed) but the injected
 * aheadByForBranch callback reports 0 commits ahead of origin/main (and the
 * story is not requires:'operator', which is exempt; see
 * confirmEmptyPushGate). This reuses 'blocked' rather than a new kind because
 * loop.ts already routes 'blocked' through the same terminal path a failed
 * push-verification check uses.
 */
export type WorkerOutcomeKind = 'pass' | 'incomplete' | 'fail' | 'blocked' | 'unknown' | 'no-commit';

/** Typed result from readWorkerOutcome. */
export interface WorkerOutcome {
	/** What happened. */
	kind: WorkerOutcomeKind;
	/**
	 * The story ID the worker completed. Derived from worker-report.json when a
	 * valid, non-stale report is present; falls back to handoff.json and the
	 * sentinel in the backward-compat path. May be undefined when kind is
	 * 'unknown' and no signals exist.
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
	 * When provided and the file is valid and non-stale, this is the PRIMARY
	 * outcome source: report.story drives which story completed, report.outcome
	 * drives DONE/BLOCKED_.../PRD_COMPLETE. handoff.json is not consulted in this
	 * path. Falls through to the sentinel+handoff fallback only when absent,
	 * missing, or stale.
	 */
	workerReportPath?: string;
	/**
	 * Optional advisory story id set by the supervisor loop (the story it
	 * dispatched). When provided, reports whose story field does NOT match this
	 * id are considered stale and fall through to the sentinel+handoff fallback
	 * path (staleness guard). This prevents a leftover report from a previous
	 * run from masquerading as a fresh completion signal when clearWorkerReport
	 * failed or the worker crashed after writing its report. When undefined, no
	 * staleness check is applied (US-001 behavior).
	 */
	expectedStoryId?: string;
	/** Raw text captured from the worker pane (via capture-pane -p). */
	capturedPaneText: string;
	/** Injected file reader; returns file contents as string, or null on error. */
	readFile: FileReader;
	/**
	 * Optional commit-existence gate (US-001, CAM-187): called with a story id
	 * that is passes:true in prd.json, right before confirming a DONE outcome.
	 * Returning false means no commit was found for that story, so the outcome
	 * does NOT resolve to kind:'pass' (kind:'no-commit' instead), UNLESS the
	 * story's `requires` field is 'operator' (ceremony exemption -- operator
	 * stories are flipped by hand, not by a worker commit).
	 *
	 * When absent (undefined), no gate is applied: readWorkerOutcome behaves
	 * exactly as it did before this option existed (AC5). This callback is a
	 * pure injection point: result.ts performs no git/child-process spawn of
	 * its own; the caller (US-002) is responsible for the actual git lookup,
	 * typically using commitSubjectMatchesStory to validate the found commit's
	 * subject line.
	 */
	commitExistsForStory?: (storyId: string) => boolean;
	/**
	 * Optional empty-push gate (US-004): called right after confirmCommitGate
	 * passes for a passes:true story, to catch `ensurePushed`/`branchPushed`
	 * reporting success on a push that landed zero new commits ahead of
	 * origin/main. Returns the ahead-by count (`git rev-list --count
	 * origin/main..HEAD`, best-effort `git fetch origin main` first, mirroring
	 * commitExistsForStory's fetch+range-fallback in host.ts), or `null` when
	 * the count could not be determined (fail-open: this gate is a coarse
	 * branch-level sanity check layered on top of the existing push
	 * verification, not a replacement for it).
	 *
	 * ahead_by === 0 degrades the outcome to kind:'blocked' (the same terminal
	 * path a failed push-verification check already uses in loop.ts), UNLESS
	 * the story is requires:'operator' (ceremony exemption, parity with
	 * confirmCommitGate/isOperatorStory). When absent (undefined), no gate is
	 * applied: readWorkerOutcome behaves exactly as it did before this option
	 * existed.
	 */
	aheadByForBranch?: () => number | null;
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
 *
 * `requires` was added in US-001 (CAM-187) so the commit-existence gate can
 * read the operator-ceremony exemption (requires: 'operator' stories are
 * flipped by hand and have no worker commit to find).
 */
interface PrdJson {
	userStories?: Array<{
		id?: string;
		passes?: boolean;
		requires?: string | null;
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
 * Read and parse worker-report.json via the shared fail-closed parser
 * (report-parse.ts, US-001/US-002/US-003). Returns the canonical typed
 * WorkerReport, or null when the file is missing or the report fails
 * validation (missing/mistyped outcome+story discriminator, or a
 * present-but-malformed optional field such as gates).
 */
function tryReadWorkerReport(reportPath: string, readFile: FileReader): WorkerReport | null {
	const text = readFile(reportPath);
	if (text === null) return null;
	return parseWorkerReport(text);
}

/**
 * Safely extract report.gates.tests as a string, or undefined if gates is
 * absent (US-001, CAM-202). parseWorkerReport already fail-closes a
 * present-but-malformed gates field at parse time (the whole report is
 * rejected to null before reaching here), so once a WorkerReport instance
 * exists its gates.tests, when present, is already a validated string.
 */
function extractRecordedTestsGate(report: WorkerReport): string | undefined {
	return report.gates?.tests;
}

/**
 * Red-gate guard (US-001, CAM-202: no-flaky-evasion): classify a recorded
 * gates.tests string (worker-report.json) as indicating a failing test.
 *
 * FAILING when:
 *   - the string starts with "fail" (e.g. "fail: <detail>"), OR
 *   - it contains a "<N> fail" count where N > 0 (e.g. "41 pass / 1 fail").
 *
 * NOT failing for "42 pass / 0 fail", "ok", "n/a", and skip-containing
 * strings with a zero fail count (e.g. "40 pass / 3 skip / 0 fail").
 * Legitimate skips (e.g. OS/capability-gated real-tmux tests off-macOS) never
 * block; only a failing test blocks. This prevents a worker from narrating a
 * recorded test failure away as flaky/pre-existing/environmental/unrelated
 * and declaring the story DONE anyway.
 */
export function gateTestsIndicateFailure(tests: string): boolean {
	const trimmed = tests.trim();
	if (/^fail/i.test(trimmed)) return true;
	const match = trimmed.match(/(\d+)\s*fail\b/i);
	if (!match) return false;
	const count = Number(match[1] ?? '0');
	return count > 0;
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

/** Is this story exempt from the commit-existence gate (an operator ceremony)? */
function isOperatorStory(prd: PrdJson, storyId: string): boolean {
	const story = prd.userStories?.find((s) => s.id === storyId);
	return story?.requires === 'operator';
}

/**
 * Commit-existence gate (US-001, CAM-187): decide whether a passes:true story
 * is safe to confirm as kind:'pass', or must fall back to kind:'no-commit'.
 *
 * - No callback injected -> always ok (AC5: pre-existing behavior, no gate).
 * - requires:'operator' story -> always ok (AC4: ceremony exemption).
 * - Otherwise -> ok iff commitExistsForStory(storyId) returns true (AC2/AC3).
 */
function confirmCommitGate(
	prd: PrdJson,
	storyId: string,
	commitExistsForStory: ((storyId: string) => boolean) | undefined,
): { ok: true } | { ok: false; detail: string } {
	if (commitExistsForStory === undefined) return { ok: true };
	if (isOperatorStory(prd, storyId)) return { ok: true };
	if (commitExistsForStory(storyId)) return { ok: true };
	return {
		ok: false,
		detail: `story=${storyId} is passes:true in prd.json but no commit was found for it (commit-existence gate); not confirmed DONE.`,
	};
}

/**
 * Empty-push gate (US-004): decide whether a passes:true story's push
 * actually landed a commit ahead of origin/main, or is an empty push
 * masquerading as a completed run (branchPushed=true can fire even when
 * ahead_by==0).
 *
 * - No callback injected -> always ok (parity with confirmCommitGate AC5).
 * - requires:'operator' story -> always ok (ceremony exemption, AC2).
 * - aheadByForBranch() returns null (could not be determined) -> ok
 *   (fail-open; a coarse sanity check layered on top of push-verification,
 *   not a replacement for it).
 * - Otherwise -> ok iff the returned ahead-by count is >= 1 (AC1).
 */
function confirmEmptyPushGate(
	prd: PrdJson,
	storyId: string,
	aheadByForBranch: (() => number | null) | undefined,
): { ok: true } | { ok: false; detail: string } {
	if (aheadByForBranch === undefined) return { ok: true };
	if (isOperatorStory(prd, storyId)) return { ok: true };
	const aheadBy = aheadByForBranch();
	if (aheadBy === null || aheadBy >= 1) return { ok: true };
	return {
		ok: false,
		detail: `story=${storyId} is passes:true in prd.json but 0 commits ahead of origin/main (empty-push gate); not confirmed DONE.`,
	};
}

/**
 * Pure matcher (US-001, CAM-187; bracketed convention fixed in US-R1-001;
 * open conventional-type prefix accepted per US-001, CAM-194): does a commit
 * subject line confirm completion of the given story, per the commit
 * convention `<type>: [Story ID] - [Story Title]`
 * (scripts/cam/CLAUDE.md step 8, templates/agents/subagent-implementer.md)?
 *
 * The prefix accepts any lowercase conventional-commit type (`feat`, `fix`,
 * `refactor`, `perf`, `chore`, `docs`, `test`, `build`, `ci`, `style`, ...),
 * with an optional scope in parens and an optional breaking-change `!`
 * (e.g. `fix(scope)!: [US-001] - ...`), since a story may legitimately be
 * completed or corrected under a non-`feat:` type (e.g. a Step 5.5
 * follow-up commit `fix: [Story ID] - correct <issue>`).
 *
 * The real convention the worker emits brackets the id (e.g.
 * `feat: [US-001] - Add commit-existence gate`); the bracketless form
 * (`feat: US-001 - Title`) is also accepted for backward compatibility with
 * older commits on the branch's history. The id must be either exactly
 * `[<id>]` or exactly `<id>` (no mismatched single bracket), immediately
 * after the type prefix (optional whitespace) and immediately before the
 * ` - ` title separator (optional whitespace around the hyphen).
 *
 * Review-fix story ids (e.g. US-R1-003) follow the same convention (they are
 * ordinary stories from the implementer's point of view) and are matched by
 * the same rule, since the id class US-[A-Za-z0-9-]+ already allows internal
 * hyphens.
 *
 * Rejects a subject that only mentions the id incidentally: the id must
 * appear immediately after the type prefix (optional whitespace) and
 * immediately before the ` - ` title separator (optional whitespace around
 * the hyphen). A subject naming a DIFFERENT story that happens to share this
 * story's id as a prefix (e.g. "feat: US-0010 - Title" queried with storyId
 * "US-001") does not match, because the character right after the id must be
 * the separator hyphen (or closing bracket), not another id character.
 */
export function commitSubjectMatchesStory(subject: string, storyId: string): boolean {
	const escapedId = storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^[a-z]+(?:\\([^)]*\\))?!?:\\s*(?:\\[${escapedId}\\]|${escapedId})\\s*-\\s*\\S`);
	return re.test(subject.trim());
}

// ---------------------------------------------------------------------------
// Sentinel polling helper (US-012)
// ---------------------------------------------------------------------------

/** Which sentinel source was matched when polling the pane. */
export type AnySentinelSource = 'implementer' | 'review-tag';

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
 *   - <review>CLEAN</review> or <review>FIXES_PENDING:N</review>
 *
 * Returns the first match found, or null if none present.
 */
export function parseAnySentinel(paneText: string): AnySentinelMatch | null {
	const implMatch = paneText.match(/CAM_IMPLEMENTER_STATUS=\S+/);
	if (implMatch) {
		return { source: 'implementer', raw: implMatch[0] ?? '' };
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

		if (report) {
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
						// Red-gate guard (US-001, CAM-202): refuse to confirm DONE when the
						// worker's OWN recorded gates.tests shows a failing test, even
						// though prd.json already shows passes:true for this story. This
						// closes the no-flaky-evasion hole: a worker cannot narrate a red
						// gate away as flaky/pre-existing/environmental/unrelated and have
						// the supervisor advance the story anyway. Checked before the
						// commit-existence gate so the red-gate detail is the one surfaced.
						const recordedTests = extractRecordedTestsGate(report);
						if (recordedTests !== undefined && gateTestsIndicateFailure(recordedTests)) {
							return {
								kind: 'fail',
								storyId: reportStory,
								detail: `story=${reportStory} refused: recorded gate had a failing test (gates.tests="${recordedTests}"); red-gate refusal, not confirmed DONE (worker-report-fallback).`,
							};
						}
						const gate = confirmCommitGate(prd, reportStory, opts.commitExistsForStory);
						if (!gate.ok) {
							return {
								kind: 'no-commit',
								storyId: reportStory,
								detail: `${gate.detail} (worker-report-fallback)`,
							};
						}
						// Empty-push gate (US-004): checked after the commit-existence
						// gate passes, so its detail is the one surfaced when both
						// would fail (the commit-existence detail is more specific).
						const emptyPushGate = confirmEmptyPushGate(prd, reportStory, opts.aheadByForBranch);
						if (!emptyPushGate.ok) {
							return {
								kind: 'blocked',
								storyId: reportStory,
								detail: `${emptyPushGate.detail} (worker-report-fallback)`,
							};
						}
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
		const gate = confirmCommitGate(prd, completedStory, opts.commitExistsForStory);
		if (!gate.ok) {
			return {
				kind: 'no-commit',
				storyId: completedStory,
				detail: gate.detail,
			};
		}
		// Empty-push gate (US-004): same ordering rationale as the
		// worker-report-fallback branch above.
		const emptyPushGate = confirmEmptyPushGate(prd, completedStory, opts.aheadByForBranch);
		if (!emptyPushGate.ok) {
			return {
				kind: 'blocked',
				storyId: completedStory,
				detail: emptyPushGate.detail,
			};
		}
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
