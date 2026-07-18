// test/supervisor/backend-adapter.test.ts
//
// Golden characterization tests for ClaudeAdapter.buildSpawnArgv (US-001,
// CAM-341, following CAM-339/US-003's seam inversion, ADR-0047). For each of
// the four worker actors, asserts that ClaudeAdapter.buildSpawnArgv(actor,
// opts) produces an exact, hardcoded literal argv string. These goldens are
// pinned directly, not compared against the four per-actor wrapper functions
// that now thinly delegate to this same method: since US-003 made those
// wrappers thin delegations, asserting against their output would be
// tautological (the adapter compared to itself). Pinning literal strings
// makes this a real behavior lock instead.

import { describe, expect, test } from 'bun:test';
import { ClaudeAdapter } from '../../src/supervisor/backend-adapter.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = "Implement it's US-002; use $HOME and `backtick`.";
const SAMPLE_MODE = 'bypassPermissions';

describe('ClaudeAdapter.buildSpawnArgv golden characterization (US-001)', () => {
	test('implementer: matches pinned golden (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('implementer', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN CAM_WORKER=1 claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'sonnet' --agent subagent-implementer 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('implementer: matches pinned golden with agentName, model, and container isolation set', () => {
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
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION CAM_WORKER=1 claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-sonnet-4-6' --agent custom-implementer 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('planner: matches pinned golden (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('planner', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'opus' --agent subagent-planner 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('planner: matches pinned golden with agentName, model, and host isolation set', () => {
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
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-opus-4-8' --agent custom-planner 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('auditor: matches pinned golden (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('auditor', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'opus' --agent subagent-auditor 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('auditor: matches pinned golden with agentName, model, and container isolation set', () => {
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
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-sonnet-4-6' --agent custom-auditor 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('reviewer: matches pinned golden (all-defaults path: no taskPrompt/permissionMode)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID };
		const actual = adapter.buildSpawnArgv('reviewer', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'opus' --agent subagent-reviewer 'Review all changes on the current branch vs main per your AGENT.md. Run the project quality gates. End your output with the <review> verdict tag on the very last line.'";
		expect(actual).toBe(expected);
	});

	test('reviewer: matches pinned golden with explicit taskPrompt, permissionMode, agentName, model, isolation set', () => {
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
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode acceptEdits --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-opus-4-8' --agent custom-reviewer 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
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
