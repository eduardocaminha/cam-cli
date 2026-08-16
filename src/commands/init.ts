import { spawnSync } from 'node:child_process';

import { printError, printHint, printSuccess } from '../logging/color.ts';

const CLAUDE_VERSION_FLOOR = '2.0.0';

export type SpawnFn = (
	cmd: string,
	args: string[],
) => { status: number | null; stdout: string; stderr: string };

function defaultSpawnFn(cmd: string, args: string[]): ReturnType<SpawnFn> {
	const result = spawnSync(cmd, args, { encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function compareVersions(leftValue: string, rightValue: string): number {
	const parts = (value: string): number[] => value
		.replace(/^v/, '')
		.split(/[-+]/, 1)[0]!
		.split('.')
		.map((part) => Number.parseInt(part, 10) || 0);
	const left = parts(leftValue);
	const right = parts(rightValue);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export interface InitOptions {
	spawnFn?: SpawnFn;
}

/** A small prerequisite check; project configuration belongs to the web runtime. */
export async function runInit(options: InitOptions = {}): Promise<number> {
	const spawn = options.spawnFn ?? defaultSpawnFn;
	const lookup = spawn('/bin/sh', ['-c', 'command -v claude']);
	const claudePath = lookup.status === 0 ? lookup.stdout.trim() : '';
	if (claudePath.length === 0) {
		printError(
			'Claude Code is not on PATH',
			'Install it from https://claude.com/claude-code and sign in before starting Gateship',
		);
		return 1;
	}

	const versionResult = spawn('claude', ['--version']);
	const rawVersion = versionResult.stdout.trim();
	const detected = rawVersion.match(/(\d+\.\d+\.\d+)/)?.[1];
	if (versionResult.status !== 0 || detected === undefined) {
		printSuccess(`Claude Code found at ${claudePath}`);
		printHint('Could not parse `claude --version`; Gateship will verify the real invocation when a run starts');
		return 0;
	}

	printSuccess(`Claude Code ${detected} found at ${claudePath}`);
	if (compareVersions(detected, CLAUDE_VERSION_FLOOR) < 0) {
		printHint(`Version ${detected} is older than the tested floor ${CLAUDE_VERSION_FLOOR}; consider \`claude update\``);
	}
	return 0;
}
