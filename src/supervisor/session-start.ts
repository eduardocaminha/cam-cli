// src/supervisor/session-start.ts
//
// Sidecar session-start marker (US-001, PR-83, dashboard total-session elapsed).
//
// The supervisor lock (.claude/.cam-supervisor.lock, lock.ts) is acquired and
// released once PER ACTIVE CYCLE inside runSidecarLoop (see loop.ts: the lock
// is taken right before dispatching runSupervisor and released in a `finally`
// right after), so `SupervisorLockInfo.startedAt` is rewritten to "now" on
// every fresh story-implementation cycle. It does NOT span the whole sidecar
// process lifetime, so it cannot be reused as the session-start timestamp.
//
// This module persists a dedicated once-per-process record instead, written
// exactly once from the sidecar entrypoint (`runSidecar` in
// src/commands/sidecar.ts) before the poll loop starts. Because the write
// happens a single time per process and the poll loop never touches this
// file, the value is stable across every state-file rewrite, active/idle
// transition, and fresh PRD cycle within the same sidecar session.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Filename within `.claude/` where the sidecar session-start record is persisted. */
export const SIDECAR_SESSION_START_FILE = '.cam-sidecar-session.json';

/**
 * Persist the sidecar session-start ISO timestamp to
 * `<claudeDir>/.cam-sidecar-session.json`.
 *
 * Called exactly once, from the sidecar entrypoint, before the poll loop
 * starts. Creates the parent directory if absent.
 */
export function writeSidecarSessionStart(claudeDir: string, sessionStartTs: string): void {
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(
		join(claudeDir, SIDECAR_SESSION_START_FILE),
		JSON.stringify({ sessionStartTs }),
		'utf8',
	);
}

/**
 * Read the sidecar session-start ISO timestamp.
 *
 * Returns null when the file is absent, unparseable, or lacks a string
 * `sessionStartTs` field. Never throws.
 */
export function readSidecarSessionStart(claudeDir: string): string | null {
	try {
		const raw = readFileSync(join(claudeDir, SIDECAR_SESSION_START_FILE), 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			!Array.isArray(parsed) &&
			typeof (parsed as Record<string, unknown>)['sessionStartTs'] === 'string'
		) {
			return (parsed as Record<string, unknown>)['sessionStartTs'] as string;
		}
		return null;
	} catch {
		return null;
	}
}
