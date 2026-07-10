// test/supervisor/worker-argv.test.ts
//
// Unit tests for src/supervisor/worker-argv.ts.
//
// Coverage:
//   1. All required claude flags are present in the output string.
//   2. The output never contains '-p' as a standalone flag or 'wait-for'.
//   3. A task prompt containing quotes and $ is shell-escaped.
//   4. The agent name can be overridden.

import { describe, expect, test } from 'bun:test';
import {
	buildImplementerWorkerArgv,
	DEFAULT_IMPLEMENTER_AGENT,
	HOST_ONLY_ENV_UNSET,
	WORKER_ENV_UNSET,
	workerEnvPrefix,
} from '../../src/supervisor/worker-argv.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = 'Implement US-003 per the PRD.';
const SAMPLE_MODE = 'bypassPermissions';

describe('buildImplementerWorkerArgv', () => {
	test('does NOT contain standalone -p flag', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		// ' -p ' as a standalone flag must be absent; the substring '-p' can appear
		// in '--permission-mode' so we use a regex word-boundary check.
		expect(result).not.toMatch(/\s-p(\s|$)/);
		expect(result).not.toContain('claude -p');
	});

	test('does NOT contain wait-for', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).not.toContain('wait-for');
		expect(result).not.toContain('tmux');
	});

	test('contains --permission-mode with the supplied mode', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--permission-mode ${SAMPLE_MODE}`);
	});

	test('contains --session-id with the supplied uuid', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
	});

	test('does NOT contain --output-format', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).not.toContain('--output-format');
	});

	test('contains --agent with the default agent name', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--agent ${DEFAULT_IMPLEMENTER_AGENT}`);
	});

	test('starts with the env -u prefix, then claude (no -p) (CAM-43)', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		// The env -u prefix strips nesting-detection vars; claude follows it.
		expect(result.startsWith('env -u CLAUDECODE')).toBe(true);
		const claudeIdx = result.indexOf('claude --permission-mode');
		const envIdx = result.indexOf('env -u CLAUDECODE');
		expect(claudeIdx).toBeGreaterThan(envIdx);
		expect(result).not.toMatch(/\s-p(\s|$)/);
		expect(result).not.toContain('claude -p');
	});

	test('env -u prefix strips each WORKER_ENV_UNSET var, but never CLAUDE_CONFIG_DIR or PATH (CAM-43)', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		for (const v of WORKER_ENV_UNSET) {
			expect(result).toContain(`-u ${v}`);
		}
		// The worker must keep its config dir (subscription auth) and PATH.
		expect(WORKER_ENV_UNSET).not.toContain('CLAUDE_CONFIG_DIR');
		expect(WORKER_ENV_UNSET).not.toContain('PATH');
		expect(result).not.toContain('-u CLAUDE_CONFIG_DIR');
		expect(result).not.toContain('-u PATH');
	});

	test('workerEnvPrefix renders "env -u ... " with a trailing space', () => {
		const prefix = workerEnvPrefix('host');
		expect(prefix.startsWith('env -u CLAUDECODE')).toBe(true);
		expect(prefix.endsWith(' ')).toBe(true);
		expect(prefix).toContain('-u CLAUDE_CODE_SESSION_ID');
	});

	test('task prompt with embedded single quotes is shell-escaped', () => {
		const dangerousPrompt = "Implement it's critical; use $HOME and `backtick`";
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: dangerousPrompt,
			permissionMode: SAMPLE_MODE,
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
			agentName: customAgent,
		});
		expect(result).toContain(`--agent ${customAgent}`);
		expect(result).not.toContain(`--agent ${DEFAULT_IMPLEMENTER_AGENT}`);
	});

	test('default agentName is subagent-implementer', () => {
		expect(DEFAULT_IMPLEMENTER_AGENT).toBe('subagent-implementer');
	});

	test('does not contain tee (no durable out-log in interactive mode)', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).not.toContain('tee');
	});

	test('retains --permission-mode, --session-id, --agent, and prompt', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain(`--permission-mode ${SAMPLE_MODE}`);
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
		expect(result).toContain(`--agent ${DEFAULT_IMPLEMENTER_AGENT}`);
		expect(result).toContain(SAMPLE_PROMPT);
	});

	// -------------------------------------------------------------------------
	// US-001 (CAM-242): host-only CLAUDE_CODE_OAUTH_TOKEN strip.
	// -------------------------------------------------------------------------

	test('HOST_ONLY_ENV_UNSET is separate from WORKER_ENV_UNSET and contains only the oauth token var', () => {
		expect(HOST_ONLY_ENV_UNSET).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
		expect(WORKER_ENV_UNSET).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
	});

	test('workerEnvPrefix("host") includes -u CLAUDE_CODE_OAUTH_TOKEN', () => {
		const prefix = workerEnvPrefix('host');
		expect(prefix).toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
	});

	test('workerEnvPrefix("container") does NOT include -u CLAUDE_CODE_OAUTH_TOKEN', () => {
		const prefix = workerEnvPrefix('container');
		expect(prefix).not.toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
		// The nesting-detection strip is still applied on container isolation.
		expect(prefix).toContain('-u CLAUDECODE');
	});

	test('on host isolation (default), the assembled command contains -u CLAUDE_CODE_OAUTH_TOKEN ahead of claude', () => {
		const result = buildImplementerWorkerArgv({
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

	test('on container isolation, the assembled command does NOT contain -u CLAUDE_CODE_OAUTH_TOKEN', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			isolation: 'container',
		});
		expect(result).not.toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
	});

	test('CLAUDE_CONFIG_DIR and PATH remain unstripped on both host and container isolation', () => {
		const hostResult = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			isolation: 'host',
		});
		const containerResult = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			isolation: 'container',
		});
		expect(hostResult).not.toContain('-u CLAUDE_CONFIG_DIR');
		expect(hostResult).not.toContain('-u PATH');
		expect(containerResult).not.toContain('-u CLAUDE_CONFIG_DIR');
		expect(containerResult).not.toContain('-u PATH');
	});

	test('isolation defaults to host when omitted', () => {
		const result = buildImplementerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(result).toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
	});
});
