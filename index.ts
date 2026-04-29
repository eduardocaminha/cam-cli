// index.ts
//
// ralph CLI entrypoint. Dispatches subcommands by argv[2]; everything else is
// implemented in `src/commands/<name>.ts`. We deliberately avoid pulling in
// `commander` / `yargs` for the current CLI surface — argv parsing fits
// inline, and a third-party arg parser would be the largest single dep in
// the project. As more subcommands with more options land we will revisit
// (this point gets re-evaluated each story; US-007 still fits inline because
// only `next` adds two more options, both with simple value parsing).
//
// IMPORTANT INVARIANT (US-007 acceptance criterion 7):
//   No subcommand parser registers a `--permission-mode` flag. The value is
//   sourced exclusively from `~/.config/ralph/config.toml` via
//   `src/config/permission-mode.ts`. The unit test
//   `test/no-permission-mode-flag.test.ts` greps this file (and every file
//   in `src/commands/`) for `--permission-mode` patterns and fails the build
//   on a registration. Search markers documented in that test.

import process from 'node:process';

import { runInit } from './src/commands/init.ts';
import { runNext } from './src/commands/next.ts';
import { runPlan } from './src/commands/plan.ts';
import { printError, printHint } from './src/logging/color.ts';

const HELP = `ralph — autonomous Claude Code loop driver

Usage:
  ralph <command> [options]

Commands:
  init                    Validate the machine and write ~/.config/ralph/config.toml
  plan [--issue <N>]      Spawn claude + dispatch /ralph-plan; prompts on APPROVE
  next [options]          Spawn the autonomous loop (Ghostty split + claude + dashboard)
  help                    Show this help

Run \`ralph <command> --help\` for command-specific options. Permission mode
for spawned claude sessions is read from \`~/.config/ralph/config.toml\` —
no subcommand exposes a CLI flag for it (run \`ralph init\` to set).`;

const PLAN_HELP = `ralph plan — wrap an interactive claude session that runs /ralph-plan

Usage:
  ralph plan [--issue <N>]

Options:
  --issue <N>    Plan against GitHub issue #N (passed through as \`/ralph-plan #N\`).
                 Without this flag, ralph dispatches a bare \`/ralph-plan\` and the
                 planner picks the highest-priority pending issue itself.

Behaviour:
  1. Spawns \`claude\` (permission mode from ~/.config/ralph/config.toml)
     attached to your TTY.
  2. The slash command is sent as the first user-turn.
  3. After the prd-auditor emits \`verdict: "APPROVE"\`, ralph asks
     \`Approve PRD and create branch? [y/N]\`.
  4. On \`y\`: planner continues to its branch + commit step.
  5. On \`N\` / empty: ralph terminates the planning session and exits 0.`;

const NEXT_HELP = `ralph next — spawn the autonomous loop

Usage:
  ralph next [--max-iter <N>] [--completion-promise <STR>]

Options:
  --max-iter <N>              Max iterations before auto-stop. Default: 30.
  --completion-promise <STR>  Phrase the assistant emits to end the loop.
                              Default: COMPLETE (assistant emits
                              \`<promise>COMPLETE</promise>\`).

Behaviour:
  1. Reads \`permission_mode\` from \`~/.config/ralph/config.toml\` (default
     \`bypassPermissions\`). Ralph does NOT accept a \`--permission-mode\`
     flag — change the config file with \`ralph init\` to override.
  2. Pre-arms the \`ralph-loop\` plugin by writing
     \`.claude/ralph-loop.local.md\` (vendored template at
     \`vendor/ralph-loop.local.md.tmpl\`).
  3. Detects the host terminal:
       Ghostty                 → opens a horizontal split (claude in current
                                 pane, \`ralph dashboard\` in new pane).
       VS Code (TERM_PROGRAM)  → inline single-pane (the IDE is the dashboard).
       anything else           → inline single-pane.
  4. Spawns \`claude\` with \`/ralph-next\` as the first user-turn.
  5. Returns claude's exit code on session end.

Stop primitives:
  /cancel-ralph  (preferred — cleans up the state file)
  rm .claude/ralph-loop.local.md  (kill switch — loop ends after current turn)`;

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

async function main(argv: string[]): Promise<number> {
	const command = argv[2];
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}

	switch (command) {
		case 'init':
			return runInit();
		case 'plan': {
			const parsed = parsePlanArgs(argv.slice(3));
			if (parsed === null) {
				printHint('run `ralph plan --help` for usage');
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
				printHint('run `ralph next --help` for usage');
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
		default:
			printError(`unknown command: ${command}`);
			printHint('run `ralph help` to see the available commands');
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

