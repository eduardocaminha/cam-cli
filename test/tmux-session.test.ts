// test/tmux-session.test.ts
//
// Unit tests for src/tmux/session.ts.
//
// Strategy: inject a fake spawn function that records every call and returns
// configurable exit codes. We assert the exact tmux argv for:
//   - has-session
//   - new-session
//   - split-window (both ensureProjectSession and openPaneInSession)
// We do NOT spin a real tmux server.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	projectSessionName,
	ensureProjectSession,
	openPaneInSession,
	isInsideProjectSession,
	type SpawnFn,
	type Env,
} from '../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fake spawn helpers
// ---------------------------------------------------------------------------

interface SpawnRecord {
	cmd: string;
	args: string[];
}

interface FakeSpawnHandlers {
	/** Whether `tmux has-session` exits 0 (session exists). Default: false. */
	sessionExists?: boolean;
}

function makeFakeSpawn(
	handlers: FakeSpawnHandlers = {},
): SpawnFn & { calls: SpawnRecord[] } {
	const calls: SpawnRecord[] = [];

	const fn: SpawnFn = (cmd, args, _opts?) => {
		calls.push({ cmd, args: [...args] });

		const result: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};

		if (cmd === 'tmux' && args[0] === 'has-session') {
			result.status = handlers.sessionExists ? 0 : 1;
		}

		return result;
	};

	const decorated = fn as SpawnFn & { calls: SpawnRecord[] };
	decorated.calls = calls;
	return decorated;
}

// ---------------------------------------------------------------------------
// projectSessionName
// ---------------------------------------------------------------------------

describe('projectSessionName', () => {
	test('produces a tmux-safe name with basename and 6-char hash', () => {
		const name = projectSessionName('/Users/eduardo/Documents/Projects/cam-cli');
		expect(name).toMatch(/^cam-orch-cam-cli-[0-9a-f]{6}$/);
	});

	test('is deterministic for the same path', () => {
		expect(projectSessionName('/some/path')).toBe(projectSessionName('/some/path'));
	});

	test('differs for paths with the same basename in different parents', () => {
		const a = projectSessionName('/work/proj');
		const b = projectSessionName('/home/proj');
		expect(a).not.toBe(b);
	});

	test('replaces unsafe characters in basename with dashes', () => {
		const name = projectSessionName('/tmp/has spaces & symbols');
		expect(name).toMatch(/^cam-orch-has-spaces---symbols-[0-9a-f]{6}$/);
	});

	test('falls back to "project" for root directory', () => {
		const name = projectSessionName('/');
		expect(name).toMatch(/^cam-orch-project-[0-9a-f]{6}$/);
	});
});

// ---------------------------------------------------------------------------
// ensureProjectSession — new-session argv
// ---------------------------------------------------------------------------

describe('ensureProjectSession — new session', () => {
	test('calls has-session first, then new-session and split-window when session absent', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		const created = ensureProjectSession('cam-orch-myproj-abc123', spawn);

		expect(created).toBe(true);

		// First call must be has-session.
		const first = spawn.calls[0];
		expect(first).toBeDefined();
		expect(first?.cmd).toBe('tmux');
		expect(first?.args[0]).toBe('has-session');
		expect(first?.args).toContain('cam-orch-myproj-abc123');

		// Second call must be new-session (detached).
		const newSess = spawn.calls[1];
		expect(newSess).toBeDefined();
		expect(newSess?.cmd).toBe('tmux');
		expect(newSess?.args[0]).toBe('new-session');
		expect(newSess?.args).toContain('-d');
		expect(newSess?.args).toContain('-s');
		expect(newSess?.args).toContain('cam-orch-myproj-abc123');

		// Third call must be split-window for the dashboard pane.
		const split = spawn.calls[2];
		expect(split).toBeDefined();
		expect(split?.cmd).toBe('tmux');
		expect(split?.args[0]).toBe('split-window');
		expect(split?.args).toContain('-t');
		expect(split?.args).toContain('cam-orch-myproj-abc123:0');
		expect(split?.args).toContain('-h');
		expect(split?.args).toContain('-d');
	});

	test('new-session argv includes -x 220 and -y 50', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		ensureProjectSession('cam-orch-test-000000', spawn);

		const newSess = spawn.calls[1];
		expect(newSess?.args).toContain('-x');
		expect(newSess?.args).toContain('220');
		expect(newSess?.args).toContain('-y');
		expect(newSess?.args).toContain('50');
	});

	test('split-window for dashboard uses -l 36 right pane', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		ensureProjectSession('cam-orch-test-000000', spawn);

		const split = spawn.calls[2];
		expect(split?.args).toContain('-l');
		expect(split?.args).toContain('36');
	});

	test('returns false and calls only has-session when session already exists', () => {
		const spawn = makeFakeSpawn({ sessionExists: true });
		const created = ensureProjectSession('cam-orch-existing-abc123', spawn);

		expect(created).toBe(false);
		// Only has-session was called.
		expect(spawn.calls).toHaveLength(1);
		expect(spawn.calls[0]?.args[0]).toBe('has-session');
	});
});

// ---------------------------------------------------------------------------
// openPaneInSession — split-window argv
// ---------------------------------------------------------------------------

describe('openPaneInSession', () => {
	test('calls split-window -t <session>:0 -v -d with the command', () => {
		const spawn = makeFakeSpawn();
		openPaneInSession('cam-orch-myproj-abc123', 'claude --permission-mode bypassPermissions', spawn);

		expect(spawn.calls).toHaveLength(1);
		const call = spawn.calls[0];
		expect(call?.cmd).toBe('tmux');
		expect(call?.args[0]).toBe('split-window');
		expect(call?.args).toContain('-t');
		expect(call?.args).toContain('cam-orch-myproj-abc123:0');
		expect(call?.args).toContain('-v');
		expect(call?.args).toContain('-d');
		expect(call?.args).toContain('claude --permission-mode bypassPermissions');
	});

	test('passes the exact command string as the last argument', () => {
		const spawn = makeFakeSpawn();
		const cmd = 'bash -c "echo hello"';
		openPaneInSession('cam-orch-test-000000', cmd, spawn);

		const call = spawn.calls[0];
		const lastArg = call?.args[call.args.length - 1];
		expect(lastArg).toBe(cmd);
	});
});

// ---------------------------------------------------------------------------
// isInsideProjectSession
// ---------------------------------------------------------------------------

describe('isInsideProjectSession', () => {
	test('returns false when TMUX env var is absent', () => {
		const env: Env = {};
		expect(isInsideProjectSession('cam-orch-myproj-abc123', env)).toBe(false);
	});

	test('returns false when TMUX is set but CAM_SESSION does not match', () => {
		const env: Env = { TMUX: '/tmp/tmux-1000/default,12345,0', CAM_SESSION: 'cam-orch-other-000000' };
		expect(isInsideProjectSession('cam-orch-myproj-abc123', env)).toBe(false);
	});

	test('returns true when TMUX is set and CAM_SESSION matches', () => {
		const sessionName = 'cam-orch-myproj-abc123';
		const env: Env = { TMUX: '/tmp/tmux-1000/default,12345,0', CAM_SESSION: sessionName };
		expect(isInsideProjectSession(sessionName, env)).toBe(true);
	});

	test('returns false when inside tmux but CAM_SESSION is absent', () => {
		const env: Env = { TMUX: '/tmp/tmux-1000/default,12345,0' };
		expect(isInsideProjectSession('cam-orch-myproj-abc123', env)).toBe(false);
	});
});
