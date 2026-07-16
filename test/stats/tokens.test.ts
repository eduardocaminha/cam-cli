// test/stats/tokens.test.ts
//
// Unit tests for aggregateTokensPerIssue (US-001 of CAM-136/241).
//
// Pure module: no filesystem I/O. All inputs are inline JSONL strings.

import { test, expect } from 'bun:test';
import { aggregateTokensPerIssue } from '../../src/stats/tokens.ts';

/** Build a raw 'tokens' event JSONL line (no issue key, matches TokensEventDetail). */
function makeTokensLine(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens: number,
	cacheCreationTokens: number,
): string {
	return JSON.stringify({
		ts: '2026-01-01T00:00:00.000Z',
		storyId: 'US-001',
		uuid: 'worker-uuid',
		kind: 'tokens',
		detail: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
	});
}

/** Build a 'cycle-tokens' marker JSONL line, attributed to issueNumber. */
function makeCycleTokensLine(
	issueNumber: string,
	orchTokens: number,
	workerTokens: number,
	total: number,
): string {
	return JSON.stringify({
		ts: '2026-01-01T01:00:00.000Z',
		uuid: 'cycle-close',
		kind: 'cycle-tokens',
		detail: {
			cycleId: `cam/${issueNumber}-cycle`,
			issueNumber,
			orchTokens,
			workerTokens,
			total,
			recordedAt: '2026-01-01T01:00:00.000Z',
		},
	});
}

// ---------------------------------------------------------------------------
// AC1: per-issue orch/worker/total rollups + global mean/median
// ---------------------------------------------------------------------------

test('null event log -> empty summary, all zeros', () => {
	const result = aggregateTokensPerIssue(null);
	expect(result.perIssue).toEqual([]);
	expect(result.meanTokensPerIssue).toBe(0);
	expect(result.medianTokensPerIssue).toBe(0);
	expect(result.unattributedTokens).toBe(0);
});

test('empty string event log -> empty summary', () => {
	const result = aggregateTokensPerIssue('');
	expect(result.perIssue).toEqual([]);
	expect(result.meanTokensPerIssue).toBe(0);
	expect(result.medianTokensPerIssue).toBe(0);
});

test('single cycle-tokens event produces one per-issue rollup', () => {
	const log = makeCycleTokensLine('CAM-100', 1000, 500, 1500);
	const result = aggregateTokensPerIssue(log);

	expect(result.perIssue).toHaveLength(1);
	expect(result.perIssue[0]).toEqual({
		issueNumber: 'CAM-100',
		orchTokens: 1000,
		workerTokens: 500,
		total: 1500,
		cycleCount: 1,
	});
});

test('multiple issues: rollups kept separate, in first-seen order', () => {
	const log = [
		makeCycleTokensLine('CAM-100', 1000, 500, 1500),
		makeCycleTokensLine('CAM-200', 2000, 1000, 3000),
	].join('\n');
	const result = aggregateTokensPerIssue(log);

	expect(result.perIssue.map((r) => r.issueNumber)).toEqual(['CAM-100', 'CAM-200']);
	expect(result.perIssue[0]?.total).toBe(1500);
	expect(result.perIssue[1]?.total).toBe(3000);
});

test('two cycle-tokens events for the SAME issue are summed into one rollup', () => {
	const log = [
		makeCycleTokensLine('CAM-100', 1000, 500, 1500),
		makeCycleTokensLine('CAM-100', 300, 200, 500),
	].join('\n');
	const result = aggregateTokensPerIssue(log);

	expect(result.perIssue).toHaveLength(1);
	expect(result.perIssue[0]).toEqual({
		issueNumber: 'CAM-100',
		orchTokens: 1300,
		workerTokens: 700,
		total: 2000,
		cycleCount: 2,
	});
});

test('global mean and median are computed over per-issue totals', () => {
	const log = [
		makeCycleTokensLine('CAM-100', 0, 0, 100),
		makeCycleTokensLine('CAM-200', 0, 0, 200),
		makeCycleTokensLine('CAM-300', 0, 0, 300),
	].join('\n');
	const result = aggregateTokensPerIssue(log);

	expect(result.meanTokensPerIssue).toBe(200);
	expect(result.medianTokensPerIssue).toBe(200);
});

test('median averages the two middle values for an even count of issues', () => {
	const log = [
		makeCycleTokensLine('CAM-100', 0, 0, 100),
		makeCycleTokensLine('CAM-200', 0, 0, 300),
	].join('\n');
	const result = aggregateTokensPerIssue(log);

	expect(result.medianTokensPerIssue).toBe(200);
	expect(result.meanTokensPerIssue).toBe(200);
});

// ---------------------------------------------------------------------------
// AC2: raw 'tokens' events are never grouped by issue directly
// ---------------------------------------------------------------------------

test('raw tokens events alone (no cycle-tokens marker) produce no per-issue rollup', () => {
	const log = [makeTokensLine(100, 50, 0, 0), makeTokensLine(200, 0, 0, 0)].join('\n');
	const result = aggregateTokensPerIssue(log);

	expect(result.perIssue).toEqual([]);
});

test('raw tokens event detail carries no issue key and is not consulted for attribution', () => {
	// A 'tokens' line with an (illegitimate) issueNumber-shaped field must still
	// be ignored for per-issue grouping -- attribution is cycle-tokens-only.
	const rogueTokensLine = JSON.stringify({
		ts: '2026-01-01T00:00:00.000Z',
		storyId: 'US-001',
		uuid: 'worker-uuid',
		kind: 'tokens',
		detail: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, issueNumber: 'CAM-999' },
	});
	const result = aggregateTokensPerIssue(rogueTokensLine);

	expect(result.perIssue).toEqual([]);
});

// ---------------------------------------------------------------------------
// AC3: unattributed spend reported as a distinct field
// ---------------------------------------------------------------------------

test('unattributed field sums raw tokens events with no closing cycle-tokens marker', () => {
	// Prior cycle: raw tokens events (total=500) closed by the marker's workerTokens=500.
	// Trailing in-flight cycle: raw tokens events after the last marker are unattributed.
	const log = [
		makeTokensLine(500, 0, 0, 0), // total=500, attributed by the marker below
		makeCycleTokensLine('CAM-100', 1000, 500, 1500),
		makeTokensLine(100, 50, 0, 0), // total=150, in-flight, unattributed
	].join('\n');
	const result = aggregateTokensPerIssue(log);

	expect(result.perIssue[0]?.total).toBe(1500);
	expect(result.unattributedTokens).toBe(150);
});

test('unattributed is 0 when every raw tokens event is covered by a cycle-tokens workerTokens sum', () => {
	const log = [
		makeTokensLine(100, 50, 0, 0), // total=150
		makeCycleTokensLine('CAM-100', 1000, 150, 1150),
	].join('\n');
	const result = aggregateTokensPerIssue(log);

	expect(result.unattributedTokens).toBe(0);
});

test('unattributed is never negative even for a malformed/inconsistent log', () => {
	// workerTokens recorded on the marker exceeds any raw tokens spend actually present.
	const log = makeCycleTokensLine('CAM-100', 0, 999999, 999999);
	const result = aggregateTokensPerIssue(log);

	expect(result.unattributedTokens).toBe(0);
});

// ---------------------------------------------------------------------------
// AC4: malformed / partial JSONL lines are tolerated (skipped)
// ---------------------------------------------------------------------------

test('malformed JSON line is skipped without throwing', () => {
	const log = [
		'{not valid json',
		makeCycleTokensLine('CAM-100', 1000, 500, 1500),
	].join('\n');

	expect(() => aggregateTokensPerIssue(log)).not.toThrow();
	const result = aggregateTokensPerIssue(log);
	expect(result.perIssue).toHaveLength(1);
	expect(result.perIssue[0]?.total).toBe(1500);
});

test('blank lines and trailing newline are tolerated', () => {
	const log = `${makeCycleTokensLine('CAM-100', 1000, 500, 1500)}\n\n\n`;
	const result = aggregateTokensPerIssue(log);
	expect(result.perIssue).toHaveLength(1);
});

test('cycle-tokens line with non-object detail is skipped', () => {
	const badLine = JSON.stringify({ kind: 'cycle-tokens', detail: 'not-an-object' });
	const log = [badLine, makeCycleTokensLine('CAM-100', 1000, 500, 1500)].join('\n');
	const result = aggregateTokensPerIssue(log);
	expect(result.perIssue).toHaveLength(1);
});

test('cycle-tokens line with missing/non-string issueNumber is skipped', () => {
	const badLine = JSON.stringify({ kind: 'cycle-tokens', detail: { orchTokens: 1, workerTokens: 1, total: 2 } });
	const result = aggregateTokensPerIssue(badLine);
	expect(result.perIssue).toEqual([]);
});

test('unrelated event kinds are ignored', () => {
	const log = [
		JSON.stringify({ kind: 'worker-start', detail: {} }),
		makeCycleTokensLine('CAM-100', 1000, 500, 1500),
		JSON.stringify({ kind: 'result', detail: { outcome: 'pass' } }),
	].join('\n');
	const result = aggregateTokensPerIssue(log);
	expect(result.perIssue).toHaveLength(1);
});

test('top-level array line (not an object) is skipped', () => {
	const log = ['[1,2,3]', makeCycleTokensLine('CAM-100', 1000, 500, 1500)].join('\n');
	const result = aggregateTokensPerIssue(log);
	expect(result.perIssue).toHaveLength(1);
});
