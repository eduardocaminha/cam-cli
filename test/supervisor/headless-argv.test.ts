// test/supervisor/headless-argv.test.ts
//
// Unit tests for src/supervisor/headless-argv.ts.
//
// Coverage:
//   1. buildHeadlessChildInvocation returns an argv ARRAY carrying the
//      required flags, and never --resume / --include-partial-messages /
//      --bare.
//   2. `env policy`: WORKER_ENV_UNSET, HOST_ONLY_ENV_UNSET
//      (CLAUDE_CODE_OAUTH_TOKEN), and ANTHROPIC_API_KEY are all stripped
//      from the returned env, while unrelated vars survive.
//   3. --agent <agentName> is always present and carries the caller-supplied
//      value (CRITICAL regression fix, US-R1-001): without it the headless
//      child has no AGENT.md and none of the implementer protocol.
//   4. --permission-mode <permissionMode> is always present and carries the
//      caller-supplied value (CRITICAL regression fix, US-R1-002): without
//      it the headless docs' "Auto-approve tools" abort rule applies and a
//      real dispatch could never write a file.
//   5. CAM_WORKER=1 is always set in the returned env (CRITICAL regression
//      fix, US-R1-003): without it, `orch-agent-allowlist.sh`'s worker-actor
//      write-guard on scripts/cam/prd.json / scripts/cam/issues/* is
//      silently disabled for a headless worker.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_IMPLEMENTER_AGENT, HOST_ONLY_ENV_UNSET, WORKER_ENV_UNSET } from '../../src/supervisor/backend-adapter.ts';
import { buildHeadlessChildInvocation } from '../../src/supervisor/headless-argv.ts';

const TEST_AGENT_NAME = DEFAULT_IMPLEMENTER_AGENT;
const TEST_PERMISSION_MODE = 'bypassPermissions';

describe('buildHeadlessChildInvocation', () => {
	test('argv is an array, not a shell string', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(Array.isArray(argv)).toBe(true);
	});

	test('contains --print', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(argv).toContain('--print');
	});

	test('contains --input-format stream-json', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		const idx = argv.indexOf('--input-format');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('stream-json');
	});

	test('contains --output-format stream-json', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		const idx = argv.indexOf('--output-format');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('stream-json');
	});

	test('contains --verbose', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(argv).toContain('--verbose');
	});

	test('does NOT contain --resume', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(argv).not.toContain('--resume');
	});

	test('does NOT contain --include-partial-messages', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(argv).not.toContain('--include-partial-messages');
	});

	test('does NOT contain --bare', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(argv).not.toContain('--bare');
	});

	test('contains --agent <agentName> (US-R1-001 regression)', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		const idx = argv.indexOf('--agent');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe(TEST_AGENT_NAME);
	});

	test('--agent carries the caller-supplied value, not a hardcoded default', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: 'subagent-planner', permissionMode: TEST_PERMISSION_MODE });
		const idx = argv.indexOf('--agent');
		expect(argv[idx + 1]).toBe('subagent-planner');
	});

	test('contains --permission-mode <permissionMode> (US-R1-002 regression)', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		const idx = argv.indexOf('--permission-mode');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe(TEST_PERMISSION_MODE);
	});

	test('--permission-mode carries the caller-supplied value, not a hardcoded default', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: 'acceptEdits' });
		const idx = argv.indexOf('--permission-mode');
		expect(argv[idx + 1]).toBe('acceptEdits');
	});

	test('appends --model when a model is supplied', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE, model: 'sonnet' });
		const idx = argv.indexOf('--model');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('sonnet');
	});

	test('omits --model when no model is supplied', () => {
		const { argv } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(argv).not.toContain('--model');
	});

	test('env policy', () => {
		const sourceEnv: Record<string, string | undefined> = { PATH: '/usr/bin', HOME: '/home/op' };
		for (const key of WORKER_ENV_UNSET) {
			sourceEnv[key] = 'set-by-parent';
		}
		for (const key of HOST_ONLY_ENV_UNSET) {
			sourceEnv[key] = 'set-by-parent';
		}
		sourceEnv.ANTHROPIC_API_KEY = 'sk-ant-set-by-operator-shell';

		const { env } = buildHeadlessChildInvocation({ sourceEnv, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });

		for (const key of WORKER_ENV_UNSET) {
			expect(env[key]).toBeUndefined();
		}
		for (const key of HOST_ONLY_ENV_UNSET) {
			expect(env[key]).toBeUndefined();
		}
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();

		// Unrelated vars survive the strip.
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/home/op');
	});

	test('sets CAM_WORKER=1 in the returned env (US-R1-003 regression)', () => {
		const { env } = buildHeadlessChildInvocation({ sourceEnv: {}, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(env.CAM_WORKER).toBe('1');
	});

	test('env policy does not mutate the source env', () => {
		const sourceEnv: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'sk-ant-untouched' };
		buildHeadlessChildInvocation({ sourceEnv, agentName: TEST_AGENT_NAME, permissionMode: TEST_PERMISSION_MODE });
		expect(sourceEnv.ANTHROPIC_API_KEY).toBe('sk-ant-untouched');
	});
});
