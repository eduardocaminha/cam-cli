// test/attach-hint.test.ts
//
// Unit tests for US-008: post-exec attach hint.
//
// Covers:
//   - emitAttachHint: emits hint when env signals detached (no TMUX or
//     CAM_SESSION mismatch); suppresses hint when inside session.
//   - runPlan: hint emitted when detached; suppressed when inside session.
//   - runNext (tmux-split): hint emitted when detached; suppressed when inside.
//   - runIssue: hint emitted when detached; suppressed when inside session.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { emitAttachHint } from '../src/logging/screen.ts';
import { projectSessionName, type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';
import { runPlan } from '../src/commands/plan.ts';
import { runIssue } from '../src/commands/issue.ts';
import { runNext } from '../src/commands/next.ts';

// --- stdout capture helper --------------------------------------------------

function captureStdout(fn: () => unknown): Promise<string> {
	return new Promise<string>(async (resolve) => {
		const chunks: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			await fn();
		} finally {
			process.stdout.write = orig;
		}
		resolve(chunks.join(''));
	});
}

// --- Fake tmux spawn --------------------------------------------------------

function makeFakeTmuxSpawn(sessionExists = false): TmuxSpawnFn {
	let paneCounter = 0;
	return ((cmd: string, args: string[], opts?: { stdio?: string }) => {
		// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]=subcommand.
		const subcommand = args[0] === '-L' ? args[2] : args[0];
		if (subcommand === 'has-session') {
			return { status: sessionExists ? 0 : 1, stdout: Buffer.from('') } as SpawnSyncReturns<Buffer>;
		}
		// Return a stable pane id for calls that capture it via -P -F #{pane_id}.
		if (
			(subcommand === 'new-session' || subcommand === 'split-window') &&
			opts?.stdio === 'pipe'
		) {
			paneCounter += 1;
			return { status: 0, stdout: Buffer.from(`%${paneCounter}\n`) } as SpawnSyncReturns<Buffer>;
		}
		return { status: 0, stdout: Buffer.from('') } as SpawnSyncReturns<Buffer>;
	}) as TmuxSpawnFn;
}

// --- emitAttachHint unit tests -----------------------------------------------

describe('emitAttachHint', () => {
	const sessionName = 'cam-orch-test-abc123';

	test('emits hint when TMUX is not set (fully detached)', async () => {
		const output = await captureStdout(() => {
			emitAttachHint(sessionName, {});
		});
		expect(output).toContain('cam run');
		expect(output).toContain(sessionName);
	});

	test('emits hint when TMUX is set but CAM_SESSION does not match (different session)', async () => {
		const output = await captureStdout(() => {
			emitAttachHint(sessionName, { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: 'cam-orch-other-999' });
		});
		expect(output).toContain('cam run');
		expect(output).toContain(sessionName);
	});

	test('suppresses hint when CAM_SESSION matches the session name', async () => {
		const output = await captureStdout(() => {
			emitAttachHint(sessionName, { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: sessionName });
		});
		expect(output).toBe('');
	});

	test('emits hint when TMUX is set but CAM_SESSION is absent', async () => {
		const output = await captureStdout(() => {
			emitAttachHint(sessionName, { TMUX: '/tmp/tmux-1/default,1234,0' });
		});
		expect(output).toContain('cam run');
	});
});

// --- runPlan: hint is contextual -------------------------------------------

describe('runPlan attach hint', () => {
	test('emits attach hint when caller is detached (no TMUX)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const output = await captureStdout(() =>
			runPlan({
				cwd: tmpDir,
				permissionMode: 'bypassPermissions',
				tmuxSpawnFn,
				env: {},
			}),
		);

		expect(output).toContain('cam run');
		expect(output).toContain(sessionName);
	});

	test('suppresses attach hint when caller is inside the session', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const output = await captureStdout(() =>
			runPlan({
				cwd: tmpDir,
				permissionMode: 'bypassPermissions',
				tmuxSpawnFn,
				env: { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: sessionName },
			}),
		);

		// cam run hint must not appear
		expect(output).not.toContain('cam run');
	});
});

// --- runIssue: hint is contextual ------------------------------------------

describe('runIssue attach hint', () => {
	test('emits attach hint when caller is detached (no TMUX)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const output = await captureStdout(() =>
			runIssue({
				text: 'Add dark mode',
				cwd: tmpDir,
				permissionMode: 'bypassPermissions',
				tmuxSpawnFn,
				env: {},
			}),
		);

		expect(output).toContain('cam run');
		expect(output).toContain(sessionName);
	});

	test('suppresses attach hint when caller is inside the session', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const output = await captureStdout(() =>
			runIssue({
				text: 'Add dark mode',
				cwd: tmpDir,
				permissionMode: 'bypassPermissions',
				tmuxSpawnFn,
				env: { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: sessionName },
			}),
		);

		expect(output).not.toContain('cam run');
	});
});

// --- runNext (tmux-split): hint is contextual --------------------------------

describe('runNext attach hint (tmux-split path)', () => {
	// Minimal fakes for runNext: suppress state-file and hook I/O.
	const fakeWriter = (_cwd: string, _body: string) => '/fake/.claude/cam-loop.local.md';
	const fakeHookMaterializer = (_cwd: string) => '/fake/.claude/hooks/cam-loop-stop.sh';
	const fakeSettingsWriter = (_cwd: string) => '/fake/.claude/settings.local.json';
	const fakeTmuxProbe = (_cmd: string[]) => ({ exitCode: 0 }); // tmux available

	test('emits attach hint when caller is detached (no TMUX)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-next-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const output = await captureStdout(() =>
			runNext({
				cwd: tmpDir,
				permissionMode: 'bypassPermissions',
				hostMode: 'tmux-split',
				writer: fakeWriter,
				hookMaterializer: fakeHookMaterializer,
				settingsWriter: fakeSettingsWriter,
				tmuxProbe: fakeTmuxProbe,
				tmuxSpawnFn,
				env: {},
			}),
		);

		expect(output).toContain('cam run');
		expect(output).toContain(sessionName);
	});

	test('suppresses attach hint when caller is inside the session', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-next-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const output = await captureStdout(() =>
			runNext({
				cwd: tmpDir,
				permissionMode: 'bypassPermissions',
				hostMode: 'tmux-split',
				writer: fakeWriter,
				hookMaterializer: fakeHookMaterializer,
				settingsWriter: fakeSettingsWriter,
				tmuxProbe: fakeTmuxProbe,
				tmuxSpawnFn,
				env: { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: sessionName },
			}),
		);

		expect(output).not.toContain('cam run');
	});
});
