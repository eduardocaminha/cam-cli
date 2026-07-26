// test/commands/run-effort-argv.test.ts
//
// Unit tests for US-002 (CAM-425): resolving effort via
// readPhaseEffort('orchestrator', configPath) into the orchestrator claude
// argv, and the injectable --effort capability-degradation gate.
//
// Coverage:
//   AC2: a staged config with efforts.orchestrator='max' produces
//        `--effort 'max'` in the dispatched argv even though
//        EFFORT_DEFAULTS.orchestrator is 'xhigh' (config wins).
//   AC3: both capability branches (supported -> flag present; unsupported ->
//        flag absent + an observable one-line warning) are exercised via the
//        injectable effortSupportCheckFn seam, with no real claude process
//        ever spawned to answer the capability question.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runRun, type SpawnSidecarFn, type SpawnWatcherFn } from '../../src/commands/run.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';

const noopSidecar: SpawnSidecarFn = () => ({ pid: 0, kill: () => {} });
const noopWatcher: SpawnWatcherFn = () => ({ pid: 0, kill: () => {} });

interface SpawnRecord {
	cmd: string;
	args: string[];
}

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

function makeTmpProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-run-effort-argv-'));
	const agentsDir = join(cwd, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# stub\n', 'utf8');
	return cwd;
}

function stageEffortConfig(dir: string, effort: string): string {
	const configPath = join(dir, 'staged-project.toml');
	writeFileSync(configPath, `[efforts]\norchestrator = "${effort}"\n`, 'utf8');
	return configPath;
}

function findOrchRespawn(calls: SpawnRecord[]): SpawnRecord | undefined {
	return calls.find((c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a === '%1'));
}

function captureStdout(fn: () => void): string {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let out = '';
	process.stdout.write = ((chunk: string) => {
		out += chunk;
		return true;
	}) as typeof process.stdout.write;
	try {
		fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return out;
}

// ---------------------------------------------------------------------------
// AC2: config wins over EFFORT_DEFAULTS.
// ---------------------------------------------------------------------------

describe('run.ts effort resolution: AC2 - config wins over EFFORT_DEFAULTS', () => {
	test("staged efforts.orchestrator='max' reaches the argv as --effort 'max' though the default is 'xhigh'", () => {
		const cwd = makeTmpProject();
		const stageDir = mkdtempSync(join(tmpdir(), 'cam-run-effort-argv-stage-'));
		try {
			const configPath = stageEffortConfig(stageDir, 'max');
			const spawn = makeFakeSpawn();

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				configPath,
				effortSupportCheckFn: () => true,
			});

			expect(code).toBe(0);
			const orchRespawn = findOrchRespawn(spawn.calls);
			const dispatchedCmd = orchRespawn?.args[orchRespawn.args.length - 1] ?? '';
			// US-003 (CAM-425): effort is a seeded bash variable re-resolved per
			// respawn, so the resolved value appears in the seed assignment while
			// the claude invocation reads it live ("$effort").
			expect(dispatchedCmd).toContain(`effort='max'`);
			expect(dispatchedCmd).toContain(`--effort "$effort"`);
			expect(dispatchedCmd).not.toContain(`effort='xhigh'`);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(stageDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// AC3: capability-degradation gate, both branches.
// ---------------------------------------------------------------------------

describe('run.ts effort resolution: AC3 - capability-degradation gate', () => {
	test('supported build: --effort is present in the dispatched argv, no warning printed', () => {
		const cwd = makeTmpProject();
		try {
			const spawn = makeFakeSpawn();
			let probeCalled = false;

			const stdout = captureStdout(() => {
				const code = runRun({
					cwd,
					noAttach: true,
					spawnFn: spawn,
					spawnSidecarFn: noopSidecar,
					spawnWatcherFn: noopWatcher,
					effortSupportCheckFn: () => {
						probeCalled = true;
						return true;
					},
				});
				expect(code).toBe(0);
			});

			expect(probeCalled).toBe(true);
			const orchRespawn = findOrchRespawn(spawn.calls);
			const dispatchedCmd = orchRespawn?.args[orchRespawn.args.length - 1] ?? '';
			expect(dispatchedCmd).toContain('--effort');
			expect(stdout).not.toContain('does not support --effort');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('unsupported build: --effort is OMITTED entirely, and an observable one-line warning is printed', () => {
		const cwd = makeTmpProject();
		try {
			const spawn = makeFakeSpawn();
			let probeCalled = false;

			const stdout = captureStdout(() => {
				const code = runRun({
					cwd,
					noAttach: true,
					spawnFn: spawn,
					spawnSidecarFn: noopSidecar,
					spawnWatcherFn: noopWatcher,
					effortSupportCheckFn: () => {
						probeCalled = true;
						return false;
					},
				});
				expect(code).toBe(0);
			});

			expect(probeCalled).toBe(true);
			const orchRespawn = findOrchRespawn(spawn.calls);
			const dispatchedCmd = orchRespawn?.args[orchRespawn.args.length - 1] ?? '';
			expect(dispatchedCmd).not.toContain('--effort');
			expect(stdout).toContain('does not support --effort');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('the capability probe never spawns a real claude process (fake spawn records the --help call, no assumption on its own answer)', () => {
		const cwd = makeTmpProject();
		try {
			const spawn = makeFakeSpawn();

			runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				// effortSupportCheckFn intentionally absent: exercises the real
				// production default (checkClaudeEffortSupport), which must route
				// its own probe through the injected spawnFn rather than spawning
				// a genuinely separate `claude` process.
			});

			const helpCall = spawn.calls.find(
				(c) => c.cmd === 'claude' && c.args.includes('--help'),
			);
			expect(helpCall).toBeDefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
