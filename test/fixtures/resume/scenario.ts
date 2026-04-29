// test/fixtures/resume/scenario.ts
//
// Scenario builders for US-014 — `ralph resume` 4-mode tests (Scope E).
//
// Each acceptance criterion describes a recovery scenario in plain English
// ("operator typed mid-loop", "terminal closed / OS rebooted", "hard-kill
// orphan", "rate-limit sleep killed mid-window"). The classification logic in
// `src/commands/resume.ts § classifyResumeMode` is already covered by the
// pre-existing 51 tests in `test/resume.test.ts`. What US-014 adds is a thin
// scenario layer on top: a tmpdir that LOOKS like the world after each
// failure mode (state file on disk, optional PRD on disk, faked process
// table), so the integration `runResume(...)` end-to-end produces the
// documented action.
//
// Discipline:
//   - Every helper returns the absolute path to the tmpdir it built. Tests
//     own the lifecycle (rmSync in `finally`).
//   - Process state is mocked via `SpawnSyncFn` + `KillFn` injection — never
//     real PIDs. The "mocked process table" requirement in the AC is
//     satisfied entirely by the helpers in this file plus the injected
//     `runResume` deps.
//   - Fixtures emit YAML state files in the exact shape the plugin writes —
//     `active`, `iteration`, optional `pid` — so the readers under test
//     parse them as production would.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import type { KillFn, SpawnSyncFn } from '../../../src/commands/resume.ts';

// --- Time anchors ----------------------------------------------------------

/**
 * The "now" anchor every scenario test uses. Picked once so commit-age math
 * stays deterministic across the suite. Mid-2026 to keep the dates plausible
 * relative to the project's actual timestamps.
 */
export const NOW = new Date('2026-04-29T00:00:00Z');

/** A commit made 1h before NOW — well inside the 24h "recent" window. */
export const RECENT_COMMIT_MS = NOW.getTime() - 60 * 60 * 1000;

/** A commit made 30h before NOW — past the HARD_KILL_AGE_MS cutoff. */
export const OLD_COMMIT_MS = NOW.getTime() - 30 * 60 * 60 * 1000;

// --- Fake PIDs -------------------------------------------------------------

/** Sentinel PID that the alive `KillFn` accepts. */
export const ALIVE_PID = 1;

/** Sentinel PID that the dead `KillFn` rejects with ESRCH. */
export const DEAD_PID = 99_999_999;

/** `process.kill(pid, 0)` substitute that always succeeds. */
export const aliveKill: KillFn = () => {};

/** `process.kill(pid, 0)` substitute that always throws ESRCH. */
export const deadKill: KillFn = () => {
	throw new Error('ESRCH');
};

// --- spawnSync fake --------------------------------------------------------

export interface SpawnHandlers {
	/** When true, `pgrep -f claude-auto-retry` exits 0 with a fake PID line. */
	autoRetryAlive?: boolean;
	/**
	 * Unix-seconds timestamp returned by `git -C <cwd> log -1 --format=%ct`.
	 * `undefined` / `null` means git exits 1 (no commits / not a repo).
	 */
	gitLogTimestampSec?: number | null;
}

/**
 * Build a fake `SpawnSyncFn` driven by `handlers`. The returned function is
 * call-spy-decorated so a test can assert exactly which subprocesses
 * `runResume` invoked — important for AC verification ("mocked process
 * table" must demonstrably replace the real one).
 */
export function makeFakeSpawn(handlers: SpawnHandlers = {}): SpawnSyncFn & {
	calls: Array<{ cmd: string; args: string[] }>;
} {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const fn = (
		cmd: string,
		args: string[],
		_options: { encoding: 'utf8' },
	): SpawnSyncReturns<string> => {
		calls.push({ cmd, args: [...args] });
		const result: SpawnSyncReturns<string> = {
			pid: 1,
			output: ['', '', ''],
			stdout: '',
			stderr: '',
			status: 1,
			signal: null,
		};
		if (cmd === 'pgrep' && args[0] === '-f' && args[1] === 'claude-auto-retry') {
			if (handlers.autoRetryAlive) {
				result.status = 0;
				result.stdout = '12345\n';
			}
			return result;
		}
		if (cmd === 'git' && args.includes('log')) {
			if (
				handlers.gitLogTimestampSec !== null &&
				handlers.gitLogTimestampSec !== undefined
			) {
				result.status = 0;
				result.stdout = `${handlers.gitLogTimestampSec}\n`;
			}
			return result;
		}
		return result;
	};
	const decorated = fn as unknown as SpawnSyncFn & {
		calls: Array<{ cmd: string; args: string[] }>;
	};
	decorated.calls = calls;
	return decorated;
}

// --- State-file builder ----------------------------------------------------

export interface StateFileSpec {
	active?: boolean;
	iteration?: number;
	maxIterations?: number;
	pid?: number;
	completionPromise?: string;
}

/**
 * Render the YAML+body payload the plugin writes to
 * `.claude/ralph-loop.local.md`. Order of keys matches the plugin's emit so
 * the parser test path stays representative.
 */
export function renderStateFileBody(spec: StateFileSpec = {}): string {
	const lines: string[] = ['---'];
	lines.push(`active: ${spec.active ?? true}`);
	if (typeof spec.iteration === 'number') lines.push(`iteration: ${spec.iteration}`);
	if (typeof spec.maxIterations === 'number')
		lines.push(`max_iterations: ${spec.maxIterations}`);
	if (typeof spec.pid === 'number') lines.push(`pid: ${spec.pid}`);
	if (spec.completionPromise) lines.push(`completion_promise: ${spec.completionPromise}`);
	lines.push('---');
	lines.push('');
	lines.push('/ralph-next');
	lines.push('');
	return lines.join('\n');
}

// --- Tmpdir-backed scenarios ----------------------------------------------

export interface ScenarioPaths {
	cwd: string;
	stateFilePath: string;
	prdPath: string;
}

function paths(cwd: string): ScenarioPaths {
	return {
		cwd,
		stateFilePath: join(cwd, '.claude', 'ralph-loop.local.md'),
		prdPath: join(cwd, 'prd.json'),
	};
}

/**
 * Default 3-story PRD with one story still `passes:false`. Used by every
 * scenario except the cleanup case.
 */
export function defaultPrdJson(): string {
	return `${JSON.stringify(
		{
			projectName: 'fixture',
			branchName: 'feat/test',
			userStories: [
				{ id: 'US-001', title: 'one', priority: 1, passes: true },
				{ id: 'US-002', title: 'two', priority: 2, passes: true },
				{ id: 'US-003', title: 'three', priority: 3, passes: false },
			],
		},
		null,
		2,
	)}\n`;
}

/**
 * Mode 1 — operator typed mid-loop. The state file is on disk; a commit
 * landed AFTER it was written; the heartbeat PID is alive (the loop is
 * still running). Recovery action: respawn (re-attach to the loop).
 */
export function buildScenarioMode1OperatorTyped(): ScenarioPaths {
	const cwd = mkdtempSync(join(tmpdir(), 'ralph-resume-mode1-'));
	mkdirSync(join(cwd, '.claude'), { recursive: true });
	writeFileSync(
		join(cwd, '.claude', 'ralph-loop.local.md'),
		renderStateFileBody({ active: true, iteration: 4, maxIterations: 30, pid: ALIVE_PID }),
	);
	writeFileSync(join(cwd, 'prd.json'), defaultPrdJson());
	return paths(cwd);
}

/**
 * Mode 2 — terminal closed / OS rebooted. State file present, heartbeat PID
 * dead, last commit recent (≤ 24h). Recovery action: respawn (no prompt).
 */
export function buildScenarioMode2TerminalClosed(): ScenarioPaths {
	const cwd = mkdtempSync(join(tmpdir(), 'ralph-resume-mode2-'));
	mkdirSync(join(cwd, '.claude'), { recursive: true });
	writeFileSync(
		join(cwd, '.claude', 'ralph-loop.local.md'),
		renderStateFileBody({ active: true, iteration: 6, maxIterations: 30, pid: DEAD_PID }),
	);
	writeFileSync(join(cwd, 'prd.json'), defaultPrdJson());
	return paths(cwd);
}

/**
 * Mode 3 — hard-kill orphan. State file present, heartbeat PID dead, last
 * commit > 24h old (or no commits at all). Recovery action: prompt
 * `[Y/n/reset]`.
 */
export function buildScenarioMode3HardKill(): ScenarioPaths {
	const cwd = mkdtempSync(join(tmpdir(), 'ralph-resume-mode3-'));
	mkdirSync(join(cwd, '.claude'), { recursive: true });
	writeFileSync(
		join(cwd, '.claude', 'ralph-loop.local.md'),
		renderStateFileBody({ active: true, iteration: 9, maxIterations: 30, pid: DEAD_PID }),
	);
	writeFileSync(join(cwd, 'prd.json'), defaultPrdJson());
	return paths(cwd);
}

/**
 * Mode 4 — rate-limit sleep killed mid-window. State file present, the
 * heartbeat PID is dead-from-the-loop's-POV (the worker exited mid-sleep)
 * but `claude-auto-retry` is still alive in the process table holding the
 * sleep window. Recovery action: noop (auto-retry will respawn `ralph next`
 * on its own timer).
 */
export function buildScenarioMode4RateLimit(): ScenarioPaths {
	const cwd = mkdtempSync(join(tmpdir(), 'ralph-resume-mode4-'));
	mkdirSync(join(cwd, '.claude'), { recursive: true });
	writeFileSync(
		join(cwd, '.claude', 'ralph-loop.local.md'),
		renderStateFileBody({ active: true, iteration: 12, maxIterations: 30, pid: DEAD_PID }),
	);
	writeFileSync(join(cwd, 'prd.json'), defaultPrdJson());
	return paths(cwd);
}

// --- Stdout silencer ------------------------------------------------------

/**
 * `runResume` writes a multi-line summary to stdout. Tests that don't care
 * about the output silence it via this helper (mirrors the pattern in
 * `test/resume.test.ts`). Always restore in a `finally` block to keep
 * surrounding tests' output intact when one of these tests throws.
 */
export function silenceStdout(): { restore: () => void } {
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	return {
		restore: () => {
			process.stdout.write = original;
		},
	};
}
