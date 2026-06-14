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

import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	projectSessionName,
	ensureProjectSession,
	openPaneInSession,
	isInsideProjectSession,
	isSessionStale,
	clampDashboardWidth,
	CAM_TMUX_SOCKET,
	tmuxArgs,
	respawnPaneArgv,
	capturePaneArgv,
	writeWorkerPaneMarker,
	readWorkerPaneMarker,
	WORKER_PANE_MARKER,
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

		if (cmd === 'tmux' && args[2] === 'has-session') {
			result.status = handlers.sessionExists ? 0 : 1;
		}

		// Return a stable pane id for calls that capture it via -P -F #{pane_id}.
		if (
			cmd === 'tmux' &&
			(args[2] === 'new-session' || args[2] === 'split-window') &&
			opts?.stdio === 'pipe'
		) {
			paneCounter += 1;
			result.stdout = Buffer.from(`%${paneCounter}\n`);
		}
		// respawn-pane and wait-for subcommands: just return status 0.

		return result;
	};

	const decorated = fn as SpawnFn & { calls: SpawnRecord[] };
	decorated.calls = calls;
	return decorated;
}

// ---------------------------------------------------------------------------
// CAM_TMUX_SOCKET + tmuxArgs
// ---------------------------------------------------------------------------

describe('CAM_TMUX_SOCKET', () => {
	test('equals "cam"', () => {
		expect(CAM_TMUX_SOCKET).toBe('cam');
	});
});

describe('tmuxArgs', () => {
	test('prepends -L and the socket name before the subcommand', () => {
		expect(tmuxArgs(['has-session', '-t', 'myses'])).toEqual([
			'-L', 'cam', 'has-session', '-t', 'myses',
		]);
	});

	test('works with an empty subcommand array', () => {
		expect(tmuxArgs([])).toEqual(['-L', 'cam']);
	});

	test('does not mutate the input array', () => {
		const sub = ['new-session', '-d'];
		const result = tmuxArgs(sub);
		expect(sub).toEqual(['new-session', '-d']);
		expect(result).toEqual(['-L', 'cam', 'new-session', '-d']);
	});
});

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

		// First call must be has-session, with -L cam prefix.
		const first = spawn.calls[0];
		expect(first).toBeDefined();
		expect(first?.cmd).toBe('tmux');
		expect(first?.args[0]).toBe('-L');
		expect(first?.args[1]).toBe('cam');
		expect(first?.args[2]).toBe('has-session');
		expect(first?.args).toContain('cam-orch-myproj-abc123');

		// Second call must be new-session (detached), with -L cam prefix.
		const newSess = spawn.calls[1];
		expect(newSess).toBeDefined();
		expect(newSess?.cmd).toBe('tmux');
		expect(newSess?.args[0]).toBe('-L');
		expect(newSess?.args[1]).toBe('cam');
		expect(newSess?.args[2]).toBe('new-session');
		expect(newSess?.args).toContain('-d');
		expect(newSess?.args).toContain('-s');
		expect(newSess?.args).toContain('cam-orch-myproj-abc123');

		// Third call: first split-window creates dashboard pane (horizontal split).
		// Target must be the captured orchPaneId (%1), NOT a positional index.
		const firstSplit = spawn.calls[2];
		expect(firstSplit).toBeDefined();
		expect(firstSplit?.cmd).toBe('tmux');
		expect(firstSplit?.args[0]).toBe('-L');
		expect(firstSplit?.args[1]).toBe('cam');
		expect(firstSplit?.args[2]).toBe('split-window');
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
		expect(secondSplit?.args[0]).toBe('-L');
		expect(secondSplit?.args[1]).toBe('cam');
		expect(secondSplit?.args[2]).toBe('split-window');
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
		// Only has-session was called, with -L cam prefix.
		expect(spawn.calls).toHaveLength(1);
		expect(spawn.calls[0]?.args[0]).toBe('-L');
		expect(spawn.calls[0]?.args[1]).toBe('cam');
		expect(spawn.calls[0]?.args[2]).toBe('has-session');
	});
});

// ---------------------------------------------------------------------------
// openPaneInSession — split-window argv
// ---------------------------------------------------------------------------

describe('openPaneInSession', () => {
	test('calls split-window -t <session>:0 -v -d -P -F #{pane_id} -- with the argv elements spread', () => {
		const spawn = makeFakeSpawn();
		const cmdArgv = ['claude', '--permission-mode', 'bypassPermissions'];
		openPaneInSession('cam-orch-myproj-abc123', cmdArgv, spawn);

		expect(spawn.calls).toHaveLength(1);
		const call = spawn.calls[0];
		expect(call?.cmd).toBe('tmux');
		expect(call?.args[0]).toBe('-L');
		expect(call?.args[1]).toBe('cam');
		expect(call?.args[2]).toBe('split-window');
		expect(call?.args).toContain('-t');
		expect(call?.args).toContain('cam-orch-myproj-abc123:0');
		expect(call?.args).toContain('-v');
		expect(call?.args).toContain('-d');
		// Must include -P -F #{pane_id} for stable pane capture.
		expect(call?.args).toContain('-P');
		expect(call?.args).toContain('-F');
		expect(call?.args).toContain('#{pane_id}');
		// The separator '--' must appear before the command elements.
		expect(call?.args).toContain('--');
		// Each argv element is a separate arg, not a joined string.
		expect(call?.args).toContain('claude');
		expect(call?.args).toContain('--permission-mode');
		expect(call?.args).toContain('bypassPermissions');
		// Must NOT contain the joined form (that was the old shell-injection path).
		expect(call?.args).not.toContain('claude --permission-mode bypassPermissions');
	});

	test('returns the captured pane id from stdout', () => {
		const spawn = makeFakeSpawn();
		const paneId = openPaneInSession('cam-orch-myproj-abc123', ['claude'], spawn);
		// makeFakeSpawn increments counter for split-window with stdio: pipe.
		expect(paneId).toBe('%1');
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
// Worker-slot argv builders (CAM-22 / US-001)
// ---------------------------------------------------------------------------

describe('respawnPaneArgv', () => {
	test('prepends -L cam and includes respawn-pane -k -t <paneId>', () => {
		const argv = respawnPaneArgv('%5', ['claude', '--permission-mode', 'bypassPermissions']);
		expect(argv[0]).toBe('-L');
		expect(argv[1]).toBe('cam');
		expect(argv[2]).toBe('respawn-pane');
		expect(argv).toContain('-k');
		expect(argv).toContain('-t');
		expect(argv).toContain('%5');
	});

	test('spreads the shell command elements after the target', () => {
		const argv = respawnPaneArgv('%3', ['bash', '-c', 'echo hello']);
		const targetIdx = argv.indexOf('-t');
		expect(targetIdx).toBeGreaterThan(-1);
		const afterTarget = argv.slice(targetIdx + 2);
		expect(afterTarget).toEqual(['bash', '-c', 'echo hello']);
	});
});

describe('capturePaneArgv', () => {
	test('prepends -L cam and includes capture-pane -p -t <paneId>', () => {
		const argv = capturePaneArgv('%7');
		expect(argv[0]).toBe('-L');
		expect(argv[1]).toBe('cam');
		expect(argv[2]).toBe('capture-pane');
		expect(argv).toContain('-p');
		expect(argv).toContain('-t');
		expect(argv).toContain('%7');
	});
});

// ---------------------------------------------------------------------------
// Worker pane marker persistence
// ---------------------------------------------------------------------------

describe('writeWorkerPaneMarker / readWorkerPaneMarker', () => {
	test('round-trip: write then read returns the same pane id', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-worker-marker-'));
		const claudeDir = join(tmpDir, '.claude');
		writeWorkerPaneMarker(claudeDir, '%5');
		expect(readWorkerPaneMarker(claudeDir)).toBe('%5');
	});

	test('creates the claudeDir if it does not exist', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-worker-marker-'));
		const claudeDir = join(tmpDir, '.claude');
		writeWorkerPaneMarker(claudeDir, '%3');
		expect(existsSync(claudeDir)).toBe(true);
	});

	test('writes file named WORKER_PANE_MARKER inside claudeDir', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-worker-marker-'));
		const claudeDir = join(tmpDir, '.claude');
		writeWorkerPaneMarker(claudeDir, '%9');
		const filePath = join(claudeDir, WORKER_PANE_MARKER);
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, 'utf8')).toBe('%9');
	});

	test('readWorkerPaneMarker returns null when file does not exist', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-worker-marker-'));
		const claudeDir = join(tmpDir, '.claude');
		expect(readWorkerPaneMarker(claudeDir)).toBeNull();
	});

	test('readWorkerPaneMarker returns null when file is empty', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-worker-marker-'));
		const claudeDir = join(tmpDir, '.claude');
		writeWorkerPaneMarker(claudeDir, '');
		expect(readWorkerPaneMarker(claudeDir)).toBeNull();
	});

	test('last write wins (overwrites previous pane id)', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-worker-marker-'));
		const claudeDir = join(tmpDir, '.claude');
		writeWorkerPaneMarker(claudeDir, '%1');
		writeWorkerPaneMarker(claudeDir, '%7');
		expect(readWorkerPaneMarker(claudeDir)).toBe('%7');
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

// ---------------------------------------------------------------------------
// isSessionStale (CAM-47)
// ---------------------------------------------------------------------------

/** Minimal fake: list-panes returns the given stdout + status. */
function staleSpawn(listPanesStdout: string, listPanesStatus = 0): SpawnFn {
	return ((cmd, args, opts) => {
		const sub = args[0] === '-L' ? args[2] : args[0];
		if (cmd === 'tmux' && sub === 'list-panes' && opts?.stdio === 'pipe') {
			return {
				pid: 1, output: [null, Buffer.from(listPanesStdout), Buffer.from('')],
				stdout: Buffer.from(listPanesStdout), stderr: Buffer.from(''),
				status: listPanesStatus, signal: null,
			} as ReturnType<SpawnFn>;
		}
		return {
			pid: 1, output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''), stderr: Buffer.from(''), status: 0, signal: null,
		} as ReturnType<SpawnFn>;
	}) as SpawnFn;
}

describe('isSessionStale', () => {
	test('healthy: 3 panes, none cat -> false', () => {
		expect(isSessionStale('s', staleSpawn('claude\ncam\ncam\n'))).toBe(false);
	});

	test('a cat placeholder pane -> true', () => {
		expect(isSessionStale('s', staleSpawn('cat\ncam\ncam\n'))).toBe(true);
	});

	test('wrong pane count (4) -> true', () => {
		expect(isSessionStale('s', staleSpawn('claude\ncam\ncam\nzsh\n'))).toBe(true);
	});

	test('wrong pane count (1) -> true', () => {
		expect(isSessionStale('s', staleSpawn('claude\n'))).toBe(true);
	});

	test('empty list-panes output -> true (conservative)', () => {
		expect(isSessionStale('s', staleSpawn(''))).toBe(true);
	});

	test('list-panes non-zero exit -> true (conservative)', () => {
		expect(isSessionStale('s', staleSpawn('', 1))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// clampDashboardWidth (US-001)
// ---------------------------------------------------------------------------

describe('clampDashboardWidth', () => {
	test('220 cols -> 44 (20% proportion, within band)', () => {
		expect(clampDashboardWidth(220)).toBe(44);
	});

	test('100 cols -> 34 (floor: 20% = 20, clamped to 34)', () => {
		expect(clampDashboardWidth(100)).toBe(34);
	});

	test('400 cols -> 52 (ceiling: 20% = 80, clamped to 52)', () => {
		expect(clampDashboardWidth(400)).toBe(52);
	});

	test('188 cols -> 38 (20% = 37.6, rounds to 38, within band)', () => {
		expect(clampDashboardWidth(188)).toBe(38);
	});
});
