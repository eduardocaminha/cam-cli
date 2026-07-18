// src/supervisor/backend-adapter.ts
//
// BackendAdapter seam (US-002, CAM-54/339). Design record: ADR-0047
// (docs/adr/0047-backendadapter-seam-methods-vs-inputs-vs-shared-contract-and-the-six-mismatch-resolution.md).
//
// ADR-0047 fixes the seam as ONE concrete adapter method:
//
//   buildSpawnArgv(actor, opts): string
//
// where `model`, `agentName`, `permissionMode`, and the env-unset prefix are
// INPUTS threaded through opts, not separate adapter methods. Completion
// detection (worker report / sentinel text parsing) is explicitly a SHARED
// CONTRACT that lives outside the adapter (see ADR-0038) and must never be
// added here.
//
// This story does NOT reroute the four existing call sites (worker-argv.ts,
// plan-argv.ts, review.ts): ClaudeAdapter reuses those pure builders
// internally so behavior is guaranteed byte-for-byte identical (no
// reimplementation of workerEnvPrefix / the env-strip list), and is proven
// by a golden characterization test per actor.

import { buildImplementerWorkerArgv } from './worker-argv.ts';
import { buildPlannerWorkerArgv, buildAuditorWorkerArgv } from './plan-argv.ts';
import { buildReviewerWorkerArgv } from './review.ts';
import type { WorkerIsolation } from '../config/models.ts';

/** The four worker actors in scope for the seam (ADR-0046/0047). */
export type WorkerActor = 'implementer' | 'planner' | 'auditor' | 'reviewer';

/**
 * Shared input shape for buildSpawnArgv, covering every value that varies
 * per call site across the four actors today. `taskPrompt` and
 * `permissionMode` are required for implementer/planner/auditor and optional
 * for reviewer (which has its own defaults, mirroring
 * ReviewerWorkerArgvOptions).
 */
export interface SpawnArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/**
	 * Free-text task prompt sent to the agent. Will be shell-escaped.
	 * Required for implementer/planner/auditor; optional for reviewer
	 * (defaults to REVIEWER_TASK_PROMPT).
	 */
	taskPrompt?: string;
	/**
	 * Claude permission mode forwarded to the spawned process (NEVER a cam CLI
	 * flag). Required for implementer/planner/auditor; optional for reviewer
	 * (defaults to 'bypassPermissions').
	 */
	permissionMode?: string;
	/** Agent name matching the .claude/agents/<name>.md frontmatter. */
	agentName?: string;
	/** Model to pass as `--model` to the spawned process. */
	model?: string;
	/**
	 * Worker isolation mode (US-001, CAM-242): threads into the env-unset
	 * prefix so CLAUDE_CODE_OAUTH_TOKEN is stripped on 'host' only.
	 */
	isolation?: WorkerIsolation;
}

/**
 * BackendAdapter: the seam between the supervisor and whatever CLI actually
 * gets spawned for a worker actor. Exposes exactly one concrete method
 * (ADR-0047): every per-actor/per-call-site variation is an INPUT to that
 * method, not a method of its own. Completion detection is deliberately
 * NOT part of this interface (shared contract, lives outside the adapter).
 */
export interface BackendAdapter {
	/**
	 * Build the shell string passed to `respawn-pane` to launch an
	 * interactive TUI worker for `actor`.
	 */
	buildSpawnArgv(actor: WorkerActor, opts: SpawnArgvOptions): string;
}

/**
 * Throws when a required field for the given actor is missing. Implementer,
 * planner, and auditor all require taskPrompt + permissionMode (their
 * existing builders take these as required fields); reviewer defaults both.
 */
function requireForNonReviewerActor(
	actor: 'implementer' | 'planner' | 'auditor',
	opts: SpawnArgvOptions,
): { taskPrompt: string; permissionMode: string } {
	if (opts.taskPrompt === undefined) {
		throw new Error(`buildSpawnArgv: taskPrompt is required for actor '${actor}'`);
	}
	if (opts.permissionMode === undefined) {
		throw new Error(`buildSpawnArgv: permissionMode is required for actor '${actor}'`);
	}
	return { taskPrompt: opts.taskPrompt, permissionMode: opts.permissionMode };
}

/**
 * ClaudeAdapter: the claude-CLI implementation of BackendAdapter. Reuses the
 * existing pure argv builders (worker-argv.ts, plan-argv.ts, review.ts)
 * verbatim per actor so the seam is locked to today's behavior byte-for-byte
 * (see test/supervisor/backend-adapter.test.ts).
 */
export class ClaudeAdapter implements BackendAdapter {
	buildSpawnArgv(actor: WorkerActor, opts: SpawnArgvOptions): string {
		switch (actor) {
			case 'implementer': {
				const required = requireForNonReviewerActor('implementer', opts);
				return buildImplementerWorkerArgv({
					uuid: opts.uuid,
					taskPrompt: required.taskPrompt,
					permissionMode: required.permissionMode,
					agentName: opts.agentName,
					model: opts.model,
					isolation: opts.isolation,
				});
			}
			case 'planner': {
				const required = requireForNonReviewerActor('planner', opts);
				return buildPlannerWorkerArgv({
					uuid: opts.uuid,
					taskPrompt: required.taskPrompt,
					permissionMode: required.permissionMode,
					agentName: opts.agentName,
					model: opts.model,
					isolation: opts.isolation,
				});
			}
			case 'auditor': {
				const required = requireForNonReviewerActor('auditor', opts);
				return buildAuditorWorkerArgv({
					uuid: opts.uuid,
					taskPrompt: required.taskPrompt,
					permissionMode: required.permissionMode,
					agentName: opts.agentName,
					model: opts.model,
					isolation: opts.isolation,
				});
			}
			case 'reviewer':
				return buildReviewerWorkerArgv({
					uuid: opts.uuid,
					taskPrompt: opts.taskPrompt,
					permissionMode: opts.permissionMode,
					agentName: opts.agentName,
					model: opts.model,
					isolation: opts.isolation,
				});
		}
	}
}
