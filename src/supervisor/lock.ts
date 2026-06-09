// src/supervisor/lock.ts
//
// Single-supervisor concurrency guard (US-015).
//
// Only one supervisor may drive a project's loop at a time. On start the
// supervisor writes .claude/.cam-supervisor.lock with { pid, startedAt,
// project }. A second supervisor that finds a lock whose recorded pid is still
// alive refuses to start. A lock whose pid is dead (the previous supervisor
// crashed) is "stale": the new supervisor logs a stale-lock event (US-013) and
// takes the lock over.
//
// Design: pure over an injected LockIo (read/write/remove/pidAlive/clock plus
// an optional event sink) so all three scenarios are unit-testable without
// touching the filesystem or real process signals. The real fs/process-backed
// adapters and the SIGINT/SIGTERM shutdown handler are wired in
// src/commands/next.ts.

import type { WorkerEventLogger } from './events.ts';

/** Contents persisted to .claude/.cam-supervisor.lock. */
export interface SupervisorLockInfo {
	/** PID of the supervisor process that owns the lock. */
	pid: number;
	/** ISO timestamp the lock was acquired. */
	startedAt: string;
	/** Project identifier (the cam session name). */
	project: string;
}

/** Injected I/O for acquireSupervisorLock. */
export interface LockIo {
	/** Read the raw lock-file contents, or null when the file is absent. */
	read: () => string | null;
	/** Write the raw lock-file contents (create the parent dir if needed). */
	write: (content: string) => void;
	/** Remove the lock file. MUST be idempotent (ignore "already gone"). */
	remove: () => void;
	/** Signal-0 liveness probe: true when a process with `pid` is alive. */
	pidAlive: (pid: number) => boolean;
	/** Current ISO timestamp. */
	clock: () => string;
	/** Optional structured event sink (US-013) for the stale-lock event. */
	logEvent?: WorkerEventLogger;
}

/** Result of acquireSupervisorLock. */
export type AcquireLockResult =
	| { acquired: true; info: SupervisorLockInfo; release: () => void }
	| { acquired: false; holderPid: number };

/** Filename within `.claude/` where the supervisor lock is persisted. */
export const SUPERVISOR_LOCK_FILE = '.cam-supervisor.lock';

/**
 * Parse + shape-check the lock-file contents.
 * Returns null when the text is not valid JSON or lacks a finite numeric pid.
 */
export function parseLockInfo(text: string): SupervisorLockInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj['pid'] !== 'number' || !Number.isFinite(obj['pid'])) return null;
	return {
		pid: obj['pid'],
		startedAt: typeof obj['startedAt'] === 'string' ? obj['startedAt'] : '',
		project: typeof obj['project'] === 'string' ? obj['project'] : '',
	};
}

/**
 * Acquire the single-supervisor lock for `pid` / `project`.
 *
 *   - No lock (or an unparseable lock): take it.
 *   - Lock held by a DIFFERENT, live pid: refuse ({ acquired: false }).
 *   - Lock held by a dead pid (stale): log a stale-lock event, then take over.
 *
 * On success returns a release() that removes the lock (idempotent).
 */
export function acquireSupervisorLock(
	pid: number,
	project: string,
	io: LockIo,
): AcquireLockResult {
	const existing = io.read();
	if (existing !== null) {
		const info = parseLockInfo(existing);
		// A live lock owned by another process blocks us.
		if (info !== null && info.pid !== pid && io.pidAlive(info.pid)) {
			return { acquired: false, holderPid: info.pid };
		}
		// A parseable lock whose owner is dead is stale: record the takeover.
		if (info !== null && info.pid !== pid && !io.pidAlive(info.pid)) {
			io.logEvent?.({
				ts: io.clock(),
				storyId: undefined,
				uuid: 'supervisor',
				kind: 'stale-lock',
				detail: { takenOverPid: info.pid, ownPid: pid, project },
			});
		}
		// An unparseable lock falls through to overwrite with no event (no pid to report).
	}

	const info: SupervisorLockInfo = { pid, startedAt: io.clock(), project };
	io.write(JSON.stringify(info));
	return { acquired: true, info, release: () => io.remove() };
}
