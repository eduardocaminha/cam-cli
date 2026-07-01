// test/attach-hint.test.ts
//
// Unit tests for US-008: post-exec attach hint.
//
// Covers:
//   - emitAttachHint: emits hint when env signals detached (no TMUX or
//     CAM_SESSION mismatch); suppresses hint when inside session.
//   - runPlan: hint emitted when detached; suppressed when inside session.
//   - runNext: hint emitted when detached; suppressed when inside session.
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

// --- Fake tmux spawn for thin-proxy commands --------------------------------
//
// The thin-proxy commands (runPlan, runNext, runIssue) call orchestratorAlive
// and getOrchPaneId. This fake simulates a live orchestrator so the hit path
// fires and attach-hint is emitted.

function makeFakeTmuxSpawn(orchAlive = true): TmuxSpawnFn {
	return ((cmd: string, args: string[]) => {
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'has-session') return base; // session exists

		if (subcommand === 'list-panes') {
			const fIdx = args.indexOf('-F');
			const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
			if (fmt === '#{@cam_label}') {
				// orchestratorAlive keys on @cam_label (claude runs under a bash
				// respawn-wrapper, so pane_current_command is never claude).
				return {
					...base,
					stdout: Buffer.from(orchAlive ? 'orchestrator\ndashboard\n' : 'dashboard\n'),
				};
			}
			if (fmt === '#{pane_index};#{pane_id}') {
				return { ...base, stdout: Buffer.from('0;%0\n') };
			}
			if (fmt === '#{pane_id}') {
				// For paneCountMutex: return 2 pane IDs (available).
				return { ...base, stdout: Buffer.from('%0\n%1\n') };
			}
			return { ...base, stdout: Buffer.from('') };
		}

		if (subcommand === 'capture-pane') {
			// Return idle pane content so the idle-check (US-008) passes immediately.
			return { ...base, stdout: Buffer.from('> ') };
		}

		return base;
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

		// Inject a plannable issue so runPlan reaches emitAttachHint.
		// Without this, readBacklogFromMain hits git in a tmpdir (returns [])
		// and runPlan exits with error before the hint is emitted.
		const readBacklogFn = () => [
			{ id: 'CAM-1', title: 'Test', stage: 'specified' as const, status: 'open' as const, blockedBy: [], createdAt: '2026-01-01T00:00:00Z' },
		];
		const writeFn = () => '';

		const output = await captureStdout(() =>
			runPlan({
				cwd: tmpDir,
				tmuxSpawnFn,
				env: {},
				readBacklogFn,
				writeFn,
			}),
		);

		expect(output).toContain('cam run');
		expect(output).toContain(sessionName);
	});

	test('suppresses attach hint when caller is inside the session', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const readBacklogFn = () => [
			{ id: 'CAM-1', title: 'Test', stage: 'specified' as const, status: 'open' as const, blockedBy: [], createdAt: '2026-01-01T00:00:00Z' },
		];
		const writeFn = () => '';

		const output = await captureStdout(() =>
			runPlan({
				cwd: tmpDir,
				tmuxSpawnFn,
				env: { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: sessionName },
				readBacklogFn,
				writeFn,
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
				tmuxSpawnFn,
				env: { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: sessionName },
			}),
		);

		expect(output).not.toContain('cam run');
	});
});

// --- runNext: hint is contextual --------------------------------

describe('runNext attach hint', () => {
	test('emits attach hint when caller is detached (no TMUX)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-next-hint-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true);
		const sessionName = projectSessionName(tmpDir);

		const output = await captureStdout(() =>
			runNext({
				cwd: tmpDir,
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
				tmuxSpawnFn,
				env: { TMUX: '/tmp/tmux-1/default,1234,0', CAM_SESSION: sessionName },
			}),
		);

		expect(output).not.toContain('cam run');
	});
});
