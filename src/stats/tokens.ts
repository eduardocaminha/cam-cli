// src/stats/tokens.ts
//
// Pure module: turns the event-log JSONL content into per-issue token
// rollups plus global mean/median tokens-per-issue. No I/O -- string in,
// data out (readable by both the report and the token-budget advisory).
//
// Attribution is driven exclusively by the 'cycle-tokens' event
// (CycleTokensEventDetail.issueNumber, src/supervisor/events.ts). Raw
// 'tokens' events carry only storyId + uuid (no issue key, TokensEventDetail)
// and are never grouped by issue directly; the 'tokens' event schema is not
// touched here. Raw 'tokens' spend is only used to compute the total
// unattributed spend (see UNATTRIBUTED below).
//
// Parsing mirrors the tolerant readers in src/commands/journal.ts
// (defaultReadEventLog / findLastCycleTokensIdx / extractTokensFromLine):
// malformed/partial JSONL lines are skipped rather than throwing.
//
// CAM-241/136 (US-001): per-issue token stats for the report + advisory.
//
// CAM-328 (US-002): orchTokens aggregation is marker-aware
// (CycleTokensEventDetail.orchTokensMode, src/supervisor/events.ts). Delta-mode
// events are summed directly; legacy (marker-absent) cumulative-snapshot
// events are collapsed per issue via max, not summed -- see
// applyCycleTokensDetail/IssueAccumulator below. Every rollup's `total` is
// always recomputed from the collapsed/summed orchTokens plus summed
// workerTokens, never by summing the stored per-cycle `total` field.

/** Coerce an unknown JSON value to a number (0 if not a number). */
function toN(v: unknown): number {
	return typeof v === 'number' ? v : 0;
}

/** Per-issue token rollup, aggregated across every 'cycle-tokens' event recorded for that issue. */
export interface IssueTokenRollup {
	issueNumber: string;
	orchTokens: number;
	workerTokens: number;
	total: number;
	/** Number of 'cycle-tokens' events (cycles) folded into this rollup. */
	cycleCount: number;
}

/** Aggregate result: per-issue rollups plus global stats. */
export interface TokensPerIssueSummary {
	/** One rollup per distinct detail.issueNumber, in first-seen order. */
	perIssue: IssueTokenRollup[];
	/** Mean of perIssue[].total (0 when perIssue is empty). */
	meanTokensPerIssue: number;
	/** Median of perIssue[].total (0 when perIssue is empty). */
	medianTokensPerIssue: number;
	/**
	 * Raw 'tokens' event spend not attributed to any issue: the total raw
	 * 'tokens' spend across the whole log minus the workerTokens already
	 * attributed by 'cycle-tokens' events. This is a distinct field rather
	 * than a silent drop or a fold into a per-issue bucket; it covers both
	 * the trailing in-flight cycle (no closing marker yet) and any cycle
	 * that closed without emitting a 'cycle-tokens' marker at all. Clamped
	 * to 0 (never negative) as a defensive guard against malformed logs.
	 */
	unattributedTokens: number;
}

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

/** Total tokens carried by one raw 'tokens' event detail (0 for missing/non-numeric fields). */
function rawTokensTotal(detail: Record<string, unknown>): number {
	return (
		toN(detail['inputTokens']) +
		toN(detail['outputTokens']) +
		toN(detail['cacheReadTokens']) +
		toN(detail['cacheCreationTokens'])
	);
}

/** Median of a numeric array (0 for an empty array). All index access is guarded. */
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

/**
 * In-progress per-issue accumulator. `orchTokens` is split into a delta sum
 * (marker-mode 'delta' events, summed directly) and a legacy max (marker-absent
 * cumulative-snapshot events, collapsed via max rather than summed -- see
 * applyCycleTokensDetail). `total` is never accumulated from the stored
 * per-cycle field; it is recomputed once at collection time.
 */
interface IssueAccumulator {
	issueNumber: string;
	orchTokensDeltaSum: number;
	orchTokensLegacyMax: number;
	workerTokens: number;
	cycleCount: number;
}

/** Mutable in-progress state threaded through one aggregation pass. */
interface AggregationState {
	order: string[];
	byIssue: Map<string, IssueAccumulator>;
	totalRawTokens: number;
	attributedWorkerTokens: number;
}

/** Fold one raw 'tokens' event detail into the running unattributed-candidate total. */
function applyTokensDetail(state: AggregationState, detail: Record<string, unknown>): void {
	state.totalRawTokens += rawTokensTotal(detail);
}

/**
 * Fold one 'cycle-tokens' event detail into its issue's accumulator (creating
 * it on first sight). Branches on `orchTokensMode` (CycleTokensEventDetail,
 * src/supervisor/events.ts): a 'delta' marker means `orchTokens` is a
 * per-cycle delta and is summed directly; an absent marker means a legacy
 * (pre-US-001) cumulative snapshot, which is collapsed per issue via max
 * (the best-effort monotonic final cumulative -- there is no
 * orchestrator-session id on the event to group by more precisely).
 * `workerTokens` always sums per-cycle regardless of mode.
 */
function applyCycleTokensDetail(state: AggregationState, detail: Record<string, unknown>): void {
	const issueNumber = detail['issueNumber'];
	if (typeof issueNumber !== 'string' || issueNumber === '') return;

	const orchTokens = toN(detail['orchTokens']);
	const workerTokens = toN(detail['workerTokens']);
	const isDelta = detail['orchTokensMode'] === 'delta';

	state.attributedWorkerTokens += workerTokens;

	const existing = state.byIssue.get(issueNumber);
	if (existing === undefined) {
		state.order.push(issueNumber);
		state.byIssue.set(issueNumber, {
			issueNumber,
			orchTokensDeltaSum: isDelta ? orchTokens : 0,
			orchTokensLegacyMax: isDelta ? 0 : orchTokens,
			workerTokens,
			cycleCount: 1,
		});
		return;
	}
	if (isDelta) {
		existing.orchTokensDeltaSum += orchTokens;
	} else {
		existing.orchTokensLegacyMax = Math.max(existing.orchTokensLegacyMax, orchTokens);
	}
	existing.workerTokens += workerTokens;
	existing.cycleCount += 1;
}

/** Parse and dispatch one trimmed, non-empty JSONL line into `state`. Malformed lines are no-ops. */
function applyLine(state: AggregationState, raw: string): void {
	const parsed = parseLine(raw);
	if (parsed === null) return;
	const detail = asDetailRecord(parsed.detail);
	if (detail === null) return;

	if (parsed.kind === 'tokens') {
		applyTokensDetail(state, detail);
	} else if (parsed.kind === 'cycle-tokens') {
		applyCycleTokensDetail(state, detail);
	}
}

/**
 * Project the accumulated map into an ordered array, first-seen order.
 * `orchTokens` is recomputed here (legacy max + delta sum) and `total` is
 * recomputed from that plus `workerTokens` -- never by summing the stored
 * per-cycle `total` field.
 */
function collectPerIssue(state: AggregationState): IssueTokenRollup[] {
	const perIssue: IssueTokenRollup[] = [];
	for (const issueNumber of state.order) {
		const acc = state.byIssue.get(issueNumber);
		if (acc === undefined) continue;
		const orchTokens = acc.orchTokensLegacyMax + acc.orchTokensDeltaSum;
		const total = orchTokens + acc.workerTokens;
		perIssue.push({ issueNumber, orchTokens, workerTokens: acc.workerTokens, total, cycleCount: acc.cycleCount });
	}
	return perIssue;
}

/**
 * Aggregate the event-log JSONL content into per-issue token rollups plus
 * global mean/median tokens-per-issue.
 *
 * `eventLogJsonl` is the raw file content, or null when the log is absent
 * (mirroring the readEventLog contract in src/commands/journal.ts). Pure:
 * no filesystem access, no mutation of its input.
 */
export function aggregateTokensPerIssue(eventLogJsonl: string | null): TokensPerIssueSummary {
	if (eventLogJsonl === null) {
		return { perIssue: [], meanTokensPerIssue: 0, medianTokensPerIssue: 0, unattributedTokens: 0 };
	}

	const state: AggregationState = {
		order: [],
		byIssue: new Map(),
		totalRawTokens: 0,
		attributedWorkerTokens: 0,
	};

	for (const line of eventLogJsonl.split('\n')) {
		const trimmed = line.trim();
		if (trimmed) applyLine(state, trimmed);
	}

	const perIssue = collectPerIssue(state);
	const totals = perIssue.map((r) => r.total);
	const meanTokensPerIssue = totals.length === 0 ? 0 : totals.reduce((a, b) => a + b, 0) / totals.length;
	const medianTokensPerIssue = median(totals);
	const unattributedTokens = Math.max(0, state.totalRawTokens - state.attributedWorkerTokens);

	return { perIssue, meanTokensPerIssue, medianTokensPerIssue, unattributedTokens };
}
