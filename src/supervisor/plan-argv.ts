// src/supervisor/plan-argv.ts
//
// Pure argv builders for launching subagent-planner and subagent-auditor
// as interactive TUI worker panes within the plan-runner.
//
// These builders mirror buildImplementerWorkerArgv (worker-argv.ts) and
// buildReviewerWorkerArgv (review.ts): same env-strip + shell-escape pattern
// (CAM-43 + CAM-42). NOT pure: each delegates to ClaudeAdapter.buildSpawnArgv,
// which writes the task prompt to a per-dispatch file on disk (reaping any
// prior prompt-file siblings) as a side effect of building the argv string
// (US-001, CAM-433, task-prompt-file.ts).
//
// Design decisions:
//   - No -p, no --output-format: subscription rule (CAM-42).
//   - Default agent names match .claude/agents/ frontmatter `name` fields.
//   - Models default to DEFAULTS.planner / DEFAULTS.auditor; the CALLER
//     (US-005) passes readPhaseModel('planner'/'auditor') at spawn time.
//   - The shell string format:
//       env -u CLAUDECODE -u ... claude --permission-mode <mode>
//         --session-id <uuid> --model '<model>' --agent <agent> \
//         "$(cat -- '<taskPromptFilePath>')"
//   - US-003 (CAM-339): buildPlannerWorkerArgv / buildAuditorWorkerArgv are
//     now thin wrappers over ClaudeAdapter.buildSpawnArgv (backend-adapter.ts),
//     which resolves the adapter per-actor and holds the actual assembly
//     (env-strip prefix, shell-escape, agent/model defaults). DEFAULT_PLANNER_AGENT
//     and DEFAULT_AUDITOR_AGENT are re-exported from there for existing
//     callers/tests that import them from this file.

import type { WorkerIsolation } from '../config/models.ts';
import { ClaudeAdapter } from './backend-adapter.ts';

export { DEFAULT_PLANNER_AGENT, DEFAULT_AUDITOR_AGENT } from './backend-adapter.ts';

// ---------------------------------------------------------------------------
// buildPlannerWorkerArgv
// ---------------------------------------------------------------------------

/** Arguments for buildPlannerWorkerArgv. */
export interface PlannerWorkerArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/** Free-text task prompt sent to the planner via a per-dispatch file. */
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
 *     --model '<model>' --agent <agentName> "$(cat -- '<taskPromptFilePath>')"
 *
 * The `env -u ...` prefix strips nesting-detection env vars (CAM-43).
 * -p and --output-format are omitted (CAM-42: subscription rule, interactive TUI only).
 * `taskPrompt` is written to a per-dispatch file (task-prompt-file.ts,
 * US-001/CAM-433) rather than embedded in the argv; the returned string
 * carries a `"$(cat -- '<path>')"` snippet that reads it back at exec time.
 *
 * US-003 (CAM-339): thin wrapper resolving the 'planner' actor and delegating
 * to ClaudeAdapter.buildSpawnArgv for the actual assembly.
 */
export function buildPlannerWorkerArgv(opts: PlannerWorkerArgvOptions): string {
	return new ClaudeAdapter().buildSpawnArgv('planner', opts);
}

// ---------------------------------------------------------------------------
// buildAuditorWorkerArgv
// ---------------------------------------------------------------------------

/** Arguments for buildAuditorWorkerArgv. */
export interface AuditorWorkerArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/** Free-text task prompt sent to the auditor via a per-dispatch file. */
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
 *     --model '<model>' --agent <agentName> "$(cat -- '<taskPromptFilePath>')"
 *
 * The `env -u ...` prefix strips nesting-detection env vars (CAM-43).
 * -p and --output-format are omitted (CAM-42: subscription rule, interactive TUI only).
 * `taskPrompt` is written to a per-dispatch file (task-prompt-file.ts,
 * US-001/CAM-433) rather than embedded in the argv; the returned string
 * carries a `"$(cat -- '<path>')"` snippet that reads it back at exec time.
 *
 * US-003 (CAM-339): thin wrapper resolving the 'auditor' actor and delegating
 * to ClaudeAdapter.buildSpawnArgv for the actual assembly.
 */
export function buildAuditorWorkerArgv(opts: AuditorWorkerArgvOptions): string {
	return new ClaudeAdapter().buildSpawnArgv('auditor', opts);
}
