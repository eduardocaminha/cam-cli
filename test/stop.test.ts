// test/stop.test.ts
//
// Unit tests for `cam stop`. Coverage:
//   - performStop: removes state file when present, no-op when missing
//   - performStop: kills the project tmux session when alive
//   - performStop: leaves tmux untouched when the project session does not exist
//   - performStop: handles tmux not on PATH (treats as "nothing to clean")
//   - performStop: defensive — only the project session is targeted (the kill
//     argv uses the project session name, not the legacy "cam" name)
//   - End-to-end: after `performStop`, the state file is gone (no stale loop
//     for the next `cam next` call to detect)

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { performStop, runStop, type SpawnSyncFn, type KillFn } from '../src/commands/stop.ts';
import { projectSessionName } from '../src/tmux/session.ts';

// --- Fakes -----------------------------------------------------------------

interface SpawnRecord {
	cmd: string;
	args: string[];
}

interface FakeSpawnHandlers {
	tmuxAvailable?: boolean; // governs `tmux -V` exit code
	sessionAlive?: boolean;  // governs `tmux has-session -t <session>` exit code
	killSucceeds?: boolean;  // governs `tmux kill-session -t <session>` exit code
	respawnPaneSucceeds?: boolean; // governs `tmux respawn-pane -k` exit code
	/** The expected session name to match has-session / kill-session calls. */
	sessionName?: string;
}

function makeFakeSpawn(handlers: FakeSpawnHandlers): SpawnSyncFn & { calls: SpawnRecord[] } {
	const calls: SpawnRecord[] = [];
	const expectedSession = handlers.sessionName ?? '';
	const fn = (cmd: string, args: string[]): SpawnSyncReturns<string> => {
		calls.push({ cmd, args: [...args] });
		const result: SpawnSyncReturns<string> = {
			pid: 1,
			output: ['', '', ''],
			stdout: '',
			stderr: '',
			status: 1,
			signal: null,
		};
		// After tmuxArgs(), argv is ['-L', 'cam', <subcommand>, ...].
		// Route on args[2] (the subcommand) when the -L prefix is present.
		const sub = args[0] === '-L' ? args[2] : args[0];
		const subArg1 = args[0] === '-L' ? args[3] : args[1];
		const subArg2 = args[0] === '-L' ? args[4] : args[2];
		if (cmd === 'tmux') {
			if (sub === '-V') {
				result.status = handlers.tmuxAvailable === false ? 127 : 0;
			} else if (
				sub === 'has-session' &&
				subArg1 === '-t' &&
				(expectedSession === '' || subArg2 === expectedSession)
			) {
				result.status = handlers.sessionAlive === true ? 0 : 1;
			} else if (
				sub === 'kill-session' &&
				subArg1 === '-t' &&
				(expectedSession === '' || subArg2 === expectedSession)
			) {
				result.status = handlers.killSucceeds === false ? 1 : 0;
			} else if (sub === 'respawn-pane') {
				result.status = handlers.respawnPaneSucceeds === false ? 1 : 0;
			}
		}
		return result;
	};
	const decorated = fn as unknown as SpawnSyncFn & { calls: SpawnRecord[] };
	decorated.calls = calls;
	return decorated;
}

// --- performStop -----------------------------------------------------------

describe('performStop — state file', () => {
	test('removes the state file when present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-state-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(statePath, 'old\n');
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.stateFileRemoved).toBe(true);
			expect(existsSync(statePath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('reports stateFileRemoved=false when no state file exists', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-no-state-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.stateFileRemoved).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('continues cleanly even when unlink throws', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-unlink-throws-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({
				cwd: dir,
				existsSyncFn: () => true,
				unlinkSyncFn: () => {
					throw new Error('EACCES');
				},
				spawnSyncFn: spawn,
			});
			// Caller swallows the error; field stays false.
			expect(report.stateFileRemoved).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('performStop — tmux session', () => {
	test('kills the project session when alive', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-tmux-alive-'));
		try {
			const session = projectSessionName(dir);
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: true,
				sessionName: session,
			});
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.tmuxKilled).toBe(true);
			expect(report.tmuxUnavailable).toBe(false);
			expect(report.sessionName).toBe(session);
			// The kill argv must target the project session name, with -L cam prefix.
			const kill = spawn.calls.find(
				(c) => c.cmd === 'tmux' && (c.args[0] === '-L' ? c.args[2] : c.args[0]) === 'kill-session',
			);
			expect(kill).toBeDefined();
			expect(kill?.args).toEqual(['-L', 'cam', 'kill-session', '-t', session]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('skips kill when the project session does not exist', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-tmux-none-'));
		try {
			const session = projectSessionName(dir);
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: false,
				sessionName: session,
			});
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.tmuxKilled).toBe(false);
			expect(report.tmuxUnavailable).toBe(false);
			// We must NOT have called `tmux kill-session` at all.
			const kill = spawn.calls.find(
				(c) => c.cmd === 'tmux' && (c.args[0] === '-L' ? c.args[2] : c.args[0]) === 'kill-session',
			);
			expect(kill).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('reports tmuxUnavailable when `tmux -V` exits non-zero', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-tmux-unavailable-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.tmuxUnavailable).toBe(true);
			expect(report.tmuxKilled).toBe(false);
			// We probed `tmux -L cam -V` once — and stopped there. has-session and
			// kill-session were never attempted.
			expect(spawn.calls.length).toBe(1);
			expect(spawn.calls[0]).toEqual({ cmd: 'tmux', args: ['-L', 'cam', '-V'] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('reports kill failure cleanly (kill-session exits non-zero)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-tmux-kill-fails-'));
		try {
			const session = projectSessionName(dir);
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: false,
				sessionName: session,
			});
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.tmuxKilled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- end-to-end: state file + tmux kill happen together --------------------

describe('performStop — end-to-end', () => {
	test('removes state file AND kills project session when both are present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-e2e-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(statePath, 'old\n');
			const session = projectSessionName(dir);
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: true,
				sessionName: session,
			});
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.stateFileRemoved).toBe(true);
			expect(report.tmuxKilled).toBe(true);
			expect(report.sessionName).toBe(session);
			// Acceptance criterion: after `cam stop`, the next `cam next`
			// must NOT detect a stale loop.
			expect(existsSync(statePath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runStop ---------------------------------------------------------------

describe('runStop', () => {
	test('exits 0 even when there is nothing to clean', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-noop-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			// Capture stdout to keep test output clean.
			const original = process.stdout.write.bind(process.stdout);
			process.stdout.write = (() => true) as typeof process.stdout.write;
			try {
				const code = runStop({ cwd: dir, spawnSyncFn: spawn });
				expect(code).toBe(0);
			} finally {
				process.stdout.write = original;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('exits 0 when both state file and tmux session were cleaned', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-clean-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'old\n');
			const session = projectSessionName(dir);
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: true,
				sessionName: session,
			});
			const original = process.stdout.write.bind(process.stdout);
			process.stdout.write = (() => true) as typeof process.stdout.write;
			try {
				const code = runStop({ cwd: dir, spawnSyncFn: spawn });
				expect(code).toBe(0);
			} finally {
				process.stdout.write = original;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- US-009: supervisor PID kill -------------------------------------------

const STATE_FILE_WITH_PID = (pid: number) =>
	`---\nactive: true\niteration: 3\npid: ${pid}\n---\n\n`;

describe('performStop — supervisor PID kill (US-009)', () => {
	test('sends SIGTERM to the supervisor PID from the state file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-sup-pid-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), STATE_FILE_WITH_PID(12345));
			const killed: number[] = [];
			const fakKill: KillFn = (pid) => {
				killed.push(pid);
			};
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn, killFn: fakKill });
			expect(report.supervisorKilled).toBe(true);
			expect(killed).toEqual([12345]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('supervisorKilled=false when state file has no pid field', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-sup-no-pid-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				'---\nactive: true\niteration: 1\n---\n\n',
			);
			const fakKill: KillFn = () => {
				throw new Error('should not be called');
			};
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn, killFn: fakKill });
			expect(report.supervisorKilled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('supervisorKilled=false when kill throws (PID already dead)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-sup-dead-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), STATE_FILE_WITH_PID(99999));
			const fakKill: KillFn = () => {
				throw new Error('ESRCH');
			};
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn, killFn: fakKill });
			expect(report.supervisorKilled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('supervisorKilled=false when state file is absent', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-sup-no-file-'));
		try {
			const fakKill: KillFn = () => {
				throw new Error('should not be called');
			};
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn, killFn: fakKill });
			expect(report.supervisorKilled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- US-009: worker pane kill -----------------------------------------------

describe('performStop — worker slot pane kill (US-009)', () => {
	test('kills the worker pane when session is alive and pane id is known', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-worker-pane-'));
		try {
			const session = projectSessionName(dir);
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: true,
				respawnPaneSucceeds: true,
				sessionName: session,
			});
			const report = performStop({
				cwd: dir,
				spawnSyncFn: spawn,
				workerPaneReader: () => '%5',
			});
			expect(report.workerPaneKilled).toBe(true);
			// The respawn-pane argv must target the worker pane id.
			// After tmuxArgs(), argv is: ['-L', 'cam', 'respawn-pane', '-k', '-t', paneId, ...]
			const respawn = spawn.calls.find(
				(c) => c.cmd === 'tmux' && (c.args[0] === '-L' ? c.args[2] : c.args[0]) === 'respawn-pane',
			);
			expect(respawn).toBeDefined();
			// paneId is at index 5 when -L cam prefix is present: [-L, cam, respawn-pane, -k, -t, paneId, ...]
			const paneArg = respawn?.args[0] === '-L' ? respawn.args[5] : respawn?.args[3];
			expect(paneArg).toBe('%5');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('workerPaneKilled=false when workerPaneReader returns null', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-worker-pane-null-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionAlive: false });
			const report = performStop({
				cwd: dir,
				spawnSyncFn: spawn,
				workerPaneReader: () => null,
			});
			expect(report.workerPaneKilled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('attempts worker pane kill even when session is not alive (race window)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-worker-pane-no-session-'));
		try {
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: false,
				respawnPaneSucceeds: true,
			});
			// If respawn-pane exits 0, workerPaneKilled should be true even without session.
			const report = performStop({
				cwd: dir,
				spawnSyncFn: spawn,
				workerPaneReader: () => '%3',
			});
			// respawn-pane was attempted (exits 0)
			expect(report.workerPaneKilled).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
