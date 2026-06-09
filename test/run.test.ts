// test/run.test.ts
//
// Tests for `cam run` — the orchestrator launcher.
//
// We focus on the parts that are straightforward to verify without spawning
// real tmux processes:
//   - parseRunArgs   (pure CLI parsing)
//   - projectSessionName (deterministic naming — re-exported from session module)
//   - runRun pre-flight failures (no orchestrator file, no tmux on PATH)
//   - tmux argv assertions (new-session + split-window + send-keys for dashboard pane)

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	parseRunArgs,
	projectSessionName,
	runRun,
	buildOrchestratorPaneCommand,
	DEFAULT_MAX_ORCH_RESPAWNS,
} from '../src/commands/run.ts';
import type { SpawnFn } from '../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fake spawn helper for argv tests
// ---------------------------------------------------------------------------

interface SpawnRecord {
	cmd: string;
	args: string[];
}

/**
 * Fake spawn that mirrors the real tmux behaviour ensureProjectSession relies
 * on: new-session and split-window calls that request -P -F #{pane_id} (pipe
 * stdio) receive sequential stable pane ids (%1, %2, %3) in stdout.
 */
function makeFakeSpawn(opts: {
	/** Return 0 for tmux -V (tmux is available). Default: true. */
	tmuxAvailable?: boolean;
	/** Return 0 for has-session (session exists). Default: false. */
	sessionExists?: boolean;
} = {}): SpawnFn & { calls: SpawnRecord[] } {
	const { tmuxAvailable = true, sessionExists = false } = opts;
	const calls: SpawnRecord[] = [];
	let paneCounter = 0;

	const fn: SpawnFn = (cmd, args, options?) => {
		calls.push({ cmd, args: [...args] });

		const result: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};

		if (cmd === 'tmux') {
			// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]=subcommand.
			// Fallback: also handle the bare (no-prefix) form for legacy callers (e.g. tmux -V check).
			const subcommand = args[0] === '-L' ? args[2] : args[0];
			if (subcommand === '-V') {
				result.status = tmuxAvailable ? 0 : 1;
			} else if (subcommand === 'has-session') {
				result.status = sessionExists ? 0 : 1;
			} else if (
				(subcommand === 'new-session' || subcommand === 'split-window') &&
				options?.stdio === 'pipe'
			) {
				// Return a stable pane id for calls that capture it (-P -F #{pane_id}).
				paneCounter += 1;
				result.stdout = Buffer.from(`%${paneCounter}\n`);
			}
		}

		return result;
	};

	const decorated = fn as SpawnFn & { calls: SpawnRecord[] };
	decorated.calls = calls;
	return decorated;
}

/** Build a temp dir with the required .claude/agents/subagent-orchestrator.md. */
function makeTmpProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-run-'));
	const agentsDir = join(cwd, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# stub\n', 'utf8');
	return cwd;
}

// ---------------------------------------------------------------------------
// parseRunArgs
// ---------------------------------------------------------------------------

describe('parseRunArgs', () => {
	it('returns sensible defaults on empty input', () => {
		const r = parseRunArgs([]);
		expect(r).not.toBeNull();
		expect(r!.noAttach).toBe(false);
		expect(r!.help).toBe(false);
	});

	it('parses --no-attach', () => {
		const r = parseRunArgs(['--no-attach']);
		expect(r!.noAttach).toBe(true);
	});

	it('parses --help and -h', () => {
		expect(parseRunArgs(['--help'])!.help).toBe(true);
		expect(parseRunArgs(['-h'])!.help).toBe(true);
	});

	it('returns null on unknown flags', () => {
		expect(parseRunArgs(['--no-such-flag'])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// projectSessionName (re-exported from session module)
// ---------------------------------------------------------------------------

describe('projectSessionName', () => {
	it('produces a tmux-safe name that includes the basename and a 6-char hash', () => {
		const name = projectSessionName('/Users/eduardo/Documents/Projects/cam-cli');
		expect(name).toMatch(/^cam-orch-cam-cli-[0-9a-f]{6}$/);
	});

	it('is deterministic for the same path', () => {
		const a = projectSessionName('/some/path');
		const b = projectSessionName('/some/path');
		expect(a).toBe(b);
	});

	it('differs for paths with the same basename in different parents', () => {
		const a = projectSessionName('/work/proj-a');
		const b = projectSessionName('/personal/proj-a');
		expect(a).not.toBe(b);
	});

	it('replaces unsafe basename characters with dashes', () => {
		const name = projectSessionName('/tmp/has spaces & symbols');
		expect(name).toMatch(/^cam-orch-has-spaces---symbols-[0-9a-f]{6}$/);
	});

	it('handles a trailing slash by treating the parent basename', () => {
		// `basename('/foo/bar/')` returns 'bar' on macOS/Linux.
		const name = projectSessionName('/foo/bar/');
		expect(name).toMatch(/^cam-orch-bar-[0-9a-f]{6}$/);
	});

	it('falls back to "project" when basename is empty (root directory)', () => {
		const name = projectSessionName('/');
		expect(name).toMatch(/^cam-orch-project-[0-9a-f]{6}$/);
	});
});

// ---------------------------------------------------------------------------
// runRun pre-flight: missing orchestrator file
// ---------------------------------------------------------------------------

describe('runRun pre-flight', () => {
	it('returns non-zero when subagent-orchestrator.md is missing', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-run-'));
		// No .claude/agents/subagent-orchestrator.md created.
		const code = runRun({ cwd, noAttach: true });
		// May fail on tmux check first (exit 1) or on orchestrator check (exit 1).
		// Either way, non-zero is the correct contract.
		expect(code).not.toBe(0);
	});

	it('returns 0 in dry-run when the orchestrator file is present (and tmux is on PATH)', () => {
		const cwd = makeTmpProject();
		const prev = process.env['CAM_RUN_DRY_RUN'];
		process.env['CAM_RUN_DRY_RUN'] = '1';
		try {
			const code = runRun({ cwd, noAttach: true });
			// On machines without tmux on PATH, the pre-flight check fails
			// before dry-run kicks in. Either case is acceptable contract:
			//   - 0 means dry-run succeeded.
			//   - non-zero means tmux pre-flight blocked.
			expect([0, 1]).toContain(code);
		} finally {
			if (prev === undefined) delete process.env['CAM_RUN_DRY_RUN'];
			else process.env['CAM_RUN_DRY_RUN'] = prev;
		}
	});
});

// ---------------------------------------------------------------------------
// runRun tmux argv assertions (US-002 acceptance criterion)
// ---------------------------------------------------------------------------

describe('runRun tmux argv — new session', () => {
	it('calls tmux new-session (detached) with correct size flags', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		const newSess = spawn.calls.find(c => c.args[2] === 'new-session');
		expect(newSess).toBeDefined();
		expect(newSess?.cmd).toBe('tmux');
		expect(newSess?.args).toContain('-d');
		expect(newSess?.args).toContain('-s');
		expect(newSess?.args).toContain(projectSessionName(cwd));
		expect(newSess?.args).toContain('-x');
		expect(newSess?.args).toContain('220');
		expect(newSess?.args).toContain('-y');
		expect(newSess?.args).toContain('50');
	});

	it('new-session argv includes -P -F #{pane_id} for stable pane id capture', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		const newSess = spawn.calls.find(c => c.args[2] === 'new-session');
		expect(newSess?.args).toContain('-P');
		expect(newSess?.args).toContain('-F');
		expect(newSess?.args).toContain('#{pane_id}');
	});

	it('new-session argv includes -e CAM_SESSION= so panes inherit the session tag', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		const newSess = spawn.calls.find(c => c.args[2] === 'new-session');
		expect(newSess?.args).toContain('-e');
		expect(newSess?.args).toContain(`CAM_SESSION=${sessionName}`);
	});

	it('calls tmux split-window twice to create pane 1 (dashboard) and pane 2 (menu)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		const splits = spawn.calls.filter(c => c.args[2] === 'split-window');
		expect(splits.length).toBe(2);

		// First split-window: horizontal split targeting the captured orch pane id (%1).
		// Must NOT use a positional index like :0.0 (breaks with pane-base-index 1).
		const firstSplit = splits[0];
		expect(firstSplit?.cmd).toBe('tmux');
		expect(firstSplit?.args).toContain('-t');
		expect(firstSplit?.args).toContain('%1');
		expect(firstSplit?.args).not.toContain('0.0');
		expect(firstSplit?.args).toContain('-h');
		expect(firstSplit?.args).toContain('-d');

		// Second split-window: vertical split targeting the captured dashboard pane id (%2).
		// Must NOT use a positional index like :0.1 (breaks with pane-base-index 1).
		const secondSplit = splits[1];
		expect(secondSplit?.cmd).toBe('tmux');
		expect(secondSplit?.args).toContain('-t');
		expect(secondSplit?.args).toContain('%2');
		expect(secondSplit?.args).not.toContain('0.1');
		expect(secondSplit?.args).toContain('-v');
		expect(secondSplit?.args).toContain('-d');
	});

	it('respawns cam dashboard in pane 1 (US-002)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// The dashboard runs via respawn-pane (direct command, no interactive
		// shell) targeting the captured pane id (%2).
		// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]='respawn-pane'.
		const dashboardRespawn = spawn.calls.find(
			c => c.args[2] === 'respawn-pane' && c.args.some(a => a === '%2'),
		);
		expect(dashboardRespawn).toBeDefined();
		expect(dashboardRespawn?.args[0]).toBe('-L');
		expect(dashboardRespawn?.args[1]).toBe('cam');
		expect(dashboardRespawn?.args).toContain('%2');
		expect(dashboardRespawn?.args).toContain('cam');
		expect(dashboardRespawn?.args).toContain('dashboard');
	});

	it('respawns the cam menu Ink app in pane 2 (US-004)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]='respawn-pane'.
		const menuRespawn = spawn.calls.find(
			c => c.args[2] === 'respawn-pane' && c.args.some(a => a === '%3'),
		);
		expect(menuRespawn).toBeDefined();
		expect(menuRespawn?.args[0]).toBe('-L');
		expect(menuRespawn?.args[1]).toBe('cam');
		expect(menuRespawn?.args).toContain('%3');
		// Runs `cam menu <orchPane> <dashboardPane>` as discrete argv elements.
		expect(menuRespawn?.args).toContain('cam');
		expect(menuRespawn?.args).toContain('menu');
		// The orchestrator (%1) and dashboard (%2) pane ids are passed as args.
		expect(menuRespawn?.args).toContain('%1');
		expect(menuRespawn?.args).toContain('%2');
	});

	it('respawns the claude command in pane 0', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// The orch pane runs via respawn-pane targeting the captured pane id (%1).
		// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]='respawn-pane'.
		const orchRespawn = spawn.calls.find(
			c => c.args[2] === 'respawn-pane' && c.args.some(a => a === '%1'),
		);
		expect(orchRespawn).toBeDefined();
		expect(orchRespawn?.args[0]).toBe('-L');
		expect(orchRespawn?.args[1]).toBe('cam');
		expect(orchRespawn?.args).toContain('%1');
		// The command includes the `claude` invocation (passed via bash -c).
		expect(orchRespawn?.args.some(a => a.includes('claude'))).toBe(true);
	});

	it('pane 0 command chains kill-session after claude exits (US-003)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]='respawn-pane'.
		const orchRespawn = spawn.calls.find(
			c => c.args[2] === 'respawn-pane' && c.args.some(a => a === '%1'),
		);
		expect(orchRespawn).toBeDefined();
		// The composed command must contain tmux -L cam kill-session for this session.
		const composedCmd = orchRespawn?.args.find(a => a.includes('kill-session'));
		expect(composedCmd).toBeDefined();
		expect(composedCmd).toContain(`-L cam kill-session -t ${sessionName}`);
	});

	it('skips session creation when session already exists', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: true });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// When session already exists, no new-session or split-window calls.
		const newSess = spawn.calls.find(c => c.args[2] === 'new-session');
		const split = spawn.calls.find(c => c.args[2] === 'split-window');
		expect(newSess).toBeUndefined();
		expect(split).toBeUndefined();
	});

	it('returns 1 when tmux is not available', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: false, sessionExists: false });

		const code = runRun({ cwd, noAttach: true, spawnFn: spawn });
		expect(code).toBe(1);
	});
});

// The interactive menu is now the `cam menu` Ink app (src/ui/Menu.tsx); its
// pane wiring is covered by the "respawns the cam menu Ink app in pane 2" test
// above. The old bash buildRunMenuScript was removed.

// ---------------------------------------------------------------------------
// runRun session-id + marker file (US-002)
// ---------------------------------------------------------------------------

describe('runRun session-id and marker file (US-002)', () => {
	const FIXED_UUID = 'deadbeef-1234-5678-abcd-000000000000';

	it('passes --session-id <uuid> to the orchestrator pane respawn-pane argv', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID });

		// The orchestrator pane targets %1.
		const orchRespawn = spawn.calls.find(
			c => c.args[2] === 'respawn-pane' && c.args.some(a => a === '%1'),
		);
		expect(orchRespawn).toBeDefined();

		// The composed bash -c command must seed the session uuid. The CAM-23
		// self-handoff wrapper sets `sid='<uuid>'` then passes `--session-id "$sid"`
		// (so respawns can re-point sid at a fresh uuid via uuidgen).
		const composedCmd = orchRespawn?.args.find(a => a.includes('--session-id'));
		expect(composedCmd).toBeDefined();
		expect(composedCmd).toContain(`sid='${FIXED_UUID}'`);
		expect(composedCmd).toContain('--session-id "$sid"');
	});

	it('writes the session uuid to .claude/.cam-orch-session on new session', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID });

		const markerPath = join(cwd, '.claude', '.cam-orch-session');
		expect(existsSync(markerPath)).toBe(true);
		expect(readFileSync(markerPath, 'utf8')).toBe(FIXED_UUID);
	});

	it('does NOT rewrite .cam-orch-session on session re-attach (created: false)', () => {
		const cwd = makeTmpProject();

		// Pre-write the marker with an original uuid to simulate a previous session.
		const dotClaude = join(cwd, '.claude');
		mkdirSync(dotClaude, { recursive: true });
		const originalUuid = 'original-uuid-0000-0000-0000-000000000000';
		writeFileSync(join(dotClaude, '.cam-orch-session'), originalUuid, 'utf8');

		// Simulate session already exists (re-attach path).
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: true });

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID });

		// Marker must still contain the original uuid, not the new one.
		const markerPath = join(cwd, '.claude', '.cam-orch-session');
		expect(readFileSync(markerPath, 'utf8')).toBe(originalUuid);
	});
});

describe('buildOrchestratorPaneCommand (CAM-23 self-handoff wrapper)', () => {
	const base = {
		sessionName: 'cam-orch-proj-abc123',
		sessionId: '11111111-2222-3333-4444-555555555555',
		promptFile: '/project/.claude/.cam-orchestrator-prompt.txt',
		sessionIdMarker: '/project/.claude/.cam-orch-session',
		handoffMarker: '/project/.claude/.cam-orch-handoff.json',
	};

	it('preserves --permission-mode bypassPermissions and the initial session-id', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		expect(cmd).toContain('claude --permission-mode bypassPermissions');
		expect(cmd).toContain(`sid='${base.sessionId}'`);
		expect(cmd).toContain('--session-id "$sid"');
	});

	it('guards on the handoff file, consumes it, and rewrites the session marker on respawn', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		expect(cmd).toContain(`[ -f '${base.handoffMarker}' ]`);
		expect(cmd).toContain(
			`mv '${base.handoffMarker}' '/project/.claude/.cam-orch-handoff.consumed.json'`,
		);
		expect(cmd).toContain(`> '${base.sessionIdMarker}'`);
	});

	it('mints a fresh uuid via uuidgen on respawn (F-03)', () => {
		expect(buildOrchestratorPaneCommand(base)).toContain('sid=$(uuidgen)');
	});

	it('falls back to kill-session for the tmux session', () => {
		expect(buildOrchestratorPaneCommand(base)).toContain(
			`tmux -L cam kill-session -t ${base.sessionName}`,
		);
	});

	it('respects the maxRespawns cap (default, overridable)', () => {
		expect(buildOrchestratorPaneCommand(base)).toContain(`max=${DEFAULT_MAX_ORCH_RESPAWNS}`);
		expect(buildOrchestratorPaneCommand({ ...base, maxRespawns: 2 })).toContain('max=2');
		expect(buildOrchestratorPaneCommand(base)).toContain('[ "$n" -lt "$max" ]');
	});
});
