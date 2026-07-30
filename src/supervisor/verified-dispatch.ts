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
	| 'pipe-pane-exited'
	/**
	 * Shared early-death literal (US-001, CAM-479): the worker session died on
	 * or before its first turn (e.g. a first-turn API error), a distinct
	 * observable terminal from a work timeout. Every phase that detects an
	 * early death reuses this one literal instead of inventing an ad hoc label.
	 */
	| 'session-died-early';

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
	/**
	 * Extracted cause text for this dispatch attempt (US-001, CAM-479), e.g. a
	 * transcript-derived early-death reason. Threaded verbatim into the marker,
	 * the dispatch-failed event detail, and the notification so the three
	 * observable channels never disagree. Absent when no caller has extracted
	 * a cause yet (this story adds vocabulary + plumbing only).
	 */
	cause?: string;
	/**
	 * The `@cam_label` value set on the pane before respawn (US-R1-005,
	 * CAM-433 review round 1). Defaults to `phase` for backward compat, but a
	 * sentinel dispatch (timeout / token-ceiling) passes a failure-reason
	 * string as `phase` (e.g. 'implementer-timeout') that `isSessionStale`
	 * (src/tmux/session.ts) does not recognize as a worker label. Leaving that
	 * reason string on the pane after a sentinel respawn would make a healthy
	 * 3-pane session look stale on the next `cam run`, tearing down the live
	 * orchestrator+dashboard panes along with it. Callers that dispatch a
	 * sentinel must pass the pane's actual worker role here so the label
	 * always reflects "what this pane is", not "why it was last respawned".
	 */
	label?: string;
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

/**
 * Narrow shape of VerifiedDispatchOptions actually consumed by
 * emitDispatchFailure (phase/paneId/uuid/logEvent/marker-writer/notifier/
 * storyId/clock/cause). VerifiedDispatchOptions remains a structural subtype
 * (its extra spawnFn/dispatchCmd/pipeCommand fields are simply unused by the
 * emitter), and this narrower shape is also the public contract for
 * emitEarlyDeathTerminal below (US-003, CAM-479): a caller that has no tmux
 * dispatch details at all -- only a transcript-derived death verdict -- can
 * still drive the exact same three-channel emission.
 */
export interface DispatchFailureEmitOptions {
	phase: string;
	paneId: string;
	uuid: string;
	logEvent: WorkerEventLogger;
	writeDispatchFailedMarkerFn: (marker: DispatchFailedMarker) => void;
	notifyFn: (message: string) => void;
	storyId?: string;
	clock?: () => string;
	cause?: string;
}

function emitDispatchFailure(
	opts: DispatchFailureEmitOptions,
	failure: FailedStep,
): { ok: false; marker: DispatchFailedMarker } {
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
		...(opts.cause !== undefined ? { cause: opts.cause } : {}),
	};
	const detail: DispatchFailedEventDetail = {
		phase: marker.phase,
		paneId: marker.paneId,
		exitCode: marker.exitCode,
		stderr: marker.stderr,
		reason: marker.reason,
		...(marker.cause !== undefined ? { cause: marker.cause } : {}),
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
		const causeSuffix = marker.cause === undefined || marker.cause.trim() === ''
			? ''
			: `: ${marker.cause.trim()}`;
		const stderrSuffix = stderr.trim() === '' ? '' : `: ${stderr.trim()}`;
		opts.notifyFn(
			`[cam] ${opts.phase} dispatch failed (${failure.reason}, pane ${opts.paneId}, ` +
			`exit ${marker.exitCode})${causeSuffix}${stderrSuffix}`,
		);
	} catch {
		// The structured return still exposes the terminal to the caller.
	}
	return { ok: false, marker };
}

/**
 * Emit the cause-bearing early-death terminal on all three observable
 * channels (dispatch-failed event, durable marker, orchestrator notification;
 * US-003, CAM-479). The reason recorded is always the shared
 * 'session-died-early' literal; `cause` carries the verbatim transcript text
 * extracted by the early-death detector (src/supervisor/early-death.ts).
 *
 * Unlike every other emitDispatchFailure call site, this one is not reporting
 * a failed tmux command: it is invoked once the poll loop's own transcript
 * probe -- not a tmux exit code -- has already decided the session is dead.
 * exitCode/stderr are synthesized as 0/'' since there is no real command
 * result to report; the reason and cause are what matters here.
 */
export function emitEarlyDeathTerminal(opts: DispatchFailureEmitOptions): DispatchFailedMarker {
	const { marker } = emitDispatchFailure(opts, {
		reason: 'session-died-early',
		result: { stdout: '', exitCode: 0, stderr: '' },
	});
	return marker;
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
		'-L', 'cam', 'set-option', '-p', '-t', opts.paneId, '@cam_label', opts.label ?? opts.phase,
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
