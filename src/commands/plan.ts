// src/commands/plan.ts
//
// Implementation of `cam plan` -- opens the /cam-plan claude invocation as a
// pane in the project session (thin pane launcher, US-006).
//
// Acceptance criteria (US-006):
//   1. Opens the /cam-plan claude invocation as a pane in the project session
//      via ensureProjectSession + openPaneInSession from src/tmux/session.ts.
//   2. The PTY/foreground inherit path is removed entirely.
//   3. APPROVE interaction happens inside the pane (flag-file approve is
//      CAM-12, explicitly out of scope here).
//   4. Unit test asserts the new tmux argv for cam plan.
//   5. Typecheck passes (bun run typecheck).
//   6. Tests pass (bun test).
//
// Pattern: identical to cam next (US-005). The thin-launcher pattern:
//   ensureProjectSession -> openPaneInSession -> return 0.
// The loop lives in the session pane; cam plan returns immediately.

import process from 'node:process';

import { readPermissionMode } from '../config/permission-mode.ts';
import { printError } from '../logging/color.ts';
import {
	emitAttachHint,
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
	emitWarn,
} from '../logging/screen.ts';
import { join } from 'node:path';

import type { Env } from '../tmux/session.ts';
import {
	ensureProjectSession,
	openPaneInSession,
	projectSessionName,
	writeWorkerPaneMarker,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';

// --- Types -----------------------------------------------------------------

export interface PlanOptions {
	/** Optional issue number; passed through as `/cam-plan N`. */
	issue?: number;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/**
	 * Override the synchronous spawn function used for tmux session management
	 * (ensureProjectSession, openPaneInSession). Tests inject a fake so they
	 * never call a real tmux binary. Defaults to a spawnSync wrapper.
	 */
	tmuxSpawnFn?: TmuxSpawnFn;
	/** Permission-mode override (purely for tests; production reads config). */
	permissionMode?: string;
	/**
	 * Override process.env for attach-hint detection. Tests inject a fake env
	 * to assert hint printed/suppressed without touching process.env.
	 */
	env?: Env;
}

// --- argv builder ----------------------------------------------------------

/**
 * Build the argv for the claude invocation inside the plan pane.
 * Uses `permission_mode` from config (default: bypassPermissions).
 */
export function buildPlanArgv(permissionMode: string, issue?: number): string[] {
	const slash = issue !== undefined ? `/cam-plan ${issue}` : '/cam-plan';
	return ['claude', '--permission-mode', permissionMode, slash];
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the `cam plan` flow: thin pane launcher.
 *
 * Calls ensureProjectSession then openPaneInSession and returns 0 immediately.
 * The /cam-plan invocation (including APPROVE prompt) runs inside the session
 * pane. No PTY forwarding in the parent process.
 */
export async function runPlan(options: PlanOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const permissionMode = options.permissionMode ?? readPermissionMode();
	const issue = options.issue;
	const env = options.env ?? process.env;

	// Default synchronous spawn for tmux session management calls.
	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam plan');
	emitSectionHeading('Session');

	const sessionName = projectSessionName(cwd);
	const claudeArgv = buildPlanArgv(permissionMode, issue);

	try {
		ensureProjectSession(sessionName, tmuxSpawnFn);
		const paneId = openPaneInSession(sessionName, claudeArgv, tmuxSpawnFn);
		const claudeDir = join(cwd, '.claude');
		writeWorkerPaneMarker(claudeDir, paneId);
	} catch (err) {
		printError(
			'Failed to launch /cam-plan pane',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	const slash = issue !== undefined ? `/cam-plan ${issue}` : '/cam-plan';
	emitOk(`Launched ${slash} in project session "${sessionName}"`);
	emitMutedHint('APPROVE prompt appears inside the pane — answer there');
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}
