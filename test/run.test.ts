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
	buildOrchestratorBootPrompt,
	DEFAULT_MAX_ORCH_RESPAWNS,
	type SpawnSidecarFn,
	type SpawnWatcherFn,
} from '../src/commands/run.ts';
import { ORCH_RECYCLE_MARKER, type SpawnFn } from '../src/tmux/session.ts';

/**
 * No-op sidecar handle. runRun spawns the sidecar via spawnSidecarFn, whose
 * production default runs a REAL `cam sidecar` process. Once a current cam
 * binary is on PATH that process idles forever and keeps its stdio pipe open,
 * which hangs `bun test`. Every runRun test must inject this so no real
 * sidecar is spawned (US-FIX-002 test-hygiene fix, CAM-55 operator smoke).
 */
const noopSidecar: SpawnSidecarFn = () => ({ pid: 0, kill: () => {} });

/**
 * No-op watcher handle. runRun spawns the recycle watcher via spawnWatcherFn,
 * whose production default runs a REAL `cam orch-recycle-watch` process. Every
 * runRun test that creates a new session must inject this so no real watcher
 * is spawned (US-004, mirrors the noopSidecar pattern).
 */
const noopWatcher: SpawnWatcherFn = () => ({ pid: 0, kill: () => {} });

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
	/**
	 * stdout for `list-panes` when the session exists (CAM-47 staleness check).
	 * Default is the HEALTHY shape (2 panes, none `cat`) so the re-attach test
	 * keeps exercising the no-reset branch. A stale-path test passes a malformed
	 * value (a `cat` pane or wrong pane count).
	 */
	listPanes?: string;
	/**
	 * How to respond to the `claude auth status --json` probe from checkClaudeAuth.
	 * 'loggedIn'    (default) — stdout JSON with loggedIn:true, status 0.
	 * 'notLoggedIn'           — stdout JSON with loggedIn:false, status 0.
	 * 'error'                 — status non-zero (probe fails).
	 */
	claudeAuth?: 'loggedIn' | 'notLoggedIn' | 'error';
} = {}): SpawnFn & { calls: SpawnRecord[] } {
	const { tmuxAvailable = true, sessionExists = false, listPanes = 'claude\ncam\n', claudeAuth = 'loggedIn' } = opts;
	const calls: SpawnRecord[] = [];
	let paneCounter = 0;
	// kill-session flips this so a stale-path recreate (ensureProjectSession ->
	// hasSession) sees the session as gone and rebuilds it.
	let exists = sessionExists;

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

		if (cmd === 'claude') {
			// claude auth status --json probe from checkClaudeAuth (US-002).
			if (claudeAuth === 'error') {
				result.status = 1;
			} else {
				result.stdout = Buffer.from(JSON.stringify({ loggedIn: claudeAuth === 'loggedIn' }));
			}
		}

		if (cmd === 'tmux') {
			// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]=subcommand.
			// Fallback: also handle the bare (no-prefix) form for legacy callers (e.g. tmux -V check).
			const subcommand = args[0] === '-L' ? args[2] : args[0];
			if (subcommand === '-V') {
				result.status = tmuxAvailable ? 0 : 1;
			} else if (subcommand === 'has-session') {
				result.status = exists ? 0 : 1;
			} else if (subcommand === 'kill-session') {
				exists = false;
			} else if (subcommand === 'list-panes' && options?.stdio === 'pipe') {
				result.stdout = Buffer.from(listPanes);
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
		const code = runRun({ cwd, noAttach: true, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });
		// May fail on tmux check first (exit 1) or on orchestrator check (exit 1).
		// Either way, non-zero is the correct contract.
		expect(code).not.toBe(0);
	});

	it('returns 0 in dry-run when the orchestrator file is present (and tmux is on PATH)', () => {
		const cwd = makeTmpProject();
		const prev = process.env['CAM_RUN_DRY_RUN'];
		process.env['CAM_RUN_DRY_RUN'] = '1';
		try {
			const code = runRun({ cwd, noAttach: true, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });
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

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

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

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		const newSess = spawn.calls.find(c => c.args[2] === 'new-session');
		expect(newSess?.args).toContain('-P');
		expect(newSess?.args).toContain('-F');
		expect(newSess?.args).toContain('#{pane_id}');
	});

	it('new-session argv includes -e CAM_SESSION= so panes inherit the session tag', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		const newSess = spawn.calls.find(c => c.args[2] === 'new-session');
		expect(newSess?.args).toContain('-e');
		expect(newSess?.args).toContain(`CAM_SESSION=${sessionName}`);
	});

	it('calls tmux split-window once to create pane 1 (dashboard)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		const splits = spawn.calls.filter(c => c.args[2] === 'split-window');
		expect(splits.length).toBe(1);

		// The single split-window: horizontal split targeting the captured orch pane id (%1).
		// Must NOT use a positional index like :0.0 (breaks with pane-base-index 1).
		const dashSplit = splits[0];
		expect(dashSplit?.cmd).toBe('tmux');
		expect(dashSplit?.args).toContain('-t');
		expect(dashSplit?.args).toContain('%1');
		expect(dashSplit?.args).not.toContain('0.0');
		expect(dashSplit?.args).toContain('-h');
		expect(dashSplit?.args).toContain('-d');
	});

	it('respawns cam dashboard in pane 1 with orchPaneId positional (US-002, US-004)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// The dashboard runs via respawn-pane (direct command, no interactive
		// shell) targeting the captured pane id (%2). The orchPaneId (%1) is
		// passed as a positional so the dashboard dispatch wiring binds to the
		// real orchestrator pane (US-003/US-004).
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
		// orchPaneId (%1) must appear in the argv so the dashboard can dispatch
		// keystrokes to the orchestrator pane (US-004).
		expect(dashboardRespawn?.args).toContain('%1');
	});

	it('respawns the claude command in pane 0', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

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

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

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

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// When session already exists, no new-session or split-window calls.
		const newSess = spawn.calls.find(c => c.args[2] === 'new-session');
		const split = spawn.calls.find(c => c.args[2] === 'split-window');
		expect(newSess).toBeUndefined();
		expect(split).toBeUndefined();
	});

	it('returns 1 when tmux is not available', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: false, sessionExists: false });

		const code = runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });
		expect(code).toBe(1);
	});

	it('no cam menu command appears in any spawned argv (US-004)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// The menu pane was removed in US-004; no spawn should reference 'menu'.
		const menuCmd = spawn.calls.find(c => c.args.some(a => a === 'menu'));
		expect(menuCmd).toBeUndefined();
	});

	it('status-left contains the green bg pill with accent background (US-004)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// Find the set-option call for status-left.
		// argv shape: ['-L', 'cam', 'set-option', '-t', sessionName, 'status-left', value]
		const statusLeftCall = spawn.calls.find(
			c => c.args[2] === 'set-option' && c.args.some(a => a === 'status-left'),
		);
		expect(statusLeftCall).toBeDefined();
		const idx = statusLeftCall!.args.indexOf('status-left');
		const value = statusLeftCall!.args[idx + 1];
		// Must use a bg= pill (not just fg=) on the accent color so the label is
		// highlighted with a filled green background (US-004 acceptance criterion).
		expect(value).toBeDefined();
		expect(value).toContain('bg=#4EBE7D');
	});

	it('pane-border-format active title uses the same green bg pill as the status indicator', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		const call = spawn.calls.find(
			c => c.args[2] === 'set-option' && c.args.some(a => a === 'pane-border-format'),
		);
		expect(call).toBeDefined();
		const idx = call!.args.indexOf('pane-border-format');
		const value = call!.args[idx + 1];
		// Active pane title is a filled green pill (bg=), matching the status-left
		// active indicator, so "green pill = active" reads the same top and bottom.
		expect(value).toBeDefined();
		expect(value).toContain('bg=#4EBE7D');
	});

	it('both pane border styles are accent so the shared divider is uniformly green', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		const styleFor = (name: string): string | undefined => {
			const call = spawn.calls.find(
				c => c.args[2] === 'set-option' && c.args.some(a => a === name),
			);
			if (call === undefined) return undefined;
			return call.args[call.args.indexOf(name) + 1];
		};
		// tmux colors each side of a shared border with that pane's own style;
		// if the inactive style were muted the divider would render half-green and
		// flip with focus. Both accent => the full divider is green regardless.
		expect(styleFor('pane-active-border-style')).toContain('#4EBE7D');
		expect(styleFor('pane-border-style')).toContain('#4EBE7D');
	});
});

// The 2-pane layout (US-002/US-004) has exactly orchestrator (pane 0) and
// dashboard (pane 1); no menu pane is created by ensureProjectSession.

// ---------------------------------------------------------------------------
// runRun session-id + marker file (US-002)
// ---------------------------------------------------------------------------

describe('runRun session-id and marker file (US-002)', () => {
	const FIXED_UUID = 'deadbeef-1234-5678-abcd-000000000000';

	it('passes --session-id <uuid> to the orchestrator pane respawn-pane argv', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

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

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

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

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// Marker must still contain the original uuid, not the new one.
		const markerPath = join(cwd, '.claude', '.cam-orch-session');
		expect(readFileSync(markerPath, 'utf8')).toBe(originalUuid);
	});

	it('CAM-47: healthy existing session is NOT reset (no kill-session, attach)', () => {
		const cwd = makeTmpProject();
		// Existing session, healthy list-panes (3 panes, none cat).
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: true });

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// A healthy re-attach must NOT kill the session (would nuke a live loop).
		const killed = spawn.calls.some((c) => c.args.includes('kill-session'));
		expect(killed).toBe(false);
	});

	it('CAM-47: stale existing session (cat pane) is killed + recreated', () => {
		const cwd = makeTmpProject();
		// Existing 2-pane session but one pane is still the `cat` placeholder -> stale.
		const spawn = makeFakeSpawn({
			tmuxAvailable: true,
			sessionExists: true,
			listPanes: 'cat\ncam\n',
		});

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// Stale path: the session is killed, then recreated + panes set up.
		const killed = spawn.calls.some((c) => c.args.includes('kill-session'));
		expect(killed).toBe(true);
		// Recreate path runs the orchestrator respawn into a pane (respawn-pane -k).
		const respawned = spawn.calls.some((c) => c.args.includes('respawn-pane'));
		expect(respawned).toBe(true);
	});

	it('clears a stale .cam-orch-handoff.json on a newly created session (CAM-23)', () => {
		const cwd = makeTmpProject();
		const dotClaude = join(cwd, '.claude');
		mkdirSync(dotClaude, { recursive: true });
		const handoff = join(dotClaude, '.cam-orch-handoff.json');
		writeFileSync(handoff, '{"schemaVersion":1,"writtenAt":"x","reason":"stale"}', 'utf8');
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, genSessionId: () => FIXED_UUID, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// A fresh session must not inherit the leftover handoff.
		expect(existsSync(handoff)).toBe(false);
	});
});

describe('buildOrchestratorPaneCommand (CAM-23 self-handoff wrapper)', () => {
	const base = {
		sessionName: 'cam-orch-proj-abc123',
		sessionId: '11111111-2222-3333-4444-555555555555',
		promptFile: '/project/.claude/.cam-orchestrator-prompt.txt',
		sessionIdMarker: '/project/.claude/.cam-orch-session',
		handoffMarker: '/project/.claude/.cam-orch-handoff.json',
		stateFile: '/project/.claude/cam-loop.local.md',
		readyMarker: '/project/.claude/.cam-orch-ready',
		pidMarker: '/project/.claude/.cam-orch-pid',
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

	it('mints a fresh LOWERCASED uuid via uuidgen on respawn (F-03 + macOS case fix)', () => {
		// macOS uuidgen is UPPERCASE; claude transcript filenames are lowercase, so
		// the respawn uuid must be lowercased or the budget check breaks post-respawn.
		expect(buildOrchestratorPaneCommand(base)).toContain("sid=$(uuidgen | tr 'A-Z' 'a-z')");
	});

	it('falls back to kill-session for the tmux session', () => {
		expect(buildOrchestratorPaneCommand(base)).toContain(
			`tmux -L cam kill-session -t ${base.sessionName}`,
		);
	});

	it('removes the loop state file on teardown, before kill-session (clean /exit)', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		expect(cmd).toContain(`rm -f '${base.stateFile}'`);
		// The rm must run BEFORE kill-session: once the session dies the wrapper
		// stops, so a rm queued after kill-session would never execute.
		expect(cmd.indexOf(`rm -f '${base.stateFile}'`)).toBeLessThan(
			cmd.indexOf(`kill-session -t ${base.sessionName}`),
		);
	});

	it('respects the maxRespawns cap and only increments inside the under-cap gate', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		expect(cmd).toContain(`max=${DEFAULT_MAX_ORCH_RESPAWNS}`);
		expect(buildOrchestratorPaneCommand({ ...base, maxRespawns: 2 })).toContain('max=2');
		expect(cmd).toContain('[ "$n" -lt "$max" ]');
		expect(cmd).toContain('n=$((n + 1))');
		// The increment sits AFTER the under-cap guard (inside the respawn branch),
		// so a write-then-instant-exit cannot loop past the cap.
		expect(cmd.indexOf('[ "$n" -lt "$max" ]')).toBeLessThan(cmd.indexOf('n=$((n + 1))'));
	});

	it('exports CAM_ORCH_REHYDRATE to the consumed path after mv, before re-exec (US-005)', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		const consumed = base.handoffMarker.replace(/\.json$/, '.consumed.json');
		// The export must use the consumed path so the freshly spawned claude reads
		// exactly the renamed file (consume-once invariant preserved).
		expect(cmd).toContain(`export CAM_ORCH_REHYDRATE='${consumed}'`);
		// Export must come AFTER the mv (file must exist before we point at it)
		// and BEFORE the uuid generation (so the env is set before re-exec).
		const mvIdx = cmd.indexOf(`mv '${base.handoffMarker}'`);
		const exportIdx = cmd.indexOf(`export CAM_ORCH_REHYDRATE=`);
		const uuidgenIdx = cmd.indexOf(`uuidgen`);
		expect(mvIdx).toBeLessThan(exportIdx);
		expect(exportIdx).toBeLessThan(uuidgenIdx);
	});

	it('reads reason with jq before mv, resets n=0 on cycle-close, increments otherwise (US-003)', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		// jq reads the reason field from the handoff BEFORE the mv rename.
		expect(cmd).toContain(`jq -r '.reason // empty' '${base.handoffMarker}'`);
		expect(cmd.indexOf('jq')).toBeLessThan(
			cmd.indexOf(`mv '${base.handoffMarker}'`),
		);
		// cycle-close resets the counter so the session never hits the cap due to
		// normal progress handoffs.
		expect(cmd).toContain(`[ "$reason" = 'cycle-close' ]`);
		expect(cmd).toContain('then n=0');
		// Non-cycle-close (no-progress or unknown) still increments the counter.
		expect(cmd).toContain('n=$((n + 1))');
	});

	it('writes wrapper pid ($$) to pidMarker exactly once, before the while loop (CAM-173 US-001)', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		// The pid write must be present and use $$, not $BASHPID (empty in bash 3.2).
		expect(cmd).toContain(`printf '%s' "$$" > '${base.pidMarker}'`);
		// The pid write must appear BEFORE "while true; do" so the marker is
		// populated before any claude invocation runs.
		expect(cmd.indexOf(`printf '%s' "$$"`)).toBeLessThan(cmd.indexOf('while true; do'));
	});

	it('claude invocation line has no background operator & (Ink TUI must stay foreground)', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		// Extract the claude invocation line. It should not be backgrounded.
		// A backgrounded claude (&) would send stdin to /dev/null in a non-job-control
		// bash and break the Ink TUI.
		const claudeIdx = cmd.indexOf('claude --permission-mode');
		const semicolonAfterClaude = cmd.indexOf(';', claudeIdx);
		const claudeLine = cmd.slice(claudeIdx, semicolonAfterClaude);
		expect(claudeLine).not.toContain('&');
	});

	it('removes pidMarker in teardown branch, before kill-session (CAM-173 US-001)', () => {
		const cmd = buildOrchestratorPaneCommand(base);
		expect(cmd).toContain(`rm -f '${base.pidMarker}'`);
		// Must be in the teardown branch: after the stateFile rm and before kill-session.
		expect(cmd.indexOf(`rm -f '${base.pidMarker}'`)).toBeGreaterThan(
			cmd.indexOf(`rm -f '${base.stateFile}'`),
		);
		expect(cmd.indexOf(`rm -f '${base.pidMarker}'`)).toBeLessThan(
			cmd.indexOf(`kill-session -t ${base.sessionName}`),
		);
	});
});

describe('buildOrchestratorBootPrompt (CAM-23 rehydration directive)', () => {
	it('directs the orchestrator to rehydrate via CAM_ORCH_REHYDRATE when present (US-005)', () => {
		const prompt = buildOrchestratorBootPrompt();
		// Must reference the env var, not an unconditional path check (US-005, CAM-141).
		expect(prompt).toContain('CAM_ORCH_REHYDRATE');
		expect(prompt.toLowerCase()).toContain('rehydrate');
		// Still tells it to read its agent system prompt.
		expect(prompt).toContain('subagent-orchestrator.md');
	});

	it('cold-start safe: does NOT unconditionally instruct reading a stale handoff file (US-005)', () => {
		const prompt = buildOrchestratorBootPrompt();
		// The old "if .cam-orch-handoff.json exists, read it" instruction is gone;
		// rehydration is now gated on CAM_ORCH_REHYDRATE being non-empty.
		// NOTE: the path MAY appear in the cold-boot prohibition clause (do NOT read
		// any stale .cam-orch-handoff.json) - that is the ONLY acceptable reference.
		// The boot prompt must NOT instruct an unconditional read of the file.
		const instructionToReadHandoff =
			/read.*\.cam-orch-handoff\.json.*first|if.*\.cam-orch-handoff\.json.*exists.*read/i;
		expect(instructionToReadHandoff.test(prompt)).toBe(false);
	});

	it('US-FIX-005: instructs the orchestrator to write .cam-orch-ready as FIRST action', () => {
		const prompt = buildOrchestratorBootPrompt();
		// The boot prompt must tell the agent to write the ready marker before
		// anything else (so the marker means "agent loaded", not "parent spawned").
		expect(prompt).toContain('.claude/.cam-orch-ready');
		// The instruction must appear BEFORE the subagent-orchestrator.md read
		// directive so the agent writes the marker as its very first action.
		expect(prompt.indexOf('.cam-orch-ready')).toBeLessThan(
			prompt.indexOf('subagent-orchestrator.md'),
		);
	});

	it('US-FIX-005: marker instruction uses Bash, not the Write tool (orchestrator lacks Write)', () => {
		// subagent-orchestrator's tools are Read/Glob/Grep/Bash/WebFetch/SlashCommand
		// — NO Write/Edit. Telling it to "use the Write tool" would silently fail and
		// the marker would never appear, deadlocking the thin-proxy bootstrap-wait.
		const prompt = buildOrchestratorBootPrompt();
		// Must not INSTRUCT using the Write tool (the bug). Clarifying that the
		// agent does NOT have Write is fine, so match the buggy directive phrasing.
		expect(prompt).not.toContain('use the Write tool');
		expect(prompt).toContain('Bash');
	});
});

// ---------------------------------------------------------------------------
// runRun: orch-ready marker NOT written by parent (US-FIX-005)
// ---------------------------------------------------------------------------

describe('runRun orch-ready marker (US-FIX-005)', () => {
	it('does NOT write .cam-orch-ready in the parent process on new session creation', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const fakeSidecar = { pid: 0, kill: () => {} };
		const spawnSidecarFn = (_c: string, _l: string) => fakeSidecar;

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn, spawnWatcherFn: noopWatcher });

		// The marker must NOT be written by the parent. The orchestrator agent
		// writes it after boot (instructed by buildOrchestratorBootPrompt).
		const markerPath = join(cwd, '.claude', '.cam-orch-ready');
		expect(existsSync(markerPath)).toBe(false);
	});

	it('does NOT write .cam-orch-ready on an existing session re-attach', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: true });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		const markerPath = join(cwd, '.claude', '.cam-orch-ready');
		expect(existsSync(markerPath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runRun auth preflight (US-002, CAM-82)
// ---------------------------------------------------------------------------

describe('runRun auth preflight', () => {
	it('returns non-zero, skips session creation, and does not spawn the sidecar on auth failure', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false, claudeAuth: 'notLoggedIn' });

		let sidecarSpawned = false;
		const spawnSidecarFn: SpawnSidecarFn = () => {
			sidecarSpawned = true;
			return { pid: 0, kill: () => {} };
		};

		const code = runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn, spawnWatcherFn: noopWatcher });

		// Non-zero exit on auth failure.
		expect(code).not.toBe(0);
		// spawnSidecarFn must NOT be called: the session-setup path was short-circuited.
		expect(sidecarSpawned).toBe(false);
		// No tmux session or pane creation should have been attempted.
		expect(spawn.calls.find(c => c.args[2] === 'new-session')).toBeUndefined();
		expect(spawn.calls.find(c => c.args[2] === 'split-window')).toBeUndefined();
	});

	it('returns non-zero when the auth probe exits with non-zero status', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false, claudeAuth: 'error' });

		const code = runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		expect(code).not.toBe(0);
		expect(spawn.calls.find(c => c.args[2] === 'new-session')).toBeUndefined();
	});

	it('passes through to session creation when auth succeeds (regression guard for existing tests)', () => {
		const cwd = makeTmpProject();
		// claudeAuth defaults to 'loggedIn' — normal happy path.
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		const code = runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		expect(code).toBe(0);
		expect(spawn.calls.find(c => c.args[2] === 'new-session')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// runRun: sidecar spawn (US-FIX-002)
// ---------------------------------------------------------------------------

describe('runRun sidecar spawn (US-FIX-002)', () => {
	it('spawns the sidecar when a new session is created and --no-attach is passed', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		let sidecarCwd: string | undefined;
		let sidecarLogPath: string | undefined;
		const fakeSidecar = { pid: 0, kill: () => {} };
		const spawnSidecarFn = (c: string, l: string) => {
			sidecarCwd = c;
			sidecarLogPath = l;
			return fakeSidecar;
		};

		const code = runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn, spawnWatcherFn: noopWatcher });

		expect(code).toBe(0);
		expect(sidecarCwd).toBe(cwd);
		expect(sidecarLogPath).toContain('.claude');
		expect(sidecarLogPath).toContain('cam-supervisor.log');
	});

	it('does NOT spawn the sidecar when an existing session is attached', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: true });

		let sidecarSpawnCalled = false;
		const spawnSidecarFn = (_c: string, _l: string) => {
			sidecarSpawnCalled = true;
			return { pid: 0, kill: () => {} };
		};

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn, spawnWatcherFn: noopWatcher });

		expect(sidecarSpawnCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runRun: recycle watcher spawn (US-004)
// ---------------------------------------------------------------------------

describe('runRun recycle watcher spawn (US-004)', () => {
	it('spawns the recycle watcher when a new session is created', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		let watcherCwd: string | undefined;
		let watcherLogPath: string | undefined;
		const spawnWatcherFn: SpawnWatcherFn = (c: string, l: string) => {
			watcherCwd = c;
			watcherLogPath = l;
			return { pid: 0, kill: () => {} };
		};

		const code = runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn });

		expect(code).toBe(0);
		expect(watcherCwd).toBe(cwd);
		expect(watcherLogPath).toContain('.claude');
		expect(watcherLogPath).toContain('cam-recycle-watcher.log');
	});

	it('does NOT spawn the recycle watcher when an existing session is attached', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: true });

		let watcherSpawnCalled = false;
		const spawnWatcherFn: SpawnWatcherFn = (_c: string, _l: string) => {
			watcherSpawnCalled = true;
			return { pid: 0, kill: () => {} };
		};

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn });

		expect(watcherSpawnCalled).toBe(false);
	});

	// US-002 tests -----------------------------------------------------------

	it('clears a stale .cam-orch-recycle marker on a newly created session (US-002)', () => {
		const cwd = makeTmpProject();
		const dotClaude = join(cwd, '.claude');
		mkdirSync(dotClaude, { recursive: true });
		const recycleMarker = join(dotClaude, ORCH_RECYCLE_MARKER);
		writeFileSync(recycleMarker, '', 'utf8');
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		// The stale marker must be removed before the watcher starts.
		expect(existsSync(recycleMarker)).toBe(false);
	});

	it('stale marker is absent when spawnWatcherFn is invoked (ordering, US-002)', () => {
		const cwd = makeTmpProject();
		const dotClaude = join(cwd, '.claude');
		mkdirSync(dotClaude, { recursive: true });
		const recycleMarker = join(dotClaude, ORCH_RECYCLE_MARKER);
		writeFileSync(recycleMarker, '', 'utf8');
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		let markerExistsAtWatcherSpawn: boolean | undefined;
		const spawnWatcherFn: SpawnWatcherFn = (_c: string, _l: string) => {
			// The cleanup must have run before this is called.
			markerExistsAtWatcherSpawn = existsSync(recycleMarker);
			return { pid: 0, kill: () => {} };
		};

		runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn });

		expect(markerExistsAtWatcherSpawn).toBe(false);
	});

	it('no-marker boot is a silent no-op (idempotent, US-002)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });

		// No marker written - should not throw and should succeed.
		const code = runRun({ cwd, noAttach: true, spawnFn: spawn, spawnSidecarFn: noopSidecar, spawnWatcherFn: noopWatcher });

		expect(code).toBe(0);
		expect(existsSync(join(cwd, '.claude', ORCH_RECYCLE_MARKER))).toBe(false);
	});
});
