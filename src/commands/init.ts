// Optional machine-readiness check used before the project metadata wizard.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { Box, render } from 'ink';
import { createElement } from 'react';

import { printError, printHint, printSuccess } from '../logging/color.ts';
import { type CheckDef, type CheckOutcome, InitScreen } from '../ui/InitScreen.tsx';
import { Splash } from '../ui/Splash.tsx';
import { CAM_VERSION } from '../version.ts';

const CLAUDE_VERSION_FLOOR = '2.0.0';

interface ValidationResult {
	ok: boolean;
	message: string;
	hint?: string;
}

export type SpawnFn = (
	cmd: string,
	args: string[],
) => { status: number | null; stdout: string; stderr: string };

function defaultSpawnFn(cmd: string, args: string[]): ReturnType<SpawnFn> {
	const result = spawnSync(cmd, args, { encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function lookupOnPath(name: string, spawnFn: SpawnFn): string | null {
	const result = spawnFn('/bin/sh', ['-c', `command -v ${name}`]);
	if (result.status !== 0) return null;
	return result.stdout.trim() || null;
}

function compareVersions(a: string, b: string): number {
	const normalize = (value: string): number[] =>
		value
			.replace(/^v/, '')
			.split(/[-+]/, 1)[0]!
			.split('.')
			.map((part) => Number.parseInt(part, 10) || 0);
	const left = normalize(a);
	const right = normalize(b);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function validateClaude(spawnFn: SpawnFn = defaultSpawnFn): ValidationResult {
	const path = lookupOnPath('claude', spawnFn);
	if (!path) {
		return {
			ok: false,
			message: 'Claude is not on PATH',
			hint: 'Install Claude Code from https://claude.com/claude-code and ensure it is on PATH',
		};
	}
	const version = spawnFn('claude', ['--version']);
	if (version.status !== 0) {
		return {
			ok: true,
			message: `Claude found at ${path} (version unparseable)`,
			hint: '`claude --version` exited non-zero; continuing anyway',
		};
	}
	const rawVersion = version.stdout.trim();
	const detected = rawVersion.match(/(\d+\.\d+\.\d+)/)?.[1];
	if (!detected) {
		return {
			ok: true,
			message: `Claude found at ${path} (version unparseable)`,
			hint: `\`claude --version\` returned: ${rawVersion}`,
		};
	}
	if (compareVersions(detected, CLAUDE_VERSION_FLOOR) < 0) {
		return {
			ok: true,
			message: `Claude found at ${path} (version ${detected}, < floor ${CLAUDE_VERSION_FLOOR})`,
			hint: 'Older Claude Code may not support the runtime flags Gateship uses; consider `claude update`',
		};
	}
	return { ok: true, message: `Claude found at ${path} (version ${detected})` };
}

export interface InitOptions {
	spawnFn?: SpawnFn;
}

export function isInitInteractiveGate(
	stdoutIsTTY: boolean,
	stdinIsTTY: boolean,
	ci: string | undefined,
): boolean {
	return stdoutIsTTY && stdinIsTTY && !ci;
}

export async function runInit(options: InitOptions = {}): Promise<number> {
	const interactive = isInitInteractiveGate(
		Boolean(process.stdout.isTTY),
		Boolean(process.stdin.isTTY),
		process.env.CI,
	);
	return interactive ? runInitInteractive() : runInitLinear(options.spawnFn);
}

function runInitLinear(spawnFn: SpawnFn = defaultSpawnFn): number {
	const result = validateClaude(spawnFn);
	if (!result.ok) {
		printError(result.message, result.hint);
		return 1;
	}
	printSuccess(result.message);
	if (result.hint) printHint(result.hint);
	printSuccess('Machine ready');
	return 0;
}

async function runInitInteractive(): Promise<number> {
	let failedIds: string[] = [];
	const view = createElement(
		Box,
		{ flexDirection: 'column' },
		createElement(Splash, { version: CAM_VERSION }),
		createElement(InitScreen, {
			checks: buildInteractiveChecks(),
			onDone: (ids: string[]) => {
				failedIds = ids;
				unmount();
			},
		}),
	);
	const { unmount, waitUntilExit } = render(view);
	await waitUntilExit();
	return failedIds.length === 0 ? 0 : 1;
}

function buildInteractiveChecks(): CheckDef[] {
	return [
		{
			id: 'claude',
			label: 'claude',
			description: 'Required by the web execution runtime',
			run: () => toOutcome(validateClaude()),
		},
	];
}

function toOutcome(result: ValidationResult): CheckOutcome {
	if (!result.ok) {
		return { status: 'fail', detail: result.message, ...(result.hint ? { hint: result.hint } : {}) };
	}
	const detected = result.message.match(/version (\d+\.\d+\.\d+)/)?.[1];
	if (result.hint) return { status: 'warn', detail: detected ? `v${detected}` : 'ready', hint: result.hint };
	return { status: 'ok', detail: detected ? `v${detected}` : 'ready' };
}
