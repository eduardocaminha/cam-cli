// src/commands/issue.ts
//
// Implementation of `cam issue "<free text>"` — opens the /cam-issue create
// invocation as a pane in the project session (thin pane launcher, US-007).
//
// Acceptance criteria (US-007):
//   1. index.ts dispatches a new `issue` subcommand to this file.
//   2. Reads permission_mode from project config via readPermissionMode().
//   3. Ensures the project session via ensureProjectSession + openPaneInSession
//      from src/tmux/session.ts.
//   4. Opens a pane with claude receiving the free-text argument (which expands
//      to title + description and runs /cam-issue create).
//   5. A help block is registered in src/logging/help.ts.
//   6. No --permission-mode CLI flag is registered (enforced by
//      test/no-permission-mode-flag.test.ts).
//   7. Typecheck passes (bun run typecheck).
//   8. Tests pass (bun test).
//
// Pattern: identical to cam plan (US-006) and cam next tmux-split path (US-005).
// The thin-launcher pattern: ensureProjectSession -> openPaneInSession -> return 0.

import process from 'node:process';

import { readPermissionMode } from '../config/permission-mode.ts';
import { printError } from '../logging/color.ts';
import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';
import {
	ensureProjectSession,
	openPaneInSession,
	projectSessionName,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';

// --- Types -----------------------------------------------------------------

export interface IssueOptions {
	/** Free-text description of the issue to file. */
	text: string;
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
}

// --- argv builder ----------------------------------------------------------

/**
 * Build the argv for the claude invocation inside the issue pane.
 * The free text is passed as the argument to /cam-issue create so that claude
 * can expand it into a title + description before filing the issue.
 */
export function buildIssueArgv(permissionMode: string, text: string): string[] {
	const slash = `/cam-issue create ${text}`;
	return ['claude', '--permission-mode', permissionMode, slash];
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the `cam issue` flow: thin pane launcher.
 *
 * Calls ensureProjectSession then openPaneInSession and returns 0 immediately.
 * The /cam-issue create invocation runs inside the session pane. No PTY
 * forwarding in the parent process.
 */
export async function runIssue(options: IssueOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const permissionMode = options.permissionMode ?? readPermissionMode();
	const text = options.text;

	// Default synchronous spawn for tmux session management calls.
	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam issue');
	emitSectionHeading('Session');

	const sessionName = projectSessionName(cwd);
	const claudeArgv = buildIssueArgv(permissionMode, text);
	const claudeCmd = claudeArgv.join(' ');

	try {
		ensureProjectSession(sessionName, tmuxSpawnFn);
		openPaneInSession(sessionName, claudeCmd, tmuxSpawnFn);
	} catch (err) {
		printError(
			'Failed to launch /cam-issue pane',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	emitOk(`Launched /cam-issue create in project session "${sessionName}"`);
	emitMutedHint(`Attach with: tmux attach -t ${sessionName}`);
	emitMutedHint('Issue title and description are expanded inside the pane');
	emitTrailingBlank();
	return 0;
}
