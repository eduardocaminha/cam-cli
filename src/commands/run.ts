// src/commands/run.ts
//
// `cam run` — opens or attaches the long-lived orchestrator tmux session.
//
// Behaviour (per project decision: always tmux, single session per project):
//   1. Compute the session name from the project (cwd basename + short hash).
//   2. If `tmux has-session -t <name>` succeeds → attach the user to it.
//   3. Otherwise → create a new session with two panes:
//        Pane 0 (left, ~70%): claude --permission-mode bypassPermissions
//                              with the orchestrator boot prompt.
//        Pane 1 (right, ~30%): status menu (key hints, last journal entry).
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
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';

import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunOptions {
	noAttach?: boolean;
	cwd?: string;
}

export interface ParsedRunArgs {
	noAttach: boolean;
	help: boolean;
}

// ---------------------------------------------------------------------------
// Session naming
// ---------------------------------------------------------------------------

/**
 * Derive a tmux session name from the project's working directory.
 *
 * Goals:
 *   - One stable session per project — running `cam run` from the same repo
 *     re-attaches instead of stacking sessions.
 *   - Different projects in different directories get different sessions
 *     (a hash of the absolute path disambiguates same-named directories).
 *   - The name is human-readable for the operator's `tmux ls`.
 *
 * Format: `cam-orch-<basename>-<6-char hash>`. Sanitized to tmux-safe chars.
 */
export function projectSessionName(cwd: string): string {
	const baseRaw = basename(cwd) || 'project';
	const base = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
	const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 6);
	return `cam-orch-${base}-${hash}`;
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

function tmuxHasSession(name: string): boolean {
	const r = spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
	return r.status === 0;
}

function tmuxAvailable(): boolean {
	const r = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
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
// Menu pane script
// ---------------------------------------------------------------------------

/**
 * Pane 1 script: a static info pane that the operator can leave alone.
 *
 * Unlike the cam-setup menu (which captures keys to switch panes), the run
 * menu is informational only — the operator interacts with the orchestrator
 * directly in pane 0. The menu is here for situational awareness:
 *   - reminds the operator of common commands
 *   - tails .claude/cam-orchestrator.log if it exists for visibility
 */
function buildRunMenuScript(): string {
	return [
		'set +m',
		"CYAN='\\033[1;36m' BOLD='\\033[1m' DIM='\\033[2m' RST='\\033[0m'",
		'clear',
		'printf "$CYAN  cam orchestrator$RST\\n"',
		'printf "$DIM  long-lived project agent$RST\\n\\n"',
		'printf "  ${BOLD}Common commands you can ask the orchestrator:${RST}\\n\\n"',
		'printf "    \\"o que temos pra fazer?\\"   list active issues\\n"',
		'printf "    \\"plano para <ID>\\"        spawn /cam-plan\\n"',
		'printf "    \\"implementa\\"               run /cam-next loop\\n"',
		'printf "    \\"review\\"                   run /cam-review\\n"',
		'printf "    \\"ship\\"                     run /cam-ship\\n"',
		'printf "    \\"o que aconteceu antes?\\"   query journal\\n\\n"',
		'printf "  ${DIM}detach: prefix-d   kill session: tmux kill-session -t \\$(tmux display-message -p \\"#S\\")${RST}\\n"',
		'while sleep 30; do :; done',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

interface CreateSessionResult {
	sessionName: string;
	created: boolean;
}

function createOrchestratorSession(opts: {
	cwd: string;
	sessionName: string;
}): CreateSessionResult {
	const { cwd, sessionName } = opts;

	// Persist the boot prompt to a file so the agent command stays simple.
	const dotClaude = join(cwd, '.claude');
	mkdirSync(dotClaude, { recursive: true });
	const promptFile = join(dotClaude, '.cam-orchestrator-prompt.txt');
	writeFileSync(promptFile, buildOrchestratorBootPrompt(), 'utf8');

	const agentCmd = `claude --permission-mode bypassPermissions "$(cat '${promptFile}')"`;
	const menuScript = buildRunMenuScript();

	// Create the detached session with the orchestrator in pane 0.
	const newSession = spawnSync(
		'tmux',
		[
			'new-session', '-d',
			'-s', sessionName,
			'-x', '220', '-y', '50',
			'bash', '-c', agentCmd,
		],
		{ cwd, stdio: 'inherit' },
	);
	if ((newSession.status ?? 1) !== 0) {
		throw new Error(`tmux new-session failed (exit ${newSession.status})`);
	}

	// Add the menu pane on the right.
	const menuPane = spawnSync(
		'tmux',
		[
			'split-window',
			'-t', `${sessionName}:0`,
			'-h',
			'-l', '36',
			'-d',
			'bash', '-c', menuScript,
		],
		{ stdio: 'inherit' },
	);
	if ((menuPane.status ?? 1) !== 0) {
		printWarning('tmux split for menu pane failed — orchestrator still running in pane 0');
	}

	// Make sure focus is on the orchestrator pane.
	spawnSync('tmux', ['select-pane', '-t', `${sessionName}:0.0`], { stdio: 'inherit' });

	return { sessionName, created: true };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function runRun(options: RunOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();

	// 1. Pre-flight checks.
	if (!tmuxAvailable()) {
		printError('tmux is not on PATH', 'install tmux and re-run `cam run`');
		return 1;
	}

	const orchestratorAgent = join(cwd, '.claude', 'agents', 'subagent-orchestrator.md');
	if (!existsSync(orchestratorAgent)) {
		printError(
			'subagent-orchestrator.md not found',
			'this project has not been initialized — run `cam init` first',
		);
		return 1;
	}

	// 2. Compute session name.
	const sessionName = projectSessionName(cwd);

	// 3. Create or detect.
	// Tests set CAM_RUN_DRY_RUN=1 to exercise pre-flight without spawning
	// real tmux processes. In that mode we only verify checks pass and
	// return 0 immediately.
	if (process.env['CAM_RUN_DRY_RUN'] === '1') {
		printSuccess(`[dry-run] would create/attach session "${sessionName}"`);
		return 0;
	}

	let result: CreateSessionResult;
	if (tmuxHasSession(sessionName)) {
		printSuccess(`tmux session "${sessionName}" already exists — attaching`);
		result = { sessionName, created: false };
	} else {
		try {
			result = createOrchestratorSession({ cwd, sessionName });
			printSuccess(`tmux session "${sessionName}" created`);
		} catch (err) {
			printError(
				'failed to create orchestrator session',
				err instanceof Error ? err.message : String(err),
			);
			return 1;
		}
	}

	// 4. Attach (unless --no-attach).
	if (options.noAttach) {
		printHint(`attach manually: tmux attach -t ${result.sessionName}`);
		return 0;
	}

	// `tmux attach` blocks until the user detaches. Inside another tmux,
	// `attach` is rejected — we use `switch-client` instead.
	const insideTmux = Boolean(process.env['TMUX']);
	const attach = insideTmux
		? spawnSync('tmux', ['switch-client', '-t', result.sessionName], { stdio: 'inherit' })
		: spawnSync('tmux', ['attach-session', '-t', result.sessionName], { stdio: 'inherit' });

	if ((attach.status ?? 1) !== 0) {
		printWarning(`tmux attach failed — try manually: tmux attach -t ${result.sessionName}`);
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
		printError(`unknown run option: ${arg}`);
		return null;
	}
	return result;
}
