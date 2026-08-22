#!/usr/bin/env bun

import process from 'node:process';
import { readFileSync, rmSync } from 'node:fs';

import { DEFAULT_WEB_PORT, runWeb } from './src/commands/web.ts';
import { runAgent } from './src/commands/agent.ts';
import { printError, printFatalHint } from './src/logging/color.ts';
import { renderHelp } from './src/logging/help.ts';
import { GSHIP_VERSION } from './src/version.ts';
import { captureBootClaudeToken } from './src/runtime/claude-credential.ts';
import { executeSelfUpdateHandoff, type HandoffPlan } from './src/runtime/self-update.ts';

const HELP = renderHelp({
	title: 'gship',
	tagline: 'Gateship: a local web runtime for coding agents',
	usage: 'gship [--port N]\n    gship agent <guide|operations|call>',
	sections: [
		{
			heading: 'Commands',
			entries: [
				{ name: 'agent', description: 'Machine-readable interface for shell-capable agents' },
			],
		},
		{
			heading: 'Options',
			entries: [
				{ name: '--port <N>', description: `TCP port (default: ${DEFAULT_WEB_PORT})` },
				{ name: '--help', description: 'Show this help' },
				{ name: '--version', description: 'Print the installed Gateship version' },
			],
		},
	],
	footer: 'Task intake, execution, review, recovery, and shipping all live in the web UI.',
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

export type WebInvocation =
	| { kind: 'web'; stateDir?: string; serverArgs: string[] }
	| { kind: 'invalid-self-update-serve' }
	| { kind: 'other' };

export function resolveWebInvocation(argv: string[]): WebInvocation {
	const command = argv[2];
	if (command === '__self-update-serve') {
		const stateDir = argv[3];
		return stateDir === undefined
			? { kind: 'invalid-self-update-serve' }
			: { kind: 'web', stateDir, serverArgs: argv.slice(4) };
	}
	return command === undefined || command.startsWith('--port')
		? { kind: 'web', serverArgs: argv.slice(2) }
		: { kind: 'other' };
}

async function launchWeb(args: string[], stateDir?: string): Promise<number> {
	const parsed = parseWebArgs(args);
	if (parsed === null) {
		printFatalHint('run `gship --help` for usage');
		return 1;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	return runWeb({ port: parsed.port, cwd: process.cwd(), stateDir, serverArgs: args });
}

export async function main(argv: string[]): Promise<number> {
	const command = argv[2];
	if (command === '__self-update-handoff') {
		const planPath = argv[3];
		if (planPath === undefined) return 1;
		// GSHIP-704: the old server process, if a dedicated Claude credential
		// was ever provisioned at boot, spawned this helper with the token set
		// explicitly in its own environment -- never in the handoff plan file.
		// Captured and removed from this process's own `process.env` the same
		// way the normal server boot already does, so the helper (which never
		// runs a project command) does not keep carrying it either; the
		// snapshot alone is what reaches the successor server this starts.
		const handoffEnv = captureBootClaudeToken();
		try {
			const plan = JSON.parse(readFileSync(planPath, 'utf8')) as HandoffPlan;
			const result = await executeSelfUpdateHandoff(plan, undefined, handoffEnv);
			return result.status === 'success' || result.status === 'rollback' ? 0 : 1;
		} finally {
			rmSync(planPath, { force: true });
		}
	}
	const web = resolveWebInvocation(argv);
	if (web.kind === 'invalid-self-update-serve') return 1;
	if (web.kind === 'web') return launchWeb(web.serverArgs, web.stateDir);
	if (command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(HELP);
		return 0;
	}
	if (command === 'version' || command === '--version' || command === '-v') {
		process.stdout.write(`gateship ${GSHIP_VERSION}\n`);
		return 0;
	}
	if (command === 'agent') return runAgent(argv.slice(3));
	printError(`unknown command: ${command}`);
	printFatalHint('run `gship --help` for usage');
	return 1;
}

if (import.meta.main) {
	process.exit(await main(process.argv));
}
