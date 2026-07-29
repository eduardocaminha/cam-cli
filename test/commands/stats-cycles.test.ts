// test/commands/stats-cycles.test.ts
//
// Unit tests for aggregateCycleMetrics (src/stats/cycles.ts, US-001 of CAM-470).
//
// Pure module: no filesystem I/O. All inputs are inline JSONL strings, plus
// one conditional sanity check against the repo's own real event log.
//
// Named per acceptance criterion (US-001):
//   AC2 (F-01, ADR-0053): events before the FIRST marker publish no row.
//   AC3 (F-07): two markers sharing a cycleId merge into ONE row, aggregates summed.
//   AC4: reviewRounds is a DISTINCT-round count, not an event count.
//   AC5: no shipped result -> absent prNumber/mergeMode keys; no row ever carries a gates field.
//   AC6: deterministic header, byte-identical re-serialization.
//   AC7: tolerant parsing of malformed/partial lines.
//
// US-002/US-003/US-004 (later stories in this same PRD) extend this file with
// CLI-level and on-main-writer tests; this file stays scoped to the pure
// aggregation module for US-001.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, describe } from 'bun:test';
import { aggregateCycleMetrics, CYCLE_METRICS_SCHEMA_VERSION, type CycleMetricsRow } from '../../src/stats/cycles.ts';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Build a 'worker-start' event JSONL line. */
function makeWorkerStartLine(uuid: string): string {
	return JSON.stringify({
		ts: '2026-01-01T00:00:00.000Z',
		storyId: 'US-001',
		uuid,
		kind: 'worker-start',
		detail: { mode: 'sentinel' },
	});
}

/** Build a 'cycle-tokens' marker JSONL line. */
function makeCycleTokensLine(
	cycleId: string,
	issueNumber: string,
	orchTokens: number,
	workerTokens: number,
	total: number,
	recordedAt: string,
): string {
	return JSON.stringify({
		ts: recordedAt,
		uuid: 'cycle-close',
		kind: 'cycle-tokens',
		detail: { cycleId, issueNumber, orchTokens, workerTokens, total, recordedAt },
	});
}

/** Build a 'review-verdict-handback' event JSONL line carrying a given round. */
function makeReviewVerdictHandbackLine(round: number): string {
	return JSON.stringify({
		ts: '2026-01-01T00:00:00.000Z',
		storyId: 'US-001',
		uuid: 'reviewer',
		kind: 'review-verdict-handback',
		detail: { verdict: `FIXES_PENDING:1`, round },
	});
}

/** Build a 'ship-phase-result' JSONL line for the 'shipped' variant (detail.kind SHADOWS the envelope kind). */
function makeShippedLine(prNumber: number, mergeMode: 'immediate' | 'ci-gated'): string {
	return JSON.stringify({
		ts: '2026-01-01T00:00:00.000Z',
		storyId: undefined,
		uuid: 'ship',
		kind: 'ship-phase-result',
		detail: { kind: 'shipped', prNumber, mergeMode },
	});
}

/** Build a non-shipped 'ship-phase-result' JSONL line (must never contribute prNumber/mergeMode). */
function makeNonShippedShipPhaseLine(): string {
	return JSON.stringify({
		ts: '2026-01-01T00:00:00.000Z',
		storyId: undefined,
		uuid: 'ship',
		kind: 'ship-phase-result',
		detail: { kind: 'gates-failed', outputTail: 'boom' },
	});
}

// ---------------------------------------------------------------------------
// Base contract
// ---------------------------------------------------------------------------

describe('aggregateCycleMetrics: base contract', () => {
	test('null event log -> header with schemaVersion + zero unattributedLeadingEvents, no rows', () => {
		const result = aggregateCycleMetrics(null);
		expect(result.header).toEqual({ schemaVersion: CYCLE_METRICS_SCHEMA_VERSION, unattributedLeadingEvents: 0 });
		expect(result.rows).toEqual([]);
	});

	test('a log with exactly one marker (no established left bound) publishes zero rows', () => {
		const log = [makeWorkerStartLine('w1'), makeCycleTokensLine('cam/only', 'CAM-1', 10, 5, 15, 't1')].join('\n');
		const result = aggregateCycleMetrics(log);
		expect(result.rows).toEqual([]);
		// AC1: zero filesystem access -- this module never imports node:fs/Bun.file/Bun.write.
	});
});

// ---------------------------------------------------------------------------
// AC2 (F-01, ADR-0053): unattributed leading span
// ---------------------------------------------------------------------------

describe('aggregateCycleMetrics: AC2 (F-01) unattributed leading span', () => {
	test('events preceding the FIRST marker publish no row for that marker cycleId, and are disclosed via unattributedLeadingEvents', () => {
		const leading = [makeWorkerStartLine('pre-1'), makeWorkerStartLine('pre-2'), makeWorkerStartLine('pre-3')];
		const markerA = makeCycleTokensLine('cam/A-cycle', 'CAM-A', 1, 1, 2, 't-a');
		const markerB = makeCycleTokensLine('cam/B-cycle', 'CAM-B', 3, 3, 6, 't-b');
		const log = [...leading, markerA, markerB].join('\n');

		const result = aggregateCycleMetrics(log);

		// The marker A's leading span (3 pre-instrumentation events) is disclosed,
		// not folded into any row.
		expect(result.header.unattributedLeadingEvents).toBe(3);
		// Only B (bounded by A) publishes a row; A itself never does.
		expect(result.rows.map((r) => r.cycleId)).toEqual(['cam/B-cycle']);
	});
});

// ---------------------------------------------------------------------------
// AC3 (F-07): duplicate-cycleId merge
// ---------------------------------------------------------------------------

describe('aggregateCycleMetrics: AC3 (F-07) duplicate-cycleId merge', () => {
	test('two bounded markers sharing one cycleId merge into ONE row, aggregates summed, position at the first bounded marker', () => {
		const m0 = makeCycleTokensLine('cam/X', 'CAM-X', 0, 0, 0, 't0'); // first marker: no row of its own
		const slice1Events = [makeWorkerStartLine('w1'), makeWorkerStartLine('w2'), makeReviewVerdictHandbackLine(1)];
		const m1 = makeCycleTokensLine('cam/X', 'CAM-X', 10, 5, 15, 't1'); // bounded by m0, cycleId X
		const slice2Events = [
			makeWorkerStartLine('w3'),
			makeWorkerStartLine('w4'),
			makeWorkerStartLine('w5'),
			makeReviewVerdictHandbackLine(2),
		];
		const m2 = makeCycleTokensLine('cam/X', 'CAM-X', 20, 8, 28, 't2'); // bounded by m1, cycleId X again
		// A distinct cycle in between two other issues, to prove ordering is
		// unaffected by an interleaved different cycleId.
		const other = makeCycleTokensLine('cam/Y', 'CAM-Y', 1, 1, 2, 't-y');

		const log = [m0, ...slice1Events, m1, ...slice2Events, m2, other].join('\n');
		const result = aggregateCycleMetrics(log);

		expect(result.rows.map((r) => r.cycleId)).toEqual(['cam/X', 'cam/Y']);
		const rowX = result.rows[0] as CycleMetricsRow;
		expect(rowX.workerRounds).toBe(5); // 2 + 3, summed across both merged slices
		expect(rowX.reviewRounds).toBe(2); // distinct rounds {1, 2}
		expect(rowX.orchTokens).toBe(30); // 10 + 20
		expect(rowX.workerTokens).toBe(13); // 5 + 8
		expect(rowX.total).toBe(43); // 15 + 28
		expect(rowX.closedAt).toBe('t2'); // the LAST merged marker's recordedAt
	});
});

// ---------------------------------------------------------------------------
// AC4: reviewRounds is a distinct-round count
// ---------------------------------------------------------------------------

describe('aggregateCycleMetrics: AC4 reviewRounds counts DISTINCT rounds', () => {
	test('5 review-verdict-handback events carrying rounds [1,1,2,2,2] yield reviewRounds 2, not 5', () => {
		const prev = makeCycleTokensLine('cam/prev', 'CAM-PREV', 0, 0, 0, 't-prev');
		const events = [1, 1, 2, 2, 2].map((round) => makeReviewVerdictHandbackLine(round));
		const marker = makeCycleTokensLine('cam/target', 'CAM-TARGET', 1, 1, 2, 't-target');
		const log = [prev, ...events, marker].join('\n');

		const result = aggregateCycleMetrics(log);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.reviewRounds).toBe(2);
		expect(result.rows[0]?.reviewRounds).not.toBe(5);
	});
});

// ---------------------------------------------------------------------------
// AC5: absent-key contract for prNumber/mergeMode, and no gates field ever
// ---------------------------------------------------------------------------

describe('aggregateCycleMetrics: AC5 shipped-only prNumber/mergeMode, never a gates field', () => {
	test('a slice with no shipped ship-phase-result omits prNumber/mergeMode as ABSENT KEYS, never null/unknown', () => {
		const prev = makeCycleTokensLine('cam/prev', 'CAM-PREV', 0, 0, 0, 't-prev');
		const marker = makeCycleTokensLine('cam/no-ship', 'CAM-NS', 1, 1, 2, 't-ns');
		const log = [prev, makeNonShippedShipPhaseLine(), marker].join('\n');

		const result = aggregateCycleMetrics(log);
		const row = result.rows[0] as CycleMetricsRow;

		expect('prNumber' in row).toBe(false);
		expect('mergeMode' in row).toBe(false);
		expect('gates' in row).toBe(false);
		// Absent, not null and not the string 'unknown' -- serialize and check literally.
		const serialized = JSON.stringify(row);
		expect(serialized).not.toContain('prNumber');
		expect(serialized).not.toContain('mergeMode');
		expect(serialized).not.toContain('unknown');
	});

	test('a slice WITH a shipped ship-phase-result carries prNumber + mergeMode', () => {
		const prev = makeCycleTokensLine('cam/prev', 'CAM-PREV', 0, 0, 0, 't-prev');
		const marker = makeCycleTokensLine('cam/shipped', 'CAM-SH', 1, 1, 2, 't-sh');
		const log = [prev, makeShippedLine(123, 'ci-gated'), marker].join('\n');

		const result = aggregateCycleMetrics(log);
		const row = result.rows[0] as CycleMetricsRow;

		expect(row.prNumber).toBe(123);
		expect(row.mergeMode).toBe('ci-gated');
		expect('gates' in row).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC6: deterministic header, byte-identical re-serialization
// ---------------------------------------------------------------------------

describe('aggregateCycleMetrics: AC6 deterministic header + byte-identical rebuild', () => {
	test('header carries schemaVersion + unattributedLeadingEvents and nothing else (no wall-clock field)', () => {
		const log = [
			makeWorkerStartLine('w1'),
			makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
			makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't-b'),
		].join('\n');

		const result = aggregateCycleMetrics(log);
		expect(Object.keys(result.header).sort()).toEqual(['schemaVersion', 'unattributedLeadingEvents']);
	});

	test('serializing the same log content twice produces byte-identical output', () => {
		const log = [
			makeWorkerStartLine('w1'),
			makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
			makeReviewVerdictHandbackLine(1),
			makeShippedLine(9, 'immediate'),
			makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't-b'),
		].join('\n');

		const first = JSON.stringify(aggregateCycleMetrics(log));
		const second = JSON.stringify(aggregateCycleMetrics(log));
		expect(first).toBe(second);
	});
});

// ---------------------------------------------------------------------------
// AC7: tolerant parsing
// ---------------------------------------------------------------------------

describe('aggregateCycleMetrics: AC7 tolerant reader', () => {
	test('malformed/partial JSONL lines are skipped, not thrown on, and do not corrupt real rows', () => {
		const log = [
			'not json at all',
			'{"kind":"cycle-tokens"', // truncated JSON
			'',
			makeWorkerStartLine('w1'),
			'{"kind":"cycle-tokens","detail":{}}', // valid JSON, but no cycleId -> skipped
			makeCycleTokensLine('cam/real', 'CAM-REAL', 5, 5, 10, 't-real'),
			makeCycleTokensLine('cam/real2', 'CAM-REAL2', 6, 6, 12, 't-real2'),
		].join('\n');

		expect(() => aggregateCycleMetrics(log)).not.toThrow();
		const result = aggregateCycleMetrics(log);
		expect(result.rows.map((r) => r.cycleId)).toEqual(['cam/real2']);
	});

	test('a log of only garbage yields a header with zero rows', () => {
		const log = ['not json', '{"broken":', '[]', 'null', '42'].join('\n');
		const result = aggregateCycleMetrics(log);
		expect(result.header).toEqual({ schemaVersion: CYCLE_METRICS_SCHEMA_VERSION, unattributedLeadingEvents: 0 });
		expect(result.rows).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Real-log sanity check (test-quality convention: hit real fixtures plus at
// least one assertion against the repo's own log content when convenient).
// The event log is gitignored (.gitignore:73), so a fresh checkout may not
// have one -- skip cleanly rather than fail CI on an absent local artifact.
// ---------------------------------------------------------------------------

const REAL_LOG_PATH = join(import.meta.dir, '..', '..', '.claude', 'cam-worker-events.jsonl');
const realLogExists = existsSync(REAL_LOG_PATH);

describe('aggregateCycleMetrics: real-log sanity', () => {
	test.skipIf(!realLogExists)(
		'unattributedLeadingEvents matches an independently-computed first-marker line index on the real log',
		() => {
			const content = readFileSync(REAL_LOG_PATH, 'utf8');
			const lines = content.split('\n');
			const independentFirstMarkerIndex = lines.findIndex((line) => {
				if (line.trim() === '') return false;
				try {
					const parsed = JSON.parse(line) as { kind?: unknown; detail?: unknown };
					return (
						parsed.kind === 'cycle-tokens' &&
						typeof parsed.detail === 'object' &&
						parsed.detail !== null &&
						typeof (parsed.detail as Record<string, unknown>)['cycleId'] === 'string' &&
						(parsed.detail as Record<string, unknown>)['cycleId'] !== ''
					);
				} catch {
					return false;
				}
			});

			const result = aggregateCycleMetrics(content);
			expect(result.header.unattributedLeadingEvents).toBe(independentFirstMarkerIndex);
			// Sanity on row shape: every real row respects the never-null/never-unknown contract.
			for (const row of result.rows) {
				expect(JSON.stringify(row)).not.toContain('"gates"');
			}
		},
	);
});
