// test/supervisor/review-argv-model.test.ts
//
// Verifies that buildReviewerWorkerArgv includes the --model flag wired
// from the model option (US-002: per-phase model configuration).
//
// Also asserts the backend=claude-only invariant: no 'codex' literal
// is ever emitted by the reviewer argv builder.

import { describe, expect, test } from 'bun:test';
import { buildReviewerWorkerArgv } from '../../src/supervisor/review.ts';
import { DEFAULTS } from '../../src/config/models.ts';

const BASE = {
	uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
};

describe('buildReviewerWorkerArgv --model wiring (US-002)', () => {
	test('includes --model flag with the supplied model value', () => {
		const argv = buildReviewerWorkerArgv({ ...BASE, model: 'claude-opus-4-8' });
		expect(argv).toContain('--model claude-opus-4-8');
	});

	test('--model appears before --agent in the command string', () => {
		const argv = buildReviewerWorkerArgv({ ...BASE, model: 'claude-opus-4-8' });
		const modelIdx = argv.indexOf('--model');
		const agentIdx = argv.indexOf('--agent');
		expect(modelIdx).toBeGreaterThan(-1);
		expect(agentIdx).toBeGreaterThan(-1);
		expect(modelIdx).toBeLessThan(agentIdx);
	});

	test('defaults to DEFAULTS.reviewer when model is not supplied', () => {
		const argv = buildReviewerWorkerArgv(BASE);
		expect(argv).toContain(`--model ${DEFAULTS.reviewer}`);
	});

	test('DEFAULTS.reviewer is the expected default model', () => {
		expect(DEFAULTS.reviewer).toBe('claude-opus-4-8');
	});

	test('never contains codex literal for any backend input (backend=claude only)', () => {
		const argv = buildReviewerWorkerArgv({ ...BASE, model: 'claude-opus-4-8' });
		expect(argv).not.toContain('codex');
	});

	test('never contains codex even with no model supplied (default path)', () => {
		const argv = buildReviewerWorkerArgv(BASE);
		expect(argv).not.toContain('codex');
	});
});
