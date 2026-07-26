// src/commands/orch-resolve.ts
//
// `cam orch-resolve` (US-001, CAM-425): a deterministic {model, backend,
// effort} resolver for the orchestrator wrapper. Re-reads project.toml on
// every invocation so the bounded self-handoff respawn loop can pick up
// config edits without forking `resolvePhaseModel`'s rules (CAM-398 nested
// [models.codex] pin, flat-pin policy, models_cache auto-resolve, claude
// typo-guard) into bash.
//
// On success: prints exactly ONE JSON line
//   {"model":...,"backend":...,"effort":...}
// to stdout, emits a 'spawn-resolution' event (US-001 AC3), and returns exit
// code 0. On a not-ok model resolution: prints the resolution message to
// stderr, nothing to stdout, and returns exit code 1.

import { join } from 'node:path';
import process from 'node:process';

import { resolvePhaseModel } from '../config/model-resolution.ts';
import type { CodexModelsCacheReader } from '../config/codex-models-cache.ts';
import { readBackend, readPhaseEffort } from '../config/models.ts';
import { emitSpawnResolution } from '../logging/spawn-resolution.ts';
import { makeFileEventLogger } from '../supervisor/events.ts';
import type { WorkerEventLogger } from '../supervisor/events.ts';

export interface RunOrchResolveOptions {
	/**
	 * Override the config file path (default: `scripts/cam/project.toml`
	 * resolved from `process.cwd()`). Used by tests to target a staged
	 * fixture instead of the live project.toml.
	 */
	configPath?: string;
	/**
	 * Injectable codex models-cache reader (DI seam), forwarded to
	 * `resolvePhaseModel`. Defaults to the real `~/.codex/models_cache.json`
	 * reader when omitted.
	 */
	cacheReader?: CodexModelsCacheReader;
	/**
	 * Project root, used only to derive the default event-log path
	 * (`<cwd>/.claude/cam-worker-events.jsonl`). Default: `process.cwd()`.
	 */
	cwd?: string;
	/**
	 * Injectable event sink (DI seam). Default: `makeFileEventLogger` writing
	 * to `.claude/cam-worker-events.jsonl` under `cwd`. Tests inject
	 * `makeInMemoryEventLogger()`'s logger to assert on emitted events without
	 * touching the filesystem.
	 */
	logEvent?: WorkerEventLogger;
	/** Output writer for the success JSON line. Default: `process.stdout.write`. */
	write?: (s: string) => void;
	/** Error writer for the failure message. Default: `process.stderr.write`. */
	writeError?: (s: string) => void;
}

/** Implementation of `cam orch-resolve`. Returns the process exit code. */
export function runOrchResolve(options: RunOrchResolveOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const { configPath, cacheReader } = options;
	const write =
		options.write ??
		((s: string) => {
			process.stdout.write(s);
		});
	const writeError =
		options.writeError ??
		((s: string) => {
			process.stderr.write(s);
		});
	const logEvent =
		options.logEvent ?? makeFileEventLogger(join(cwd, '.claude', 'cam-worker-events.jsonl'));

	const backend = readBackend(configPath);
	const modelResolution = resolvePhaseModel({ phase: 'orchestrator', backend, configPath, cacheReader });
	if (!modelResolution.ok) {
		writeError(`${modelResolution.message}\n`);
		return 1;
	}
	const model = modelResolution.model;
	const effort = readPhaseEffort('orchestrator', configPath);

	// US-001 (CAM-425) AC3: emit a spawn-resolution event on every successful
	// resolution (unlike run.ts's one-shot emission at `cam run` setup time),
	// so a respawn triggered by the bash wrapper is auditable too.
	emitSpawnResolution({
		phase: 'orchestrator',
		model,
		backend,
		effort,
		writeEvent: (e) =>
			logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'orch-resolve',
				kind: 'spawn-resolution',
				detail: e,
			}),
	});

	write(`${JSON.stringify({ model, backend, effort })}\n`);
	return 0;
}
