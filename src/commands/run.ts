// src/commands/run.ts
//
// `cam run` — opens or attaches the long-lived orchestrator tmux session.
//
// Behaviour (per project decision: always tmux, single session per project):
//   1. Compute the session name from the project (cwd basename + short hash).
//   2. If `tmux has-session -t <name>` succeeds → attach the user to it.
//   3. Otherwise → create a new session with two panes via ensureProjectSession:
//        Pane 0 (left, ~70%): claude --permission-mode bypassPermissions
//                              with the orchestrator boot prompt.
//        Pane 1 (right, ~30%): cam dashboard (permanent pane, US-002).
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
 * Generate a bash key-loop menu for the right pane of the orchestrator session.
 *
 * The menu renders a numbered list of cam orchestrator commands. When the user
 * presses a key the corresponding command is sent to the orchestrator pane via
 * `tmux send-keys -t <orchPane> <command> Enter`.
 *
 * The orchestrator pane address is embedded in the script so no env wiring is
 * needed at call time (compare: setup.ts passes CAM_CONFIG_PANE via -e flag).
 *
 * @param orchPane  - tmux pane target for the orchestrator, e.g. "cam-orch-x:0.0"
 */
export function buildRunMenuScript(orchPane: string): string {
	return `#!/bin/bash
set +m

CYAN='\\033[1;36m'
GREEN='\\033[1;32m'
BOLD='\\033[1m'
DIM='\\033[2m'
RST='\\033[0m'

ORCH_PANE='${orchPane}'

show_menu() {
	clear
	printf "\${CYAN}  cam — orchestrator menu\${RST}\\n\\n"
	printf "  \${BOLD}n\${RST}  /cam-next   (run next story)\\n"
	printf "  \${BOLD}r\${RST}  /cam-review (review PRD)\\n"
	printf "  \${BOLD}s\${RST}  /cam-ship   (ship iteration)\\n"
	printf "  \${BOLD}p\${RST}  /cam-plan   (plan / re-plan)\\n"
	printf "  \${BOLD}i\${RST}  /cam-issue  (sync issues)\\n"
	printf "  \${BOLD}d\${RST}  cam dashboard\\n"
	printf "  \${BOLD}q\${RST}  quit this menu\\n\\n"
	printf "\${DIM}  Press a key...\${RST}\\n"
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
		d|D) tmux send-keys -t "\${ORCH_PANE}" 'cam dashboard' Enter ; show_menu ;;
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
 * Delegates layout creation to ensureProjectSession (2-pane detached session),
 * then:
 *   - Sends the claude orchestrator command to pane 0.
 *   - Sends the interactive menu script to pane 1 (replaces static dashboard).
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

	const created = ensureProjectSession(sessionName, spawnFn);
	if (!created) {
		return { sessionName, created: false };
	}

	// Persist the boot prompt to a file so the agent command stays simple.
	const dotClaude = join(cwd, '.claude');
	mkdirSync(dotClaude, { recursive: true });
	const promptFile = join(dotClaude, '.cam-orchestrator-prompt.txt');
	writeFileSync(promptFile, buildOrchestratorBootPrompt(), 'utf8');

	// Pane 0: orchestrator (claude).
	// Chain kill-session so that when claude exits the whole tmux session is
	// torn down automatically, dropping the user back to their shell (US-003).
	const agentCmd = `claude --permission-mode bypassPermissions "$(cat '${promptFile}')"; tmux kill-session -t ${sessionName}`;
	spawnFn(
		'tmux',
		['send-keys', '-t', `${sessionName}:0.0`, agentCmd, 'Enter'],
		{ stdio: 'ignore' },
	);

	// Pane 1: interactive menu (US-004).
	// Write the menu script to a file so the pane command stays simple.
	const menuFile = join(dotClaude, '.cam-run-menu.sh');
	writeFileSync(menuFile, buildRunMenuScript(`${sessionName}:0.0`), 'utf8');
	spawnFn(
		'tmux',
		['send-keys', '-t', `${sessionName}:0.1`, `bash '${menuFile}'`, 'Enter'],
		{ stdio: 'ignore' },
	);

	// Make sure focus is on the orchestrator pane.
	spawnFn('tmux', ['select-pane', '-t', `${sessionName}:0.0`], { stdio: 'ignore' });

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
