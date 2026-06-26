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
//
// env isolation: every runHook call passes an explicit env object to Bun.spawn.
// The hook process inherits NO ambient env variables — CAM_SESSION in the parent
// process does not bleed through. This makes tests deterministic on CI (where
// CAM_SESSION is unset) and locally (where it may be set inside a cam session).

import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';

const jqAvailable = Bun.which('jq') !== null;
const HOOK_SCRIPT = join(import.meta.dir, '..', '.claude', 'hooks', 'orch-agent-allowlist.sh');

// Explicit env objects passed to Bun.spawn. PATH is required for bash to find jq.
const BASE_PATH = process.env['PATH'] ?? '/usr/bin:/bin:/usr/local/bin';
// Scoped env: CAM_SESSION is set — capability policy applies.
const SCOPED_ENV: Record<string, string> = { PATH: BASE_PATH, CAM_SESSION: 'test-session' };
// Unscoped env: CAM_SESSION is absent — scope gate exits 0 (allow) for everything.
const UNSCOPED_ENV: Record<string, string> = { PATH: BASE_PATH };

// Helper: spawn the real hook script with a JSON payload on stdin and an explicit env.
// The env arg controls whether CAM_SESSION is visible to the script (never inherited from
// the parent process), which is required for deterministic CI/local behavior.
async function runHook(
	payload: object,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const stdin = JSON.stringify(payload);
	const proc = Bun.spawn(['bash', HOOK_SCRIPT], {
		stdin: new TextEncoder().encode(stdin),
		stdout: 'pipe',
		stderr: 'pipe',
		env,
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
	// --- Scope gate: unscoped (CAM_SESSION absent) → ALLOW everything ---
	// These cases prove the hook is a no-op outside cam-managed sessions.

	test.skipIf(!jqAvailable)(
		'unscoped (no CAM_SESSION): general-purpose yields allow',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'general-purpose' } },
				UNSCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'unscoped (no CAM_SESSION): absent subagent_type yields allow',
		async () => {
			const result = await runHook({ tool_name: 'Task', tool_input: {} }, UNSCOPED_ENV);
			assertAllow(result);
		},
	);

	// --- Scoped ALLOW cases ---
	// Capability allowlist: read-only plan-time helpers when CAM_SESSION is set.

	test.skipIf(!jqAvailable)(
		'scoped: Explore yields allow',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'Explore' } },
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: Plan yields allow',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'Plan' } },
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: claude-code-guide yields allow',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'claude-code-guide' } },
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: subagent-planner yields allow',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'subagent-planner' } },
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: subagent-auditor yields allow',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'subagent-auditor' } },
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: subagent-reviewer yields allow',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'subagent-reviewer' } },
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	// --- Scoped DENY cases ---
	// Code-writers, general-purpose, and absent/unknown types are denied.

	test.skipIf(!jqAvailable)(
		'scoped: general-purpose yields deny',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'general-purpose' } },
				SCOPED_ENV,
			);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: claude yields deny',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'claude' } },
				SCOPED_ENV,
			);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: fork yields deny',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'fork' } },
				SCOPED_ENV,
			);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: subagent-implementer yields deny',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'subagent-implementer' } },
				SCOPED_ENV,
			);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: absent subagent_type (empty tool_input) yields deny',
		async () => {
			const result = await runHook({ tool_name: 'Task', tool_input: {} }, SCOPED_ENV);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: absent subagent_type (no tool_input) yields deny',
		async () => {
			const result = await runHook({ tool_name: 'Task' }, SCOPED_ENV);
			assertDeny(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: unknown type (foobar) yields deny',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { subagent_type: 'foobar' } },
				SCOPED_ENV,
			);
			assertDeny(result);
		},
	);

	// --- Alternate field shapes (defensive fallback + regression) ---

	// S-1: ONLY tool_input.agent_type (fallback field, no subagent_type).
	// general-purpose -> DENY.
	test.skipIf(!jqAvailable)(
		'scoped: tool_input.agent_type=general-purpose yields deny (no subagent_type)',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: { agent_type: 'general-purpose' } },
				SCOPED_ENV,
			);
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
		'scoped: ONLY top-level agent_type=subagent-planner yields allow (third fallback path)',
		async () => {
			const result = await runHook(
				{ tool_name: 'Task', tool_input: {}, agent_type: 'subagent-planner' },
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	// S-3: ONLY tool_input.agent_type=general-purpose (second fallback path, no subagent_type).
	// DENY: catches a future field-name change that moves the spawned type to agent_type.
	test.skipIf(!jqAvailable)(
		'scoped: ONLY tool_input.agent_type=general-purpose yields deny (second fallback path)',
		async () => {
			const result = await runHook(
				{
					tool_name: 'Task',
					tool_input: { agent_type: 'general-purpose' },
					// no subagent_type, no top-level agent_type
				},
				SCOPED_ENV,
			);
			assertDeny(result);
		},
	);

	// S-4 (empirically-observed production shape): Task payload as emitted by Claude Code
	// in a cam-orchestrator session. The spawned subagent type lives in tool_input.subagent_type.
	// This fixture locks the real production field shape.
	test.skipIf(!jqAvailable)(
		'scoped: production shape: tool_input.subagent_type=subagent-planner yields allow',
		async () => {
			const result = await runHook(
				{
					tool_name: 'Task',
					tool_input: {
						subagent_type: 'subagent-planner',
						description: 'Plan the next PRD sprint',
					},
					// top-level agent_type would be 'subagent-orchestrator' in production
					agent_type: 'subagent-orchestrator',
				},
				SCOPED_ENV,
			);
			assertAllow(result);
		},
	);

	test.skipIf(!jqAvailable)(
		'scoped: production shape with general-purpose subagent_type yields deny',
		async () => {
			const result = await runHook(
				{
					tool_name: 'Task',
					tool_input: {
						subagent_type: 'general-purpose',
						description: 'Do some work',
					},
					agent_type: 'subagent-orchestrator',
				},
				SCOPED_ENV,
			);
			assertDeny(result);
		},
	);
});
