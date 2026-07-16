// test/commands/stats.test.ts
//
// Unit tests for `cam stats tokens` (CAM-241/136 US-002):
// - runStatsTokens (src/commands/stats.ts): the I/O-wired report + sentinel.
// - parseStatsArgs / dispatchStats (index.ts): CLI wiring.
//
// Mirrors the injectable-deps test pattern of test/commands/patterns-cli.test.ts
// and test/stats/tokens.test.ts (fixture builders for raw JSONL lines).

import { test, expect, describe } from 'bun:test';
import { runStatsTokens } from '../../src/commands/stats.ts';
import { parseStatsArgs, dispatchStats, COMMANDS, HELP_REGISTRY } from '../../index.ts';

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
// runStatsTokens
// ---------------------------------------------------------------------------

describe('runStatsTokens', () => {
	test('missing event log (readEventLog -> null): exits 0, reports no data, sentinel with zeros', () => {
		const written: string[] = [];
		const code = runStatsTokens({
			readEventLog: () => null,
			write: (s) => written.push(s),
		});
		expect(code).toBe(0);
		const output = written.join('');
		expect(output).toContain('No token data recorded yet');
		expect(output).toContain('CAM_STATS_TOKENS=issues=0 mean=0 median=0 unattributed=0');
	});

	test('empty event log (""): exits 0, same as missing', () => {
		const written: string[] = [];
		const code = runStatsTokens({
			readEventLog: () => '',
			write: (s) => written.push(s),
		});
		expect(code).toBe(0);
		expect(written.join('')).toContain('CAM_STATS_TOKENS=issues=0 mean=0 median=0 unattributed=0');
	});

	test('renders per-issue orch/worker/total table plus mean/median, exactly one CAM_STATS_TOKENS= line', () => {
		const log = [
			makeCycleTokensLine('CAM-100', 1000, 2000, 3000),
			makeCycleTokensLine('CAM-200', 500, 500, 1000),
		].join('\n');
		const written: string[] = [];
		const code = runStatsTokens({
			readEventLog: () => log,
			write: (s) => written.push(s),
		});
		expect(code).toBe(0);
		const output = written.join('');

		expect(output).toContain('CAM-100');
		expect(output).toContain('CAM-200');
		expect(output).toContain('Mean tokens/issue: 2000');
		expect(output).toContain('Median tokens/issue: 2000');

		const sentinelLines = output.split('\n').filter((l) => l.startsWith('CAM_STATS_TOKENS='));
		expect(sentinelLines).toHaveLength(1);
		expect(sentinelLines[0]).toBe('CAM_STATS_TOKENS=issues=2 mean=2000 median=2000 unattributed=0');
	});

	test('AC4: unattributed spend from raw tokens events is flagged, not dropped or misattributed', () => {
		const log = [
			// Closed cycle: 200 worker tokens attributed to CAM-100.
			makeCycleTokensLine('CAM-100', 100, 200, 300),
			// Trailing raw 'tokens' events for an in-flight cycle (no closing
			// 'cycle-tokens' marker yet) summing to 300 -> 100 unattributed
			// once the already-attributed 200 is subtracted.
			makeTokensLine(150, 75, 30, 45),
		].join('\n');
		const written: string[] = [];
		const code = runStatsTokens({
			readEventLog: () => log,
			write: (s) => written.push(s),
		});
		expect(code).toBe(0);
		const output = written.join('');
		expect(output).toContain('Unattributed spend: 100 tokens');
		expect(output).toContain('CAM_STATS_TOKENS=issues=1 mean=300 median=300 unattributed=100');
	});

	test('AC5: states the orch-vs-worker formula asymmetry and that totals are used as recorded', () => {
		const written: string[] = [];
		runStatsTokens({ readEventLog: () => null, write: (s) => written.push(s) });
		const output = written.join('');
		expect(output).toContain('excludes output tokens');
		expect(output).toContain('not recomputed from transcripts');
	});

	test('malformed JSONL lines are skipped, not thrown', () => {
		const log = ['not json', makeCycleTokensLine('CAM-1', 10, 20, 30)].join('\n');
		const written: string[] = [];
		const code = runStatsTokens({ readEventLog: () => log, write: (s) => written.push(s) });
		expect(code).toBe(0);
		expect(written.join('')).toContain('CAM_STATS_TOKENS=issues=1 mean=30 median=30 unattributed=0');
	});
});

// ---------------------------------------------------------------------------
// index.ts wiring: parseStatsArgs / dispatchStats / COMMANDS / HELP_REGISTRY
// ---------------------------------------------------------------------------

describe('parseStatsArgs', () => {
	test('--help returns { help: true }', () => {
		expect(parseStatsArgs(['--help'])).toEqual({ help: true });
	});

	test('-h returns { help: true }', () => {
		expect(parseStatsArgs(['-h'])).toEqual({ help: true });
	});

	test('no args returns { help: true } (bare `cam stats` shows usage, does not error)', () => {
		expect(parseStatsArgs([])).toEqual({ help: true });
	});

	test('tokens returns { mode: "tokens", help: false }', () => {
		expect(parseStatsArgs(['tokens'])).toEqual({ mode: 'tokens', help: false });
	});

	test('unknown subcommand returns null', () => {
		expect(parseStatsArgs(['unknown'])).toBeNull();
	});
});

describe('dispatchStats', () => {
	test('help mode: prints STATS_HELP and returns 0 without touching statsTokensFn', () => {
		let called = false;
		const parsed = parseStatsArgs(['--help']);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const code = dispatchStats(parsed, {
			statsTokensFn: () => {
				called = true;
				return 0;
			},
		});
		expect(code).toBe(0);
		expect(called).toBe(false);
	});

	test('tokens mode: delegates to statsTokensFn and returns its exit code', () => {
		const parsed = parseStatsArgs(['tokens']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchStats(parsed, { statsTokensFn: () => 0 });
		expect(code).toBe(0);
	});
});

test('COMMANDS + HELP_REGISTRY: `stats` is registered end-to-end', () => {
	expect(COMMANDS).toContain('stats');
	expect(HELP_REGISTRY['stats']).toBeDefined();
	expect(HELP_REGISTRY['stats']).toContain('cam stats tokens');
});
