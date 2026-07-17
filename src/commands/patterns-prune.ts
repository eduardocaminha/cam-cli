// src/commands/patterns-prune.ts
//
// prunePatternRecordsOnMain() -- decay/demotion gate for the typed pattern-
// record store (scripts/cam/pattern-records.jsonl), so it self-cleans instead
// of growing monotonically like patterns.md.
//
// Three independent trigger conditions, evaluated per record. At most ONE
// decision fires per record per prune run (never a double-demote in a single
// pass, even when more than one condition matches):
//
//   1. Shelf-life staleness (AC3): a `tactical` record older than
//      TACTICAL_SHELF_LIFE_DAYS (30d), or an `observational` record older
//      than OBSERVATIONAL_SHELF_LIFE_DAYS (14d) -- age measured from the MOST
//      RECENT of recorded_at and every outcome's recorded_at -- is archived
//      directly (moved out of pattern-records.jsonl into
//      pattern-records.archive.jsonl), regardless of score or anchors.
//      `foundational` records have no shelf life (permanent invariants,
//      exempt from staleness).
//
//   2. Low confirmationScore (AC2): a record with at least one recorded
//      outcome (zero-outcome records are exempt -- unconfirmed but not yet
//      disproven, should not be punished before they get a chance to run)
//      whose confirmationScore (src/patterns/record.ts) falls below
//      PRUNE_SCORE_THRESHOLD is demoted ONE classification tier:
//      foundational -> tactical -> observational -> archived.
//
//   3. Anchor decay (AC4, "optional": only applies when dir_anchors is
//      non-empty -- an anchor-less record can never trigger this) -- a
//      record whose dir_anchors ALL resolve (relative to cwd) to paths that
//      no longer exist is demoted one tier, same chain as #2.
//
// Precedence per record: #1 is checked FIRST and wins outright (a stale
// record has already exhausted its tier's lifetime, independent of score or
// anchors). If not stale, #2 and #3 are combined with OR: either firing
// demotes exactly one tier (never two demotions from stacking both).
//
// PatternClassification (src/patterns/record.ts) has exactly three string
// values (foundational | tactical | observational) -- there is no fourth
// "archived" classification string. Demoting past `observational` therefore
// means REMOVAL from the active store (pattern-records.jsonl) into the
// companion archive file, not a stored classification value.
//
// Design mirrors the two established on-main writers for this subsystem:
//   - src/commands/patterns-archive.ts (patterns.md -> patterns.archive.md):
//     lazy archive-file bootstrap, one atomic 2-file commit.
//   - src/commands/pattern-records.ts (appendOutcomeOnMain): the per-attempt
//     CAS recompute discipline for a whole-file JSONL rewrite (US-002,
//     CAM-300, patterns.md line ~762) -- every retry attempt re-reads BOTH
//     files from the advanced main and re-runs the same pure decision logic
//     against that fresh content, so a concurrent append/outcome write
//     landing between the pre-mutation read and the winning commit survives
//     instead of being clobbered by a stale whole-file overwrite.
//
// US-004, CAM-64 "mulch model" port.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	checkMainUpToDate,
	commitTreeToMain,
	pushMainBestEffort,
	type FileWrite,
	type SpawnFn,
} from '../git/on-main.ts';
import {
	confirmationScore,
	parsePatternRecordsJsonl,
	type PatternClassification,
	type PatternRecord,
} from '../patterns/record.ts';
import { PATTERN_RECORDS_JSONL_PATH, readPatternRecordsContentFromMain } from './pattern-records.ts';

// Re-export SpawnFn so callers do not need to reach into src/git/on-main.ts directly.
export type { SpawnFn };

/** Companion archive file for records pruned past `observational`. Lazily created, mirrors patterns.archive.md. */
export const PATTERN_RECORDS_ARCHIVE_JSONL_PATH = 'scripts/cam/pattern-records.archive.jsonl';

/**
 * A record with at least one recorded outcome and a confirmationScore below
 * this threshold is demoted one classification tier. Records with ZERO
 * outcomes are exempt (unconfirmed, but not yet disproven).
 */
export const PRUNE_SCORE_THRESHOLD = 1;

/** Shelf life (days) before a `tactical` record is archived by staleness, regardless of score. */
export const TACTICAL_SHELF_LIFE_DAYS = 30;

/** Shelf life (days) before an `observational` record is archived by staleness, regardless of score. */
export const OBSERVATIONAL_SHELF_LIFE_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure decision logic (exported for unit testing without git)
// ---------------------------------------------------------------------------

/** One prune decision for a single record. */
export type PruneDecision =
	| { action: 'keep' }
	| { action: 'demote'; to: PatternClassification }
	| { action: 'archive' };

/**
 * Next tier down the demotion chain, or null when `observational` -- the
 * terminal step there is archive (removal from the store), not a fourth
 * classification string.
 */
function demoteOneTier(classification: PatternClassification): PatternClassification | null {
	if (classification === 'foundational') return 'tactical';
	if (classification === 'tactical') return 'observational';
	return null;
}

/** Shelf life in days for a classification, or null when exempt (`foundational`). */
function shelfLifeDaysFor(classification: PatternClassification): number | null {
	if (classification === 'tactical') return TACTICAL_SHELF_LIFE_DAYS;
	if (classification === 'observational') return OBSERVATIONAL_SHELF_LIFE_DAYS;
	return null;
}

/** Most recent timestamp (ms epoch) across recorded_at and every outcome's recorded_at. */
function mostRecentTimestamp(record: PatternRecord): number {
	let latest = Date.parse(record.recorded_at);
	for (const outcome of record.outcomes) {
		const t = Date.parse(outcome.recorded_at);
		if (!Number.isNaN(t) && t > latest) latest = t;
	}
	return latest;
}

/** True when dir_anchors is non-empty and every anchor fails existsFn relative to cwd. */
function isAnchorDecayed(
	record: PatternRecord,
	cwd: string,
	existsFn: (path: string) => boolean,
): boolean {
	if (record.dir_anchors.length === 0) return false;
	return record.dir_anchors.every((anchor) => !existsFn(join(cwd, anchor)));
}

export interface ComputePruneDecisionOptions {
	/** Absolute path to the project root; dir_anchors are resolved relative to this. */
	cwd: string;
	/** Current time (ms epoch), injectable for deterministic shelf-life tests. */
	nowMs: number;
	/** Injectable path-existence check. Defaults to node:fs existsSync. */
	existsFn?: (path: string) => boolean;
}

/**
 * Compute the prune decision for one record. Pure (no git calls; the only
 * I/O is the injectable existsFn). See module header for the full
 * precedence rule (shelf-life wins outright; score/anchor-decay combine into
 * at most one demotion step).
 */
export function computePruneDecision(
	record: PatternRecord,
	options: ComputePruneDecisionOptions,
): PruneDecision {
	const { cwd, nowMs, existsFn = existsSync } = options;

	// 1. Shelf-life staleness wins outright (direct archive).
	const shelfLifeDays = shelfLifeDaysFor(record.classification);
	if (shelfLifeDays !== null) {
		const ageMs = nowMs - mostRecentTimestamp(record);
		if (ageMs > shelfLifeDays * MS_PER_DAY) {
			return { action: 'archive' };
		}
	}

	// 2. Low confirmationScore (only when the record has evidence to act on).
	const scoreTriggered =
		record.outcomes.length > 0 && confirmationScore(record) < PRUNE_SCORE_THRESHOLD;

	// 3. Anchor decay.
	const anchorTriggered = isAnchorDecayed(record, cwd, existsFn);

	if (scoreTriggered || anchorTriggered) {
		const next = demoteOneTier(record.classification);
		return next === null ? { action: 'archive' } : { action: 'demote', to: next };
	}

	return { action: 'keep' };
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

/** Serialize a PatternRecord[] as JSONL, one record per line, trailing newline. Empty list -> ''. */
function serializeRecords(records: PatternRecord[]): string {
	if (records.length === 0) return '';
	return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

/**
 * Read pattern-records.archive.jsonl from main via `git show`. Missing file
 * on main (non-zero exit) is treated as empty -- lazy creation, same posture
 * as patterns.archive.md (src/commands/patterns-archive.ts).
 */
function readPatternRecordsArchiveContentFromMain(cwd: string, spawnFn: SpawnFn): string {
	const showResult = spawnFn(
		'git',
		['-C', cwd, 'show', `main:${PATTERN_RECORDS_ARCHIVE_JSONL_PATH}`],
		{ encoding: 'utf8' },
	);
	if ((showResult.status ?? 1) !== 0) {
		return '';
	}
	return showResult.stdout ?? '';
}

// ---------------------------------------------------------------------------
// prunePatternRecordsOnMain
// ---------------------------------------------------------------------------

export interface PrunePatternRecordsOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Current time (ms epoch), injectable for deterministic shelf-life tests. Defaults to Date.now(). */
	nowMs?: number;
	/** Injectable path-existence check for anchor-decay. Defaults to node:fs existsSync. */
	existsFn?: (path: string) => boolean;
}

export interface PrunePatternRecordsOnMainSuccess {
	ok: true;
	/** Total records mutated this run (demoted + archived). 0 for the no-op path. */
	pruned: number;
	/** Count of records demoted one tier (still present in the active store). */
	demoted: number;
	/** Count of records archived (removed from the active store). */
	archived: number;
	/** Short sha (7 chars) of the new commit on main. Empty string on no-op. */
	sha: string;
}

export type PrunePatternRecordsOnMainError = {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main';
};

export type PrunePatternRecordsOnMainResult =
	| PrunePatternRecordsOnMainSuccess
	| PrunePatternRecordsOnMainError;

/**
 * Demote/archive stale or unconfirmed scripts/cam/pattern-records.jsonl
 * records, directly on main.
 *
 * Guards (in order, before any mutation):
 *   0. Up-to-date guard (detached-head, missing-main, diverged).
 *   1. Pre-mutation check: read + decide against the current main content.
 *      No record needs a decision other than `keep` -- clean no-op
 *      ({ ok: true, pruned: 0, demoted: 0, archived: 0, sha: '' }), no commit.
 *
 * Mutation (at least one record needs demotion/archival):
 *   2. The per-attempt CAS recompute callback re-reads BOTH
 *      pattern-records.jsonl and pattern-records.archive.jsonl from the
 *      advanced main on EVERY attempt and re-runs computePruneDecision
 *      against that fresh content, so a concurrent writer's change (a new
 *      append, a new outcome) landing between the pre-mutation read and the
 *      winning commit survives instead of being clobbered by a stale
 *      whole-file overwrite.
 *   3. Writes both files in ONE atomic commit via commitTreeToMain.
 *   4. Best-effort push to origin main.
 */
export function prunePatternRecordsOnMain(
	options: PrunePatternRecordsOnMainOptions,
): PrunePatternRecordsOnMainResult {
	const { cwd, spawnFn, nowMs = Date.now(), existsFn = existsSync } = options;

	const guard = checkMainUpToDate(cwd, spawnFn, 'prune pattern records');
	if (!guard.ok) return guard;
	const { localMainSha } = guard;

	const preRecords = parsePatternRecordsJsonl(readPatternRecordsContentFromMain(cwd, spawnFn));
	const preHasWork = preRecords.some(
		(r) => computePruneDecision(r, { cwd, nowMs, existsFn }).action !== 'keep',
	);
	if (!preHasWork) {
		return { ok: true, pruned: 0, demoted: 0, archived: 0, sha: '' };
	}

	let demotedCount = 0;
	let archivedCount = 0;

	const commitMsg = 'chore(cam): pattern-records prune';
	const sha = commitTreeToMain(
		cwd,
		(_mainSha) => {
			const freshRecords = parsePatternRecordsJsonl(readPatternRecordsContentFromMain(cwd, spawnFn));
			const freshArchived = parsePatternRecordsJsonl(
				readPatternRecordsArchiveContentFromMain(cwd, spawnFn),
			);

			const kept: PatternRecord[] = [];
			const newlyArchived: PatternRecord[] = [];
			let demoted = 0;
			let archived = 0;

			for (const record of freshRecords) {
				const decision = computePruneDecision(record, { cwd, nowMs, existsFn });
				if (decision.action === 'keep') {
					kept.push(record);
				} else if (decision.action === 'demote') {
					demoted += 1;
					kept.push({ ...record, classification: decision.to });
				} else {
					archived += 1;
					newlyArchived.push(record);
				}
			}

			demotedCount = demoted;
			archivedCount = archived;

			const files: FileWrite[] = [
				{ path: PATTERN_RECORDS_JSONL_PATH, content: serializeRecords(kept) },
				{
					path: PATTERN_RECORDS_ARCHIVE_JSONL_PATH,
					content: serializeRecords([...freshArchived, ...newlyArchived]),
				},
			];
			return files;
		},
		commitMsg,
		localMainSha,
		spawnFn,
		'cam-patterns-prune-',
	);

	pushMainBestEffort(cwd, spawnFn);

	return {
		ok: true,
		pruned: demotedCount + archivedCount,
		demoted: demotedCount,
		archived: archivedCount,
		sha,
	};
}
