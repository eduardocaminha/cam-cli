// src/commands/cycle-metrics.ts
//
// On-main upsert/append writer for scripts/cam/cycle-metrics.jsonl (US-003 of
// CAM-470). Companion to the pure derivation module (src/stats/cycles.ts,
// US-001) and the CLI-facing `cam stats cycles --rebuild` reporter
// (src/commands/stats.ts, US-002): this module is what the LOOP itself calls
// at cycle-close time to grow the versioned artifact on main, in place, one
// row per closed cycle, without ever touching a feature branch's working
// tree or clobbering another writer's concurrent commit.
//
// Design mirrors appendOutcomeOnMain / readPatternRecordsContentFromMain
// (src/commands/pattern-records.ts):
//   - Read scripts/cam/cycle-metrics.jsonl from main via `git show main:<path>`,
//     NEVER the working tree. A missing file on main (non-zero exit) is
//     treated as an empty store -- there is no templates/ seed and no
//     `cam init` seeding step for this artifact (bootstrap-on-first-append
//     posture, NOT the suggestions.ts hard-printError posture).
//   - Commit via the SHARED commitTreeToMain/checkMainUpToDate/
//     pushMainBestEffort helpers in src/git/on-main.ts -- no private copy of
//     that guard/push pair (jscpd gate, patterns.md line 272).
//   - The per-attempt FileWritesFn callback re-reads scripts/cam/cycle-metrics.jsonl
//     from the advanced main on EVERY CAS attempt and re-applies the SAME
//     bootstrap-or-upsert mutation against that fresh content, so a row
//     concurrently written by another caller between the pre-mutation lookup
//     and the winning commit survives instead of being clobbered by a stale
//     whole-file overwrite.
//
// Bootstrap vs upsert:
//   - Store absent/empty on main: the first write bootstraps the file with a
//     FULL derivation of `eventLogJsonl` (header + every bounded row),
//     byte-identical to what `cam stats cycles --rebuild` would produce for
//     the same log content (AC3).
//   - Store already present: only the ONE line for `cycleId` is replaced (or
//     appended, when that cycleId has no line yet) -- every other line,
//     including blank lines and lines that fail to parse, is pushed back
//     byte-for-byte (AC4), mirroring appendOutcomeToLine
//     (src/commands/pattern-records.ts:338-369).
//   - A cycleId with no established row yet (e.g. its marker is the log's
//     very first, which has no left bound per ADR-0053) never fabricates a
//     row: the writer returns a structured no-op result before any git call.
//
// Failure modes are structured, never thrown (AC7): the up-to-date guard's
// 'diverged' | 'detached-head' | 'missing-main' reasons pass straight
// through, and a commitTreeToMain failure (CAS exhaustion, hash-object/
// update-index error) is caught and reported as reason 'commit-failed'
// instead of propagating, so the US-004 caller can warn and continue the
// cycle rather than crashing the loop.

import {
	checkMainUpToDate,
	commitTreeToMain,
	pushMainBestEffort,
	type SpawnFn,
} from '../git/on-main.ts';
import { aggregateCycleMetrics, serializeCycleMetrics, type CycleMetricsRow } from '../stats/cycles.ts';

// Re-export SpawnFn so callers do not need to reach into src/git/on-main.ts directly.
export type { SpawnFn };

/** Git-relative path of the cycle-metrics artifact, read/written on main only. */
export const CYCLE_METRICS_JSONL_PATH = 'scripts/cam/cycle-metrics.jsonl';

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Read raw cycle-metrics.jsonl content from main via `git show`. A missing
 * file on main (non-zero exit -- no seeding story exists for this artifact)
 * is treated as an empty store rather than a structured error, so the first
 * successful write bootstraps the file.
 */
export function readCycleMetricsContentFromMain(cwd: string, spawnFn: SpawnFn): string {
	const showResult = spawnFn('git', ['-C', cwd, 'show', 'main:scripts/cam/cycle-metrics.jsonl'], {
		encoding: 'utf8',
	});
	if ((showResult.status ?? 1) !== 0) {
		return '';
	}
	return showResult.stdout ?? '';
}

// ---------------------------------------------------------------------------
// In-place row upsert (mirrors appendOutcomeToLine, src/commands/pattern-records.ts:338-369)
// ---------------------------------------------------------------------------

/** True when `parsed` is a plain object carrying a `cycleId` field equal to `cycleId`. */
function isRowForCycle(parsed: unknown, cycleId: string): boolean {
	return (
		typeof parsed === 'object' &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		(parsed as Record<string, unknown>)['cycleId'] === cycleId
	);
}

/**
 * Replace `content`'s ONE line whose `cycleId` field matches `row.cycleId`
 * with `JSON.stringify(row)`. Every other line -- including blank lines and
 * lines that fail to parse as JSON (the header line never matches: it has no
 * `cycleId` field) -- is pushed back byte-for-byte. When no line matches
 * (this cycleId has no row yet), the new line is appended at the end
 * instead, still never disturbing any existing line.
 */
function upsertRowIntoContent(content: string, row: CycleMetricsRow): string {
	const rawLines = content.split('\n');
	let found = false;
	const kept: string[] = [];
	for (const rawLine of rawLines) {
		const trimmed = rawLine.trim();
		if (trimmed.length === 0) {
			kept.push(rawLine);
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			kept.push(rawLine);
			continue;
		}

		if (!found && isRowForCycle(parsed, row.cycleId)) {
			found = true;
			kept.push(JSON.stringify(row));
			continue;
		}
		kept.push(rawLine);
	}

	const rejoined = kept.join('\n');
	if (found) {
		return rejoined;
	}
	const newLine = JSON.stringify(row);
	return rejoined.endsWith('\n') || rejoined === '' ? `${rejoined}${newLine}\n` : `${rejoined}\n${newLine}\n`;
}

// ---------------------------------------------------------------------------
// upsertCycleMetricsRowOnMain
// ---------------------------------------------------------------------------

export interface UpsertCycleMetricsRowOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Full event-log JSONL content (or null when absent), same contract as aggregateCycleMetrics. */
	eventLogJsonl: string | null;
	/** cycleId of the just-closed cycle to upsert a row for. */
	cycleId: string;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
}

export interface UpsertCycleMetricsRowOnMainCommitted {
	ok: true;
	committed: true;
	cycleId: string;
	/** true when this write bootstrapped a previously absent/empty store with a full derivation. */
	bootstrapped: boolean;
	/** Short sha (7 chars) of the new commit on main. */
	sha: string;
}

export interface UpsertCycleMetricsRowOnMainNoRow {
	ok: true;
	committed: false;
	reason: 'no-established-row';
	cycleId: string;
}

export interface UpsertCycleMetricsRowOnMainGuardError {
	ok: false;
	reason: 'diverged' | 'detached-head' | 'missing-main';
}

export interface UpsertCycleMetricsRowOnMainCommitError {
	ok: false;
	reason: 'commit-failed';
	error: string;
}

export type UpsertCycleMetricsRowOnMainResult =
	| UpsertCycleMetricsRowOnMainCommitted
	| UpsertCycleMetricsRowOnMainNoRow
	| UpsertCycleMetricsRowOnMainGuardError
	| UpsertCycleMetricsRowOnMainCommitError;

/**
 * Upsert exactly one cycle-metrics row into scripts/cam/cycle-metrics.jsonl
 * on main, in place.
 *
 * `eventLogJsonl` is aggregated once (aggregateCycleMetrics, src/stats/cycles.ts)
 * to derive the row for `cycleId`. When no bounded row exists for that
 * cycleId (its marker has no established left bound, e.g. it is the log's
 * very first marker) this returns `{ ok: true, committed: false, reason:
 * 'no-established-row' }` before any git call -- never a fabricated row.
 *
 * Otherwise:
 *   - Store absent/empty on main: bootstraps the file with the FULL
 *     derivation of `eventLogJsonl` (header + every bounded row), byte-
 *     identical to a `--rebuild` of the same log (AC3).
 *   - Store already present: replaces (or appends) ONLY the `cycleId` line,
 *     leaving every other line untouched (AC4).
 *
 * Failure modes are structured, never thrown (AC7): the up-to-date guard's
 * reasons pass straight through, and a commitTreeToMain failure is caught and
 * returned as `{ ok: false, reason: 'commit-failed', error }`.
 */
export function upsertCycleMetricsRowOnMain(
	options: UpsertCycleMetricsRowOnMainOptions,
): UpsertCycleMetricsRowOnMainResult {
	const { cwd, eventLogJsonl, cycleId, spawnFn } = options;

	// Step 1: derive the target row before any git call -- fail-fast, no
	// fabricated row, when the cycleId has no established slice yet.
	const fullResult = aggregateCycleMetrics(eventLogJsonl);
	const targetRow = fullResult.rows.find((r) => r.cycleId === cycleId);
	if (targetRow === undefined) {
		return { ok: true, committed: false, reason: 'no-established-row', cycleId };
	}

	// Step 2: up-to-date guard (shared helper, src/git/on-main.ts).
	const guard = checkMainUpToDate(cwd, spawnFn, 'append cycle-metrics row');
	if (!guard.ok) {
		return guard;
	}
	const { localMainSha } = guard;

	const commitMsg = `chore(cam): cycle-metrics upsert ${cycleId}`;

	let bootstrapped = false;
	let sha: string;
	try {
		// Step 3: commit, with a per-attempt recompute callback (US-001,
		// CAM-300 discipline): every CAS attempt re-reads the store from the
		// advanced main and re-applies the SAME bootstrap-or-upsert mutation
		// against that fresh content, so a row concurrently written by another
		// caller between this read and the winning commit survives instead of
		// being clobbered by a stale whole-file overwrite.
		sha = commitTreeToMain(
			cwd,
			(_mainSha) => {
				const freshContent = readCycleMetricsContentFromMain(cwd, spawnFn);
				bootstrapped = freshContent === '';
				const content = bootstrapped
					? serializeCycleMetrics(fullResult)
					: upsertRowIntoContent(freshContent, targetRow);
				return [{ path: CYCLE_METRICS_JSONL_PATH, content }];
			},
			commitMsg,
			localMainSha,
			spawnFn,
			'cam-cycle-metrics-',
		);
	} catch (err) {
		return { ok: false, reason: 'commit-failed', error: err instanceof Error ? err.message : String(err) };
	}

	pushMainBestEffort(cwd, spawnFn);

	return { ok: true, committed: true, cycleId, bootstrapped, sha };
}
