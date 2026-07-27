// src/supervisor/verified-dispatch.ts
//
// Shared verified tmux dispatch primitive (US-003, CAM-433).
//
// A tmux exit code alone is not proof that respawn-pane replaced the process
// in the pane. This helper records pane_pid before the relabel/respawn sequence,
// checks every tmux command result (including captured stderr), then reads
// pane_pid again. A non-zero command or unchanged identity is a terminal
// dispatch failure surfaced through all three observable channels: event,
// durable marker, and orchestrator notification.

import type { DispatchFailedMarker } from './dispatch-failed-marker.ts';
import type { DispatchFailedEventDetail, WorkerEventLogger } from './events.ts';
import type { SpawnFn, SpawnResult } from './loop.ts';

export type DispatchFailureReason =
	| 'pane-pid-before-exited'
	| 'pane-pid-before-empty'
	| 'set-option-exited'
	| 'respawn-pane-exited'
	| 'pane-pid-after-exited'
	| 'pane-pid-after-empty'
	| 'pane-pid-unchanged'
	| 'pipe-pane-exited';

export interface VerifiedDispatchOptions {
	spawnFn: SpawnFn;
	phase: string;
	paneId: string;
	uuid: string;
	dispatchCmd: string;
	pipeCommand: string;
	logEvent: WorkerEventLogger;
	writeDispatchFailedMarkerFn: (marker: DispatchFailedMarker) => void;
	notifyFn: (message: string) => void;
	storyId?: string;
	clock?: () => string;
}

export type VerifiedDispatchResult =
	| { ok: true; beforePanePid: string; afterPanePid: string }
	| { ok: false; marker: DispatchFailedMarker };

interface FailedStep {
	reason: DispatchFailureReason;
	result: SpawnResult;
}

type PanePidRead = { ok: true; panePid: string } | { ok: false; failure: FailedStep };

function normalizedExitCode(result: SpawnResult): number {
	return result.exitCode ?? 1;
}

function readPanePid(
	spawnFn: SpawnFn,
	paneId: string,
	position: 'before' | 'after',
): PanePidRead {
	const result = spawnFn('tmux', [
		'-L', 'cam', 'display-message', '-p', '-t', paneId, '#{pane_pid}',
	]);
	if (normalizedExitCode(result) !== 0) {
		return { ok: false, failure: { reason: `pane-pid-${position}-exited`, result } };
	}
	const panePid = result.stdout.trim();
	if (panePid === '') {
		return { ok: false, failure: { reason: `pane-pid-${position}-empty`, result } };
	}
	return { ok: true, panePid };
}

function failedCommand(reason: DispatchFailureReason, result: SpawnResult): FailedStep | null {
	return normalizedExitCode(result) === 0 ? null : { reason, result };
}

function emitDispatchFailure(
	opts: VerifiedDispatchOptions,
	failure: FailedStep,
): VerifiedDispatchResult {
	const timestamp = opts.clock?.() ?? new Date().toISOString();
	const stderr = failure.result.stderr ?? '';
	const marker: DispatchFailedMarker = {
		phase: opts.phase,
		paneId: opts.paneId,
		uuid: opts.uuid,
		exitCode: normalizedExitCode(failure.result),
		stderr,
		reason: failure.reason,
		timestamp,
	};
	const detail: DispatchFailedEventDetail = {
		phase: marker.phase,
		paneId: marker.paneId,
		exitCode: marker.exitCode,
		stderr: marker.stderr,
		reason: marker.reason,
	};

	// Each channel is attempted independently so one broken sink cannot silence
	// either of the other two observable terminals.
	try {
		opts.logEvent({
			ts: timestamp,
			storyId: opts.storyId,
			uuid: opts.uuid,
			kind: 'dispatch-failed',
			detail,
		});
	} catch {
		// Continue to the durable marker and live notification.
	}
	try {
		opts.writeDispatchFailedMarkerFn(marker);
	} catch {
		// Continue to the live notification.
	}
	try {
		const stderrSuffix = stderr.trim() === '' ? '' : `: ${stderr.trim()}`;
		opts.notifyFn(
			`[cam] ${opts.phase} dispatch failed (${failure.reason}, pane ${opts.paneId}, ` +
			`exit ${marker.exitCode})${stderrSuffix}`,
		);
	} catch {
		// The structured return still exposes the terminal to the caller.
	}
	return { ok: false, marker };
}

/**
 * Relabel, respawn, pipe output, and verify that the pane process changed.
 *
 * The identity read occurs before set-option because relabeling is not proof
 * of a respawn. The after-read occurs immediately after respawn-pane and
 * before pipe-pane, so a lying zero exit cannot be mistaken for success.
 */
export function runVerifiedDispatch(opts: VerifiedDispatchOptions): VerifiedDispatchResult {
	const before = readPanePid(opts.spawnFn, opts.paneId, 'before');
	if (!before.ok) return emitDispatchFailure(opts, before.failure);

	const labelResult = opts.spawnFn('tmux', [
		'-L', 'cam', 'set-option', '-p', '-t', opts.paneId, '@cam_label', opts.phase,
	]);
	const labelFailure = failedCommand('set-option-exited', labelResult);
	if (labelFailure !== null) return emitDispatchFailure(opts, labelFailure);

	const respawnResult = opts.spawnFn('tmux', [
		'-L', 'cam', 'respawn-pane', '-k', '-t', opts.paneId, opts.dispatchCmd,
	]);
	const respawnFailure = failedCommand('respawn-pane-exited', respawnResult);
	if (respawnFailure !== null) return emitDispatchFailure(opts, respawnFailure);

	const after = readPanePid(opts.spawnFn, opts.paneId, 'after');
	if (!after.ok) return emitDispatchFailure(opts, after.failure);
	if (after.panePid === before.panePid) {
		return emitDispatchFailure(opts, { reason: 'pane-pid-unchanged', result: respawnResult });
	}

	const pipeResult = opts.spawnFn('tmux', [
		'-L', 'cam', 'pipe-pane', '-t', opts.paneId, opts.pipeCommand,
	]);
	const pipeFailure = failedCommand('pipe-pane-exited', pipeResult);
	if (pipeFailure !== null) return emitDispatchFailure(opts, pipeFailure);

	return { ok: true, beforePanePid: before.panePid, afterPanePid: after.panePid };
}
