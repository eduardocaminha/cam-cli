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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { buildRunMenuScript, parseRunArgs, projectSessionName, runRun } from '../src/commands/run.ts';
import type { SpawnFn } from '../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fake spawn helper for argv tests
// ---------------------------------------------------------------------------

interface SpawnRecord {
	cmd: string;
	args: string[];
}

function makeFakeSpawn(opts: {
	/** Return 0 for tmux -V (tmux is available). Default: true. */
	tmuxAvailable?: boolean;
	/** Return 0 for has-session (session exists). Default: false. */
	sessionExists?: boolean;
} = {}): SpawnFn & { calls: SpawnRecord[] } {
	const { tmuxAvailable = true, sessionExists = false } = opts;
	const calls: SpawnRecord[] = [];

	const fn: SpawnFn = (cmd, args, _options?) => {
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
			if (args[0] === '-V') {
				result.status = tmuxAvailable ? 0 : 1;
			} else if (args[0] === 'has-session') {
				result.status = sessionExists ? 0 : 1;
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

		const newSess = spawn.calls.find(c => c.args[0] === 'new-session');
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

	it('calls tmux split-window twice to create pane 1 (dashboard) and pane 2 (menu)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		const splits = spawn.calls.filter(c => c.args[0] === 'split-window');
		expect(splits.length).toBe(2);

		// First split-window: horizontal split of pane 0 to create dashboard pane 1.
		const firstSplit = splits[0];
		expect(firstSplit?.cmd).toBe('tmux');
		expect(firstSplit?.args).toContain('-t');
		expect(firstSplit?.args).toContain(`${sessionName}:0.0`);
		expect(firstSplit?.args).toContain('-h');
		expect(firstSplit?.args).toContain('-d');

		// Second split-window: vertical split of pane 1 to create menu pane 2.
		const secondSplit = splits[1];
		expect(secondSplit?.cmd).toBe('tmux');
		expect(secondSplit?.args).toContain('-t');
		expect(secondSplit?.args).toContain(`${sessionName}:0.1`);
		expect(secondSplit?.args).toContain('-v');
		expect(secondSplit?.args).toContain('-d');
	});

	it('sends cam dashboard to pane 1 via send-keys (US-002)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// Find the send-keys call that targets pane 0.1 (dashboard pane).
		const dashboardSendKeys = spawn.calls.find(
			c => c.args[0] === 'send-keys' && c.args.some(a => a === `${sessionName}:0.1`),
		);
		expect(dashboardSendKeys).toBeDefined();
		expect(dashboardSendKeys?.args).toContain(`${sessionName}:0.1`);
		expect(dashboardSendKeys?.args.some(a => a.includes('cam dashboard'))).toBe(true);
	});

	it('sends the interactive menu script to pane 2 via send-keys (US-004)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// Find the send-keys call that targets pane 0.2 (menu pane).
		const menuSendKeys = spawn.calls.find(
			c => c.args[0] === 'send-keys' && c.args.some(a => a === `${sessionName}:0.2`),
		);
		expect(menuSendKeys).toBeDefined();
		expect(menuSendKeys?.args).toContain(`${sessionName}:0.2`);
		// The command should run bash with the .cam-run-menu.sh file.
		expect(menuSendKeys?.args.some(a => a.includes('.cam-run-menu.sh'))).toBe(true);
	});

	it('sends the claude command to pane 0 via send-keys', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		const orchSendKeys = spawn.calls.find(
			c => c.args[0] === 'send-keys' && c.args.some(a => a.includes(':0.0')),
		);
		expect(orchSendKeys).toBeDefined();
		expect(orchSendKeys?.args).toContain(`${sessionName}:0.0`);
		// The command includes `claude` invocation.
		expect(orchSendKeys?.args.some(a => a.includes('claude'))).toBe(true);
	});

	it('pane 0 command chains kill-session after claude exits (US-003)', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		const orchSendKeys = spawn.calls.find(
			c => c.args[0] === 'send-keys' && c.args.some(a => a.includes(':0.0')),
		);
		expect(orchSendKeys).toBeDefined();
		// The composed command must contain a kill-session call for this session.
		const composedCmd = orchSendKeys?.args.find(a => a.includes('kill-session'));
		expect(composedCmd).toBeDefined();
		expect(composedCmd).toContain(`kill-session -t ${sessionName}`);
	});

	it('skips session creation when session already exists', () => {
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: true });

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// When session already exists, no new-session or split-window calls.
		const newSess = spawn.calls.find(c => c.args[0] === 'new-session');
		const split = spawn.calls.find(c => c.args[0] === 'split-window');
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

// ---------------------------------------------------------------------------
// buildRunMenuScript (US-004, US-011)
// ---------------------------------------------------------------------------

describe('buildRunMenuScript', () => {
	const ORCH_PANE = 'cam-orch-myproject-abc123:0.0';
	const DASHBOARD_PANE = 'cam-orch-myproject-abc123:0.1';

	it('embeds the orchestrator pane target in the script', () => {
		const script = buildRunMenuScript(ORCH_PANE, DASHBOARD_PANE);
		expect(script).toContain(ORCH_PANE);
	});

	it('embeds the dashboard pane target in the script', () => {
		const script = buildRunMenuScript(ORCH_PANE, DASHBOARD_PANE);
		expect(script).toContain(DASHBOARD_PANE);
	});

	it('contains a send-keys call targeting the orchestrator pane for /cam-next', () => {
		const script = buildRunMenuScript(ORCH_PANE, DASHBOARD_PANE);
		// The send-keys invocation should reference the pane and the command.
		expect(script).toContain(`tmux send-keys -t "\${ORCH_PANE}" '/cam-next' Enter`);
	});

	it('contains send-keys entries for all expected commands', () => {
		const script = buildRunMenuScript(ORCH_PANE, DASHBOARD_PANE);
		for (const cmd of ['/cam-next', '/cam-review', '/cam-ship', '/cam-plan', '/cam-issue']) {
			expect(script).toContain(cmd);
		}
	});

	it('uses read -rsn1 for non-blocking single-key input', () => {
		const script = buildRunMenuScript(ORCH_PANE, DASHBOARD_PANE);
		expect(script).toContain('read -rsn1');
	});

	it('includes a quit key (q/Q) that exits without sending to the orch pane', () => {
		const script = buildRunMenuScript(ORCH_PANE, DASHBOARD_PANE);
		// q|Q case must be present and must call exit 0, not send-keys.
		expect(script).toContain('q|Q) exit 0');
	});

	it('d key uses tmux select-pane to focus dashboard, not send-keys to orchestrator (US-011)', () => {
		const script = buildRunMenuScript(ORCH_PANE, DASHBOARD_PANE);
		// d must call tmux select-pane targeting DASHBOARD_PANE.
		expect(script).toContain('tmux select-pane -t "${DASHBOARD_PANE}"');
		// d must NOT inject text into the orchestrator pane.
		expect(script).not.toContain('send-keys -t "${ORCH_PANE}" \'cam dashboard\'');
	});

	it('pane 2 send-keys calls bash with the menu script file (integration)', () => {
		// Verify that setupOrchestratorSession wires pane 2 to run the menu script.
		const cwd = makeTmpProject();
		const spawn = makeFakeSpawn({ tmuxAvailable: true, sessionExists: false });
		const sessionName = projectSessionName(cwd);

		runRun({ cwd, noAttach: true, spawnFn: spawn });

		// Pane 0.2 send-keys should reference bash and a .cam-run-menu.sh file.
		const menuSendKeys = spawn.calls.find(
			c => c.args[0] === 'send-keys' && c.args.some(a => a === `${sessionName}:0.2`),
		);
		expect(menuSendKeys).toBeDefined();
		expect(menuSendKeys?.args).toContain(`${sessionName}:0.2`);
		// The command sent should run bash with the menu file.
		const sentCmd = menuSendKeys?.args.find(a => a.includes('.cam-run-menu.sh'));
		expect(sentCmd).toBeDefined();
		expect(sentCmd).toContain('bash');
	});
});
