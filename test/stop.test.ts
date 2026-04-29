// test/stop.test.ts
//
// Unit tests for `ralph stop`. Coverage:
//   - performStop: removes state file when present, no-op when missing
//   - performStop: kills tmux session "ralph" when alive
//   - performStop: leaves tmux untouched when no `ralph` session
//   - performStop: handles tmux not on PATH (treats as "nothing to clean")
//   - performStop: defensive — only `ralph` is targeted (the kill argv is
//     fixed; we assert the literal `kill-session -t ralph` form)
//   - End-to-end: after `performStop`, the state file is gone (no stale loop
//     for the next `ralph next` call to detect)

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { performStop, runStop, type SpawnSyncFn } from '../src/commands/stop.ts';

// --- Fakes -----------------------------------------------------------------

interface SpawnRecord {
	cmd: string;
	args: string[];
}

interface FakeSpawnHandlers {
	tmuxAvailable?: boolean; // governs `tmux -V` exit code
	sessionAlive?: boolean; // governs `tmux has-session -t ralph` exit code
	killSucceeds?: boolean; // governs `tmux kill-session -t ralph` exit code
}

function makeFakeSpawn(handlers: FakeSpawnHandlers): SpawnSyncFn & { calls: SpawnRecord[] } {
	const calls: SpawnRecord[] = [];
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
		if (cmd === 'tmux') {
			if (args[0] === '-V') {
				result.status = handlers.tmuxAvailable === false ? 127 : 0;
			} else if (args[0] === 'has-session' && args[1] === '-t' && args[2] === 'ralph') {
				result.status = handlers.sessionAlive === true ? 0 : 1;
			} else if (args[0] === 'kill-session' && args[1] === '-t' && args[2] === 'ralph') {
				result.status = handlers.killSucceeds === false ? 1 : 0;
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
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-state-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'ralph-loop.local.md');
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
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-no-state-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.stateFileRemoved).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('continues cleanly even when unlink throws', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-unlink-throws-'));
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
	test('kills the `ralph` session when alive', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-tmux-alive-'));
		try {
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: true,
			});
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.tmuxKilled).toBe(true);
			expect(report.tmuxUnavailable).toBe(false);
			// The kill argv must be exactly `tmux kill-session -t ralph` —
			// nothing else, ever. This is the defensive contract.
			const kill = spawn.calls.find(
				(c) => c.cmd === 'tmux' && c.args[0] === 'kill-session',
			);
			expect(kill).toBeDefined();
			expect(kill?.args).toEqual(['kill-session', '-t', 'ralph']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('skips kill when no `ralph` session is alive', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-tmux-none-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionAlive: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.tmuxKilled).toBe(false);
			expect(report.tmuxUnavailable).toBe(false);
			// We must NOT have called `tmux kill-session` at all.
			const kill = spawn.calls.find(
				(c) => c.cmd === 'tmux' && c.args[0] === 'kill-session',
			);
			expect(kill).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('reports tmuxUnavailable when `tmux -V` exits non-zero', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-tmux-unavailable-'));
		try {
			const spawn = makeFakeSpawn({ tmuxAvailable: false });
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.tmuxUnavailable).toBe(true);
			expect(report.tmuxKilled).toBe(false);
			// We probed `tmux -V` once — and stopped there. has-session and
			// kill-session were never attempted.
			expect(spawn.calls.length).toBe(1);
			expect(spawn.calls[0]).toEqual({ cmd: 'tmux', args: ['-V'] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('reports kill failure cleanly (kill-session exits non-zero)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-tmux-kill-fails-'));
		try {
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: false,
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
	test('removes state file AND kills tmux when both are present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-e2e-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'ralph-loop.local.md');
			writeFileSync(statePath, 'old\n');
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: true,
			});
			const report = performStop({ cwd: dir, spawnSyncFn: spawn });
			expect(report.stateFileRemoved).toBe(true);
			expect(report.tmuxKilled).toBe(true);
			// Acceptance criterion: after `ralph stop`, the next `ralph next`
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
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-noop-'));
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
		const dir = mkdtempSync(join(tmpdir(), 'ralph-stop-clean-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'ralph-loop.local.md'), 'old\n');
			const spawn = makeFakeSpawn({
				tmuxAvailable: true,
				sessionAlive: true,
				killSucceeds: true,
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
