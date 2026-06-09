// test/orchestrator/budget.test.ts
//
// Unit tests for src/orchestrator/budget.ts (CAM-23 US-001). All inputs are
// injected, so these never touch real ~/.claude or process.env.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	computeOrchBudget,
	resolveOrchThreshold,
	DEFAULT_ORCH_TOKEN_BUDGET,
} from '../../src/orchestrator/budget.ts';
import { runOrchBudget } from '../../src/commands/orch-budget.ts';

/** One transcript line with a known in-flow spend (input + cacheCreation + cacheRead). */
function transcriptWithSpend(input: number, cacheCreation: number, cacheRead: number): string {
	return (
		JSON.stringify({
			requestId: 'r1',
			message: {
				id: 'm1',
				usage: {
					input_tokens: input,
					cache_creation_input_tokens: cacheCreation,
					cache_read_input_tokens: cacheRead,
					output_tokens: 999,
				},
			},
		}) + '\n'
	);
}

describe('resolveOrchThreshold', () => {
	test('default when no overrides', () => {
		expect(resolveOrchThreshold(undefined, undefined)).toBe(DEFAULT_ORCH_TOKEN_BUDGET);
	});

	test('toml overrides default', () => {
		expect(resolveOrchThreshold(undefined, 50_000)).toBe(50_000);
	});

	test('env overrides toml', () => {
		expect(resolveOrchThreshold('30000', 50_000)).toBe(30_000);
	});

	test('garbled env falls through to toml', () => {
		expect(resolveOrchThreshold('abc', 50_000)).toBe(50_000);
	});

	test('non-positive env and toml fall through to default', () => {
		expect(resolveOrchThreshold('0', -5)).toBe(DEFAULT_ORCH_TOKEN_BUDGET);
	});
});

describe('computeOrchBudget', () => {
	test('under budget', () => {
		const r = computeOrchBudget({
			readTranscript: () => transcriptWithSpend(1000, 0, 0),
			tomlBudget: 100_000,
		});
		expect(r.spend).toBe(1000);
		expect(r.threshold).toBe(100_000);
		expect(r.overBudget).toBe(false);
	});

	test('exactly at threshold counts as over (>=)', () => {
		const r = computeOrchBudget({
			readTranscript: () => transcriptWithSpend(50_000, 0, 0),
			tomlBudget: 50_000,
		});
		expect(r.spend).toBe(50_000);
		expect(r.overBudget).toBe(true);
	});

	test('over budget sums input + cacheCreation + cacheRead', () => {
		const r = computeOrchBudget({
			readTranscript: () => transcriptWithSpend(60_000, 5_000, 40_000),
			tomlBudget: 100_000,
		});
		expect(r.spend).toBe(105_000);
		expect(r.overBudget).toBe(true);
	});

	test('missing transcript is 0 spend, not over budget', () => {
		const r = computeOrchBudget({ readTranscript: () => null });
		expect(r.spend).toBe(0);
		expect(r.threshold).toBe(DEFAULT_ORCH_TOKEN_BUDGET);
		expect(r.overBudget).toBe(false);
	});

	test('env overrides toml for the threshold', () => {
		const r = computeOrchBudget({
			readTranscript: () => transcriptWithSpend(40_000, 0, 0),
			envBudget: '30000',
			tomlBudget: 100_000,
		});
		expect(r.threshold).toBe(30_000);
		expect(r.overBudget).toBe(true); // 40k >= 30k
	});

	test('toml overrides default for the threshold', () => {
		const r = computeOrchBudget({
			readTranscript: () => transcriptWithSpend(5_000, 0, 0),
			tomlBudget: 4_000,
		});
		expect(r.threshold).toBe(4_000);
		expect(r.overBudget).toBe(true); // 5k >= 4k
	});
});

describe('runOrchBudget (cam orch-budget surface)', () => {
	test('prints a machine-parseable line; missing transcript is 0 spend at default threshold; exit 0', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-orch-budget-'));
		let out = '';
		const code = runOrchBudget({
			cwd,
			claudeDir: join(cwd, '.claude'),
			write: (s) => {
				out += s;
			},
		});
		expect(code).toBe(0);
		expect(out.trim()).toBe(`CAM_ORCH_BUDGET=0/${DEFAULT_ORCH_TOKEN_BUDGET} over=false`);
	});

	test('env budget override flows into the printed threshold', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-orch-budget-'));
		let out = '';
		runOrchBudget({
			cwd,
			claudeDir: join(cwd, '.claude'),
			envBudget: '50000',
			write: (s) => {
				out += s;
			},
		});
		expect(out.trim()).toBe('CAM_ORCH_BUDGET=0/50000 over=false');
	});
});
