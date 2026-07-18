// test/supervisor/backend-adapter.test.ts
//
// Golden characterization tests for ClaudeAdapter.buildSpawnArgv (US-002,
// CAM-339, ADR-0047). For each of the four worker actors, asserts that
// ClaudeAdapter.buildSpawnArgv(actor, opts) reproduces the EXACT string
// produced by the corresponding existing builder for identical inputs,
// comparing against real builder output (never a mock-call assertion).

import { describe, expect, test } from 'bun:test';
import { ClaudeAdapter } from '../../src/supervisor/backend-adapter.ts';
import { buildImplementerWorkerArgv } from '../../src/supervisor/worker-argv.ts';
import { buildPlannerWorkerArgv, buildAuditorWorkerArgv } from '../../src/supervisor/plan-argv.ts';
import { buildReviewerWorkerArgv } from '../../src/supervisor/review.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = "Implement it's US-002; use $HOME and `backtick`.";
const SAMPLE_MODE = 'bypassPermissions';

describe('ClaudeAdapter.buildSpawnArgv golden characterization (US-002)', () => {
	test('implementer: matches buildImplementerWorkerArgv byte-for-byte (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('implementer', opts);
		const expected = buildImplementerWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	test('implementer: matches with agentName, model, and container isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-implementer',
			model: 'claude-sonnet-4-6',
			isolation: 'container' as const,
		};
		const actual = adapter.buildSpawnArgv('implementer', opts);
		const expected = buildImplementerWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	test('planner: matches buildPlannerWorkerArgv byte-for-byte (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('planner', opts);
		const expected = buildPlannerWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	test('planner: matches with agentName, model, and host isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-planner',
			model: 'claude-opus-4-8',
			isolation: 'host' as const,
		};
		const actual = adapter.buildSpawnArgv('planner', opts);
		const expected = buildPlannerWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	test('auditor: matches buildAuditorWorkerArgv byte-for-byte (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('auditor', opts);
		const expected = buildAuditorWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	test('auditor: matches with agentName, model, and container isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-auditor',
			model: 'claude-sonnet-4-6',
			isolation: 'container' as const,
		};
		const actual = adapter.buildSpawnArgv('auditor', opts);
		const expected = buildAuditorWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	test('reviewer: matches buildReviewerWorkerArgv byte-for-byte (all-defaults path: no taskPrompt/permissionMode)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID };
		const actual = adapter.buildSpawnArgv('reviewer', opts);
		const expected = buildReviewerWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	test('reviewer: matches with explicit taskPrompt, permissionMode, agentName, model, isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: 'acceptEdits',
			agentName: 'custom-reviewer',
			model: 'claude-opus-4-8',
			isolation: 'host' as const,
		};
		const actual = adapter.buildSpawnArgv('reviewer', opts);
		const expected = buildReviewerWorkerArgv(opts);
		expect(actual).toBe(expected);
	});

	// -------------------------------------------------------------------------
	// Adapter-level guards (not builder-golden, but proves the seam contract).
	// -------------------------------------------------------------------------

	test('implementer/planner/auditor throw when taskPrompt is missing (never silently emits a bad argv)', () => {
		const adapter = new ClaudeAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, permissionMode: SAMPLE_MODE })).toThrow();
		}
	});

	test('implementer/planner/auditor throw when permissionMode is missing', () => {
		const adapter = new ClaudeAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT })).toThrow();
		}
	});
});
