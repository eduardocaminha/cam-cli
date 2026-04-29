// index.ts
//
// ralph CLI entrypoint. Dispatches subcommands by argv[2]; everything else is
// implemented in `src/commands/<name>.ts`. We deliberately avoid pulling in
// `commander` / `yargs` for a 4-subcommand CLI — the surface is small enough
// that argv parsing fits inline, and a third-party arg parser would be the
// largest single dep in the project.

import process from 'node:process';

import { runInit } from './src/commands/init.ts';
import { printError, printHint } from './src/logging/color.ts';

const HELP = `ralph — autonomous Claude Code loop driver

Usage:
  ralph <command> [options]

Commands:
  init        Validate the machine and write ~/.config/ralph/config.toml
  help        Show this help

Run \`ralph <command> --help\` for command-specific options. Until the rest of
the subcommands land (US-006+), only \`init\` is implemented.`;

function main(argv: string[]): number {
	const command = argv[2];
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}

	switch (command) {
		case 'init':
			return runInit();
		default:
			printError(`unknown command: ${command}`);
			printHint('run `ralph help` to see the available commands');
			return 1;
	}
}

const exitCode = main(process.argv);
process.exit(exitCode);
