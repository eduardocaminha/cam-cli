// test/orchestrator/context-window.test.ts
//
// Unit tests for the context-window constants and decision functions in
// src/orchestrator/context-window.ts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
	OPUS_CONTEXT_WINDOW,
	ORCH_CONTEXT_BACKSTOP_FRACTION,
	orchestratorContextWindow,
	isOverContextBackstop,
} from '../../src/orchestrator/context-window.ts';

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('OPUS_CONTEXT_WINDOW', () => {
	test('is 1_000_000 (Claude Opus 4.6+ context window per Anthropic docs 2026-07-03)', () => {
		expect(OPUS_CONTEXT_WINDOW).toBe(1_000_000);
	});
});

describe('ORCH_CONTEXT_BACKSTOP_FRACTION', () => {
	test('is approximately 0.8', () => {
		expect(ORCH_CONTEXT_BACKSTOP_FRACTION).toBeCloseTo(0.8);
	});
	test('is strictly between 0 and 1', () => {
		expect(ORCH_CONTEXT_BACKSTOP_FRACTION).toBeGreaterThan(0);
		expect(ORCH_CONTEXT_BACKSTOP_FRACTION).toBeLessThan(1);
	});
});

// ---------------------------------------------------------------------------
// orchestratorContextWindow
// ---------------------------------------------------------------------------

describe('orchestratorContextWindow', () => {
	let tmpDir: string;
	let configPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'ctx-window-test-'));
		configPath = join(tmpDir, 'project.toml');
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns 1_000_000 for default opus model (no config)', () => {
		// No config file -> readPhaseModel falls back to DEFAULTS['orchestrator'] = 'claude-opus-4-8'
		// claude-opus-4-8 has a 1M context window per Anthropic docs (2026-07-03)
		const result = orchestratorContextWindow(configPath);
		expect(result).toBe(1_000_000);
	});

	test('returns 1_000_000 for claude-opus-4-8 explicitly', () => {
		writeFileSync(configPath, '[models]\norchestrator = "claude-opus-4-8"\n');
		expect(orchestratorContextWindow(configPath)).toBe(1_000_000);
	});

	test('returns 1_000_000 for claude-opus-4-6 (1M generation)', () => {
		writeFileSync(configPath, '[models]\norchestrator = "claude-opus-4-6"\n');
		expect(orchestratorContextWindow(configPath)).toBe(1_000_000);
	});

	test('returns 200_000 for claude-opus-4-5 (200k generation)', () => {
		writeFileSync(configPath, '[models]\norchestrator = "claude-opus-4-5"\n');
		expect(orchestratorContextWindow(configPath)).toBe(200_000);
	});

	test('returns 200_000 for claude-opus-4-1 (200k generation)', () => {
		writeFileSync(configPath, '[models]\norchestrator = "claude-opus-4-1"\n');
		expect(orchestratorContextWindow(configPath)).toBe(200_000);
	});

	test('returns 200_000 for claude-sonnet-4-5 (200k generation)', () => {
		writeFileSync(configPath, '[models]\norchestrator = "claude-sonnet-4-5"\n');
		expect(orchestratorContextWindow(configPath)).toBe(200_000);
	});

	test('returns 1_000_000 for claude-sonnet-4-6 (1M generation)', () => {
		writeFileSync(configPath, '[models]\norchestrator = "claude-sonnet-4-6"\n');
		expect(orchestratorContextWindow(configPath)).toBe(1_000_000);
	});

	test('returns 200_000 for claude-haiku-4-5 (200k model)', () => {
		writeFileSync(configPath, '[models]\norchestrator = "claude-haiku-4-5"\n');
		expect(orchestratorContextWindow(configPath)).toBe(200_000);
	});

	test('returns 1_000_000 (fallback) for an unknown model -- never throws', () => {
		writeFileSync(configPath, '[models]\norchestrator = "some-future-model-9-0"\n');
		expect(() => orchestratorContextWindow(configPath)).not.toThrow();
		expect(orchestratorContextWindow(configPath)).toBe(1_000_000);
	});

	test('returns 1_000_000 when config is malformed TOML -- never throws', () => {
		writeFileSync(configPath, 'not valid toml !!!\n');
		expect(() => orchestratorContextWindow(configPath)).not.toThrow();
		expect(orchestratorContextWindow(configPath)).toBe(1_000_000);
	});
});

// ---------------------------------------------------------------------------
// isOverContextBackstop
// ---------------------------------------------------------------------------

describe('isOverContextBackstop', () => {
	const window = 200_000;
	const fraction = 0.8;
	const threshold = window * fraction; // 160_000

	test('returns false when occupancy is below the threshold', () => {
		expect(isOverContextBackstop(150_000, window, fraction)).toBe(false);
	});

	test('returns false at exactly the threshold (boundary: == is NOT over)', () => {
		expect(isOverContextBackstop(threshold, window, fraction)).toBe(false);
	});

	test('returns true when occupancy is one token above the threshold (boundary: > is over)', () => {
		expect(isOverContextBackstop(threshold + 1, window, fraction)).toBe(true);
	});

	test('returns true when occupancy is well above the threshold', () => {
		expect(isOverContextBackstop(190_000, window, fraction)).toBe(true);
	});

	test('returns false at 0 occupancy', () => {
		expect(isOverContextBackstop(0, window, fraction)).toBe(false);
	});

	// Default-fraction path
	describe('default fraction path (ORCH_CONTEXT_BACKSTOP_FRACTION)', () => {
		const defaultThreshold = window * ORCH_CONTEXT_BACKSTOP_FRACTION;

		test('uses ORCH_CONTEXT_BACKSTOP_FRACTION when fraction is omitted', () => {
			// At exactly the default threshold: not over
			expect(isOverContextBackstop(defaultThreshold, window)).toBe(false);
			// One token above: over
			expect(isOverContextBackstop(defaultThreshold + 1, window)).toBe(true);
		});
	});

	// Edge cases
	test('handles occupancy of 0 with 0 window gracefully (no division by zero)', () => {
		// 0 > 0 * 0.8 = 0 => false
		expect(isOverContextBackstop(0, 0, fraction)).toBe(false);
	});
});
