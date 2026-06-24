// test/supervisor/worker-argv-model.test.ts
//
// Verifies that buildImplementerWorkerArgv includes the --model flag wired
// from the model option (US-002: per-phase model configuration).
//
// Also asserts the backend=claude-only invariant: no 'codex' literal
// is ever emitted by the implementer argv builder.

import { describe, expect, test } from 'bun:test';
import { buildImplementerWorkerArgv } from '../../src/supervisor/worker-argv.ts';
import { DEFAULTS } from '../../src/config/models.ts';

const BASE = {
	uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
	taskPrompt: 'Implement US-002 per the PRD.',
	permissionMode: 'bypassPermissions',
};

describe('buildImplementerWorkerArgv --model wiring (US-002)', () => {
	test('includes --model flag with the supplied model value', () => {
		const argv = buildImplementerWorkerArgv({ ...BASE, model: 'claude-sonnet-4-6' });
		expect(argv).toContain('--model claude-sonnet-4-6');
	});

	test('--model appears before --agent in the command string', () => {
		const argv = buildImplementerWorkerArgv({ ...BASE, model: 'claude-sonnet-4-6' });
		const modelIdx = argv.indexOf('--model');
		const agentIdx = argv.indexOf('--agent');
		expect(modelIdx).toBeGreaterThan(-1);
		expect(agentIdx).toBeGreaterThan(-1);
		expect(modelIdx).toBeLessThan(agentIdx);
	});

	test('defaults to DEFAULTS.implementer when model is not supplied', () => {
		const argv = buildImplementerWorkerArgv(BASE);
		expect(argv).toContain(`--model ${DEFAULTS.implementer}`);
	});

	test('DEFAULTS.implementer is the expected default model', () => {
		expect(DEFAULTS.implementer).toBe('claude-sonnet-4-6');
	});

	test('never contains codex literal for any backend input (backend=claude only)', () => {
		const argv = buildImplementerWorkerArgv({ ...BASE, model: 'claude-sonnet-4-6' });
		expect(argv).not.toContain('codex');
	});

	test('never contains codex even with no model supplied (default path)', () => {
		const argv = buildImplementerWorkerArgv(BASE);
		expect(argv).not.toContain('codex');
	});
});
