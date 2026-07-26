// src/commands/run-effort-preflight.ts
//
// Capability probe for the claude CLI's `--effort` flag (US-002, CAM-425).
//
// An unknown flag makes claude exit immediately, both at boot and at every
// CAM-23 self-handoff respawn, on any machine cam is distributed to. Before
// `cam run` ever passes `--effort` in the orchestrator argv, it must first
// confirm the locally installed claude build actually understands the flag.
// The default production check greps the local `claude --help` output for
// the literal substring '--effort'; tests inject a fake so no real claude
// process is ever spawned and both the supported/unsupported branches are
// exercised deterministically.
//
// Sibling module to run-auth-preflight.ts (same extraction rationale: keeps
// src/commands/run.ts within its file-size budget), mirroring its shape
// (checkClaudeAuth(spawnFn): result) adapted to a boolean capability
// question instead of a login-state question.

import type { SpawnFn } from '../tmux/session.ts';

/**
 * Injectable capability probe (DI seam). Defaults to
 * {@link checkClaudeEffortSupport} in production; tests inject a fake so both
 * the supported and unsupported argv shapes are exercised without spawning a
 * real `claude` process.
 */
export type EffortCapabilityCheck = (spawnFn: SpawnFn) => boolean;

/**
 * Default production capability probe: does the locally installed `claude`
 * build understand `--effort`?
 *
 * Runs `claude --help` and greps its stdout for the literal substring
 * '--effort'. Fail-closed on every error path (spawn error, ENOENT, non-zero
 * exit, unreadable output): an inability to CONFIRM support is treated the
 * same as confirmed absence, because emitting an unsupported flag is
 * boot-fatal while omitting a supported one merely loses a tuning knob for
 * one session.
 */
export function checkClaudeEffortSupport(spawnFn: SpawnFn): boolean {
	let result: ReturnType<SpawnFn>;
	try {
		result = spawnFn('claude', ['--help'], { stdio: 'pipe' });
	} catch {
		return false;
	}
	// spawnSync sets result.error on ENOENT (claude not on PATH) without throwing.
	if (result.error != null) return false;
	if ((result.status ?? 1) !== 0) return false;
	const stdoutRaw = result.stdout;
	const raw = Buffer.isBuffer(stdoutRaw) ? stdoutRaw.toString('utf8') : (stdoutRaw ?? '');
	return raw.includes('--effort');
}
