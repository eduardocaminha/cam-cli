// src/issues/list.ts
//
// deriveBacklogView() -- pure derivation of the actionable-backlog view from
// an IssueEntry[]. Groups open issues by lifecycle stage, sorts within each
// group, and annotates each entry with its unmet blockers.
//
// deriveBacklogJson() -- pure derivation of the `cam issue list --json`
// machine snapshot ({ counts, plannable, byStage }). See src/commands/
// issue-list.ts (US-002, this PRD) for the I/O-owning command that renders
// it to stdout.
//
// No I/O here: the file-backed seam (readBacklogFromMain) lives in
// src/issues/backlog.ts and is wired up by the cam issue list command
// (src/commands/issue-list.ts, US-002).
//
// CAM-190 US-001.

import type { IssueEntry, IssueStage } from './types.ts';
import { isPlannable } from './select.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One row in the rendered backlog view: the issue plus its unmet blockers.
 *
 * unmetBlockers mirrors isBlocked's semantics (src/issues/graph.ts): the
 * subset of issue.blockedBy ids whose backlog entry exists with
 * stage !== 'shipped'. A missing (unknown) blockedBy id is NOT included here
 * (referential-integrity is checkReferentialIntegrity's concern, not this
 * view's).
 */
export interface BacklogViewEntry {
	issue: IssueEntry;
	unmetBlockers: string[];
}

/** One lifecycle-stage group in the rendered backlog view. */
export interface BacklogViewGroup {
	stage: IssueStage;
	entries: BacklogViewEntry[];
}

export interface BacklogViewOptions {
	/** When true, appends a 'shipped' group after the default lifecycle groups. */
	includeShipped?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Default lifecycle-order stage groups (shipped is opt-in via includeShipped). */
const DEFAULT_STAGES: IssueStage[] = ['idea', 'specified', 'planned'];

/**
 * Parses the numeric suffix from an issue id (e.g. "CAM-12" -> 12).
 * Returns Infinity when the suffix is absent or non-numeric, so un-parseable
 * ids sort to the end rather than crashing.
 *
 * Replicated from src/issues/select.ts (selectPlannableIssue's tie-breaker)
 * per the story notes: this module stays independent of select.ts internals.
 */
function numericIdSuffix(id: string): number {
	const suffix = id.split('-').at(-1);
	if (suffix === undefined) return Infinity;
	const n = Number(suffix);
	return Number.isNaN(n) ? Infinity : n;
}

/**
 * Sort comparator mirroring selectPlannableIssue's ordering contract:
 *   1. ranked entries sort before unranked ones
 *   2. among ranked entries, ascending rank value (lower rank = higher priority)
 *   3. tie-break (same rank, or both unranked): ascending numeric id suffix
 */
export function compareBacklogEntries(a: IssueEntry, b: IssueEntry): number {
	const aHasRank = a.rank !== undefined;
	const bHasRank = b.rank !== undefined;

	if (aHasRank && !bHasRank) return -1;
	if (!aHasRank && bHasRank) return 1;

	if (aHasRank && bHasRank) {
		const rankDiff = (a.rank as number) - (b.rank as number);
		if (rankDiff !== 0) return rankDiff;
	}

	return numericIdSuffix(a.id) - numericIdSuffix(b.id);
}

/**
 * Returns the subset of issue.blockedBy ids that are unmet: present in the
 * backlog with stage !== 'shipped' (isBlocked semantics, src/issues/graph.ts).
 */
function unmetBlockersOf(issue: IssueEntry, byId: Map<string, IssueEntry>): string[] {
	return issue.blockedBy.filter((depId) => {
		const dep = byId.get(depId);
		return dep !== undefined && dep.stage !== 'shipped';
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives the actionable-backlog view from a full IssueEntry[] backlog.
 *
 * Filtering (default, includeShipped absent/false):
 *   - stage:'shipped' entries are excluded, regardless of status. This keys
 *     ONLY on stage, never on status: a fixture with stage:'shipped' AND
 *     status:'open' must NOT appear (the CAM-139 regression case).
 *   - status:'abandoned' entries are excluded from every group, including the
 *     opt-in shipped group.
 *
 * Grouping: one group per stage, always in lifecycle order
 * (idea, specified, planned[, shipped when includeShipped is true]). Groups
 * are always present (possibly with zero entries); callers decide whether to
 * render empty groups.
 *
 * Sorting: within each group, entries are ordered by compareBacklogEntries
 * (ranked-before-unranked, ascending rank, numeric id suffix tie-break).
 *
 * Pure: no I/O. backlog array in, view struct out.
 */
export function deriveBacklogView(
	backlog: IssueEntry[],
	options: BacklogViewOptions = {},
): BacklogViewGroup[] {
	const stages: IssueStage[] = options.includeShipped
		? [...DEFAULT_STAGES, 'shipped']
		: DEFAULT_STAGES;

	const byId = new Map(backlog.map((entry) => [entry.id, entry]));

	return stages.map((stage) => {
		const stageIssues = backlog.filter(
			(issue) => issue.stage === stage && issue.status !== 'abandoned',
		);
		stageIssues.sort(compareBacklogEntries);
		return {
			stage,
			entries: stageIssues.map((issue) => ({
				issue,
				unmetBlockers: unmetBlockersOf(issue, byId),
			})),
		};
	});
}

// ---------------------------------------------------------------------------
// --json machine view (US-002, this PRD)
// ---------------------------------------------------------------------------

/** One row in the `--json` output: a minimal issue projection. */
export interface BacklogJsonRow {
	id: string;
	title: string;
	/** null when the issue is unranked (JSON has no `undefined`; the key is always present). */
	rank: number | null;
}

/** Per-stage open-issue counts. `shipped` is present only when `includeShipped` is true. */
export interface BacklogJsonCounts {
	idea: number;
	specified: number;
	planned: number;
	shipped?: number;
}

/** Per-stage open-issue rows (blocked entries included). `shipped` is present only when `includeShipped` is true. */
export interface BacklogJsonByStage {
	idea: BacklogJsonRow[];
	specified: BacklogJsonRow[];
	planned: BacklogJsonRow[];
	shipped?: BacklogJsonRow[];
}

/** The full `cam issue list --json` payload. */
export interface BacklogJsonView {
	counts: BacklogJsonCounts;
	plannable: BacklogJsonRow[];
	byStage: BacklogJsonByStage;
}

function toJsonRow(issue: IssueEntry): BacklogJsonRow {
	return { id: issue.id, title: issue.title, rank: issue.rank ?? null };
}

/**
 * Derives the `cam issue list --json` machine snapshot from a full
 * IssueEntry[] backlog.
 *
 * - counts / byStage: per lifecycle-stage groups of status:'open' entries
 *   ONLY (status:'abandoned' entries never appear anywhere in the output).
 *   'shipped' is included in both only when `includeShipped` is true
 *   (mirrors deriveBacklogView's --all semantics); otherwise the key is
 *   absent (not merely undefined-valued).
 * - plannable: membership is isPlannable (specified + open + not blocked,
 *   src/issues/plannable.ts via select.ts) evaluated against the FULL
 *   backlog (blocker lookups need every stage, not just the open subset).
 *   A blocked specified+open entry appears in byStage.specified but NOT in
 *   plannable.
 *
 * Sorting: both plannable and each byStage group use compareBacklogEntries
 * (ranked-first, ascending rank, numeric id suffix tie-break) -- the same
 * ordering deriveBacklogView uses, NOT selectPlannableIssue's WSJF-aware
 * champion selection (that answers a different question: "which ONE issue
 * next", not "rank this list").
 *
 * Pure: no I/O. backlog array in, JSON-shaped struct out.
 */
export function deriveBacklogJson(
	backlog: IssueEntry[],
	options: BacklogViewOptions = {},
): BacklogJsonView {
	const stages: IssueStage[] = options.includeShipped
		? [...DEFAULT_STAGES, 'shipped']
		: DEFAULT_STAGES;

	const counts = {} as BacklogJsonCounts;
	const byStage = {} as BacklogJsonByStage;

	for (const stage of stages) {
		const stageIssues = backlog.filter(
			(issue) => issue.stage === stage && issue.status === 'open',
		);
		stageIssues.sort(compareBacklogEntries);
		counts[stage] = stageIssues.length;
		byStage[stage] = stageIssues.map(toJsonRow);
	}

	const plannable = backlog
		.filter((issue) => isPlannable(issue, backlog))
		.sort(compareBacklogEntries)
		.map(toJsonRow);

	return { counts, plannable, byStage };
}
