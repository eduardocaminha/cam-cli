// test/commands/run-model-argv.test.ts
//
// Verifies that buildOrchestratorPaneCommand includes the --model flag wired
// from the model option (US-002: per-phase model configuration).

import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPaneCommand } from '../../src/commands/run.ts';
import { DEFAULTS } from '../../src/config/models.ts';

const BASE_OPTS = {
	sessionName: 'cam-test-session',
	sessionId: '11111111-2222-3333-4444-555555555555',
	promptFile: '/project/.claude/.cam-orchestrator-prompt.txt',
	sessionIdMarker: '/project/.claude/.cam-orch-session',
	handoffMarker: '/project/.claude/.cam-orch-handoff.json',
	stateFile: '/project/.claude/cam-loop.local.md',
	readyMarker: '/project/.claude/.cam-orch-ready',
};

describe('buildOrchestratorPaneCommand --model wiring (US-002)', () => {
	test('includes --model with the supplied model value', () => {
		const cmd = buildOrchestratorPaneCommand({ ...BASE_OPTS, model: 'claude-opus-4-8' });
		expect(cmd).toContain('--model');
		expect(cmd).toContain("'claude-opus-4-8'");
	});

	test('--model appears before the prompt argument (cat)', () => {
		const cmd = buildOrchestratorPaneCommand({ ...BASE_OPTS, model: 'claude-opus-4-8' });
		const modelIdx = cmd.indexOf('--model');
		const promptIdx = cmd.indexOf('$(cat');
		expect(modelIdx).toBeGreaterThan(-1);
		expect(promptIdx).toBeGreaterThan(-1);
		expect(modelIdx).toBeLessThan(promptIdx);
	});

	test('defaults to DEFAULTS.orchestrator when model is not supplied', () => {
		const cmd = buildOrchestratorPaneCommand(BASE_OPTS);
		expect(cmd).toContain(`'${DEFAULTS.orchestrator}'`);
		expect(cmd).toContain('--model');
	});

	test('different model values produce distinct outputs', () => {
		const cmd1 = buildOrchestratorPaneCommand({ ...BASE_OPTS, model: 'claude-opus-4-8' });
		const cmd2 = buildOrchestratorPaneCommand({ ...BASE_OPTS, model: 'claude-sonnet-4-6' });
		expect(cmd1).toContain("'claude-opus-4-8'");
		expect(cmd2).toContain("'claude-sonnet-4-6'");
		expect(cmd1).not.toContain("'claude-sonnet-4-6'");
		expect(cmd2).not.toContain("'claude-opus-4-8'");
	});
});
