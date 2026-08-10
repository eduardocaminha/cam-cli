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
//   5. The real `orch-agent-allowlist.sh` denies a headless worker Write to
//      prd.json when the source env has no CAM_SESSION. This exercises both
//      required markers at the subprocess boundary instead of checking one
//      env property in isolation.

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IMPLEMENTER_AGENT, HOST_ONLY_ENV_UNSET, WORKER_ENV_UNSET } from '../../src/supervisor/backend-adapter.ts';
import { buildHeadlessChildInvocation } from '../../src/supervisor/headless-argv.ts';

const TEST_AGENT_NAME = DEFAULT_IMPLEMENTER_AGENT;
const TEST_PERMISSION_MODE = 'bypassPermissions';
const TEST_SESSION_NAME = 'cam-test-session';
const HOOK_SCRIPT = fileURLToPath(new URL('../../.claude/hooks/orch-agent-allowlist.sh', import.meta.url));

function buildTestInvocation(
	overrides: Partial<Parameters<typeof buildHeadlessChildInvocation>[0]> = {},
) {
	return buildHeadlessChildInvocation({
		sourceEnv: {},
		agentName: TEST_AGENT_NAME,
		permissionMode: TEST_PERMISSION_MODE,
		sessionName: TEST_SESSION_NAME,
		...overrides,
	});
}

describe('buildHeadlessChildInvocation', () => {
	test('argv is an array, not a shell string', () => {
		const { argv } = buildTestInvocation();
		expect(Array.isArray(argv)).toBe(true);
	});

	test('contains --print', () => {
		const { argv } = buildTestInvocation();
		expect(argv).toContain('--print');
	});

	test('contains --input-format stream-json', () => {
		const { argv } = buildTestInvocation();
		const idx = argv.indexOf('--input-format');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('stream-json');
	});

	test('contains --output-format stream-json', () => {
		const { argv } = buildTestInvocation();
		const idx = argv.indexOf('--output-format');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('stream-json');
	});

	test('contains --verbose', () => {
		const { argv } = buildTestInvocation();
		expect(argv).toContain('--verbose');
	});

	test('does NOT contain --resume', () => {
		const { argv } = buildTestInvocation();
		expect(argv).not.toContain('--resume');
	});

	test('does NOT contain --include-partial-messages', () => {
		const { argv } = buildTestInvocation();
		expect(argv).not.toContain('--include-partial-messages');
	});

	test('does NOT contain --bare', () => {
		const { argv } = buildTestInvocation();
		expect(argv).not.toContain('--bare');
	});

	test('contains --agent <agentName> (US-R1-001 regression)', () => {
		const { argv } = buildTestInvocation();
		const idx = argv.indexOf('--agent');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe(TEST_AGENT_NAME);
	});

	test('--agent carries the caller-supplied value, not a hardcoded default', () => {
		const { argv } = buildTestInvocation({ agentName: 'subagent-planner' });
		const idx = argv.indexOf('--agent');
		expect(argv[idx + 1]).toBe('subagent-planner');
	});

	test('contains --permission-mode <permissionMode> (US-R1-002 regression)', () => {
		const { argv } = buildTestInvocation();
		const idx = argv.indexOf('--permission-mode');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe(TEST_PERMISSION_MODE);
	});

	test('--permission-mode carries the caller-supplied value, not a hardcoded default', () => {
		const { argv } = buildTestInvocation({ permissionMode: 'acceptEdits' });
		const idx = argv.indexOf('--permission-mode');
		expect(argv[idx + 1]).toBe('acceptEdits');
	});

	test('appends --model when a model is supplied', () => {
		const { argv } = buildTestInvocation({ model: 'sonnet' });
		const idx = argv.indexOf('--model');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe('sonnet');
	});

	test('omits --model when no model is supplied', () => {
		const { argv } = buildTestInvocation();
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

		const { env } = buildTestInvocation({ sourceEnv });

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
		const { env } = buildTestInvocation();
		expect(env.CAM_WORKER).toBe('1');
	});

	test('real write guard denies a headless worker Write to prd.json when source env is unscoped', async () => {
		const { env } = buildTestInvocation({
			sourceEnv: { PATH: process.env.PATH },
		});
		const payload = JSON.stringify({
			tool_name: 'Write',
			tool_input: { file_path: '/workspace/scripts/cam/prd.json' },
		});
		const proc = Bun.spawn(['bash', HOOK_SCRIPT], {
			stdin: new TextEncoder().encode(payload),
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

		expect(exitCode).toBe(0);
		const decision = JSON.parse(stdout) as {
			hookSpecificOutput?: { permissionDecision?: string };
		};
		expect(decision.hookSpecificOutput?.permissionDecision).toBe('deny');
		expect(env.CAM_SESSION).toBe(TEST_SESSION_NAME);
	});

	test('env policy does not mutate the source env', () => {
		const sourceEnv: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'sk-ant-untouched' };
		buildTestInvocation({ sourceEnv });
		expect(sourceEnv.ANTHROPIC_API_KEY).toBe('sk-ant-untouched');
	});
});
