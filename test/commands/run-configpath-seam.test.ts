// test/commands/run-configpath-seam.test.ts
//
// Unit tests for US-002 (CAM-425): the injectable `configPath` seam at the
// run.ts orchestrator resolution site (setupPanes), mirroring the CAM-405
// seam on MakeReviewDispatchOptions.configPath (src/supervisor/review.ts).
//
// Coverage:
//   AC1: readBackend, resolvePhaseModel AND readPhaseEffort at the setupPanes
//        resolution site all honor an injected configPath pointing at a
//        STAGED temp project.toml, never the live scripts/cam/project.toml
//        or the process cwd's project.toml -- proven by staging a
//        non-default orchestrator model AND effort and asserting the built
//        claude argv (captured via the fake-spawn seam) carries BOTH staged
//        values.

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

/** Mirrors test/commands/run-model-resolution.test.ts's makeFakeSpawn shape. */
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

/** Build a temp project dir with the required .claude/agents/subagent-orchestrator.md. */
function makeTmpProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-run-configpath-seam-'));
	const agentsDir = join(cwd, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# stub\n', 'utf8');
	return cwd;
}

/**
 * Stage a temp project.toml at a location OUTSIDE the project cwd, with a
 * non-default orchestrator model and effort. Neither value matches
 * DEFAULTS.orchestrator ('opus') nor EFFORT_DEFAULTS.orchestrator ('xhigh'),
 * so a passing assertion proves the injected configPath -- not the cwd's own
 * (nonexistent) project.toml or the repo's live one -- drove resolution.
 */
function stageConfig(dir: string, model: string, effort: string): string {
	const configPath = join(dir, 'staged-project.toml');
	writeFileSync(
		configPath,
		`[models]\norchestrator = "${model}"\n\n[efforts]\norchestrator = "${effort}"\n`,
		'utf8',
	);
	return configPath;
}

function findOrchRespawn(calls: SpawnRecord[]): SpawnRecord | undefined {
	return calls.find((c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a === '%1'));
}

describe('run.ts configPath seam (US-002, CAM-425)', () => {
	test('a staged configPath (separate from cwd) drives model AND effort resolution', () => {
		const cwd = makeTmpProject();
		const stageDir = mkdtempSync(join(tmpdir(), 'cam-run-configpath-stage-'));
		try {
			const configPath = stageConfig(stageDir, 'haiku', 'medium');
			const spawn = makeFakeSpawn();

			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				configPath,
				// Deterministic capability probe: this test proves the configPath
				// seam, not the capability gate (covered in run-effort-argv.test.ts).
				effortSupportCheckFn: () => true,
			});

			expect(code).toBe(0);
			const orchRespawn = findOrchRespawn(spawn.calls);
			expect(orchRespawn).toBeDefined();
			const dispatchedCmd = orchRespawn?.args[orchRespawn.args.length - 1] ?? '';
			expect(dispatchedCmd).toContain(`--model 'haiku'`);
			expect(dispatchedCmd).toContain(`--effort 'medium'`);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(stageDir, { recursive: true, force: true });
		}
	});
});
