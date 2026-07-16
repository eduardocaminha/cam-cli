// src/stats/split-advisory.ts
//
// Pure heuristic: given historical { jobSize, total } records (one per past
// issue, its WSJF jobSize joined with its aggregate token total), decide
// whether an issue of a given jobSize is likely to run hot enough to warrant
// a plan-time split advisory.
//
// jobSize is the WSJF job-size scale (IssueEntry.wsjf.jobSize, see
// src/issues/types.ts): a small discrete scale (e.g. 1/2/3/5/8/13). This
// module buckets historical records by exact jobSize match; it does not read
// the event log, issue files, or wsjf itself -- the caller (US-004, the plan
// runner) is responsible for building the `records` array by joining
// cycle-tokens per-issue totals (src/stats/tokens.ts) with each issue's
// jobSize.
//
// No I/O, no config: the 1.5x threshold multiplier and the exact-jobSize
// bucketing are code constants (project.toml is never read here, per PRD
// AC-4 -- this heuristic is not meant to be operator-tunable yet).
//
// CAM-241/136 (US-003): split-advisory heuristic + event kind. Emission at
// plan-time is a separate story (US-004).

/** One historical (jobSize, total-tokens) observation from a past issue's cycle. */
export interface HistoricalJobSizeRecord {
	jobSize: number;
	total: number;
}

/** The current issue's jobSize plus how many stories the plan just generated for it. */
export interface SplitAdvisoryInput {
	jobSize: number;
	storyCount: number;
}

/** Result of the split-advisory heuristic. `advisory` is the fire/no-fire decision. */
export interface SplitAdvisoryResult {
	advisory: boolean;
	/** storyCount echoed back so a caller building a note has it without re-threading input. */
	storyCount: number;
	/** Projected tokens for this issue: the historical mean of the same-jobSize bucket. */
	projectedTokens: number;
	bucketMean: number;
	bucketMedian: number;
	/** Number of historical records folded into this jobSize's bucket. */
	bucketSize: number;
}

/**
 * Multiplier applied to a jobSize bucket's median to decide if a projection
 * is "hot" enough to advise a split. Code constant per PRD AC-4: no
 * project.toml knob.
 */
const SPLIT_ADVISORY_THRESHOLD_MULTIPLIER = 1.5;

/** Median of a numeric array (0 for an empty array). All index access is guarded (noUncheckedIndexedAccess). */
function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[mid] ?? 0;
	}
	const lo = sorted[mid - 1] ?? 0;
	const hi = sorted[mid] ?? 0;
	return (lo + hi) / 2;
}

/** Bucket historical records by exact jobSize match. */
function bucketFor(records: HistoricalJobSizeRecord[], jobSize: number): number[] {
	return records.filter((r) => r.jobSize === jobSize).map((r) => r.total);
}

/**
 * Compute the split advisory for `input.jobSize` against `records`.
 *
 * - projectedTokens is the historical mean of the same-jobSize bucket.
 * - advisory fires only when projectedTokens exceeds
 *   SPLIT_ADVISORY_THRESHOLD_MULTIPLIER (~1.5x) times the bucket's median.
 * - No-data (empty bucket) always returns advisory:false, never a division
 *   or a spurious fire.
 */
export function computeSplitAdvisory(
	records: HistoricalJobSizeRecord[],
	input: SplitAdvisoryInput,
): SplitAdvisoryResult {
	const bucket = bucketFor(records, input.jobSize);
	if (bucket.length === 0) {
		return {
			advisory: false,
			storyCount: input.storyCount,
			projectedTokens: 0,
			bucketMean: 0,
			bucketMedian: 0,
			bucketSize: 0,
		};
	}

	const bucketMean = bucket.reduce((a, b) => a + b, 0) / bucket.length;
	const bucketMedian = median(bucket);
	const projectedTokens = bucketMean;
	const advisory = bucketMedian > 0 && projectedTokens > bucketMedian * SPLIT_ADVISORY_THRESHOLD_MULTIPLIER;

	return {
		advisory,
		storyCount: input.storyCount,
		projectedTokens,
		bucketMean,
		bucketMedian,
		bucketSize: bucket.length,
	};
}
