// src/stats/cycles.ts
//
// Pure module: turns the event-log JSONL content into one deterministic row
// per bounded cycle slice, plus a header disclosing the schema version and
// the unattributed leading span. No filesystem access -- string in, data out
// (mirrors src/stats/tokens.ts).
//
// Slice rule (ADR-0053: docs/adr/0053-cycle-metrics-attribute-only-bounded-
// slices-and-disclose-the-unattributed-leading-span.md): a slice runs from
// the event AFTER the previous 'cycle-tokens' marker THROUGH the current
// marker. The FIRST marker in the log has no established left bound and
// publishes NO row; the leading span (every physical event-log line before
// that first marker) is disclosed instead, as header.unattributedLeadingEvents,
// exactly mirroring how src/stats/tokens.ts keeps unattributedTokens as a
// distinct, always-present field rather than folding it into (or silently
// dropping it from) the first published row.
//
// Parsing mirrors the tolerant readers in src/stats/tokens.ts (and
// src/commands/journal.ts): malformed/partial JSONL lines are skipped rather
// than thrown on.
//
// CAM-470 (US-001): the pure derivation module. Rendering (`cam stats
// cycles`) and the versioned artifact (scripts/cam/cycle-metrics.jsonl) are
// out of scope here -- see US-002/US-003/US-004.

import type { MergeMode } from '../config/models.ts';

/** Bump when the row/header shape changes in a way a reader must know about. */
export const CYCLE_METRICS_SCHEMA_VERSION = 1;

/**
 * Header line: schema version plus the disclosed unattributed leading span.
 * Deterministic by construction -- no wall-clock or other nondeterministic
 * field, so the same log content always serializes to byte-identical output.
 */
export interface CycleMetricsHeader {
	schemaVersion: number;
	/**
	 * Count of physical event-log lines before the FIRST 'cycle-tokens'
	 * marker (0 when the log has no marker at all -- there is no first
	 * marker for the span to be "before").
	 */
	unattributedLeadingEvents: number;
}

/**
 * One row per bounded cycle slice (ADR-0053). `prNumber`/`mergeMode` are
 * present ONLY when the slice contains a 'shipped' ship-phase-result --
 * absent keys otherwise, never null and never 'unknown'. No row carries any
 * quality-gate field: buildResultDetail (src/supervisor/events.ts) records
 * gates as 'unknown' for every non-pass outcome (open defect CAM-444), and
 * this schema does not read 'result' events at all, so it cannot inherit
 * that defect.
 */
export interface CycleMetricsRow {
	cycleId: string;
	issueNumber: string;
	/**
	 * The marker's recordedAt. When two or more markers share a cycleId
	 * (AC3/F-07), this is the LAST merged marker's recordedAt -- the cycle
	 * did not actually close until then.
	 */
	closedAt: string;
	/** Count of 'worker-start' events in the slice. */
	workerRounds: number;
	/** Count of DISTINCT detail.round values across 'review-verdict-handback' events in the slice. */
	reviewRounds: number;
	/** The marker's orchTokens, used exactly as recorded (CycleTokensEventDetail, src/supervisor/events.ts:421-431). */
	orchTokens: number;
	/** The marker's workerTokens, used exactly as recorded. */
	workerTokens: number;
	/** The marker's total, used exactly as recorded. */
	total: number;
	prNumber?: number;
	mergeMode?: MergeMode;
}

/** Aggregate result: the header plus one row per attributed cycle, in first-seen order. */
export interface CycleMetricsResult {
	header: CycleMetricsHeader;
	rows: CycleMetricsRow[];
}

// ---------------------------------------------------------------------------
// Tolerant line parsing (mirrors src/stats/tokens.ts:69-83)
// ---------------------------------------------------------------------------

interface ParsedEventLine {
	kind?: unknown;
	detail?: unknown;
}

/** Parse one JSONL line into a shallow { kind, detail } shape. Returns null for malformed lines. */
function parseLine(raw: string): ParsedEventLine | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
		return parsed as ParsedEventLine;
	} catch {
		return null;
	}
}

/** Narrow an unknown `detail` value to a plain record, or null when it is not one. */
function asDetailRecord(detail: unknown): Record<string, unknown> | null {
	if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
	return detail as Record<string, unknown>;
}

/** Coerce an unknown JSON value to a number (0 if not a number). */
function toN(v: unknown): number {
	return typeof v === 'number' ? v : 0;
}

/** Coerce an unknown JSON value to a string ('' if not a string). */
function toS(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Internal per-line shapes
// ---------------------------------------------------------------------------

/** One successfully-parsed 'cycle-tokens' marker, plus its physical line index (0-based). */
interface Marker {
	lineIndex: number;
	cycleId: string;
	issueNumber: string;
	orchTokens: number;
	workerTokens: number;
	total: number;
	recordedAt: string;
}

/** One successfully-parsed 'shipped' ship-phase-result, plus its physical line index. */
interface ShippedEvent {
	lineIndex: number;
	prNumber: number;
	mergeMode: MergeMode;
}

/** One review round observation: a 'review-verdict-handback' event's line index and detail.round. */
interface ReviewRound {
	lineIndex: number;
	round: number;
}

/** Everything one tolerant parse pass extracts from the log, indexed by physical line. */
interface ParsedLog {
	markers: Marker[];
	workerStartLineIndexes: number[];
	reviewRounds: ReviewRound[];
	shippedEvents: ShippedEvent[];
}

/** Push a 'cycle-tokens' detail onto `markers`, skipping one with no cycleId. */
function tryAddCycleTokensMarker(markers: Marker[], lineIndex: number, detail: Record<string, unknown>): void {
	const cycleId = toS(detail['cycleId']);
	if (cycleId === '') return;
	markers.push({
		lineIndex,
		cycleId,
		issueNumber: toS(detail['issueNumber']),
		orchTokens: toN(detail['orchTokens']),
		workerTokens: toN(detail['workerTokens']),
		total: toN(detail['total']),
		recordedAt: toS(detail['recordedAt']),
	});
}

/** Push a 'review-verdict-handback' detail's round onto `reviewRounds`, skipping a non-numeric round. */
function tryAddReviewRound(reviewRounds: ReviewRound[], lineIndex: number, detail: Record<string, unknown>): void {
	const round = detail['round'];
	if (typeof round === 'number') reviewRounds.push({ lineIndex, round });
}

/**
 * Push a 'ship-phase-result' detail onto `shippedEvents`, but ONLY the
 * 'shipped' variant (detail.kind SHADOWS the envelope's own
 * 'ship-phase-result' kind at the emit site, src/commands/sidecar.ts:1342-1348);
 * every other ShipPhaseResult kind is skipped.
 */
function tryAddShippedEvent(shippedEvents: ShippedEvent[], lineIndex: number, detail: Record<string, unknown>): void {
	if (detail['kind'] !== 'shipped') return;
	const prNumber = detail['prNumber'];
	const mergeMode = detail['mergeMode'];
	if (typeof prNumber !== 'number' || typeof mergeMode !== 'string') return;
	shippedEvents.push({ lineIndex, prNumber, mergeMode: mergeMode as MergeMode });
}

/** Dispatch one successfully-parsed { kind, detail } line into `state`, by kind. */
function applyParsedLine(state: ParsedLog, lineIndex: number, parsed: ParsedEventLine): void {
	if (parsed.kind === 'worker-start') {
		state.workerStartLineIndexes.push(lineIndex);
		return;
	}

	const detail = asDetailRecord(parsed.detail);
	if (detail === null) return;

	if (parsed.kind === 'cycle-tokens') {
		tryAddCycleTokensMarker(state.markers, lineIndex, detail);
	} else if (parsed.kind === 'review-verdict-handback') {
		tryAddReviewRound(state.reviewRounds, lineIndex, detail);
	} else if (parsed.kind === 'ship-phase-result') {
		tryAddShippedEvent(state.shippedEvents, lineIndex, detail);
	}
}

/**
 * One parse pass over every physical line. Malformed/partial JSON lines are
 * skipped rather than thrown on (tolerant-reader contract, src/stats/tokens.ts:14-16).
 *
 * `lineIndex` is the 0-based physical line position within `eventLogJsonl.split('\n')`,
 * kept regardless of whether a line parses -- this is what
 * `unattributedLeadingEvents` counts against, so a malformed line still
 * occupies a line position even though it contributes no event.
 */
function parseLog(eventLogJsonl: string): ParsedLog {
	const state: ParsedLog = { markers: [], workerStartLineIndexes: [], reviewRounds: [], shippedEvents: [] };

	const lines = eventLogJsonl.split('\n');
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const raw = lines[lineIndex] ?? '';
		if (raw.trim() === '') continue;
		const parsed = parseLine(raw);
		if (parsed === null) continue;
		applyParsedLine(state, lineIndex, parsed);
	}

	return state;
}

// ---------------------------------------------------------------------------
// Slice aggregation
// ---------------------------------------------------------------------------

/** Count values in `sortedIndexes` (ascending) that fall within (loExclusive, hiInclusive]. */
function countInRange(sortedIndexes: number[], loExclusive: number, hiInclusive: number): number {
	let n = 0;
	for (const idx of sortedIndexes) {
		if (idx > loExclusive && idx <= hiInclusive) n++;
	}
	return n;
}

/** One bounded slice's aggregate, before cross-marker cycleId merging (AC3/F-07). */
interface SliceAggregate {
	marker: Marker;
	workerRounds: number;
	reviewRoundSet: Set<number>;
	shipped: ShippedEvent | undefined;
}

/** The distinct detail.round values, within (loExclusive, hiInclusive], across `reviewRounds`. */
function reviewRoundSetInRange(reviewRounds: ReviewRound[], loExclusive: number, hiInclusive: number): Set<number> {
	const set = new Set<number>();
	for (const rr of reviewRounds) {
		if (rr.lineIndex > loExclusive && rr.lineIndex <= hiInclusive) set.add(rr.round);
	}
	return set;
}

/** The LAST shipped event within (loExclusive, hiInclusive], or undefined when none falls in range. */
function shippedInRange(
	shippedEvents: ShippedEvent[],
	loExclusive: number,
	hiInclusive: number,
): ShippedEvent | undefined {
	let shipped: ShippedEvent | undefined;
	for (const s of shippedEvents) {
		if (s.lineIndex > loExclusive && s.lineIndex <= hiInclusive) shipped = s;
	}
	return shipped;
}

/**
 * Build one aggregate per bounded marker: every marker except the first
 * (ADR-0053 -- the first marker has no established left bound and
 * contributes no slice of its own, only the right bound of the next one).
 */
function buildSliceAggregates(parsed: ParsedLog): SliceAggregate[] {
	const slices: SliceAggregate[] = [];
	for (let i = 1; i < parsed.markers.length; i++) {
		const marker = parsed.markers[i];
		const prevMarker = parsed.markers[i - 1];
		if (marker === undefined || prevMarker === undefined) continue;
		const lo = prevMarker.lineIndex;
		const hi = marker.lineIndex;

		slices.push({
			marker,
			workerRounds: countInRange(parsed.workerStartLineIndexes, lo, hi),
			reviewRoundSet: reviewRoundSetInRange(parsed.reviewRounds, lo, hi),
			shipped: shippedInRange(parsed.shippedEvents, lo, hi),
		});
	}
	return slices;
}

/** In-progress merge state for one cycleId (AC3/F-07). */
interface RowAccumulator {
	cycleId: string;
	issueNumber: string;
	closedAt: string;
	workerRounds: number;
	reviewRounds: Set<number>;
	orchTokens: number;
	workerTokens: number;
	total: number;
	shipped: ShippedEvent | undefined;
}

/**
 * Merge slice aggregates sharing a cycleId into one row each (AC3/F-07): the
 * row's position in the returned array is the FIRST bounded slice's order
 * (first-seen insertion order, mirroring the `order` array in
 * src/stats/tokens.ts); workerRounds/orchTokens/workerTokens/total sum across
 * every merged slice; reviewRounds unions the distinct round sets before
 * counting; closedAt tracks the LAST merged slice's recordedAt (the cycle did
 * not actually close until then); prNumber/mergeMode carry over from
 * whichever merged slice shipped (the latest one, if more than one did).
 */
function mergeSlices(slices: SliceAggregate[]): CycleMetricsRow[] {
	const order: string[] = [];
	const byCycle = new Map<string, RowAccumulator>();

	for (const slice of slices) {
		const { cycleId } = slice.marker;
		const existing = byCycle.get(cycleId);
		if (existing === undefined) {
			order.push(cycleId);
			byCycle.set(cycleId, {
				cycleId,
				issueNumber: slice.marker.issueNumber,
				closedAt: slice.marker.recordedAt,
				workerRounds: slice.workerRounds,
				reviewRounds: new Set(slice.reviewRoundSet),
				orchTokens: slice.marker.orchTokens,
				workerTokens: slice.marker.workerTokens,
				total: slice.marker.total,
				shipped: slice.shipped,
			});
			continue;
		}
		existing.closedAt = slice.marker.recordedAt;
		existing.workerRounds += slice.workerRounds;
		for (const round of slice.reviewRoundSet) existing.reviewRounds.add(round);
		existing.orchTokens += slice.marker.orchTokens;
		existing.workerTokens += slice.marker.workerTokens;
		existing.total += slice.marker.total;
		if (slice.shipped !== undefined) existing.shipped = slice.shipped;
	}

	return order.map((cycleId) => {
		const acc = byCycle.get(cycleId);
		/* c8 ignore next -- unreachable: cycleId always came from an entry just inserted into byCycle above. */
		if (acc === undefined) throw new Error(`unreachable: missing cycle-metrics accumulator for ${cycleId}`);
		const row: CycleMetricsRow = {
			cycleId: acc.cycleId,
			issueNumber: acc.issueNumber,
			closedAt: acc.closedAt,
			workerRounds: acc.workerRounds,
			reviewRounds: acc.reviewRounds.size,
			orchTokens: acc.orchTokens,
			workerTokens: acc.workerTokens,
			total: acc.total,
		};
		if (acc.shipped !== undefined) {
			row.prNumber = acc.shipped.prNumber;
			row.mergeMode = acc.shipped.mergeMode;
		}
		return row;
	});
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Aggregate the event-log JSONL content into a deterministic cycle-metrics
 * header + rows (ADR-0053).
 *
 * `eventLogJsonl` is the raw file content, or null when the log is absent
 * (mirrors the readEventLog contract in src/stats/tokens.ts /
 * src/commands/journal.ts). Pure: no filesystem access, no mutation of its
 * input, no wall-clock field -- the same input always serializes to
 * byte-identical output.
 */
export function aggregateCycleMetrics(eventLogJsonl: string | null): CycleMetricsResult {
	if (eventLogJsonl === null) {
		return { header: { schemaVersion: CYCLE_METRICS_SCHEMA_VERSION, unattributedLeadingEvents: 0 }, rows: [] };
	}

	const parsed = parseLog(eventLogJsonl);
	const firstMarker = parsed.markers[0];
	const unattributedLeadingEvents = firstMarker === undefined ? 0 : firstMarker.lineIndex;

	const slices = buildSliceAggregates(parsed);
	const rows = mergeSlices(slices);

	return { header: { schemaVersion: CYCLE_METRICS_SCHEMA_VERSION, unattributedLeadingEvents }, rows };
}

/**
 * Serialize a CycleMetricsResult into the NDJSON artifact format written to
 * scripts/cam/cycle-metrics.jsonl (US-002): one JSON line for the header,
 * followed by one JSON line per row, in `rows` order (first-seen order of
 * each cycleId's first bounded marker). Pure formatting -- no filesystem
 * access. Deterministic given a deterministic `result`, which is exactly
 * what AC10 (re-running `--rebuild` on a clean tree leaves the tracked file
 * byte-identical) depends on.
 */
export function serializeCycleMetrics(result: CycleMetricsResult): string {
	const lines: unknown[] = [result.header, ...result.rows];
	return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}
