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

import { runDashboardInk } from './src/commands/dashboard.ts';
import { runInit } from './src/commands/init.ts';
import { runIssue } from './src/commands/issue.ts';
import { runNext } from './src/commands/next.ts';
import { runSetup, parseSetupArgs } from './src/commands/setup.ts';
import { runPlan } from './src/commands/plan.ts';
import { runResume, type ExplicitMode } from './src/commands/resume.ts';
import { runRun, parseRunArgs } from './src/commands/run.ts';
import { runStatus } from './src/commands/status.ts';
import { runStop } from './src/commands/stop.ts';
import { runClaude, parseClaudeArgs, CLAUDE_HELP } from './src/commands/claude.ts';
import { runRetryMonitor, parseRetryMonitorArgs, RETRY_MONITOR_HELP } from './src/commands/retry-monitor.ts';
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
				{ name: 'run [options]', description: 'Open or attach the long-lived orchestrator (tmux session)' },
				{ name: 'plan [--issue <N>]', description: 'Spawn claude + dispatch /cam-plan; prompts on APPROVE' },
				{ name: 'next [options]', description: 'Spawn the autonomous loop (Ghostty split + claude + dashboard)' },
				{ name: 'issue "<text>"', description: 'File an issue from free text; opens /cam-issue create in a pane' },
				{ name: 'claude [args...]', description: 'Run claude in print mode with auto-retry on rate limits' },
				{ name: 'dashboard', description: 'Standalone read-only TUI (alt-screen) for monitoring a loop' },
				{ name: 'status', description: 'Show current loop state at a glance (idle / active / paused)' },
				{ name: 'stop', description: 'Cancel a running loop (clears state file + kills tmux session "cam")' },
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
	tagline: 'Open or attach the long-lived orchestrator session',
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
				'3. If the session exists: attach.\n' +
				'   Otherwise: create with two panes (orchestrator on the left, status\n' +
				'   menu on the right) and attach.\n' +
				'4. Inside an existing tmux: uses `switch-client` instead of `attach`.',
		},
	],
	footer:
		'The orchestrator persona is loaded from\n' +
		'.claude/agents/subagent-orchestrator.md — see that file for what it does.',
});

const PLAN_HELP = renderHelp({
	title: 'cam plan',
	tagline: 'Wrap an interactive claude session that runs /cam-plan',
	usage: 'cam plan [--issue <N>]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{
					name: '--issue <N>',
					description: 'Plan against GitHub issue #N (passed as `/cam-plan #N`)',
				},
			],
		},
		{
			heading: 'Behaviour',
			body:
				'1. Spawns `claude` (permission mode from ~/.config/cam/config.toml)\n' +
				'   attached to your TTY.\n' +
				'2. The slash command is sent as the first user-turn.\n' +
				'3. After the prd-auditor emits `verdict: "APPROVE"`, cam asks\n' +
				'   `Approve PRD and create branch? [y/N]`.\n' +
				'4. On `y`: planner continues to its branch + commit step.\n' +
				'5. On `N` / empty: cam terminates the planning session and exits 0.',
		},
	],
	footer:
		'Without --issue, cam dispatches a bare `/cam-plan` and the planner picks\n' +
		'the highest-priority pending issue itself.',
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
				'1. Reads `permission_mode` from `~/.config/cam/config.toml` (default\n' +
				'   `bypassPermissions`). cam does NOT accept a `--permission-mode`\n' +
				'   flag — change the config file with `cam init` to override.\n' +
				'2. Ensures the project tmux session exists\n' +
				'   (cam-orch-<basename>-<hash>); creates it if needed.\n' +
				'3. Opens a new pane inside the session running:\n' +
				'     claude --permission-mode <mode> "/cam-issue create <text>"\n' +
				'4. Returns 0 immediately — the issue-creation flow runs inside\n' +
				'   the pane. Attach with `cam run` to watch.',
		},
	],
	footer:
		'The free text is passed verbatim to the /cam-issue create slash command.\n' +
		'The pane agent expands it into a structured issue title + description.',
});

const NEXT_HELP = renderHelp({
	title: 'cam next',
	tagline: 'Spawn the autonomous loop',
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
				'1. Reads `permission_mode` from `~/.config/cam/config.toml` (default\n' +
				'   `bypassPermissions`). cam does NOT accept a `--permission-mode`\n' +
				'   flag — change the config file with `cam init` to override.\n' +
				'2. Pre-arms the `cam-loop` plugin by writing\n' +
				'   `.claude/cam-loop.local.md` (vendored template at\n' +
				'   `vendor/cam-loop.local.md.tmpl`).\n' +
				'3. Detects the host terminal:\n' +
				'     Ghostty                 → opens a horizontal split (claude in current\n' +
				'                               pane, `cam dashboard` in new pane).\n' +
				'     VS Code (TERM_PROGRAM)  → inline single-pane (the IDE is the dashboard).\n' +
				'     anything else           → inline single-pane.\n' +
				'4. Spawns `claude` with `/cam-next` as the first user-turn.\n' +
				'5. Returns claude\'s exit code on session end.',
		},
		{
			heading: 'Stop primitives',
			body:
				'/cancel-cam  (preferred — cleans up the state file)\n' +
				'rm .claude/cam-loop.local.md  (kill switch — loop ends after current turn)',
		},
	],
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
	usage: 'cam dashboard',
	sections: [
		{
			heading: 'Behaviour',
			body:
				'1. Enters the alternate screen buffer (vim/htop style), hides the cursor.\n' +
				'2. Polls the cwd\'s prd.json + .claude/cam-loop.local.md every 2s and\n' +
				'   redraws on change.\n' +
				'3. Surfaces: branch, current story (id + title), iteration N/M, wall-clock,\n' +
				'   last 5 progress.txt entries, sleep banner if active:false.\n' +
				'4. Exits cleanly on `q` or Ctrl+C — restores the cursor + leaves alt-screen.',
		},
	],
	footer:
		'This command is read-only. `cam next` spawns it in pane B of a Ghostty\n' +
		'split; you can also run it standalone in any terminal that hosts the loop.',
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
				'2. Kills the tmux session named exactly "cam" if alive (defensive —\n' +
				'   unrelated tmux sessions are NOT touched).\n' +
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
export function parseIssueArgs(args: string[]): { text: string; help: boolean } | null {
	if (args.includes('--help') || args.includes('-h')) {
		return { text: '', help: true };
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
	return { text, help: false };
}

/**
 * Parse plan-specific flags from argv. We accept either `--issue 123`
 * (separate token) or `--issue=123` (joined). Returns the parsed issue
 * number plus a flag indicating the operator asked for help, or `null` on
 * a parse error (the caller prints the diagnostic and exits 1).
 */
export function parsePlanArgs(args: string[]): { issue?: number; help: boolean } | null {
	const result: { issue?: number; help: boolean } = { help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--issue') {
			const next = args[i + 1];
			if (next === undefined) {
				printError('--issue requires a number');
				return null;
			}
			const parsed = Number.parseInt(next, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				printError(`--issue expects a positive integer, got ${JSON.stringify(next)}`);
				return null;
			}
			result.issue = parsed;
			i += 1;
			continue;
		}
		if (arg.startsWith('--issue=')) {
			const value = arg.slice('--issue='.length);
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				printError(`--issue expects a positive integer, got ${JSON.stringify(value)}`);
				return null;
			}
			result.issue = parsed;
			continue;
		}
		printError(`unknown plan option: ${arg}`);
		return null;
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
				printFatalHint('Usage: cam issue "<free text>"');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(ISSUE_HELP);
				return 0;
			}
			return runIssue({ text: parsed.text });
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
		case 'dashboard': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(DASHBOARD_HELP);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown dashboard option: ${tail[0]}`);
				printFatalHint('run `cam dashboard --help` for usage');
				return 1;
			}
			return runDashboardInk();
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

