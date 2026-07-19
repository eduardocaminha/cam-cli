// test/commands/run-codex-auth.test.ts
//
// Unit tests for the codex auth preflight seam wired into run.ts's
// orchestrator dispatch (US-003, CAM-352): fail-closed codexAuthPreflight
// runs immediately before the orchestrator respawn-pane call, the 4th and
// final worker-dispatch site (mirrors the 3 supervisor sites wired in
// US-002).
//
// Acceptance criteria proved:
//   AC2: backend=codex + unauthenticated -> halts bootstrap with an
//        actionable error naming `codex login`, never respawns the
//        orchestrator (or dashboard) pane.
//   AC3: backend=codex + authenticated -> dispatch proceeds unchanged.
//   AC4: backend=claude -> codexAuthCheckFn never invoked, dispatch
//        byte-identical.
//
// readBackend/readPhaseModel are not injectable through RunOptions; they
// always read scripts/cam/project.toml relative to process.cwd() (same
// constraint documented in plan-runner-codex-auth.test.ts), so every
// codex-backend test below stages a temp cwd via withCodexBackendCwd.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runRun, type SpawnSidecarFn, type SpawnWatcherFn } from '../../src/commands/run.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fakes (mirror test/run.test.ts's noopSidecar/noopWatcher/makeFakeSpawn shape)
// ---------------------------------------------------------------------------

const noopSidecar: SpawnSidecarFn = () => ({ pid: 0, kill: () => {} });
const noopWatcher: SpawnWatcherFn = () => ({ pid: 0, kill: () => {} });

interface SpawnRecord {
	cmd: string;
	args: string[];
}

/**
 * Minimal fake spawn: tmux is available, no existing session, claude auth
 * status always reports logged in (so the 1b claude-auth preflight never
 * blocks these codex-orchestrator-dispatch tests), new-session/split-window
 * return stable pane ids.
 */
function makeFakeSpawn(): SpawnFn & { calls: SpawnRecord[] } {
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

		if (cmd === 'claude') {
			result.stdout = Buffer.from(JSON.stringify({ loggedIn: true }));
		}

		if (cmd === 'tmux') {
			const subcommand = args[0] === '-L' ? args[2] : args[0];
			if (subcommand === '-V') {
				result.status = 0;
			} else if (subcommand === 'has-session') {
				result.status = 1; // no existing session
			} else if (
				(subcommand === 'new-session' || subcommand === 'split-window') &&
				options?.stdio === 'pipe'
			) {
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
	const cwd = mkdtempSync(join(tmpdir(), 'cam-run-codex-auth-'));
	const agentsDir = join(cwd, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# stub\n', 'utf8');
	return cwd;
}

/**
 * Stage a temp cwd resolving the orchestrator backend to 'codex' with a
 * non-claude-alias model, chdir into it (readBackend/readPhaseModel read
 * from process.cwd(), never an injected path), and restore afterward.
 */
function withCodexBackendCwd<T>(fn: (cwd: string) => T): T {
	const cwd = makeTmpProject();
	const camDir = join(cwd, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });
	writeFileSync(
		join(camDir, 'project.toml'),
		'backend = "codex"\n\n[models]\norchestrator = "gpt-5-codex"\n',
		'utf8',
	);
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		return fn(cwd);
	} finally {
		process.chdir(prevCwd);
		rmSync(cwd, { recursive: true, force: true });
	}
}

function findOrchRespawn(calls: SpawnRecord[]): SpawnRecord | undefined {
	return calls.find((c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a === '%1'));
}

function findDashboardRespawn(calls: SpawnRecord[]): SpawnRecord | undefined {
	return calls.find((c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a === '%2'));
}

// ---------------------------------------------------------------------------
// AC2: backend=codex + unauthenticated -> fail-closed halt
// ---------------------------------------------------------------------------

describe('run.ts codex auth preflight: AC2 - fail-closed on unauthenticated', () => {
	test('returns non-zero and never respawns the orchestrator pane', () => {
		withCodexBackendCwd((cwd) => {
			const spawn = makeFakeSpawn();

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				codexAuthCheckFn: () => ({ authenticated: false }),
			});

			expect(code).not.toBe(0);
			expect(findOrchRespawn(spawn.calls)).toBeUndefined();
		});
	});

	test('never respawns the dashboard pane either', () => {
		withCodexBackendCwd((cwd) => {
			const spawn = makeFakeSpawn();

			runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				codexAuthCheckFn: () => ({ authenticated: false }),
			});

			expect(findDashboardRespawn(spawn.calls)).toBeUndefined();
		});
	});

	test('does not spawn the sidecar or recycle watcher', () => {
		withCodexBackendCwd((cwd) => {
			const spawn = makeFakeSpawn();
			let sidecarSpawned = false;
			let watcherSpawned = false;

			runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: () => {
					sidecarSpawned = true;
					return { pid: 0, kill: () => {} };
				},
				spawnWatcherFn: () => {
					watcherSpawned = true;
					return { pid: 0, kill: () => {} };
				},
				codexAuthCheckFn: () => ({ authenticated: false }),
			});

			expect(sidecarSpawned).toBe(false);
			expect(watcherSpawned).toBe(false);
		});
	});

	test('the printed error names `codex login`', () => {
		withCodexBackendCwd((cwd) => {
			const spawn = makeFakeSpawn();
			const originalWrite = process.stderr.write.bind(process.stderr);
			let stderrOutput = '';
			process.stderr.write = ((chunk: string) => {
				stderrOutput += chunk;
				return true;
			}) as typeof process.stderr.write;

			try {
				runRun({
					cwd,
					noAttach: true,
					spawnFn: spawn,
					spawnSidecarFn: noopSidecar,
					spawnWatcherFn: noopWatcher,
					codexAuthCheckFn: () => ({ authenticated: false }),
				});
			} finally {
				process.stderr.write = originalWrite;
			}

			expect(stderrOutput).toContain('codex login');
		});
	});
});

// ---------------------------------------------------------------------------
// AC3: backend=codex + authenticated -> proceeds unchanged
// ---------------------------------------------------------------------------

describe('run.ts codex auth preflight: AC3 - authenticated proceeds unchanged', () => {
	test('respawns both the orchestrator and dashboard pane, returns 0', () => {
		withCodexBackendCwd((cwd) => {
			const spawn = makeFakeSpawn();

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				codexAuthCheckFn: () => ({ authenticated: true }),
			});

			expect(code).toBe(0);
			expect(findOrchRespawn(spawn.calls)).toBeDefined();
			expect(findDashboardRespawn(spawn.calls)).toBeDefined();
		});
	});
});

// ---------------------------------------------------------------------------
// AC4: backend=claude -> codexAuthCheckFn never invoked
// ---------------------------------------------------------------------------

describe('run.ts codex auth preflight: AC4 - claude backend never invokes codexAuthCheckFn', () => {
	test('claude backend (repo default project.toml) -> auth-check never called, dispatch unchanged', () => {
		// No withCodexBackendCwd: this repo's own scripts/cam/project.toml
		// resolves the orchestrator backend to 'claude' by default.
		const cwd = makeTmpProject();
		try {
			const spawn = makeFakeSpawn();
			let authCheckCalled = false;

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				codexAuthCheckFn: () => {
					authCheckCalled = true;
					return { authenticated: false };
				},
			});

			expect(authCheckCalled).toBe(false);
			expect(code).toBe(0);
			expect(findOrchRespawn(spawn.calls)).toBeDefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('absent codexAuthCheckFn + claude backend -> unaffected (backward compat)', () => {
		const cwd = makeTmpProject();
		try {
			const spawn = makeFakeSpawn();

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
			});

			expect(code).toBe(0);
			expect(findOrchRespawn(spawn.calls)).toBeDefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
