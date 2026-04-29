// index.ts
//
// ralph CLI entrypoint. Dispatches subcommands by argv[2]; everything else is
// implemented in `src/commands/<name>.ts`. We deliberately avoid pulling in
// `commander` / `yargs` for a small CLI surface — argv parsing fits inline,
// and a third-party arg parser would be the largest single dep in the
// project. As more subcommands with options land (US-007+) we will revisit.

import process from 'node:process';

import { runInit } from './src/commands/init.ts';
import { runPlan } from './src/commands/plan.ts';
import { printError, printHint } from './src/logging/color.ts';

const HELP = `ralph — autonomous Claude Code loop driver

Usage:
  ralph <command> [options]

Commands:
  init                    Validate the machine and write ~/.config/ralph/config.toml
  plan [--issue <N>]      Spawn claude + dispatch /ralph-plan; prompts on APPROVE
  help                    Show this help

Run \`ralph <command> --help\` for command-specific options. Until the rest of
the subcommands land (US-007+), only \`init\` and \`plan\` are implemented.`;

const PLAN_HELP = `ralph plan — wrap an interactive claude session that runs /ralph-plan

Usage:
  ralph plan [--issue <N>]

Options:
  --issue <N>    Plan against GitHub issue #N (passed through as \`/ralph-plan #N\`).
                 Without this flag, ralph dispatches a bare \`/ralph-plan\` and the
                 planner picks the highest-priority pending issue itself.

Behaviour:
  1. Spawns \`claude --permission-mode bypassPermissions\` attached to your TTY.
  2. The slash command is sent as the first user-turn.
  3. After the prd-auditor emits \`verdict: "APPROVE"\`, ralph asks
     \`Approve PRD and create branch? [y/N]\`.
  4. On \`y\`: planner continues to its branch + commit step.
  5. On \`N\` / empty: ralph terminates the planning session and exits 0.`;

/**
 * Parse plan-specific flags from argv. We accept either `--issue 123`
 * (separate token) or `--issue=123` (joined). Returns the parsed issue
 * number plus a flag indicating the operator asked for help, or `null` on
 * a parse error (the caller prints the diagnostic and exits 1).
 */
function parsePlanArgs(args: string[]): { issue?: number; help: boolean } | null {
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
		default:
			printError(`unknown command: ${command}`);
			printHint('run `ralph help` to see the available commands');
			return 1;
	}
}

const exitCode = await main(process.argv);
process.exit(exitCode);
