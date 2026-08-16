#!/usr/bin/env bun

import process from 'node:process';

import { runInit } from './src/commands/init.ts';
import { DEFAULT_WEB_PORT, runWeb } from './src/commands/web.ts';
import { printError, printFatalHint } from './src/logging/color.ts';
import { renderHelp } from './src/logging/help.ts';
import { GSHIP_VERSION } from './src/version.ts';

const HELP = renderHelp({
	title: 'gship',
	tagline: 'Gateship: a local web runtime for coding agents',
	usage: 'gship [web|run|init] [options]',
	sections: [
		{
			heading: 'Commands',
			entries: [
				{ name: '(default)', description: 'Start the web control surface on 127.0.0.1:7777' },
				{ name: 'web [--port N]', description: 'Start the web control surface on another port' },
				{ name: 'run [--port N]', description: 'Compatibility alias for `gship web`' },
				{ name: 'init', description: 'Check that the signed-in Claude CLI is available' },
				{ name: 'version', description: 'Print the installed Gateship version' },
			],
		},
	],
	footer: 'Task intake, execution, review, recovery, and shipping all live in the web UI.',
});

const WEB_HELP = renderHelp({
	title: 'gship web',
	tagline: 'Start the local Gateship service',
	usage: 'gship web [--port N]',
	sections: [
		{
			heading: 'Options',
			entries: [
				{ name: '--port <N>', description: `TCP port (default: ${DEFAULT_WEB_PORT})` },
			],
		},
	],
});

const INIT_HELP = renderHelp({
	title: 'gship init',
	tagline: 'Check local runtime prerequisites',
	usage: 'gship init',
	sections: [
		{
			heading: 'Checks',
			body: 'Confirms that a compatible, signed-in Claude Code CLI is available on PATH.',
		},
	],
});

export function parseWebArgs(args: string[]): { port: number; help: boolean } | null {
	if (args.includes('--help') || args.includes('-h')) return { port: DEFAULT_WEB_PORT, help: true };
	let port = DEFAULT_WEB_PORT;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		let rawPort: string | undefined;
		if (arg === '--port') {
			rawPort = args[index + 1];
			index += 1;
		} else if (arg.startsWith('--port=')) {
			rawPort = arg.slice('--port='.length);
		} else {
			printError(`unknown web option: ${arg}`);
			return null;
		}
		const parsed = Number(rawPort);
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
			printError(`invalid --port value: ${rawPort ?? ''}`);
			return null;
		}
		port = parsed;
	}
	return { port, help: false };
}

async function launchWeb(args: string[]): Promise<number> {
	const parsed = parseWebArgs(args);
	if (parsed === null) {
		printFatalHint('run `gship web --help` for usage');
		return 1;
	}
	if (parsed.help) {
		process.stdout.write(WEB_HELP);
		return 0;
	}
	return runWeb({ port: parsed.port, cwd: process.cwd() });
}

export async function main(argv: string[]): Promise<number> {
	const command = argv[2];
	if (command === undefined) return launchWeb([]);
	if (command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(HELP);
		return 0;
	}
	if (command === 'version' || command === '--version' || command === '-v') {
		process.stdout.write(`gateship ${GSHIP_VERSION}\n`);
		return 0;
	}
	if (command === 'web' || command === 'run') {
		const tail = argv.slice(3);
		if (tail.includes('--no-attach')) {
			printError('`--no-attach` was retired with the tmux runtime');
			return 1;
		}
		return launchWeb(tail);
	}
	if (command === 'init') {
		const tail = argv.slice(3);
		if (tail.includes('--help') || tail.includes('-h')) {
			process.stdout.write(INIT_HELP);
			return 0;
		}
		if (tail.length > 0) {
			printError(`unknown init option: ${tail[0]}`);
			return 1;
		}
		return runInit();
	}
	printError(`unknown command: ${command}`);
	printFatalHint('run `gship help` to see the available commands');
	return 1;
}

if (import.meta.main) {
	process.exit(await main(process.argv));
}
