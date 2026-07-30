// src/commands/stats.ts
//
// `cam stats tokens` (CAM-241/136 US-002): reads the event log
// (.claude/cam-worker-events.jsonl), aggregates per-issue token spend via the
// US-001 pure aggregation module (src/stats/tokens.ts, aggregateTokensPerIssue),
// and renders a human-readable report plus one machine-parseable summary line:
//
//   CAM_STATS_TOKENS=issues=<N> mean=<mean> median=<median> unattributed=<unattributed>
//
// Mirrors the I/O-wiring shape of src/commands/orch-budget.ts: injectable
// cwd / readEventLog / write, and always exits 0 -- a missing or empty event
// log is "no data yet", not an error.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { aggregateCycleMetrics, serializeCycleMetrics, type CycleMetricsRow } from '../stats/cycles.ts';
import { aggregateTokensPerIssue, type IssueTokenRollup } from '../stats/tokens.ts';

export interface RunStatsTokensOptions {
	/** Project root (default: process.cwd()). */
	cwd?: string;
	/**
	 * Injectable: read the event log JSONL content. Default: reads
	 * join(cwd, '.claude', 'cam-worker-events.jsonl') via readFileSync,
	 * returning null when absent/unreadable (mirrors defaultReadEventLog in
	 * src/commands/journal.ts).
	 */
	readEventLog?: () => string | null;
	/** Output writer (default: process.stdout.write). Injected for tests. */
	write?: (s: string) => void;
}

/** Default readEventLog: real fs read, null on missing/unreadable file. */
function defaultReadEventLog(cwd: string): string | null {
	const path = join(cwd, '.claude', 'cam-worker-events.jsonl');
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

/** Format a number for display: integers print bare; fractional means/medians round to 1 decimal. */
function fmt(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const ISSUE_WIDTH = 14;
const COL_WIDTH = 10;

/** Render the per-issue orch/worker/total/cycles table (empty perIssue is handled by the caller). */
function renderTable(perIssue: IssueTokenRollup[]): string {
	const header =
		'Issue'.padEnd(ISSUE_WIDTH) +
		'Orch'.padStart(COL_WIDTH) +
		'Worker'.padStart(COL_WIDTH) +
		'Total'.padStart(COL_WIDTH) +
		'Cycles'.padStart(COL_WIDTH);
	const rows = perIssue.map(
		(r) =>
			r.issueNumber.padEnd(ISSUE_WIDTH) +
			fmt(r.orchTokens).padStart(COL_WIDTH) +
			fmt(r.workerTokens).padStart(COL_WIDTH) +
			fmt(r.total).padStart(COL_WIDTH) +
			String(r.cycleCount).padStart(COL_WIDTH),
	);
	return [header, ...rows].join('\n');
}

/** Implementation of `cam stats tokens`. Returns the process exit code (always 0). */
export function runStatsTokens(options: RunStatsTokensOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const readEventLog = options.readEventLog ?? (() => defaultReadEventLog(cwd));
	const write =
		options.write ??
		((s: string) => {
			process.stdout.write(s);
		});

	const summary = aggregateTokensPerIssue(readEventLog());

	const lines: string[] = [];
	if (summary.perIssue.length === 0) {
		lines.push('No token data recorded yet (.claude/cam-worker-events.jsonl is missing or empty).');
	} else {
		lines.push(renderTable(summary.perIssue));
		lines.push('');
		lines.push(`Mean tokens/issue: ${fmt(summary.meanTokensPerIssue)}`);
		lines.push(`Median tokens/issue: ${fmt(summary.medianTokensPerIssue)}`);
	}

	lines.push('');
	// AC4: flag unattributed spend rather than silently dropping or
	// misattributing it -- this is a distinct line, always printed, never
	// folded into any issue's row above.
	if (summary.unattributedTokens > 0) {
		lines.push(
			`Unattributed spend: ${fmt(summary.unattributedTokens)} tokens recorded by raw 'tokens' events with no matching 'cycle-tokens' issue marker yet (e.g. an in-flight cycle, or one that closed without emitting a marker). Not dropped and not folded into any issue's total above -- flagged here instead.`,
		);
	} else {
		lines.push('Unattributed spend: 0 tokens.');
	}

	// AC5: state the orch-vs-worker formula asymmetry explicitly, and that
	// totals are used as recorded, not recomputed from transcripts.
	lines.push(
		"Note: the orch component of a cycle-tokens total excludes output tokens (input + cacheCreation + cacheRead only, per recordCycleTokens in src/commands/journal.ts); the worker component includes all four fields (input + output + cacheCreation + cacheRead). All totals above are used exactly as recorded in the event log, not recomputed from transcripts.",
	);

	write(`${lines.join('\n')}\n`);
	write(
		`CAM_STATS_TOKENS=issues=${summary.perIssue.length} mean=${fmt(summary.meanTokensPerIssue)} median=${fmt(summary.medianTokensPerIssue)} unattributed=${fmt(summary.unattributedTokens)}\n`,
	);
	return 0;
}

// ---------------------------------------------------------------------------
// `cam stats cycles` (CAM-470 US-002)
// ---------------------------------------------------------------------------

/** Path of the committed cycle-metrics artifact, relative to the project root. */
const CYCLE_METRICS_ARTIFACT_REL_PATH = ['scripts', 'cam', 'cycle-metrics.jsonl'];

export interface RunStatsCyclesOptions {
	/** Project root (default: process.cwd()). */
	cwd?: string;
	/**
	 * Injectable: read the event log JSONL content. Default: reads
	 * join(cwd, '.claude', 'cam-worker-events.jsonl') via readFileSync,
	 * returning null when absent/unreadable (mirrors runStatsTokens above).
	 */
	readEventLog?: () => string | null;
	/** Output writer (default: process.stdout.write). Injected for tests. */
	write?: (s: string) => void;
	/**
	 * When true, regenerate scripts/cam/cycle-metrics.jsonl from the event
	 * log (the explicit write path, AC10). Default: false (read-only report,
	 * mirroring runStatsTokens's always-read-only contract).
	 */
	rebuild?: boolean;
	/**
	 * Injectable artifact writer, only invoked when `rebuild` is true.
	 * Default: writeFileSync to join(cwd, ...CYCLE_METRICS_ARTIFACT_REL_PATH).
	 */
	writeArtifact?: (content: string) => void;
}

const CYCLE_COL_WIDTH = 42;
const CYCLE_ISSUE_WIDTH = 12;
const CYCLE_NUM_COL_WIDTH = 10;

/**
 * Left-pad-safe column cell: `cycleId` is an OPAQUE free-form string (a
 * branch name) with no length ceiling, unlike `issueNumber`, so it can meet
 * or exceed `CYCLE_COL_WIDTH` on real data (observed up to 47 chars against a
 * 42-char column). `String.padEnd` only ever ADDS padding -- it never
 * truncates -- so a value already at or past `width` collides directly with
 * the next column with zero separating space. Truncate to `width - 1` chars
 * first (reserving one guaranteed separator column) so `padEnd(width)` always
 * emits at least one space, mirroring the CAM-217 renderHelp gotcha
 * (patterns.md) applied here to a table column instead of a help entry name.
 */
function truncateForColumn(value: string, width: number): string {
	return value.length >= width ? value.slice(0, width - 1) : value;
}

/** Render the per-cycle worker/review-round/total table (empty rows handled by the caller). */
function renderCyclesTable(rows: CycleMetricsRow[]): string {
	const header =
		'Cycle'.padEnd(CYCLE_COL_WIDTH) +
		'Issue'.padEnd(CYCLE_ISSUE_WIDTH) +
		'WkrRounds'.padStart(CYCLE_NUM_COL_WIDTH) +
		'RevRounds'.padStart(CYCLE_NUM_COL_WIDTH) +
		'Total'.padStart(CYCLE_NUM_COL_WIDTH);
	const body = rows.map(
		(r) =>
			truncateForColumn(r.cycleId, CYCLE_COL_WIDTH).padEnd(CYCLE_COL_WIDTH) +
			r.issueNumber.padEnd(CYCLE_ISSUE_WIDTH) +
			String(r.workerRounds).padStart(CYCLE_NUM_COL_WIDTH) +
			String(r.reviewRounds).padStart(CYCLE_NUM_COL_WIDTH) +
			String(r.total).padStart(CYCLE_NUM_COL_WIDTH),
	);
	return [header, ...body].join('\n');
}

/** Default writeArtifact: real fs write to the committed artifact path. */
function defaultWriteArtifact(cwd: string): (content: string) => void {
	return (content: string) => {
		writeFileSync(join(cwd, ...CYCLE_METRICS_ARTIFACT_REL_PATH), content, 'utf8');
	};
}

/**
 * Implementation of `cam stats cycles`. Always exits 0 -- a missing/empty
 * event log or a log with no bounded cycle (fewer than two 'cycle-tokens'
 * markers) is "no data yet", not an error, mirroring runStatsTokens. Prints
 * the human-readable report plus one machine-parseable summary line
 * (CAM_STATS_CYCLES=...). When `rebuild` is set, additionally regenerates the
 * committed artifact (scripts/cam/cycle-metrics.jsonl) from the same
 * aggregation (AC10).
 */
export function runStatsCycles(options: RunStatsCyclesOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const readEventLog = options.readEventLog ?? (() => defaultReadEventLog(cwd));
	const write =
		options.write ??
		((s: string) => {
			process.stdout.write(s);
		});

	const result = aggregateCycleMetrics(readEventLog());

	const lines: string[] = [];
	if (result.rows.length === 0) {
		lines.push(
			'No cycle data recorded yet (.claude/cam-worker-events.jsonl is missing, empty, or has fewer than two \'cycle-tokens\' markers).',
		);
	} else {
		lines.push(renderCyclesTable(result.rows));
	}

	lines.push('');
	// AC6: disclose the unattributed leading span explicitly -- an
	// always-present line, never folded into any row and never silently
	// dropped when zero (ADR-0053, mirrors the AC4 unattributed-spend line
	// in runStatsTokens above).
	lines.push(
		`Unattributed leading span: ${result.header.unattributedLeadingEvents} event-log line(s) before the first 'cycle-tokens' marker (no established left bound, so not published as a cycle).`,
	);

	write(`${lines.join('\n')}\n`);
	// AC9: machine-parseable line mirroring CAM_STATS_TOKENS= above.
	write(`CAM_STATS_CYCLES=cycles=${result.rows.length} unattributedLeadingEvents=${result.header.unattributedLeadingEvents}\n`);

	if (options.rebuild) {
		const writeArtifact = options.writeArtifact ?? defaultWriteArtifact(cwd);
		writeArtifact(serializeCycleMetrics(result));
	}

	return 0;
}
