// src/supervisor/worker-dispatch.ts
//
// Shared lifecycle wrapper for implementer/reviewer verified tmux dispatches
// (US-005, CAM-433). Keeps prompt cleanup, output piping, durable failure
// sinks, and stale-marker convergence identical across both worker phases.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DispatchFailedMarker } from './dispatch-failed-marker.ts';
import type { WorkerEventLogger } from './events.ts';
import type { SpawnFn } from './loop.ts';
import { removeTaskPromptFile } from './task-prompt-file.ts';
import {
	runVerifiedDispatch,
	type VerifiedDispatchResult,
} from './verified-dispatch.ts';

export interface WorkerDispatchLifecycleOptions {
	spawnFn: SpawnFn;
	phase: string;
	paneId: string;
	uuid: string;
	dispatchCmd: string;
	claudeDir?: string;
	storyId?: string;
	logEvent?: WorkerEventLogger;
	writeDispatchFailedMarkerFn?: (marker: DispatchFailedMarker) => void;
	removeDispatchFailedMarkerFn?: () => void;
	notifyFn?: (message: string) => void;
	removeTaskPromptFileFn?: (uuid: string) => void;
	/** See VerifiedDispatchOptions.label (US-R1-005): defaults to `phase`. */
	label?: string;
}

function effectiveClaudeDir(claudeDir: string | undefined): string {
	return claudeDir ?? join(tmpdir(), `cam-cli-task-prompts-${process.pid}`, '.claude');
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function workerOutLogPath(opts: WorkerDispatchLifecycleOptions): string {
	return join(effectiveClaudeDir(opts.claudeDir), `cam-worker-out-${opts.phase}-${opts.uuid}.log`);
}

/** Remove this dispatch's own prompt without masking its terminal outcome. */
export function removeWorkerTaskPrompt(
	opts: Pick<WorkerDispatchLifecycleOptions, 'claudeDir' | 'removeTaskPromptFileFn'>,
	uuid: string,
): void {
	try {
		if (opts.removeTaskPromptFileFn !== undefined) {
			opts.removeTaskPromptFileFn(uuid);
			return;
		}
		removeTaskPromptFile(effectiveClaudeDir(opts.claudeDir), uuid);
	} catch {
		// Cleanup is best-effort and idempotent; terminal observability still runs.
	}
}

/**
 * Dispatch a worker through mandatory pane identity verification.
 *
 * A failed dispatch owns prompt cleanup. A successful dispatch clears stale
 * dispatch-failed evidence only after pane_pid changed and pipe-pane exited 0.
 */
export function runVerifiedWorkerDispatch(
	opts: WorkerDispatchLifecycleOptions,
): VerifiedDispatchResult {
	const result = runVerifiedDispatch({
		spawnFn: opts.spawnFn,
		phase: opts.phase,
		paneId: opts.paneId,
		uuid: opts.uuid,
		dispatchCmd: opts.dispatchCmd,
		pipeCommand: `cat >> ${shellQuote(workerOutLogPath(opts))}`,
		logEvent: opts.logEvent ?? ((): void => {}),
		writeDispatchFailedMarkerFn: opts.writeDispatchFailedMarkerFn ?? ((): void => {}),
		notifyFn: opts.notifyFn ?? ((): void => {}),
		storyId: opts.storyId,
		label: opts.label,
	});
	if (!result.ok) {
		removeWorkerTaskPrompt(opts, opts.uuid);
		return result;
	}
	try {
		opts.removeDispatchFailedMarkerFn?.();
	} catch {
		// Stale-evidence cleanup is best-effort after verified convergence.
	}
	return result;
}

/**
 * Replace a stuck worker with a sentinel command through the same checked path.
 *
 * Unlike a successful worker dispatch, a sentinel must not clear durable
 * evidence: it is itself a terminal/retry boundary, not dispatch convergence.
 */
export function runCheckedWorkerSentinel(
	opts: Omit<WorkerDispatchLifecycleOptions, 'dispatchCmd'>,
	dispatchCmd: string,
): VerifiedDispatchResult {
	removeWorkerTaskPrompt(opts, opts.uuid);
	return runVerifiedDispatch({
		spawnFn: opts.spawnFn,
		phase: opts.phase,
		paneId: opts.paneId,
		uuid: opts.uuid,
		dispatchCmd,
		pipeCommand: `cat >> ${shellQuote(workerOutLogPath({ ...opts, dispatchCmd }))}`,
		logEvent: opts.logEvent ?? ((): void => {}),
		writeDispatchFailedMarkerFn: opts.writeDispatchFailedMarkerFn ?? ((): void => {}),
		notifyFn: opts.notifyFn ?? ((): void => {}),
		storyId: opts.storyId,
		label: opts.label,
	});
}
