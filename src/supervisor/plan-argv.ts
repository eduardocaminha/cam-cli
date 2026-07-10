// src/supervisor/plan-argv.ts
//
// Pure argv builders for launching subagent-planner and subagent-auditor
// as interactive TUI worker panes within the plan-runner.
//
// These builders mirror buildImplementerWorkerArgv (worker-argv.ts) and
// buildReviewerWorkerArgv (review.ts): pure functions, no I/O, same
// env-strip + shell-escape pattern (CAM-43 + CAM-42).
//
// Design decisions:
//   - workerEnvPrefix() is shared from worker-argv.ts (DO NOT re-implement the
//     env-strip list). Both builders strip the same WORKER_ENV_UNSET vars so
//     a pane spawned from inside a claude session still boots.
//   - No -p, no --output-format: subscription rule (CAM-42).
//   - Default agent names match .claude/agents/ frontmatter `name` fields.
//   - Models default to DEFAULTS.planner / DEFAULTS.auditor; the CALLER
//     (US-005) passes readPhaseModel('planner'/'auditor') at spawn time.
//   - The shell string format:
//       env -u CLAUDECODE -u ... claude --permission-mode <mode>
//         --session-id <uuid> --model '<model>' --agent <agent> '<prompt>'

import { DEFAULTS } from '../config/models.ts';
import type { WorkerIsolation } from '../config/models.ts';
import { workerEnvPrefix } from './worker-argv.ts';

/** Default planner agent name; matches .claude/agents/subagent-planner.md. */
export const DEFAULT_PLANNER_AGENT = 'subagent-planner';

/** Default auditor agent name; matches .claude/agents/subagent-auditor.md. */
export const DEFAULT_AUDITOR_AGENT = 'subagent-auditor';

/**
 * Escape a string for safe embedding inside a POSIX single-quoted shell argument.
 * Handles embedded single quotes via the '\'' technique.
 */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// buildPlannerWorkerArgv
// ---------------------------------------------------------------------------

/** Arguments for buildPlannerWorkerArgv. */
export interface PlannerWorkerArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/** Free-text task prompt sent to the planner agent. Will be shell-escaped. */
	taskPrompt: string;
	/**
	 * Claude permission mode forwarded to the spawned claude process (NEVER a
	 * cam CLI flag).
	 */
	permissionMode: string;
	/**
	 * Agent name matching the .claude/agents/<name>.md frontmatter.
	 * Defaults to 'subagent-planner'.
	 */
	agentName?: string;
	/**
	 * Model to pass as `--model` to the spawned claude process.
	 * Defaults to DEFAULTS.planner when absent. The caller (US-005) passes
	 * readPhaseModel('planner') so the project config is respected.
	 */
	model?: string;
	/**
	 * Worker isolation mode (US-001, CAM-242). Threaded into workerEnvPrefix so
	 * CLAUDE_CODE_OAUTH_TOKEN is stripped on 'host' only. Defaults to 'host'.
	 */
	isolation?: WorkerIsolation;
}

/**
 * Build the shell string passed to `respawn-pane` to launch an interactive
 * TUI planner worker.
 *
 * Returns a shell string with the shape:
 *
 *   env -u CLAUDECODE -u ... claude --permission-mode <mode> --session-id <uuid> \
 *     --model '<model>' --agent <agentName> '<taskPrompt>'
 *
 * The `env -u ...` prefix strips nesting-detection env vars (CAM-43).
 * -p and --output-format are omitted (CAM-42: subscription rule, interactive TUI only).
 */
export function buildPlannerWorkerArgv(opts: PlannerWorkerArgvOptions): string {
	const agentName = opts.agentName ?? DEFAULT_PLANNER_AGENT;
	const model = opts.model ?? DEFAULTS.planner;
	const isolation = opts.isolation ?? 'host';
	const escapedPrompt = shellEscape(opts.taskPrompt);
	return (
		workerEnvPrefix(isolation) +
		`claude` +
		` --permission-mode ${opts.permissionMode}` +
		` --session-id ${opts.uuid}` +
		` --model ${shellEscape(model)}` +
		` --agent ${agentName}` +
		` ${escapedPrompt}`
	);
}

// ---------------------------------------------------------------------------
// buildAuditorWorkerArgv
// ---------------------------------------------------------------------------

/** Arguments for buildAuditorWorkerArgv. */
export interface AuditorWorkerArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/** Free-text task prompt sent to the auditor agent. Will be shell-escaped. */
	taskPrompt: string;
	/**
	 * Claude permission mode forwarded to the spawned claude process (NEVER a
	 * cam CLI flag).
	 */
	permissionMode: string;
	/**
	 * Agent name matching the .claude/agents/<name>.md frontmatter.
	 * Defaults to 'subagent-auditor'.
	 */
	agentName?: string;
	/**
	 * Model to pass as `--model` to the spawned claude process.
	 * Defaults to DEFAULTS.auditor when absent. The caller (US-005) passes
	 * readPhaseModel('auditor') so the project config is respected.
	 */
	model?: string;
	/**
	 * Worker isolation mode (US-001, CAM-242). Threaded into workerEnvPrefix so
	 * CLAUDE_CODE_OAUTH_TOKEN is stripped on 'host' only. Defaults to 'host'.
	 */
	isolation?: WorkerIsolation;
}

/**
 * Build the shell string passed to `respawn-pane` to launch an interactive
 * TUI auditor worker.
 *
 * Returns a shell string with the shape:
 *
 *   env -u CLAUDECODE -u ... claude --permission-mode <mode> --session-id <uuid> \
 *     --model '<model>' --agent <agentName> '<taskPrompt>'
 *
 * The `env -u ...` prefix strips nesting-detection env vars (CAM-43).
 * -p and --output-format are omitted (CAM-42: subscription rule, interactive TUI only).
 */
export function buildAuditorWorkerArgv(opts: AuditorWorkerArgvOptions): string {
	const agentName = opts.agentName ?? DEFAULT_AUDITOR_AGENT;
	const model = opts.model ?? DEFAULTS.auditor;
	const isolation = opts.isolation ?? 'host';
	const escapedPrompt = shellEscape(opts.taskPrompt);
	return (
		workerEnvPrefix(isolation) +
		`claude` +
		` --permission-mode ${opts.permissionMode}` +
		` --session-id ${opts.uuid}` +
		` --model ${shellEscape(model)}` +
		` --agent ${agentName}` +
		` ${escapedPrompt}`
	);
}
