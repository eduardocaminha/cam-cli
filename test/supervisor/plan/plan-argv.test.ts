// test/supervisor/plan/plan-argv.test.ts
//
// Unit tests for src/supervisor/plan-argv.ts.
//
// Coverage:
//   1. Both builders produce the correct shell string shape.
//   2. Neither builder emits -p or --output-format (CAM-42).
//   3. Both start with workerEnvPrefix() / env -u CLAUDECODE (CAM-43).
//   4. Model defaults: DEFAULTS.planner / DEFAULTS.auditor.
//   5. Agent name defaults: 'subagent-planner' / 'subagent-auditor'.
//   6. Prompt is single-quote-shell-escaped.
//   7. Model and agent name can be overridden.

import { describe, expect, test } from 'bun:test';
import {
	buildPlannerWorkerArgv,
	buildAuditorWorkerArgv,
	DEFAULT_PLANNER_AGENT,
	DEFAULT_AUDITOR_AGENT,
} from '../../../src/supervisor/plan-argv.ts';
import { DEFAULTS } from '../../../src/config/models.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = 'Plan the next sprint.';
const SAMPLE_MODE = 'bypassPermissions';

// ---------------------------------------------------------------------------
// buildPlannerWorkerArgv
// ---------------------------------------------------------------------------

describe('buildPlannerWorkerArgv', () => {
	test('does NOT contain standalone -p flag (CAM-42)', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).not.toMatch(/\s-p(\s|$)/);
		expect(result).not.toContain('claude -p');
	});

	test('does NOT contain --output-format (CAM-42)', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).not.toContain('--output-format');
	});

	test('starts with env -u CLAUDECODE prefix (CAM-43)', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result.startsWith('env -u CLAUDECODE')).toBe(true);
	});

	test('contains --permission-mode with the supplied mode', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--permission-mode ${SAMPLE_MODE}`);
	});

	test('contains --session-id with the supplied uuid', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
	});

	test('contains --agent with the default planner agent name', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--agent ${DEFAULT_PLANNER_AGENT}`);
	});

	test('default agent name is subagent-planner', () => {
		expect(DEFAULT_PLANNER_AGENT).toBe('subagent-planner');
	});

	test('agent name can be overridden', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-planner',
		});
		expect(result).toContain('--agent custom-planner');
		expect(result).not.toContain(`--agent ${DEFAULT_PLANNER_AGENT}`);
	});

	test('contains --model with DEFAULTS.planner when no model supplied (shell-quoted)', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--model '${DEFAULTS.planner}'`);
	});

	test('contains --model with supplied model (shell-quoted)', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			model: 'my-custom-model',
		});
		expect(result).toContain("--model 'my-custom-model'");
	});

	test('DEFAULTS.planner is claude-opus-4-8', () => {
		expect(DEFAULTS.planner).toBe('claude-opus-4-8');
	});

	test('--model appears before --agent in the command string', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result.indexOf('--model')).toBeLessThan(result.indexOf('--agent'));
	});

	test('prompt with embedded single quotes is shell-escaped', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: "it's a plan",
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain("'\\''");
	});

	test('prompt with dollar sign and backticks is safely enclosed in single quotes', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: 'cost $100 and run `ls`',
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toMatch(/'cost \$100 and run `ls`'/);
	});

	test('contains the task prompt in the output', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(SAMPLE_PROMPT);
	});

	// -------------------------------------------------------------------------
	// US-001 (CAM-242): host-only CLAUDE_CODE_OAUTH_TOKEN strip.
	// -------------------------------------------------------------------------

	test('on host isolation, contains -u CLAUDE_CODE_OAUTH_TOKEN ahead of claude', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			isolation: 'host',
		});
		const tokenIdx = result.indexOf('-u CLAUDE_CODE_OAUTH_TOKEN');
		const claudeIdx = result.indexOf('claude --permission-mode');
		expect(tokenIdx).toBeGreaterThan(-1);
		expect(tokenIdx).toBeLessThan(claudeIdx);
	});

	test('on container isolation, does NOT contain -u CLAUDE_CODE_OAUTH_TOKEN', () => {
		const result = buildPlannerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			isolation: 'container',
		});
		expect(result).not.toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
	});
});

// ---------------------------------------------------------------------------
// buildAuditorWorkerArgv
// ---------------------------------------------------------------------------

describe('buildAuditorWorkerArgv', () => {
	test('does NOT contain standalone -p flag (CAM-42)', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).not.toMatch(/\s-p(\s|$)/);
		expect(result).not.toContain('claude -p');
	});

	test('does NOT contain --output-format (CAM-42)', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).not.toContain('--output-format');
	});

	test('starts with env -u CLAUDECODE prefix (CAM-43)', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result.startsWith('env -u CLAUDECODE')).toBe(true);
	});

	test('contains --permission-mode with the supplied mode', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--permission-mode ${SAMPLE_MODE}`);
	});

	test('contains --session-id with the supplied uuid', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
	});

	test('contains --agent with the default auditor agent name', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--agent ${DEFAULT_AUDITOR_AGENT}`);
	});

	test('default agent name is subagent-auditor', () => {
		expect(DEFAULT_AUDITOR_AGENT).toBe('subagent-auditor');
	});

	test('agent name can be overridden', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-auditor',
		});
		expect(result).toContain('--agent custom-auditor');
		expect(result).not.toContain(`--agent ${DEFAULT_AUDITOR_AGENT}`);
	});

	test('contains --model with DEFAULTS.auditor when no model supplied (shell-quoted)', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--model '${DEFAULTS.auditor}'`);
	});

	test('contains --model with supplied model (shell-quoted)', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			model: 'my-custom-model',
		});
		expect(result).toContain("--model 'my-custom-model'");
	});

	test('DEFAULTS.auditor is claude-opus-4-8', () => {
		expect(DEFAULTS.auditor).toBe('claude-opus-4-8');
	});

	test('--model appears before --agent in the command string', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result.indexOf('--model')).toBeLessThan(result.indexOf('--agent'));
	});

	test('prompt with embedded single quotes is shell-escaped', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: "it's an audit",
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain("'\\''");
	});

	test('prompt with dollar sign and backticks is safely enclosed in single quotes', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: 'cost $100 and run `ls`',
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toMatch(/'cost \$100 and run `ls`'/);
	});

	test('contains the task prompt in the output', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(SAMPLE_PROMPT);
	});

	// -------------------------------------------------------------------------
	// US-001 (CAM-242): host-only CLAUDE_CODE_OAUTH_TOKEN strip.
	// -------------------------------------------------------------------------

	test('on host isolation, contains -u CLAUDE_CODE_OAUTH_TOKEN ahead of claude', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			isolation: 'host',
		});
		const tokenIdx = result.indexOf('-u CLAUDE_CODE_OAUTH_TOKEN');
		const claudeIdx = result.indexOf('claude --permission-mode');
		expect(tokenIdx).toBeGreaterThan(-1);
		expect(tokenIdx).toBeLessThan(claudeIdx);
	});

	test('on container isolation, does NOT contain -u CLAUDE_CODE_OAUTH_TOKEN', () => {
		const result = buildAuditorWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			isolation: 'container',
		});
		expect(result).not.toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
	});
});
