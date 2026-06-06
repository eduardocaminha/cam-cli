// test/tmux-session.test.ts
//
// Unit tests for src/tmux/session.ts.
//
// Strategy: inject a fake spawn function that records every call and returns
// configurable exit codes. We assert the exact tmux argv for:
//   - has-session
//   - new-session  (must include -P -F #{pane_id} and -e CAM_SESSION=)
//   - split-window (must include -P -F #{pane_id}; target uses captured %id)
//   - split-window for openPaneInSession
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

/**
 * Fake spawn that returns sequential pane IDs (%1, %2, %3) for each
 * new-session / split-window call that requests -P -F #{pane_id} (pipe stdio).
 * This mirrors the real tmux behaviour ensureProjectSession relies on.
 */
function makeFakeSpawn(
	handlers: FakeSpawnHandlers = {},
): SpawnFn & { calls: SpawnRecord[] } {
	const calls: SpawnRecord[] = [];
	let paneCounter = 0;

	const fn: SpawnFn = (cmd, args, opts?) => {
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

		// Return a stable pane id for calls that capture it via -P -F #{pane_id}.
		if (
			cmd === 'tmux' &&
			(args[0] === 'new-session' || args[0] === 'split-window') &&
			opts?.stdio === 'pipe'
		) {
			paneCounter += 1;
			result.stdout = Buffer.from(`%${paneCounter}\n`);
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
	test('calls has-session first, then new-session and two split-window calls when session absent', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		const result = ensureProjectSession('cam-orch-myproj-abc123', spawn);

		expect(result).not.toBe(false);

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

		// Third call: first split-window creates dashboard pane (horizontal split).
		// Target must be the captured orchPaneId (%1), NOT a positional index.
		const firstSplit = spawn.calls[2];
		expect(firstSplit).toBeDefined();
		expect(firstSplit?.cmd).toBe('tmux');
		expect(firstSplit?.args[0]).toBe('split-window');
		expect(firstSplit?.args).toContain('-t');
		expect(firstSplit?.args).toContain('%1');
		expect(firstSplit?.args).not.toContain('cam-orch-myproj-abc123:0.0');
		expect(firstSplit?.args).toContain('-h');
		expect(firstSplit?.args).toContain('-d');

		// Fourth call: second split-window creates menu pane (vertical split of pane 1).
		// Target must be the captured dashboardPaneId (%2), NOT a positional index.
		const secondSplit = spawn.calls[3];
		expect(secondSplit).toBeDefined();
		expect(secondSplit?.cmd).toBe('tmux');
		expect(secondSplit?.args[0]).toBe('split-window');
		expect(secondSplit?.args).toContain('-t');
		expect(secondSplit?.args).toContain('%2');
		expect(secondSplit?.args).not.toContain('cam-orch-myproj-abc123:0.1');
		expect(secondSplit?.args).toContain('-v');
		expect(secondSplit?.args).toContain('-d');
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

	test('new-session argv includes -P -F #{pane_id} for stable pane capture', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		ensureProjectSession('cam-orch-test-000000', spawn);

		const newSess = spawn.calls[1];
		expect(newSess?.args).toContain('-P');
		expect(newSess?.args).toContain('-F');
		expect(newSess?.args).toContain('#{pane_id}');
	});

	test('new-session argv includes -e CAM_SESSION= so panes inherit the session tag', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		ensureProjectSession('cam-orch-test-000000', spawn);

		const newSess = spawn.calls[1];
		expect(newSess?.args).toContain('-e');
		expect(newSess?.args).toContain('CAM_SESSION=cam-orch-test-000000');
	});

	test('split-window calls include -P -F #{pane_id} for stable pane capture', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		ensureProjectSession('cam-orch-test-000000', spawn);

		const firstSplit = spawn.calls[2];
		expect(firstSplit?.args).toContain('-P');
		expect(firstSplit?.args).toContain('-F');
		expect(firstSplit?.args).toContain('#{pane_id}');

		const secondSplit = spawn.calls[3];
		expect(secondSplit?.args).toContain('-P');
		expect(secondSplit?.args).toContain('-F');
		expect(secondSplit?.args).toContain('#{pane_id}');
	});

	test('returns CreatedPaneIds with captured %n ids when session is created', () => {
		const spawn = makeFakeSpawn({ sessionExists: false });
		const result = ensureProjectSession('cam-orch-myproj-abc123', spawn);

		expect(result).not.toBe(false);
		if (result !== false) {
			expect(result.orchPaneId).toBe('%1');
			expect(result.dashboardPaneId).toBe('%2');
			expect(result.menuPaneId).toBe('%3');
		}
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
		const result = ensureProjectSession('cam-orch-existing-abc123', spawn);

		expect(result).toBe(false);
		// Only has-session was called.
		expect(spawn.calls).toHaveLength(1);
		expect(spawn.calls[0]?.args[0]).toBe('has-session');
	});
});

// ---------------------------------------------------------------------------
// openPaneInSession — split-window argv
// ---------------------------------------------------------------------------

describe('openPaneInSession', () => {
	test('calls split-window -t <session>:0 -v -d -- with the argv elements spread', () => {
		const spawn = makeFakeSpawn();
		const cmdArgv = ['claude', '--permission-mode', 'bypassPermissions'];
		openPaneInSession('cam-orch-myproj-abc123', cmdArgv, spawn);

		expect(spawn.calls).toHaveLength(1);
		const call = spawn.calls[0];
		expect(call?.cmd).toBe('tmux');
		expect(call?.args[0]).toBe('split-window');
		expect(call?.args).toContain('-t');
		expect(call?.args).toContain('cam-orch-myproj-abc123:0');
		expect(call?.args).toContain('-v');
		expect(call?.args).toContain('-d');
		// The separator '--' must appear before the command elements.
		expect(call?.args).toContain('--');
		// Each argv element is a separate arg, not a joined string.
		expect(call?.args).toContain('claude');
		expect(call?.args).toContain('--permission-mode');
		expect(call?.args).toContain('bypassPermissions');
		// Must NOT contain the joined form (that was the old shell-injection path).
		expect(call?.args).not.toContain('claude --permission-mode bypassPermissions');
	});

	test('passes argv elements as separate tmux args (not a single joined shell string)', () => {
		const spawn = makeFakeSpawn();
		// Metacharacters in the issue text must NOT be shell-interpreted.
		const cmdArgv = [
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-issue create fix; $(echo injected) `whoami` & bad > /tmp/x',
		];
		openPaneInSession('cam-orch-test-000000', cmdArgv, spawn);

		const call = spawn.calls[0];
		// The free-text element is passed verbatim as one discrete argv element.
		const lastArg = call?.args[call.args.length - 1];
		expect(lastArg).toBe('/cam-issue create fix; $(echo injected) `whoami` & bad > /tmp/x');
		// It must NOT be joined into a single /bin/sh -c string.
		const joinedStr = cmdArgv.join(' ');
		expect(call?.args).not.toContain(joinedStr);
	});

	test('separator -- appears before command elements to guard against flag-like args', () => {
		const spawn = makeFakeSpawn();
		openPaneInSession('cam-orch-test-000000', ['claude', '/cam-next'], spawn);

		const call = spawn.calls[0];
		const dashDashIdx = call?.args.indexOf('--') ?? -1;
		expect(dashDashIdx).toBeGreaterThan(-1);
		// 'claude' must appear after '--'.
		const claudeIdx = call?.args.indexOf('claude') ?? -1;
		expect(claudeIdx).toBeGreaterThan(dashDashIdx);
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
