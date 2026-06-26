// test/orch-agent-allowlist.test.ts
//
// Regression test: pipes synthetic PreToolUse payloads to the real
// .claude/hooks/orch-agent-allowlist.sh script via Bun.spawn and asserts the
// allow/deny decisions.
//
// ANTI-SHADOW-MOCK: this test invokes the actual shell script, NOT an inline
// TS reimplementation. A unit fake that returns what the code expects cannot
// catch real behavior bugs (lessons.md CAM-55 operator-smoke).
//
// Requires jq on PATH (the script depends on it). Skips when jq is absent.

import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';

const jqAvailable = Bun.which('jq') !== null;
const HOOK_SCRIPT = join(import.meta.dir, '..', '.claude', 'hooks', 'orch-agent-allowlist.sh');

// Helper: spawn the real hook script with a JSON payload on stdin.
// Returns { stdout, stderr, exitCode }.
async function runHook(payload: object): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const stdin = JSON.stringify(payload);
	const proc = Bun.spawn(['bash', HOOK_SCRIPT], {
		stdin: new TextEncoder().encode(stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
}

// Helper: assert the result is a DENY decision.
// The hook emits JSON with permissionDecision: "deny" on stdout and exits 0.
function assertDeny(result: { stdout: string; exitCode: number }): void {
	expect(result.exitCode).toBe(0);
	let parsed: { hookSpecificOutput?: { permissionDecision?: string } };
	try {
		parsed = JSON.parse(result.stdout.trim());
	} catch {
		throw new Error(`Expected JSON deny output, got: ${JSON.stringify(result.stdout)}`);
	}
	expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
}

// Helper: assert the result is an ALLOW decision.
// The hook emits no output and exits 0.
function assertAllow(result: { stdout: string; exitCode: number }): void {
	expect(result.exitCode).toBe(0);
	expect(result.stdout.trim()).toBe('');
}

describe('orch-agent-allowlist.sh', () => {
	// --- DENY cases ---

	test.skipIf(!jqAvailable)(
		'subagent_type=general-purpose yields deny (tool_input.subagent_type)',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: { subagent_type: 'general-purpose' },
			};
			const result = await runHook(payload);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'subagent_type=Explore yields deny (tool_input.subagent_type)',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: { subagent_type: 'Explore' },
			};
			const result = await runHook(payload);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'missing subagent_type (empty tool_input) yields deny',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: {},
			};
			const result = await runHook(payload);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'missing subagent_type (no tool_input) yields deny',
		async () => {
			const payload = { tool_name: 'Task' };
			const result = await runHook(payload);
			assertDeny(result);
		},
	);

	// --- ALLOW cases ---

	test.skipIf(!jqAvailable)(
		'subagent_type=subagent-planner yields allow (tool_input.subagent_type)',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: { subagent_type: 'subagent-planner' },
			};
			const result = await runHook(payload);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'subagent_type=subagent-auditor yields allow (tool_input.subagent_type)',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: { subagent_type: 'subagent-auditor' },
			};
			const result = await runHook(payload);
			assertAllow(result);
		},
	);

	// --- Alternate field shapes (defensive fallback + regression) ---

	// S-1: ONLY tool_input.agent_type (fallback field, no subagent_type).
	// general-purpose -> DENY.
	test.skipIf(!jqAvailable)(
		'tool_input.agent_type=general-purpose yields deny (no subagent_type)',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: { agent_type: 'general-purpose' },
			};
			const result = await runHook(payload);
			assertDeny(result);
		},
	);

	// S-2: ONLY top-level agent_type (caller identity field, per CAM-91 notes).
	// subagent-planner -> ALLOW via the third fallback path (.agent_type).
	// NOTE: In production the top-level agent_type is the CALLER's identity, not the
	// spawned type. The orchestrator's own identity is 'subagent-orchestrator' (not
	// allowlisted), so a misread of this field would produce a DENY, never a false
	// allow. This fixture locks the defensive fallback path behavior.
	test.skipIf(!jqAvailable)(
		'ONLY top-level agent_type=subagent-planner yields allow (third fallback path)',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: {},
				agent_type: 'subagent-planner',
			};
			const result = await runHook(payload);
			assertAllow(result);
		},
	);

	// S-3: ONLY tool_input.agent_type=general-purpose (second fallback path, no subagent_type).
	// DENY: catches a future field-name change that moves the spawned type to agent_type.
	test.skipIf(!jqAvailable)(
		'ONLY tool_input.agent_type=general-purpose yields deny (second fallback path)',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: { agent_type: 'general-purpose' },
				// no subagent_type, no top-level agent_type
			};
			const result = await runHook(payload);
			assertDeny(result);
		},
	);

	// S-4 (empirically-observed production shape): Task payload as emitted by Claude Code
	// in a cam-orchestrator session. The spawned subagent type lives in tool_input.subagent_type.
	// This fixture locks the real production field shape.
	test.skipIf(!jqAvailable)(
		'empirically-observed production shape: tool_input.subagent_type=subagent-planner yields allow',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: {
					subagent_type: 'subagent-planner',
					description: 'Plan the next PRD sprint',
				},
				// top-level agent_type would be 'subagent-orchestrator' in production
				agent_type: 'subagent-orchestrator',
			};
			const result = await runHook(payload);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'production shape with general-purpose subagent_type yields deny',
		async () => {
			const payload = {
				tool_name: 'Task',
				tool_input: {
					subagent_type: 'general-purpose',
					description: 'Do some work',
				},
				agent_type: 'subagent-orchestrator',
			};
			const result = await runHook(payload);
			assertDeny(result);
		},
	);
});
