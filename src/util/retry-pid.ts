// src/util/retry-pid.ts
//
// Helpers to manage the retry-monitor PID file at ~/.cam/retry.pid.
//
// The PID file records the OS PID of the most-recently-forked retry-monitor
// child so that cam resume (US-007) can detect whether a monitor is still
// alive without relying on the external `claude-auto-retry` binary.
//
// Single-file convention: one global file per user at ~/.cam/retry.pid.
// Projects with concurrent monitors would need a per-project path — that is
// an explicit non-goal for this story.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// PID file path
// ---------------------------------------------------------------------------

/**
 * The absolute path of the retry-monitor PID file.
 *
 * Exposed as a constant so callers can reference the path without coupling to
 * the implementation detail; cam resume (US-007) reads it via this export.
 */
export function retryPidPath(): string {
	return join(homedir(), '.cam', 'retry.pid');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write `pid` to the retry PID file. Creates `~/.cam/` if it does not exist.
 *
 * Overwrites any previously written PID — a new monitor supersedes the old one.
 */
export function writeRetryPid(pid: number): void {
	const path = retryPidPath();
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, String(pid) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the PID from the retry PID file.
 *
 * Returns the PID as a number, or `null` when:
 *   - the file does not exist, or
 *   - the file content is not a valid integer.
 */
export function readRetryPid(): number | null {
	const path = retryPidPath();
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, 'utf8').trim();
		const pid = parseInt(raw, 10);
		if (!Number.isInteger(pid) || pid <= 0) return null;
		return pid;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Liveness check
// ---------------------------------------------------------------------------

/**
 * Return `true` if the given PID refers to a live process.
 *
 * Uses `process.kill(pid, 0)` — which does NOT send a signal but throws
 * `ESRCH` when the PID is dead or `EPERM` when the process exists but is
 * owned by a different user (still "alive" for our purposes).
 */
export function isRetryPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		// ESRCH: no such process — dead.
		// EPERM: permission denied — process exists but is not ours.
		//        Treat as alive (we can't signal it, but it is running).
		if (err !== null && typeof err === 'object' && 'code' in err) {
			const code = (err as { code: string }).code;
			if (code === 'EPERM') return true;
		}
		return false;
	}
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Remove the retry PID file. No-op when the file does not exist.
 *
 * Safe to call from cleanup callbacks — never throws.
 */
export function removeRetryPid(): void {
	const path = retryPidPath();
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
		// Best-effort — ignore errors on shutdown.
	}
}
