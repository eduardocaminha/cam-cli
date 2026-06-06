// src/commands/run.ts
//
// `cam run` — opens or attaches the long-lived orchestrator tmux session.
//
// Behaviour (per project decision: always tmux, single session per project):
//   1. Compute the session name from the project (cwd basename + short hash).
//   2. If `tmux has-session -t <name>` succeeds → attach the user to it.
//   3. Otherwise → create a new session with three panes via ensureProjectSession:
//        Pane 0 (left):         claude orchestrator with boot prompt (US-001).
//        Pane 1 (top-right):    cam dashboard — permanent pane (US-002, US-010).
//        Pane 2 (bottom-right): interactive menu script (US-004).
//      Then attach.
//
// Dependencies:
//   - tmux on PATH (verified by `cam init`).
//   - claude on PATH (verified by `cam init`).
//   - .claude/agents/subagent-orchestrator.md present in cwd (installed by
//     `cam init` stage 2).
//
// CLI contract:
//   cam run [--no-attach]         (don't attach, just create the session)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

import { printError } from '../logging/color.ts';
import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
	emitWarn,
} from '../logging/screen.ts';
import {
	projectSessionName,
	ensureProjectSession,
	type SpawnFn,
	type CreatedPaneIds,
} from '../tmux/session.ts';

// Re-export projectSessionName so existing callers (test/run.test.ts) continue
// to import it from this module without breaking.
export { projectSessionName } from '../tmux/session.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunOptions {
	noAttach?: boolean;
	cwd?: string;
	/** Injectable spawn function for unit tests. Defaults to spawnSync. */
	spawnFn?: SpawnFn;
}

export interface ParsedRunArgs {
	noAttach: boolean;
	help: boolean;
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

function tmuxAvailable(spawnFn: SpawnFn): boolean {
	const r = spawnFn('tmux', ['-V'], { stdio: 'ignore' });
	return (r.status ?? 1) === 0;
}

// ---------------------------------------------------------------------------
// Boot prompt
// ---------------------------------------------------------------------------

/**
 * The first message we feed claude so the orchestrator persona loads.
 *
 * We point at the agent file rather than inlining its contents — keeping the
 * prompt small and letting claude follow its `.claude/agents/` lookup.
 */
export function buildOrchestratorBootPrompt(): string {
	return [
		'You are the cam orchestrator for this project.',
		'',
		'Read .claude/agents/subagent-orchestrator.md NOW. That file is your',
		'system prompt — every instruction in it applies to you for the entire',
		'duration of this session.',
		'',
		'After reading it, perform the boot context steps it documents (read',
		'CLAUDE.md, project.toml, journal.md, prd.json, current git state),',
		'then greet the operator with the one-screen summary it specifies.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Menu script
// ---------------------------------------------------------------------------

/**
 * Generate a bash key-loop menu for the bottom-right pane of the session.
 *
 * The menu renders a list of cam orchestrator commands. When the user presses
 * a key, the corresponding slash command is sent to the orchestrator pane via
 * `tmux send-keys -t <orchPane> <command> Enter`.
 *
 * The `d` key focuses the permanent dashboard pane (pane 1) via
 * `tmux select-pane` — it does NOT inject text into the orchestrator pane,
 * because the dashboard is already running as a permanent pane (US-011).
 *
 * Both pane addresses are embedded in the script so no env wiring is needed
 * at call time.
 *
 * @param orchPane      - tmux pane ID for the orchestrator, e.g. "%1"
 * @param dashboardPane - tmux pane ID for the dashboard, e.g. "%2"
 */
export function buildRunMenuScript(orchPane: string, dashboardPane: string): string {
	return `#!/bin/bash
set +m

ACCENT='\\033[38;2;78;190;125m'
MUTED='\\033[38;2;128;128;128m'
BOLD='\\033[1m'
RST='\\033[0m'

ORCH_PANE='${orchPane}'
DASHBOARD_PANE='${dashboardPane}'

show_menu() {
	clear
	local COLS RULE_W DIV
	COLS=$(tput cols 2>/dev/null || echo 36)
	RULE_W=$(( COLS > 4 ? COLS - 2 : 2 ))
	DIV=$(printf '─%.0s' $(seq 1 "$RULE_W"))
	printf "  \${ACCENT}\${BOLD}cam orchestrator\${RST}\\n"
	printf "  \${MUTED}\${DIV}\${RST}\\n"
	printf "  \${BOLD}n\${RST}  \${BOLD}/cam-next  \${RST}  \${MUTED}run next story\${RST}\\n"
	printf "  \${BOLD}r\${RST}  \${BOLD}/cam-review\${RST}  \${MUTED}review PRD\${RST}\\n"
	printf "  \${BOLD}s\${RST}  \${BOLD}/cam-ship  \${RST}  \${MUTED}ship iteration\${RST}\\n"
	printf "  \${BOLD}p\${RST}  \${BOLD}/cam-plan  \${RST}  \${MUTED}plan / re-plan\${RST}\\n"
	printf "  \${BOLD}i\${RST}  \${BOLD}/cam-issue \${RST}  \${MUTED}sync issues\${RST}\\n"
	printf "  \${MUTED}\${DIV}\${RST}\\n"
	printf "  \${BOLD}d\${RST}  \${MUTED}focus dashboard pane\${RST}\\n"
	printf "  \${BOLD}q\${RST}  \${MUTED}quit this menu\${RST}\\n"
	printf "  \${MUTED}press a key\${RST}\\n"
}

show_menu

while true; do
	read -rsn1 key
	case "\${key}" in
		n|N) tmux send-keys -t "\${ORCH_PANE}" '/cam-next' Enter ; show_menu ;;
		r|R) tmux send-keys -t "\${ORCH_PANE}" '/cam-review' Enter ; show_menu ;;
		s|S) tmux send-keys -t "\${ORCH_PANE}" '/cam-ship' Enter ; show_menu ;;
		p|P) tmux send-keys -t "\${ORCH_PANE}" '/cam-plan' Enter ; show_menu ;;
		i|I) tmux send-keys -t "\${ORCH_PANE}" '/cam-issue' Enter ; show_menu ;;
		d|D) tmux select-pane -t "\${DASHBOARD_PANE}" ;;
		q|Q) exit 0 ;;
	esac
done
`;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Create the orchestrator session using the shared session module.
 *
 * Delegates layout creation to ensureProjectSession (3-pane detached session),
 * then:
 *   - Sends the claude orchestrator command to pane 0 (orchestrator).
 *   - Sends `cam dashboard` to pane 1 (permanent dashboard).
 *   - Sends the interactive menu script to pane 2 (menu).
 *
 * Pane IDs returned by ensureProjectSession are stable %<n> identifiers that
 * work regardless of the user's pane-base-index in .tmux.conf.
 *
 * Returns { sessionName, created: true } when a new session was built,
 * { sessionName, created: false } when it already existed (just attach).
 */
function setupOrchestratorSession(opts: {
	cwd: string;
	sessionName: string;
	spawnFn: SpawnFn;
}): { sessionName: string; created: boolean } {
	const { cwd, sessionName, spawnFn } = opts;

	const panes: CreatedPaneIds | false = ensureProjectSession(sessionName, spawnFn);
	if (!panes) {
		return { sessionName, created: false };
	}

	const { orchPaneId, dashboardPaneId, menuPaneId } = panes;

	// Persist the boot prompt to a file so the agent command stays simple.
	const dotClaude = join(cwd, '.claude');
	mkdirSync(dotClaude, { recursive: true });
	const promptFile = join(dotClaude, '.cam-orchestrator-prompt.txt');
	writeFileSync(promptFile, buildOrchestratorBootPrompt(), 'utf8');

	// Pane 0: orchestrator (claude).
	// --permission-mode bypassPermissions is INTENTIONAL (2026-06-06): the
	// orchestrator runs the loop unattended and must bypass; do NOT change to
	// readPermissionMode.
	// Chain kill-session so that when claude exits the whole tmux session is
	// torn down automatically, dropping the user back to their shell (US-003).
	const agentCmd = `claude --permission-mode bypassPermissions "$(cat '${promptFile}')"; tmux kill-session -t ${sessionName}`;
	spawnFn(
		'tmux',
		['send-keys', '-t', orchPaneId, agentCmd, 'Enter'],
		{ stdio: 'ignore' },
	);

	// Pane 1: cam dashboard — permanent pane (US-002, US-010).
	spawnFn(
		'tmux',
		['send-keys', '-t', dashboardPaneId, 'cam dashboard', 'Enter'],
		{ stdio: 'ignore' },
	);

	// Pane 2: interactive menu (US-004).
	// Write the menu script to a file so the pane command stays simple.
	const menuFile = join(dotClaude, '.cam-run-menu.sh');
	writeFileSync(menuFile, buildRunMenuScript(orchPaneId, dashboardPaneId), 'utf8');
	spawnFn(
		'tmux',
		['send-keys', '-t', menuPaneId, `bash '${menuFile}'`, 'Enter'],
		{ stdio: 'ignore' },
	);

	// Enable mouse mode on this session so the operator can click a pane to
	// focus it and scroll with the trackpad, instead of the tmux prefix dance
	// (Ctrl+b + arrows). Scoped to this session only. Note: with mouse on,
	// selecting text to copy needs Option held down (macOS Terminal/iTerm).
	spawnFn('tmux', ['set-option', '-t', sessionName, 'mouse', 'on'], { stdio: 'ignore' });

	// Make sure focus is on the orchestrator pane.
	spawnFn('tmux', ['select-pane', '-t', orchPaneId], { stdio: 'ignore' });

	return { sessionName, created: true };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function runRun(options: RunOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const spawnFn: SpawnFn = options.spawnFn ?? ((cmd, args, opts) =>
		spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' })
	);

	// Title + leading blank up-front so every code path below shares the same
	// hierarchy as `cam status` / `cam help`.
	emitTitle('cam run');

	// 1. Pre-flight checks. Errors use `printError` directly (destructive
	//    bold lives at col 0 by design — it must stand out, not nestle inside
	//    a Section column).
	if (!tmuxAvailable(spawnFn)) {
		printError('tmux is not on PATH', 'install tmux and re-run `cam run`');
		emitTrailingBlank();
		return 1;
	}

	const orchestratorAgent = join(cwd, '.claude', 'agents', 'subagent-orchestrator.md');
	if (!existsSync(orchestratorAgent)) {
		printError(
			'subagent-orchestrator.md not found',
			'This project has not been initialized — run `cam init` first',
		);
		emitTrailingBlank();
		return 1;
	}

	// 2. Compute session name.
	const sessionName = projectSessionName(cwd);

	// 3. Open the "Session" section — everything from here is part of the
	//    create/attach narrative, so it lives under one heading.
	emitSectionHeading('Session');

	// Tests set CAM_RUN_DRY_RUN=1 to exercise pre-flight without spawning
	// real tmux processes. In that mode we only verify checks pass and
	// return 0 immediately.
	if (process.env['CAM_RUN_DRY_RUN'] === '1') {
		emitOk(`[dry-run] would create/attach session "${sessionName}"`);
		emitTrailingBlank();
		return 0;
	}

	let result: { sessionName: string; created: boolean };
	try {
		result = setupOrchestratorSession({ cwd, sessionName, spawnFn });
		if (result.created) {
			emitOk(`tmux session "${sessionName}" created`);
		} else {
			emitOk(`tmux session "${sessionName}" already exists — attaching`);
		}
	} catch (err) {
		printError(
			'Failed to create orchestrator session',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	// 4. Attach (unless --no-attach).
	if (options.noAttach) {
		emitMutedHint(`Attach manually: tmux attach -t ${result.sessionName}`);
		emitTrailingBlank();
		return 0;
	}

	// `tmux attach` blocks until the user detaches. Inside another tmux,
	// `attach` is rejected — we use `switch-client` instead.
	const insideTmux = Boolean(process.env['TMUX']);
	const attach = insideTmux
		? spawnFn('tmux', ['switch-client', '-t', result.sessionName], { stdio: 'inherit' })
		: spawnFn('tmux', ['attach-session', '-t', result.sessionName], { stdio: 'inherit' });

	if ((attach.status ?? 1) !== 0) {
		emitWarn('tmux attach failed', `try manually: tmux attach -t ${result.sessionName}`);
		emitTrailingBlank();
		return attach.status ?? 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Arg parser (called from index.ts)
// ---------------------------------------------------------------------------

export function parseRunArgs(args: string[]): ParsedRunArgs | null {
	const result: ParsedRunArgs = { noAttach: false, help: false };
	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--no-attach') {
			result.noAttach = true;
			continue;
		}
		printError(`Unknown run option: ${arg}`);
		return null;
	}
	return result;
}
