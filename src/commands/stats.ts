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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

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
