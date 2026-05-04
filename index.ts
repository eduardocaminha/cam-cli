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

import { runDashboard } from './src/commands/dashboard.ts';
import { runInit } from './src/commands/init.ts';
import { runNext } from './src/commands/next.ts';
import { runSetup, parseSetupArgs } from './src/commands/setup.ts';
import { runPlan } from './src/commands/plan.ts';
import { runResume, type ExplicitMode } from './src/commands/resume.ts';
import { runRun, parseRunArgs } from './src/commands/run.ts';
import { runStatus } from './src/commands/status.ts';
import { runStop } from './src/commands/stop.ts';
import { printError, printHint } from './src/logging/color.ts';
import { CAM_VERSION } from './src/version.ts';

const HELP = `cam — autonomous Claude Code loop driver

Usage:
  cam <command> [options]

Commands:
  init [options]          Validate the machine, then run the project-setup wizard
  run [options]           Open or attach the long-lived orchestrator (tmux session)
  plan [--issue <N>]      Spawn claude + dispatch /cam-plan; prompts on APPROVE
  next [options]          Spawn the autonomous loop (Ghostty split + claude + dashboard)
  dashboard               Standalone read-only TUI (alt-screen) for monitoring a loop
  status                  Show current loop state at a glance (idle / active / paused)
  stop                    Cancel a running loop (clears state file + kills tmux session "cam")
  resume [options]        Reconcile loop state after interrupt; auto-detect or --mode <name>
  version                 Print the installed cam-cli version (also \`--version\` / \`-v\`)
  help                    Show this help

Run \`cam <command> --help\` for command-specific options. Permission mode
for spawned claude sessions is read from \`~/.config/cam/config.toml\` —
no subcommand exposes a CLI flag for it (run \`cam init\` to set).`;

const INIT_HELP = `cam init — validate the machine and set up the project for the cam loop

Usage:
  cam init [options]

Options:
  --new               Treat this as a new project (skip the new/existing question).
  --existing          Treat this as an existing project.
  --issue-system <x>  linear | github | none. Skip the issue-system question.
  --description "<t>" Project description for new projects (skip the prompt).
  --no-tmux           Install templates only; skip spawning the tmux setup session.

Behaviour:
  Stage 1 — Machine validation:
    1. Checks \`claude\` is on PATH and logged in.
    2. Checks \`claude-auto-retry\` is on PATH.
    3. Runs vendored smokes (check-agent-frontmatter, claude-auto-retry-patterns).
    4. Writes ~/.config/cam/config.toml with permission_mode = "bypassPermissions".

  Stage 2 — Project setup wizard (if stage 1 passes):
    1. Asks: new project or existing?
    2. Verifies claude is installed and logged in.
    3. Asks: which issue system (linear | github | none)?
    4. If new: asks for a brief project description.
    5. Installs cam templates into .claude/commands/, .claude/agents/, scripts/cam/.
    6. Writes scripts/cam/project.toml with per-project config.
    7. Opens a tmux split:
         Pane A (left):  claude in bypassPermissions, adapts templates to this project.
         Pane B (right): key menu — c to interact, v for view-only, q to close.
    8. Auto-handoff: when the config agent emits CAM_SETUP_STATUS=DONE,
       the orchestrator is launched in a new pane immediately. The menu
       pane updates with options: o (orchestrator), c (config), k (kill
       config pane), q (close menu).`;

const RUN_HELP = `cam run — open or attach the long-lived orchestrator session

Usage:
  cam run [options]

Options:
  --no-attach    Create the orchestrator session but do not attach the
                 current terminal to it. Useful for scripting.

Behaviour:
  1. Verifies tmux and \`.claude/agents/subagent-orchestrator.md\` exist
     (run \`cam init\` first if not).
  2. Computes a stable session name per project (cam-orch-<basename>-<hash>).
  3. If the session exists: attach.
     Otherwise: create with two panes (orchestrator on the left, status
     menu on the right) and attach.
  4. Inside an existing tmux: uses \`switch-client\` instead of \`attach\`.

The orchestrator persona is loaded from
.claude/agents/subagent-orchestrator.md — see that file for what it does.`;

const PLAN_HELP = `cam plan — wrap an interactive claude session that runs /cam-plan

Usage:
  cam plan [--issue <N>]

Options:
  --issue <N>    Plan against GitHub issue #N (passed through as \`/cam-plan #N\`).
                 Without this flag, cam dispatches a bare \`/cam-plan\` and the
                 planner picks the highest-priority pending issue itself.

Behaviour:
  1. Spawns \`claude\` (permission mode from ~/.config/cam/config.toml)
     attached to your TTY.
  2. The slash command is sent as the first user-turn.
  3. After the prd-auditor emits \`verdict: "APPROVE"\`, cam asks
     \`Approve PRD and create branch? [y/N]\`.
  4. On \`y\`: planner continues to its branch + commit step.
  5. On \`N\` / empty: cam terminates the planning session and exits 0.`;

const NEXT_HELP = `cam next — spawn the autonomous loop

Usage:
  cam next [--max-iter <N>] [--completion-promise <STR>]

Options:
  --max-iter <N>              Max iterations before auto-stop. Default: 30.
  --completion-promise <STR>  Phrase the assistant emits to end the loop.
                              Default: COMPLETE (assistant emits
                              \`<promise>COMPLETE</promise>\`).

Behaviour:
  1. Reads \`permission_mode\` from \`~/.config/cam/config.toml\` (default
     \`bypassPermissions\`). cam does NOT accept a \`--permission-mode\`
     flag — change the config file with \`cam init\` to override.
  2. Pre-arms the \`cam-loop\` plugin by writing
     \`.claude/cam-loop.local.md\` (vendored template at
     \`vendor/cam-loop.local.md.tmpl\`).
  3. Detects the host terminal:
       Ghostty                 → opens a horizontal split (claude in current
                                 pane, \`cam dashboard\` in new pane).
       VS Code (TERM_PROGRAM)  → inline single-pane (the IDE is the dashboard).
       anything else           → inline single-pane.
  4. Spawns \`claude\` with \`/cam-next\` as the first user-turn.
  5. Returns claude's exit code on session end.

Stop primitives:
  /cancel-cam  (preferred — cleans up the state file)
  rm .claude/cam-loop.local.md  (kill switch — loop ends after current turn)`;

const STATUS_HELP = `cam status — show current loop state at a glance

Usage:
  cam status

Reads three sources in the current cwd:
  1. .claude/cam-loop.local.md  — plugin state file (iteration, started_at,
                                    completion_promise, active flag).
  2. prd.json                     — current story = highest-priority passes:false.
  3. git                          — current branch + last commit (best-effort).

Output:
  status: idle | active | paused
  story:  US-NNN <title>
  iter:   N / M
  since:  <wall-clock since started_at>
  branch: <current branch>
  last:   <sha> <subject>

Exits 0 always — even when no loop is running (status: idle).`;

const DASHBOARD_HELP = `cam dashboard — read-only TUI for monitoring a running loop

Usage:
  cam dashboard

Behaviour:
  1. Enters the alternate screen buffer (vim/htop style), hides the cursor.
  2. Polls the cwd's prd.json + .claude/cam-loop.local.md every 2s and
     redraws on change.
  3. Surfaces: branch, current story (id + title), iteration N/M, wall-clock,
     last 5 progress.txt entries, sleep banner if active:false.
  4. Exits cleanly on \`q\` or Ctrl+C — restores the cursor + leaves alt-screen.

This command is read-only. \`cam next\` spawns it in pane B of a Ghostty
split; you can also run it standalone in any terminal that hosts the loop.`;

const STOP_HELP = `cam stop — cleanly cancel a running loop

Usage:
  cam stop

What it does:
  1. Removes .claude/cam-loop.local.md (the plugin state file).
  2. Kills the tmux session named exactly "cam" if alive (defensive —
     unrelated tmux sessions are NOT touched).
  3. Exits 0. Idempotent: calling \`cam stop\` with nothing to clean is the
     success state, not a failure.

After \`cam stop\`, the next \`cam next\` will not detect a stale loop.`;

const RESUME_HELP = `cam resume — reconcile loop state after an interrupt

Usage:
  cam resume [--mode <name>] [--dry-run] [--force]

Auto-detected modes (no --mode flag):
  idle      No state file → run \`cam next\` to start fresh.
  noop      claude-auto-retry process alive → loop is in a rate-limit
            sleep window; will resume on its own.
  respawn   State file present + heartbeat PID dead + recent commit
            (≤ 24h) → re-spawn \`cam next\` to re-attach.
  prompt    State file present + heartbeat PID dead + last commit
            > 24h old (or unknown) → asks [Y/n/reset]:
                  Y      continue (treat as respawn)
                  n      abort (exit 1; no recovery)
                  reset  remove state file + exit 0
  success   PRD already complete → auto-clean orphan state file.

Explicit --mode overrides:
  --mode reset-current-story   Flip the most-recently-completed story back
                               to passes:false. Re-runs that story on the
                               next \`cam next\`.
  --mode reset-prd             Flip every story to passes:false. Re-runs the
                               whole PRD from US-001.
  --mode reset-branch          Print the operator-driven \`git reset --hard
                               origin/main\` instruction + remove the state
                               file. cam does NOT run the destructive
                               \`git reset\` itself.

Flags:
  --dry-run    Classify and print without mutating state or spawning.
  --force      Skip the confirmation prompt for --mode reset-branch.`;

// --- Argv parsers ----------------------------------------------------------

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
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	// `cam --version` / `cam -v` / `cam version`. We accept all three
	// because Unix CLIs are inconsistent about which form is canonical and
	// shipping just one would surprise muscle memory. The output shape is
	// `cam 0.1.0` (single line, trailing newline).
	if (command === '--version' || command === '-v' || command === 'version') {
		process.stdout.write(`cam ${CAM_VERSION}\n`);
		return 0;
	}

	switch (command) {
		case 'init': {
			const setupArgs = parseSetupArgs(argv.slice(3));
			if (setupArgs === null) {
				printHint('run `cam init --help` for usage');
				return 1;
			}
			if (setupArgs.help) {
				process.stdout.write(`${INIT_HELP}\n`);
				return 0;
			}
			const machineCode = runInit();
			if (machineCode !== 0) return machineCode;
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
				printHint('run `cam run --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(`${RUN_HELP}\n`);
				return 0;
			}
			return runRun({ noAttach: parsed.noAttach });
		}
		case 'plan': {
			const parsed = parsePlanArgs(argv.slice(3));
			if (parsed === null) {
				printHint('run `cam plan --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(`${PLAN_HELP}\n`);
				return 0;
			}
			return runPlan({ issue: parsed.issue });
		}
		case 'next': {
			const parsed = parseNextArgs(argv.slice(3));
			if (parsed === null) {
				printHint('run `cam next --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(`${NEXT_HELP}\n`);
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
				process.stdout.write(`${DASHBOARD_HELP}\n`);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown dashboard option: ${tail[0]}`);
				printHint('run `cam dashboard --help` for usage');
				return 1;
			}
			return runDashboard();
		}
		case 'status': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(`${STATUS_HELP}\n`);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown status option: ${tail[0]}`);
				printHint('run `cam status --help` for usage');
				return 1;
			}
			return runStatus();
		}
		case 'stop': {
			const tail = argv.slice(3);
			if (tail.includes('--help') || tail.includes('-h')) {
				process.stdout.write(`${STOP_HELP}\n`);
				return 0;
			}
			if (tail.length > 0) {
				printError(`unknown stop option: ${tail[0]}`);
				printHint('run `cam stop --help` for usage');
				return 1;
			}
			return runStop();
		}
		case 'resume': {
			const parsed = parseResumeArgs(argv.slice(3));
			if (parsed === null) {
				printHint('run `cam resume --help` for usage');
				return 1;
			}
			if (parsed.help) {
				process.stdout.write(`${RESUME_HELP}\n`);
				return 0;
			}
			return runResume({
				...(parsed.mode ? { mode: parsed.mode } : {}),
				dryRun: parsed.dryRun,
				force: parsed.force,
			});
		}
		default:
			printError(`unknown command: ${command}`);
			printHint('run `cam help` to see the available commands');
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

