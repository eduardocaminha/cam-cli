// src/supervisor/sidecar-pid.ts
//
// Helpers for persisting and reading the sidecar process PID so that
// `cam stop` can send SIGTERM to an idle sidecar that holds no supervisor
// lock (the lock is only acquired in the active branch of runSidecarLoop).
//
// Pattern: mirrors WORKER_PANE_MARKER (session.ts) and SUPERVISOR_LOCK_FILE
// (lock.ts). A single constant names the file; three tiny helpers wrap the
// read/write/remove cycle with try/catch (never throw to callers).
//
// Signal-0 liveness probe: `process.kill(pid, 0)` throws when the pid is dead;
// wrap in try/catch (see lock.ts:38-44 comment for the same idiom).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Filename within `.claude/` where the sidecar spawn-time PID is persisted. */
export const SIDECAR_PID_FILE = '.cam-sidecar.pid';

/**
 * Persist the sidecar pid to `<claudeDir>/.cam-sidecar.pid`.
 *
 * `claudeDir` is typically `<cwd>/.claude`. Creates the directory if absent.
 * The file contains the bare decimal pid string, no trailing newline.
 */
export function writeSidecarPid(claudeDir: string, pid: number): void {
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, SIDECAR_PID_FILE), String(pid), 'utf8');
}

/**
 * Read the sidecar pid from `<claudeDir>/.cam-sidecar.pid`.
 *
 * Returns the pid as a number, or `null` when the file is absent, empty, or
 * does not contain a valid positive integer. Never throws.
 */
export function readSidecarPid(claudeDir: string): number | null {
	try {
		const content = readFileSync(join(claudeDir, SIDECAR_PID_FILE), 'utf8').trim();
		const pid = parseInt(content, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Remove the sidecar pid file. Idempotent: silently ignores "already gone".
 * Never throws.
 */
export function removeSidecarPid(claudeDir: string): void {
	try {
		unlinkSync(join(claudeDir, SIDECAR_PID_FILE));
	} catch {
		// already gone or never written
	}
}

/**
 * Signal-0 liveness probe: returns `true` when a process with `pid` exists.
 * `process.kill(pid, 0)` throws when the pid is dead (ESRCH) or access is
 * denied (EPERM, which still means the process exists on POSIX). We treat
 * EPERM as alive (conservative) and any other error as dead.
 */
export function sidecarPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: process exists but we lack permission to signal it -> alive.
		if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM') {
			return true;
		}
		return false;
	}
}

/**
 * Remove the pid file only when it exists (existsSync-guarded). Used by the
 * cleanup path in run.ts to avoid ENOENT noise if the file was never written.
 */
export function removeSidecarPidIfExists(claudeDir: string): void {
	if (existsSync(join(claudeDir, SIDECAR_PID_FILE))) {
		removeSidecarPid(claudeDir);
	}
}

/**
 * Composite liveness check for the sidecar (US-002, CAM-207).
 *
 * Returns `true` when `.claude/.cam-sidecar.pid` exists, contains a valid
 * positive-integer pid, and signal-0 confirms the process is alive.
 * Returns `false` when the pid file is absent, unparseable, or the process
 * is dead. Never throws. Mirrors `watcherAlive` below.
 */
export function sidecarAlive(claudeDir: string): boolean {
	const pid = readSidecarPid(claudeDir);
	if (pid === null) return false;
	return sidecarPidAlive(pid);
}

// ---------------------------------------------------------------------------
// Recycle watcher PID (mirrors the sidecar PID pattern above)
// ---------------------------------------------------------------------------

/** Filename within `.claude/` where the recycle watcher spawn-time PID is persisted. */
export const WATCHER_PID_FILE = '.cam-watcher.pid';

/**
 * Persist the recycle watcher pid to `<claudeDir>/.cam-watcher.pid`.
 *
 * Called immediately after `spawnWatcherFn` returns so `cam stop` can SIGTERM
 * the watcher even when it is idle (no supervisor lock held by the watcher).
 */
export function writeWatcherPid(claudeDir: string, pid: number): void {
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, WATCHER_PID_FILE), String(pid), 'utf8');
}

/**
 * Read the recycle watcher pid from `<claudeDir>/.cam-watcher.pid`.
 *
 * Returns the pid as a number, or `null` when the file is absent, empty, or
 * does not contain a valid positive integer. Never throws.
 */
export function readWatcherPid(claudeDir: string): number | null {
	try {
		const content = readFileSync(join(claudeDir, WATCHER_PID_FILE), 'utf8').trim();
		const pid = parseInt(content, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Remove the watcher pid file. Idempotent: silently ignores "already gone".
 * Never throws.
 */
export function removeWatcherPid(claudeDir: string): void {
	try {
		unlinkSync(join(claudeDir, WATCHER_PID_FILE));
	} catch {
		// already gone or never written
	}
}

/**
 * Remove the watcher pid file only when it exists (existsSync-guarded). Used
 * by the cleanup path in run.ts to avoid ENOENT noise if the file was never
 * written.
 */
export function removeWatcherPidIfExists(claudeDir: string): void {
	if (existsSync(join(claudeDir, WATCHER_PID_FILE))) {
		removeWatcherPid(claudeDir);
	}
}

/**
 * Composite liveness check for the recycle watcher.
 *
 * Returns `true` when `.claude/.cam-watcher.pid` exists, contains a valid
 * positive-integer pid, and signal-0 confirms the process is alive.
 * Returns `false` when the pid file is absent, unparseable, or the process
 * is dead. Never throws.
 */
export function watcherAlive(claudeDir: string): boolean {
	const pid = readWatcherPid(claudeDir);
	if (pid === null) return false;
	return sidecarPidAlive(pid);
}

// ---------------------------------------------------------------------------
// Sidecar-liveness watcher PID (US-002, CAM-207; mirrors the recycle watcher
// PID pattern above)
// ---------------------------------------------------------------------------

/** Filename within `.claude/` where the sidecar-liveness watcher spawn-time PID is persisted. */
export const SIDECAR_LIVENESS_WATCHER_PID_FILE = '.cam-sidecar-liveness-watcher.pid';

/**
 * Persist the sidecar-liveness watcher pid to `<claudeDir>/.cam-sidecar-liveness-watcher.pid`.
 *
 * Called immediately after `spawnSidecarLivenessWatchFn` returns so `cam stop`
 * can SIGTERM the watcher even when it is idle.
 */
export function writeSidecarLivenessWatcherPid(claudeDir: string, pid: number): void {
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, SIDECAR_LIVENESS_WATCHER_PID_FILE), String(pid), 'utf8');
}

/**
 * Read the sidecar-liveness watcher pid from `<claudeDir>/.cam-sidecar-liveness-watcher.pid`.
 *
 * Returns the pid as a number, or `null` when the file is absent, empty, or
 * does not contain a valid positive integer. Never throws.
 */
export function readSidecarLivenessWatcherPid(claudeDir: string): number | null {
	try {
		const content = readFileSync(join(claudeDir, SIDECAR_LIVENESS_WATCHER_PID_FILE), 'utf8').trim();
		const pid = parseInt(content, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Remove the sidecar-liveness watcher pid file. Idempotent: silently ignores
 * "already gone". Never throws.
 */
export function removeSidecarLivenessWatcherPid(claudeDir: string): void {
	try {
		unlinkSync(join(claudeDir, SIDECAR_LIVENESS_WATCHER_PID_FILE));
	} catch {
		// already gone or never written
	}
}

/**
 * Remove the sidecar-liveness watcher pid file only when it exists
 * (existsSync-guarded). Used by the cleanup path in run.ts to avoid ENOENT
 * noise if the file was never written.
 */
export function removeSidecarLivenessWatcherPidIfExists(claudeDir: string): void {
	if (existsSync(join(claudeDir, SIDECAR_LIVENESS_WATCHER_PID_FILE))) {
		removeSidecarLivenessWatcherPid(claudeDir);
	}
}
