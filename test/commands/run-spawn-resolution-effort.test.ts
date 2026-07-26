// test/commands/run-spawn-resolution-effort.test.ts
//
// Unit test for US-002 (CAM-425) AC4: the initial-spawn emitSpawnResolution
// call in setupPanes (run.ts) includes the resolved effort in its detail,
// using the optional `effort` field SpawnResolutionEvent gained in US-001.
//
// The event is asserted from the REAL file it is written to
// (.claude/cam-worker-events.jsonl under the run cwd), not an injected
// in-memory sink: emitSpawnResolution's writeEvent callback in setupPanes is
// wired straight to makeFileEventLogger with no test seam of its own, so
// reading the file back is the only way to observe the emitted event.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runRun, type SpawnSidecarFn, type SpawnWatcherFn } from '../../src/commands/run.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';
import type { SpawnResolutionEvent } from '../../src/logging/spawn-resolution.ts';

const noopSidecar: SpawnSidecarFn = () => ({ pid: 0, kill: () => {} });
const noopWatcher: SpawnWatcherFn = () => ({ pid: 0, kill: () => {} });

function makeFakeSpawn(): SpawnFn {
	let paneCounter = 0;
	return (cmd, args, options?) => {
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
				result.status = 1;
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
}

function makeTmpProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-run-spawn-resolution-effort-'));
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

/** Read back the FIRST 'spawn-resolution' event line for phase 'orchestrator'. */
function readOrchestratorSpawnResolutionEvent(cwd: string): SpawnResolutionEvent | undefined {
	const eventsPath = join(cwd, '.claude', 'cam-worker-events.jsonl');
	const raw = readFileSync(eventsPath, 'utf8');
	for (const line of raw.split('\n')) {
		if (line.trim() === '') continue;
		const event = JSON.parse(line) as WorkerEvent;
		if (event.kind === 'spawn-resolution') {
			const detail = event.detail as SpawnResolutionEvent;
			if (detail.phase === 'orchestrator') return detail;
		}
	}
	return undefined;
}

describe('run.ts emitSpawnResolution: AC4 - resolved effort in event detail (US-002, CAM-425)', () => {
	test('a staged config effort reaches the spawn-resolution event detail when the capability probe is supported', () => {
		const cwd = makeTmpProject();
		const stageDir = mkdtempSync(join(tmpdir(), 'cam-run-spawn-resolution-effort-stage-'));
		try {
			const configPath = stageEffortConfig(stageDir, 'medium');

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: makeFakeSpawn(),
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				configPath,
				effortSupportCheckFn: () => true,
			});

			expect(code).toBe(0);
			const detail = readOrchestratorSpawnResolutionEvent(cwd);
			expect(detail).toBeDefined();
			expect(detail?.effort).toBe('medium');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(stageDir, { recursive: true, force: true });
		}
	});

	test('the resolved effort is still recorded in the event even when the capability gate omits it from the argv', () => {
		const cwd = makeTmpProject();
		const stageDir = mkdtempSync(join(tmpdir(), 'cam-run-spawn-resolution-effort-stage2-'));
		try {
			const configPath = stageEffortConfig(stageDir, 'medium');

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: makeFakeSpawn(),
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				configPath,
				effortSupportCheckFn: () => false,
			});

			expect(code).toBe(0);
			const detail = readOrchestratorSpawnResolutionEvent(cwd);
			expect(detail).toBeDefined();
			// The audit trail always records what config RESOLVED to, independent
			// of whether the argv itself could carry it (capability degradation).
			expect(detail?.effort).toBe('medium');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(stageDir, { recursive: true, force: true });
		}
	});
});
