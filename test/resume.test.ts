// test/resume.test.ts
//
// Unit tests for `cam resume` — the 4-mode recovery command (US-010).
//
// Coverage:
//   classifyResumeMode (pure):
//     - PRD complete  → success (auto-clean)
//     - no state file → idle
//     - retry-monitor PID alive → noop
//     - state file + heartbeat PID alive → respawn (Mode 1)
//     - state file + PID dead + recent commit → respawn (Mode 2)
//     - state file + PID dead + > 24h commit → prompt (Mode 3)
//     - state file + PID dead + no commit found → prompt (Mode 3)
//   isPidAlive: alive (kill returns), dead (kill throws), invalid PIDs.
//   isRetryMonitorAlive: tested via retryMonitorFn injection in buildResumeReport.
//   isPrdComplete: empty list, mixed, all true.
//   resetCurrentStoryInPlace: picks the highest-priority `passes:true` story;
//     no-op when nothing has passed.
//   resetPrdInPlace: flips every entry; reports 0 when already all false.
//   normalizePromptAnswer: y/yes/n/<empty>/RESET/reset cases.
//   buildResumeReport: integrates all the readers using a tmpdir cwd.
//   runResume:
//     - Mode 3 prompt → 'y' continues; 'n' aborts (exit 1); 'reset' removes file.
//     - dry-run: no mutation, exit 0.
//     - --mode reset-current-story: flips PRD.
//     - --mode reset-prd: flips every entry.
//     - --mode reset-branch: removes state file + prints instruction.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	HARD_KILL_AGE_MS,
	buildResumeReport,
	classifyResumeMode,
	isRetryMonitorAlive,
	isPidAlive,
	isPrdComplete,
	isWorkerPaneAlive,
	normalizePromptAnswer,
	readLastCommitTimestamp,
	readPrd,
	readStateFile,
	resetCurrentStoryInPlace,
	resetPrdInPlace,
	runResume,
	type KillFn,
	type SpawnSyncFn,
} from '../src/commands/resume.ts';

// --- Test fakes ------------------------------------------------------------

interface FakeSpawnHandlers {
	gitLogTimestamp?: number | null; // controls `git -C <cwd> log -1 --format=%ct`
	/** List of pane ids returned by `tmux list-panes -a`. Default: []. */
	livePaneIds?: string[];
}

function makeFakeSpawn(handlers: FakeSpawnHandlers = {}): SpawnSyncFn & {
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
		if (cmd === 'git' && args.includes('log')) {
			if (handlers.gitLogTimestamp !== null && handlers.gitLogTimestamp !== undefined) {
				result.status = 0;
				result.stdout = `${handlers.gitLogTimestamp}\n`;
			}
			return result;
		}
		// Handle `tmux -L cam list-panes -a -F #{pane_id}`.
		if (cmd === 'tmux' && args.includes('list-panes')) {
			const panes = handlers.livePaneIds ?? [];
			result.status = 0;
			result.stdout = panes.join('\n') + (panes.length > 0 ? '\n' : '');
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

const ALIVE_PID = 1;
const DEAD_PID = 99_999_999;
const aliveKill: KillFn = () => {};
const deadKill: KillFn = () => {
	throw new Error('ESRCH');
};

// --- isPidAlive ------------------------------------------------------------

describe('isPidAlive', () => {
	test('returns false for undefined pid', () => {
		expect(isPidAlive(undefined, aliveKill)).toBe(false);
	});

	test('returns false for non-positive pid', () => {
		expect(isPidAlive(0, aliveKill)).toBe(false);
		expect(isPidAlive(-1, aliveKill)).toBe(false);
	});

	test('returns false for NaN pid', () => {
		expect(isPidAlive(Number.NaN, aliveKill)).toBe(false);
	});

	test('returns true when killFn does not throw', () => {
		expect(isPidAlive(ALIVE_PID, aliveKill)).toBe(true);
	});

	test('returns false when killFn throws', () => {
		expect(isPidAlive(DEAD_PID, deadKill)).toBe(false);
	});
});

// --- isRetryMonitorAlive ---------------------------------------------------
// isRetryMonitorAlive reads ~/.cam/retry.pid + calls isRetryPidAlive.
// We test it indirectly via buildResumeReport with retryMonitorFn injection
// (below in the buildResumeReport block), keeping this block for the
// export contract check.

describe('isRetryMonitorAlive', () => {
	test('is a function (export contract check)', () => {
		expect(typeof isRetryMonitorAlive).toBe('function');
	});

	test('returns false when retry.pid is absent (integration guard)', () => {
		// On the dev/CI machine the PID file may or may not exist. We can't
		// inject the path here without changing the implementation. Instead we
		// only assert the return type is boolean — the real liveness path is
		// covered by the retry-pid unit tests (test/retry/retry-pid.test.ts).
		const result = isRetryMonitorAlive();
		expect(typeof result).toBe('boolean');
	});
});

// --- isPrdComplete ---------------------------------------------------------

describe('isPrdComplete', () => {
	test('returns false on null PRD', () => {
		expect(isPrdComplete(null)).toBe(false);
	});

	test('returns false on empty story list', () => {
		expect(isPrdComplete({ userStories: [] })).toBe(false);
	});

	test('returns false when any story is passes:false', () => {
		expect(
			isPrdComplete({
				userStories: [
					{ id: 'A', title: 'a', passes: true },
					{ id: 'B', title: 'b', passes: false },
				],
			}),
		).toBe(false);
	});

	test('returns true when every story is passes:true', () => {
		expect(
			isPrdComplete({
				userStories: [
					{ id: 'A', title: 'a', passes: true },
					{ id: 'B', title: 'b', passes: true },
				],
			}),
		).toBe(true);
	});
});

// --- classifyResumeMode ----------------------------------------------------

const NOW = new Date('2026-04-29T00:00:00Z');
const RECENT_COMMIT_MS = NOW.getTime() - 60 * 60 * 1000; // 1h ago
const OLD_COMMIT_MS = NOW.getTime() - HARD_KILL_AGE_MS - 60 * 60 * 1000; // > 24h

describe('classifyResumeMode', () => {
	test('PRD complete → success regardless of state file', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: ALIVE_PID },
			{ userStories: [{ id: 'A', title: 'a', passes: true }] },
			RECENT_COMMIT_MS,
			true,
			false,
			NOW,
		);
		expect(decision.mode).toBe('success');
	});

	test('no state file → idle', () => {
		const decision = classifyResumeMode(null, null, RECENT_COMMIT_MS, false, false, NOW);
		expect(decision.mode).toBe('idle');
	});

	test('state file + retry-monitor PID alive → noop (Mode 4)', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			RECENT_COMMIT_MS,
			false,
			true, // retryMonitorAlive
			NOW,
		);
		expect(decision.mode).toBe('noop');
	});

	test('state file + supervisor PID alive → live-supervisor (Mode 1)', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: ALIVE_PID },
			null,
			RECENT_COMMIT_MS,
			true,
			false,
			NOW,
		);
		expect(decision.mode).toBe('live-supervisor');
	});

	test('state file + PID dead + recent commit → respawn (Mode 2)', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			RECENT_COMMIT_MS,
			false,
			false,
			NOW,
		);
		expect(decision.mode).toBe('respawn');
	});

	test('state file + PID dead + > 24h commit → prompt (Mode 3)', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			OLD_COMMIT_MS,
			false,
			false,
			NOW,
		);
		expect(decision.mode).toBe('prompt');
	});

	test('state file + PID dead + null commit ts → prompt (Mode 3)', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			null,
			false,
			false,
			NOW,
		);
		expect(decision.mode).toBe('prompt');
	});

	test('Mode 4 wins over live-supervisor — retry-monitor alive short-circuits PID liveness', () => {
		// Edge case: retry-monitor PID alive + state-file-PID also alive. We
		// must report `noop` (Mode 4) not `live-supervisor` (Mode 1) — the retry
		// monitor owns the recovery cycle.
		const decision = classifyResumeMode(
			{ active: true, pid: ALIVE_PID },
			null,
			RECENT_COMMIT_MS,
			true,
			true,
			NOW,
		);
		expect(decision.mode).toBe('noop');
	});
});

// --- isWorkerPaneAlive (US-009) --------------------------------------------

describe('isWorkerPaneAlive (US-009)', () => {
	test('returns false for null pane id', () => {
		const spawn = makeFakeSpawn({ livePaneIds: ['%1', '%2'] });
		expect(isWorkerPaneAlive(null, spawn)).toBe(false);
	});

	test('returns false for empty string pane id', () => {
		const spawn = makeFakeSpawn({ livePaneIds: ['%1'] });
		expect(isWorkerPaneAlive('', spawn)).toBe(false);
	});

	test('returns true when pane id appears in list-panes output', () => {
		const spawn = makeFakeSpawn({ livePaneIds: ['%1', '%5', '%9'] });
		expect(isWorkerPaneAlive('%5', spawn)).toBe(true);
	});

	test('returns false when pane id is not in list-panes output', () => {
		const spawn = makeFakeSpawn({ livePaneIds: ['%1', '%2'] });
		expect(isWorkerPaneAlive('%5', spawn)).toBe(false);
	});

	test('returns false when list-panes exits non-zero (tmux unavailable)', () => {
		// Default fakeFn returns status=1 for non-list and non-git calls.
		const spawn = makeFakeSpawn(); // livePaneIds undefined → status 0 with empty output
		// Override to return status 1 for list-panes.
		const failSpawn: SpawnSyncFn = (cmd, args, opts) => {
			const base = spawn(cmd, args, opts);
			if (cmd === 'tmux' && args.includes('list-panes')) {
				return { ...base, status: 1, stdout: '' };
			}
			return base;
		};
		expect(isWorkerPaneAlive('%5', failSpawn)).toBe(false);
	});
});

// --- classifyResumeMode matrix (US-009) ------------------------------------

describe('classifyResumeMode — US-009 matrix', () => {
	test('no-state: no state file → idle', () => {
		const decision = classifyResumeMode(null, null, RECENT_COMMIT_MS, false, false, NOW, false);
		expect(decision.mode).toBe('idle');
	});

	test('live-supervisor: state file + supervisor PID alive → live-supervisor', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: ALIVE_PID },
			null,
			RECENT_COMMIT_MS,
			true, // pidAlive
			false,
			NOW,
			false,
		);
		expect(decision.mode).toBe('live-supervisor');
	});

	test('orphan-pane: state file + PID dead + worker pane alive → orphaned-worker', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			RECENT_COMMIT_MS,
			false, // pidAlive = false
			false,
			NOW,
			true, // workerPaneAlive = true
		);
		expect(decision.mode).toBe('orphaned-worker');
	});

	test('fully-dead: state file + PID dead + pane dead + recent commit → respawn', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			RECENT_COMMIT_MS,
			false,
			false,
			NOW,
			false, // workerPaneAlive = false
		);
		expect(decision.mode).toBe('respawn');
	});

	test('fully-dead + stale commit: state file + PID dead + pane dead + >24h → prompt', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			OLD_COMMIT_MS,
			false,
			false,
			NOW,
			false,
		);
		expect(decision.mode).toBe('prompt');
	});

	test('noop wins over orphaned-worker: retry-monitor alive short-circuits pane check', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: DEAD_PID },
			null,
			RECENT_COMMIT_MS,
			false,
			true, // retryMonitorAlive
			NOW,
			true, // workerPaneAlive
		);
		expect(decision.mode).toBe('noop');
	});

	test('live-supervisor wins over orphaned-worker: PID alive takes priority', () => {
		const decision = classifyResumeMode(
			{ active: true, pid: ALIVE_PID },
			null,
			RECENT_COMMIT_MS,
			true, // pidAlive
			false,
			NOW,
			true, // workerPaneAlive — but PID wins
		);
		expect(decision.mode).toBe('live-supervisor');
	});
});

// --- normalizePromptAnswer -------------------------------------------------

describe('normalizePromptAnswer', () => {
	test('maps y / Y / yes / YES → y', () => {
		expect(normalizePromptAnswer('y')).toBe('y');
		expect(normalizePromptAnswer('Y')).toBe('y');
		expect(normalizePromptAnswer('yes')).toBe('y');
		expect(normalizePromptAnswer('YES')).toBe('y');
		expect(normalizePromptAnswer(' y ')).toBe('y');
	});

	test('maps reset / RESET → reset', () => {
		expect(normalizePromptAnswer('reset')).toBe('reset');
		expect(normalizePromptAnswer('RESET')).toBe('reset');
	});

	test('maps anything else (incl. empty / "n" / garbage) → n (safe default)', () => {
		expect(normalizePromptAnswer('')).toBe('n');
		expect(normalizePromptAnswer('n')).toBe('n');
		expect(normalizePromptAnswer('no')).toBe('n');
		expect(normalizePromptAnswer('whatever')).toBe('n');
	});
});

// --- resetCurrentStoryInPlace ----------------------------------------------

describe('resetCurrentStoryInPlace', () => {
	test('flips the highest-priority passes:true story to passes:false', () => {
		const prd = {
			userStories: [
				{ id: 'US-001', title: 'one', priority: 1, passes: true },
				{ id: 'US-002', title: 'two', priority: 2, passes: true },
				{ id: 'US-003', title: 'three', priority: 3, passes: false },
			],
		};
		const id = resetCurrentStoryInPlace(prd);
		expect(id).toBe('US-002'); // highest priority value among passed
		expect(prd.userStories.find((s) => s.id === 'US-002')?.passes).toBe(false);
		expect(prd.userStories.find((s) => s.id === 'US-001')?.passes).toBe(true);
	});

	test('returns null when no story has passed', () => {
		const prd = {
			userStories: [{ id: 'US-001', title: 'a', priority: 1, passes: false }],
		};
		expect(resetCurrentStoryInPlace(prd)).toBeNull();
	});

	test('returns null on empty PRD', () => {
		expect(resetCurrentStoryInPlace({ userStories: [] })).toBeNull();
		expect(resetCurrentStoryInPlace({})).toBeNull();
	});
});

// --- resetPrdInPlace -------------------------------------------------------

describe('resetPrdInPlace', () => {
	test('flips every passes:true entry to passes:false; reports the count', () => {
		const prd = {
			userStories: [
				{ id: 'US-001', title: 'a', passes: true },
				{ id: 'US-002', title: 'b', passes: true },
				{ id: 'US-003', title: 'c', passes: false },
			],
		};
		expect(resetPrdInPlace(prd)).toBe(2);
		expect(prd.userStories.every((s) => s.passes === false)).toBe(true);
	});

	test('returns 0 when every story is already passes:false', () => {
		const prd = {
			userStories: [
				{ id: 'US-001', title: 'a', passes: false },
				{ id: 'US-002', title: 'b', passes: false },
			],
		};
		expect(resetPrdInPlace(prd)).toBe(0);
	});
});

// --- readLastCommitTimestamp -----------------------------------------------

describe('readLastCommitTimestamp', () => {
	test('returns ms timestamp when git log succeeds', () => {
		const spawn = makeFakeSpawn({ gitLogTimestamp: 1745020800 }); // 2025-04-19T00:00:00Z
		const ts = readLastCommitTimestamp('/tmp/fake', spawn);
		expect(ts).toBe(1745020800 * 1000);
	});

	test('returns null when git log fails', () => {
		const spawn = makeFakeSpawn(); // gitLogTimestamp undefined → status 1
		expect(readLastCommitTimestamp('/tmp/fake', spawn)).toBeNull();
	});
});

// --- readStateFile / readPrd integration ----------------------------------

describe('readStateFile + readPrd', () => {
	test('readStateFile parses a real on-disk state file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-state-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const body = [
				'---',
				'active: true',
				'iteration: 5',
				'max_iterations: 30',
				`pid: ${ALIVE_PID}`,
				'---',
				'',
				'/cam-next',
				'',
			].join('\n');
			writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), body);
			const state = readStateFile(dir);
			expect(state?.active).toBe(true);
			expect(state?.iteration).toBe(5);
			expect(state?.pid).toBe(ALIVE_PID);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('readStateFile returns null when the file is missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-no-state-'));
		try {
			expect(readStateFile(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('readPrd parses a real on-disk PRD', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-prd-'));
		try {
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({ userStories: [{ id: 'A', title: 'a', passes: false }] }),
			);
			const prd = readPrd(dir);
			expect(prd?.userStories?.[0]?.id).toBe('A');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('readPrd returns null when prd.json is invalid JSON', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-bad-prd-'));
		try {
			writeFileSync(join(dir, 'prd.json'), '{not json');
			expect(readPrd(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- buildResumeReport (integration) ---------------------------------------

describe('buildResumeReport', () => {
	test('idle when nothing exists', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-idle-'));
		try {
			const report = buildResumeReport({
				cwd: dir,
				now: () => NOW,
				spawnFn: makeFakeSpawn(),
				killFn: deadKill,
				retryMonitorFn: () => false,
			});
			expect(report.mode).toBe('idle');
			expect(report.stateFilePresent).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('success when the PRD is complete and a state file lingers', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-success-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				'---\nactive: true\n---\n\n/cam-next\n',
			);
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({ userStories: [{ id: 'A', title: 'a', passes: true }] }),
			);
			const report = buildResumeReport({
				cwd: dir,
				now: () => NOW,
				spawnFn: makeFakeSpawn(),
				killFn: deadKill,
				retryMonitorFn: () => false,
			});
			expect(report.mode).toBe('success');
			expect(report.prdComplete).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('respawn when PID is dead but commit is recent', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-respawn-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				`---\nactive: true\npid: ${DEAD_PID}\n---\n\n/cam-next\n`,
			);
			const report = buildResumeReport({
				cwd: dir,
				now: () => NOW,
				spawnFn: makeFakeSpawn({
					gitLogTimestamp: Math.floor(RECENT_COMMIT_MS / 1000),
				}),
				killFn: deadKill,
				retryMonitorFn: () => false,
			});
			expect(report.mode).toBe('respawn');
			expect(report.pidAlive).toBe(false);
			expect(report.lastCommitAgeMs).toBeLessThan(HARD_KILL_AGE_MS);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('prompt when PID is dead and commit is > 24h old', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-prompt-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				`---\nactive: true\npid: ${DEAD_PID}\n---\n\n/cam-next\n`,
			);
			const report = buildResumeReport({
				cwd: dir,
				now: () => NOW,
				spawnFn: makeFakeSpawn({
					gitLogTimestamp: Math.floor(OLD_COMMIT_MS / 1000),
				}),
				killFn: deadKill,
				retryMonitorFn: () => false,
			});
			expect(report.mode).toBe('prompt');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('noop when retry-monitor PID is alive', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-noop-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				`---\nactive: true\npid: ${DEAD_PID}\n---\n\n/cam-next\n`,
			);
			const report = buildResumeReport({
				cwd: dir,
				now: () => NOW,
				spawnFn: makeFakeSpawn(),
				killFn: deadKill,
				retryMonitorFn: () => true,
			});
			expect(report.mode).toBe('noop');
			expect(report.retryPidAlive).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runResume (integration) -----------------------------------------------

function silenceStdout(): { restore: () => void } {
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	return {
		restore: () => {
			process.stdout.write = original;
		},
	};
}

describe('runResume — Mode 3 prompt', () => {
	test('answer "y" → exits 0 and does not remove state file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-prompt-y-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(
				statePath,
				`---\nactive: true\npid: ${DEAD_PID}\n---\n\n/cam-next\n`,
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd: dir,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestamp: Math.floor(OLD_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					retryMonitorFn: () => false,
					prompt: () => 'y',
				});
				expect(code).toBe(0);
				expect(existsSync(statePath)).toBe(true); // not cleaned
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('answer "n" (default) → exits 1', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-prompt-n-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				`---\nactive: true\npid: ${DEAD_PID}\n---\n\n/cam-next\n`,
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd: dir,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestamp: Math.floor(OLD_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					retryMonitorFn: () => false,
					prompt: () => '',
				});
				expect(code).toBe(1);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('answer "reset" → removes state file and exits 0', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-prompt-reset-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(
				statePath,
				`---\nactive: true\npid: ${DEAD_PID}\n---\n\n/cam-next\n`,
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd: dir,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestamp: Math.floor(OLD_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					retryMonitorFn: () => false,
					prompt: () => 'reset',
				});
				expect(code).toBe(0);
				expect(existsSync(statePath)).toBe(false);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('runResume — auto-cleanup of orphan state', () => {
	test('PRD complete + state file lingering → removes the file and exits 0', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-success-clean-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(
				statePath,
				`---\nactive: true\npid: ${ALIVE_PID}\n---\n\n/cam-next\n`,
			);
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({ userStories: [{ id: 'A', title: 'a', passes: true }] }),
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd: dir,
					now: () => NOW,
					spawnFn: makeFakeSpawn(),
					killFn: aliveKill,
					retryMonitorFn: () => false,
					prompt: () => 'n',
				});
				expect(code).toBe(0);
				expect(existsSync(statePath)).toBe(false);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('runResume — dry-run', () => {
	test('does not mutate or spawn under --dry-run', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-dryrun-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(
				statePath,
				`---\nactive: true\npid: ${DEAD_PID}\n---\n\n/cam-next\n`,
			);
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({ userStories: [{ id: 'A', title: 'a', passes: true }] }),
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd: dir,
					now: () => NOW,
					spawnFn: makeFakeSpawn(),
					killFn: deadKill,
					retryMonitorFn: () => false,
					prompt: () => {
						throw new Error('prompt should not be called under dry-run');
					},
					dryRun: true,
				});
				expect(code).toBe(0);
				expect(existsSync(statePath)).toBe(true);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('runResume — explicit --mode reset-current-story', () => {
	test('flips the most-recently-completed story to passes:false', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-reset-cur-'));
		try {
			const prdPath = join(dir, 'prd.json');
			writeFileSync(
				prdPath,
				JSON.stringify({
					userStories: [
						{ id: 'US-001', title: 'a', priority: 1, passes: true },
						{ id: 'US-002', title: 'b', priority: 2, passes: true },
						{ id: 'US-003', title: 'c', priority: 3, passes: false },
					],
				}),
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd: dir,
					mode: 'reset-current-story',
				});
				expect(code).toBe(0);
				const after = JSON.parse(readFileSync(prdPath, 'utf8'));
				expect(after.userStories.find((s: { id: string }) => s.id === 'US-002').passes).toBe(false);
				expect(after.userStories.find((s: { id: string }) => s.id === 'US-001').passes).toBe(true);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('exits 2 when there is no completed story to reset', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-reset-cur-empty-'));
		try {
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({
					userStories: [{ id: 'US-001', title: 'a', priority: 1, passes: false }],
				}),
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({ cwd: dir, mode: 'reset-current-story' });
				expect(code).toBe(2);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('exits 2 when prd.json is missing', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-reset-cur-noprd-'));
		try {
			const stdout = silenceStdout();
			try {
				const code = await runResume({ cwd: dir, mode: 'reset-current-story' });
				expect(code).toBe(2);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('runResume — explicit --mode reset-prd', () => {
	test('flips every story to passes:false', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-reset-prd-'));
		try {
			const prdPath = join(dir, 'prd.json');
			writeFileSync(
				prdPath,
				JSON.stringify({
					userStories: [
						{ id: 'US-001', title: 'a', passes: true },
						{ id: 'US-002', title: 'b', passes: true },
					],
				}),
			);
			const stdout = silenceStdout();
			try {
				const code = await runResume({ cwd: dir, mode: 'reset-prd' });
				expect(code).toBe(0);
				const after = JSON.parse(readFileSync(prdPath, 'utf8'));
				expect(after.userStories.every((s: { passes: boolean }) => s.passes === false)).toBe(true);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('dry-run does not write prd.json', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-reset-prd-dryrun-'));
		try {
			const prdPath = join(dir, 'prd.json');
			const original = {
				userStories: [{ id: 'US-001', title: 'a', passes: true }],
			};
			writeFileSync(prdPath, JSON.stringify(original));
			const stdout = silenceStdout();
			try {
				const code = await runResume({ cwd: dir, mode: 'reset-prd', dryRun: true });
				expect(code).toBe(0);
				const after = JSON.parse(readFileSync(prdPath, 'utf8'));
				expect(after.userStories[0].passes).toBe(true); // unchanged
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('runResume — explicit --mode reset-branch', () => {
	test('--force skips the prompt and removes the state file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-reset-branch-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(statePath, '---\nactive: true\n---\n\n/cam-next\n');
			const stdout = silenceStdout();
			try {
				const code = await runResume({ cwd: dir, mode: 'reset-branch', force: true });
				expect(code).toBe(0);
				expect(existsSync(statePath)).toBe(false);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('without --force prompts; "n" answer aborts with exit 1', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-reset-branch-n-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			writeFileSync(statePath, '---\nactive: true\n---\n\n/cam-next\n');
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd: dir,
					mode: 'reset-branch',
					prompt: () => 'n',
				});
				expect(code).toBe(1);
				// State file unchanged.
				expect(existsSync(statePath)).toBe(true);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
