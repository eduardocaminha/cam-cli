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

import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, expect, describe } from 'bun:test';
import {
	aggregateCycleMetrics,
	serializeCycleMetrics,
	CYCLE_METRICS_SCHEMA_VERSION,
	type CycleMetricsRow,
} from '../../src/stats/cycles.ts';
import { runStatsCycles } from '../../src/commands/stats.ts';
import { parseStatsArgs, dispatchStats, dispatchJournal, parseJournalArgs } from '../../index.ts';
import {
	upsertCycleMetricsRowOnMain,
	readCycleMetricsContentFromMain,
} from '../../src/commands/cycle-metrics.ts';
import { realOnMainSpawnFn, type SpawnFn } from '../../src/git/on-main.ts';
import type { JournalCycleEntry } from '../../src/commands/journal.ts';
import type { ArchiveJournalOnMainResult } from '../../src/commands/journal-archive.ts';
import type { ArchivePatternsOnMainResult } from '../../src/commands/patterns-archive.ts';
import { gitAvailable } from '../helpers/test-deps.ts';

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

// ---------------------------------------------------------------------------
// serializeCycleMetrics (US-002): NDJSON artifact formatting
// ---------------------------------------------------------------------------

describe('serializeCycleMetrics', () => {
	test('one line for the header, then one line per row, in order, each valid JSON', () => {
		const log = [
			makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
			makeWorkerStartLine('w1'),
			makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't-b'),
		].join('\n');
		const result = aggregateCycleMetrics(log);

		const serialized = serializeCycleMetrics(result);
		const lines = serialized.split('\n').filter((l) => l !== '');
		expect(lines).toHaveLength(1 + result.rows.length);
		expect(JSON.parse(lines[0] as string)).toEqual(result.header);
		expect(JSON.parse(lines[1] as string)).toEqual(result.rows[0]);
		// Trailing newline: the file ends in '\n', mirroring appendFileSync conventions elsewhere.
		expect(serialized.endsWith('\n')).toBe(true);
	});

	test('re-serializing the same result twice produces byte-identical output (AC10 idempotency precondition)', () => {
		const log = [
			makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
			makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't-b'),
		].join('\n');
		const result = aggregateCycleMetrics(log);
		expect(serializeCycleMetrics(result)).toBe(serializeCycleMetrics(aggregateCycleMetrics(log)));
	});
});

// ---------------------------------------------------------------------------
// runStatsCycles (src/commands/stats.ts, US-002): I/O-wired report + sentinel
// ---------------------------------------------------------------------------

describe('runStatsCycles', () => {
	test('missing event log (readEventLog -> null): exits 0, reports no data, sentinel with zeros', () => {
		const written: string[] = [];
		const code = runStatsCycles({ readEventLog: () => null, write: (s) => written.push(s) });
		expect(code).toBe(0);
		const output = written.join('');
		expect(output).toContain('No cycle data recorded yet');
		expect(output).toContain('CAM_STATS_CYCLES=cycles=0 unattributedLeadingEvents=0');
	});

	test('renders a table row per bounded cycle plus the always-present unattributed-leading-span line', () => {
		const log = [
			makeWorkerStartLine('pre'),
			makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
			makeWorkerStartLine('w1'),
			makeReviewVerdictHandbackLine(1),
			makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't-b'),
		].join('\n');
		const written: string[] = [];
		const code = runStatsCycles({ readEventLog: () => log, write: (s) => written.push(s) });
		expect(code).toBe(0);
		const output = written.join('');

		expect(output).toContain('cam/B');
		expect(output).not.toContain('cam/A'); // AC2/AC3: the first marker publishes no row of its own.
		expect(output).toContain('Unattributed leading span: 1 event-log line(s)');

		const sentinelLines = output.split('\n').filter((l) => l.startsWith('CAM_STATS_CYCLES='));
		expect(sentinelLines).toHaveLength(1);
		expect(sentinelLines[0]).toBe('CAM_STATS_CYCLES=cycles=1 unattributedLeadingEvents=1');
	});

	test('a cycleId longer than the Cycle column still separates from Issue by at least one space (US-R1-001, CAM-470 review finding)', () => {
		// Real observed example from the committed artifact: 47 chars, wider
		// than CYCLE_COL_WIDTH (42), which used to collide directly into the
		// Issue column with zero separating space.
		const longCycleId = 'cam/CAM-94-blocked-narration-supervisor-outcomeCAM-94';
		const log = [
			makeWorkerStartLine('pre'),
			makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
			makeWorkerStartLine('w1'),
			makeCycleTokensLine(longCycleId, 'CAM-94', 2, 2, 4, 't-b'),
		].join('\n');
		const written: string[] = [];
		const code = runStatsCycles({ readEventLog: () => log, write: (s) => written.push(s) });
		expect(code).toBe(0);
		const output = written.join('');

		const row = output.split('\n').find((l) => l.includes('CAM-94'));
		expect(row).toBeDefined();
		expect(row).toMatch(/ CAM-94/); // guaranteed separator between the (truncated) cycleId and the issue column.
		expect(row).not.toContain('outcomeCAM-94'); // no direct column collision.
	});

	test('rebuild:true calls the injected writeArtifact with the serialized aggregation; rebuild:false (default) never calls it', () => {
		const log = [
			makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
			makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't-b'),
		].join('\n');

		let writtenArtifact: string | undefined;
		const codeRebuild = runStatsCycles({
			readEventLog: () => log,
			write: () => {},
			rebuild: true,
			writeArtifact: (content) => {
				writtenArtifact = content;
			},
		});
		expect(codeRebuild).toBe(0);
		expect(writtenArtifact).toBe(serializeCycleMetrics(aggregateCycleMetrics(log)));

		let calledWithoutRebuild = false;
		const codeReadOnly = runStatsCycles({
			readEventLog: () => log,
			write: () => {},
			writeArtifact: () => {
				calledWithoutRebuild = true;
			},
		});
		expect(codeReadOnly).toBe(0);
		expect(calledWithoutRebuild).toBe(false);
	});

	test('rebuild:true with a writeArtifact that throws (e.g. missing scripts/cam/ dir) exits 1 instead of letting the raw exception escape', () => {
		const log = [makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a')].join('\n');

		let thrown = false;
		let code: number | undefined;
		try {
			code = runStatsCycles({
				readEventLog: () => log,
				write: () => {},
				rebuild: true,
				writeArtifact: () => {
					throw new Error("ENOENT: no such file or directory, open 'scripts/cam/cycle-metrics.jsonl'");
				},
			});
		} catch {
			thrown = true;
		}

		expect(thrown).toBe(false); // the ENOENT must be caught, not escape as an uncaught exception.
		expect(code).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// index.ts wiring: parseStatsArgs / dispatchStats for the 'cycles' subcommand
// ---------------------------------------------------------------------------

describe('parseStatsArgs: cycles subcommand', () => {
	test('cycles (no flag) returns { mode: "cycles", help: false, rebuild: false }', () => {
		expect(parseStatsArgs(['cycles'])).toEqual({ mode: 'cycles', help: false, rebuild: false });
	});

	test('cycles --rebuild returns rebuild: true', () => {
		expect(parseStatsArgs(['cycles', '--rebuild'])).toEqual({ mode: 'cycles', help: false, rebuild: true });
	});
});

describe('dispatchStats: cycles subcommand', () => {
	test('cycles mode delegates to statsCyclesFn with the parsed rebuild flag', () => {
		const parsed = parseStatsArgs(['cycles', '--rebuild']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		let receivedRebuild: boolean | undefined;
		const code = dispatchStats(parsed, {
			statsCyclesFn: (rebuild) => {
				receivedRebuild = rebuild;
				return 0;
			},
		});
		expect(code).toBe(0);
		expect(receivedRebuild).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Committed artifact sanity (US-002): unlike the event log, the artifact
// itself IS git-tracked, so this check always runs (no skipIf).
// ---------------------------------------------------------------------------

const ARTIFACT_PATH = join(import.meta.dir, '..', '..', 'scripts', 'cam', 'cycle-metrics.jsonl');

describe('scripts/cam/cycle-metrics.jsonl: committed backfill sanity', () => {
	test('every line parses as JSON, the first line is the header, no row ever carries a gates field', () => {
		const content = readFileSync(ARTIFACT_PATH, 'utf8');
		const lines = content.split('\n').filter((l) => l !== '');
		expect(lines.length).toBeGreaterThan(1);

		const header = JSON.parse(lines[0] as string) as { schemaVersion?: unknown; unattributedLeadingEvents?: unknown };
		expect(header.schemaVersion).toBe(CYCLE_METRICS_SCHEMA_VERSION);
		expect(typeof header.unattributedLeadingEvents).toBe('number');

		for (const line of lines.slice(1)) {
			expect(line).not.toContain('"gates"');
			const row = JSON.parse(line) as Record<string, unknown>;
			expect(typeof row['cycleId']).toBe('string');
			if ('prNumber' in row) expect(row['prNumber']).not.toBeNull();
			if ('mergeMode' in row) expect(row['mergeMode']).not.toBe('unknown');
		}
	});
});

// ---------------------------------------------------------------------------
// upsertCycleMetricsRowOnMain (src/commands/cycle-metrics.ts, US-003 of
// CAM-470): real-temp-git-repo integration tests (test-quality convention --
// hit real I/O at the wire boundary, not a tautological argv-recording mock).
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];

afterEach(() => {
	for (const d of dirsToCleanup) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	dirsToCleanup.length = 0;
});

interface RepoHandles {
	dir: string;
	run: (args: string[]) => SpawnSyncReturns<string>;
}

/** A real, remote-less temp git repo checked out on `main` (mirrors test/commands/pattern-records.ts's makeTmpRepo). */
function makeTmpRepo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-cycle-metrics-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);
	run(['commit', '--allow-empty', '-m', 'chore: initial harness state']);

	return { dir, run };
}

describe('upsertCycleMetricsRowOnMain: bootstrap-on-first-append (AC3)', () => {
	test.skipIf(!gitAvailable)(
		'store absent on main: first write bootstraps a full derivation, byte-identical to a --rebuild of the same log',
		() => {
			const { dir } = makeTmpRepo();
			const log = [
				makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't-a'),
				makeWorkerStartLine('w1'),
				makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't-b'),
			].join('\n');

			const result = upsertCycleMetricsRowOnMain({
				cwd: dir,
				eventLogJsonl: log,
				cycleId: 'cam/B',
				spawnFn: realOnMainSpawnFn,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			if (!result.committed) throw new Error('expected a commit to land');
			expect(result.bootstrapped).toBe(true);

			const stored = readCycleMetricsContentFromMain(dir, realOnMainSpawnFn);
			expect(stored).toBe(serializeCycleMetrics(aggregateCycleMetrics(log)));
		},
	);
});

describe('upsertCycleMetricsRowOnMain: in-place upsert (AC4)', () => {
	test.skipIf(!gitAvailable)(
		'replaces the matching cycleId line in its original slot; blank lines, malformed lines, and other rows survive byte-for-byte',
		() => {
			const { dir, run } = makeTmpRepo();

			const headerLine = JSON.stringify({ schemaVersion: CYCLE_METRICS_SCHEMA_VERSION, unattributedLeadingEvents: 0 });
			const oldRowX = JSON.stringify({
				cycleId: 'cam/X',
				issueNumber: 'CAM-X',
				closedAt: 't-old',
				workerRounds: 1,
				reviewRounds: 0,
				orchTokens: 1,
				workerTokens: 1,
				total: 2,
			});
			const rowY = JSON.stringify({
				cycleId: 'cam/Y',
				issueNumber: 'CAM-Y',
				closedAt: 't-y',
				workerRounds: 0,
				reviewRounds: 0,
				orchTokens: 5,
				workerTokens: 5,
				total: 10,
			});
			const malformedLine = '{not valid json';
			// Deliberately includes a blank line and an unparseable line, mirroring
			// appendOutcomeToLine's fixture shape (test/commands/pattern-records.test.ts).
			const seedContent = `${headerLine}\n\n${malformedLine}\n${oldRowX}\n${rowY}\n`;

			mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
			writeFileSync(join(dir, 'scripts', 'cam', 'cycle-metrics.jsonl'), seedContent);
			run(['add', 'scripts/cam/cycle-metrics.jsonl']);
			run(['commit', '-m', 'test: seed cycle-metrics store']);

			const prev = makeCycleTokensLine('cam/prev', 'CAM-PREV', 0, 0, 0, 't-prev');
			const marker = makeCycleTokensLine('cam/X', 'CAM-X', 9, 9, 18, 't-new');
			const log = [prev, marker].join('\n');

			const result = upsertCycleMetricsRowOnMain({
				cwd: dir,
				eventLogJsonl: log,
				cycleId: 'cam/X',
				spawnFn: realOnMainSpawnFn,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			if (!result.committed) throw new Error('expected a commit to land');
			expect(result.bootstrapped).toBe(false);

			const newRowX = JSON.stringify(aggregateCycleMetrics(log).rows.find((r) => r.cycleId === 'cam/X'));
			const expected = `${headerLine}\n\n${malformedLine}\n${newRowX}\n${rowY}\n`;
			expect(readCycleMetricsContentFromMain(dir, realOnMainSpawnFn)).toBe(expected);
		},
	);
});

describe("upsertCycleMetricsRowOnMain: 'the incremental cycle-close upsert produces a file byte-identical to a full rebuild'", () => {
	test.skipIf(!gitAvailable)(
		'applying the incremental writer once per marker over a fixture log yields exactly the bytes a single full derivation of that same log produces',
		() => {
			const { dir } = makeTmpRepo();

			const m0 = makeCycleTokensLine('cam/only-first', 'CAM-0', 0, 0, 0, 't0'); // no established left bound
			const m1 = makeCycleTokensLine('cam/A', 'CAM-A', 1, 1, 2, 't1');
			const m2 = makeCycleTokensLine('cam/B', 'CAM-B', 2, 2, 4, 't2');
			const m3 = makeCycleTokensLine('cam/A', 'CAM-A', 3, 3, 6, 't3'); // merges back into cam/A (AC3/F-07)

			const logAfterM0 = [m0].join('\n');
			const logAfterM1 = [m0, m1].join('\n');
			const logAfterM2 = [m0, m1, m2].join('\n');
			const fullLog = [m0, m1, m2, m3].join('\n');

			// One incremental call per marker, each seeing only the log available
			// AT THAT MOMENT (the event log only ever grows), exactly mirroring how
			// the US-004 caller will drive this at real cycle-close time.
			const r0 = upsertCycleMetricsRowOnMain({
				cwd: dir,
				eventLogJsonl: logAfterM0,
				cycleId: 'cam/only-first',
				spawnFn: realOnMainSpawnFn,
			});
			expect(r0.ok).toBe(true);
			if (r0.ok) expect(r0.committed).toBe(false); // no established row yet -- nothing to commit

			const r1 = upsertCycleMetricsRowOnMain({
				cwd: dir,
				eventLogJsonl: logAfterM1,
				cycleId: 'cam/A',
				spawnFn: realOnMainSpawnFn,
			});
			expect(r1.ok).toBe(true);
			if (r1.ok && r1.committed) expect(r1.bootstrapped).toBe(true);

			const r2 = upsertCycleMetricsRowOnMain({
				cwd: dir,
				eventLogJsonl: logAfterM2,
				cycleId: 'cam/B',
				spawnFn: realOnMainSpawnFn,
			});
			expect(r2.ok).toBe(true);
			if (r2.ok && r2.committed) expect(r2.bootstrapped).toBe(false);

			const r3 = upsertCycleMetricsRowOnMain({
				cwd: dir,
				eventLogJsonl: fullLog,
				cycleId: 'cam/A',
				spawnFn: realOnMainSpawnFn,
			});
			expect(r3.ok).toBe(true);

			const stored = readCycleMetricsContentFromMain(dir, realOnMainSpawnFn);
			expect(stored).toBe(serializeCycleMetrics(aggregateCycleMetrics(fullLog)));
		},
	);
});

describe('upsertCycleMetricsRowOnMain: no established left bound (AC6)', () => {
	test.skipIf(!gitAvailable)(
		'a log whose only marker is the first one yields a header with zero rows, not a fabricated head row',
		() => {
			const { dir } = makeTmpRepo();
			const log = [makeWorkerStartLine('w1'), makeCycleTokensLine('cam/only', 'CAM-1', 10, 5, 15, 't1')].join('\n');

			const result = upsertCycleMetricsRowOnMain({
				cwd: dir,
				eventLogJsonl: log,
				cycleId: 'cam/only',
				spawnFn: realOnMainSpawnFn,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.committed).toBe(false);
			if (result.committed) return;
			expect(result.reason).toBe('no-established-row');

			// No commit ever fired: the store is still absent from main.
			expect(readCycleMetricsContentFromMain(dir, realOnMainSpawnFn)).toBe('');
		},
	);
});

describe('upsertCycleMetricsRowOnMain: structured failure modes, never a throw (AC7)', () => {
	const log = [
		makeCycleTokensLine('cam/prev', 'CAM-PREV', 0, 0, 0, 't-prev'),
		makeCycleTokensLine('cam/target', 'CAM-TARGET', 1, 1, 2, 't-target'),
	].join('\n');

	test.skipIf(!gitAvailable)('detached HEAD: returns { ok: false, reason: "detached-head" }, no throw', () => {
		const { dir, run } = makeTmpRepo();
		const mainSha = run(['rev-parse', 'main']).stdout.trim();
		run(['checkout', '--detach', mainSha]);

		let result: ReturnType<typeof upsertCycleMetricsRowOnMain> | undefined;
		expect(() => {
			result = upsertCycleMetricsRowOnMain({ cwd: dir, eventLogJsonl: log, cycleId: 'cam/target', spawnFn: realOnMainSpawnFn });
		}).not.toThrow();

		expect(result?.ok).toBe(false);
		if (!result || result.ok) return;
		expect(result.reason).toBe('detached-head');
	});

	test.skipIf(!gitAvailable)('missing local main branch: returns { ok: false, reason: "missing-main" }, no throw', () => {
		const { dir, run } = makeTmpRepo();
		run(['branch', '-m', 'main', 'renamed-away']);

		let result: ReturnType<typeof upsertCycleMetricsRowOnMain> | undefined;
		expect(() => {
			result = upsertCycleMetricsRowOnMain({ cwd: dir, eventLogJsonl: log, cycleId: 'cam/target', spawnFn: realOnMainSpawnFn });
		}).not.toThrow();

		expect(result?.ok).toBe(false);
		if (!result || result.ok) return;
		expect(result.reason).toBe('missing-main');
	});

	test.skipIf(!gitAvailable)(
		'commitTreeToMain CAS-exhaustion: returns { ok: false, reason: "commit-failed", error }, no throw',
		() => {
			const { dir } = makeTmpRepo();

			// Wrap the real spawnFn so every `update-ref` call is rejected -- forces
			// commitTreeToMain to exhaust CAS_MAX_ATTEMPTS and throw internally; the
			// writer must catch that throw and surface it as a structured result.
			const casAlwaysFailsSpawnFn: SpawnFn = (cmd, args, opts) => {
				if (cmd === 'git' && args.includes('update-ref')) {
					return {
						stdout: '',
						stderr: 'simulated CAS rejection',
						status: 1,
						pid: 1,
						output: [],
						signal: null,
					} as SpawnSyncReturns<string>;
				}
				return realOnMainSpawnFn(cmd, args, opts);
			};

			let result: ReturnType<typeof upsertCycleMetricsRowOnMain> | undefined;
			expect(() => {
				result = upsertCycleMetricsRowOnMain({
					cwd: dir,
					eventLogJsonl: log,
					cycleId: 'cam/target',
					spawnFn: casAlwaysFailsSpawnFn,
				});
			}).not.toThrow();

			expect(result?.ok).toBe(false);
			if (!result || result.ok) return;
			expect(result.reason).toBe('commit-failed');
			if (result.reason === 'commit-failed') {
				expect(result.error.length).toBeGreaterThan(0);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// AC5 (US-004, CAM-470): one cycle-close appends exactly one row with no
// manual intervention -- drives the FULL `cam journal append --cycle-close`
// path (dispatchJournal, index.ts) against a real fixture repo, wiring
// cycleMetricsAppendFn to the real upsertCycleMetricsRowOnMain. Every other
// side effect (journal.md write, archive checks, recycle marker) is faked so
// this test isolates the cycle-metrics artifact growth.
// ---------------------------------------------------------------------------

describe("dispatchJournal --cycle-close: 'one cycle-close appends exactly one row with no manual intervention' (AC5)", () => {
	test.skipIf(!gitAvailable)(
		'driving one cycle-close against a fixture repo grows the artifact by exactly one row and leaves every prior line byte-identical',
		async () => {
			const { dir } = makeTmpRepo();

			const headerLine = JSON.stringify({ schemaVersion: CYCLE_METRICS_SCHEMA_VERSION, unattributedLeadingEvents: 0 });
			const rowY = JSON.stringify({
				cycleId: 'cam/Y',
				issueNumber: 'CAM-Y',
				closedAt: 't-y',
				workerRounds: 0,
				reviewRounds: 0,
				orchTokens: 5,
				workerTokens: 5,
				total: 10,
			});
			const seedContent = `${headerLine}\n${rowY}\n`;
			mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
			writeFileSync(join(dir, 'scripts', 'cam', 'cycle-metrics.jsonl'), seedContent);
			spawnSync('git', ['-C', dir, 'add', 'scripts/cam/cycle-metrics.jsonl'], { stdio: 'pipe', encoding: 'utf8' });
			spawnSync('git', ['-C', dir, 'commit', '-m', 'test: seed cycle-metrics store'], { stdio: 'pipe', encoding: 'utf8' });

			const prevMarker = makeCycleTokensLine('cam/prev-close', 'CAM-PREV', 0, 0, 0, 't-prev');
			const closeMarker = makeCycleTokensLine('cam/US-004-close', 'CAM-470', 3, 4, 7, 't-close');
			const log = [prevMarker, closeMarker].join('\n');

			const entry: JournalCycleEntry = {
				cycleId: 'cam/US-004-close',
				title: 'one cycle-close appends exactly one row',
				started: '2026-07-29',
				closed: '2026-07-29',
				branch: 'cam/issue-470',
				issue: 'CAM-470',
				outcome: 'shipped',
				summary: 'AC5 fixture-repo drive of dispatchJournal --cycle-close.',
			};

			const parsed = parseJournalArgs(['append', '--cycle-close']);
			expect(parsed).not.toBeNull();
			if (!parsed || parsed.help) return;

			const code = await dispatchJournal(parsed, {
				readStdin: async () => JSON.stringify(entry),
				appendFn: () => ({ ok: true, cycleId: entry.cycleId, sha: 'fakejournalsha' }), // journal.md write is out of scope for this test
				writeStdout: () => {},
				recordCycleTokensFn: () => {}, // avoid real transcript/event-log I/O
				handoffExistsFn: () => true,
				watcherAliveFn: () => true,
				archiveFn: (): ArchiveJournalOnMainResult => ({ ok: true, archived: 0, entries: 0, sha: '' }),
				patternsArchiveFn: (): ArchivePatternsOnMainResult => ({ ok: true, archived: 0, sha: '' }),
				cycleMetricsAppendFn: (cycleId) =>
					upsertCycleMetricsRowOnMain({ cwd: dir, eventLogJsonl: log, cycleId, spawnFn: realOnMainSpawnFn }),
				armRecycleMarkerFn: () => {}, // no real marker file I/O in this test
			});

			expect(code).toBe(0);

			const newRow = JSON.stringify(aggregateCycleMetrics(log).rows.find((r) => r.cycleId === 'cam/US-004-close'));
			const expectedContent = `${headerLine}\n${rowY}\n${newRow}\n`;
			const storedContent = readCycleMetricsContentFromMain(dir, realOnMainSpawnFn);
			expect(storedContent).toBe(expectedContent);

			// Exactly one row grew: 2 pre-existing lines (header + rowY) -> 3.
			const seedLineCount = seedContent.split('\n').filter((l) => l !== '').length;
			const storedLineCount = storedContent.split('\n').filter((l) => l !== '').length;
			expect(storedLineCount).toBe(seedLineCount + 1);

			// Every prior line survives byte-identical, in its original position.
			const storedLines = storedContent.split('\n').filter((l) => l !== '');
			expect(storedLines[0]).toBe(headerLine);
			expect(storedLines[1]).toBe(rowY);
		},
	);
});
