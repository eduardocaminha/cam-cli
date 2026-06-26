// index.ts
//
// cam CLI entrypoint. Dispatches subcommands by argv[2]; everything else is
// implemented in `src/commands/<name>.ts`. We deliberately avoid pulling in
// `commander` / `yargs` for the current CLI surface — argv parsing fits
// inline, and a third-party arg parser would be the largest single dep in
// the project. As more subcommands with more options land we will revisit
// (this point gets re-evaluated each story; US-007 still fits inline because
// only `next` adds two more options, both with simple value parsing).
//
// IMPORTANT INVARIANT (US-007 acceptance criterion 7):
//   No subcommand parser registers a `--permission-mode` flag. The value is
//   sourced exclusively from `~/.config/cam/config.toml` via
//   `src/config/permission-mode.ts`. The unit test
//   `test/no-permission-mode-flag.test.ts` greps this file (and every file
//   in `src/commands/`) for `--permission-mode` patterns and fails the build
//   on a registration. Search markers documented in that test.

import process from 'node:process';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDashboardInk } from './src/commands/dashboard.ts';
import { runInit } from './src/commands/init.ts';
import {
	createLocalIssueOnMain,
	type CreateLocalIssueOnMainOptions,
} from './src/commands/issue-file.ts';
import { runIssue } from './src/commands/issue.ts';
import { runNext } from './src/commands/next.ts';
import { runSetup, parseSetupArgs } from './src/commands/setup.ts';
import { runPlan } from './src/commands/plan.ts';
import { runReview } from './src/commands/review.ts';
import { runShip } from './src/commands/ship.ts';
import {
	finalizeCycleClose,
	type FinalizeCycleCloseResult,
} from './src/commands/ship-finalize.ts';
import { runShipBump, type ShipBumpResult } from './src/release/ship-bump.ts';
import { runResume, type ExplicitMode } from './src/commands/resume.ts';
import { runRun, parseRunArgs } from './src/commands/run.ts';
import { runStatus } from './src/commands/status.ts';
import { runOrchBudget } from './src/commands/orch-budget.ts';
import { runStop } from './src/commands/stop.ts';
import { runClaude, parseClaudeArgs, CLAUDE_HELP } from './src/commands/claude.ts';
import { runConfig } from './src/commands/config.ts';
import { runRetryMonitor, parseRetryMonitorArgs, RETRY_MONITOR_HELP } from './src/commands/retry-monitor.ts';
import { runSidecar } from './src/commands/sidecar.ts';
import { runTag } from './src/commands/tag.ts';
import { printError, printFatalHint, printHint } from './src/logging/color.ts';
import { renderHelp } from './src/logging/help.ts';
import { CAM_VERSION } from './src/version.ts';

const HELP = renderHelp({
	title: 'cam',
	tagline: 'Autonomous Claude Code loop driver',
	usage: 'cam <command> [options]',
	sections: [
		{
			heading: 'Commands',
			entries: [
				{ name: 'init [options]', description: 'Validate the machine, then run the project-setup wizard' },
				{ name: 'config [--show]', description: 'Interactive wizard to set model per phase and backend' },
				{ name: 'run [options]', description: 'Open or attach the long-lived orchestrator (tmux session)' },
				{ name: 'plan [--issue <N>]', description: 'Spawn claude + dispatch /cam-plan; APPROVE happens inside the pane' },
				{ name: 'next [options]', description: 'Launch the autonomous loop as a tmux pane in the project session' },
				{ name: 'review', description: 'Dispatch /cam-review to the live orchestrator (or bootstrap first)' },
				{ name: 'ship', description: 'Dispatch /cam-ship to the live orchestrator (or bootstrap first)' },
				{ name: 'tag', description: 'Create and push the vX.Y.Z git tag for the current CAM_VERSION on main' },
				{ name: 'issue "<text>"', description: 'File an issue from free text; opens /cam-issue create in a pane' },
				{ name: 'claude [args...]', description: 'Run claude in print mode with auto-retry on rate limits' },
				{ name: 'dashboard', description: 'Standalone read-only TUI (alt-screen) for monitoring a loop' },
				{ name: 'status', description: 'Show current loop state at a glance (idle / active / paused)' },
				{ name: 'stop', description: 'Cancel a running loop (clears state file + kills the per-project tmux session)' },
				{ name: 'resume [options]', description: 'Reconcile loop state after interrupt; auto-detect or --mode <name>' },
				{ name: 'version', description: 'Print the installed cam-cli version (also `--version` / `-v`)' },
				{ name: 'help', description: 'Show this help' },
			],
		},
	],
	footer:
		'Run `cam <command> --help` for command-specific options. Permission mode\n' +
		'for spawned claude sessions is read from `~/.config/cam/config.toml` —\n' +
		'no subcommand exposes a CLI flag for it (run `cam init` to set).',
});

const INIT_HELP = renderHelp({
	title: 'cam init',
	tagline: 'Validate the machine and set up the project for the cam loop',
	usage: 'cam init [options]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--new', description: 'Treat this as a new project (skip the new/existing question)' },
				{ name: '--existing', description: 'Treat this as an existing project' },
				{ name: '--issue-system <x>', description: 'linear | github | none. Skip the issue-system question' },
				{ name: '--description "<t>"', description: 'Project description for new projects (skip the prompt)' },
				{ name: '--no-tmux', description: 'Install templates only; skip spawning the tmux setup session' },
			],
		},
		{
			heading: 'Behaviour',
			body:
				'Stage 1 — Machine validation:\n' +
				'  1. Checks `claude` is on PATH and logged in.\n' +
				'  2. Runs vendored smokes (check-agent-frontmatter).\n' +
				'  3. Writes ~/.config/cam/config.toml with permission_mode = "bypassPermissions".\n' +
				'  4. Writes ~/.config/cam/retry.toml with the built-in retry policy defaults\n' +
				'     (first run only; existing file is preserved). Edit this file to tune\n' +
				'     max attempts, rate-limit patterns, and the retry log retention window.\n' +
				'\n' +
				'Stage 2 — Project setup wizard (if stage 1 passes):\n' +
				'  1. Asks: new project or existing?\n' +
				'  2. Verifies claude is installed and logged in.\n' +
				'  3. Asks: which issue system (linear | github | none)?\n' +
				'  4. If new: asks for a brief project description.\n' +
				'  5. Installs cam templates into .claude/commands/, .claude/agents/, scripts/cam/.\n' +
				'  6. Writes scripts/cam/project.toml with per-project config.\n' +
				'  7. Opens a tmux split:\n' +
				'       Pane A (left):  claude in bypassPermissions, adapts templates to this project.\n' +
				'       Pane B (right): key menu — c to interact, v for view-only, q to close.\n' +
				'  8. Auto-handoff: when the config agent emits CAM_SETUP_STATUS=DONE,\n' +
				'     the orchestrator is launched in a new pane immediately. The menu\n' +
				'     pane updates with options: o (orchestrator), c (config), k (kill\n' +
				'     config pane), q (close menu).',
		},
	],
	footer:
		'Note: auto-retry on rate limits is built into cam — no external tool required.\n' +
		'Rate-limit retry config: ~/.config/cam/retry.toml\n' +
		'Retry logs:             ~/.cam/retry-logs/',
});

const RUN_HELP = renderHelp({
	title: 'cam run',
	tagline: 'Open or attach the single per-project orchestrator session',
	usage: 'cam run [options]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{
					name: '--no-attach',
					description: 'Create the orchestrator session without attaching (useful for scripting)',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Verifies tmux and `.claude/agents/subagent-orchestrator.md` exist\n' +
				'   (run `cam init` first if not).\n' +
				'2. Computes a stable session name per project (cam-orch-<basename>-<hash>).\n' +
				'3. If the session does not exist: creates it with two panes.\n' +
				'     Pane 0.0 (left):  orchestrator (claude /cam-next loop).\n' +
				'     Pane 0.1 (right): cam dashboard (permanent, navigable TUI).\n' +
				'   When the orchestrator exits, the session is torn down automatically.\n' +
				'4. If the session already exists: attach (or switch-client inside tmux).\n' +
				'5. plan, next, and issue are thin pane launchers: they open a new pane\n' +
				'   inside this session and return immediately.',
		},
	],
	footer:
		'The orchestrator persona is loaded from\n' +
		'.claude/agents/subagent-orchestrator.md — see that file for what it does.',
});

const PLAN_HELP = renderHelp({
	title: 'cam plan',
	tagline: 'Open a planning pane in the project session',
	usage: 'cam plan [<N>]',
	sections: [
		{
			heading: 'Arguments',
			entries: [
				{
					name: '<N>',
					description:
						'Issue number to plan (passed to the planner as `/cam-plan N`). A leading `#` is tolerated. Omit it to plan the highest-priority open issue.',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads permission_mode from ~/.config/cam/config.toml (default:\n' +
				'   bypassPermissions). cam does NOT accept a --permission-mode flag.\n' +
				'2. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'3. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-plan" (or "/cam-plan N")\n' +
				'4. Returns 0 immediately. The planning flow runs inside the pane.\n' +
				'5. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
	],
	footer:
		'cam plan accepts only an issue number; any other argument is an error.\n' +
		'Without a number, cam dispatches a bare `/cam-plan` and the planner\n' +
		'picks the highest-priority open issue itself.',
});

const ISSUE_HELP = renderHelp({
	title: 'cam issue',
	tagline: 'File an issue from free text without entering a session manually',
	usage: 'cam issue "<free text>"',
	sections: [
		{
			heading: 'Arguments',
			entries: [
				{
					name: '"<free text>"',
					description: 'Free-text description; expanded to title + description by /cam-issue create',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads permission_mode from ~/.config/cam/config.toml (default:\n' +
				'   bypassPermissions). cam does NOT accept a --permission-mode flag.\n' +
				'2. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'3. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-issue create <text>"\n' +
				'4. Returns 0 immediately. The issue-creation flow runs inside the pane.\n' +
				'5. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
	],
	footer:
		'The free text is passed verbatim to the /cam-issue create slash command.\n' +
		'The pane agent expands it into a structured issue title + description.',
});

const NEXT_HELP = renderHelp({
	title: 'cam next',
	tagline: 'Open a loop pane in the project session',
	usage: 'cam next [--max-iter <N>] [--completion-promise <STR>]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--max-iter <N>', description: 'Max iterations before auto-stop (default: 30)' },
				{
					name: '--completion-promise <STR>',
					description: 'Phrase the assistant emits to end the loop (default: COMPLETE)',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Reads permission_mode from ~/.config/cam/config.toml (default:\n' +
				'   bypassPermissions). cam does NOT accept a --permission-mode flag.\n' +
				'2. Pre-arms the cam-loop plugin by writing\n' +
				'   .claude/cam-loop.local.md (vendored template at\n' +
				'   vendor/cam-loop.local.md.tmpl).\n' +
				'3. Ensures the project session exists (cam-orch-<basename>-<hash>);\n' +
				'   creates it (with 2-pane layout: orchestrator + dashboard) if needed.\n' +
				'4. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-next"\n' +
				'5. Returns 0 immediately. The loop runs inside the pane.\n' +
				'6. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
		{
			heading: 'Stop primitives',
			body:
				'/cancel-cam  (preferred — cleans up the state file)\n' +
				'rm .claude/cam-loop.local.md  (kill switch — loop ends after current turn)',
		},
	],
});

const REVIEW_HELP = renderHelp({
	title: 'cam review',
	tagline: 'Dispatch /cam-review to the live orchestrator',
	usage: 'cam review',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'1. Checks whether a live orchestrator session exists\n' +
				'   (cam-orch-<basename>-<hash>).\n' +
				'2. On hit: sends /cam-review to the orchestrator pane via\n' +
				'   atomic tmux send-keys and returns immediately.\n' +
				'3. On miss: bootstraps the orchestrator via `cam run --no-attach`,\n' +
				'   waits for .claude/.cam-orch-ready + liveness re-check, then\n' +
				'   sends /cam-review.\n' +
				'4. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
	],
	footer: 'cam review accepts no arguments. cam does NOT accept a --permission-mode flag.',
});

const SHIP_HELP = renderHelp({
	title: 'cam ship',
	tagline: 'Dispatch /cam-ship to the live orchestrator, or finalize a cycle in-process',
	usage: 'cam ship [--finalize] [--bump]',
	sections: [
		{
			heading: 'Behaviour (default)',
			body:
				'1. Checks whether a live orchestrator session exists\n' +
				'   (cam-orch-<basename>-<hash>).\n' +
				'2. On hit: sends /cam-ship to the orchestrator pane via\n' +
				'   atomic tmux send-keys and returns immediately.\n' +
				'3. On miss: bootstraps the orchestrator via `cam run --no-attach`,\n' +
				'   waits for .claude/.cam-orch-ready + liveness re-check, then\n' +
				'   sends /cam-ship.\n' +
				'4. If not already inside the session, prints a hint:\n' +
				'     Run `cam run` to open the project session.',
		},
		{
			heading: 'Options',
			entries: [
				{
					name: '--finalize',
					description:
						'Run the deterministic cycle-close in-process (no tmux session needed). ' +
						'Closes the tracked issue, removes per-branch harness state files via ' +
						'`git rm -f --ignore-unmatch`, and commits the cleanup.',
				},
				{
					name: '--bump',
					description:
						'Classify branch commits (main..HEAD), compute the next semver version ' +
						'(0.x convention: major -> minor while major is 0), write src/version.ts ' +
						'and package.json, and commit `chore(release): bump version to X.Y.Z`. ' +
						'No-op when all commits classify as none.',
				},
			],
		},
	],
	footer: 'cam does NOT accept a --permission-mode flag.',
});

const TAG_HELP = renderHelp({
	title: 'cam tag',
	tagline: 'Create and push the vX.Y.Z git tag for the current CAM_VERSION',
	usage: 'cam tag',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'1. Reads CAM_VERSION from src/version.ts to determine the tag name (vX.Y.Z).\n' +
				'2. Refuses with a non-zero exit if the current branch is not `main`.\n' +
				'3. Refuses with a non-zero exit if the working tree is dirty.\n' +
				'4. If the tag already exists, prints a message and exits 0 (idempotent).\n' +
				'5. Otherwise: runs `git tag vX.Y.Z` then `git push origin vX.Y.Z`.\n' +
				'\n' +
				'Run this on main AFTER the PR squash-merges (squash mints a new SHA,\n' +
				'so tagging from the feature branch would tag the wrong commit).',
		},
	],
	footer: 'Requires a clean working tree and `git push` access to origin.',
});

const STATUS_HELP = renderHelp({
	title: 'cam status',
	tagline: 'Show current loop state at a glance',
	usage: 'cam status',
	sections: [
		{
			heading: 'Reads three sources in the current cwd',
			body:
				'1. .claude/cam-loop.local.md  — plugin state file (iteration, started_at,\n' +
				'                                completion_promise, active flag).\n' +
				'2. prd.json                   — current story = highest-priority passes:false.\n' +
				'3. git                        — current branch + last commit (best-effort).',
		},
		{
			heading: 'Output',
			body:
				'status: idle | active | paused\n' +
				'story:  US-NNN <title>\n' +
				'iter:   N / M\n' +
				'since:  <wall-clock since started_at>\n' +
				'branch: <current branch>\n' +
				'last:   <sha> <subject>',
		},
	],
	footer: 'Exits 0 always — even when no loop is running (status: idle).',
});

const DASHBOARD_HELP = renderHelp({
	title: 'cam dashboard',
	tagline: 'Read-only TUI for monitoring a running loop',
	usage: 'cam dashboard [orchPane]',
	sections: [
		{
			heading: 'Arguments',
			body:
				'  orchPane   Optional tmux pane id of the orchestrator (e.g. %5).\n' +
				'             When provided, the keybar keys (n/r/s/p/i/d) dispatch\n' +
				'             commands to that pane. Omit for standalone monitoring.',
		},
		{
			heading: 'Behaviour',
			body:
				'1. Enters the alternate screen buffer (vim/htop style), hides the cursor.\n' +
				'2. Polls the cwd\'s prd.json + .claude/cam-loop.local.md every 2s and\n' +
				'   redraws on change.\n' +
				'3. Surfaces: branch, current story (id + title), wall-clock,\n' +
				'   last 5 progress events, story list with token counts.\n' +
				'4. Keybar: n=/cam-next  r=/cam-review  s=/cam-ship  p=/cam-plan\n' +
				'           i=/cam-issue  d=focus orchestrator  q=close pane.\n' +
				'5. Exits cleanly on q or Ctrl+C, restores the cursor + leaves alt-screen.',
		},
	],
	footer:
		'cam run places this command in pane 0.1 of the project session (permanent,\n' +
		'always visible). You can also run it standalone in any terminal.',
});

const STOP_HELP = renderHelp({
	title: 'cam stop',
	tagline: 'Cleanly cancel a running loop',
	usage: 'cam stop',
	sections: [
		{
			heading: 'What it does',
			body:
				'1. Removes .claude/cam-loop.local.md (the plugin state file).\n' +
				'2. Kills the per-project tmux session (derived from the project root\n' +
				'   path) if alive; unrelated tmux sessions are NOT touched.\n' +
				'3. Exits 0. Idempotent: calling `cam stop` with nothing to clean is the\n' +
				'   success state, not a failure.',
		},
	],
	footer: 'After `cam stop`, the next `cam next` will not detect a stale loop.',
});

const RESUME_HELP = renderHelp({
	title: 'cam resume',
	tagline: 'Reconcile loop state after an interrupt',
	usage: 'cam resume [--mode <name>] [--dry-run] [--force]',
	sections: [
		{
			heading: 'Auto-detected modes (no --mode flag)',
			entries: [
				{ name: 'idle', description: 'No state file → run `cam next` to start fresh' },
				{
					name: 'noop',
					description: 'retry-monitor alive (PID from ~/.cam/retry.pid) — loop will resume on its own',
				},
				{
					name: 'respawn',
					description: 'State file + heartbeat dead + recent commit (≤24h) → re-spawn `cam next`',
				},
				{
					name: 'prompt',
					description: 'State file + heartbeat dead + last commit >24h → asks [Y/n/reset]',
				},
				{ name: 'success', description: 'PRD already complete → auto-clean orphan state file' },
			],
		},
		{
			heading: 'Explicit --mode overrides',
			entries: [
				{
					name: '--mode reset-current-story',
					description: 'Flip most-recently-completed story back to passes:false (re-runs it next)',
				},
				{
					name: '--mode reset-prd',
					description: 'Flip every story to passes:false (re-runs PRD from US-001)',
				},
				{
					name: '--mode reset-branch',
					description: 'Print `git reset --hard origin/main` + remove state file (cam does NOT run reset)',
				},
			],
		},
		{
			heading: 'Flags',
			entries: [
				{ name: '--dry-run', description: 'Classify and print without mutating state or spawning' },
				{ name: '--force', description: 'Skip the confirmation prompt for --mode reset-branch' },
			],
		},
	],
});

// --- Argv parsers ----------------------------------------------------------

/**
 * Parse issue-subcommand positional argument. Accepts a single free-text
 * string (the issue description) or `--help` / `-h`. Returns the parsed
 * text plus a flag indicating the operator asked for help, or `null` on a
 * parse error (the caller prints the diagnostic and exits 1).
 *
 * NOTE: This parser does NOT accept `--permission-mode` — that is the
 * US-007 acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if a parser registers it.
 */

/**
 * Discriminated union returned by parseIssueArgs.
 * - mode === 'text': free-text thin-proxy path (existing behaviour).
 * - mode === 'file-local': deterministic in-process path (US-003).
 * - help === true: caller should print ISSUE_HELP and exit 0.
 */
export type ParsedIssueArgs =
	| { mode: 'text'; text: string; help: false }
	| { mode: 'file-local'; help: false }
	| { mode?: never; help: true };

export function parseIssueArgs(args: string[]): ParsedIssueArgs | null {
	if (args.includes('--help') || args.includes('-h')) {
		return { help: true };
	}
	if (args.includes('--file-local')) {
		const rest = args.filter((a) => a !== '--file-local');
		if (rest.length > 0) {
			printError(`unexpected argument: ${rest[0]!}`);
			return null;
		}
		return { mode: 'file-local', help: false };
	}
	const text = args[0];
	if (text === undefined || text.trim().length === 0) {
		printError('cam issue requires a free-text argument');
		return null;
	}
	if (args.length > 1) {
		printError(`unexpected argument: ${args[1]}`);
		return null;
	}
	return { mode: 'text', text, help: false };
}

/**
 * Parse `cam plan` args. The command takes at most one POSITIONAL argument:
 * a positive integer issue number (a leading `#` is tolerated, e.g. `'#21'`).
 * The CLI is strict on purpose; the `/cam-plan` slash inside claude stays
 * flexible (number resolved per backend, plus free-text descriptions). A
 * positional that is not a valid integer is a standardized error. A bare
 * `cam plan` (no positional) leaves `issue` undefined; the planner then picks
 * the highest-priority open issue itself.
 *
 * Returns `{ issue?, help }` or `null` on a parse error (the caller prints the
 * diagnostic and exits 1).
 */
export function parsePlanArgs(args: string[]): { issue?: number; help: boolean } | null {
	const result: { issue?: number; help: boolean } = { help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg.startsWith('-')) {
			printError(
				`unknown plan option: ${arg}`,
				'cam plan takes an issue number, e.g. `cam plan 21`',
			);
			return null;
		}
		if (result.issue !== undefined) {
			printError(
				'cam plan: too many arguments',
				'expected a single issue number, e.g. `cam plan 21`',
			);
			return null;
		}
		// Positional issue number; tolerate a leading `#` (e.g. `cam plan '#21'`).
		const token = arg.startsWith('#') ? arg.slice(1) : arg;
		const parsed = Number.parseInt(token, 10);
		if (!/^\d+$/.test(token) || parsed <= 0) {
			printError(
				'cam plan: invalid issue reference',
				'expected an issue number, e.g. `cam plan 21`',
			);
			return null;
		}
		result.issue = parsed;
	}
	return result;
}

/**
 * Parse next-specific flags. Accepts `--max-iter N` / `--max-iter=N` and
 * `--completion-promise STR` / `--completion-promise=STR`. Both are
 * optional; defaults applied in `runNext`.
 *
 * NOTE: This parser does NOT accept `--permission-mode` — that's the US-007
 * acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if it appears.
 */
export function parseNextArgs(
	args: string[],
): { maxIterations?: number; completionPromise?: string; help: boolean } | null {
	const result: { maxIterations?: number; completionPromise?: string; help: boolean } = {
		help: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--max-iter' || arg === '--max-iterations') {
			const next = args[i + 1];
			if (next === undefined) {
				printError(`${arg} requires a number`);
				return null;
			}
			const parsed = Number.parseInt(next, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				printError(`${arg} expects a positive integer, got ${JSON.stringify(next)}`);
				return null;
			}
			result.maxIterations = parsed;
			i += 1;
			continue;
		}
		if (arg.startsWith('--max-iter=') || arg.startsWith('--max-iterations=')) {
			const value = arg.slice(arg.indexOf('=') + 1);
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				printError(`${arg.split('=')[0]} expects a positive integer, got ${JSON.stringify(value)}`);
				return null;
			}
			result.maxIterations = parsed;
			continue;
		}
		if (arg === '--completion-promise') {
			const next = args[i + 1];
			if (next === undefined) {
				printError('--completion-promise requires a string');
				return null;
			}
			result.completionPromise = next;
			i += 1;
			continue;
		}
		if (arg.startsWith('--completion-promise=')) {
			result.completionPromise = arg.slice('--completion-promise='.length);
			continue;
		}
		printError(`unknown next option: ${arg}`);
		return null;
	}
	return result;
}

/**
 * Parse resume-specific flags. Accepts:
 *
 *   --mode <name>   one of: reset-current-story | reset-prd | reset-branch
 *   --mode=<name>   joined form
 *   --dry-run       classify + print, no mutations
 *   --force         skip the destructive-mode confirmation prompt
 *   --help / -h     show RESUME_HELP
 *
 * Returns `null` on a parse error (caller prints the diagnostic + exits 1).
 *
 * NOTE: This parser does NOT accept `--permission-mode` — that's the US-007
 * acceptance criterion 7 invariant. The textual smoke in
 * `test/no-permission-mode-flag.test.ts` greps this file for any registration
 * of `--permission-mode`; resume is bound by the same invariant.
 */
const RESUME_MODES = new Set<ExplicitMode>([
	'reset-current-story',
	'reset-prd',
	'reset-branch',
]);

function isExplicitMode(value: string): value is ExplicitMode {
	return (RESUME_MODES as Set<string>).has(value);
}

export function parseResumeArgs(
	args: string[],
): { mode?: ExplicitMode; dryRun: boolean; force: boolean; help: boolean } | null {
	const result: { mode?: ExplicitMode; dryRun: boolean; force: boolean; help: boolean } = {
		dryRun: false,
		force: false,
		help: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--dry-run') {
			result.dryRun = true;
			continue;
		}
		if (arg === '--force') {
			result.force = true;
			continue;
		}
		if (arg === '--mode') {
			const next = args[i + 1];
			if (next === undefined) {
				printError('--mode requires a value (one of reset-current-story | reset-prd | reset-branch)');
				return null;
			}
			if (!isExplicitMode(next)) {
				printError(`--mode expects reset-current-story | reset-prd | reset-branch, got ${JSON.stringify(next)}`);
				return null;
			}
			result.mode = next;
			i += 1;
			continue;
		}
		if (arg.startsWith('--mode=')) {
			const value = arg.slice('--mode='.length);
			if (!isExplicitMode(value)) {
				printError(`--mode expects reset-current-story | reset-prd | reset-branch, got ${JSON.stringify(value)}`);
				return null;
			}
			result.mode = value;
			continue;
		}
		printError(`unknown resume option: ${arg}`);
		return null;
	}
	return result;
}

/**
 * Parse `cam review` args. The command accepts no positional arguments and
 * only the standard --help / -h flag. Any other argument is an error.
 *
 * NOTE: This parser does NOT accept `--permission-mode` -- that is the
 * US-007 acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if a parser registers it.
 */
export function parseReviewArgs(args: string[]): { help: boolean } | null {
	const result = { help: false };
	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		printError(`unknown review option: ${arg}`);
		return null;
	}
	return result;
}

/**
 * Parse `cam ship` args. The command accepts no positional arguments and
 * only the standard --help / -h flag. Any other argument is an error.
 *
 * NOTE: This parser does NOT accept `--permission-mode` -- that is the
 * US-007 acceptance criterion 7 invariant. `test/no-permission-mode-flag.test.ts`
 * greps this file for the literal `--permission-mode` and fails the build
 * if a parser registers it.
 */
export function parseShipArgs(args: string[]): { help: boolean; finalize: boolean; bump: boolean } | null {
	const result = { help: false, finalize: false, bump: false };
	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--finalize') {
			result.finalize = true;
			continue;
		}
		if (arg === '--bump') {
			result.bump = true;
			continue;
		}
		printError(`unknown ship option: ${arg}`);
		return null;
	}
	return result;
}

// ---------------------------------------------------------------------------
// cam ship dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/** Injectable deps for dispatchShip — all optional; production uses real impls. */
export interface ShipDispatchDeps {
	/** Inject a fake finalizeCycleClose wrapper; default: uses real fs + spawnSync. */
	finalizeFn?: () => FinalizeCycleCloseResult;
	/** Inject a fake runShipBump wrapper; default: uses real fs + spawnSync. */
	bumpFn?: () => ShipBumpResult;
	/** Inject a fake runShip; default: calls the real runShip({}) thin-proxy. */
	runShipFn?: () => Promise<number>;
}

/**
 * Route a parsed `cam ship` call:
 *   --finalize => finalizeCycleClose (in-process, no tmux needed)
 *   --bump     => runShipBump (in-process, DI'd spawnFn + clock)
 *   otherwise  => runShip thin-proxy
 *
 * Exported so unit tests can inject fakes for all branches.
 */
export async function dispatchShip(
	parsed: { help: boolean; finalize: boolean; bump: boolean },
	deps?: ShipDispatchDeps,
): Promise<number> {
	if (parsed.finalize) {
		const finalizeFn = deps?.finalizeFn ?? (() => finalizeCycleClose(_buildFinalizeOpts(process.cwd())));
		try {
			finalizeFn();
			return 0;
		} catch (err) {
			printError(`cam ship --finalize failed: ${String(err)}`);
			return 1;
		}
	}
	if (parsed.bump) {
		const bumpFn = deps?.bumpFn ?? (() => runShipBump(_buildBumpOpts(process.cwd())));
		try {
			const result = bumpFn();
			if (result.noOp) {
				printHint(`version bump: ${result.reason}`);
			} else {
				printHint(`version bump: ${result.oldVersion} -> ${result.newVersion} (${result.bump})`);
			}
			return 0;
		} catch (err) {
			printError(`cam ship --bump failed: ${String(err)}`);
			return 1;
		}
	}
	const ship = deps?.runShipFn ?? (() => runShip({}));
	return ship();
}

/** Build production deps for finalizeCycleClose from the given project root. */
function _buildFinalizeOpts(cwd: string) {
	return {
		cwd,
		spawnFn: spawnSync,
		clock: () => new Date().toISOString(),
		readProjectToml: () => readFileSync(join(cwd, 'scripts/cam/project.toml'), 'utf8'),
		readPrd: () => readFileSync(join(cwd, 'scripts/cam/prd.json'), 'utf8'),
		readIssues: () => readFileSync(join(cwd, 'scripts/cam/issues.local.json'), 'utf8'),
		writeIssues: (text: string) =>
			writeFileSync(join(cwd, 'scripts/cam/issues.local.json'), text, 'utf8'),
	};
}

/** Build production deps for runShipBump from the given project root. */
function _buildBumpOpts(cwd: string) {
	return {
		cwd,
		spawnFn: spawnSync,
		clock: () => new Date().toISOString(),
		readVersionTs: () => readFileSync(join(cwd, 'src/version.ts'), 'utf8'),
		readPackageJson: () => readFileSync(join(cwd, 'package.json'), 'utf8'),
		writeVersionTs: (text: string) => writeFileSync(join(cwd, 'src/version.ts'), text, 'utf8'),
		writePackageJson: (text: string) => writeFileSync(join(cwd, 'package.json'), text, 'utf8'),
		readChangelog: () => readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'),
		writeChangelog: (text: string) => writeFileSync(join(cwd, 'CHANGELOG.md'), text, 'utf8'),
	};
}

// ---------------------------------------------------------------------------
// cam issue dispatch (exported for unit testing with injectable deps)
// ---------------------------------------------------------------------------

/** Injectable deps for dispatchIssue — both optional; production uses real impls. */
export interface IssueDispatchDeps {
	/**
	 * Inject a fake for the --file-local branch.
	 * Default: reads stdin as JSON and routes to createLocalIssueOnMain (in-process, no tmux).
	 */
	fileLocalFn?: () => Promise<number>;
	/** Inject a fake runIssue thin-proxy. Default: calls the real runIssue with the parsed text. */
	runIssueFn?: () => Promise<number>;
}

/** Build production CreateLocalIssueOnMainOptions from project root + parsed stdin JSON. */
function _buildCreateIssueOpts(
	cwd: string,
	parsedStdin: { title: string; description?: string; priority?: string },
): CreateLocalIssueOnMainOptions {
	return {
		cwd,
		title: parsedStdin.title,
		...(parsedStdin.description !== undefined ? { description: parsedStdin.description } : {}),
		...(parsedStdin.priority !== undefined ? { priority: parsedStdin.priority } : {}),
		spawnFn: (cmd, args, opts) =>
			spawnSync(cmd, args, {
				encoding: opts.encoding,
				...(opts.env !== undefined ? { env: opts.env } : {}),
				...(opts.input !== undefined ? { input: opts.input } : {}),
				stdio: 'pipe',
			}) as SpawnSyncReturns<string>,
		clock: () => new Date().toISOString(),
		readProjectToml: () => readFileSync(join(cwd, 'scripts/cam/project.toml'), 'utf8'),
	};
}

/**
 * Route a parsed `cam issue` call: --file-local => createLocalIssueOnMain (in-process,
 * reads stdin as JSON, no tmux needed); otherwise => runIssue thin-proxy. Exported so
 * unit tests can inject fakes for both branches and prove the --file-local path NEVER
 * calls runIssue.
 */
export async function dispatchIssue(
	parsed: ParsedIssueArgs,
	deps?: IssueDispatchDeps,
): Promise<number> {
	if (parsed.mode === 'file-local') {
		const fileLocalFn =
			deps?.fileLocalFn ??
			(async () => {
				const stdinText = await Bun.stdin.text();
				let stdinData: { title: string; description?: string; priority?: string };
				try {
					stdinData = JSON.parse(stdinText) as {
						title: string;
						description?: string;
						priority?: string;
					};
				} catch (err) {
					printError(`cam issue --file-local: invalid JSON from stdin: ${String(err)}`);
					return 1;
				}
				try {
					const result = createLocalIssueOnMain(
						_buildCreateIssueOpts(process.cwd(), stdinData),
					);
					if (!result.ok) {
						// printError already fired inside createLocalIssueOnMain
						return 1;
					}
					printHint(`filed ${result.id} on main (${result.sha})`);
					return 0;
				} catch (err) {
					printError(`cam issue --file-local failed: ${String(err)}`);
					return 1;
				}
			});
		return fileLocalFn();
	}
	// Free-text thin-proxy path (text mode or unexpected help=true — help is handled in main()).
	const text = parsed.mode === 'text' ? parsed.text : '';
	const issueFn = deps?.runIssueFn ?? (() => runIssue({ text }));
	return issueFn();
}

async function main(argv: string[]): Promise<number> {
	const command = argv[2];
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(HELP);
		return 0;
	}
	// `cam --version` / `cam -v` / `cam version`. We accept all three
	// because Unix CLIs are inconsistent about which form is canonical and
	// shipping just one would surprise muscle memory. The output shape is
	// `cam 0.1.0` (single line, trailing newline).
	if (command === '--version' || command === '-v' || command === 'version') {
		// `cam --version` is a machine-readable contract: emit exactly
		// `cam X.Y.Z\n` so scripts piping into `head -1` or doing `==`
		// comparisons keep working. The "leading/trailing blank line"
		// convention applies to human-facing screens, not to version probes.
		process.stdout.write(`cam ${CAM_VERSION}\n`);
		return 0;
	}

	switch (command) {
		case 'init': {
			const setupArgs = parseSetupArgs(argv.slice(3));
			if (setupArgs === null) {
				printFatalHint('run `cam init --help` for usage');
				return 1;
			}
			if (setupArgs.help) {
				process.stdout.write(INIT_HELP);
				return 0;
			}
			const machineCode = await runInit();
			if (machineCode !== 0) return machineCode;
			return runSetup({
				projectMode: setupArgs.projectMode,
				issueSystem: setupArgs.issueSystem,
				description: setupArgs.description,
				noTmux: setupArgs.noTmux,
			});
		}
		case 'setup': {
			// Skip Stage 1 (machine validation) — exposes the SetupScreen directly
			// for previewing/iterating on its layout without re-running `cam init`.
			// Accepts the same flags as `cam init` Stage 2.
			const setupArgs = parseSetupArgs(argv.slice(3));
			if (setupArgs === null) {
				printFatalHint('run `cam init --help` for usage (setup shares its flags)');
				return 1;
			}
			if (setupArgs.help) {
				process.stdout.write(INIT_HELP);
				return 0;
			}
			return runSetup({
				projectMode: setupArgs.projectMode,
				issueSystem: setupArgs.issueSystem,
				description: setupArgs.description,
				noTmux: setupArgs.noTmux,
			});
		}
		case 'config': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(
					'Usage: cam config [--show]\n' +
					'  Interactive wizard to set model per phase and backend\n' +
					'  --show  Print current config without prompting (US-008)\n',
				);
				return 0;
			}
			const showFlag = tail.includes('--show');
			const unknownFlags = tail.filter((a) => a !== '--show');
			if (unknownFlags.length > 0) {
				printError(`unknown config option: ${unknownFlags[0]}`);
				printFatalHint('run `cam config --help` for usage');
				return 1;
			}
			return runConfig({ show: showFlag });
		}
		case 'run': {
			const parsed = parseRunArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam run --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(RUN_HELP);
				return 0;
			}
			return runRun({ noAttach: parsed.noAttach });
		}
		case 'plan': {
			const parsed = parsePlanArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam plan --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(PLAN_HELP);
				return 0;
			}
			return runPlan({ issue: parsed.issue });
		}
		case 'issue': {
			const parsed = parseIssueArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('Usage: cam issue "<free text>" | cam issue --file-local');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(ISSUE_HELP);
				return 0;
			}
			return dispatchIssue(parsed);
		}
		case 'next': {
			const parsed = parseNextArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam next --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(NEXT_HELP);
				return 0;
			}
			return runNext({
				maxIterations: parsed.maxIterations,
				completionPromise: parsed.completionPromise,
			});
		}
		case 'review': {
			const parsed = parseReviewArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam review --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(REVIEW_HELP);
				return 0;
			}
			return runReview({});
		}
		case 'ship': {
			const parsed = parseShipArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam ship --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(SHIP_HELP);
				return 0;
			}
			return dispatchShip(parsed);
		}
		case 'tag': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(TAG_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown tag option: ${tail[0]}`);
				printFatalHint('run `cam tag --help` for usage');
				return 1;
			}
			const tagResult = runTag({
				cwd: process.cwd(),
				spawnFn: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, cwd: process.cwd() }),
			});
			return tagResult.ok ? 0 : 1;
		}
		case 'dashboard': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(DASHBOARD_HELP);
				return 0;
			}
			// Optional positional: orchPane (tmux pane id, e.g. %5). Injected by
			// `cam run` so the keybar can dispatch to the orchestrator. Omitted
			// when the dashboard is run standalone.
			const remaining = [...tail];
			let orchPane: string | undefined;
			if (remaining.length > 0 && !remaining[0]!.startsWith('-')) {
				orchPane = remaining.shift();
			}
			if (remaining.length > 0) {
				printError(`unknown dashboard option: ${remaining[0]}`);
				printFatalHint('run `cam dashboard --help` for usage');
				return 1;
			}
			return runDashboardInk({ ...(orchPane !== undefined ? { orchPane } : {}) });
		}
		case 'status': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(STATUS_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown status option: ${tail[0]}`);
				printFatalHint('run `cam status --help` for usage');
				return 1;
			}
			return runStatus();
		}
		case 'orch-budget': {
			// CAM-23 US-001: machine-parseable orchestrator token-budget line.
			// Read-only, no flags; the orchestrator agent invokes it each cycle.
			return runOrchBudget();
		}
		case 'stop': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(STOP_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown stop option: ${tail[0]}`);
				printFatalHint('run `cam stop --help` for usage');
				return 1;
			}
			return runStop();
		}
		case 'resume': {
			const parsed = parseResumeArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam resume --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(RESUME_HELP);
				return 0;
			}
			return runResume({
				...(parsed.mode ? { mode: parsed.mode } : {}),
				dryRun: parsed.dryRun,
				force: parsed.force,
			});
		}
		case 'claude': {
			const parsed = parseClaudeArgs(argv.slice(3));
			if (parsed.help) {
				process.stdout.write(CLAUDE_HELP);
				return 0;
			}
			return runClaude({ args: parsed.forwardedArgs });
		}
		// Internal subcommand — not listed in top-level HELP.
		// Spawned as a detached background process by cam run (US-FIX-002).
		// Polls the active flag in .claude/cam-loop.local.md and calls
		// runSupervisor when active:true with non-operator stories pending.
		case 'sidecar': {
			await runSidecar();
			return 0;
		}
		// Internal subcommand — not listed in top-level HELP.
		// Forked as a detached background process by forkMonitor() when running
		// inside a tmux session.
		case 'retry-monitor': {
			const parsed = parseRetryMonitorArgs(argv.slice(3));
			if (parsed === null) {
				printFatalHint('run `cam retry-monitor --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(RETRY_MONITOR_HELP);
				return 0;
			}
			return runRetryMonitor({ pane: parsed.pane, pid: parsed.pid });
		}
		default:
			printError(`unknown command: ${command}`);
			printFatalHint('run `cam help` to see the available commands');
			return 1;
	}
}

// Only execute when invoked as a script (not when imported by a test).
// `import.meta.main` is true exactly once — when this module is the entry
// point passed to `bun`. Tests that import this file to exercise
// `parsePlanArgs` / `parseNextArgs` skip the dispatcher entirely.
if (import.meta.main) {
	const exitCode = await main(process.argv);
	process.exit(exitCode);
}

export { main };

