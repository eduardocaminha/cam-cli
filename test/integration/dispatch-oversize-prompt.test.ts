// Real-tmux regression for CAM-433. A private socket is mandatory: this file
// never touches the live `cam` socket.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';

import {
	DISPATCH_FAILED_FILENAME,
	readDispatchFailedMarker,
	writeDispatchFailedMarker,
} from '../../src/supervisor/dispatch-failed-marker.ts';
import { makeFileEventLogger } from '../../src/supervisor/events.ts';
import type { SpawnFn } from '../../src/supervisor/loop.ts';
import {
	taskPromptFileArgument,
	writeTaskPromptFile,
} from '../../src/supervisor/task-prompt-file.ts';
import { runVerifiedDispatch } from '../../src/supervisor/verified-dispatch.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';
import { tmuxAvailable } from '../helpers/test-deps.ts';

const TEST_SOCKET = `cam-it-oversize-${process.pid}`;
const SESSION = 'oversize-dispatch';
const cleanupDirs: string[] = [];

function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCKET, ...args], { stdio: 'pipe' });
}

function swapSocketSpawn(
	transform?: (args: string[]) => string[],
): SpawnFn {
	return (cmd, args) => {
		const swapped = [...args];
		const socketIndex = swapped.indexOf('-L');
		if (socketIndex !== -1 && swapped[socketIndex + 1] === 'cam') {
			swapped[socketIndex + 1] = TEST_SOCKET;
		}
		const finalArgs = transform?.(swapped) ?? swapped;
		const result = spawnSync(cmd, finalArgs, { stdio: 'pipe' });
		return {
			stdout: result.stdout?.toString() ?? '',
			stderr: result.stderr?.toString() ?? '',
			exitCode: result.status,
		};
	};
}

function quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function paneId(): string {
	return tmuxRaw(['display-message', '-p', '-t', SESSION, '#{pane_id}'])
		.stdout.toString()
		.trim();
}

function panePid(target: string): string {
	return tmuxRaw(['display-message', '-p', '-t', target, '#{pane_pid}'])
		.stdout.toString()
		.trim();
}

function makeClaudeDir(prefix: string): string {
	const root = createTestTmpdir(prefix);
	cleanupDirs.push(root);
	return join(root, '.claude');
}

beforeEach(async () => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '100', '-y', '20', 'cat']);
	await waitForCondition(() => tmuxRaw(['has-session', '-t', SESSION]).status === 0);
});

afterEach(() => {
	if (tmuxAvailable) tmuxRaw(['kill-server']);
	for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
	cleanupDirs.length = 0;
});

test.skipIf(!tmuxAvailable)(
	'oversize runtime prompt is delivered out-of-band and the real pane process identity changes',
	async () => {
		const claudeDir = makeClaudeDir('cam-oversize-prompt-');
		const authoredPrompt = `${'runtime-oversize-prompt-'.repeat(1_600)}\n`;
		const prompt = authoredPrompt.slice(0, -1);
		const promptBytes = Buffer.byteLength(prompt, 'utf8');

		// The size and final-newline contract live inside the test. No shell
		// numeric comparison or committed fixture can make this assertion pass.
		expect(promptBytes).toBeGreaterThanOrEqual(32_768);
		expect(authoredPrompt.endsWith('\n')).toBe(true);
		expect(prompt.endsWith('\n')).toBe(false);

		const promptPath = writeTaskPromptFile(claudeDir, 'oversize-runtime', prompt);
		expect(Buffer.byteLength(readFileSync(promptPath))).toBe(promptBytes);

		const receivedPath = join(claudeDir, 'received-prompt.txt');
		const outLogPath = join(claudeDir, 'oversize-pane.log');
		const target = paneId();
		const preDispatchPid = panePid(target);
		const eventsPath = join(claudeDir, 'events.jsonl');
		const notifications: string[] = [];
		const dispatchCmd =
			`sh -c 'printf %s "$1" > "$2"; exec cat' sh ` +
			`${taskPromptFileArgument(promptPath)} ${quote(receivedPath)}`;

		const result = runVerifiedDispatch({
			spawnFn: swapSocketSpawn(),
			phase: 'planner',
			paneId: target,
			uuid: 'oversize-runtime',
			dispatchCmd,
			pipeCommand: `cat >> ${quote(outLogPath)}`,
			logEvent: makeFileEventLogger(eventsPath),
			writeDispatchFailedMarkerFn: (marker) =>
				writeDispatchFailedMarker(join(claudeDir, DISPATCH_FAILED_FILENAME), marker),
			notifyFn: (message) => notifications.push(message),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(`unexpected dispatch failure: ${result.marker.reason}`);
		await waitForCondition(() => existsSync(receivedPath));
		const postDispatchPid = panePid(target);
		expect(result.beforePanePid).toBe(preDispatchPid);
		expect(result.afterPanePid).not.toBe(preDispatchPid);
		expect(postDispatchPid).toBe(result.afterPanePid);
		expect(readFileSync(receivedPath).equals(Buffer.from(prompt))).toBe(true);
		expect(Buffer.byteLength(readFileSync(receivedPath))).toBe(promptBytes);
		expect(notifications).toEqual([]);
	},
);

test.skipIf(!tmuxAvailable)(
	'a real invalid tmux dispatch is never silent: events.jsonl and durable marker both record it',
	() => {
		const claudeDir = makeClaudeDir('cam-oversize-failure-');
		const eventsPath = join(claudeDir, 'events.jsonl');
		const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
		const notifications: string[] = [];
		const target = paneId();
		const invalidRespawnSpawn = swapSocketSpawn((args) => {
			if (args[2] !== 'respawn-pane') return args;
			return [args[0]!, args[1]!, 'cam-invalid-dispatch-command'];
		});

		const result = runVerifiedDispatch({
			spawnFn: invalidRespawnSpawn,
			phase: 'auditor',
			paneId: target,
			uuid: 'forced-failure',
			dispatchCmd: 'cat',
			pipeCommand: `cat >> ${quote(join(claudeDir, 'never-piped.log'))}`,
			logEvent: makeFileEventLogger(eventsPath),
			writeDispatchFailedMarkerFn: (marker) =>
				writeDispatchFailedMarker(markerPath, marker),
			notifyFn: (message) => notifications.push(message),
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('invalid tmux command unexpectedly dispatched');
		expect(result.marker.reason).toBe('respawn-pane-exited');
		expect(result.marker.exitCode).not.toBe(0);
		expect(existsSync(eventsPath)).toBe(true);
		const events = readFileSync(eventsPath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { kind?: string; detail?: { reason?: string } });
		expect(
			events.some(
				(event) =>
					event.kind === 'dispatch-failed' &&
					event.detail?.reason === 'respawn-pane-exited',
			),
		).toBe(true);
		expect(readDispatchFailedMarker(markerPath)?.reason).toBe('respawn-pane-exited');
		expect(notifications.some((message) => message.includes('dispatch failed'))).toBe(true);
	},
);
