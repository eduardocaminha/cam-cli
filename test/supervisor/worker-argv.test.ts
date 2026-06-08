// test/supervisor/worker-argv.test.ts
//
// Unit tests for src/supervisor/worker-argv.ts.
//
// Coverage:
//   1. All required claude flags are present in the output string.
//   2. The tmux wait-for -S chain follows the claude command.
//   3. A task prompt containing quotes and $ is shell-escaped.
//   4. The agent name can be overridden.

import { describe, expect, test } from 'bun:test';
import {
	buildImplementerWorkerArgv,
	DEFAULT_IMPLEMENTER_AGENT,
} from '../../src/supervisor/worker-argv.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_CHANNEL = 'cam-worker-US-003-a1b2c3d4';
const SAMPLE_PROMPT = 'Implement US-003 per the PRD.';
const SAMPLE_MODE = 'bypassPermissions';

describe('buildImplementerWorkerArgv', () => {
	test('contains claude -p flag', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		expect(result).toContain('claude -p');
	});

	test('contains --permission-mode with the supplied mode', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		expect(result).toContain(`--permission-mode ${SAMPLE_MODE}`);
	});

	test('contains --session-id with the supplied uuid', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
	});

	test('contains --output-format text', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		expect(result).toContain('--output-format text');
	});

	test('contains --agent with the default agent name', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		expect(result).toContain(`--agent ${DEFAULT_IMPLEMENTER_AGENT}`);
	});

	test('contains tmux -L cam wait-for -S chain after the implementer command', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		// The chain must appear after `claude`
		const claudeIdx = result.indexOf('claude');
		const waitIdx = result.indexOf('tmux -L cam wait-for -S');
		expect(claudeIdx).toBeGreaterThanOrEqual(0);
		expect(waitIdx).toBeGreaterThan(claudeIdx);
	});

	test('channel is present in the wait-for -S argument', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		// Channel is single-quoted, but the bare channel name should still appear
		expect(result).toContain(SAMPLE_CHANNEL);
	});

	test('task prompt with embedded single quotes is shell-escaped', () => {
		const dangerousPrompt = "Implement it's critical; use $HOME and `backtick`";
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: dangerousPrompt,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		// The prompt content must be present but the single quote must be escaped
		// as '\'' so the shell cannot break out of the quoted argument.
		expect(result).toContain("'\\''");
		// $ and backtick must not be interpolated: they remain literal inside
		// single quotes, so the raw characters should still appear in the string.
		expect(result).toContain('$HOME');
		expect(result).toContain('`backtick`');
	});

	test('task prompt with dollar sign and backticks is safely enclosed in single quotes', () => {
		const dangerousPrompt = 'Cost is $100 and run `ls`';
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: dangerousPrompt,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
		});
		// The prompt must be wrapped in single quotes (so $ and ` are literal)
		expect(result).toMatch(/'Cost is \$100 and run `ls`'/);
	});

	test('agentName can be overridden', () => {
		const customAgent = 'my-custom-agent';
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			channel: SAMPLE_CHANNEL,
			agentName: customAgent,
		});
		expect(result).toContain(`--agent ${customAgent}`);
		expect(result).not.toContain(`--agent ${DEFAULT_IMPLEMENTER_AGENT}`);
	});

	test('default agentName is subagent-implementer', () => {
		expect(DEFAULT_IMPLEMENTER_AGENT).toBe('subagent-implementer');
	});
});
