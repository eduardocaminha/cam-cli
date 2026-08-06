// test/commands/run-model-resolution.test.ts
//
// Unit tests for US-007 (CAM-398): wiring `resolvePhaseModel` into the
// orchestrator dispatch site in src/commands/run.ts's `setupPanes`. This is
// the 4th (last) call site in the CAM-398 model-resolution wiring epic,
// mirroring US-004 (loop.ts), US-005 (plan-runner.ts) and US-006 (review.ts)'s
// conventions, adapted to run.ts's synchronous CLI setup path (no async
// escalateFn: the existing printError surfacing on `result.blocked` IS the
// escalation seam here).
//
// Coverage:
//   AC1: resolvePhaseModel is invoked at the readPhaseModel call site, before
//        the argv build (buildOrchestratorPaneCommand); codexAuthPreflight
//        keeps its position relative to that argv build (proven indirectly:
//        the codex-auth regression suite in run-codex-auth.test.ts still
//        passes unmodified, AC7).
//   AC2: the not-ok path returns the existing { blocked: true, message }
//        shape, surfaced via the pre-existing printError path in runRun; the
//        orchestrator pane is never respawned.
//   AC3: a codex-backed dispatch whose config carries only a claude-shaped
//        flat model, with an injected cache reader resolving 'gpt-5.6-sol',
//        spawns argv containing 'gpt-5.6-sol' and never the claude alias.
//   AC4: a not-ok resolution aborts before any spawn: actionable message,
//        the escalation seam (printError) fires, no respawn-pane recorded.
//   AC5: the cache reader reaches this site through an injectable option seam
//        (codexModelsCacheReaderFn) mirroring codexAuthCheckFn -- defaults to
//        the production reader when omitted, and a claude-backed dispatch
//        never invokes it.
//
// US-R1-001 (review round 1 fix): a model-resolution abort must surface under
// a distinct 'model resolution failed' headline, never the misleading 'codex
// auth preflight failed' wording the codexAuthPreflight abort path reuses
// (both aborts return the same { blocked: true; message } shape). See the
// AC2/AC4 test below.
//
// readBackend/readPhaseModel are not injectable through RunOptions; they
// always read scripts/cam/project.toml relative to process.cwd() (same
// constraint documented in run-codex-auth.test.ts), so every codex-backend
// test below stages a temp cwd via withCodexBackendCwd variants.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runRun, type SpawnSidecarFn, type SpawnWatcherFn } from '../../src/commands/run.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';
import type { CodexModelsCacheReader } from '../../src/config/codex-models-cache.ts';

// ---------------------------------------------------------------------------
// Fakes (mirror test/commands/run-codex-auth.test.ts's shape)
// ---------------------------------------------------------------------------

const noopSidecar: SpawnSidecarFn = () => ({ pid: 0, kill: () => {} });
const noopWatcher: SpawnWatcherFn = () => ({ pid: 0, kill: () => {} });
const alwaysAuthenticated = () => ({ authenticated: true });

interface SpawnRecord {
	cmd: string;
	args: string[];
}

/**
 * Minimal fake spawn: tmux is available, no existing session, claude auth
 * status always reports logged in (so the 1b claude-auth preflight never
 * blocks these orchestrator-dispatch tests), new-session/split-window return
 * stable pane ids.
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
	const cwd = createTestTmpdir('cam-run-model-resolution-');
	const agentsDir = join(cwd, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# stub\n', 'utf8');
	return cwd;
}

/**
 * Stage a temp cwd resolving the orchestrator backend to 'codex' with a
 * claude-SHAPED flat model (so the flat `[models]` pin is rejected and
 * resolution falls through to the injectable cache reader), chdir into it
 * (readBackend does accept a configPath argument, src/config/models.ts:224,
 * but this call site relies on its process.cwd()-derived default instead of
 * forwarding one), and restore afterward.
 */
function withClaudeShapedCodexCwd<T>(fn: (cwd: string) => T): T {
	const cwd = makeTmpProject();
	const camDir = join(cwd, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });
	writeFileSync(
		join(camDir, 'project.toml'),
		'backend = "codex"\n\n[models]\norchestrator = "sonnet"\n',
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

function captureStderr(fn: () => void): string {
	const originalWrite = process.stderr.write.bind(process.stderr);
	let out = '';
	process.stderr.write = ((chunk: string) => {
		out += chunk;
		return true;
	}) as typeof process.stderr.write;
	try {
		fn();
	} finally {
		process.stderr.write = originalWrite;
	}
	return out;
}

// ---------------------------------------------------------------------------
// AC3: claude-shaped flat model on a codex backend resolves via the injected
// cache reader; the resolved slug reaches the respawned orchestrator argv,
// never the claude alias.
// ---------------------------------------------------------------------------

describe('run.ts model resolution: AC3 - injected cache reader resolves the dispatched slug', () => {
	test('codex-backed dispatch with a claude-shaped flat model spawns argv containing the resolved slug, never the claude alias', () => {
		withClaudeShapedCodexCwd((cwd) => {
			const spawn = makeFakeSpawn();
			let cacheReaderCalled = false;

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				codexAuthCheckFn: alwaysAuthenticated,
				codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
					cacheReaderCalled = true;
					return { ok: true, slug: 'gpt-5.6-sol' };
				},
			});

			expect(code).toBe(0);
			expect(cacheReaderCalled).toBe(true);
			const orchRespawn = findOrchRespawn(spawn.calls);
			expect(orchRespawn).toBeDefined();
			const dispatchedCmd = orchRespawn?.args[orchRespawn.args.length - 1] ?? '';
			expect(dispatchedCmd).toContain('gpt-5.6-sol');
			expect(dispatchedCmd).not.toMatch(/'sonnet'/);
			expect(dispatchedCmd).not.toMatch(/'opus'/);
		});
	});
});

// ---------------------------------------------------------------------------
// AC2 + AC4: a not-ok resolution aborts before any spawn.
// ---------------------------------------------------------------------------

describe('run.ts model resolution: AC2/AC4 - not-ok resolution aborts before spawn', () => {
	test('actionable message surfaces via printError (the escalation seam), no respawn-pane invocation recorded', () => {
		withClaudeShapedCodexCwd((cwd) => {
			const spawn = makeFakeSpawn();

			const stderrOutput = captureStderr(() => {
				const code = runRun({
					cwd,
					noAttach: true,
					spawnFn: spawn,
					spawnSidecarFn: noopSidecar,
					spawnWatcherFn: noopWatcher,
					codexAuthCheckFn: alwaysAuthenticated,
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => ({
						ok: false,
						reason: 'models_cache.json missing',
					}),
				});

				expect(code).not.toBe(0);
			});

			expect(stderrOutput).toContain('model-resolution-failed');
			expect(stderrOutput).toContain('models_cache.json missing');
			// US-R1-001 (review round 1 fix): the headline must NOT be the
			// misleading auth-preflight wording -- this is a config/model-pin
			// failure, not an unauthenticated codex CLI.
			expect(stderrOutput).toContain('model resolution failed');
			expect(stderrOutput).not.toContain('codex auth preflight failed');
			expect(findOrchRespawn(spawn.calls)).toBeUndefined();
			expect(findDashboardRespawn(spawn.calls)).toBeUndefined();
		});
	});

	test('does not spawn the sidecar or recycle watcher', () => {
		withClaudeShapedCodexCwd((cwd) => {
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
				codexAuthCheckFn: alwaysAuthenticated,
				codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => ({
					ok: false,
					reason: 'models_cache.json missing',
				}),
			});

			expect(sidecarSpawned).toBe(false);
			expect(watcherSpawned).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// AC5: injectable seam mirrors codexAuthCheckFn; defaults when absent;
// claude-backed dispatch never invokes it.
// ---------------------------------------------------------------------------

describe('run.ts model resolution: AC5 - injectable seam, default fallback, claude-backend bypass', () => {
	test('absent codexModelsCacheReaderFn on a codex dispatch with a non-claude-shaped pin never crashes (falls back to the production reader)', () => {
		const cwd = makeTmpProject();
		const camDir = join(cwd, 'scripts', 'cam');
		mkdirSync(camDir, { recursive: true });
		writeFileSync(
			join(camDir, 'project.toml'),
			'backend = "codex"\n\n[models.codex]\norchestrator = "gpt-5-codex"\n',
			'utf8',
		);
		const prevCwd = process.cwd();
		process.chdir(cwd);
		try {
			const spawn = makeFakeSpawn();

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				codexAuthCheckFn: alwaysAuthenticated,
				// codexModelsCacheReaderFn intentionally absent
			});

			expect(code).toBe(0);
			expect(findOrchRespawn(spawn.calls)).toBeDefined();
		} finally {
			process.chdir(prevCwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('claude-backed dispatch (repo default project.toml) never invokes the injected cacheReader', () => {
		// No chdir/fixture: this repo's own scripts/cam/project.toml resolves the
		// orchestrator backend to 'claude' by default.
		const cwd = makeTmpProject();
		try {
			const spawn = makeFakeSpawn();
			let cacheReaderCalled = false;

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				codexAuthCheckFn: alwaysAuthenticated,
				codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
					cacheReaderCalled = true;
					return { ok: true, slug: 'gpt-5.6-sol' };
				},
			});

			expect(code).toBe(0);
			expect(findOrchRespawn(spawn.calls)).toBeDefined();
			expect(cacheReaderCalled).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
